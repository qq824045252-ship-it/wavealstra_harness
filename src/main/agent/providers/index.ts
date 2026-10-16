import { createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { commandCodeProvider } from "./command-code";
import { magpieProvider, type MagpieGatewayConfig } from "./magpie";

export interface MyBuddyProviderOptions {
  /**
   * models.json `providers.magpie`, read at refresh time: Magpie writes (and
   * rewrites) that block while MyBuddy runs, and the gateway address and key in
   * it must be the live ones. Undefined means no Magpie is configured — Pi then
   * composes the provider bare, so it carries no login and no models.
   */
  magpieConfig?: () => MagpieGatewayConfig | undefined;
}

export function registerMyBuddyProviders(runtime: ModelRuntime, options: MyBuddyProviderOptions = {}): void {
  runtime.registerNativeProvider(commandCodeProvider({ createProvider, envApiKeyAuth }, {
    "anthropic-messages": anthropicMessagesApi(),
    "openai-completions": openAICompletionsApi(),
    "openai-responses": openAIResponsesApi(),
  }));
  // Magpie's gateway models: models.json keeps owning the provider block, while
  // Pi gains the model-catalog refresh its `api: openai-completions` config alone
  // can never declare (Pi attaches refreshModels only from provider code).
  runtime.registerNativeProvider(magpieProvider({ createProvider }, {
    "anthropic-messages": anthropicMessagesApi(),
    "openai-completions": openAICompletionsApi(),
    "openai-responses": openAIResponsesApi(),
  }, options.magpieConfig ?? (() => undefined)));
}
