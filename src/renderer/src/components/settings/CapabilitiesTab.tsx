import SearchSettings from "./SearchSettings";
import { searchPolicyFromConfig, normalizeSearchPolicy, DEFAULT_SEARCH_POLICY } from "@shared/web-search";
import MultiModelConsultSettings from "./MultiModelConsultSettings";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BUILTIN_CODEX_IMAGE_MODEL, BUILTIN_CODEX_IMAGE_PROVIDER_ID } from "@shared/builtin-capabilities";
import type {
  BuiltinCapabilitiesConfigDto,
  BuiltinCapabilitiesSnapshotDto,
  BuiltinCapabilityId,
  BuiltinCapabilityStatusDto,
} from "@shared/builtin-capabilities";
import { desktopPlatformLabel, desktopRuntimeSummary } from "@shared/desktop-platform";
import { useAppStore } from "@/store/appStore";
import { WEB_SEARCH_PROVIDER_OPTIONS, type WebSearchConfigDto } from "@shared/agent-ipc";
import "./CapabilitiesTab.css";

const STATE_LABEL: Record<string, string> = {
  ready: "已就绪",
  unchecked: "待检查",
  disabled: "已关闭",
  "needs-configuration": "需要配置",
  "missing-dependency": "缺少运行组件",
  offline: "离线",
  degraded: "部分可用",
};

function NativeToggle({ on, disabled, label, onChange }: { on: boolean; disabled?: boolean; label: string; onChange: (value: boolean) => void }): React.JSX.Element {
  return (
    <button
      type="button"
      className={`switch ${on ? "on" : ""}`}
      disabled={disabled}
      aria-pressed={on}
      aria-label={label}
      onClick={() => !disabled && onChange(!on)}
    />
  );
}

function StatusBadge({ status, pending, readyLabel }: { status?: BuiltinCapabilityStatusDto; pending?: boolean; readyLabel?: string }): React.JSX.Element {
  if (pending) return <span className="capability-state capability-state--pending">待保存</span>;
  const state = status?.state ?? "needs-configuration";
  return <span className={`capability-state capability-state--${state}`}>{state === "ready" && readyLabel ? readyLabel : STATE_LABEL[state] ?? state}</span>;
}

