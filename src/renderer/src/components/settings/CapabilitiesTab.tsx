import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { RecognitionServiceEditor } from "./RecognitionServiceEditor";
import { SettingsInput, SettingsSecretField, SettingsSection, SettingsSelect, SettingsToggle } from "./SettingsPrimitives";
import SearchSettings, { searchProviderLabel } from "./SearchSettings";
import MultiModelConsultSettings from "./MultiModelConsultSettings";
import { searchPolicyFromConfig, normalizeSearchPolicy, DEFAULT_SEARCH_POLICY } from "@shared/web-search";
import type { WebSearchPolicy } from "@shared/web-search";
import { BUILTIN_CODEX_IMAGE_PROVIDER_ID } from "@shared/builtin-capabilities";
import type { BuiltinCapabilitiesConfigDto, BuiltinCapabilitiesSnapshotDto, BuiltinCapabilityId, BuiltinCapabilityStatusDto } from "@shared/builtin-capabilities";
import { API_PROTOCOL_CAPABILITIES, BAIDU_OCR_DEFAULT_MODE, BAIDU_OCR_MODES, CODEX_CONNECTION_ID, LOCAL_WHISPER_CONNECTION_ID, MEDIA_CAPABILITY_IDS, MEDIA_PROVIDER_PRESETS, OPENROUTER_API_ROOT, connectionCapabilities } from "@shared/media-capabilities";
import type { ApiCapabilityConnection, ApiCapabilityProtocol, CapabilityConnectionOption, CapabilityCredentialChange, CapabilityVideoJobDto, MediaCapabilityBinding, MediaCapabilityId } from "@shared/media-capabilities";
import { desktopPlatformLabel, desktopRuntimeSummary } from "@shared/desktop-platform";
import { useAppStore } from "@/store/appStore";
import { WEB_SEARCH_PROVIDER_OPTIONS, type WebSearchConfigDto } from "@shared/agent-ipc";
import "./CapabilitiesTab.css";

const AUTO_SERVICE = "__automatic__";
const ADD_SERVICE = "__add_api__";
const ADD_PRESET_PREFIX = "__preset__:";
const CUSTOM_MODEL = "__custom_model__";
const STATE_LABEL: Record<string, string> = {
  ready: "已就绪", unchecked: "待检查", disabled: "已关闭", "needs-configuration": "需要配置",
  "missing-dependency": "需要准备", offline: "连接异常", degraded: "部分可用",
};
const MEDIA_ROWS: Record<MediaCapabilityId, { title: string; description: string; tool: string }> = {
  "speech-to-text": { title: "语音转文字", description: "将任务内音频转写为文字。", tool: "speech_to_text" },
  ocr: { title: "图片文字识别", description: "提取任务内图片中的文字。", tool: "ocr_file" },
  "text-to-speech": { title: "文字转语音", description: "将文字合成为音频，并保存到当前任务。", tool: "text_to_speech" },
  "image-generation": { title: "图片生成", description: "根据描述生成图片；服务支持时可使用参考图。", tool: "image_generate" },
  "video-generation": { title: "视频生成", description: "根据描述生成视频，并保存到当前任务。", tool: "video_generate" },
};
const PROTOCOL_LABEL: Record<ApiCapabilityProtocol, string> = { "openai-compatible": "OpenAI 兼容 API", openrouter: "OpenRouter 多模态 API", "mistral-ocr": "Mistral OCR API", "baidu-ocr": "百度智能云 OCR API", "black-forest-labs": "Black Forest Labs（FLUX）原生任务 API", dashscope: "阿里云百炼（千问 / 万相）原生任务 API" };
type CredentialDraft = Pick<CapabilityCredentialChange, "secret" | "clear">;
const differs = (left: unknown, right: unknown): boolean => JSON.stringify(left) !== JSON.stringify(right);
const errorText = (reason: unknown): string => reason instanceof Error ? reason.message : String(reason);
const hasCredentialChange = (change?: CredentialDraft): boolean => Boolean(change?.clear || change?.secret?.trim());

/** One live line for the collapsed row header; it never repeats the full form. */
function searchSummary(enabled: boolean, policy: WebSearchPolicy): string {
  if (!enabled) return "已关闭";
  switch (policy.mode) {
    case "parallel": return `多源同时搜索 · ${policy.providers.length} 家供应商`;
    case "single": return policy.providers[0] ? `指定单源 · ${searchProviderLabel(policy.providers[0])}` : "指定单源 · 未选择供应商";
    case "fallback": return `按序回退 · ${policy.providers.length} 家`;
    default: return "自动选择可用源";
  }
}

/** A fresh OpenRouter connection is saved before its model catalogue has been discovered. */
function needsCatalogueRefresh(config: BuiltinCapabilitiesConfigDto, snapshot: BuiltinCapabilitiesSnapshotDto): boolean {
  const connections = Object.entries(config.connections ?? {}).filter(([, connection]) => connection.protocol === "openrouter");
  if (!connections.length) return false;
  const catalogue = snapshot.mediaServices ?? [];
  return connections.some(([id]) => {
    const option = catalogue.find(entry => entry.id === id);
    return !option || Object.values(option.models ?? {}).every(list => !list || list.length === 0);
  });
}

function settingsApi() {
  const api = window.api?.agent;
  if (!api) throw new Error("设置 API 尚未就绪，请重新打开设置。");
  return api;
}

/** Merge status-driven defaults without mixing fields from two different service selections. */
function mergeConfigUpdate(base: unknown, edited: unknown, incoming: unknown, path: string[] = []): { value: unknown; conflict: boolean } {
  if (!differs(base, edited)) return { value: incoming, conflict: false };
  if (!differs(base, incoming) || !differs(edited, incoming)) return { value: edited, conflict: false };
  const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  // A user's deliberate choice has priority over the server's first automatic suggestion.
  if (path.join(".") === "mediaBindings.image-generation" && object(base) && object(incoming)
    && base.selection === "auto" && !base.connectionId && incoming.selection === "auto" && incoming.connectionId) {
    return { value: edited, conflict: false };
  }
  if (path.length === 2 && ["mediaBindings", "connections", "services"].includes(path[0])) return { value: edited, conflict: true };
  if (object(base) && object(edited) && object(incoming)) {
    const value: Record<string, unknown> = {};
    let conflict = false;
    for (const key of new Set([...Object.keys(base), ...Object.keys(edited), ...Object.keys(incoming)])) {
      const merged = mergeConfigUpdate(base[key], edited[key], incoming[key], [...path, key]);
      if (merged.value !== undefined) value[key] = merged.value;
      conflict ||= merged.conflict;
    }
    return { value, conflict };
  }
  return { value: edited, conflict: true };
}

