import type { WebSearchPolicy, SearchMode } from "@shared/web-search";
import { WEB_SEARCH_PROVIDER_OPTIONS } from "@shared/agent-ipc";
import "./SearchSettings.css";

export default function SearchSettings({ value, configured, disabled, onChange }: { value: WebSearchPolicy; configured: string[]; disabled?: boolean; onChange: (value: WebSearchPolicy) => void }): React.JSX.Element {
  const providers = [...WEB_SEARCH_PROVIDER_OPTIONS].sort((a, b) => Number(configured.includes(b.id)) - Number(configured.includes(a.id)));
  const setMode = (mode: SearchMode): void => {
    const candidates = [...new Set([...value.providers, ...configured])];
    onChange({ ...value, mode, providers: mode === "single" ? candidates.slice(0, 1) : mode === "parallel" && value.providers.length < 2 ? candidates.slice(0, 2) : value.providers });
  };
  const toggle = (id: string): void => {
    const selected = value.providers.includes(id);
    onChange({ ...value, providers: value.mode === "single" ? [id] : selected ? value.providers.filter(p => p !== id) : [...value.providers, id] });
  };
  return <fieldset className="search-settings" disabled={disabled}>
    <label>搜索方式<select aria-label="搜索方式" value={value.mode} onChange={e => setMode(e.target.value as SearchMode)}>
      <option value="auto">自动选择单个可用源</option><option value="single">指定单源</option><option value="fallback">按顺序失败回退</option><option value="parallel">多源同时搜索</option>
    </select></label>
    {value.mode !== "auto" && <>
      <div className="search-provider-grid" aria-label="参与搜索的供应商">
        {providers.map(p => <label key={p.id} className={value.providers.includes(p.id) ? "selected" : ""}>
          <input type={value.mode === "single" ? "radio" : "checkbox"} name="search-provider" value={p.id} checked={value.providers.includes(p.id)} disabled={!value.providers.includes(p.id) && value.providers.length >= 6 && value.mode !== "single"} onChange={() => toggle(p.id)} />
          <span>{p.label}<small>{configured.includes(p.id) ? "已配置 · 待实际调用" : "未检测到配置"}</small></span>
        </label>)}
      </div>
      <p>{value.mode === "parallel" ? `每次同时请求已选 ${value.providers.length} 家；至少选择 2 家，最多 6 家。` : value.mode === "fallback" ? "一家成功后即返回；此模式不会同时搜索。" : "每次只请求所选供应商。"}</p>
      {value.mode === "fallback" && <ol className="search-order">{value.providers.map((p, i) => <li key={p}>{p}<button type="button" disabled={i === 0} aria-label={`上移 ${p}`} onClick={() => { const providers = [...value.providers]; [providers[i - 1], providers[i]] = [providers[i], providers[i - 1]]; onChange({ ...value, providers }); }}>↑</button></li>)}</ol>}
    </>}
    <label className="search-verify"><input type="checkbox" checked={value.verifySources} onChange={e => onChange({ ...value, verifySources: e.target.checked })} />读取关键原文并核验结论<small>最多读取 5 个网页；引用原文、保留分歧，会增加等待时间和模型用量。</small></label>
    <details><summary>等待与调用上限</summary><div className="search-limits">
      <label>单家超时（秒）<input aria-label="单家超时" type="number" min={1} max={120} value={value.providerTimeoutMs / 1000} onChange={e => onChange({ ...value, providerTimeoutMs: Number(e.target.value) * 1000 })} /></label>
      <label>搜索总等待（秒）<input aria-label="搜索总等待" type="number" min={1} max={180} value={value.totalTimeoutMs / 1000} onChange={e => onChange({ ...value, totalTimeoutMs: Number(e.target.value) * 1000 })} /></label>
      <label>每次工具最多请求<input aria-label="最多搜索请求" type="number" min={1} max={24} value={value.maxRequests} onChange={e => onChange({ ...value, maxRequests: Number(e.target.value) })} /></label>
    </div><p>请求数按“查询数 × 供应商数”计算；原文读取和核验另有等待上限。</p></details>
  </fieldset>;
}
