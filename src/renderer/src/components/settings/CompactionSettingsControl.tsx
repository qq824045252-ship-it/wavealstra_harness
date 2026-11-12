import { useEffect, useState } from "react";
import { SettingsToggle } from "./SettingsPrimitives";
import { useAppStore } from "@/store/appStore";
import type { TaskCompactionStatusDto } from "@shared/compaction";
import { DEFAULT_COMPACTION_TRIGGER_RATIO, DEFAULT_COMPACTION_TRIGGER_TOKENS,
  normalizeCompactionTriggerRatio, normalizeCompactionTriggerTokens, resolveCompactionPolicy,
  MIN_COMPACTION_TRIGGER_TOKENS, MAX_COMPACTION_TRIGGER_TOKENS } from "@shared/compaction-policy";
import { DEFAULT_COMPACTION_ENGINE, normalizeCompactionEngine, type ContextManagementEngine } from "@shared/context-management";

/** 引擎显示名：DTO 没带 engine 时说明还没观察到具体引擎，按默认自动路径展示。 */
function describeEngine(engine: "billion-context" | "native" | undefined): string {
  if (engine === "billion-context") return "billion-context（内嵌 acp-kernel）";
  if (engine === "native") return "Pi 原生压缩";
  return "自动（内嵌 acp-kernel）";
}

