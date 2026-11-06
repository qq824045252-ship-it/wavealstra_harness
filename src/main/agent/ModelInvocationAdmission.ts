import { AsyncLocalStorage } from "node:async_hooks";
import {
  createAssistantMessageEventStream, type Api, type AssistantMessage,
  type AssistantMessageEventStream, type Context, type Model, normalizeContext,
  type ModelsRequestTransforms, type ProviderRequestOptions, type ProviderHeaders, type StreamOptions,
} from "@earendil-works/pi-ai";
import { resolveModelScopeWithDiagnostics, type AgentSession, type ModelRuntime, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { createRequestTransport } from "./request-transport.mjs";
import { startCacheRequestTrace, sessionTraceBoundary, type CacheTraceBoundary } from "./CacheRequestTrace";
import type { ModelExecutionIdentity } from "./CacheRequestTracer";

// Request-local settings only. Pi still owns configuration, parsing and the model catalog.
const invocationSettings = new AsyncLocalStorage<{ settings: SettingsManager; validate?: () => void; boundary?: () => CacheTraceBoundary }>();
const requestIdentity = new AsyncLocalStorage<(identity: ModelExecutionIdentity) => void>();
const installed = new WeakSet<ModelRuntime>();
const boundSessions = new WeakSet<AgentSession>();
const requestGuards = new WeakMap<AgentSession, () => () => void>();
const sessionsByManager = new WeakMap<object, AgentSession>();

export function withModelInvocationSettings<T>(settings: SettingsManager, operation: () => T, validate?: () => void, boundary?: () => CacheTraceBoundary): T {
  return invocationSettings.run({ settings, validate, boundary: boundary ?? invocationSettings.getStore()?.boundary }, operation);
}

/**
 * Durable has no AgentSession to describe a model request: one task invocation (a generation or a
 * compaction) owns one abort signal, and Pi passes that same signal to the provider request. Its hooks
 * register the boundary under that signal — the same key `DurableBotRuntime.modelRequestGuards` uses —
 * so `guarded()` finds the operation without threading anything through the call stack.
 */
const requestBoundaries = new WeakMap<AbortSignal, () => CacheTraceBoundary>();

/** Register (or clear, with `undefined`) the boundary for the request(s) one task invocation will issue. */
export function setRequestTraceBoundary(signal: AbortSignal | undefined, boundary: (() => CacheTraceBoundary) | undefined): void {
  if (!signal) return;
  if (boundary) requestBoundaries.set(signal, boundary);
  else requestBoundaries.delete(signal);
}

/** The boundary a task invocation registered for this signal; `undefined` means no task claimed the request. */
export function requestTraceBoundary(signal: AbortSignal | undefined): (() => CacheTraceBoundary) | undefined {
  return signal ? requestBoundaries.get(signal) : undefined;
}

/** Native hosts annotate the already-observed request while Pi builds its provider payload. */
export function identifyModelInvocation(identity: ModelExecutionIdentity): void { requestIdentity.getStore()?.(identity); }

export function setSessionRequestGuard(session: AgentSession, capture: () => () => void): void {
  requestGuards.set(session, capture);
}

/** Inline capabilities use their owning session, including after UI approvals. */
export function getSessionModelInvocation(manager: object) {
  const session = sessionsByManager.get(manager);
  if (!session) throw new Error("模型调用所属会话已结束或尚未绑定");
  return {
    runtime: session.modelRuntime,
    settings: session.settingsManager,
    run<T>(operation: () => T): T {
      const validate = requestGuards.get(session)?.();
      return withModelInvocationSettings(session.settingsManager, operation, () => {
        if (sessionsByManager.get(manager) !== session) throw new Error("模型调用所属会话已结束");
        validate?.();
      }, () => sessionTraceBoundary(session, 'capability'));
    },
  };
}

export async function assertModelAdmission(runtime: ModelRuntime, settings: SettingsManager, model: Model<Api>): Promise<void> {
  await settings.reload();
  const errors = settings.drainErrors();
  if (errors.length) throw new Error(`Pi 模型设置读取失败：${errors[0]!.error.message}`);
  const patterns = settings.getEnabledModels();
  if (patterns === undefined) return;
  const { scopedModels } = await resolveModelScopeWithDiagnostics(patterns, runtime);
  if (!scopedModels.some(({ model: allowed }) => allowed.provider === model.provider && allowed.id === model.id)) {
    throw new Error(`模型 ${model.provider}/${model.id} 不在当前 Pi enabledModels 范围内`);
  }
}

/** Image counts use native metadata; serialized HTTP bodies are checked by the transport guard. */
function assertImageCounts(model: Model<Api>, context: Context): void {
  const limits = model.inputLimits?.images;
  if (!limits) return;
  let total = 0;
  for (const message of normalizeContext(context).messages) {
    const count = (message.role === "user" || message.role === "toolResult") && Array.isArray(message.content)
      ? message.content.filter((part) => part.type === "image").length : 0;
    total += count;
    if (limits.maxPerMessage !== undefined && count > limits.maxPerMessage) {
      throw new Error(`模型 ${model.id} 每条消息最多接收 ${limits.maxPerMessage} 张图片，当前为 ${count}`);
    }
  }
  if (limits.maxPerRequest !== undefined && total > limits.maxPerRequest) {
    throw new Error(`模型 ${model.id} 每次请求最多接收 ${limits.maxPerRequest} 张图片，当前为 ${total}`);
  }
}

/** Both completion methods delegate to these same guarded stream methods. */
export function installModelInvocationAdmission(runtime: ModelRuntime, fallbackSettings: () => SettingsManager, traceFactory: typeof startCacheRequestTrace = startCacheRequestTrace): void {
  if (installed.has(runtime)) return;
  installed.add(runtime);
  function guarded<TApi extends Api, TOptions extends ProviderRequestOptions<Model<TApi>> & ModelsRequestTransforms & Pick<StreamOptions, 'onProviderStreamEvent'>>(
    model: Model<TApi>, context: Context, options: TOptions | undefined,
    dispatch: (options: TOptions) => AssistantMessageEventStream,
  ): AssistantMessageEventStream {
    const invocation = invocationSettings.getStore();
    const settings = invocation?.settings ?? fallbackSettings();
    // Durable registers per task invocation; an explicit caller boundary (native sessions) always wins.
    const describeBoundary = invocation?.boundary ?? requestTraceBoundary(options?.signal);
    const stream = createAssistantMessageEventStream();
    const trace = (() => {
      try { return traceFactory(model, (options as { sessionId?: string } | undefined)?.sessionId, describeBoundary?.()); }
      catch { return undefined; }
    })();
    void (async () => {
      try {
        const validate = async () => {
          options?.signal?.throwIfAborted();
          await assertModelAdmission(runtime, settings, model);
          const current = runtime.getModel(model.provider, model.id);
          if (!current) throw new Error(`Pi 模型目录中已无 ${model.provider}/${model.id}`);
          const requestFacts = (entry: Model<Api>) => JSON.stringify([
            entry.api, entry.baseUrl, entry.contextWindow, entry.maxTokens, entry.input, entry.inputLimits,
            entry.reasoning, entry.thinkingLevelMap, entry.compat, entry.headers, entry.samplingParams, entry.samplingParamsByThinkingLevel,
          ]);
          if (requestFacts(model) !== requestFacts(current)) throw new Error("模型配置已变化，请在新轮次重新选择模型");
          assertImageCounts(current, context);
          options?.signal?.throwIfAborted();
          invocation?.validate?.();
        };
        await validate();
        const guardedOptions = {
          ...options,
          ...createRequestTransport(model, options, validate, trace),
          transformHeaders: async (headers: ProviderHeaders) => {
            const transformed = options?.transformHeaders ? await options.transformHeaders(headers) : headers;
            // Authentication and user approvals may have awaited since entry.
            await validate();
            return transformed;
          },
          onProviderStreamEvent: async (data: unknown, eventModel: Model<Api>) => {
            try { trace?.providerEvent(data); } catch { /* observation cannot fail a request */ }
            await options?.onProviderStreamEvent?.(data, eventModel);
          },
          onPayload: async (payload: unknown, payloadModel: Model<TApi>) => {
            const replacement = await requestIdentity.run(identity => { trace?.identify(identity); }, () => options?.onPayload?.(payload, payloadModel));
            await validate();
            trace?.payload(replacement === undefined ? payload : replacement);
            return replacement;
          },
        } as TOptions;
        for await (const event of dispatch(guardedOptions)) {
          if (event.type.endsWith('_delta') || event.type === 'done') trace?.firstResponse();
          if (event.type === 'done') trace?.result(event.message);
          else if (event.type === 'error') trace?.result(event.error);
          stream.push(event);
        }
        stream.end();
      } catch (error) {
        const reason = options?.signal?.aborted ? "aborted" : "error";
        const response: AssistantMessage = {
          role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
          stopReason: reason, errorMessage: error instanceof Error ? error.message : String(error), timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        trace?.result(response);
        stream.push({ type: "error", reason, error: response });
        stream.end();
      }
    })();
    return stream;
  }
  // enabledModels is Pi's chat scope. Non-chat calls keep native typed catalogs, but
  // must still respect the product's explicit provider pause and session revocation.
  const typedValidator = (provider: string, signal?: AbortSignal) => {
    const invocation = invocationSettings.getStore();
    const settings = invocation?.settings ?? fallbackSettings();
    return async () => {
      signal?.throwIfAborted();
      await settings.reload();
      const errors = settings.drainErrors();
      if (errors.length) throw errors[0]!.error;
      const raw = settings.getSettings() as { pausedProviderModels?: Record<string, unknown> };
      if (Object.hasOwn(raw.pausedProviderModels ?? {}, provider)) {
        throw new Error('Provider ' + provider + ' is disabled in model settings');
      }
      signal?.throwIfAborted();
      invocation?.validate?.();
    };
  };
  if (typeof runtime.generateImages === 'function') {
    const originalImages = runtime.generateImages.bind(runtime);
    runtime.generateImages = async (model, context, options) => {
      const validate = typedValidator(model.provider, options?.signal);
      try {
        await validate();
        return await originalImages(model, context, {
          ...options,
          transformHeaders: async headers => {
            const result = options?.transformHeaders ? await options.transformHeaders(headers) : headers;
            await validate(); return result;
          },
          onPayload: async (payload, selectedModel) => {
            const result = await options?.onPayload?.(payload, selectedModel);
            await validate(); return result;
          },
        });
      } catch (error) {
        return { api: model.api, provider: model.provider, model: model.id, output: [], timestamp: Date.now(),
          stopReason: options?.signal?.aborted ? 'aborted' : 'error', errorMessage: error instanceof Error ? error.message : String(error) };
      }
    };
  }
  if (typeof runtime.classify === 'function') {
    const originalClassify = runtime.classify.bind(runtime);
    runtime.classify = async (model, context, options) => {
      const validate = typedValidator(model.provider, options?.signal);
      try {
        await validate();
        return await originalClassify(model, context, {
          ...options,
          transformHeaders: async headers => {
            const result = options?.transformHeaders ? await options.transformHeaders(headers) : headers;
            await validate(); return result;
          },
          onPayload: async (payload, selectedModel) => {
            const result = await options?.onPayload?.(payload, selectedModel);
            await validate(); return result;
          },
        });
      } catch (error) {
        return { api: model.api, provider: model.provider, model: model.id, answers: {}, timestamp: Date.now(),
          stopReason: options?.signal?.aborted ? 'aborted' : 'error', errorMessage: error instanceof Error ? error.message : String(error) };
      }
    };
  }
  const originalSimple = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (model, context, options) => guarded(model, context, options,
    (checked) => originalSimple(model, context, checked));
  const originalApi = runtime.stream.bind(runtime);
  runtime.stream = (model, context, options) => guarded(model, context, options,
    (checked) => originalApi(model, context, checked));
}

/** Preserve workspace settings through tool loops, retries, and summary requests. */
export function bindSessionModelAdmission(session: AgentSession, admissionSettings: SettingsManager = session.settingsManager): void {
  if (boundSessions.has(session)) return;
  boundSessions.add(session);
  sessionsByManager.set(session.sessionManager, session);
  const dispose = session.dispose.bind(session);
  session.dispose = () => {
    if (sessionsByManager.get(session.sessionManager) === session) sessionsByManager.delete(session.sessionManager);
    dispose();
  };
  // A read-only child can keep private preferences while inheriting the parent's live enabledModels scope.
  const settings = admissionSettings;
  const stream = session.agent.streamFunction;
  session.agent.streamFunction = (...args) => withModelInvocationSettings(settings, () => stream(...args), requestGuards.get(session)?.(), () => sessionTraceBoundary(session, 'stream'));
  const validateHistory = () => requestGuards.get(session)?.()();
  const prompt = session.prompt.bind(session);
  // Automatic compaction calls the runtime outside agent.streamFunction. It still
  // carries source revocation checks through admission, auth, payload and retries.
  session.prompt = (...args) => withModelInvocationSettings(settings, () => prompt(...args), validateHistory, () => sessionTraceBoundary(session, 'prompt'));
  const compact = session.compact.bind(session);
  session.compact = (...args) => withModelInvocationSettings(settings, () => compact(...args), requestGuards.get(session)?.(), () => sessionTraceBoundary(session, 'compact'));
  const navigate = session.navigateTree.bind(session);
  session.navigateTree = (...args) => withModelInvocationSettings(settings, () => navigate(...args), requestGuards.get(session)?.(), () => sessionTraceBoundary(session, 'navigate'));
}
