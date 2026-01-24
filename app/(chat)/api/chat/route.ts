import { geolocation } from "@vercel/functions";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateId,
  stepCountIs,
  streamText,
} from "ai";
import { after } from "next/server";
import { createResumableStreamContext } from "resumable-stream";
import { auth } from "@/app/(auth)/auth";
import { type RequestHints, systemPrompt } from "@/lib/ai/prompts";
import { getLanguageModel } from "@/lib/ai/providers";
import { createDocument } from "@/lib/ai/tools/create-document";
import { getWeather } from "@/lib/ai/tools/get-weather";
import { requestSuggestions } from "@/lib/ai/tools/request-suggestions";
import { updateDocument } from "@/lib/ai/tools/update-document";
import { isProductionEnvironment } from "@/lib/constants";
import {
  createStreamId,
  deleteChatById,
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
   Tavily Search (Relevance-style)
========================= */

type TavilyItem = {
  title: string;
  url: string;
  content?: string;
  score?: number;
};

type SearchBucket = {
  bucket: "forum" | "youtube" | "tsb" | "web";
  query: string;
  items: TavilyItem[];
  error?: string;
};

function extractTextFromParts(parts: any[] | undefined): string {
  if (!parts) return "";
  const texts: string[] = [];
  for (const p of parts) {
    if (!p) continue;
    if (typeof p === "string") texts.push(p);
    if (p.type === "text" && typeof p.text === "string") texts.push(p.text);
  }
  return texts.join("\n").trim();
}

function shouldSearchRelevanceStyle(userText: string): boolean {
  const t = (userText || "").toLowerCase();
  const highRiskSignals = [
    "misfire",
    "no start",
    "overheat",
    "overheating",
    "stall",
    "stalls",
    "rough",
    "code",
    "dtc",
    "p0",
    "cylinder",
    "compression",
    "fuel trim",
    "injector",
    "coil",
    "spark",
    "timing",
    "tsb",
    "next step",
    "diagnose",
    "diagnosis",
    "诊断",
    "报码",
    "失火",
    "缺火",
    "无法启动",
    "过热",
    "下一步",
    "缸压",
    "喷油嘴",
    "点火线圈",
  ];
  return highRiskSignals.some((k) => t.includes(k));
}

async function tavilySearch(params: {
  query: string;
  includeDomains?: string[];
  excludeDomains?: string[];
  maxResults?: number;
}): Promise<TavilyItem[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("Missing env: TAVILY_API_KEY");

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query: params.query,
      max_results: params.maxResults ?? 6,
      search_depth: "advanced",
      include_answer: false,
      include_raw_content: false,
      include_domains: params.includeDomains,
      exclude_domains: params.excludeDomains,
    }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Tavily error ${res.status}: ${txt}`.slice(0, 500));
  }

  const data = await res.json();
  const results = Array.isArray(data?.results) ? data.results : [];
  return results.map((r: any) => ({
    title: r?.title ?? "",
    url: r?.url ?? "",
    content: r?.content ?? "",
    score: r?.score,
  }));
}

function toEvidencePack(buckets: SearchBucket[]): string {
  const lines: string[] = [];
  lines.push("SEARCH_EVIDENCE (use as citations; do not invent links):");
  for (const b of buckets) {
    lines.push(`\n[${b.bucket.toUpperCase()}] query="${b.query}"`);
    if (b.error) {
      lines.push(`- ERROR: ${b.error}`);
      continue;
    }
    for (const it of b.items.slice(0, 5)) {
      if (!it?.url) continue;
      lines.push(`- ${it.title} | ${it.url}`);
    }
  }
  return lines.join("\n");
}

/* =========================
   Resumable stream
========================= */

function getStreamContext() {
  try {
    return createResumableStreamContext({ waitUntil: after });
  } catch (_) {
    return null;
  }
}

export { getStreamContext };

/* =========================
   POST
========================= */

export async function POST(request: Request) {
  let requestBody: PostRequestBody;

  try {
    const json = await request.json();
    requestBody = postRequestBodySchema.parse(json);
  } catch (_) {
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

    const { longitude, latitude, city, country } = geolocation(request);

    const requestHints: RequestHints = {
      longitude,
      latitude,
      city,
      country,
    };

    if (message?.role === "user") {
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

    const modelMessages = await convertToModelMessages(uiMessages);

    const stream = createUIMessageStream({
      originalMessages: isToolApprovalFlow ? uiMessages : undefined,

      execute: async ({ writer: dataStream }) => {
        const userText =
          message?.role === "user"
            ? extractTextFromParts((message as any)?.parts)
            : "";

        const needsSearch = shouldSearchRelevanceStyle(userText);
        console.log("NEEDS_SEARCH:", needsSearch, "TEXT:", userText);

        let searchBuckets: SearchBucket[] = [];

        if (needsSearch) {
          const plan: Array<{
            bucket: SearchBucket["bucket"];
            includeDomains?: string[];
            query: string;
          }> = [
            {
              bucket: "forum",
              includeDomains: ["mbworld.org", "benzworld.org", "reddit.com"],
              query: `${userText} site:mbworld.org OR site:benzworld.org OR site:reddit.com`,
            },
            {
              bucket: "youtube",
              includeDomains: ["youtube.com"],
              query: `${userText} site:youtube.com`,
            },
            {
              bucket: "tsb",
              includeDomains: ["nhtsa.gov"],
              query: `${userText} TSB site:nhtsa.gov`,
            },
            {
              bucket: "web",
              query: `${userText}`,
            },
          ];

          console.log("SEARCH_BUCKETS_COUNT:", searchBuckets.length);

          for (const step of plan) {
            try {
              const items = await tavilySearch({
                query: step.query,
                includeDomains: step.includeDomains,
                maxResults: 6,
              });

              searchBuckets.push({
                bucket: step.bucket,
                query: step.query,
                items,
              });
            } catch (e: any) {
              searchBuckets.push({
                bucket: step.bucket,
                query: step.query,
                items: [],
                error: e?.message ?? String(e),
              });
            }
          }

          const anyResult = searchBuckets.some(
            (b) => (b.items?.length ?? 0) > 0
          );
          if (!anyResult) {
            // 如果全空，就当没搜到，不注入 evidence
            searchBuckets = [];
          }
        }

        const evidenceText =
          searchBuckets.length > 0 ? toEvidencePack(searchBuckets) : "";

        const augmentedMessages =
          evidenceText.length > 0
            ? ([
                ...(modelMessages as any),
                { role: "system", content: evidenceText },
              ] as any)
            : (modelMessages as any);

        const result = streamText({
          model: getLanguageModel(selectedChatModel),
          system: systemPrompt({ selectedChatModel, requestHints }),
          messages: augmentedMessages,
          stopWhen: stepCountIs(5),

          experimental_activeTools: isReasoningModel
            ? []
            : [
                "getWeather",
                "createDocument",
                "updateDocument",
                "requestSuggestions",
              ],

          providerOptions: isReasoningModel
            ? {
                anthropic: {
                  thinking: { type: "enabled", budgetTokens: 10_000 },
                },
              }
            : undefined,

          tools: {
            getWeather,
            createDocument: createDocument({ session, dataStream }),
            updateDocument: updateDocument({ session, dataStream }),
            requestSuggestions: requestSuggestions({ session, dataStream }),
          },

          experimental_telemetry: {
            isEnabled: isProductionEnvironment,
            functionId: "stream-text",
          },
        });

        dataStream.merge(result.toUIMessageStream({ sendReasoning: true }));

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
        } else if (finishedMessages.length > 0) {
          await saveMessages({
            messages: finishedMessages.map((currentMessage) => ({
              id: currentMessage.id,
              role: currentMessage.role,
              parts: currentMessage.parts,
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
        if (!process.env.REDIS_URL) return;

        try {
          const streamContext = getStreamContext();
          if (streamContext) {
            const streamId = generateId();
            await createStreamId({ streamId, chatId: id });
            await streamContext.createNewResumableStream(
              streamId,
              () => sseStream
            );
          }
        } catch (_) {
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

/* =========================
   DELETE
========================= */

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return new ChatSDKError("bad_request:api").toResponse();
  }

  const session = await auth();

  if (!session?.user) {
    return new ChatSDKError("unauthorized:chat").toResponse();
  }

  const chat = await getChatById({ id });

  if (chat?.userId !== session.user.id) {
    return new ChatSDKError("forbidden:chat").toResponse();
  }

  const deletedChat = await deleteChatById({ id });

  return Response.json(deletedChat, { status: 200 });
}
// test push