function CapabilityRow({
  id,
  title,
  description,
  tools,
  enabled,
  savedEnabled,
  saving,
  testing,
  status,
  configurationPending = false,
  preventEnable = false,
  onToggle,
  onTest,
  children,
}: {
  id: BuiltinCapabilityId;
  title: string;
  description?: string;
  tools: string[];
  enabled: boolean;
  savedEnabled?: boolean;
  saving: boolean;
  testing: boolean;
  status?: BuiltinCapabilityStatusDto;
  configurationPending?: boolean;
  preventEnable?: boolean;
  onToggle: (enabled: boolean) => void;
  onTest: (id: BuiltinCapabilityId) => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const pending = configurationPending || (savedEnabled !== undefined && savedEnabled !== enabled);
  const detail = pending ? "配置尚未保存；保存后新会话按新状态注册工具。" : status?.detail;
  const toggleDisabled = saving || (preventEnable && !enabled);
  return (
    <div data-capability-id={id} className={`capability-config-row${enabled ? "" : " is-disabled"}`}>
      <div className="capability-config-copy">
        <div className="capability-config-title-line">
          <strong>{title}</strong>
          <StatusBadge status={status} pending={pending} readyLabel={id === "speech-to-text" ? "依赖检查通过" : undefined} />
        </div>
        {description && <div className="capability-config-description">{description}</div>}
        <div className="capability-config-tools">{tools.join(" · ")}</div>
      </div>
      <div className="capability-config-control">{children}</div>
      <div className="capability-config-actions">
        <button
          type="button"
          className="capability-check-btn"
          disabled={saving || testing || !enabled || pending}
          onClick={() => onTest(id)}
        >
          {testing ? "检查中" : "检查"}
        </button>
        <NativeToggle on={enabled} disabled={toggleDisabled} label={`${title}开关`} onChange={onToggle} />
      </div>
      {detail && <div className="capability-config-detail">{detail}</div>}
    </div>
  );
}

function Field({ value, placeholder, disabled, onChange }: { value: string; placeholder: string; disabled?: boolean; onChange: (value: string) => void }): React.JSX.Element {
  return (
    <input
      className="capability-field"
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function FixedRuntime({ label, enabled }: { label: string; enabled: boolean }): React.JSX.Element {
  return <div className={`capability-runtime${enabled ? "" : " is-off"}`}>{enabled ? label : "已关闭"}</div>;
}

interface ModelChoice {
  id: string;
  name: string;
  vendor: string;
}

function CapabilityModelSelect({
  value,
  choices,
  disabled,
  emptyLabel = "暂无可用模型",
  onChange,
}: {
  value: string;
  choices: ModelChoice[];
  disabled?: boolean;
  emptyLabel?: string;
  onChange: (value: string) => void;
}): React.JSX.Element {
  const groups = useMemo(() => {
    const grouped = new Map<string, ModelChoice[]>();
    for (const choice of choices) {
      const rows = grouped.get(choice.vendor) ?? [];
      rows.push(choice);
      grouped.set(choice.vendor, rows);
    }
    return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [choices]);

  return (
    <select
      className="capability-model-select"
      value={choices.some((choice) => choice.id === value) ? value : ""}
      disabled={disabled || choices.length === 0}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">{choices.length ? "选择可用模型" : emptyLabel}</option>
      {groups.map(([vendor, rows]) => (
        <optgroup key={vendor} label={vendor}>
          {rows
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((choice) => <option key={choice.id} value={choice.id}>{choice.name}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

function UnavailableModelControl({ configured }: { configured?: string }): React.JSX.Element {
  return (
    <div className="capability-model-unavailable">
      {configured ? `自定义配置：${configured}` : "暂无已接入的可用模型"}
    </div>
  );
}

export default function CapabilitiesTab(): React.JSX.Element {
  const models = useAppStore((state) => state.models);
  const [snapshot, setSnapshot] = useState<BuiltinCapabilitiesSnapshotDto | null>(null);
  const [draft, setDraft] = useState<BuiltinCapabilitiesConfigDto | null>(null);
  const [savedWebSearch, setSavedWebSearch] = useState<WebSearchConfigDto | null>(null);
  const [webSearchDraft, setWebSearchDraft] = useState<WebSearchConfigDto | null>(null);
  const [searchPolicy, setSearchPolicy] = useState(DEFAULT_SEARCH_POLICY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<BuiltinCapabilityId | null>(null);
  const [credentialId, setCredentialId] = useState("");
  const [credential, setCredential] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const visionModels = useMemo<ModelChoice[]>(() => (
    models
      .filter((model) => model.enabled !== false && model.supportsImages)
      .map((model) => ({ id: model.id, name: model.name, vendor: model.vendor }))
  ), [models]);

  const searchProviderChoices = useMemo(() => {
    const ready = new Set<string>(webSearchDraft?.configuredProviders ?? []);
    if (models.some((model) => model.vendor === "openai-codex" || model.id.startsWith("openai-codex/"))) ready.add("codex");
    const hasSearchKey = (id: string, legacyField: string): boolean => {
      const cfg = webSearchDraft as (WebSearchConfigDto & Record<string, unknown>) | null;
      const legacy = cfg?.[legacyField];
      const pool = webSearchDraft?.apiKeyPools?.[id];
      return Boolean(
        (typeof legacy === "string" && legacy.trim().length > 0) ||
        (Array.isArray(pool) && pool.length > 0),
      );
    };
    if (hasSearchKey("tavily", "tavilyApiKey")) ready.add("tavily");
    if (hasSearchKey("tinyfish", "tinyfishApiKey")) ready.add("tinyfish");
    if (hasSearchKey("brave", "braveApiKey")) ready.add("brave");
    if (hasSearchKey("serper", "serperApiKey")) ready.add("serper");
    for (const provider of savedWebSearch?.searchRouting?.providers ?? []) ready.add(provider);
    return WEB_SEARCH_PROVIDER_OPTIONS
      .filter((provider) => ready.has(provider.id))
      .map((provider) => ({ id: provider.id, label: provider.label }));
  }, [models, savedWebSearch, webSearchDraft]);



  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [next, webConfig] = await Promise.all([
        window.api?.agent?.getBuiltinCapabilities?.(),
        window.api?.agent?.getWebSearchConfig?.(),
      ]);
      if (!next) throw new Error("原生能力 API 未就绪，请重启 MyBuddy");
      setSnapshot(next);
      setDraft(structuredClone(next.config));
      const normalizedWeb = webConfig ?? {};
      setSavedWebSearch(structuredClone(normalizedWeb));
      setWebSearchDraft(structuredClone(normalizedWeb));
      setSearchPolicy(searchPolicyFromConfig(normalizedWeb));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    if (!draft || draft.vision.model || visionModels.length === 0) return;
    setDraft({ ...draft, vision: { ...draft.vision, model: visionModels[0].id } });
  }, [draft?.vision.model, visionModels]);

  const save = async (): Promise<void> => {
    if (!draft) return;
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const policyChanged = JSON.stringify(searchPolicyFromConfig(savedWebSearch ?? {})) !== JSON.stringify(searchPolicy);
      const validSearchPolicy = policyChanged || savedWebSearch?.searchPolicy ? normalizeSearchPolicy(searchPolicy) : undefined;
      const [next, nextWeb] = await Promise.all([
        window.api?.agent?.saveBuiltinCapabilities?.(draft),
        window.api?.agent?.saveWebSearchConfig?.({
          ...(webSearchDraft ?? {}),
          ...(validSearchPolicy ? { searchPolicy: validSearchPolicy } : {}),
        }),
      ]);
      if (!next) throw new Error("保存失败：Main API 无返回");
      setSnapshot(next);
      setDraft(structuredClone(next.config));
      if (nextWeb) {
        setSavedWebSearch(structuredClone(nextWeb));
        setWebSearchDraft(structuredClone(nextWeb));
        setSearchPolicy(searchPolicyFromConfig(nextWeb));
      }
      setMessage("已保存；搜索方式从下次调用生效，工具开关从新会话生效。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const saveCredential = async (clear = false): Promise<void> => {
    const id = credentialId.trim();
    if (!id) {
      setError("请先填写 Provider credential id");
      return;
    }
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const next = await window.api?.agent?.saveBuiltinCredential?.({ id, secret: credential, clear });
      if (!next) throw new Error("Credential 保存失败");
      setSnapshot(next);
      setCredential("");
      setMessage(clear ? "Credential 已从系统凭据库删除。" : "Credential 已保存到系统凭据库；不会回传到界面。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const test = async (id: BuiltinCapabilityId): Promise<void> => {
    setTesting(id);
    setMessage(null);
    setError(null);
    try {
      const result = await window.api?.agent?.testBuiltinCapability?.(id);
      if (!result) throw new Error("能力检查无返回");
      (result.ok ? setMessage : setError)(result.detail);
      const next = await window.api?.agent?.getBuiltinCapabilities?.();
      if (next) setSnapshot(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setTesting(null);
    }
  };

  const statusById = useMemo(() => new Map(snapshot?.capabilities.map((item) => [item.id, item]) ?? []), [snapshot]);
  const readyCount = useMemo(() => snapshot?.capabilities.filter((item) => item.state === "ready").length ?? 0, [snapshot]);
  const totalCount = snapshot?.capabilities.length ?? 0;

  if (loading && !draft) return <div className="settings-row-desc">正在读取工具能力…</div>;
  if (!draft) return <div className="settings-inline-error">{error ?? "工具能力配置不可用"}</div>;

  const rowCommon = (id: BuiltinCapabilityId, enabled: boolean) => ({
    id,
    enabled,
    savedEnabled: statusById.get(id)?.enabled,
    saving: saving || testing !== null,
    testing: testing === id,
    status: statusById.get(id),
    onTest: (target: BuiltinCapabilityId) => void test(target),
  });

  const searchPolicyPending = JSON.stringify(searchPolicyFromConfig(savedWebSearch ?? {})) !== JSON.stringify(searchPolicy);
  const webKeysPending = (savedWebSearch?.tavilyApiKey ?? "") !== (webSearchDraft?.tavilyApiKey ?? "")
    || (savedWebSearch?.tinyfishApiKey ?? "") !== (webSearchDraft?.tinyfishApiKey ?? "")
    || (savedWebSearch?.braveApiKey ?? "") !== (webSearchDraft?.braveApiKey ?? "")
    || (savedWebSearch?.serperApiKey ?? "") !== (webSearchDraft?.serperApiKey ?? "");
  const searchDescription = searchPolicy.mode === "parallel" ? `同时搜索 ${searchPolicy.providers.length} 家供应商` : "选择检索方式与供应商";

  const imageStatus = statusById.get("image-generation");
  const codexImageAvailable = imageStatus?.state === "ready"
    || models.some((model) => model.vendor === "openai-codex" || model.id.startsWith("openai-codex/"));
  const videoConfigured = [draft.videoGeneration.provider, draft.videoGeneration.model].filter(Boolean).join(" / ");
  const ttsConfigured = draft.textToSpeech.provider ?? "";

  return (
    <div className="capabilities-page">
      <div className="capabilities-hero">
        <div>
          <h2>工具能力</h2>
          <p>只显示真正具备条件的模型。已经登录且支持对应输入的模型会自动出现在列表中，不需要手填 Adapter ID。</p>
        </div>
        <div className="capabilities-ready-count"><strong>{readyCount}</strong><span>/ {totalCount} 已就绪</span></div>
      </div>

      <section className="capability-group consult-settings-group" data-testid="consult-capability">
        <div className="capability-group-head"><div><h3>多模型会诊</h3></div></div>
        <CapabilityRow
          {...rowCommon("multi-model-consult", draft.multiModelConsult.enabled)}
          title="多模型会诊"
          tools={["multi_model_consult"]}
          configurationPending={JSON.stringify(snapshot?.config.multiModelConsult) !== JSON.stringify(draft.multiModelConsult)}
          onToggle={(enabled) => setDraft({ ...draft, multiModelConsult: { ...draft.multiModelConsult, enabled } })}
        >
          <MultiModelConsultSettings config={draft.multiModelConsult} disabled={saving} onChange={(multiModelConsult) => setDraft({ ...draft, multiModelConsult })} />
        </CapabilityRow>
      </section>

      <section className="capability-group">
        <div className="capability-group-head">
          <div>
            <h3>外部与多模态</h3>
            <p>模型候选来自当前已登录的模型供应商。没有候选时保持关闭即可。</p>
          </div>
        </div>
        <div className="capability-config-list">
          <CapabilityRow
            {...rowCommon("web", draft.web.enabled)}
            title="联网搜索"
            description={searchDescription}
            tools={["web_search", "fetch_content", "source_check", "get_search_content"]}
            configurationPending={searchPolicyPending || webKeysPending}
            onToggle={(enabled) => setDraft({ ...draft, web: { ...draft.web, enabled } })}
          >
            <SearchSettings value={searchPolicy} configured={searchProviderChoices.map(p => p.id)} disabled={!draft.web.enabled || saving} onChange={setSearchPolicy} />
          </CapabilityRow>

          <CapabilityRow
            {...rowCommon("vision", draft.vision.enabled)}
            title="图像理解"
            description={visionModels.length ? `主模型支持图片时原生直读；纯文本主模型自动委托所选视觉模型。已发现 ${visionModels.length} 个多模态候选` : "当前已登录模型中没有支持图片输入的模型，纯文本主模型将没有 Vision fallback"}
            tools={["describe_image"]}
            configurationPending={snapshot?.config.vision.model !== draft.vision.model}
            preventEnable={visionModels.length === 0}
            onToggle={(enabled) => setDraft({ ...draft, vision: { ...draft.vision, enabled } })}
          >
            <CapabilityModelSelect
              value={draft.vision.model ?? ""}
              choices={visionModels}
              disabled={!draft.vision.enabled || saving}
              onChange={(model) => setDraft({ ...draft, vision: { ...draft.vision, model: model || undefined } })}
            />
          </CapabilityRow>

          <CapabilityRow
            {...rowCommon("image-generation", draft.imageGeneration.enabled)}
            title="图像生成"
            description={codexImageAvailable
              ? "复用 OpenAI Codex（ChatGPT OAuth）登录，使用 GPT Image 2；支持文本生成和参考图编辑"
              : "登录 OpenAI Codex（ChatGPT OAuth）后自动启用 GPT Image 2，无需额外 API Key"}
            tools={["image_generate"]}
            configurationPending={snapshot?.config.imageGeneration.provider !== draft.imageGeneration.provider || snapshot?.config.imageGeneration.model !== draft.imageGeneration.model}
            preventEnable={!codexImageAvailable}
            onToggle={(enabled) => setDraft({
              ...draft,
              imageGeneration: {
                enabled,
                provider: BUILTIN_CODEX_IMAGE_PROVIDER_ID,
                model: BUILTIN_CODEX_IMAGE_MODEL,
              },
            })}
          >
            <FixedRuntime
              enabled={draft.imageGeneration.enabled && codexImageAvailable}
              label="OpenAI Codex · GPT Image 2"
            />
          </CapabilityRow>

          <CapabilityRow
            {...rowCommon("video-generation", draft.videoGeneration.enabled)}
            title="视频生成"
            description="仅在存在真正的视频生成 Adapter / 模型时启用"
            tools={["video_generate"]}
            configurationPending={snapshot?.config.videoGeneration.provider !== draft.videoGeneration.provider || snapshot?.config.videoGeneration.model !== draft.videoGeneration.model}
            preventEnable={!videoConfigured}
            onToggle={(enabled) => setDraft({ ...draft, videoGeneration: { ...draft.videoGeneration, enabled } })}
          >
            <UnavailableModelControl configured={videoConfigured} />
          </CapabilityRow>

          <CapabilityRow
            {...rowCommon("speech-to-text", draft.speechToText.enabled)}
            title="语音转文字"
            description="本地 Whisper medium-int8 / NPU。检查仅核对配置与依赖路径；最近真实转写未在此检查中验证，需用音频试运行。"
            tools={["speech_to_text"]}
            configurationPending={snapshot?.config.speechToText.provider !== draft.speechToText.provider}
            onToggle={(enabled) => setDraft({ ...draft, speechToText: { ...draft.speechToText, enabled, provider: "local-whisper" } })}
          >
            <FixedRuntime enabled={draft.speechToText.enabled} label="本地 Whisper · NPU" />
          </CapabilityRow>

          <CapabilityRow
            {...rowCommon("text-to-speech", draft.textToSpeech.enabled)}
            title="文字转语音"
            description="仅在存在真正的语音合成 Adapter 时启用"
            tools={["text_to_speech"]}
            configurationPending={snapshot?.config.textToSpeech.provider !== draft.textToSpeech.provider || snapshot?.config.textToSpeech.voice !== draft.textToSpeech.voice}
            preventEnable={!ttsConfigured}
            onToggle={(enabled) => setDraft({ ...draft, textToSpeech: { ...draft.textToSpeech, enabled } })}
          >
            <UnavailableModelControl configured={ttsConfigured} />
          </CapabilityRow>
        </div>
      </section>

      <details className="capability-advanced-config">
        <summary>
          <span><strong>高级配置</strong><small>搜索 API Key 与开发中的自定义 Provider；普通使用通常无需展开</small></span>
          <span className="capability-credentials-chevron">&#8964;</span>
        </summary>
        <div className="capability-advanced-body">
          <div className="capability-advanced-row">
            <span>联网搜索 API Key</span>
            <div className="capability-fields">
              <Field value={webSearchDraft?.tavilyApiKey ?? ""} placeholder="Tavily API Key" disabled={saving} onChange={(tavilyApiKey) => setWebSearchDraft({ ...(webSearchDraft ?? {}), tavilyApiKey: tavilyApiKey || undefined })} />
              <Field value={webSearchDraft?.serperApiKey ?? ""} placeholder="Serper API Key" disabled={saving} onChange={(serperApiKey) => setWebSearchDraft({ ...(webSearchDraft ?? {}), serperApiKey: serperApiKey || undefined })} />
              <Field value={webSearchDraft?.tinyfishApiKey ?? ""} placeholder="TinyFish API Key" disabled={saving} onChange={(tinyfishApiKey) => setWebSearchDraft({ ...(webSearchDraft ?? {}), tinyfishApiKey: tinyfishApiKey || undefined })} />
              <Field value={webSearchDraft?.braveApiKey ?? ""} placeholder="Brave API Key" disabled={saving} onChange={(braveApiKey) => setWebSearchDraft({ ...(webSearchDraft ?? {}), braveApiKey: braveApiKey || undefined })} />
            </div>
          </div>
          <div className="capability-advanced-row">
            <span>视频生成</span>
            <div className="capability-fields capability-fields--two">
              <Field value={draft.videoGeneration.provider ?? ""} placeholder="Provider Adapter ID" disabled={saving} onChange={(provider) => setDraft({ ...draft, videoGeneration: { ...draft.videoGeneration, provider: provider || undefined } })} />
              <Field value={draft.videoGeneration.model ?? ""} placeholder="模型 ID" disabled={saving} onChange={(model) => setDraft({ ...draft, videoGeneration: { ...draft.videoGeneration, model: model || undefined } })} />
            </div>
          </div>
          <div className="capability-advanced-row">
            <span>文字转语音</span>
            <div className="capability-fields capability-fields--two">
              <Field value={draft.textToSpeech.provider ?? ""} placeholder="TTS Adapter ID" disabled={saving} onChange={(provider) => setDraft({ ...draft, textToSpeech: { ...draft.textToSpeech, provider: provider || undefined } })} />
              <Field value={draft.textToSpeech.voice ?? ""} placeholder="Voice（可选）" disabled={saving} onChange={(voice) => setDraft({ ...draft, textToSpeech: { ...draft.textToSpeech, voice: voice || undefined } })} />
            </div>
          </div>
        </div>
      </details>

      <details className="capability-group capability-group--collapsible">
        <summary className="capability-group-head capability-group-summary">
          <div>
            <h3>本机工具</h3>
            <p>关闭后从新会话生效；检查会实际运行探测，不调用模型。</p>
          </div>
          <span className="capability-group-chevron">&#8964;</span>
        </summary>
        <div className="capability-config-list">
          <CapabilityRow
            {...rowCommon("browser", draft.browser.enabled)}
            title="界面与桌面操作"
            description={`读取并操作浏览器、MyBuddy 界面和${desktopPlatformLabel(window.api?.platform)}；检查会分别读取可用目标`}
            tools={statusById.get("browser")?.tools ?? ["browser_exec", "ui_exec", "computer_exec"]}
            onToggle={(enabled) => setDraft({ ...draft, browser: { enabled } })}
          >
            <FixedRuntime enabled={draft.browser.enabled} label={desktopRuntimeSummary(window.api?.platform)} />
          </CapabilityRow>

          <CapabilityRow
            {...rowCommon("terminal", draft.execution.terminalEnabled)}
            title="命令执行"
            description="直接使用 Pi 原生 bash；关闭后新会话不提供 bash"
            tools={["bash"]}
            onToggle={(terminalEnabled) => setDraft({ ...draft, execution: { ...draft.execution, terminalEnabled } })}
          >
            <FixedRuntime enabled={draft.execution.terminalEnabled} label="Pi Bash · 任务隔离与审批" />
          </CapabilityRow>

          <CapabilityRow
            {...rowCommon("code-execution", draft.execution.codeExecutionEnabled)}
            title="代码执行"
            description="执行 JavaScript、PowerShell 和受管 Python；检查不下载环境，缺少 Python 会显示部分可用"
            tools={["execute_code"]}
            onToggle={(codeExecutionEnabled) => setDraft({ ...draft, execution: { ...draft.execution, codeExecutionEnabled } })}
          >
            <FixedRuntime enabled={draft.execution.codeExecutionEnabled} label="代码执行 · 受管 Python" />
          </CapabilityRow>

          <CapabilityRow
            {...rowCommon("subagent", draft.subagent.enabled)}
            title="子代理"
            description="委派独立子任务；检查实际启动子代理入口，模型登录在委派时验证"
            tools={["subagent", "subagent_list", "subagent_steer"]}
            onToggle={(enabled) => setDraft({ ...draft, subagent: { enabled } })}
          >
            <FixedRuntime enabled={draft.subagent.enabled} label="Subagent Runtime" />
          </CapabilityRow>
        </div>
      </details>

      <details className="capability-group capability-group--collapsible">
        <summary className="capability-group-head capability-group-summary">
          <div><h3>开发诊断</h3><p>读取应用运行状态和日志，独立于界面操作开关。</p></div>
          <span className="capability-group-chevron">&#8964;</span>
        </summary>
        <div className="capability-config-list">
          <CapabilityRow
            {...rowCommon("runtime-diagnostics", draft.diagnostics?.enabled ?? draft.browser.enabled)}
            title="运行诊断"
            description="读取应用、浏览器与产物的运行状态和日志"
            tools={["runtime_probe"]}
            onToggle={(enabled) => setDraft({ ...draft, diagnostics: { enabled } })}
          >
            <FixedRuntime enabled={draft.diagnostics?.enabled ?? draft.browser.enabled} label="运行状态 · 日志" />
          </CapabilityRow>
        </div>
      </details>

      <details className="capability-credentials">
        <summary>
          <span><strong>Provider 凭据</strong><small>高级设置 · 密钥只写入操作系统凭据库</small></span>
          <span className="capability-credentials-chevron">&#8964;</span>
        </summary>
        <div className="capability-credentials-body">
          <div className="capability-fields capability-fields--credential">
            <Field value={credentialId} placeholder="Credential ID" onChange={setCredentialId} disabled={saving} />
            <input className="capability-field" type="password" value={credential} placeholder="Secret" onChange={(event) => setCredential(event.target.value)} autoComplete="new-password" disabled={saving} />
          </div>
          <div className="capability-credential-actions">
            <button type="button" className="btn" disabled={saving || !credentialId.trim()} onClick={() => void saveCredential(true)}>删除凭据</button>
            <button type="button" className="btn primary" disabled={saving || !credentialId.trim() || !credential.trim()} onClick={() => void saveCredential(false)}>保存凭据</button>
          </div>
        </div>
      </details>

      {(message || error) && <div className={`capability-message ${error ? "is-error" : "is-ok"}`}>{error ?? message}</div>}

      <div className="settings-footer-bar capabilities-footer">
        <button type="button" className="btn" disabled={saving || loading} onClick={() => void reload()}>{loading ? "刷新中…" : "刷新状态"}</button>
        <button type="button" className="btn primary" disabled={saving} onClick={() => void save()}>{saving ? "保存中…" : "保存能力配置"}</button>
      </div>
    </div>
  );
}
