import { useState, type ReactNode } from "react";
import type { WebSearchPolicy, SearchMode } from "@shared/web-search";
import { WEB_SEARCH_PROVIDER_OPTIONS } from "@shared/agent-ipc";
import "./SearchSettings.css";

export const searchProviderLabel = (id: string): string => WEB_SEARCH_PROVIDER_OPTIONS.find((option) => option.id === id)?.label ?? id;

type Props = {
  value: WebSearchPolicy;
  saved: WebSearchPolicy;
  savedEnabled: boolean;
  configured: string[];
  savedConfigured: string[];
  linked: string[];
  disabled?: boolean;
  onChange: (value: WebSearchPolicy) => void;
  renderProviderConfig: (id: string) => ReactNode;
  advanced: ReactNode;
};

export default function SearchSettings({ value, saved, savedEnabled, configured, savedConfigured, linked, disabled, onChange, renderProviderConfig, advanced }: Props): React.JSX.Element {
  const [showAll, setShowAll] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const providers = value.mode === "fallback" ? [...WEB_SEARCH_PROVIDER_OPTIONS].sort((a, b) => {
    const rank = (id: string): number => value.providers.includes(id) ? value.providers.indexOf(id) : Infinity;
    const left = rank(a.id), right = rank(b.id);
    return left === right ? 0 : left < right ? -1 : 1;
  }) : WEB_SEARCH_PROVIDER_OPTIONS;
  const visible = new Set([...configured, ...savedConfigured, ...linked, ...value.providers, ...saved.providers, editing]);
  const hiddenCount = providers.filter(provider => !visible.has(provider.id)).length;
  const full = value.mode !== "single" && value.providers.length >= 6;
  const setMode = (mode: SearchMode): void => {
    const candidates = [...new Set([...value.providers, ...configured])];
    onChange({ ...value, mode, providers: mode === "single" ? candidates.slice(0, 1) : mode === "parallel" && value.providers.length < 2 ? candidates.slice(0, 2) : value.providers });
  };
  const toggle = (id: string): void => {
    const selected = value.providers.includes(id);
    onChange({ ...value, providers: value.mode === "single" ? [id] : selected ? value.providers.filter(p => p !== id) : [...value.providers, id] });
  };
  const count = value.mode === "parallel" ? `已选 ${value.providers.length} / 6 · 至少 2 家` : value.mode === "single" ? "只选 1 家" : value.mode === "auto" ? "自动从可用供应商中选择" : `已选 ${value.providers.length} 家`;
  return <fieldset className="search-settings" disabled={disabled}>
    <div className="search-settings-row">
      <label className="search-settings-label" htmlFor="web-search-mode">搜索方式</label>
      <select id="web-search-mode" aria-label="搜索方式" className="search-settings-select" value={value.mode} onChange={e => setMode(e.target.value as SearchMode)}>
        <option value="auto">自动选择单个可用源</option><option value="single">指定单源</option><option value="fallback">按顺序失败回退</option><option value="parallel">多源同时搜索</option>
      </select>
    </div>
    <div className="search-provider-block">
      <div className="search-provider-head"><strong className="search-settings-label">搜索供应商</strong><span className="search-provider-count">{count}</span></div>
      <div className="search-provider-grid" aria-label="搜索供应商">
        {providers.filter(p => showAll || visible.has(p.id)).map(p => {
          const selected = value.mode !== "auto" && value.providers.includes(p.id);
          const savedSelected = saved.mode !== "auto" && saved.providers.includes(p.id);
          const ready = configured.includes(p.id);
          const savedReady = savedConfigured.includes(p.id);
          const isEditing = editing === p.id;
          const order = value.providers.indexOf(p.id);
          return <div key={p.id} className={`search-provider-row${selected ? " selected" : ""}`} data-search-provider={p.id}>
            <div className="search-provider-line">
              <label title={p.label}>
                {value.mode !== "auto" && <input type={value.mode === "single" ? "radio" : "checkbox"} name="search-provider" value={p.id} checked={selected} disabled={!selected && full} onChange={() => toggle(p.id)} />}
                <span className="search-provider-name">{p.label}</span>
              </label>
              <span className={`search-provider-state${ready && savedReady ? " is-ready" : ""}`}>{ready ? savedReady ? "已配置" : "配置待保存" : savedReady ? "配置变更待保存" : "未配置"}</span>
              {savedEnabled && savedSelected && <span className="search-provider-state is-ready">已启用</span>}
              {selected !== savedSelected && <span className="search-provider-state">{selected ? "启用待保存" : "停用待保存"}</span>}
              {value.mode === "fallback" && selected && <button className="search-provider-action" type="button" disabled={order === 0} aria-label={`上移 ${p.label}`} onClick={() => {
                const next = [...value.providers];
                [next[order - 1], next[order]] = [next[order], next[order - 1]];
                onChange({ ...value, providers: next });
              }}>{order + 1} ↑</button>}
              <button type="button" className="search-provider-action" aria-expanded={isEditing} aria-label={`配置 ${p.label}`} onClick={() => setEditing(isEditing ? null : p.id)}>{isEditing ? "收起" : "配置"}</button>
            </div>
            {isEditing && <div className="search-provider-editor">{renderProviderConfig(p.id)}</div>}
          </div>;
        })}
      </div>
      {!configured.length && !savedConfigured.length && !linked.length && !value.providers.length && !saved.providers.length && !editing ? <p>暂无已配置的搜索供应商。</p> : null}
      <small>配置状态不代表连通性。保存后，以实际搜索结果为准。</small>
      {(hiddenCount > 0 || showAll) && <button type="button" className="search-providers-toggle" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>{showAll ? "收起未配置的供应商" : "＋ 添加供应商"}</button>}
    </div>
    <details className="search-limits-details"><summary>高级设置 · 网页读取、原文核验与请求限制</summary>
      <div className="search-advanced">{advanced}
        <label className="search-verify">
          <input type="checkbox" checked={value.verifySources} onChange={e => onChange({ ...value, verifySources: e.target.checked })} />允许按需读取原文并核验<small>最多 5 页，会增加等待时间和模型用量</small>
        </label>
        <div className="search-limits">
          <label>单家超时（秒）<input aria-label="单家超时" type="number" min={1} max={120} value={value.providerTimeoutMs / 1000} onChange={e => onChange({ ...value, providerTimeoutMs: Number(e.target.value) * 1000 })} /></label>
          <label>搜索总等待（秒）<input aria-label="搜索总等待" type="number" min={1} max={180} value={value.totalTimeoutMs / 1000} onChange={e => onChange({ ...value, totalTimeoutMs: Number(e.target.value) * 1000 })} /></label>
          <label>每次工具最多请求<input aria-label="最多搜索请求" type="number" min={1} max={24} value={value.maxRequests} onChange={e => onChange({ ...value, maxRequests: Number(e.target.value) })} /></label>
        </div>
      </div>
    </details>
  </fieldset>;
}
