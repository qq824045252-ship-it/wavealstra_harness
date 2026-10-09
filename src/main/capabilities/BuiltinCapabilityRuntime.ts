import type {
  BuiltinCapabilitiesConfigDto,
  BuiltinCapabilitiesSnapshotDto,
  BuiltinCapabilityId,
  BuiltinCapabilityStatusDto,
  BuiltinCredentialId,
  TestBuiltinCapabilityResultDto,
} from "../../shared/builtin-capabilities";
import { BUILTIN_CAPABILITY_TOOLS } from "../../shared/builtin-capabilities";
import { consultDistinctModelCount } from "../../shared/multi-model-consult";
import { BuiltinCapabilityStore } from "./BuiltinCapabilityStore";
import { BuiltinCredentialStore } from "./BuiltinCredentialStore";

export interface ToolExecutionContext {
  taskId: string;
  taskRoot: string;
  toolCallId: string;
  producerMessageId?: string;
  signal?: AbortSignal;
}

export interface VisionDescribeInput {
  imagePaths: string[];
  prompt?: string;
}

export interface VisionDescribeOutput {
  descriptions: Array<{ imagePath: string; text: string }>;
  provider: string;
  metadata?: Record<string, unknown>;
}

export interface VisionCapabilityProvider {
  readonly id: string;
  readonly label: string;
  readonly credentialId?: BuiltinCredentialId;
  describe(input: VisionDescribeInput, context: ToolExecutionContext): Promise<VisionDescribeOutput>;
  test?(): Promise<string>;
}

export interface ImageGenerateInput {
  prompt: string;
  negativePrompt?: string;
  aspectRatio?: string;
  width?: number;
  height?: number;
  count?: number;
  model?: string;
  seed?: number;
  inputImagePaths?: string[];
}

export interface VideoGenerateInput {
  prompt: string;
  negativePrompt?: string;
  aspectRatio?: string;
  durationSeconds?: number;
  resolution?: string;
  model?: string;
  seed?: number;
  inputImagePath?: string;
  generateAudio?: boolean;
}

export interface GeneratedMediaItem {
  /** Provider may return bytes, a URL, or a task-root local path. */
  bytes?: Uint8Array;
  url?: string;
  localPath?: string;
  mimeType: string;
  fileName?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  metadata?: Record<string, unknown>;
}

export interface GeneratedMediaOutput {
  items: GeneratedMediaItem[];
  provider: string;
  model?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
}

export interface MediaCapabilityProvider {
  readonly id: string;
  readonly label: string;
  readonly credentialId?: BuiltinCredentialId;
  /** Runtime-backed adapters may depend on an existing login rather than a separate credential. */
  isAvailable?(): boolean;
  availabilityDetail?(): string | undefined;
  generateImage?(input: ImageGenerateInput, context: ToolExecutionContext): Promise<GeneratedMediaOutput>;
  generateVideo?(input: VideoGenerateInput, context: ToolExecutionContext): Promise<GeneratedMediaOutput>;
  test?(): Promise<string>;
}

export interface SpeechToTextInput {
  audioPath: string;
  language?: string;
  prompt?: string;
}

export interface SpeechToTextOutput {
  text: string;
  language?: string;
  provider: string;
  metadata?: Record<string, unknown>;
}

export interface TextToSpeechInput {
  text: string;
  voice?: string;
  rate?: string;
  format?: "mp3" | "wav" | "ogg";
}

export interface SpeechCapabilityProvider {
  readonly id: string;
  readonly label: string;
  readonly credentialId?: BuiltinCredentialId;
  speechToText?(input: SpeechToTextInput, context: ToolExecutionContext): Promise<SpeechToTextOutput>;
  textToSpeech?(input: TextToSpeechInput, context: ToolExecutionContext): Promise<GeneratedMediaOutput>;
  test?(): Promise<string>;
}

type ProviderKind = "vision" | "media" | "speech";
type AnyProvider = VisionCapabilityProvider | MediaCapabilityProvider | SpeechCapabilityProvider;

export type LocalCapabilityId = "browser" | "terminal" | "code-execution" | "subagent" | "runtime-diagnostics";
export interface LocalCapabilityCheckResult { state: "ready" | "degraded"; detail: string }
export interface LocalCapabilityAvailability { available: boolean; tools?: string[]; detail?: string }