/** Project old settings into the selector without rewriting or enabling anything on mount. */
function mediaBinding(config: BuiltinCapabilitiesConfigDto, id: MediaCapabilityId): MediaCapabilityBinding {
  const binding = config.mediaBindings?.[id];
  if (binding) {
    const legacyPolicy = binding.connectionId.startsWith("legacy:") ? config.services?.[binding.connectionId.slice(7)]?.dataPolicy : undefined;
    if (legacyPolicy === "local-only" || (!binding.dataPolicy && legacyPolicy)) return { ...binding, dataPolicy: legacyPolicy };
    return binding;
  }
  if (id === "speech-to-text") {
    if (config.speechToText.provider === "http-asr" && config.speechToText.serviceId) {
      const service = config.services?.[config.speechToText.serviceId];
      return { connectionId: `legacy:${config.speechToText.serviceId}`, model: service?.model, dataPolicy: service?.dataPolicy };
    }
    if (!config.speechToText.provider || config.speechToText.provider === "local-whisper") return { connectionId: LOCAL_WHISPER_CONNECTION_ID };
  }
  if (id === "ocr" && config.ocr?.serviceId) {
    const service = config.services?.[config.ocr.serviceId];
    return { connectionId: `legacy:${config.ocr.serviceId}`, model: service?.model, dataPolicy: service?.dataPolicy };
  }
  if (id === "image-generation" && config.imageGeneration.provider === BUILTIN_CODEX_IMAGE_PROVIDER_ID) {
    return { connectionId: CODEX_CONNECTION_ID, model: config.imageGeneration.model, selection: "manual" };
  }
  const configured = id === "speech-to-text" ? config.speechToText : id === "text-to-speech" ? config.textToSpeech : id === "image-generation" ? config.imageGeneration : id === "video-generation" ? config.videoGeneration : undefined;
  if (configured?.provider) return { connectionId: `registered:${configured.provider}`, model: "model" in configured ? configured.model : undefined, selection: "manual" };
  return { connectionId: "", selection: "manual" };
}

function credentialReference(config: BuiltinCapabilitiesConfigDto, connectionId: string): string | undefined {
  return connectionId.startsWith("legacy:") ? config.services?.[connectionId.slice(7)]?.credentialRef : config.connections?.[connectionId]?.credentialRef;
}

function mediaEnabled(config: BuiltinCapabilitiesConfigDto, id: MediaCapabilityId): boolean {
  switch (id) {
    case "speech-to-text": return config.speechToText.enabled;
    case "ocr": return config.ocr?.enabled ?? false;
    case "text-to-speech": return config.textToSpeech.enabled;
    case "image-generation": return config.imageGeneration.enabled;
    case "video-generation": return config.videoGeneration.enabled;
  }
}

function setMediaEnabled(config: BuiltinCapabilitiesConfigDto, id: MediaCapabilityId, enabled: boolean): BuiltinCapabilitiesConfigDto {
  switch (id) {
    case "speech-to-text": return { ...config, speechToText: { ...config.speechToText, enabled } };
    case "ocr": return { ...config, ocr: { ...config.ocr, enabled } };
    case "text-to-speech": return { ...config, textToSpeech: { ...config.textToSpeech, enabled } };
    case "image-generation": return { ...config, imageGeneration: { ...config.imageGeneration, enabled } };
    case "video-generation": return { ...config, videoGeneration: { ...config.videoGeneration, enabled } };
  }
}

function mediaConfiguration(config: BuiltinCapabilitiesConfigDto, id: MediaCapabilityId): unknown {
  const binding = mediaBinding(config, id);
  return {
    enabled: mediaEnabled(config, id), binding,
    connection: config.connections?.[binding.connectionId],
    legacy: binding.connectionId.startsWith("legacy:") ? config.services?.[binding.connectionId.slice(7)] : undefined,
    speech: id === "text-to-speech" ? config.textToSpeech : undefined,
  };
}

function connectionLocation(url: string): "loopback" | "remote" | undefined {
  try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname) ? "loopback" : "remote"; } catch { return undefined; }
}

function StatusBadge({ status, pending }: { status?: BuiltinCapabilityStatusDto; pending?: boolean }): React.JSX.Element {
  const state = pending ? "pending" : status?.state ?? "needs-configuration";
  const uncheckedMedia = state === "unchecked" && status && MEDIA_CAPABILITY_IDS.includes(status.id as MediaCapabilityId);
  return <span className={`capability-state capability-state--${state}`}>{pending ? "待保存" : uncheckedMedia ? "已配置，未试用" : STATE_LABEL[state] ?? state}</span>;
}

function CapabilityRow({ id, title, description, tools, enabled, savedEnabled, disabled, testing, status, configurationPending = false, preventEnable = false, collapsible = false, defaultCollapsed = false, summary, checkResult, onToggle, onTest, children, detailsContent }: {
  id: BuiltinCapabilityId;
  title: string;
  description?: string;
  tools: string[];
  enabled: boolean;
  savedEnabled?: boolean;
  disabled: boolean;
  testing: boolean;
  status?: BuiltinCapabilityStatusDto;
  configurationPending?: boolean;
  preventEnable?: boolean;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  summary?: ReactNode;
  checkResult?: { ok: boolean; detail: string } | null;
  onToggle: (enabled: boolean) => void;
  onTest: (id: BuiltinCapabilityId) => void;
  children: ReactNode;
  detailsContent?: ReactNode;
}): React.JSX.Element {
  const pending = configurationPending || (savedEnabled !== undefined && savedEnabled !== enabled);
  // Collapsing keeps the form mounted, so an unsaved draft is never discarded.
  const [expanded, setExpanded] = useState(() => !collapsible || !defaultCollapsed);
  const config = <fieldset className="capability-config-control" disabled={disabled}>{children}</fieldset>;
  return <div data-capability-id={id} className={`settings-row capability-config-row${enabled ? "" : " is-disabled"}`}>
    <div className="capability-config-header">
      <div className="capability-config-copy"><div className="settings-row-label">{title}</div>{description && <div className="settings-row-desc">{description}</div>}</div>
      <StatusBadge status={status} pending={pending} />
      <SettingsToggle on={enabled} label={`${title}开关`} disabled={disabled || (preventEnable && !enabled)} onChange={onToggle} />
    </div>
    {checkResult && <p className={`capability-check-result ${checkResult.ok ? "is-ok" : "is-error"}`} role={checkResult.ok ? "status" : "alert"}>{checkResult.ok ? "检查通过" : "检查失败"}：{checkResult.detail}</p>}
    {collapsible
      ? <details className="capability-config-disclosure" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
        <summary className="capability-config-summary"><span className="capability-config-summary-text">{summary}</span><span className="settings-disclosure-chevron" aria-hidden="true">⌄</span></summary>
        {config}
      </details>
      : config}
    <details className="capability-status-details">
      <summary>状态与详情</summary>
      <div className="capability-status-body">
        <div className="settings-row-desc">{pending ? "有未保存的更改；保存后再检查。" : status?.detail ?? "可在需要时检查当前配置。"}</div>
        <div className="capability-config-tools">可调用工具：{tools.join(" · ")}</div>
        <button type="button" className="btn capability-check-btn" disabled={disabled || testing || !enabled || pending} onClick={() => onTest(id)}>{testing ? "检查中…" : "检查"}</button>
        {detailsContent}
      </div>
    </details>
  </div>;
}

