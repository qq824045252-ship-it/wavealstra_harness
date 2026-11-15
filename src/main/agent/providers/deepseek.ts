import { randomUUID } from "node:crypto";
import {
  createAssistantMessageEventStream,
  type Api, type AssistantMessage, type Model, type Provider, type ProviderStreams, type StreamOptions, type TranscriptContext,
} from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import {
  deepseekAssistantMetadata, deepseekNativeOptions, deepseekRecord, supportsDeepSeekNative,
  type DeepSeekAssistantMetadata,
} from "../../../shared/deepseek";
import { DeepSeekFileUploads, deepseekCredentialTag, deepseekFileReference, deepseekSafeError, type DeepSeekFileReference } from "./deepseek-files";

type DeepSeekApi = "openai-completions" | "openai-responses" | "anthropic-messages";
type PiProviderSdk = Pick<typeof import("@earendil-works/pi-ai"), "createProvider" | "envApiKeyAuth">;
type NativeAssistant = AssistantMessage & { mybuddyDeepSeek?: DeepSeekAssistantMetadata };

/** Pi remains responsible for SSE parsing, ordinary function calls, reasoning,
 * retries and cancellation. These hooks preserve DeepSeek's application fields
 * that the OpenAI-compatible normalized message otherwise cannot represent. */