const LABELS: Record<string, { label: string; description: string; category: BuiltinCapabilityStatusDto["category"] }> = {
  web: { label: "联网搜索", description: "搜索互联网并提取网页正文。", category: "web" },
  vision: { label: "图像理解", description: "分析任务目录内的图片。", category: "media" },
  "image-generation": { label: "图像生成", description: "生成或编辑图片并保存为任务产物。", category: "media" },
  "video-generation": { label: "视频生成", description: "从文本或图片生成视频并保存为任务产物。", category: "media" },
  "speech-to-text": { label: "语音转文字", description: "把任务内音频转写为文本。", category: "speech" },
  "text-to-speech": { label: "文字转语音", description: "把文本合成为任务音频产物。", category: "speech" },
  browser: { label: "界面与桌面操作", description: "操作 MyBuddy 浏览器/主界面，并在必要时执行受控 Windows 桌面交互。", category: "automation" },
  "runtime-diagnostics": { label: "运行诊断", description: "读取应用、浏览器与产物的运行状态和日志。", category: "automation" },
  terminal: { label: "命令执行", description: "直接使用 Pi 原生 bash 执行命令。", category: "execution" },
  "code-execution": { label: "代码执行", description: "在任务目录内执行一次性代码。", category: "execution" },
  subagent: { label: "子代理", description: "把有边界的子任务委派给独立 Subagent。", category: "agent" },
};

export class BuiltinCapabilityRuntime {
  readonly store: Pick<BuiltinCapabilityStore, "read" | "write">;
  readonly credentials: Pick<BuiltinCredentialStore, "has" | "get" | "set" | "clear">;
  private readonly providers = new Map<string, AnyProvider>();
  private browserAvailable = false;
  private subagentAvailable = false;
  private readonly localChecks = new Map<LocalCapabilityId, {
    run: () => Promise<LocalCapabilityCheckResult>;
    availability?: () => LocalCapabilityAvailability;
  }>();
  private readonly localResults = new Map<BuiltinCapabilityId, { key: string; result: TestBuiltinCapabilityResultDto }>();
  private readonly checkRevisions = new Map<BuiltinCapabilityId, number>();

  constructor(options: {
    store?: Pick<BuiltinCapabilityStore, "read" | "write">;
    credentials?: Pick<BuiltinCredentialStore, "has" | "get" | "set" | "clear">;
  } = {}) {
    this.store = options.store ?? new BuiltinCapabilityStore();
    this.credentials = options.credentials ?? new BuiltinCredentialStore();
  }

  registerProvider(kind: ProviderKind, provider: AnyProvider): () => void {
    const key = `${kind}:${provider.id}`;
    this.providers.set(key, provider);
    return () => this.providers.delete(key);
  }

  setBrowserAvailable(available: boolean): void {
    if (available !== this.browserAvailable) this.localResults.delete("browser");
    this.browserAvailable = available;
  }

  setSubagentAvailable(available: boolean): void {
    if (available !== this.subagentAvailable) this.localResults.delete("subagent");
    this.subagentAvailable = available;
  }

  registerLocalCheck(id: LocalCapabilityId, run: () => Promise<LocalCapabilityCheckResult>, availability?: () => LocalCapabilityAvailability): void {
    this.localChecks.set(id, { run, availability });
    this.localResults.delete(id);
  }

  private checkKey(id: BuiltinCapabilityId): string {
    return JSON.stringify([this.config(), this.localChecks.get(id as LocalCapabilityId)?.availability?.()]);
  }

  config(): BuiltinCapabilitiesConfigDto {
    return this.store.read();
  }

  saveConfig(config: BuiltinCapabilitiesConfigDto): BuiltinCapabilitiesSnapshotDto {
    this.store.write(config);
    this.localResults.clear();
    return this.snapshot();
  }

  saveCredential(id: BuiltinCredentialId, secret?: string, clear = false): BuiltinCapabilitiesSnapshotDto {
    if (clear) this.credentials.clear(id);
    else if (secret?.trim()) this.credentials.set(id, secret);
    return this.snapshot();
  }

  visionProvider(): VisionCapabilityProvider | null {
    const id = this.config().vision.enabled ? "default" : undefined;
    return id ? (this.providers.get(`vision:${id}`) as VisionCapabilityProvider | undefined) ?? null : null;
  }

  imageProvider(): MediaCapabilityProvider | null {
    const id = this.config().imageGeneration.provider;
    const provider = id ? (this.providers.get(`media:${id}`) as MediaCapabilityProvider | undefined) : undefined;
    return provider?.generateImage ? provider : null;
  }