export default function CompactionSettingsControl(): React.JSX.Element {
  const api = window.api?.agent;
  const activeTaskId = useAppStore(s => s.activeTaskId);
  const modelId = useAppStore(s => s.activeModelId);
  const models = useAppStore(s => s.models);
  const model = models.find(m => m.id === modelId);
  // 当前任务最近一次压缩状态由主进程推送；优先使用实时状态里的 engine（字段可选，缺失走兜底）。
  const liveStatus = useAppStore(s => (s.activeTaskId ? s.compactionByTask[s.activeTaskId] : undefined));
  const [fetchedStatus, setFetchedStatus] = useState<TaskCompactionStatusDto | undefined>(undefined);
  const [ratio, setRatio] = useState(DEFAULT_COMPACTION_TRIGGER_RATIO);
  const [engineSetting, setEngineSetting] = useState<ContextManagementEngine>(DEFAULT_COMPACTION_ENGINE);
  const [enabled, setEnabled] = useState(true);
  const [k, setK] = useState(String(DEFAULT_COMPACTION_TRIGGER_TOKENS / 1000));
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!api) { setError("桌面服务未连接。"); return; }
    let active = true;
    void api.getAppSettings().then(s => {
      if (!active) return;
      setRatio(normalizeCompactionTriggerRatio(s.compactionTriggerRatio));
      setEngineSetting(normalizeCompactionEngine(s.compactionEngine));
      const tokens = normalizeCompactionTriggerTokens(s.compactionTriggerTokens);
      setEnabled(tokens !== null); setK(String((tokens ?? DEFAULT_COMPACTION_TRIGGER_TOKENS) / 1000)); setLoaded(true);
    }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [api]);
  /** 设置页没有实时压缩事件时，主动读一次当前任务的引擎（只读现有 IPC，不新增通道）。 */
  useEffect(() => {
    if (!api || !activeTaskId) { setFetchedStatus(undefined); return; }
    let active = true;
    void api.getCompactionStatus(activeTaskId)
      .then(status => { if (active) setFetchedStatus(status); })
      .catch(() => { if (active) setFetchedStatus(undefined); });
    return () => { active = false; };
  }, [api, activeTaskId]);
  const rawTokens = Number(k) * 1000;
  // Decimal K values such as 1.001 represent whole tokens despite floating-point noise.
  const tokens = Math.abs(rawTokens - Math.round(rawTokens)) <= Number.EPSILON * Math.max(1, Math.abs(rawTokens))
    ? Math.round(rawTokens) : rawTokens;
  const valid = !enabled || (k.trim() !== "" && Number.isSafeInteger(tokens) && tokens >= MIN_COMPACTION_TRIGGER_TOKENS && tokens <= MAX_COMPACTION_TRIGGER_TOKENS);
  const policy = valid ? resolveCompactionPolicy(model?.contextWindow ?? 0, ratio, enabled ? tokens : null) : null;
  const engine = (liveStatus?.engine ? liveStatus : fetchedStatus)?.engine;
  const changed = (): void => { setDirty(true); setNotice(""); setError(""); };
  const save = async (): Promise<void> => {
    if (!api || !valid || saving || !loaded) return;
    setSaving(true); setError("");
    try {
      await api.updateAppSettings({ compactionTriggerRatio: ratio, compactionTriggerTokens: enabled ? tokens : null, compactionEngine: engineSetting });
      setDirty(false); setNotice("已保存；下一轮请求起按新设置自动整理（无需重开会话）。");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };
  return <div className="compaction-settings" aria-label="自动上下文管理设置" aria-busy={(!loaded && !error) || saving}>
    <fieldset disabled={!loaded || saving} className="compaction-settings-fields">
      <legend className="compaction-field-label">上下文管理方式</legend>
      <div className="compaction-engine-options" role="group" aria-label="上下文管理方式">
        <button type="button" className={"compaction-engine-option" + (engineSetting === "billion-context" ? " active" : "")}
          aria-label="分层摘要（billion-context）" aria-pressed={engineSetting === "billion-context"}
          onClick={() => { setEngineSetting("billion-context"); changed(); }}>
          <span className="compaction-engine-heading"><span>分层摘要</span><span className="compaction-recommended">推荐</span></span>
          <span className="compaction-engine-detail">保留原文，支持回查细节</span>
        </button>
        <button type="button" className={"compaction-engine-option" + (engineSetting === "native" ? " active" : "")}
          aria-label="按比例压缩（Pi 原生）" aria-pressed={engineSetting === "native"}
          onClick={() => { setEngineSetting("native"); changed(); }}>
          <span className="compaction-engine-heading">按比例压缩</span>
          <span className="compaction-engine-detail">使用 Pi 原生压缩策略</span>
        </button>
      </div>
      <p className="compaction-help compaction-engine-help">{engineSetting === "billion-context"
        ? "billion-context 自动分层摘要；折叠后的原文可通过 acp_retrieve 回查。"
        : "Pi 管理压缩结果，不提供按引用的原文回查。"}</p>

      <div className="compaction-thresholds">
        <div className="compaction-field-head">
          <div><label className="compaction-field-label" htmlFor="compaction-ratio">上下文窗口比例</label>
            <p className="compaction-help" id="compaction-ratio-help">当前上下文占模型窗口的比例</p></div>
          <output className="compaction-ratio-value" htmlFor="compaction-ratio">{Math.round(ratio * 100)}<span>%</span></output>
        </div>
        <div className="font-slider compaction-ratio-slider"><span>10%</span><input id="compaction-ratio" type="range" min={10} max={90} step={5}
          aria-label="上下文压缩触发比例" aria-describedby="compaction-ratio-help" value={Math.round(ratio * 100)} onChange={e => { setRatio(Number(e.target.value) / 100); changed(); }} /><span>90%</span></div>
        <div className="font-scale-ticks compaction-presets" role="group" aria-label="上下文比例预设">{[30, 50, 70, 80, 90].map(n => <button type="button" key={n}
          className={"font-scale-tick" + (Math.round(ratio * 100) === n ? " active" : "")} aria-pressed={Math.round(ratio * 100) === n}
          onClick={() => { setRatio(n / 100); changed(); }}>{n}%</button>)}</div>

        <div className="compaction-absolute-section">
          <div className="compaction-field-head">
            <div><div className="compaction-field-label">指定上下文用量</div><p className="compaction-help">与比例阈值任一先达到，即自动整理</p></div>
            <SettingsToggle on={enabled} label="启用绝对压缩阈值" disabled={!loaded || saving} onChange={value => { setEnabled(value); changed(); }} />
          </div>
          <div className="compaction-absolute-controls" data-disabled={!enabled}>
            <div className="compaction-absolute-input"><input id="compaction-absolute" type="number" min={MIN_COMPACTION_TRIGGER_TOKENS / 1000}
              max={MAX_COMPACTION_TRIGGER_TOKENS / 1000} step="any" value={k} disabled={!enabled}
              aria-label="自动压缩绝对阈值 K tokens" aria-invalid={!valid} aria-describedby={!valid ? "compaction-validation" : "compaction-token-help"}
              onChange={e => { setK(e.target.value); changed(); }} /><span>K tokens</span></div>
            <div className="font-scale-ticks compaction-presets" role="group" aria-label="上下文用量预设">{[64, 96, 128, 160, 200, 256].map(n => <button type="button" key={n} disabled={!enabled}
              className={"font-scale-tick" + (Number(k) === n ? " active" : "")} aria-pressed={Number(k) === n}
              onClick={() => { setK(String(n)); changed(); }}>{n}K</button>)}</div>
          </div>
          <p className="compaction-help" id="compaction-token-help">1K = 1000 tokens。{!enabled && "已关闭指定用量，仅按窗口比例触发。"}</p>
          {!valid && <p className="compaction-feedback compaction-feedback--error" id="compaction-validation" role="alert">请输入 1–100000K 范围内、换算后为整数的 token 数。</p>}
        </div>
      </div>
    </fieldset>

    <div className="compaction-summary" aria-label="上下文策略预览">
      <div className="compaction-summary-trigger"><span className="compaction-summary-label">{dirty ? "保存后触发线" : "实际触发线"}</span>
        <strong>{policy ? (policy.triggerTokens / 1000).toLocaleString("zh-CN", { maximumFractionDigits: 3 }) + "K" : "—"}</strong>
        <span className="compaction-help">{policy ? (policy.limitedBy === "absolute" ? "绝对阈值先达到" : "比例阈值先达到") : valid ? "选择模型后计算" : "请检查阈值"}</span></div>
      <dl className="compaction-summary-details"><div><dt>当前模型</dt><dd>{model?.name || model?.id || "未选择"}</dd></div>
        <div><dt>当前引擎</dt><dd>{describeEngine(engine ?? engineSetting)}</dd></div></dl>
    </div>
    <p className="compaction-help">按当前模型窗口计算，不是累计发送量，也不是整理后的目标大小。</p>
    {policy && policy.triggerTokens <= 20_000 && <p className="compaction-feedback compaction-feedback--warning">阈值较低。整理时默认保留最近约 20K tokens 原文；历史不足时不会强行整理，因此这不是硬性用量上限。</p>}
    {error && <p className="compaction-feedback compaction-feedback--error" role="alert">{error}</p>}
    <div className="compaction-footer">
      <p className="compaction-save-state" role="status">{notice || (!loaded ? (error ? "未能读取设置" : "正在读取设置…") : dirty ? "有未保存的更改" : "设置已同步")}</p>
      <button type="button" className="btn primary" disabled={!loaded || !dirty || !valid || saving} onClick={() => void save()}>{saving ? "保存中…" : "保存压缩设置"}</button>
    </div>
  </div>;
}
