import { useState } from "react";
import type { WebSearchPolicy, SearchMode } from "@shared/web-search";
import { WEB_SEARCH_PROVIDER_OPTIONS } from "@shared/agent-ipc";
import "./SearchSettings.css";

export const searchProviderLabel = (id: string): string => WEB_SEARCH_PROVIDER_OPTIONS.find((option) => option.id === id)?.label ?? id;

export default function SearchSettings({ value, configured, disabled, onChange }: { value: WebSearchPolicy; configured: string[]; disabled?: boolean; onChange: (value: WebSearchPolicy) => void }): React.JSX.Element {
  // Configured (or already selected) providers come first; the rest stay one click away.
  const [showAll, setShowAll] = useState(false);
  const providers = [...WEB_SEARCH_PROVIDER_OPTIONS].sort((a, b) => Number(configured.includes(b.id)) - Number(configured.includes(a.id)));
  const visible = providers.filter((provider) => configured.includes(provider.id) || value.providers.includes(provider.id));
  const hidden = providers.filter((provider) => !visible.includes(provider));
  const shown = showAll ? providers : visible;
  const full = value.mode !== "single" && value.providers.length >= 6;
  const setMode = (mode: SearchMode): void => {
    const candidates = [...new Set([...value.providers, ...configured])];
    onChange({ ...value, mode, providers: mode === "single" ? candidates.slice(0, 1) : mode === "parallel" && value.providers.length < 2 ? candidates.slice(0, 2) : value.providers });
  };
  const toggle = (id: string): void => {
    const selected = value.providers.includes(id);
    onChange({ ...value, providers: value.mode === "single" ? [id] : selected ? value.providers.filter(p => p !== id) : [...value.providers, id] });
  };
  const count = value.mode === "parallel" ? `已选 ${value.providers.length} / 6 · 至少 2 家` : value.mode === "single" ? "只选 1 家" : `已选 ${value.providers.length} 家`;
  return <fieldset className="search-settings" disabled={disabled}>
    <div className="search-settings-row">
      <span className="search-settings-label">搜索方式</span>
      <select className="search-settings-select" aria-label="搜索方式" value={value.mode} onChange={e => setMode(e.target.value as SearchMode)}>
        <option value="auto">自动选择单个可用源</option><option value="single">指定单源</option><option value="fallback">按顺序失败回退</option><option value="parallel">多源同时搜索</option>
      </select>
    </div>
    {value.mode !== "auto" && <div className="search-provider-block">
      <div className="search-provider-head"><span className="search-settings-label">供应商</span><span className="search-provider-count">{count}</span></div>
      <div className="search-provider-grid" aria-label="参与搜索的供应商">
        {shown.map(p => {
          const selected = value.providers.includes(p.id);
          const configuredNow = configured.includes(p.id);
          return <label key={p.id} className={selected ? "selected" : ""} title={p.label}>
            <input type={value.mode === "single" ? "radio" : "checkbox"} name="search-provider" value={p.id} checked={selected} disabled={!selected && full} onChange={() => toggle(p.id)} />
            <span className="search-provider-name">{p.label}</span>
            <span className={`search-provider-state${configuredNow ? " is-ready" : ""}`}>{configuredNow ? "已配置" : "未配置"}</span>
          </label>;
        })}
      </div>
      {hidden.length > 0 && <button type="button" className="search-providers-toggle" onClick={() => setShowAll(!showAll)}>{showAll ? "收起未配置的供应商" : `显示未配置的 ${hidden.length} 家供应商`}</button>}
      {value.mode === "fallback" && <ol className="search-order">{value.providers.map((p, i) => <li key={p} title={searchProviderLabel(p)}><span>{searchProviderLabel(p)}</span><button type="button" disabled={i === 0} aria-label={`上移 ${p}`} onClick={() => { const providers = [...value.providers]; [providers[i - 1], providers[i]] = [providers[i], providers[i - 1]]; onChange({ ...value, providers }); }}>↑</button></li>)}</ol>}
    </div>}
    <label className="search-verify" title="最多读取 5 个网页；引用原文、保留分歧，会增加等待时间和模型用量。">
      <input type="checkbox" checked={value.verifySources} onChange={e => onChange({ ...value, verifySources: e.target.checked })} />允许按需读取原文并核验<small>普通搜索直接返回摘要；深度核验最多 5 页，更慢更贵</small>
    </label>
    <details className="search-limits-details"><summary>等待与调用上限</summary><div className="search-limits">
      <label>单家超时（秒）<input aria-label="单家超时" type="number" min={1} max={120} value={value.providerTimeoutMs / 1000} onChange={e => onChange({ ...value, providerTimeoutMs: Number(e.target.value) * 1000 })} /></label>
      <label>搜索总等待（秒）<input aria-label="搜索总等待" type="number" min={1} max={180} value={value.totalTimeoutMs / 1000} onChange={e => onChange({ ...value, totalTimeoutMs: Number(e.target.value) * 1000 })} /></label>
      <label>每次工具最多请求<input aria-label="最多搜索请求" type="number" min={1} max={24} value={value.maxRequests} onChange={e => onChange({ ...value, maxRequests: Number(e.target.value) })} /></label>
    </div><p className="search-settings-hint">请求数 = 查询数 × 供应商数；原文核验另有等待上限。</p></details>
  </fieldset>;
}
