/** Trusted child-process entry. Disk extensions remain disabled by the host. */
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { createRequestTransport } from "../../agent/request-transport.mjs";
import { EphemeralContextProjection } from "./vendor/context-projection.mjs";
import { commandCodeProvider } from "./vendor/command-code.mjs";
import { CacheRequestTracer, sessionTraceBoundary } from "./vendor/cache-request-trace.mjs";

const EXPECTED_PI_VERSION = "1.3.0";

const requestedCli = realpathSync(resolve(process.argv[2] ?? ""));
const bundled = requestedCli.endsWith('/pi-runtime.mjs') || requestedCli.endsWith('\\pi-runtime.mjs');
let pi, ai, anthropic, completions, responses, cliPath, loadExtensionFromFactory, writeRawStdout, bundledRuntime;
if (bundled) {
  const manifest = JSON.parse(readFileSync(join(dirname(requestedCli), 'package.json'), 'utf8'));
  if (manifest.name !== '@wavealstra/pi-worker-runtime' || manifest.version !== EXPECTED_PI_VERSION) throw new Error('Packaged Pi worker version mismatch');
  bundledRuntime = await import(pathToFileURL(requestedCli).href);
  ({ pi, ai, loadExtensionFromFactory, writeRawStdout } = bundledRuntime);
  anthropic = bundledRuntime; completions = bundledRuntime; responses = bundledRuntime;
  cliPath = requestedCli;
  if (pi.VERSION !== EXPECTED_PI_VERSION) throw new Error('Packaged native Pi version mismatch');
} else {
let packageRoot = dirname(requestedCli);
for (;;) {
  const manifestPath = join(packageRoot, "package.json");
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.name === "@earendil-works/pi-coding-agent") {
      if (manifest.version !== EXPECTED_PI_VERSION) throw new Error(`子代理需要 Pi ${EXPECTED_PI_VERSION}，当前为 ${manifest.version}`);
      break;
    }
  }
  const parent = dirname(packageRoot);
  if (parent === packageRoot) throw new Error("子代理 CLI 不属于受支持的 Pi 安装");
  packageRoot = parent;
}
// The npm bin may point at dist/bundle/cli.js, which embeds independent classes.
// Use the same installed package's unbundled CLI and SDK for the trusted hooks.
cliPath = join(packageRoot, "dist/cli.js");
if (!existsSync(cliPath)) throw new Error(`Pi 安装缺少原生 CLI 模块，请修复 Pi ${EXPECTED_PI_VERSION} 安装`);
const cliRequire = createRequire(cliPath);
pi = await import(pathToFileURL(join(dirname(cliPath), "index.js")).href);
// pi-ai exposes only the ESM import condition. Use Node's dependency search
// roots from the real CLI path; require.resolve(package) cannot resolve it.
const aiRoot = cliRequire.resolve.paths("@earendil-works/pi-ai")
  ?.map((root) => join(root, "@earendil-works/pi-ai"))
  .find((root) => existsSync(join(root, "package.json")));
if (!aiRoot || JSON.parse(readFileSync(join(aiRoot, "package.json"), "utf8")).version !== EXPECTED_PI_VERSION) {
  throw new Error(`子代理 Pi AI 依赖与 ${EXPECTED_PI_VERSION} Runtime 不一致`);
}
ai = await import(pathToFileURL(realpathSync(join(aiRoot, "dist/index.js"))).href);
[anthropic, completions, responses] = await Promise.all([
  "anthropic-messages", "openai-completions", "openai-responses",
].map((name) => import(pathToFileURL(realpathSync(join(aiRoot, "dist/api", `${name}.lazy.js`))).href)));
if (pi.VERSION !== EXPECTED_PI_VERSION) throw new Error(`子代理需要 Pi ${EXPECTED_PI_VERSION}，当前为 ${pi.VERSION}`);

  ({ loadExtensionFromFactory } = await import(pathToFileURL(join(dirname(cliPath), 'core/extensions/loader.js')).href));
  ({ writeRawStdout } = await import(pathToFileURL(join(dirname(cliPath), 'core/output-guard.js')).href));
}
const settings = pi.SettingsManager.create(process.cwd(), pi.getAgentDir());
const createRuntime = pi.ModelRuntime.create.bind(pi.ModelRuntime);
const invocationGuard = new AsyncLocalStorage();
const cacheTracer = process.env.MYBUDDY_CACHE_TRACE === '0' ? undefined : new CacheRequestTracer(record => {
  writeRawStdout(JSON.stringify({ type: 'mybuddy_cache_trace', record }) + '\n');
});
const projections = new WeakMap();
const attachedSessions = new WeakSet();
const attachedLoaders = new WeakSet();