function VideoJobs({ disabled }: { disabled: boolean }): React.JSX.Element {
  const [jobs, setJobs] = useState<CapabilityVideoJobDto[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadJobs = async (): Promise<void> => {
    setLoading(true); setError(null);
    try { setJobs((await settingsApi().listBuiltinVideoJobs()).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5)); }
    catch (reason) { setError(`视频任务读取失败：${errorText(reason)}`); }
    finally { setLoading(false); }
  };
  const status: Record<string, string> = { submitting: "正在提交", "submission-unknown": "提交状态待确认", queued: "等待生成", in_progress: "正在生成", completed: "远端生成完成", failed: "生成失败" };
  return <div className="capability-video-jobs">
    <button type="button" className="btn" disabled={disabled || loading} onClick={() => void loadJobs()}>{loading ? "读取中…" : jobs ? "刷新最近任务" : "查看最近的视频任务"}</button>
    {error && <p className="settings-inline-error" role="alert">{error}</p>}
    {jobs && <>
      {jobs.length ? <ul>{jobs.map(job => <li key={job.id}><strong>{status[job.status] ?? "等待确认"}</strong><span>任务：{job.taskId}</span><code>{job.id}</code>{job.status === "submission-unknown" && <span>请求可能已被接收，请先到服务端确认，避免重复生成。</span>}</li>)}</ul> : <p className="settings-row-desc">暂无视频任务记录。</p>}
      {jobs.length > 0 && <p className="settings-row-desc">回到对应任务，提供以上编号以继续查询或取回结果。停止等待不会取消远端生成。</p>}
    </>}
  </div>;
}

