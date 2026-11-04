import { createHash } from "node:crypto";
import type { BuiltinCapabilitiesConfigDto, SaveBuiltinCapabilitySettingsRequest, TestBuiltinCapabilityResultDto, BuiltinCapabilityStatusDto } from "../../shared/builtin-capabilities";
import { BUILTIN_CODEX_IMAGE_MODEL, BUILTIN_CODEX_IMAGE_PROVIDER_ID } from "../../shared/builtin-capabilities";
import { API_PROTOCOL_CAPABILITIES, CODEX_CONNECTION_ID, LOCAL_WHISPER_CONNECTION_ID, MAGPIE_CONNECTION_ID, MEDIA_CAPABILITY_IDS, MEDIA_PROVIDER_PRESETS, OPENROUTER_API_ROOT, connectionCapabilities, type CapabilityConnectionOption, type MediaCapabilityBinding, type MediaCapabilityId } from "../../shared/media-capabilities";
import type { MagpieGatewayConfig } from "../agent/providers/magpie";
import type { BuiltinCapabilityRuntime, GeneratedMediaOutput, MediaCapabilityProvider, SpeechCapabilityProvider, ToolExecutionContext } from "./BuiltinCapabilityRuntime";
import { createHttpOcrAdapter, type ImageRecognitionAdapter } from "./HttpOcrProvider";
import { discoverMagpieCapabilities, type MagpieCapabilityCatalog } from "./providers/MagpieCapabilityCatalog";
import { discoverOpenRouterCapabilities, type OpenRouterCapabilityCatalog } from "./providers/OpenRouterCapabilityCatalog";
import { createApiMediaProvider } from "./providers/ApiMediaProvider";
import { createApiSpeechProvider } from "./providers/ApiSpeechProvider";
import { createApiOcrAdapter } from "./providers/ApiOcrProvider";
import type { ResolvedApiConnection } from "./providers/ApiServiceConnection";
import type { VideoGenerationJobStore } from "./VideoGenerationJobs";

type ServiceStatus = Pick<BuiltinCapabilityStatusDto, "state" | "provider" | "credentialConfigured" | "detail">;

export function capabilityConfigRevision(config: BuiltinCapabilitiesConfigDto): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

export function capabilityEnabled(config: BuiltinCapabilitiesConfigDto, id: MediaCapabilityId): boolean {
  switch (id) {
    case "image-generation": return config.imageGeneration.enabled;
    case "video-generation": return config.videoGeneration.enabled;
    case "speech-to-text": return config.speechToText.enabled;
    case "text-to-speech": return config.textToSpeech.enabled;
    case "ocr": return config.ocr?.enabled === true;
  }
}

export function capabilityApiRoot(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error("请填写有效的 API 服务地址。"); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("API 地址须为 HTTP(S) 地址；密钥请填写在 API Key 中，不要放在地址里。");
  }
  if (url.pathname === "/") url.pathname = "/v1";
  return url.toString().replace(/\/+$/, "");
}

function location(baseUrl: string): "loopback" | "remote" {
  return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseUrl).hostname) ? "loopback" : "remote";
}

/** Main-process projection: reused identities, capability bindings, and actual adapters. */
export class MediaCapabilityServices {
  private magpieCatalog?: { identity: string; catalog: MagpieCapabilityCatalog };
  private magpieError?: string;
  private readonly openRouterCatalogs = new Map<string, { identity: string; catalog: OpenRouterCapabilityCatalog }>();
  private readonly openRouterErrors = new Map<string, string>();
  private refreshing?: Promise<void>;
  private readonly lastRuns = new Map<MediaCapabilityId, { key: string; at: number }>();

  constructor(private readonly options: {
    runtime: BuiltinCapabilityRuntime;
    getMagpieConfig: () => MagpieGatewayConfig | undefined;
    getDefaultProvider?: () => string | undefined;
    videoJobs: VideoGenerationJobStore;
    fetch?: typeof fetch;
    discover?: typeof discoverMagpieCapabilities;
    discoverOpenRouter?: typeof discoverOpenRouterCapabilities;
  }) {}

  private get runtime(): BuiltinCapabilityRuntime { return this.options.runtime; }