  videoProvider(): MediaCapabilityProvider | null {
    const id = this.config().videoGeneration.provider;
    const provider = id ? (this.providers.get(`media:${id}`) as MediaCapabilityProvider | undefined) : undefined;
    return provider?.generateVideo ? provider : null;
  }

  speechToTextProvider(): SpeechCapabilityProvider | null {
    const id = this.config().speechToText.provider;
    const provider = id ? (this.providers.get(`speech:${id}`) as SpeechCapabilityProvider | undefined) : undefined;
    return provider?.speechToText ? provider : null;
  }

  textToSpeechProvider(): SpeechCapabilityProvider | null {
    const id = this.config().textToSpeech.provider;
    const provider = id ? (this.providers.get(`speech:${id}`) as SpeechCapabilityProvider | undefined) : undefined;
    return provider?.textToSpeech ? provider : null;
  }

  private providerStatus(
    id: BuiltinCapabilityStatusDto["id"],
    enabled: boolean,
    provider: AnyProvider | null,
    configuredProvider?: string,
  ): BuiltinCapabilityStatusDto {
    const meta = LABELS[id];
    const credentialConfigured = provider?.credentialId ? this.credentials.has(provider.credentialId) : undefined;
    const missingCredential = provider?.credentialId && !credentialConfigured;
    const availabilityAware = provider as (AnyProvider & {
      isAvailable?: () => boolean;
      availabilityDetail?: () => string | undefined;
    }) | null;
    const providerAvailable = provider ? (availabilityAware?.isAvailable?.() ?? true) : false;
    return {
      id,
      ...meta,
      enabled,
      tools: BUILTIN_CAPABILITY_TOOLS[id],
      provider: provider?.label ?? configuredProvider,
      credentialConfigured,
      state: !enabled
        ? "disabled"
        : !configuredProvider || !provider || missingCredential || !providerAvailable
          ? "needs-configuration"
          : "ready",
      detail: !enabled
        ? "已关闭；新会话不会注册对应工具。"
        : !configuredProvider
          ? "工具契约已内建，尚未选择 Provider adapter。"
          : !provider
            ? `Provider adapter 未安装到 MyBuddy 内建注册表：${configuredProvider}`
            : missingCredential
              ? "Provider credential 尚未配置。"
              : !providerAvailable
                ? (availabilityAware?.availabilityDetail?.() ?? "Provider runtime 尚未就绪。")
                : undefined,
    };
  }

