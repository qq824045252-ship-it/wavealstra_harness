import { useCallback, useEffect, useMemo, useState } from "react";
import { IconBot, IconCheck, IconRefresh, IconX } from "@/components/common/icons";
import { loadExternalAgentCatalog, updateExternalAgentCatalog, useExternalAgentCatalog } from "@/lib/externalAgentCatalog";
import type {
  ExternalAgentConfigOptionDto,
  ExternalAgentDescriptorDto,
  ExternalAgentId,
  ExternalAgentTestResultDto,
} from "@shared/external-agent";
import "./AcpTab.css";

function availabilityLabel(agent: ExternalAgentDescriptorDto): { text: string; tone: "ready" | "adapter" | "missing" | "disabled" } {
  if (!agent.enabled) return { text: "已停用", tone: "disabled" };
  if (!agent.available) return { text: "未就绪", tone: "missing" };
  return agent.availability === "adapter"
    ? { text: "ACP 适配器", tone: "adapter" }
    : { text: "原生 ACP", tone: "ready" };
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.max(1, Math.round(ms))}ms`;
}

function AcpToggle({
  on,
  disabled,
  onChange,
}: {
  on: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`switch ${on ? "on" : ""}`}
      disabled={disabled}
      aria-pressed={on}
      onClick={() => {
        if (!disabled) onChange(!on);
      }}
    />
  );
}

function AgentTestResult({ result }: { result: ExternalAgentTestResultDto }): React.JSX.Element {
  return (
    <div className={`acp-test-result ${result.ok ? "is-ok" : "is-error"}`}>
      <div className="acp-test-steps">
        {result.steps.map((step) => (
          <span key={step.id} className={`acp-test-step ${step.ok ? "ok" : "fail"}`}>
            {step.ok ? <IconCheck size={11} /> : <IconX size={11} />}
            {step.label}
            <em>{formatDuration(step.durationMs)}</em>
          </span>
        ))}
        <span className="acp-test-total">共 {formatDuration(result.durationMs)}</span>
      </div>
      {result.ok ? (
        <div className="acp-test-meta">
          {result.sessionId && <span>session：{result.sessionId}</span>}
          <span>{result.resumeSupported ? "支持会话续聊" : "不支持会话续聊"}</span>
          {result.authMethods && result.authMethods.length > 0 && (
            <span>认证方式：{result.authMethods.join("、")}</span>
          )}
          {result.configOptions && result.configOptions.length > 0 && (
            <span>捕获 {result.configOptions.length} 个会话选项（可在下方设置默认值）</span>
          )}
        </div>
      ) : (
        result.error && <pre className="acp-test-error">{result.error}</pre>
      )}
      {result.notes && result.notes.length > 0 && (
        <div className="acp-test-notes">
          {result.notes.map((note, index) => <div key={index}>{note}</div>)}
        </div>
      )}
    </div>
  );
}

/** 单个会话选项行：select 渲染为下拉（含「默认」项），boolean 渲染为 默认/开启/关闭 三态下拉。 */
function AgentConfigOptionRow({
  option,
  saved,
  disabled,
  onChange,
}: {
  option: ExternalAgentConfigOptionDto;
  saved: string | boolean | undefined;
  disabled?: boolean;
  onChange: (value: string | boolean | undefined) => void;
}): React.JSX.Element {
  if (option.type === "boolean") {
    const value = saved === true ? "true" : saved === false ? "false" : "";
    return (
      <label className="acp-config-row">
        <span className="acp-config-label" title={option.description}>{option.name}</span>
        <select
          className="acp-config-select"
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.value === "true")}
        >
          <option value="">默认（{option.currentValue === true ? "开启" : "关闭"}）</option>
          <option value="true">开启</option>
          <option value="false">关闭</option>
        </select>
      </label>
    );
  }
  const options = option.options ?? [];
  const currentName = options.find((item) => item.value === option.currentValue)?.name
    ?? (typeof option.currentValue === "string" && option.currentValue ? option.currentValue : "Agent 默认");
  const savedValue = typeof saved === "string" ? saved : "";
  const stale = Boolean(savedValue) && !options.some((item) => item.value === savedValue);
  return (
    <label className="acp-config-row">
      <span className="acp-config-label" title={option.description}>{option.name}</span>
      <select
        className={`acp-config-select${stale ? " is-stale" : ""}`}
        value={savedValue}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value || undefined)}
      >
        <option value="">默认（{currentName}）</option>
        {stale && <option value={savedValue}>{savedValue}（已失效）</option>}
        {options.map((item) => (
          <option key={item.value} value={item.value} title={item.description}>
            {item.group ? `${item.group} / ` : ""}{item.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function AgentRow({
  agent,
  busy,
  testing,
  result,
  onToggle,
  onTest,
  onConfigChange,
}: {
  agent: ExternalAgentDescriptorDto;
  busy: boolean;
  testing: boolean;
  result?: ExternalAgentTestResultDto;
  onToggle: (enabled: boolean) => void;
  onTest: () => void;
  onConfigChange: (configId: string, value: string | boolean | undefined) => void;
}): React.JSX.Element {
  const state = availabilityLabel(agent);
  return (
    <div className={`acp-agent-row${agent.enabled ? "" : " is-disabled"}`}>
      <div className="acp-agent-icon"><IconBot size={16} /></div>
      <div className="acp-agent-copy">
        <div className="acp-agent-title-line">
          <strong>{agent.name}</strong>
          <span className={`acp-state acp-state--${state.tone}`}>{state.text}</span>
        </div>
        <div className="acp-agent-command">{agent.commandLabel}</div>
        {agent.detail && <div className="acp-agent-detail">{agent.detail}</div>}
        {agent.configOptions && agent.configOptions.length > 0 && (
          <div className="acp-config-list">
            {agent.configOptions.map((option) => (
              <AgentConfigOptionRow
                key={option.id}
                option={option}
                saved={agent.configSelections?.[option.id]}
                disabled={busy}
                onChange={(value) => onConfigChange(option.id, value)}
              />
            ))}
          </div>
        )}
        {testing && <div className="acp-agent-detail">正在测试：启动 ACP 进程并创建会话…</div>}
        {result && <AgentTestResult result={result} />}
      </div>
      <div className="acp-agent-actions">
        <button
          type="button"
          className="acp-test-btn"
          disabled={busy || testing}
          onClick={onTest}
        >
          {testing ? "测试中…" : "测试"}
        </button>
        <AcpToggle on={agent.enabled} disabled={busy} onChange={onToggle} />
      </div>
    </div>
  );
}

export default function AcpTab(): React.JSX.Element {
  const agents = useExternalAgentCatalog((state) => state.agents);
  const loading = useExternalAgentCatalog((state) => state.loading || (!state.loaded && !state.error));
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<ExternalAgentId | null>(null);
  const [testingId, setTestingId] = useState<ExternalAgentId | null>(null);
  const [results, setResults] = useState<Partial<Record<ExternalAgentId, ExternalAgentTestResultDto>>>({});
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);

  const load = useCallback(async (refresh = false): Promise<void> => {
    if (refresh) setRefreshing(true);
    try {
      await loadExternalAgentCatalog(refresh);
      setNotice(null);
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : String(error), error: true });
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (agent: ExternalAgentDescriptorDto, enabled: boolean): Promise<void> => {
    const setEnabled = window.api?.externalAgent?.setEnabled;
    if (!setEnabled) {
      setNotice({ text: "外部 Agent API 未就绪，请完整重启应用", error: true });
      return;
    }
    setBusyId(agent.id);
    setNotice(null);
    try {
      const items = await setEnabled(agent.id, enabled);
      updateExternalAgentCatalog(items ?? []);
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : String(error), error: true });
    } finally {
      setBusyId(null);
    }
  };

  const setConfigOption = async (
    agent: ExternalAgentDescriptorDto,
    configId: string,
    value: string | boolean | undefined,
  ): Promise<void> => {
    const setter = window.api?.externalAgent?.setConfigOption;
    if (!setter) {
      setNotice({ text: "外部 Agent API 未就绪，请完整重启应用", error: true });
      return;
    }
    setBusyId(agent.id);
    setNotice(null);
    try {
      const items = await setter({ agentId: agent.id, configId, value });
      updateExternalAgentCatalog(items ?? []);
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : String(error), error: true });
    } finally {
      setBusyId(null);
    }
  };

  const test = async (agent: ExternalAgentDescriptorDto): Promise<void> => {
    const testFn = window.api?.externalAgent?.test;
    if (!testFn) {
      setNotice({ text: "外部 Agent API 未就绪，请完整重启应用", error: true });
      return;
    }
    setTestingId(agent.id);
    setNotice(null);
    try {
      const result = await testFn(agent.id);
      setResults((current) => ({ ...current, [agent.id]: result }));
      if (!result.ok) setNotice({ text: `${agent.name} 测试未通过`, error: true });
      else if (result.configOptions?.length) {
        const current = useExternalAgentCatalog.getState().agents;
        updateExternalAgentCatalog(current.map((item) => item.id === agent.id
          ? { ...item, configOptions: result.configOptions }
          : item));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setResults((current) => ({
        ...current,
        [agent.id]: { agentId: agent.id, ok: false, durationMs: 0, steps: [], error: message },
      }));
      setNotice({ text: message, error: true });
    } finally {
      setTestingId(null);
    }
  };

  const enabledCount = useMemo(() => agents.filter((agent) => agent.enabled).length, [agents]);
  const readyCount = useMemo(() => agents.filter((agent) => agent.enabled && agent.available).length, [agents]);

  return (
    <div className="acp-page">
      <div className="acp-hero">
        <div>
          <h2>ACP 管理</h2>
          <p>通过 Agent Client Protocol 接入本机外部 Agent CLI。停用后该 Agent 不再出现在「+ → 外部 Agent」委托入口，也无法接收新任务。</p>
        </div>
        <div className="acp-hero-side">
          <div className="acp-ready-count"><strong>{readyCount}</strong><span>/ {enabledCount} 启用中可用</span></div>
          <button
            type="button"
            className="acp-refresh-btn"
            disabled={refreshing}
            title="重新探测本机 ACP Runtime"
            onClick={() => void load(true)}
          >
            <IconRefresh size={13} />
            {refreshing ? "检测中…" : "重新检测"}
          </button>
        </div>
      </div>

      {notice && <div className={`acp-notice ${notice.error ? "error" : ""}`}>{notice.text}</div>}

      <section className="acp-group">
        <div className="acp-group-head">
          <div>
            <h3>外部 Agent · ACP</h3>
            <p>「测试」会实际启动对应 ACP 进程并完成协议握手 + 创建会话，同时抓取会话选项（模型/模式等）供下方设置默认值；不会发送真实任务。</p>
          </div>
        </div>
        <div className="acp-agent-list">
          {loading && agents.length === 0 ? (
            <div className="acp-empty">正在检测本机 ACP Runtime…</div>
          ) : agents.length === 0 ? (
            <div className="acp-empty">未检测到 ACP 外部 Agent</div>
          ) : (
            agents.map((agent) => (
              <AgentRow
                key={agent.id}
                agent={agent}
                busy={busyId === agent.id}
                testing={testingId === agent.id}
                result={results[agent.id]}
                onToggle={(enabled) => void toggle(agent, enabled)}
                onTest={() => void test(agent)}
                onConfigChange={(configId, value) => void setConfigOption(agent, configId, value)}
              />
            ))
          )}
        </div>
      </section>
    </div>
  );
}