function MediaModelField({ id, binding, service, disabled, onChange }: {
  id: MediaCapabilityId;
  binding: MediaCapabilityBinding;
  service?: CapabilityConnectionOption;
  disabled?: boolean;
  onChange: (model: string) => void;
}): React.JSX.Element {
  const choices = service?.models[id] ?? [];
  const hasCatalogue = choices.length > 0;
  const [custom, setCustom] = useState(false);
  // The parent keys this field by service/catalogue so resets happen during
  // reconciliation, never in a delayed effect that can overwrite a user edit.
  const label = service?.id && id === "ocr" && service.models.ocr?.some(row => row.id === BAIDU_OCR_DEFAULT_MODE)
    ? "OCR 识别模式" : `${MEDIA_ROWS[id].title}模型`;
  const placeholder = id === "ocr" ? "输入支持图片的模型名称" : "输入服务支持的模型名称";
  if (!hasCatalogue) {
    // Without a discovered catalogue there is nothing to select; only a free-form protocol stays editable.
    if (!service?.allowCustomModel) return <SettingsSelect label={label === "OCR 识别模式" ? "识别模式" : "模型"} aria-label={label} value={binding.model ?? ""} disabled={disabled || !hasCatalogue} onChange={event => onChange(event.target.value)}>
      <option value="">{service?.source === "local" ? "使用本机已安装模型" : "服务可用后显示模型"}</option>
      {binding.model && <option value={binding.model}>{binding.model}（暂不可用）</option>}
    </SettingsSelect>;
    return <div>
      <SettingsInput label="模型" aria-label={label} value={binding.model ?? ""} spellCheck={false} disabled={disabled} placeholder={placeholder} hint="尚未加载模型目录；刷新状态以加载模型目录，或直接输入模型名称。" onChange={event => onChange(event.target.value)} />
    </div>;
  }
  return <div>
    <SettingsSelect label={label === "OCR 识别模式" ? "识别模式" : "模型"} aria-label={label} value={custom ? CUSTOM_MODEL : binding.model ?? ""} disabled={disabled} onChange={event => {
      const next = event.target.value;
      if (next === CUSTOM_MODEL) { setCustom(true); return; }
      setCustom(false);
      onChange(next);
    }}>
      <option value="">{service?.source === "local" ? "使用本机已安装模型" : "请选择模型"}</option>
      {!custom && binding.model && !choices.some(choice => choice.id === binding.model) && <option value={binding.model}>{binding.model}（暂不可用）</option>}
      {choices.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
      {service?.allowCustomModel && <option value={CUSTOM_MODEL}>自定义模型…</option>}
    </SettingsSelect>
    {custom && service?.allowCustomModel && <SettingsInput label="自定义模型" aria-label={`${label}（自定义）`} value={binding.model ?? ""} spellCheck={false} disabled={disabled} placeholder={placeholder} hint="目录里没有需要的模型时，可手动填写模型 ID。" onChange={event => onChange(event.target.value)} />}
  </div>;
}

function ApiConnectionEditor({ id, value, option, credentials, secretKeyCredentials, usedBy, disabled, onChange, onCredentialChange, onSecretKeyCredentialChange, onRemove }: {
  id: string;
  value: ApiCapabilityConnection;
  option?: CapabilityConnectionOption;
  credentials?: CredentialDraft;
  secretKeyCredentials?: CredentialDraft;
  usedBy: MediaCapabilityId[];
  disabled: boolean;
  onChange: (value: ApiCapabilityConnection) => void;
  onCredentialChange: (value: CredentialDraft) => void;
  onSecretKeyCredentialChange: (value: CredentialDraft) => void;
  onRemove: () => void;
}): React.JSX.Element {
  return <fieldset className="capability-connection-fields" disabled={disabled} data-connection-id={id}>
    <div className="capability-form-grid">
      <SettingsInput label="服务名称" value={value.name} onChange={event => onChange({ ...value, name: event.target.value })} />
      <SettingsSelect label="接口类型" value={value.protocol} disabled={Boolean(value.presetId)} onChange={event => {
        const protocol = event.target.value as ApiCapabilityProtocol;
        onChange({ ...value, protocol, ...(protocol === "openrouter" ? { baseUrl: OPENROUTER_API_ROOT, auth: "api-key" as const } : {}) });
      }}>
        {(Object.keys(PROTOCOL_LABEL) as ApiCapabilityProtocol[]).filter(protocol => {
          // Native task APIs only exist behind their official preset (fixed endpoint + model family).
          const presetOnly = protocol === "baidu-ocr" || protocol === "black-forest-labs" || protocol === "dashscope";
          return presetOnly ? value.presetId === protocol : true;
        }).map(protocol => <option key={protocol} value={protocol} disabled={usedBy.some(capability => !API_PROTOCOL_CAPABILITIES[protocol].includes(capability))}>{PROTOCOL_LABEL[protocol]}</option>)}
      </SettingsSelect>
    </div>
    <SettingsInput label="API 地址" type="url" disabled={Boolean(value.presetId)} value={value.baseUrl} spellCheck={false} autoComplete="off" placeholder="https://api.example.com/v1" hint="填写服务的 API 根地址，通常以 /v1 结尾。" onChange={event => onChange({ ...value, baseUrl: event.target.value })} />
    <SettingsSelect label="认证方式" disabled={Boolean(value.presetId)} value={value.auth} onChange={event => onChange({ ...value, auth: event.target.value as ApiCapabilityConnection["auth"] })}>
      <option value="api-key">API Key</option><option value="none">无需认证</option>
      {value.protocol === "baidu-ocr" && <option value="baidu-ak-sk">API Key + Secret Key</option>}
    </SettingsSelect>
    {value.auth === "api-key" && <SettingsSecretField value={credentials?.secret ?? ""} clear={credentials?.clear} configured={option?.authState === "configured"} disabled={disabled} onChange={secret => onCredentialChange({ secret, clear: false })} onClearChange={clear => onCredentialChange({ secret: "", clear })} />}
    {value.auth === "baidu-ak-sk" && <div className="capability-form-grid">
      <SettingsSecretField label="API Key" value={credentials?.secret ?? ""} clear={credentials?.clear}
        configured={option?.credentialSlotsConfigured?.apiKey === true} disabled={disabled}
        onChange={secret => onCredentialChange({ secret, clear: false })}
        onClearChange={clear => onCredentialChange({ secret: "", clear })} />
      <SettingsSecretField label="Secret Key" value={secretKeyCredentials?.secret ?? ""} clear={secretKeyCredentials?.clear}
        configured={option?.credentialSlotsConfigured?.secretKey === true} disabled={disabled}
        onChange={secret => onSecretKeyCredentialChange({ secret, clear: false })}
        onClearChange={clear => onSecretKeyCredentialChange({ secret: "", clear })} />
    </div>}
    <p className="settings-row-desc">{MEDIA_PROVIDER_PRESETS.find(preset => preset.id === value.presetId)?.hint ?? (value.protocol === "mistral-ocr" ? "用于 Mistral OCR 接口。" : value.protocol === "openrouter" ? "使用 OpenRouter 专用多模态接口及实时目录。" : "使用对应的 OpenAI 兼容接口；服务端需实际支持所选能力。")}{usedBy.length > 0 ? ` 当前用于：${usedBy.map(capability => MEDIA_ROWS[capability].title).join("、")}。修改此服务会应用到这些能力。` : "保存后可供上方的能力选择。"}</p>
    <details className="capability-options"><summary>连接选项</summary><SettingsInput label="等待上限（秒）" type="number" min={1} value={value.timeoutMs / 1000 || ""} onChange={event => onChange({ ...value, timeoutMs: Number(event.target.value) * 1000 })} /></details>
    <div className="capability-connection-actions"><button type="button" className="btn" disabled={disabled || usedBy.length > 0} title={usedBy.length ? "先为使用此服务的能力选择其他服务" : undefined} onClick={onRemove}>移除此服务</button></div>
  </fieldset>;
}

export default function CapabilitiesTab(): React.JSX.Element {
  const models = useAppStore(state => state.models);
  const [snapshot, setSnapshot] = useState<BuiltinCapabilitiesSnapshotDto | null>(null);
  const [savedConfig, setSavedConfig] = useState<BuiltinCapabilitiesConfigDto | null>(null);
  const [draft, setDraft] = useState<BuiltinCapabilitiesConfigDto | null>(null);
  const [draftRevision, setDraftRevision] = useState<string | undefined>();
  const [savedWebSearch, setSavedWebSearch] = useState<WebSearchConfigDto | null>(null);
  const [webSearchDraft, setWebSearchDraft] = useState<WebSearchConfigDto | null>(null);
  const [searchPolicy, setSearchPolicy] = useState(DEFAULT_SEARCH_POLICY);
  const [credentialDrafts, setCredentialDrafts] = useState<Record<string, CredentialDraft>>({});
  const [openConnections, setOpenConnections] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<BuiltinCapabilityId | null>(null);
  const [checkResult, setCheckResult] = useState<{ id: BuiltinCapabilityId; ok: boolean; detail: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchLoadError, setSearchLoadError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);

  const acceptConfig = useCallback((next: BuiltinCapabilitiesSnapshotDto) => {
    setSnapshot(next);
    setSavedConfig(structuredClone(next.config));
    setDraft(structuredClone(next.config));
    setDraftRevision(next.revision);
  }, []);
  const acceptSearch = useCallback((next: WebSearchConfigDto) => {
    setSavedWebSearch(structuredClone(next));
    setWebSearchDraft(structuredClone(next));
    setSearchPolicy(searchPolicyFromConfig(next));
    setSearchLoadError(null);
  }, []);
  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true); setError(null);
    try {
      const api = settingsApi();
      const [capabilities, search] = await Promise.allSettled([api.getBuiltinCapabilities(), api.getWebSearchConfig()]);
      if (!mounted.current) return;
      if (capabilities.status === "fulfilled" && capabilities.value) acceptConfig(capabilities.value);
      else setError(`工具能力读取失败：${capabilities.status === "rejected" ? errorText(capabilities.reason) : "没有返回配置"}`);
      if (search.status === "fulfilled") acceptSearch(search.value ?? {});
      else setSearchLoadError(`搜索设置读取失败：${errorText(search.reason)}`);
    } catch (reason) {
      if (mounted.current) setError(`工具能力读取失败：${errorText(reason)}`);
    } finally {
      inFlight.current = false;
      if (mounted.current) setLoading(false);
    }
  }, [acceptConfig, acceptSearch]);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; }; }, [load]);

  const services = useMemo<CapabilityConnectionOption[]>(() => {
    const catalog = snapshot?.mediaServices ?? [];
    const savedOptions = new Map(catalog.map(option => [option.id, option]));
    return [
      ...catalog.filter(option => option.source !== "api"),
      ...Object.entries(draft?.connections ?? {}).map(([id, connection]): CapabilityConnectionOption => {
        const previous = savedOptions.get(id);
        const presetModels = MEDIA_PROVIDER_PRESETS.find(item => item.id === connection.presetId)?.models;
        return { id, label: connection.name || "未命名 API 服务", source: "api", capabilities: connectionCapabilities(connection),
          // A preset with fixed model families (FLUX / 百炼) shows them before the first save too.
          models: connection.protocol === "baidu-ocr"
            ? { ocr: BAIDU_OCR_MODES.map(({ id, label }) => ({ id, label })) }
            : previous?.models && Object.keys(previous.models).length ? previous.models : presetModels ?? previous?.models ?? {},
          allowCustomModel: connection.protocol !== "baidu-ocr",
          configured: previous?.configured ?? false, credentialSlotsConfigured: previous?.credentialSlotsConfigured,
          authState: connection.auth === "none" ? "none" : previous?.authState === "configured" ? "configured" : "missing-key",
          location: connectionLocation(connection.baseUrl), detail: previous?.detail };
      }),
    ];
  }, [snapshot?.mediaServices, draft?.connections]);
  const statusById = useMemo(() => new Map(snapshot?.capabilities.map(item => [item.id, item]) ?? []), [snapshot]);
  const visionModels = useMemo(() => models.filter(model => model.enabled !== false && model.supportsImages), [models]);
  const searchProviderChoices = useMemo(() => {
    const ready = new Set<string>(webSearchDraft?.configuredProviders ?? []);
    if (models.some(model => model.vendor === "openai-codex" || model.id.startsWith("openai-codex/"))) ready.add("codex");
    const searchKeys = { tavily: webSearchDraft?.tavilyApiKey, serper: webSearchDraft?.serperApiKey, tinyfish: webSearchDraft?.tinyfishApiKey, brave: webSearchDraft?.braveApiKey };
    for (const [id, key] of Object.entries(searchKeys)) if (key?.trim() || webSearchDraft?.apiKeyPools?.[id]?.length) ready.add(id);
    for (const provider of savedWebSearch?.searchRouting?.providers ?? []) ready.add(provider);
    return WEB_SEARCH_PROVIDER_OPTIONS.filter(provider => ready.has(provider.id)).map(provider => provider.id);
  }, [models, savedWebSearch, webSearchDraft]);
  const credentialChanges = Object.entries(credentialDrafts).filter(([, change]) => hasCredentialChange(change)).map(([key, change]) =>
    key.endsWith("::secretKey")
      ? { connectionId: key.slice(0, -"::secretKey".length), slot: "secretKey" as const, ...change }
      : { connectionId: key, ...change });
  const mainPending = Boolean(draft && savedConfig && differs(draft, savedConfig)) || credentialChanges.length > 0;
  const searchPending = webSearchDraft !== null && (differs(webSearchDraft, savedWebSearch) || differs(searchPolicy, searchPolicyFromConfig(savedWebSearch ?? {})));
  const busy = saving || testing !== null || refreshing;

  const acceptStatus = (next: BuiltinCapabilitiesSnapshotDto): void => {
    setSnapshot(next);
    if (!draft || !savedConfig) { acceptConfig(next); return; }
    const merged = mergeConfigUpdate(savedConfig, draft, next.config);
    if (!merged.conflict) {
      setDraft(structuredClone(merged.value as BuiltinCapabilitiesConfigDto));
      setSavedConfig(structuredClone(next.config));
      setDraftRevision(next.revision);
    }
  };

  const changeConfig = (update: (current: BuiltinCapabilitiesConfigDto) => BuiltinCapabilitiesConfigDto): void => {
    if (saving) return;
    // A result belongs to the configuration that was checked; editing it makes the result stale.
    setCheckResult(null);
    setDraft(current => current ? update(current) : current);
  };
  const changeCredential = (connectionId: string, change: CredentialDraft): void => {
    setCredentialDrafts(current => ({ ...current, [connectionId]: change }));
  };
  const editConnection = (id: string): void => {
    setOpenConnections(current => new Set(current).add(id));
    requestAnimationFrame(() => document.getElementById(`capability-connection-${id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  };
  const addConnection = (capability?: MediaCapabilityId, presetId?: string): void => {
    const preset = MEDIA_PROVIDER_PRESETS.find(entry => entry.id === presetId);
    if (preset && capability && !preset.capabilities.includes(capability)) return;
    const id = `api-${crypto.randomUUID()}`;
    changeConfig(current => {
      const protocol = preset?.protocol ?? (capability === "ocr" ? "mistral-ocr" : "openai-compatible");
      const previous = capability ? mediaBinding(current, capability) : undefined;
      return {
        ...current,
        connections: { ...current.connections, [id]: {
          name: preset?.label ?? `API 服务 ${Object.keys(current.connections ?? {}).length + 1}`,
          protocol, ...(preset ? { presetId: preset.id } : {}),
          baseUrl: preset?.baseUrl ?? "", auth: preset?.protocol === "baidu-ocr" ? "baidu-ak-sk" as const : "api-key" as const, timeoutMs: 60000,
        } },
        ...(capability ? { mediaBindings: { ...current.mediaBindings, [capability]: { connectionId: id, selection: "manual" as const, ...(capability === "ocr" || capability === "speech-to-text" ? { dataPolicy: previous?.dataPolicy ?? "allow-cloud" } : {}),
          ...(capability === "ocr" && preset?.protocol === "baidu-ocr" ? { model: BAIDU_OCR_DEFAULT_MODE } : {}) } } } : {}),
        ...(capability === "text-to-speech" ? { textToSpeech: { ...current.textToSpeech, voice: undefined, rate: undefined } } : {}),
      };
    });
    editConnection(id);
  };
  const selectService = (id: MediaCapabilityId, selected: string): void => {
    if (selected === ADD_SERVICE) { addConnection(id); return; }
    if (selected.startsWith(ADD_PRESET_PREFIX)) {
      const preset = MEDIA_PROVIDER_PRESETS.find(item => item.id === selected.slice(ADD_PRESET_PREFIX.length));
      if (!preset || !preset.capabilities.includes(id)) return;
      const existing = Object.entries(draft?.connections ?? {}).find(([, service]) => service.presetId === preset.id);
      if (existing) { selectService(id, existing[0]); return; }
      addConnection(id, preset.id);
      return;
    }
    changeConfig(current => {
      const previous = mediaBinding(current, id);
      const service = services.find(option => option.id === selected);
      const modelsForCapability = service?.models[id] ?? [];
      const binding: MediaCapabilityBinding = selected === AUTO_SERVICE
        ? { connectionId: "", selection: "auto" }
        : { connectionId: selected, selection: "manual", model: service?.models.ocr?.some(item => item.id === BAIDU_OCR_DEFAULT_MODE) && id === "ocr"
          ? BAIDU_OCR_DEFAULT_MODE : modelsForCapability.length === 1 ? modelsForCapability[0].id : undefined };
      if (id === "ocr" || id === "speech-to-text") {
        const targetPolicy = selected.startsWith("legacy:") ? current.services?.[selected.slice(7)]?.dataPolicy : undefined;
        binding.dataPolicy = previous.dataPolicy === "local-only" || targetPolicy === "local-only" ? "local-only" : previous.dataPolicy ?? targetPolicy ?? "allow-cloud";
      }
      const next = { ...current, mediaBindings: { ...current.mediaBindings, [id]: binding }, ...(id === "text-to-speech" && previous.connectionId !== selected ? { textToSpeech: { ...current.textToSpeech, voice: undefined, rate: undefined } } : {}) };
      return selected ? next : setMediaEnabled(next, id, false);
    });
  };

  const save = async (): Promise<void> => {
    if (!draft || inFlight.current || (!mainPending && !searchPending)) return;
    let searchToSave: WebSearchConfigDto | undefined;
    try {
      if (searchPending && webSearchDraft) {
        const changedPolicy = differs(searchPolicyFromConfig(savedWebSearch ?? {}), searchPolicy);
        searchToSave = { ...webSearchDraft, ...(changedPolicy || savedWebSearch?.searchPolicy ? { searchPolicy: normalizeSearchPolicy(searchPolicy) } : {}) };
      }
    } catch (reason) { setError(`搜索设置未保存：${errorText(reason)}`); return; }
    inFlight.current = true; setSaving(true); setMessage(null); setError(null);
    const submittedConfig = structuredClone(draft);
    const submittedCredentials = structuredClone(credentialChanges);
    try {
      const [capabilities, search] = await Promise.allSettled([
        mainPending ? settingsApi().saveBuiltinCapabilitySettings({ config: submittedConfig, credentials: submittedCredentials, expectedRevision: draftRevision }) : Promise.resolve(null),
        searchToSave ? settingsApi().saveWebSearchConfig(searchToSave) : Promise.resolve(null),
      ]);
      if (!mounted.current) return;
      const successes: string[] = [];
      const failures: string[] = [];
      let catalogueNotice = "";
      if (mainPending) {
        if (capabilities.status === "fulfilled" && capabilities.value) {
          acceptConfig(capabilities.value);
          setCredentialDrafts({});
          successes.push("工具能力已保存");
          // A newly added OpenRouter connection has no catalogue until it is discovered after saving.
          if (needsCatalogueRefresh(submittedConfig, capabilities.value)) {
            try {
              const refreshed = await settingsApi().refreshBuiltinMediaServices();
              if (refreshed && mounted.current) acceptStatus(refreshed);
            } catch (reason) { catalogueNotice = `模型目录暂时未能加载：${errorText(reason)}。可稍后点「刷新状态」重试。`; }
          }
        } else failures.push(`工具能力保存失败：${capabilities.status === "rejected" ? errorText(capabilities.reason) : "没有返回配置"}`);
      }
      if (searchToSave) {
        if (search.status === "fulfilled" && search.value) { acceptSearch(search.value); successes.push("搜索设置已保存"); }
        else failures.push(`搜索设置保存失败：${search.status === "rejected" ? errorText(search.reason) : "没有返回配置"}`);
      }
      if (successes.length) setMessage(`${successes.join("；")}。${failures.length ? "未成功的更改仍在表单中，重试只提交这些更改。" : "工具开关从新会话生效。"}${catalogueNotice}`);
      else if (catalogueNotice) setMessage(catalogueNotice);
      if (failures.length) setError(`${failures.join("；")}。未保存的草稿已保留。`);
    } catch (reason) { if (mounted.current) setError(`保存失败：${errorText(reason)}。草稿已保留。`); }
    finally { inFlight.current = false; if (mounted.current) setSaving(false); }
  };
  const refresh = async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true; setRefreshing(true); setError(null);
    try {
      const next = await settingsApi().refreshBuiltinMediaServices();
      if (!next) throw new Error("没有返回服务状态");
      if (mounted.current) { acceptStatus(next); setMessage("服务状态已刷新；未保存的更改保持不变。"); }
    } catch (reason) { if (mounted.current) setError(`刷新失败：${errorText(reason)}。未保存的更改保持不变。`); }
    finally { inFlight.current = false; if (mounted.current) setRefreshing(false); }
  };
  const test = async (id: BuiltinCapabilityId): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true; setTesting(id); setMessage(null); setError(null); setCheckResult(null);
    try {
      const result = await settingsApi().testBuiltinCapability(id);
      if (!result) throw new Error("检查没有返回结果");
      if (!mounted.current) return;
      setCheckResult({ id, ok: Boolean(result.ok), detail: result.detail });
      (result.ok ? setMessage : setError)(result.detail);
      try {
        const next = await settingsApi().getBuiltinCapabilities();
        if (next && mounted.current) acceptStatus(next);
      } catch { /* The check result stays valid even when the status read fails. */ }
    } catch (reason) {
      if (mounted.current) { setCheckResult({ id, ok: false, detail: errorText(reason) }); setError(errorText(reason)); }
    }
    finally { inFlight.current = false; if (mounted.current) setTesting(null); }
  };
  const retrySearch = async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true; setRefreshing(true);
    try { const next = await settingsApi().getWebSearchConfig(); if (mounted.current) acceptSearch(next ?? {}); }
    catch (reason) { if (mounted.current) setSearchLoadError(`搜索设置读取失败：${errorText(reason)}`); }
    finally { inFlight.current = false; if (mounted.current) setRefreshing(false); }
  };

  if (loading && !draft) return <div className="settings-row-desc">正在读取工具能力…</div>;
  if (!draft) return <div className="capabilities-page"><div className="capability-message is-error" role="alert">{error ?? "工具能力配置不可用"}</div><button type="button" className="btn" onClick={() => void load()}>重新读取</button></div>;
  const rowCommon = (id: BuiltinCapabilityId, enabled: boolean) => ({ id, enabled, savedEnabled: statusById.get(id)?.enabled, disabled: busy, testing: testing === id, status: statusById.get(id), checkResult: checkResult?.id === id ? checkResult : null, onTest: (target: BuiltinCapabilityId) => void test(target) });
  const connectionUsers = (connectionId: string): MediaCapabilityId[] => MEDIA_CAPABILITY_IDS.filter(id => mediaBinding(draft, id).connectionId === connectionId);
  const configChangedElsewhere = draftRevision !== undefined && snapshot?.revision !== undefined && draftRevision !== snapshot.revision;

  return <div className="capabilities-page" aria-busy={saving}>
    <p className="settings-section-desc capabilities-intro">为每项能力选择服务。已有登录和本机服务可直接使用，也可以添加 API 服务供多项能力共用。</p>
    <SettingsSection title="语音与图像" description="开关控制能力是否提供给新会话；关闭时仍可编辑服务设置。">
      {MEDIA_CAPABILITY_IDS.map(id => {
        const row = MEDIA_ROWS[id];
        const binding = mediaBinding(draft, id);
        const service = services.find(option => option.id === binding.connectionId);
        const choices = services.filter(option => option.capabilities.includes(id));
        const selectedValue = binding.selection === "auto" && id === "image-generation" ? AUTO_SERVICE : binding.connectionId;
        const legacyId = binding.connectionId.startsWith("legacy:") ? binding.connectionId.slice(7) : undefined;
        const legacy = legacyId ? draft.services?.[legacyId] : undefined;
        const connection = draft.connections?.[binding.connectionId];
        const credentials = credentialDrafts[binding.connectionId];
        const secretKeyCredentials = credentialDrafts[`${binding.connectionId}::secretKey`];
        const ref = credentialReference(draft, binding.connectionId);
        const pending = Boolean(savedConfig && differs(mediaConfiguration(draft, id), mediaConfiguration(savedConfig, id))) || hasCredentialChange(credentials) || hasCredentialChange(secretKeyCredentials)
          || Boolean(ref && Object.entries(credentialDrafts).some(([connectionId, change]) => hasCredentialChange(change) && credentialReference(draft, connectionId) === ref));
        const configured = connection ? Boolean(connection.baseUrl.trim() && binding.model?.trim() && (
          connection.auth === "none" ||
          (connection.auth === "baidu-ak-sk"
            ? (!credentials?.clear && (Boolean(credentials?.secret?.trim()) || service?.credentialSlotsConfigured?.apiKey === true)
              && !secretKeyCredentials?.clear && (Boolean(secretKeyCredentials?.secret?.trim()) || service?.credentialSlotsConfigured?.secretKey === true))
            : (!credentials?.clear && (credentials?.secret?.trim() || service?.authState === "configured")))
        )) : service?.configured;
        const restrictive = legacy?.dataPolicy === "local-only" || binding.dataPolicy === "local-only";
        const privacy = id === "speech-to-text" || id === "ocr";
        const hasUnknownSelection = selectedValue && selectedValue !== AUTO_SERVICE && !choices.some(option => option.id === selectedValue);
        const sharedLegacyCredentials = legacy?.credentialRef ? Object.values(draft.services ?? {}).filter(item => item.credentialRef === legacy.credentialRef).length : 0;
        return <CapabilityRow key={id} {...rowCommon(id, mediaEnabled(draft, id))} title={row.title} description={row.description} tools={[row.tool]} configurationPending={pending} preventEnable={restrictive || (!configured && selectedValue !== AUTO_SERVICE) || (id === "text-to-speech" && !draft.textToSpeech.voice?.trim())} detailsContent={id === "video-generation" ? <VideoJobs disabled={busy} /> : undefined} onToggle={enabled => changeConfig(current => setMediaEnabled(current, id, enabled))}>
          <div className={`capability-form-grid${legacy ? " capability-form-grid--single" : ""}`}>
            <SettingsSelect label="服务" aria-label={`${row.title}服务`} value={selectedValue} onChange={event => selectService(id, event.target.value)}>
              <option value="">暂不配置（关闭此能力）</option>
              {id === "image-generation" && <option value={AUTO_SERVICE}>自动使用已登录服务{service ? `（${service.label}）` : ""}</option>}
              {hasUnknownSelection && <option value={selectedValue}>原服务暂不可用（已保留选择）</option>}
              {choices.map(option => <option key={option.id} value={option.id}>{option.label}{option.authState === "needs-login" ? "（需要登录）" : ""}</option>)}
              <optgroup label="添加服务商">
                {MEDIA_PROVIDER_PRESETS.filter(preset => preset.capabilities.includes(id) && !Object.values(draft.connections ?? {}).some(connection => connection.presetId === preset.id)).map(preset =>
                  <option key={preset.id} value={`${ADD_PRESET_PREFIX}${preset.id}`}>＋ {preset.label}</option>
                )}
              </optgroup>
              <option value={ADD_SERVICE}>＋ 自定义兼容 API…</option>
            </SettingsSelect>
            {!legacy && <MediaModelField key={JSON.stringify([service?.id, Boolean(service?.models[id]?.length)])} id={id} binding={binding} service={service} onChange={model => changeConfig(current => ({
              ...current,
              mediaBindings: { ...current.mediaBindings, [id]: { ...mediaBinding(current, id), model } },
            }))} />}
          </div>
          {/* API 服务没有模型目录时，把服务行的可操作原因（例如 Key 含中文）直接显示在模型控件下面。 */}
          {service?.source === "api" && !legacy && !(service.models[id]?.length) && service.detail && <p className="settings-row-desc">{service.detail}</p>}
          {id === "image-generation" && binding.selection === "auto" && <p className="settings-row-desc">{service ? `当前使用 ${service.label}；登录变化或调用失败不会自动切换服务。` : "首次发现可用的已登录图片服务后确定选择。不会重新开启已关闭的能力。"}</p>}
          {service?.authState === "needs-login" && <p className="settings-row-desc">请在模型设置中登录此服务；原有选择会保留。</p>}
          {connection && <div className="capability-service-meta"><span className="settings-row-desc">{service?.location === "loopback" ? "本机地址" : "远程服务"} · {connection.auth === "none" ? "无需认证" : connection.auth === "baidu-ak-sk"
            ? (credentials?.clear || secretKeyCredentials?.clear ? "密钥待移除"
              : credentials?.secret?.trim() || secretKeyCredentials?.secret?.trim() ? "密钥待保存"
              : service?.authState === "configured" ? "双密钥已保存" : "需要 API Key 和 Secret Key")
            : credentials?.clear ? "密钥待移除" : credentials?.secret?.trim() ? "密钥待保存" : service?.authState === "configured" ? "已保存 API Key" : "需要 API Key"}</span><button type="button" className="btn" onClick={() => editConnection(binding.connectionId)}>编辑服务</button></div>}
          {id === "ocr" && connection?.protocol === "openai-compatible" && <p className="settings-row-desc">视觉模型提取文字，不提供位置框。</p>}
          {legacy && legacyId && <RecognitionServiceEditor value={legacy} adapter={legacy.adapter} effectiveDataPolicy={restrictive ? "local-only" : "allow-cloud"} onAllowConversation={legacy.dataPolicy !== "local-only" && binding.dataPolicy === "local-only" ? () => changeConfig(current => ({ ...current, mediaBindings: { ...current.mediaBindings, [id]: { ...mediaBinding(current, id), dataPolicy: "allow-cloud" } } })) : undefined} disabled={busy} secret={credentials?.secret} clearCredential={credentials?.clear} credentialConfigured={service?.authState === "configured"} sharedCredentialNote={sharedLegacyCredentials > 1 ? "此密钥由多个识别服务共用；更新或移除会同时影响这些服务。" : undefined} onCredentialChange={change => changeCredential(binding.connectionId, change)} onChange={value => changeConfig(current => ({ ...current, services: { ...current.services, [legacyId]: value }, ...(current.mediaBindings?.[id] ? { mediaBindings: { ...current.mediaBindings, [id]: { ...current.mediaBindings[id]!, model: value.model, dataPolicy: mediaBinding(current, id).dataPolicy === "local-only" ? "local-only" : value.dataPolicy } } } : {}) }))} />}
          {privacy && !legacy && (restrictive ? <div className="capability-policy-note" role="note"><p>已保留“仅限本机”的限制。当前对话无法保证识别正文只在本机处理，因此暂不能使用此能力。</p><SettingsSelect label="识别结果用于" value={binding.dataPolicy} onChange={event => changeConfig(current => ({ ...current, mediaBindings: { ...current.mediaBindings, [id]: { ...mediaBinding(current, id), dataPolicy: event.target.value as MediaCapabilityBinding["dataPolicy"] } } }))}><option value="local-only">仅限本机（对话中不可用）</option><option value="allow-cloud">当前对话（可能使用云端模型）</option></SettingsSelect></div> : <p className="settings-row-desc">识别正文会进入当前对话，并按当前模型设置处理。</p>)}
          {id === "text-to-speech" && <div className="capability-form-grid">
            <div><SettingsInput label="声音" aria-label="文字转语音声音"
              list="capability-tts-voice-options" value={draft.textToSpeech.voice ?? ""}
              placeholder="输入或选择模型支持的音色"
              onChange={event => changeConfig(current => ({ ...current, textToSpeech: { ...current.textToSpeech, voice: event.target.value || undefined } }))} />
              <datalist id="capability-tts-voice-options">{(service?.models["text-to-speech"]?.find(option => option.id === binding.model)?.voices ?? []).map(voice => <option value={voice} key={voice} />)}</datalist>
            </div>
            <SettingsInput label="语速" aria-label="文字转语音语速" type="number" min={0.25} max={4} step={0.05} value={draft.textToSpeech.rate ?? ""} placeholder="1（正常）" onChange={event => changeConfig(current => ({ ...current, textToSpeech: { ...current.textToSpeech, rate: event.target.value || undefined } }))} />
          </div>}
        </CapabilityRow>;
      })}
    </SettingsSection>

    <SettingsSection title="API 服务" description="连接和密钥只需设置一次。已有登录服务在模型设置中管理。">
      {Object.entries(draft.connections ?? {}).map(([id, connection]) => <details id={`capability-connection-${id}`} key={id} className="capability-connection" open={openConnections.has(id)} onToggle={event => { const open = event.currentTarget.open; setOpenConnections(current => { if (current.has(id) === open) return current; const next = new Set(current); if (open) next.add(id); else next.delete(id); return next; }); }}>
        <summary><span><strong>{connection.name || "未命名 API 服务"}</strong><span className="settings-row-desc">{PROTOCOL_LABEL[connection.protocol]}</span></span><span className="settings-disclosure-chevron" aria-hidden="true">⌄</span></summary>
        <ApiConnectionEditor id={id} value={connection} option={snapshot?.mediaServices?.find(option => option.id === id)}
          credentials={credentialDrafts[id]} secretKeyCredentials={credentialDrafts[`${id}::secretKey`]}
          usedBy={connectionUsers(id)} disabled={busy}
          onChange={value => {
            changeConfig(current => ({ ...current, connections: { ...current.connections, [id]: value } }));
            if (value.auth === "none") setCredentialDrafts(current => { const next = { ...current }; delete next[id]; delete next[`${id}::secretKey`]; return next; });
          }}
          onCredentialChange={value => changeCredential(id, value)}
          onSecretKeyCredentialChange={value => changeCredential(`${id}::secretKey`, value)}
          onRemove={() => {
            changeConfig(current => { const connections = { ...current.connections }; delete connections[id]; return { ...current, connections }; });
            setCredentialDrafts(current => { const next = { ...current }; delete next[id]; delete next[`${id}::secretKey`]; return next; });
          }} />
      </details>)}
      <div className="settings-row capability-add-service"><div className="settings-row-desc">{Object.keys(draft.connections ?? {}).length ? "可添加另一家服务，再为需要的能力选择它。" : "有服务地址和 API Key 时，可以在这里添加连接。"}</div><button type="button" className="btn" disabled={busy} onClick={() => addConnection()}>添加 API 服务</button></div>
    </SettingsSection>

    <SettingsSection title="搜索与图像理解">
      <CapabilityRow {...rowCommon("web", draft.web.enabled)} title="联网搜索" description={searchPolicy.mode === "parallel" ? `同时搜索 ${searchPolicy.providers.length} 家供应商` : "选择检索方式与供应商。"} tools={["web_search", "fetch_content", "source_check", "get_search_content"]} configurationPending={searchPending} collapsible defaultCollapsed summary={searchSummary(draft.web.enabled, searchPolicy)} onToggle={enabled => changeConfig(current => ({ ...current, web: { ...current.web, enabled } }))}>
        {searchLoadError ? <div className="capability-search-error"><p className="settings-inline-error" role="alert">{searchLoadError}</p><button type="button" className="btn" disabled={busy || refreshing} onClick={() => void retrySearch()}>重新读取搜索设置</button></div> : <><SearchSettings value={searchPolicy} configured={searchProviderChoices} disabled={!draft.web.enabled || busy} onChange={setSearchPolicy} /><details className="capability-options"><summary>搜索 API Key</summary><div className="capability-form-grid">{([['tavilyApiKey', 'Tavily'], ['serperApiKey', 'Serper'], ['tinyfishApiKey', 'TinyFish'], ['braveApiKey', 'Brave']] as const).map(([key, label]) => <SettingsInput key={key} label={`${label} API Key`} type="password" autoComplete="new-password" value={webSearchDraft?.[key] ?? ""} onChange={event => setWebSearchDraft(current => ({ ...(current ?? {}), [key]: event.target.value || undefined }))} />)}</div></details></>}
      </CapabilityRow>
      <CapabilityRow {...rowCommon("vision", draft.vision.enabled)} title="图像理解" description="为不支持图片输入的主模型选择视觉模型；用于分析图片。" tools={["describe_image"]} configurationPending={savedConfig?.vision.model !== draft.vision.model} preventEnable={!visionModels.length} collapsible summary={draft.vision.model ? `视觉模型 · ${visionModels.find(model => model.id === draft.vision.model)?.name ?? draft.vision.model}` : "自动使用可用视觉模型"} onToggle={enabled => changeConfig(current => ({ ...current, vision: { ...current.vision, enabled } }))}>
        <SettingsSelect label="视觉模型" value={draft.vision.model ?? ""} disabled={!visionModels.length} onChange={event => changeConfig(current => ({ ...current, vision: { ...current.vision, model: event.target.value || undefined } }))}>
          <option value="">{visionModels.length ? "自动使用可用视觉模型" : "暂无支持图片输入的已启用模型"}</option>
          {draft.vision.model && !visionModels.some(model => model.id === draft.vision.model) && <option value={draft.vision.model}>{draft.vision.model}（暂不可用）</option>}
          {visionModels.map(model => <option key={model.id} value={model.id}>{model.name} · {model.vendor}</option>)}
        </SettingsSelect>
      </CapabilityRow>
    </SettingsSection>

    <SettingsSection title="多模型会诊" testId="consult-capability">
      <CapabilityRow {...rowCommon("multi-model-consult", draft.multiModelConsult.enabled)} title="多模型会诊" tools={["multi_model_consult"]} configurationPending={differs(savedConfig?.multiModelConsult, draft.multiModelConsult)} onToggle={enabled => changeConfig(current => ({ ...current, multiModelConsult: { ...current.multiModelConsult, enabled } }))}>
        <MultiModelConsultSettings config={draft.multiModelConsult} disabled={busy} onChange={multiModelConsult => changeConfig(current => ({ ...current, multiModelConsult }))} />
      </CapabilityRow>
    </SettingsSection>

    <SettingsSection title="本机工具" description="按需检查本机环境，不调用模型或安装组件。" collapsible>
      <CapabilityRow {...rowCommon("browser", draft.browser.enabled)} title="界面与桌面操作" description={`读取并操作浏览器、MyBuddy 界面和${desktopPlatformLabel(window.api?.platform)}。`} tools={statusById.get("browser")?.tools ?? ["browser_exec", "ui_exec", "computer_exec"]} onToggle={enabled => changeConfig(current => ({ ...current, browser: { enabled } }))}><div className="settings-row-desc">{desktopRuntimeSummary(window.api?.platform)}</div></CapabilityRow>
      <CapabilityRow {...rowCommon("terminal", draft.execution.terminalEnabled)} title="命令执行" description="在任务中执行命令。" tools={["bash"]} onToggle={terminalEnabled => changeConfig(current => ({ ...current, execution: { ...current.execution, terminalEnabled } }))}><div className="settings-row-desc">Pi Bash · 任务隔离与审批</div></CapabilityRow>
      <CapabilityRow {...rowCommon("code-execution", draft.execution.codeExecutionEnabled)} title="代码执行" description="执行 JavaScript、PowerShell 和受管 Python。" tools={["execute_code"]} onToggle={codeExecutionEnabled => changeConfig(current => ({ ...current, execution: { ...current.execution, codeExecutionEnabled } }))}><div className="settings-row-desc">代码执行 · 受管 Python</div></CapabilityRow>
      <CapabilityRow {...rowCommon("subagent", draft.subagent.enabled)} title="子代理" description="委派有边界的独立子任务。" tools={["subagent", "subagent_list", "subagent_steer"]} onToggle={enabled => changeConfig(current => ({ ...current, subagent: { enabled } }))}><div className="settings-row-desc">模型登录在委派时验证。</div></CapabilityRow>
    </SettingsSection>
    <SettingsSection title="开发诊断" description="读取应用运行状态和日志，独立于界面操作开关。" collapsible>
      <CapabilityRow {...rowCommon("runtime-diagnostics", draft.diagnostics?.enabled ?? draft.browser.enabled)} title="运行诊断" tools={["runtime_probe"]} onToggle={enabled => changeConfig(current => ({ ...current, diagnostics: { enabled } }))}><div className="settings-row-desc">应用、浏览器与产物的运行状态</div></CapabilityRow>
    </SettingsSection>

    {message && <div className="capability-message is-ok" role="status">{message}</div>}
    {error && <div className="capability-message is-error" role="alert">{error}</div>}
    {configChangedElsewhere && <div className="capability-message is-warning"><p>配置已在其他位置更新。当前草稿仍保留，重新载入后再继续编辑。</p><button type="button" className="btn" disabled={busy || refreshing} onClick={() => { acceptConfig(snapshot!); setCredentialDrafts({}); setError(null); }}>放弃能力草稿并重新载入</button></div>}
    <div className="settings-footer-bar capabilities-footer">
      <span className="settings-row-desc">{mainPending || searchPending ? "有未保存的更改" : "配置已保存"}</span>
      <button type="button" className="btn" disabled={busy || refreshing || loading} onClick={() => void refresh()}>{refreshing ? "刷新中…" : "刷新状态"}</button>
      <button type="button" className="btn primary" disabled={busy || refreshing || (!mainPending && !searchPending)} onClick={() => void save()}>{saving ? "保存中…" : "保存能力配置"}</button>
    </div>
  </div>;
}