  /** Old schema-v1 selections remain usable and visible until deliberately changed. */
  binding(id: MediaCapabilityId, config = this.runtime.config()): MediaCapabilityBinding | undefined {
    if (config.mediaBindings?.[id]) return config.mediaBindings[id];
    if (id === "image-generation" && config.imageGeneration.provider === BUILTIN_CODEX_IMAGE_PROVIDER_ID) {
      return { connectionId: CODEX_CONNECTION_ID, model: config.imageGeneration.model, selection: "manual" };
    }
    if (id === "speech-to-text" && config.speechToText.provider === "local-whisper") return { connectionId: LOCAL_WHISPER_CONNECTION_ID, selection: "manual" };
    const serviceId = id === "ocr" ? config.ocr?.serviceId : id === "speech-to-text" && config.speechToText.provider === "http-asr" ? config.speechToText.serviceId : undefined;
    if (serviceId) {
      const service = config.services?.[serviceId];
      return { connectionId: `legacy:${serviceId}`, model: service?.model, dataPolicy: service?.dataPolicy, selection: "manual" };
    }
    const original = id === "image-generation" ? config.imageGeneration : id === "video-generation" ? config.videoGeneration : id === "text-to-speech" ? config.textToSpeech : id === "speech-to-text" ? config.speechToText : undefined;
    if (original?.provider) return { connectionId: `registered:${original.provider}`, model: "model" in original ? original.model : undefined, selection: "manual" };
    return undefined;
  }

  private magpieIdentity(config = this.options.getMagpieConfig()): string | undefined {
    if (!config?.baseUrl) return undefined;
    try {
      const headers = [...new Headers(config.headers).entries()].sort(([a], [b]) => a.localeCompare(b));
      return createHash("sha256").update(JSON.stringify({ baseUrl: capabilityApiRoot(config.baseUrl), key: config.apiKey ?? "", headers })).digest("hex");
    } catch { return undefined; }
  }

  private openRouterIdentity(id: string, config = this.runtime.config()): string | undefined {
    const connection = config.connections?.[id];
    if (!connection || connection.protocol !== "openrouter" || connection.baseUrl !== OPENROUTER_API_ROOT || !connection.credentialRef) return undefined;
    const secret = this.runtime.credentials.get(connection.credentialRef);
    return secret ? createHash("sha256").update(JSON.stringify([id, connection.baseUrl, connection.credentialRef, secret])).digest("hex") : undefined;
  }

