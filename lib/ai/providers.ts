import { openai } from "@ai-sdk/openai";
import {
  customProvider,
  extractReasoningMiddleware,
  wrapLanguageModel,
} from "ai";
import { isTestEnvironment } from "../constants";

const THINKING_SUFFIX_REGEX = /-thinking$/;

export const myProvider = isTestEnvironment
  ? (() => {
      const {
        artifactModel,
        chatModel,
        reasoningModel,
        titleModel,
      } = require("./models.mock");
      return customProvider({
        languageModels: {
          "chat-model": chatModel,
          "chat-model-reasoning": reasoningModel,
          "title-model": titleModel,
          "artifact-model": artifactModel,
        },
      });
    })()
  : null;

function mapToOpenAIModelId(modelId: string) {
  // 你的 UI 传的是 "openai/gpt-5.2"
  if (modelId.startsWith("openai/")) {
    return modelId.replace("openai/", "");
  }
  // 兜底
  return "gpt-4.1";
}

export function getLanguageModel(modelId: string) {
  if (isTestEnvironment && myProvider) {
    return myProvider.languageModel(modelId);
  }

  const isReasoningModel =
    modelId.includes("reasoning") || modelId.endsWith("-thinking");

  const openaiModelId = mapToOpenAIModelId(modelId);

  if (isReasoningModel) {
    const baseId = openaiModelId.replace(THINKING_SUFFIX_REGEX, "");
    return wrapLanguageModel({
      model: openai(baseId),
      middleware: extractReasoningMiddleware({ tagName: "thinking" }),
    });
  }

  return openai(openaiModelId);
}

export function getTitleModel() {
  if (isTestEnvironment && myProvider) {
    return myProvider.languageModel("title-model");
  }
  return openai("gpt-4.1");
}

export function getArtifactModel() {
  if (isTestEnvironment && myProvider) {
    return myProvider.languageModel("artifact-model");
  }
  return openai("gpt-4.1");
}

// import { gateway } from "@ai-sdk/gateway";
// import {
//   customProvider,
//   extractReasoningMiddleware,
//   wrapLanguageModel,
// } from "ai";
// import { isTestEnvironment } from "../constants";

// const THINKING_SUFFIX_REGEX = /-thinking$/;

// export const myProvider = isTestEnvironment
//   ? (() => {
//       const {
//         artifactModel,
//         chatModel,
//         reasoningModel,
//         titleModel,
//       } = require("./models.mock");
//       return customProvider({
//         languageModels: {
//           "chat-model": chatModel,
//           "chat-model-reasoning": reasoningModel,
//           "title-model": titleModel,
//           "artifact-model": artifactModel,
//         },
//       });
//     })()
//   : null;

// export function getLanguageModel(modelId: string) {
//   if (isTestEnvironment && myProvider) {
//     return myProvider.languageModel(modelId);
//   }

//   const isReasoningModel =
//     modelId.includes("reasoning") || modelId.endsWith("-thinking");

//   if (isReasoningModel) {
//     const gatewayModelId = modelId.replace(THINKING_SUFFIX_REGEX, "");

//     return wrapLanguageModel({
//       model: gateway.languageModel(gatewayModelId),
//       middleware: extractReasoningMiddleware({ tagName: "thinking" }),
//     });
//   }

//   return gateway.languageModel(modelId);
// }

// export function getTitleModel() {
//   if (isTestEnvironment && myProvider) {
//     return myProvider.languageModel("title-model");
//   }
//   return gateway.languageModel("openai/gpt-5.2");
// }

// export function getArtifactModel() {
//   if (isTestEnvironment && myProvider) {
//     return myProvider.languageModel("artifact-model");
//   }
//   return gateway.languageModel("anthropic/claude-haiku-4.5");
// }

// // import { openai } from "@ai-sdk/openai";
// // import {
// //   customProvider,
// //   extractReasoningMiddleware,
// //   wrapLanguageModel,
// // } from "ai";
// // import { isTestEnvironment } from "../constants";

// // const THINKING_SUFFIX_REGEX = /-thinking$/;

// // export const myProvider = isTestEnvironment
// //   ? (() => {
// //       const {
// //         artifactModel,
// //         chatModel,
// //         reasoningModel,
// //         titleModel,
// //       } = require("./models.mock");
// //       return customProvider({
// //         languageModels: {
// //           "chat-model": chatModel,
// //           "chat-model-reasoning": reasoningModel,
// //           "title-model": titleModel,
// //           "artifact-model": artifactModel,
// //         },
// //       });
// //     })()
// //   : null;

// // function mapToOpenAIModelId(modelId: string) {
// //   // 你的 UI 里是 "openai/gpt-5.2" 这种
// //   if (modelId.startsWith("openai/")) {
// //     return modelId.replace("openai/", "");
// //   }
// //   // 其他 provider 先兜底成一个可用的
// //   return "gpt-4.1-mini";
// // }

// // export function getLanguageModel(modelId: string) {
// //   if (isTestEnvironment && myProvider) {
// //     return myProvider.languageModel(modelId);
// //   }

// //   const isReasoningModel =
// //     modelId.includes("reasoning") || modelId.endsWith("-thinking");

// //   const openaiModelId = mapToOpenAIModelId(modelId);

// //   if (isReasoningModel) {
// //     const baseId = openaiModelId.replace(THINKING_SUFFIX_REGEX, "");
// //     return wrapLanguageModel({
// //       model: openai(baseId),
// //       middleware: extractReasoningMiddleware({ tagName: "thinking" }),
// //     });
// //   }

// //   return openai(openaiModelId);
// // }

// // export function getTitleModel() {
// //   if (isTestEnvironment && myProvider) {
// //     return myProvider.languageModel("title-model");
// //   }
// //   // 标题模型也用 OpenAI
// //   return openai("gpt-4.1-mini");
// // }

// // export function getArtifactModel() {
// //   if (isTestEnvironment && myProvider) {
// //     return myProvider.languageModel("artifact-model");
// //   }
// //   return openai("gpt-4.1-mini");
// // }
