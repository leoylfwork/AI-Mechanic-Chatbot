// ❌ 删掉 test
// import { gateway } from "@ai-sdk/gateway";

import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateId,
  streamText,
} from "ai";
import { after } from "next/server";
import { createResumableStreamContext } from "resumable-stream";
import { auth } from "@/app/(auth)/auth";
import { type RequestHints, systemPrompt } from "@/lib/ai/prompts";
import { getLanguageModel } from "@/lib/ai/providers";
import {
  createStreamId,
  getChatById,
  getMessagesByChatId,
  saveChat,
  saveMessages,
  updateChatTitleById,
  updateMessage,
} from "@/lib/db/queries";
import type { DBMessage } from "@/lib/db/schema";
import { ChatSDKError } from "@/lib/errors";
import type { ChatMessage } from "@/lib/types";
import { convertToUIMessages, generateUUID } from "@/lib/utils";
import { generateTitleFromUserMessage } from "../../actions";
import { type PostRequestBody, postRequestBodySchema } from "./schema";

export const maxDuration = 60;

/* =========================
   Resumable stream
========================= */

function getStreamContext() {
  try {
    return createResumableStreamContext({ waitUntil: after });
  } catch {
    return null;
  }
}

export { getStreamContext };

function mustSearch(userText: string) {
  const t = userText.toLowerCase();

  const keywords = [
    // ===== 1. Time-sensitive / reality changing =====
    "latest",
    "new",
    "update",
    "202",
    "model",
    "最新",
    "新版",
    "更新",
    "新款",
    "改款",
    "年款",

    // ===== 2. Legal / recall / compliance =====
    "recall",
    "safety recall",
    "tsb",
    "technical service bulletin",
    "service bulletin",
    "nhtsa",
    "transport canada",
    "class action",
    "lawsuit",
    "settlement",
    "warranty extension",
    "召回",
    "安全召回",
    "技术通告",
    "服务通告",
    "通告",
    "延保",
    "保修延长",
    "集体诉讼",
    "诉讼",
    "和解",

    // ===== 3. Known issues / failure patterns =====
    "fail",
    "failure",
    "known issue",
    "common problem",
    "common issue",
    "通病",
    "常见问题",
    "常见故障",
    "容易坏",
    "经常坏",
    "失效",
    "故障率",

    // ===== 5. Pricing / money / labor =====
    "price",
    "cost",
    "labor",
    "labour",
    "labor time",
    "flat rate",
    "book time",
    "estimate",
    "quote",
    "价格",
    "多少钱",
    "费用",
    "成本",
    "工时",
    "工费",
    "报价",
    "估价",

    // ===== 6. OEM parts / specs =====
    "oem",
    "part number",
    "part no",
    "pn",
    "genuine part",
    "replacement part",
    "原厂",
    "原厂件",
    "副厂",
    "配件号",
    "零件号",
    "料号",
    "替换件",
    "原装",

    // ===== 7. Torque / capacity / fluids =====
    "torque",
    "torque spec",
    "specification",
    "spec",
    "fluid capacity",
    "oil capacity",
    "coolant capacity",
    "atf capacity",
    "service capacity",
    "扭矩",
    "扭力",
    "规格",
    "参数",
    "加多少",
    "容量",
    "机油容量",
    "冷却液容量",
    "变速箱油容量",

    // ===== 8. Procedures / official steps =====
    "procedure",
    "service procedure",
    "repair procedure",
    "step by step",
    "how to replace",
    "how to remove",
    "how to install",
    "oem procedure",
    "维修步骤",
    "更换步骤",
    "拆卸方法",
    "安装方法",
    "维修流程",
    "官方流程",

    // ===== 9. Software / calibration =====
    "software update",
    "firmware update",
    "reprogram",
    "flash",
    "calibration",
    "pcm update",
    "ecm update",
    "软件更新",
    "系统更新",
    "刷机",
    "重刷",
    "标定",
    "重新标定",
    "程序升级",

    // ===== 10. Campaigns / programs =====
    "campaign",
    "service campaign",
    "field action",
    "customer satisfaction program",
    "extended warranty",
    "服务活动",
    "厂家活动",
    "召回活动",
    "客户满意计划",

    // ===== 11. Heavy mode / system risk =====
    "multiple codes",
    "multiple dtc",
    "no communication",
    "lost communication",
    "can bus",
    "lin bus",
    "network fault",
    "module offline",
    "no power",
    "low voltage",
    "charging issue",
    "battery drain",
    "parasitic draw",
    "pcm",
    "ecm",
    "tcm",
    "bcm",
    "abs module",
    "airbag module",
    "多个报码",
    "多个故障码",
    "无法通讯",
    "通信丢失",
    "总线故障",
    "模块离线",
    "没电",
    "电压低",
    "充电问题",
    "电瓶亏电",
    "漏电",
    "寄生电流",
    "发动机电脑",
    "变速箱电脑",
    "车身电脑",
    "abs模块",
    "气囊模块",

    // ===== 12. Regulations =====
    "emissions",
    "epa",
    "carb",
    "safety standard",
    "regulation",
    "compliance",
    "排放",
    "环保",
    "排放标准",
    "法规",
    "合规",
    "安全标准",
  ];

  return keywords.some((k) => t.includes(k));
}

