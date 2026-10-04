import { createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { commandCodeProvider } from "./command-code";

export function registerMyBuddyProviders(runtime: ModelRuntime): void {
  runtime.registerNativeProvider(commandCodeProvider({ createProvider, envApiKeyAuth }, {
    "anthropic-messages": anthropicMessagesApi(),
    "openai-completions": openAICompletionsApi(),
    "openai-responses": openAIResponsesApi(),
  }));
}