  services(config = this.runtime.config()): CapabilityConnectionOption[] {
    const codex = this.runtime.registeredMediaProvider(BUILTIN_CODEX_IMAGE_PROVIDER_ID);
    const codexAvailable = codex?.isAvailable?.() === true;
    const result: CapabilityConnectionOption[] = [
      { id: CODEX_CONNECTION_ID, label: "OpenAI Codex", source: "login", capabilities: ["image-generation"], models: { "image-generation": [{ id: BUILTIN_CODEX_IMAGE_MODEL, label: "GPT Image 2" }] }, allowCustomModel: false, configured: codexAvailable, authState: codexAvailable ? "signed-in" : "needs-login", location: "remote", detail: codexAvailable ? "使用本应用已登录的 Codex 账号；尚未验证当前账号的生成额度。" : "请在模型供应商中登录 Codex。" },
      { id: LOCAL_WHISPER_CONNECTION_ID, label: "本机 Whisper · NPU", source: "local", capabilities: ["speech-to-text"], models: {}, allowCustomModel: false, configured: Boolean(this.runtime.registeredSpeechProvider("local-whisper")), authState: "none", location: "loopback", detail: "在本机转写文件；识别正文会提供给当前对话模型。" },
    ];
    const magpie = this.options.getMagpieConfig();
    if (magpie?.baseUrl || Object.values(config.mediaBindings ?? {}).some((binding) => binding?.connectionId === MAGPIE_CONNECTION_ID)) {
      let baseUrl: string | undefined;
      try { if (magpie?.baseUrl) baseUrl = capabilityApiRoot(magpie.baseUrl); } catch { /* incomplete external config remains visible */ }
      const catalog = this.magpieCatalog?.identity === this.magpieIdentity(magpie) ? this.magpieCatalog?.catalog : undefined;
      const imageModels = catalog?.models.filter((model) => model.kind === "image").map(({ id, label }) => ({ id, label })) ?? [];
      const videoModels = catalog?.models.filter((model) => model.kind === "video").map(({ id, label }) => ({ id, label })) ?? [];
      // Missing info is unknown; allow an explicit model without inventing a catalogue.
      const capabilities: MediaCapabilityId[] = [];
      if (imageModels.length) capabilities.push("image-generation");
      if (videoModels.length) capabilities.push("video-generation");
      if (catalog?.audio.asr.available !== false) capabilities.push("speech-to-text");
      if (catalog?.audio.tts.available !== false) capabilities.push("text-to-speech");
      // A temporarily unavailable catalogue must not erase a saved selection.
      for (const id of MEDIA_CAPABILITY_IDS) if (this.binding(id, config)?.connectionId === MAGPIE_CONNECTION_ID && !capabilities.includes(id)) capabilities.push(id);
      result.push({ id: MAGPIE_CONNECTION_ID, label: "Magpie", source: "login", capabilities, models: { "image-generation": imageModels, "video-generation": videoModels }, allowCustomModel: true, configured: Boolean(baseUrl), authState: baseUrl ? "configured" : "needs-login", ...(baseUrl ? { location: location(baseUrl) } : {}), detail: this.magpieError ?? (catalog ? "复用 Magpie 网关配置。音频模型请填写网关支持的 provider/model；目录不等于实际生成已验证。" : "请刷新服务目录；不会发送文件或执行生成。") });
    }
    for (const [id, connection] of Object.entries(config.connections ?? {})) {
      let baseUrl: string | undefined;
      try { baseUrl = capabilityApiRoot(connection.baseUrl); } catch { /* keep editable */ }
      const hasKey = Boolean(connection.credentialRef && this.runtime.credentials.has(connection.credentialRef));
      const identity = this.openRouterIdentity(id, config);
      const savedCatalog = this.openRouterCatalogs.get(id);
      const catalog = identity && savedCatalog?.identity === identity ? savedCatalog.catalog : undefined;
      const addressValid = connection.protocol !== "openrouter" || baseUrl === OPENROUTER_API_ROOT;
      result.push({
        id, label: connection.name, source: "api", capabilities: connectionCapabilities(connection),
        models: catalog?.models ?? {}, allowCustomModel: true,
        configured: Boolean(baseUrl && addressValid) && (connection.auth === "none" || hasKey),
        authState: connection.auth === "none" ? "none" : hasKey ? "configured" : "missing-key",
        ...(baseUrl ? { location: location(baseUrl) } : {}),
        detail: connection.protocol === "openrouter"
          ? this.openRouterErrors.get(id) ?? (catalog ? catalog.partial
              ? "部分模型目录已更新；没有列出的能力仍可手动填写有效模型 ID。"
              : "五项能力的模型目录已更新；以所选模型的实际权限和接口为准。"
            : "复用这一把 OpenRouter API Key。刷新目录会获取最新模型，不会执行付费生成。")
          : "已实现所选协议；模型与账号权限以服务端实际响应为准。",
      });
    }
    for (const [id, service] of Object.entries(config.services ?? {})) {
      if (service.adapter !== "http-asr" && service.adapter !== "http-ocr") continue;
      const capability = service.adapter === "http-asr" ? "speech-to-text" : "ocr";
      const hasKey = !service.credentialRef || this.runtime.credentials.has(service.credentialRef);
      result.push({ id: `legacy:${id}`, label: `已有${capability === "ocr" ? "识别" : "转写"}服务`, source: "legacy", capabilities: [capability], models: { [capability]: [{ id: service.model, label: service.model }] }, allowCustomModel: true, configured: Boolean(service.endpoint && service.model && hasKey), authState: !service.credentialRef ? "none" : hasKey ? "configured" : "missing-key", detail: service.dataPolicy === "local-only" ? "保留原有仅本地隐私限制；当前对话模型路径不能使用此服务。" : "保留原有服务协议和凭据；识别正文会进入当前对话。" });
    }
    for (const capability of MEDIA_CAPABILITY_IDS) {
      const binding = this.binding(capability, config);
      if (!binding?.connectionId.startsWith("registered:")) continue;
      const providerId = binding.connectionId.slice(11);
      const media = this.runtime.registeredMediaProvider(providerId);
      const speech = this.runtime.registeredSpeechProvider(providerId);
      const provider = capability === "image-generation" && media?.generateImage ? media
        : capability === "video-generation" && media?.generateVideo ? media
          : capability === "speech-to-text" && speech?.speechToText ? speech
            : capability === "text-to-speech" && speech?.textToSpeech ? speech : null;
      const hasKey = !provider?.credentialId || this.runtime.credentials.has(provider.credentialId);
      const available = provider && (!("isAvailable" in provider) || (provider as MediaCapabilityProvider).isAvailable?.() !== false);
      const existing = result.find((option) => option.id === binding.connectionId);
      if (existing) {
        if (provider) existing.capabilities.push(capability);
        if (binding.model) existing.models[capability] = [{ id: binding.model, label: binding.model }];
      } else result.push({ id: binding.connectionId, label: provider?.label ?? "原有服务（尚未接入）", source: "legacy", capabilities: provider ? [capability] : [], models: binding.model ? { [capability]: [{ id: binding.model, label: binding.model }] } : {}, allowCustomModel: true, configured: Boolean(available && hasKey), authState: !provider?.credentialId ? "none" : hasKey ? "configured" : "missing-key", detail: provider ? "保留原有已注册服务。" : "原选择已保留；当前版本未注册此服务，请选择已接入服务。" });
    }
    return result;
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const pending = (async () => {
      const config = this.options.getMagpieConfig();
      const identity = this.magpieIdentity(config);
      if (config?.baseUrl) {
        try {
          capabilityApiRoot(config.baseUrl);
          const catalog = await (this.options.discover ?? discoverMagpieCapabilities)(config, { fetchImpl: this.options.fetch });
          // Never associate a response with a gateway changed during the request.
          if (identity && this.magpieIdentity() === identity) {
            this.magpieCatalog = { identity, catalog };
            this.magpieError = undefined;
          }
        } catch (error) {
          if (this.magpieIdentity() === identity) this.magpieError = error instanceof Error ? error.message : "Magpie 服务目录读取失败。";
        }
      }
      // Refresh each saved OpenRouter connection with its own key. A changed
      // key or connection invalidates the result before any renderer projection.
      const configured = this.runtime.config();
      await Promise.all(Object.entries(configured.connections ?? {}).filter(([, connection]) => connection.protocol === "openrouter").map(async ([id, connection]) => {
        const identity = this.openRouterIdentity(id, configured);
        const key = connection.credentialRef ? this.runtime.credentials.get(connection.credentialRef) : undefined;
        if (!identity || !key) return;
        try {
          const catalog = await (this.options.discoverOpenRouter ?? discoverOpenRouterCapabilities)(key, { fetchImpl: this.options.fetch });
          if (this.openRouterIdentity(id) !== identity) return;
          this.openRouterCatalogs.set(id, { identity, catalog });
          this.openRouterErrors.delete(id);
        } catch {
          if (this.openRouterIdentity(id) === identity) this.openRouterErrors.set(id, "OpenRouter 模型目录暂不可用。原服务选择已保留，可手动填写模型 ID。");
        }
      }));
      this.resolveAutomaticImage();
    })();
    this.refreshing = pending;
    try { await pending; } finally { if (this.refreshing === pending) this.refreshing = undefined; }
  }