export function deepseekNativeStreams(native: ProviderStreams): ProviderStreams {
  const uploads = new DeepSeekFileUploads();
  const wrap = (method: "stream" | "streamSimple", model: Model<Api>, context: TranscriptContext, options: StreamOptions = {}) => {
    if (!supportsDeepSeekNative(model)) return native[method](model, context, options);
    const config = deepseekNativeOptions(model);
    const baseUrl = new URL(model.baseUrl).origin;
    const credentialTag = deepseekCredentialTag(model, options);
    const metadata: DeepSeekAssistantMetadata = { version: 1, baseUrl, model: model.id, credentialTag };
    const assistantMarkers = new Map<string, DeepSeekAssistantMetadata>();
    const fileMarkers = new Map<string, DeepSeekFileReference>();
    const prefix = `mybuddy-deepseek-${randomUUID()}`;
    let markerIndex = 0;
    const marker = () => `[${prefix}-${++markerIndex}]`;
    const prepared: TranscriptContext = { ...context, messages: context.messages.map(message => {
      if (message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted") {
        const previous = deepseekAssistantMetadata(message);
        if (!previous || previous.baseUrl !== baseUrl || previous.credentialTag !== credentialTag
          || previous.model !== model.id || message.provider !== model.provider || message.api !== model.api || message.model !== model.id) return message;
        const token = marker();
        assistantMarkers.set(token, previous);
        // A temporary marker preserves identity through Pi's skipped empty
        // messages and inserted tool-result bridges. It is removed before the
        // caller's onPayload hook and never reaches the provider or history.
        return { ...message, content: [...message.content, { type: "text" as const, text: token }] };
      }
      if (config.files && message.role === "user" && Array.isArray(message.content)) {
        return { ...message, content: message.content.map(block => {
          const reference = block.type === "text" ? deepseekFileReference(block) : undefined;
          if (!reference) return block;
          const token = marker();
          fileMarkers.set(token, reference);
          return { type: "text" as const, text: token };
        }) };
      }
      return message;
    }) };
    let finalReasoning = "";
    const hasMetadata = () => metadata.serverToolCalls !== undefined || metadata.annotations !== undefined
      || metadata.serverToolEvents !== undefined || metadata.title !== undefined || metadata.serverToolUsage !== undefined;
    const attach = (message: AssistantMessage): void => {
      if (hasMetadata()) (message as NativeAssistant).mybuddyDeepSeek = structuredClone({ ...metadata, reasoningContent: finalReasoning });
      if (message.errorMessage) message.errorMessage = deepseekSafeError(message.errorMessage, model, options);
    };
    const stream = createAssistantMessageEventStream();
    const request: StreamOptions = {
      ...options,
      onPayload: async (payload, currentModel) => {
        const source = deepseekRecord(payload);
        if (!source) return await options.onPayload?.(payload, currentModel) ?? payload;
        const body = { ...source };
        if (Array.isArray(source.messages)) {
          const messages: unknown[] = [];
          for (const original of source.messages) {
            const value = deepseekRecord(original);
            if (!value) { messages.push(original); continue; }
            let message = { ...value };
            if (value.role === "assistant") {
              for (const [token, previous] of assistantMarkers) {
                const blocks = Array.isArray(value.content) ? value.content : [{ type: "text", text: value.content }];
                if (!blocks.some(block => deepseekRecord(block)?.type === "text" && typeof block.text === "string" && block.text.includes(token))) continue;
                message.content = typeof value.content === "string" ? value.content.replace(token, "")
                  : blocks.map(block => deepseekRecord(block)?.type === "text" && typeof block.text === "string"
                    ? { ...block, text: block.text.replace(token, "") } : block);
                if (Array.isArray(previous.serverToolCalls)) message.server_tool_calls = structuredClone(previous.serverToolCalls);
                if (Array.isArray(previous.annotations)) message.annotations = structuredClone(previous.annotations);
                if (typeof previous.reasoningContent === "string") message.reasoning_content = previous.reasoningContent;
                break;
              }
            }
            if (value.role === "user" && Array.isArray(value.content)) {
              const content: unknown[] = [];
              for (const block of value.content) {
                const part = deepseekRecord(block);
                const file = part?.type === "text" && typeof part.text === "string" ? fileMarkers.get(part.text) : undefined;
                content.push(file ? { type: "file", file_id: await uploads.upload(file, model, options) } : block);
              }
              message = { ...message, content };
            }
            messages.push(message);
          }
          body.messages = messages;
        }
        const customized = await options.onPayload?.(body, currentModel) ?? body;
        const final = deepseekRecord(customized);
        if (!final || (!config.webSearch && !config.readUrl)) return customized;
        const tools = Array.isArray(final.tools) ? [...final.tools] : [];
        for (const type of [...(config.webSearch ? ["deepseek_web_search"] : []), ...(config.readUrl ? ["deepseek_read_url"] : [])]) {
          if (!tools.some(tool => deepseekRecord(tool)?.type === type)) tools.push({ type });
        }
        return { ...final, tools };
      },
      onProviderStreamEvent: async (event, currentModel) => {
        const chunk = deepseekRecord(event);
        const choices = chunk?.choices;
        const choice = Array.isArray(choices) ? deepseekRecord(choices[0]) : undefined;
        const delta = deepseekRecord(choice?.delta);
        if (typeof delta?.reasoning_content === "string") finalReasoning += delta.reasoning_content;
        const progress = deepseekRecord(choice?.server_tool_event);
        if (progress) {
          (metadata.serverToolEvents ??= []).push(structuredClone(progress));
          if (progress.type === "step_reasoning_done") finalReasoning = "";
        }
        if (Array.isArray(delta?.server_tool_calls)) metadata.serverToolCalls = structuredClone(delta.server_tool_calls);
        if (Array.isArray(delta?.annotations)) metadata.annotations = structuredClone(delta.annotations);
        if (typeof delta?.title === "string") metadata.title = delta.title;
        const usage = deepseekRecord(chunk?.usage);
        const serverToolUsage = deepseekRecord(usage?.server_tool_use);
        if (serverToolUsage) metadata.serverToolUsage = structuredClone(serverToolUsage);
        await options.onProviderStreamEvent?.(event, currentModel);
      },
    };
    void (async () => {
      let last: AssistantMessage | undefined;
      try {
        const upstream = native[method](model, prepared, request);
        for await (const event of upstream) {
          last = event.type === "done" ? event.message : event.type === "error" ? event.error : event.partial;
          attach(last);
          stream.push(event);
        }
        const result = await upstream.result();
        attach(result);
        stream.end(result);
      } catch (error) {
        const message: AssistantMessage = { role: "assistant", content: last?.content ?? [], api: model.api, provider: model.provider, model: model.id,
          timestamp: last?.timestamp ?? Date.now(), stopReason: options.signal?.aborted ? "aborted" : "error",
          errorMessage: error instanceof Error ? error.message : String(error), usage: last?.usage ?? {
            input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          } };
        attach(message);
        stream.push({ type: "error", reason: message.stopReason as "error" | "aborted", error: message });
        stream.end();
      }
    })();
    return stream;
  };
  return { stream: (model, context, options) => wrap("stream", model, context, options),
    streamSimple: (model, context, options) => wrap("streamSimple", model, context, options) };
}

export function mybuddyDeepSeekProvider(sdk: PiProviderSdk, api: Record<DeepSeekApi, ProviderStreams>): Provider<DeepSeekApi> {
  return sdk.createProvider<DeepSeekApi>({
    id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com",
    auth: { apiKey: sdk.envApiKeyAuth("DeepSeek API key", ["DEEPSEEK_API_KEY"]) },
    // The pinned Pi catalog owns current IDs, limits and vision support. In 1.5
    // Flash accepts images; V4 Pro is text-only. No guessed model definitions.
    models: getBuiltinModels("deepseek"),
    api: { ...api, "openai-completions": deepseekNativeStreams(api["openai-completions"]) },
  });
}
