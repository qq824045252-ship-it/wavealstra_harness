import { useEffect, useState } from "react";
import { useAppStore } from "@/store/appStore";
import { DEFAULT_COMPACTION_TRIGGER_RATIO, DEFAULT_COMPACTION_TRIGGER_TOKENS,
  normalizeCompactionTriggerRatio, normalizeCompactionTriggerTokens, resolveCompactionPolicy,
  MIN_COMPACTION_TRIGGER_TOKENS, MAX_COMPACTION_TRIGGER_TOKENS } from "@shared/compaction-policy";

export default function CompactionSettingsControl(): React.JSX.Element {
  const api = window.api?.agent;
  const modelId = useAppStore(s => s.activeModelId);
  const models = useAppStore(s => s.models);
  const model = models.find(m => m.id === modelId);
  const [ratio, setRatio] = useState(DEFAULT_COMPACTION_TRIGGER_RATIO);
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
      const tokens = normalizeCompactionTriggerTokens(s.compactionTriggerTokens);
      setEnabled(tokens !== null); setK(String((tokens ?? DEFAULT_COMPACTION_TRIGGER_TOKENS) / 1000)); setLoaded(true);
    }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [api]);
  const tokens = Number(k) * 1000;
  const valid = !enabled || (k.trim() !== "" && Number.isSafeInteger(tokens) && tokens >= MIN_COMPACTION_TRIGGER_TOKENS && tokens <= MAX_COMPACTION_TRIGGER_TOKENS);
  const policy = valid ? resolveCompactionPolicy(model?.contextWindow ?? 0, ratio, enabled ? tokens : null) : null;
  const changed = (): void => { setDirty(true); setNotice(""); setError(""); };
  const save = async (): Promise<void> => {
    if (!api || !valid || saving || !loaded) return;
    setSaving(true); setError("");
    try {
      await api.updateAppSettings({ compactionTriggerRatio: ratio, compactionTriggerTokens: enabled ? tokens : null });
      setDirty(false); setNotice("已保存；Pi 在下一个安全检查点按最先达到的阈值自动压缩。");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };
  return <div className="compaction-settings" aria-label="自动压缩设置">
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
    <p className="settings-row-desc">任一条件先达到即触发。1K = 1000 tokens；按当前模型上下文计算，不是累计发送量，也不是压缩后的目标大小。</p>
    <p className="compaction-effective">当前模型：{model?.name || model?.id || "未选择"}<br />
      实际触发线：<strong>{policy ? (policy.triggerTokens / 1000).toLocaleString("zh-CN", { maximumFractionDigits: 3 }) + "K（" + (policy.limitedBy === "absolute" ? "绝对阈值" : "比例阈值") + "）" : "—"}</strong></p>
    {policy && policy.triggerTokens <= 20_000 && <p className="settings-row-desc">阈值较低。Pi 默认保留最近约 20K 消息；历史不足时不会强行压缩，因此这不是硬性用量上限。</p>}
    {!valid && <p role="alert">请输入 1–100000K 范围内、换算后为整数的 token 数。</p>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <button type="button" className="btn btn--primary" disabled={!loaded || !dirty || !valid || saving} onClick={() => void save()}>{saving ? "保存中…" : "保存压缩设置"}</button>
  </div>;
}
