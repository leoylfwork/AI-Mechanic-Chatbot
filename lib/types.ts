import type { InferUITool, UIMessage } from "ai";
import { z } from "zod";
import type { ArtifactKind } from "@/components/artifact";
import type { createDocument } from "./ai/tools/create-document";
import type { getWeather } from "./ai/tools/get-weather";
import type { requestSuggestions } from "./ai/tools/request-suggestions";
import type { updateDocument } from "./ai/tools/update-document";
import type { Suggestion } from "./db/schema";

export type DataPart = { type: "append-message"; message: string };

export const messageMetadataSchema = z.object({
  createdAt: z.string(),
});

export type MessageMetadata = z.infer<typeof messageMetadataSchema>;

type weatherTool = InferUITool<typeof getWeather>;
type createDocumentTool = InferUITool<ReturnType<typeof createDocument>>;
type updateDocumentTool = InferUITool<ReturnType<typeof updateDocument>>;
type requestSuggestionsTool = InferUITool<
  ReturnType<typeof requestSuggestions>
>;

export type ChatTools = {
  getWeather: weatherTool;
  createDocument: createDocumentTool;
  updateDocument: updateDocumentTool;
  requestSuggestions: requestSuggestionsTool;
};

export type CustomUIDataTypes = {
  textDelta: string;
  imageDelta: string;
  sheetDelta: string;
  codeDelta: string;
  suggestion: Suggestion;
  appendMessage: string;
  id: string;
  title: string;
  kind: ArtifactKind;
  clear: null;
  finish: null;

  // 你已有的
  "chat-title": string;

  // ✅ 后端现在发的是 data-chat-title（否则会红）
  "data-chat-title": string;

  // ✅ Relevance-style sources 事件（否则 data-sources 会红）
  "data-sources": {
    stage:
      | "search_start"
      | "bucket_done"
      | "bucket_error"
      | "search_failed"
      | "final";
    used_search: boolean;
    cited: boolean;
    sources: Array<"forum" | "youtube" | "tsb" | "web">;
    top_links: Array<{
      bucket: "forum" | "youtube" | "tsb" | "web";
      title: string;
      url: string;
    }>;
    bucket?: "forum" | "youtube" | "tsb" | "web";
    latency_ms?: number;
    errors?: string[];
  };
};

export type ChatMessage = UIMessage<
  MessageMetadata,
  CustomUIDataTypes,
  ChatTools
>;

export type Attachment = {
  name: string;
  url: string;
  contentType: string;
};