  snapshot(): BuiltinCapabilitiesSnapshotDto {
    const config = this.config();
    const simple = (
      id: BuiltinCapabilityStatusDto["id"],
      enabled: boolean,
      ready: boolean,
    ): BuiltinCapabilityStatusDto => {
      const local = this.localChecks.get(id as LocalCapabilityId);
      const availability = local?.availability?.();
      const available = availability?.available ?? ready;
      const cached = this.localResults.get(id);
      const result = cached && cached.key === this.checkKey(id) && Date.now() - cached.result.checkedAt < 60_000 ? cached.result : undefined;
      const isLocal = id !== "web";
      return {
        id, ...LABELS[id], enabled,
        tools: availability?.tools ?? BUILTIN_CAPABILITY_TOOLS[id],
        state: !enabled ? "disabled" : !available ? "missing-dependency" : result?.state ?? (isLocal ? "unchecked" : "ready"),
        detail: !enabled ? "已关闭；新会话不会注册对应工具。"
          : !available ? availability?.detail ?? "内建 Runtime 尚未装配。"
            : result ? `最近检查：${result.detail}`
              : isLocal ? availability?.detail ?? "已接入；点击检查验证实际运行，当前尚未实测。" : undefined,
      };
    };
    return {
      config,
      capabilities: [
        simple("web", config.web.enabled, true),
        !config.vision.enabled
          ? { id: "vision", ...LABELS.vision, enabled: false, tools: BUILTIN_CAPABILITY_TOOLS.vision, state: "disabled", detail: "已关闭；新会话不会注册对应工具。" }
          : !this.visionProvider()
            ? { id: "vision", ...LABELS.vision, enabled: true, tools: BUILTIN_CAPABILITY_TOOLS.vision, state: "missing-dependency", detail: "内建 Vision Runtime 尚未装配。" }
            : config.vision.model
              ? this.providerStatus("vision", true, this.visionProvider(), "default")
              : {
                  id: "vision", ...LABELS.vision, enabled: true, tools: BUILTIN_CAPABILITY_TOOLS.vision,
                  provider: this.visionProvider()?.label, state: "degraded",
                  detail: "主模型支持图片时可原生多模态直读；尚未选择委托 Vision 模型，因此纯文本主模型没有视觉 fallback。",
                },
        this.providerStatus("image-generation", config.imageGeneration.enabled, this.imageProvider(), config.imageGeneration.provider),
        this.providerStatus("video-generation", config.videoGeneration.enabled, this.videoProvider(), config.videoGeneration.provider),
        this.providerStatus("speech-to-text", config.speechToText.enabled, this.speechToTextProvider(), config.speechToText.provider),
        this.providerStatus("text-to-speech", config.textToSpeech.enabled, this.textToSpeechProvider(), config.textToSpeech.provider),
        simple("browser", config.browser.enabled, this.browserAvailable),
        simple("runtime-diagnostics", config.diagnostics?.enabled ?? config.browser.enabled, this.localChecks.has("runtime-diagnostics")),
        simple("terminal", config.execution.terminalEnabled, true),
        simple("code-execution", config.execution.codeExecutionEnabled, true),
        simple("subagent", config.subagent.enabled, this.subagentAvailable),
        {
          id: "multi-model-consult", label: "多模型会诊", category: "agent",
          description: "多个参与者独立分析同一个任务，再由当前主模型综合；同一模型可用不同思考等级多次参与。",
          enabled: config.multiModelConsult.enabled, tools: ["multi_model_consult"],
          state: !config.multiModelConsult.enabled ? "disabled" : config.multiModelConsult.participants.length < 2 ? "needs-configuration" : "ready",
          detail: !config.multiModelConsult.enabled ? "未启用。"
            : config.multiModelConsult.participants.length < 2 ? "至少选择两个参与者。"
            : `${config.multiModelConsult.participants.length} 个参与者 · ${consultDistinctModelCount(config.multiModelConsult.participants)} 个模型。`,
        },
      ],
      checkedAt: Date.now(),
    };
  }

  async test(id: BuiltinCapabilityStatusDto["id"]): Promise<TestBuiltinCapabilityResultDto> {
    const status = this.snapshot().capabilities.find((item) => item.id === id);
    if (!status) return { ok: false, state: "missing-dependency", detail: "未知能力", checkedAt: Date.now() };
    const local = this.localChecks.get(id as LocalCapabilityId);
    if (local && status.enabled && status.state !== "missing-dependency") {
      const key = this.checkKey(id);
      const revision = (this.checkRevisions.get(id) ?? 0) + 1;
      this.checkRevisions.set(id, revision);
      let result: TestBuiltinCapabilityResultDto;
      try {
        const checked = await local.run();
        result = { ok: true, ...checked, checkedAt: Date.now() };
      } catch (error) {
        result = { ok: false, state: "offline", detail: error instanceof Error ? error.message : String(error), checkedAt: Date.now() };
      }
      if (key !== this.checkKey(id)) return { ok: false, state: "unchecked", detail: "检查期间配置或运行组件发生变化，请重新检查。", checkedAt: Date.now() };
      if (revision === this.checkRevisions.get(id)) this.localResults.set(id, { key, result });
      return result;
    }
    if (id === "vision" && status.state === "degraded") {
      return { ok: true, state: "degraded", detail: status.detail ?? "原生多模态路径可用，但未配置纯文本模型的 Vision fallback。", checkedAt: Date.now() };
    }
    if (status.state !== "ready") return { ok: false, state: status.state, detail: status.detail ?? "能力未就绪", checkedAt: Date.now() };
    if (id === "multi-model-consult") {
      return { ok: true, state: "ready", detail: "配置检查通过；未调用模型。", checkedAt: Date.now() };
    }
    const provider = id === "vision" ? this.visionProvider()
        : id === "image-generation" ? this.imageProvider()
          : id === "video-generation" ? this.videoProvider()
            : id === "speech-to-text" ? this.speechToTextProvider()
              : id === "text-to-speech" ? this.textToSpeechProvider()
                : null;
    try {
      const detail = provider?.test ? await provider.test() : "内建 Runtime 已就绪";
      return { ok: true, state: "ready", detail, checkedAt: Date.now() };
    } catch (error) {
      return {
        ok: false,
        state: "offline",
        detail: error instanceof Error ? error.message : String(error),
        checkedAt: Date.now(),
      };
    }
  }
}