// Keep the CLI's native loader and RPC lifecycle. Add one trusted inline factory
// after loading, while --no-extensions still disables disk auto-discovery.
const reloadResources = pi.DefaultResourceLoader.prototype.reload;
pi.DefaultResourceLoader.prototype.reload = async function (...args) {
  if (attachedLoaders.has(this)) throw new Error("子代理上下文重载需要重新创建 worker");
  await reloadResources.apply(this, args);
  const result = this.getExtensions();
  const projection = new EphemeralContextProjection({
    enabled: () => false,
    scope: () => ({}),
    supplementalEvidence: () => [],
    log: (metadata) => console.error(metadata),
    registerRequestGuard: (session, capture) => {
      const stream = session.agent.streamFunction;
      session.agent.streamFunction = (...input) => invocationGuard.run({ validate: capture(),
        boundary: sessionTraceBoundary(session, 'stream') }, () => stream(...input));
    },
  });
  const extension = await loadExtensionFromFactory(projection.extension, process.cwd(), pi.createEventBus(), result.runtime, "<inline:mybuddy-worker-context>");
  result.extensions.push(extension);
  projections.set(this, projection);
};
const bindExtensions = pi.AgentSession.prototype.bindExtensions;
pi.AgentSession.prototype.bindExtensions = async function (...args) {
  if (!attachedSessions.has(this)) {
    const projection = projections.get(this.resourceLoader);
    if (!projection) throw new Error("子代理缺少受信任的上下文预算入口");
    projection.attach(this);
    attachedSessions.add(this);
    attachedLoaders.add(this.resourceLoader);
  }
  return bindExtensions.apply(this, args);
};

// CLI and this entry import the same native module. Each child owns its one
// native runtime; no host catalog, credentials, or preference copies cross IPC.
pi.ModelRuntime.create = async (...args) => {
  const runtime = await createRuntime(...args);
  runtime.registerNativeProvider(commandCodeProvider(ai, {
    "anthropic-messages": anthropic.anthropicMessagesApi(),
    "openai-completions": completions.openAICompletionsApi(),
    "openai-responses": responses.openAIResponsesApi(),
  }));
  await runtime.refresh({ allowNetwork: false, providers: ["commandcode"] });
  for (const method of ["stream", "streamSimple"]) {
    const dispatch = runtime[method].bind(runtime);
    runtime[method] = (model, context, options = {}) => {
      const requestGuard = invocationGuard.getStore();
      const trace = cacheTracer?.start(model, options.sessionId, requestGuard?.boundary);
      const output = ai.createAssistantMessageEventStream();
      void (async () => {
        try {
          await runtime.refresh({ allowNetwork: false });
          const catalogError = runtime.getError();
          if (catalogError) throw new Error(catalogError);
          const validate = async () => {
            options.signal?.throwIfAborted();
            await settings.reload();
            const errors = settings.drainErrors();
            if (errors.length) throw new Error(`子代理 Pi 设置读取失败：${errors[0].error.message}`);
            const patterns = settings.getEnabledModels();
            if (patterns !== undefined) {
              const { scopedModels } = await pi.resolveModelScopeWithDiagnostics(patterns, runtime);
              if (!scopedModels.some(({ model: allowed }) => allowed.provider === model.provider && allowed.id === model.id) &&
                  !patterns.some((pattern) => {
                    // A pattern naming this exact model is the authorization, even when this child cannot
                    // resolve it into the scoped list (unknown virtual ids report a no-match diagnostic).
                    // getModel plus the config comparison below still rejects a model this child cannot serve.
                    const base = String(pattern).replace(/:(?:max|xhigh|high|medium|low|none)$/i, "");
                    return base === `${model.provider}/${model.id}` || base === model.id;
                  })) {
                throw new Error(`子代理模型 ${model.provider}/${model.id} 已不在当前允许范围内`);
              }
            }
            const current = runtime.getModel(model.provider, model.id);
            const facts = (entry) => JSON.stringify([entry.api, entry.baseUrl, entry.contextWindow, entry.maxTokens, entry.input, entry.inputLimits,
              entry.reasoning, entry.thinkingLevelMap, entry.compat, entry.headers, entry.samplingParams, entry.samplingParamsByThinkingLevel]);
            if (!current || facts(current) !== facts(model)) throw new Error("子代理模型配置已变化，请重新发起任务");
            const limits = current.inputLimits?.images;
            let total = 0;
            for (const message of ai.normalizeContext(context).messages) {
              const count = Array.isArray(message.content) ? message.content.filter((part) => part.type === "image").length : 0;
              total += count;
              if (limits?.maxPerMessage !== undefined && count > limits.maxPerMessage) throw new Error("子代理消息图片数量超过模型限制");
            }
            if (limits?.maxPerRequest !== undefined && total > limits.maxPerRequest) throw new Error("子代理请求图片数量超过模型限制");
            options.signal?.throwIfAborted();
            requestGuard?.validate();
          };
          await validate();
          for await (const event of dispatch(model, context, {
            ...options,
            ...createRequestTransport(model, options, validate, trace),
            transformHeaders: async (headers) => {
              const transformed = options.transformHeaders ? await options.transformHeaders(headers) : headers;
              await validate();
              return transformed;
            },
            onPayload: async (payload, payloadModel) => {
              const replacement = await options.onPayload?.(payload, payloadModel);
              await validate();
              trace?.payload(replacement === undefined ? payload : replacement);
              return replacement;
            },
          })) {
            if (event.type === 'done') trace?.result(event.message);
            else if (event.type === 'error') trace?.result(event.error);
            output.push(event);
          }
          output.end();
        } catch (error) {
          const reason = options.signal?.aborted ? "aborted" : "error";
          const response = {
            role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
            stopReason: reason, errorMessage: error instanceof Error ? error.message : String(error), timestamp: Date.now(),
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          };
          trace?.result(response);
          output.push({ type: "error", reason, error: response });
          output.end();
        }
      })();
      return output;
    };
  }
  return runtime;
};

// Preserve native CLI argument and process identity before loading its entry.
process.argv.splice(1, 1);
process.argv[1] = cliPath;
if (bundledRuntime) { bundledRuntime.setupCli(); await bundledRuntime.main(process.argv.slice(2)); }
else await import(pathToFileURL(cliPath).href);