/* =========================
   POST
========================= */

export async function POST(request: Request) {
  let requestBody: PostRequestBody;

  try {
    const json = await request.json();
    requestBody = postRequestBodySchema.parse(json);
  } catch {
    return new ChatSDKError("bad_request:api").toResponse();
  }

  try {
    const { id, message, messages, selectedChatModel, selectedVisibilityType } =
      requestBody;

    const session = await auth();
    if (!session?.user) {
      return new ChatSDKError("unauthorized:chat").toResponse();
    }

    const isToolApprovalFlow = Boolean(messages);

    const chat = await getChatById({ id });
    let messagesFromDb: DBMessage[] = [];
    let titlePromise: Promise<string> | null = null;

    if (chat) {
      if (chat.userId !== session.user.id) {
        return new ChatSDKError("forbidden:chat").toResponse();
      }
      if (!isToolApprovalFlow) {
        messagesFromDb = await getMessagesByChatId({ id });
      }
    } else if (message?.role === "user") {
      await saveChat({
        id,
        userId: session.user.id,
        title: "New chat",
        visibility: selectedVisibilityType,
      });
      titlePromise = generateTitleFromUserMessage({ message });
    }

    const uiMessages = isToolApprovalFlow
      ? (messages as ChatMessage[])
      : [...convertToUIMessages(messagesFromDb), message as ChatMessage];

    const requestHints: RequestHints = {
      userRole: "technician",
      shopType: "independent",
    };

    if (!isToolApprovalFlow && message?.role === "user") {
      await saveMessages({
        messages: [
          {
            chatId: id,
            id: message.id,
            role: "user",
            parts: message.parts,
            attachments: [],
            createdAt: new Date(),
          },
        ],
      });
    }

    const isReasoningModel =
      selectedChatModel.includes("reasoning") ||
      selectedChatModel.includes("thinking");

    const userText =
      message?.role === "user"
        ? ((message.parts?.[0] as { text?: string } | undefined)?.text ?? "")
        : "";

    const forceSearch = mustSearch(userText);
    // const forceSearch = true;

    let searchContext = "";
    if (forceSearch) {
      console.log("🌍 MANUAL SEARCH TRIGGERED");

      const searchQuery = `
      Answer in English.
      Search only English technical automotive sources.
      ${userText}
      `;

      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
        },
        body: JSON.stringify({
          query: searchQuery,
          max_results: 6,
          search_depth: "basic",
        }),
      });

      const data = await res.json();
      const results = Array.isArray(data?.results) ? data.results : [];
      const normalized = results.slice(0, 6).map((r: any, i: number) => ({
        id: i + 1,
        title: String(r?.title ?? ""),
        url: String(r?.url ?? ""),
        snippet: String(r?.content ?? "").slice(0, 800),
      }));

      searchContext = JSON.stringify(normalized, null, 2);
    }

    const modelMessages = await convertToModelMessages(uiMessages);

    const stream = createUIMessageStream({
      originalMessages: isToolApprovalFlow ? uiMessages : undefined,

      execute: async ({ writer: dataStream }) => {
        console.log("🔥 HIT execute");
        console.log("MODEL =", getLanguageModel(selectedChatModel));
        console.log("USER_TEXT =", userText);
        console.log("FORCE_SEARCH =", forceSearch);
        // -------------------------
        // 核心：工具注入（必须 cast）
        // -------------------------

        const model = getLanguageModel(selectedChatModel);
        console.log("MODEL_CHECK =", model);

        const result = streamText({
          model: getLanguageModel(selectedChatModel),
          system:
            systemPrompt({ requestHints }) +
            `
            SEARCH_MODE: ${forceSearch ? "ON" : "OFF"}

            WEB_SEARCH_RESULTS_JSON:
            ${searchContext || "[]"}
              
            INSTRUCTIONS:
            - If SEARCH_MODE is ON, you MUST use WEB_SEARCH_RESULTS_JSON when answering.
            - Only cite URLs that appear in WEB_SEARCH_RESULTS_JSON. Never invent URLs.
            - When you use a fact from a result, cite it inline like: (Source: <url>)
            - At the end, output a "Sources:" list with 2-6 URLs you actually used.
            - If WEB_SEARCH_RESULTS_JSON is empty, say "No reliable web results found" and continue with best-practice diagnostic steps.
            `,
          messages: modelMessages,
        });

        const uiStream = result.toUIMessageStream({ sendReasoning: true });

        for await (const part of uiStream as any) {
          if (part.type === "tool-call") {
            console.log("🛠 TOOL CALLED:", part.toolName);
          }
          dataStream.write(part);
        }

        if (titlePromise) {
          const title = await titlePromise;
          dataStream.write({ type: "data-chat-title", data: title });
          updateChatTitleById({ chatId: id, title });
        }
      },

      generateId: generateUUID,

      onFinish: async ({ messages: finishedMessages }) => {
        if (isToolApprovalFlow) {
          for (const finishedMsg of finishedMessages) {
            const existingMsg = uiMessages.find((m) => m.id === finishedMsg.id);
            if (existingMsg) {
              await updateMessage({
                id: finishedMsg.id,
                parts: finishedMsg.parts,
              });
            } else {
              await saveMessages({
                messages: [
                  {
                    id: finishedMsg.id,
                    role: finishedMsg.role,
                    parts: finishedMsg.parts,
                    createdAt: new Date(),
                    attachments: [],
                    chatId: id,
                  },
                ],
              });
            }
          }
          return;
        }

        if (finishedMessages.length > 0) {
          await saveMessages({
            messages: finishedMessages.map((m) => ({
              id: m.id,
              role: m.role,
              parts: m.parts,
              createdAt: new Date(),
              attachments: [],
              chatId: id,
            })),
          });
        }
      },

      onError: () => "Oops, an error occurred!",
    });

    return createUIMessageStreamResponse({
      stream,

      async consumeSseStream({ stream: sseStream }) {
        if (!process.env.REDIS_URL) {
          return;
        }

        try {
          const streamContext = getStreamContext();
          if (!streamContext) {
            return;
          }

          const streamId = generateId();
          await createStreamId({ streamId, chatId: id });

          await streamContext.createNewResumableStream(
            streamId,
            () => sseStream
          );
        } catch {
          // ignore redis errors
        }
      },
    });
  } catch (error) {
    const vercelId = request.headers.get("x-vercel-id");

    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }

    if (
      error instanceof Error &&
      error.message?.includes(
        "AI Gateway requires a valid credit card on file to service requests"
      )
    ) {
      return new ChatSDKError("bad_request:activate_gateway").toResponse();
    }

    console.error("Unhandled error in chat API:", error, { vercelId });
    return new ChatSDKError("offline:chat").toResponse();
  }
}
