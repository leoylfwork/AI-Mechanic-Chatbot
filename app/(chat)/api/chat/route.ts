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
  return (
    t.includes("recall") ||
    t.includes("tsb") ||
    t.includes("latest") ||
    t.includes("2024") ||
    t.includes("2025") ||
    t.includes("price") ||
    t.includes("多少钱") ||
    t.includes("召回") ||
    t.includes("最新")
  );
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

    // const forceSearch = mustSearch(userText);
    const forceSearch = true;

    let searchContext = "";
    if (forceSearch) {
      console.log("🌍 MANUAL SEARCH TRIGGERED");

      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
        },
        body: JSON.stringify({
          query: userText,
          max_results: 6,
          search_depth: "basic",
        }),
      });

      const data = await res.json();
      searchContext = data.results
        .map(
          (r: any, i: number) => `
[${i + 1}]
Title: ${r.title}
URL: ${r.url}
Content: ${r.content}
`
        )
        .join("\n");
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
            systemPrompt({ selectedChatModel, requestHints }) +
            `

              WEB SEARCH RESULTS:
              ${searchContext}

              INSTRUCTIONS:
              - When using facts from the web search, include the source URL.
              - At the end of the answer, list the sources used.
              - Use real URLs from the results above.
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