  /** Only a never-resolved auto binding changes here. No inference or fallback. */
  resolveAutomaticImage(): void {
    const config = this.runtime.config();
    const next = this.automaticImageConfig(config);
    if (next !== config) this.runtime.store.write(next);
  }

  private automaticImageConfig(config: BuiltinCapabilitiesConfigDto): BuiltinCapabilitiesConfigDto {
    const binding = config.mediaBindings?.["image-generation"];
    if (!config.imageGeneration.enabled || binding?.selection !== "auto" || binding.connectionId) return config;
    const candidates = this.services(config).filter((service) => service.configured && service.capabilities.includes("image-generation") && service.models["image-generation"]?.length && ([MAGPIE_CONNECTION_ID, CODEX_CONNECTION_ID].includes(service.id) || config.connections?.[service.id]?.protocol === "openrouter"));
    const preferred = this.options.getDefaultProvider?.() === "magpie" ? MAGPIE_CONNECTION_ID : CODEX_CONNECTION_ID;
    candidates.sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred) || a.id.localeCompare(b.id));
    const selected = candidates[0];
    if (!selected) return config;
    const model = [...selected.models["image-generation"]!].sort((a, b) => a.id.localeCompare(b.id))[0]!.id;
    return { ...config, mediaBindings: { ...config.mediaBindings, "image-generation": { connectionId: selected.id, model, selection: "auto" } } };
  }

  private resolveApi(capability: MediaCapabilityId, connectionId?: string): ResolvedApiConnection {
    const config = this.runtime.config();
    const binding = this.binding(capability, config);
    const id = connectionId ?? binding?.connectionId;
    if (!id) throw new Error("请先选择服务。");
    const model = binding?.connectionId === id ? binding.model : undefined;
    if (id === MAGPIE_CONNECTION_ID) {
      const magpie = this.options.getMagpieConfig();
      if (!magpie?.baseUrl) throw new Error("Magpie 网关尚未连接。");
      let headers: Headers;
      try {
        headers = new Headers(magpie.headers);
        if (magpie.apiKey && !headers.has("authorization")) headers.set("authorization", `Bearer ${magpie.apiKey}`);
      } catch { throw new Error("Magpie 网关请求头配置无效。"); }
      return { id, label: "Magpie", baseUrl: capabilityApiRoot(magpie.baseUrl), headers: Object.fromEntries(headers), protocol: "magpie", timeoutMs: 300_000, model };
    }
    const connection = config.connections?.[id];
    if (!connection || !connectionCapabilities(connection).includes(capability)) throw new Error("所选服务不支持此能力。");
    if (connection.protocol === "openrouter" && (connection.baseUrl !== OPENROUTER_API_ROOT || connection.auth !== "api-key")) throw new Error("OpenRouter 连接必须使用官方 API 地址和 API Key。");
    const secret = connection.auth === "api-key" && connection.credentialRef ? this.runtime.credentials.get(connection.credentialRef) : undefined;
    if (connection.auth === "api-key" && !secret) throw new Error("请填写此服务的 API Key。");
    return { id, label: connection.name, baseUrl: capabilityApiRoot(connection.baseUrl), protocol: connection.protocol, timeoutMs: connection.timeoutMs, model, headers: secret ? { authorization: `Bearer ${secret}` } : {}, ...(connection.presetId === "groq" ? { speechFormat: "wav" as const } : {}) };
  }

  private key(id: MediaCapabilityId): string {
    const config = this.runtime.config();
    const binding = this.binding(id, config);
    return JSON.stringify({ binding, speech: id === "text-to-speech" ? config.textToSpeech : undefined, identity: binding?.connectionId === MAGPIE_CONNECTION_ID ? this.magpieIdentity() : undefined, connection: binding ? config.connections?.[binding.connectionId] : undefined, legacy: binding?.connectionId.startsWith("legacy:") ? config.services?.[binding.connectionId.slice(7)] : undefined });
  }

  invalidateCredentialChecks(): void { this.lastRuns.clear(); }

  private completed(id: MediaCapabilityId, key: string): void { this.lastRuns.set(id, { key, at: Date.now() }); }

  hasVideoJobs(taskId: string): boolean {
    try { return this.options.videoJobs.list(taskId).some((job) => job.state !== "failed"); }
    catch { return false; /* A damaged ledger still fails closed if a generation is attempted. */ }
  }

  async resumeVideo(jobId: string, context: ToolExecutionContext): Promise<GeneratedMediaOutput> {
    if (!capabilityEnabled(this.runtime.config(), "video-generation")) throw new Error("视频生成已关闭。");
    const job = this.options.videoJobs.get(jobId);
    if (!job || job.taskId !== context.taskId) throw new Error("视频任务不存在或不属于当前任务。");
    const binding = this.binding("video-generation");
    const matchingBinding = binding?.connectionId === job.connection.id && binding.model === job.connection.model;
    const key = matchingBinding ? this.key("video-generation") : undefined;
    const provider = createApiMediaProvider({
      id: job.connection.id, label: job.connection.label,
      getConnection: (connectionId) => this.resolveApi("video-generation", connectionId ?? job.connection.id),
      jobStore: this.options.videoJobs, fetch: this.options.fetch,
    });
    const result = await provider.generateVideo!({ jobId }, context);
    if (key) this.completed("video-generation", key);
    return result;
  }

  mediaProvider(id: "image-generation" | "video-generation"): MediaCapabilityProvider | null {
    const binding = this.binding(id);
    if (!binding?.connectionId) return null;
    let provider: MediaCapabilityProvider | null;
    if (binding.connectionId === CODEX_CONNECTION_ID && id === "image-generation") provider = this.runtime.registeredMediaProvider(BUILTIN_CODEX_IMAGE_PROVIDER_ID);
    else if (binding.connectionId.startsWith("registered:")) provider = this.runtime.registeredMediaProvider(binding.connectionId.slice(11));
    else if (binding.connectionId === MAGPIE_CONNECTION_ID || this.runtime.config().connections?.[binding.connectionId]) {
      provider = createApiMediaProvider({ id: binding.connectionId, label: this.services().find((service) => service.id === binding.connectionId)?.label ?? "API 服务", getConnection: (connectionId) => this.resolveApi(id, connectionId), jobStore: this.options.videoJobs, fetch: this.options.fetch });
    } else return null;
    if (!provider || (id === "image-generation" ? !provider.generateImage : !provider.generateVideo)) return null;
    return {
      ...provider,
      ...(provider.generateImage ? { generateImage: async (input, context) => {
        if (!capabilityEnabled(this.runtime.config(), id)) throw new Error("图片生成已关闭。");
        const key = this.key(id);
        const result = await provider.generateImage!({ ...input, model: input.model ?? this.binding(id)?.model }, context);
        this.completed(id, key); return result;
      } } : {}),
      ...(provider.generateVideo ? { generateVideo: async (input, context) => {
        if (!capabilityEnabled(this.runtime.config(), id)) throw new Error("视频生成已关闭。");
        if (input.jobId) {
          if (Object.entries(input).some(([key, value]) => key !== "jobId" && value !== undefined)) throw new Error("恢复视频时只传 jobId；请保留原任务参数。");
          return this.resumeVideo(input.jobId, context);
        }
        const key = this.key(id);
        const result = await provider.generateVideo!({ ...input, model: input.jobId ? undefined : input.model ?? this.binding(id)?.model }, context);
        this.completed(id, key); return result;
      } } : {}),
    };
  }

  speechProvider(id: "speech-to-text" | "text-to-speech"): SpeechCapabilityProvider | null {
    const binding = this.binding(id);
    if (!binding?.connectionId) return null;
    const provider = binding.connectionId === LOCAL_WHISPER_CONNECTION_ID && id === "speech-to-text" ? this.runtime.registeredSpeechProvider("local-whisper")
      : binding.connectionId.startsWith("legacy:") && id === "speech-to-text" ? this.runtime.registeredSpeechProvider("http-asr")
        : binding.connectionId.startsWith("registered:") ? this.runtime.registeredSpeechProvider(binding.connectionId.slice(11))
        : binding.connectionId === MAGPIE_CONNECTION_ID || this.runtime.config().connections?.[binding.connectionId]
          ? createApiSpeechProvider({ id: binding.connectionId, label: this.services().find((service) => service.id === binding.connectionId)?.label ?? "API 服务", getConnection: (connectionId) => this.resolveApi(id, connectionId), fetch: this.options.fetch }) : null;
    if (!provider || (id === "speech-to-text" ? !provider.speechToText : !provider.textToSpeech)) return null;
    return { ...provider,
      ...(provider.speechToText ? { speechToText: async (input, context) => {
        if (!capabilityEnabled(this.runtime.config(), id)) throw new Error("语音转文字已关闭。");
        this.assertRecognitionPolicy("speech-to-text");
        const key = this.key(id);
        const result = await provider.speechToText!({ ...input, model: input.model ?? this.binding(id)?.model }, context);
        this.completed(id, key); return result;
      } } : {}),
      ...(provider.textToSpeech ? { textToSpeech: async (input, context) => {
        if (!capabilityEnabled(this.runtime.config(), id)) throw new Error("文字转语音已关闭。");
        const key = this.key(id);
        const result = await provider.textToSpeech!({ ...input, model: input.model ?? this.binding(id)?.model }, context);
        this.completed(id, key); return result;
      } } : {}),
    };
  }

  ocrAdapter(): ImageRecognitionAdapter | null {
    const binding = this.binding("ocr");
    if (!binding?.connectionId) return null;
    const adapter = binding.connectionId.startsWith("legacy:") ? createHttpOcrAdapter(this.runtime)
      : this.runtime.config().connections?.[binding.connectionId] ? createApiOcrAdapter({ getConnection: () => this.resolveApi("ocr"), fetch: this.options.fetch }) : null;
    if (!adapter) return null;
    return { recognize: async (path, context) => {
      if (!capabilityEnabled(this.runtime.config(), "ocr")) throw new Error("图片文字识别已关闭。");
      this.assertRecognitionPolicy("ocr");
      const key = this.key("ocr");
      const result = await adapter.recognize(path, context);
      this.completed("ocr", key); return result;
    } };
  }

  assertRecognitionPolicy(id: "speech-to-text" | "ocr"): void {
    const config = this.runtime.config();
    const binding = this.binding(id, config);
    const legacy = binding?.connectionId.startsWith("legacy:") ? config.services?.[binding.connectionId.slice(7)] : undefined;
    if (binding?.dataPolicy === "local-only" || legacy?.dataPolicy === "local-only") throw new Error("policy: local-only recognition is blocked because the current conversation may use a cloud model; zero upload. 原有仅本地隐私限制仍生效。");
  }

  status(id: MediaCapabilityId): ServiceStatus {
    const config = this.runtime.config();
    if (!capabilityEnabled(config, id)) return { state: "disabled", detail: "已关闭。保存后新会话按此设置提供工具。" };
    const binding = this.binding(id, config);
    const service = this.services().find((entry) => entry.id === binding?.connectionId);
    if (!service) return { state: "needs-configuration", detail: binding?.selection === "auto" ? "等待可用的已登录图片服务；可刷新目录或手动选择。" : "请选择服务并填写所需模型。" };
    const base = { provider: service.label, credentialConfigured: service.configured };
    if (!service.capabilities.includes(id)) return { ...base, state: "needs-configuration", detail: "所选服务不支持此能力，请重新选择。" };
    if (!service.configured) return { ...base, state: "needs-configuration", detail: service.authState === "missing-key" ? "请填写此服务的 API Key。" : service.detail ?? "请完成服务配置。" };
    if (id === "ocr" || id === "speech-to-text") {
      try { this.assertRecognitionPolicy(id); } catch (error) { return { ...base, state: "needs-configuration", detail: (error as Error).message }; }
    }
    if (binding?.connectionId !== LOCAL_WHISPER_CONNECTION_ID && !binding?.connectionId.startsWith("registered:") && !binding?.model) return { ...base, state: "needs-configuration", detail: "请填写此能力使用的模型。" };
    if (id === "text-to-speech" && !binding.connectionId.startsWith("registered:") && !config.textToSpeech.voice) return { ...base, state: "needs-configuration", detail: "请填写服务支持的默认音色，或在调用时指定音色。" };
    const last = this.lastRuns.get(id);
    return { ...base, state: last?.key === this.key(id) ? "ready" : "unchecked", detail: last?.key === this.key(id) ? `最近成功使用：${new Date(last.at).toLocaleString()}。` : "配置已保存；尚未执行实际任务。检查不会发送样本或产生生成请求。" };
  }

  async test(id: MediaCapabilityId): Promise<TestBuiltinCapabilityResultDto> {
    const status = this.status(id);
    if (status.state !== "ready" && status.state !== "unchecked") return { ok: false, state: status.state, detail: status.detail ?? "请完成配置。", checkedAt: Date.now() };
    try {
      const binding = this.binding(id)!;
      if (binding.connectionId === CODEX_CONNECTION_ID) await this.runtime.registeredMediaProvider(BUILTIN_CODEX_IMAGE_PROVIDER_ID)?.test?.();
      else if (binding.connectionId === LOCAL_WHISPER_CONNECTION_ID) await this.runtime.registeredSpeechProvider("local-whisper")?.test?.();
      else if (binding.connectionId.startsWith("legacy:")) this.runtime.recognitionService(id as "ocr" | "speech-to-text", id === "ocr" ? "http-ocr" : "http-asr");
      else if (binding.connectionId.startsWith("registered:")) { /* Configuration only: custom tests may perform inference. */ }
      else this.resolveApi(id);
      return { ok: true, state: "unchecked", detail: "配置检查通过；未发送样本，实际模型权限和输出需在任务中验证。", checkedAt: Date.now() };
    } catch (error) {
      return { ok: false, state: "needs-configuration", detail: error instanceof Error ? error.message : "服务检查失败。", checkedAt: Date.now() };
    }
  }

  /** Validate first, then update secrets and config together; rollback on a write failure. */
  save(request: SaveBuiltinCapabilitySettingsRequest): void {
    const previous = this.runtime.config();
    if (request.expectedRevision && request.expectedRevision !== capabilityConfigRevision(previous)) throw new Error("设置已在其他位置改变。请重新载入后再保存；当前草稿仍保留。");
    const next = structuredClone(request.config);
    if (next.schemaVersion !== previous.schemaVersion) throw new Error("配置版本不匹配，请重新载入设置。");
    for (const [id, connection] of Object.entries(next.connections ?? {})) {
      if (!/^api-[a-z0-9-]{1,80}$/i.test(id) || !API_PROTOCOL_CAPABILITIES[connection.protocol]) throw new Error("API 服务类型无效。");
      connection.baseUrl = capabilityApiRoot(connection.baseUrl);
      const preset = MEDIA_PROVIDER_PRESETS.find(item => item.id === connection.presetId);
      if (connection.presetId && (!preset || preset.protocol !== connection.protocol || connection.baseUrl !== preset.baseUrl || connection.auth !== "api-key")) throw new Error("内置服务商的协议或地址不匹配；如需代理地址请另建自定义 API 服务。");
      if (connection.protocol === "openrouter" && (connection.baseUrl !== OPENROUTER_API_ROOT || connection.auth !== "api-key")) throw new Error("OpenRouter 只允许官方 HTTPS API 地址和 Key 认证。");
      if (!Number.isSafeInteger(connection.timeoutMs) || connection.timeoutMs < 1000 || connection.timeoutMs > 600_000) throw new Error("请求超时应为 1 至 600 秒。");
      connection.credentialRef = previous.connections?.[id]?.credentialRef;
    }
    for (const [id, service] of Object.entries(next.services ?? {})) {
      const old = previous.services?.[id];
      if (old?.credentialRef) service.credentialRef = old.credentialRef;
      if (old?.dataPolicy === "local-only") service.dataPolicy = "local-only";
    }
    const changes = new Map<string, { secret?: string; clear?: boolean }>();
    for (const change of request.credentials ?? []) {
      if (!change.clear && !change.secret?.trim()) continue;
      if (change.clear && change.secret?.trim()) throw new Error("请分别执行替换密钥或清除密钥。");
      const legacyId = change.connectionId.startsWith("legacy:") ? change.connectionId.slice(7) : undefined;
      const connection = legacyId ? next.services?.[legacyId] : next.connections?.[change.connectionId];
      if (!connection) throw new Error("待保存密钥的服务不存在。");
      const ref = connection.credentialRef ?? `media.${createHash("sha256").update(change.connectionId).digest("hex").slice(0,40)}`;
      connection.credentialRef = ref;
      const prior = changes.get(ref);
      if (prior && (prior.secret !== change.secret || prior.clear !== change.clear)) throw new Error("共享密钥收到不同修改，请只修改一次。");
      changes.set(ref, change);
    }
    const oldSecrets = new Map<string, string | null>();
    try {
      for (const [ref, change] of changes) {
        oldSecrets.set(ref, this.runtime.credentials.get(ref));
        if (change.clear) {
          this.runtime.credentials.clear(ref);
          if (this.runtime.credentials.get(ref) !== null) throw new Error("Keyring refused to clear credential");
        } else this.runtime.credentials.set(ref, change.secret!.trim());
      }
      this.runtime.store.write(this.automaticImageConfig(next));
    } catch {
      let restored = true;
      for (const [ref, secret] of oldSecrets) {
        try {
          if (secret) this.runtime.credentials.set(ref, secret); else this.runtime.credentials.clear(ref);
          if (this.runtime.credentials.get(ref) !== secret) restored = false;
        }
        catch { restored = false; }
      }
      throw new Error(restored ? "服务设置未保存，原密钥已保留。请检查凭据库和配置文件是否可写后重试。" : "服务设置未保存，部分密钥恢复失败。请重新填写受影响服务的 API Key。");
    }
    this.lastRuns.clear();
  }
}
