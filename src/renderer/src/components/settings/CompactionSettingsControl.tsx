import { useEffect, useState } from "react";
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
  const tokens = Number(k) * 1000;
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
  return <div className="compaction-settings" aria-label="自动上下文管理设置">
    <p className="settings-row-desc">自动上下文管理默认生效：日常不需要手动压缩，「立即整理上下文」只是高级操作。</p>
    <div className="font-scale-head"><label>上下文管理方式</label><strong>{engineSetting === "billion-context" ? "分层摘要" : "按比例压缩"}</strong></div>
    <div className="font-scale-ticks">
      <button type="button" className={"font-scale-tick" + (engineSetting === "billion-context" ? " active" : "")}
        onClick={() => { setEngineSetting("billion-context"); changed(); }}>分层摘要（billion-context）</button>
      <button type="button" className={"font-scale-tick" + (engineSetting === "native" ? " active" : "")}
        onClick={() => { setEngineSetting("native"); changed(); }}>按比例压缩（Pi 原生）</button>
    </div>
    <p className="settings-row-desc">{engineSetting === "billion-context"
      ? "自动分层摘要并保留原文回查（推荐）；旧内容可被折叠，细节可用 acp_retrieve 读回。"
      : "只按下方阈值触发 Pi 原生压缩；不提供按引用的原文回查，压缩结果由 Pi 管理。"}</p>
    <fieldset disabled={!loaded || saving} className="compaction-settings-fields">
      <div className="font-scale-head"><label htmlFor="compaction-ratio">上下文窗口比例</label><strong>{Math.round(ratio * 100)}%</strong></div>
      <div className="font-slider"><span>10%</span><input id="compaction-ratio" type="range" min={10} max={90} step={5}
        aria-label="上下文压缩触发比例" value={Math.round(ratio * 100)} onChange={e => { setRatio(Number(e.target.value) / 100); changed(); }} /><span>90%</span></div>
      <div className="font-scale-ticks">{[30, 50, 70, 80, 90].map(n => <button type="button" key={n}
        className={"font-scale-tick" + (Math.round(ratio * 100) === n ? " active" : "")}
        onClick={() => { setRatio(n / 100); changed(); }}>{n}%</button>)}</div>
      <label className="compaction-absolute-toggle"><input type="checkbox" checked={enabled}
        aria-label="启用绝对压缩阈值" onChange={e => { setEnabled(e.target.checked); changed(); }} />或达到指定上下文用量</label>
      <div className="compaction-absolute-input"><input type="number" min={MIN_COMPACTION_TRIGGER_TOKENS / 1000}
        max={MAX_COMPACTION_TRIGGER_TOKENS / 1000} step="any" value={k} disabled={!enabled}
        aria-label="自动压缩绝对阈值 K tokens" onChange={e => { setK(e.target.value); changed(); }} /><span>K tokens</span></div>
      {enabled && <div className="font-scale-ticks">{[64, 96, 128, 160, 200, 256].map(n => <button type="button" key={n}
        className={"font-scale-tick" + (Number(k) === n ? " active" : "")} onClick={() => { setK(String(n)); changed(); }}>{n}K</button>)}</div>}
    </fieldset>
    <p className="settings-row-desc">Durable 主执行路径按此策略自动整理上下文：任一条件先达到即触发。1K = 1000 tokens；按当前模型窗口计算，不是累计发送量，也不是整理后的目标大小。</p>
    <p className="compaction-effective">当前模型：{model?.name || model?.id || "未选择"}<br />
      实际触发线：<strong>{policy ? (policy.triggerTokens / 1000).toLocaleString("zh-CN", { maximumFractionDigits: 3 }) + "K（" + (policy.limitedBy === "absolute" ? "绝对阈值" : "比例阈值") + "）" : "—"}</strong><br />
      当前引擎：<strong>{describeEngine(engine ?? engineSetting)}</strong></p>
    {policy && policy.triggerTokens <= 20_000 && <p className="settings-row-desc">阈值较低。整理时默认保留最近约 20K tokens 原文；历史不足时不会强行整理，因此这不是硬性用量上限。</p>}
    {!valid && <p role="alert">请输入 1–100000K 范围内、换算后为整数的 token 数。</p>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <button type="button" className="btn btn--primary" disabled={!loaded || !dirty || !valid || saving} onClick={() => void save()}>{saving ? "保存中…" : "保存压缩设置"}</button>
  </div>;
}