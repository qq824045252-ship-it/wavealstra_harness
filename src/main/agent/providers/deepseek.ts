import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import {
  createAssistantMessageEventStream,
  type Api, type AssistantMessage, type Model, type Provider, type ProviderStreams, type StreamOptions, type TranscriptContext,
} from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import {
  deepseekAssistantMetadata, deepseekNativeOptions, deepseekRecord, supportsDeepSeekNative,
  type DeepSeekAssistantMetadata, type DeepSeekFileProgress,
} from "../../../shared/deepseek";
import { DeepSeekFileUploads, deepseekCredentialTag, deepseekFileReference, deepseekSafeError, type DeepSeekFileReference } from "./deepseek-files";
import { DeepSeekStreamState } from "./deepseek-stream-state";

type DeepSeekApi = "openai-completions" | "openai-responses" | "anthropic-messages";
type PiProviderSdk = Pick<typeof import("@earendil-works/pi-ai"), "createProvider" | "envApiKeyAuth">;
type NativeAssistant = AssistantMessage & { mybuddyDeepSeek?: DeepSeekAssistantMetadata };
type Replay = { start: string; end: string; metadata: DeepSeekAssistantMetadata };

function textParts(content: unknown): Record<string, unknown>[] {
  return typeof content === "string" ? [{ type: "text", text: content }]
    : Array.isArray(content) ? content.map(deepseekRecord).filter((part): part is Record<string, unknown> => part !== undefined) : [];
}
function contains(content: unknown, token: string): boolean {
  return textParts(content).some(part => typeof part.text === "string" && part.text.includes(token));
}
function filePart(file: DeepSeekFileReference, id: string, api: string): Record<string, unknown> {
  const image = file.purpose === "user_data" && [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(extname(file.name).toLowerCase());
  return api === "anthropic-messages" ? { type: image ? "image" : "document", source: { type: "file", file_id: id } }
    : { type: api === "openai-responses" ? image ? "input_image" : "input_file" : "file", file_id: id };
}

/** Pi owns SSE parsing, functions, reasoning, retries and cancellation. These
 * hooks preserve provider fields the normalized message cannot represent. */
export function deepseekNativeStreams(native: ProviderStreams, uploads = new DeepSeekFileUploads()): ProviderStreams {
  const wrap = (method: "stream" | "streamSimple", model: Model<Api>, context: TranscriptContext, options: StreamOptions = {}) => {
    if (!supportsDeepSeekNative(model)) return native[method](model, context, options);
    const config = deepseekNativeOptions(model);
    const baseUrl = new URL(model.baseUrl).origin;
    const credentialTag = deepseekCredentialTag(model, options);
    const metadata: DeepSeekAssistantMetadata = { version: 1, baseUrl, model: model.id, credentialTag };
    const state = new DeepSeekStreamState(metadata, model.api);
    const replays: Replay[] = [];
    const fileMarkers = new Map<string, DeepSeekFileReference>();
    const prefix = `mybuddy-deepseek-${randomUUID()}`;
    let markerIndex = 0;
    const marker = () => `[${prefix}-${++markerIndex}]`;
    const prepared: TranscriptContext = { ...context, messages: context.messages.map(message => {
      if (message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted") {
        const previous = deepseekAssistantMetadata(message);
        if (!previous || previous.baseUrl !== baseUrl || previous.credentialTag !== credentialTag
          || previous.model !== model.id || message.provider !== model.provider || message.api !== model.api || message.model !== model.id) return message;
        const start = marker(); const end = marker();
        replays.push({ start, end, metadata: previous });
        // Boundary markers survive Pi's empty-message removal, inserted result
        // bridges and Responses item expansion. They never leave onPayload.
        return { ...message, content: [{ type: "text" as const, text: start }, ...message.content, { type: "text" as const, text: end }] };
      }
      if (config.files && message.role === "user" && Array.isArray(message.content)) {
        return { ...message, content: message.content.map(block => {
          const reference = block.type === "text" ? deepseekFileReference(block) : undefined;
          if (!reference) return block;
          const token = marker(); fileMarkers.set(token, reference);
          return { type: "text" as const, text: token };
        }) };
      }
      return message;
    }) };
    const stream = createAssistantMessageEventStream();
    let last: AssistantMessage | undefined;
    let started = false;
    let finished = false;
    const empty = (): AssistantMessage => ({ role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
      timestamp: Date.now(), stopReason: "pending", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    const attach = (message: AssistantMessage): void => {
      if (Object.keys(metadata).length > 4) (message as NativeAssistant).mybuddyDeepSeek = structuredClone(metadata);
      if (message.errorMessage) message.errorMessage = deepseekSafeError(message.errorMessage, model, options);
    };
    const progress = (): void => {
      if (finished) return;
      last ??= empty();
      attach(last);
      if (!started) { started = true; stream.push({ type: "start", partial: last }); }
      // Pi 1.5 has no metadata event, and Durable skips empty partials. A zero-
      // length display block commits the metadata immediately. It exists only
      // in this projection copy, never in Pi's final or replayed transcript.
      const partial = { ...last, content: [...last.content, { type: "text" as const, text: "" }] };
      const contentIndex = partial.content.length - 1;
      stream.push({ type: "text_start", contentIndex, partial });
      stream.push({ type: "text_end", contentIndex, content: "", partial });
    };
    const fileProgress = (value: DeepSeekFileProgress): void => {
      metadata.fileUploads = [...(metadata.fileUploads ?? []).filter(file => file.id !== value.id), value];
      progress();
    };
    const materializeFiles = async (content: unknown): Promise<unknown> => {
      if (!fileMarkers.size) return content;
      const parts: unknown[] = [];
      for (const part of textParts(content)) {
        if (typeof part.text !== "string") { parts.push(part); continue; }
        let text = part.text;
        while (text) {
          const found = [...fileMarkers].map(([token, file]) => ({ token, file, index: text.indexOf(token) }))
            .filter(item => item.index >= 0).sort((a, b) => a.index - b.index)[0];
          if (!found) { parts.push({ ...part, text }); break; }
          if (found.index) parts.push({ ...part, text: text.slice(0, found.index) });
          parts.push(filePart(found.file, await uploads.upload(found.file, model, options, fileProgress), model.api));
          text = text.slice(found.index + found.token.length);
        }
      }
      return parts;
    };
    const beta = new Headers(model.headers);
    for (const [key, value] of Object.entries(options.headers ?? {})) {
      if (value === null) beta.delete(key); else if (value !== undefined) beta.set(key, value);
    }
    const request: StreamOptions = {
      ...options,
      ...(model.api === "anthropic-messages" && fileMarkers.size ? { headers: { ...options.headers,
        "anthropic-beta": [...new Set([...(beta.get("anthropic-beta") ?? "").split(",").filter(Boolean), "files-api-2025-04-14"])].join(",") } } : {}),
      onPayload: async (payload, currentModel) => {
        const source = deepseekRecord(payload);
        if (!source) return await options.onPayload?.(payload, currentModel) ?? payload;
        const body = { ...source };
        const key = model.api === "openai-responses" ? "input" : "messages";
        if (Array.isArray(source[key])) {
          const messages: unknown[] = [];
          let replayUntil: string | undefined;
          for (const original of source[key] as unknown[]) {
            const value = deepseekRecord(original);
            if (!value) { messages.push(original); continue; }
            if (replayUntil) { if (contains(value.content, replayUntil)) replayUntil = undefined; continue; }
            let message = { ...value };
            if (value.role === "assistant") {
              const replay = replays.find(item => contains(value.content, item.start));
              if (replay) {
                if (model.api === "openai-responses" && replay.metadata.responsesOutput) {
                  messages.push(...structuredClone(replay.metadata.responsesOutput)); replayUntil = replay.end; continue;
                }
                if (model.api === "anthropic-messages" && replay.metadata.anthropicContent) message.content = structuredClone(replay.metadata.anthropicContent);
                else {
                  const clean = (text: string) => text.replace(replay.start, "").replace(replay.end, "");
                  message.content = typeof value.content === "string" ? clean(value.content)
                    : textParts(value.content).map(part => typeof part.text === "string" ? { ...part, text: clean(part.text) } : part)
                      .filter(part => typeof part.text !== "string" || part.text !== "");
                  if (Array.isArray(replay.metadata.serverToolCalls)) message.server_tool_calls = structuredClone(replay.metadata.serverToolCalls);
                  if (Array.isArray(replay.metadata.annotations)) message.annotations = structuredClone(replay.metadata.annotations);
                  if (typeof replay.metadata.reasoningContent === "string") message.reasoning_content = replay.metadata.reasoningContent;
                }
              }
            }
            if (value.role === "user") message.content = await materializeFiles(value.content);
            messages.push(message);
          }
          body[key] = messages;
        }
        const customized = await options.onPayload?.(body, currentModel) ?? body;
        const final = deepseekRecord(customized);
        if (!final || (!config.webSearch && !config.readUrl)) return customized;
        const tools = Array.isArray(final.tools) ? [...final.tools] : [];
        for (const type of [...(config.webSearch ? ["deepseek_web_search"] : []), ...(config.readUrl ? ["deepseek_read_url"] : [])]) {
          if (!tools.some(tool => deepseekRecord(tool)?.type === type)) tools.push({ type, ...(model.api === "anthropic-messages" ? { name: type } : {}) });
        }
        return { ...final, tools };
      },
      onProviderStreamEvent: async (event, currentModel) => {
        if (state.observe(event)) progress();
        await options.onProviderStreamEvent?.(event, currentModel);
      },
    };
    void (async () => {
      try {
        const upstream = native[method](model, prepared, request);
        for await (const event of upstream) {
          last = event.type === "done" ? event.message : event.type === "error" ? event.error : event.partial;
          if (event.type === "error") metadata.fileUploads = metadata.fileUploads?.map(file => file.status === "ready" || file.status === "error" ? file
            : { ...file, status: "error", message: "附件处理已停止等待，服务器可能仍在处理；未自动重传。" });
          attach(last);
          if (event.type === "start") { if (started) continue; started = true; }
          if (event.type === "done" || event.type === "error") finished = true;
          stream.push(event);
        }
        const result = await upstream.result(); attach(result); stream.end(result);
      } catch (error) {
        finished = true;
        const message: AssistantMessage = { ...(last ?? empty()), stopReason: options.signal?.aborted ? "aborted" : "error",
          errorMessage: error instanceof Error ? error.message : String(error) };
        attach(message);
        stream.push({ type: "error", reason: message.stopReason as "error" | "aborted", error: message }); stream.end();
      }
    })();
    return stream;
  };
  return { stream: (model, context, options) => wrap("stream", model, context, options),
    streamSimple: (model, context, options) => wrap("streamSimple", model, context, options) };
}

export function mybuddyDeepSeekProvider(sdk: PiProviderSdk, api: Record<DeepSeekApi, ProviderStreams>): Provider<DeepSeekApi> {
  const uploads = new DeepSeekFileUploads();
  return sdk.createProvider<DeepSeekApi>({
    id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com",
    auth: { apiKey: sdk.envApiKeyAuth("DeepSeek API key", ["DEEPSEEK_API_KEY"]) },
    models: getBuiltinModels("deepseek"),
    api: { "openai-completions": deepseekNativeStreams(api["openai-completions"], uploads),
      "openai-responses": deepseekNativeStreams(api["openai-responses"], uploads),
      "anthropic-messages": deepseekNativeStreams(api["anthropic-messages"], uploads) },
  });
}
