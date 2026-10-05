import { useState } from "react";
import type { ToolCall } from "@/types";
import { useAppStore } from "@/store/appStore";
import { mergeWebSearchReports } from "@/lib/mergeWebSearchReports";
import { searchReportSummary, type SearchRunStatus, type WebSearchSource } from "@shared/web-search";
import "./WebSearchCard.css";

const STATUS: Record<SearchRunStatus, string> = { queued: "等待", running: "搜索中", success: "成功", empty: "无网页结果", timeout: "超时", error: "失败", cancelled: "已取消" };
const EVIDENCE = { supported: "原文支持", contradicted: "原文反驳", unclear: "存在分歧或证据不足", "missing-evidence": "证据不足" };
function Source({ source }: { source: WebSearchSource }): React.JSX.Element {
  return <article className="web-search-source">
    <a href={/^https?:\/\//i.test(source.url) ? source.url : undefined} target="_blank" rel="noreferrer">{source.title || source.url}</a>
    <small className="web-search-url">{source.url}</small>
    <div className="web-search-badges"><span>{source.evidence === "page" ? "已读取原文" : "仅搜索摘要"}</span>{source.origins?.length ? <span>{[...new Set(source.origins.map(o => o.provider))].join(" · ")} 检索到</span> : null}{source.publishedAt && <span>{source.publishedAt}</span>}</div>
    {source.snippet && <p>{source.snippet}</p>}
    {source.duplicateOf && <small>与 <a href={source.duplicateOf} target="_blank" rel="noreferrer">此网页</a> 正文相同，仅计一份证据。</small>}
    {source.fetchError && <small className="web-search-warning">原文读取失败：{source.fetchError}</small>}
  </article>;
}
export default function WebSearchCard({ toolCall, toolCalls }: { toolCall: ToolCall; toolCalls?: ToolCall[] }): React.JSX.Element {
  const calls = toolCalls ?? [toolCall];
  const report = calls.length > 1 ? mergeWebSearchReports(calls) : toolCall.webSearch!;
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState("merged");
  const appendComposer = useAppStore(s => s.appendComposer);
  const interrupted = calls.every(call => call.status !== "running") && report.status === "running";
  const providers = [...new Set(report.runs.map(r => r.provider))];
  const successProviders = new Set(report.runs.filter(r => r.status === "success").map(r => r.provider)).size;
  return <section className="web-search-card" data-testid="web-search-card">
    <button type="button" className="web-search-heading" aria-expanded={open} onClick={() => setOpen(!open)}><strong>{interrupted ? `联网搜索 · ${calls.length} 轮 · 已中断，保留已收到结果` : searchReportSummary(report).replace("联网搜索 · ", `联网搜索 · ${calls.length} 轮 · `)}</strong><span>{open ? "收起" : "查看结果"}</span></button>
    {open && <>
    <div className="web-search-provider-status">{providers.map(provider => {
      const runs = report.runs.filter(run => run.provider === provider);
      const completed = runs.filter(run => run.status === "success" || run.status === "empty").length;
      const status = runs.some(run => run.status === "running" || run.status === "queued") ? "running" : completed === runs.length ? "success" : "error";
      return <span key={provider} className={`is-${status}`} title={runs.map(run => `${run.query}${run.error ? `：${run.error}` : ""}`).join("\n")}>{provider} · {completed}/{runs.length} 次完成{status === "running" ? " · 搜索中" : status === "error" ? " · 部分未完成" : ""}</span>;
    })}</div>
    {providers.length > 1 && successProviders < 2 && <p className="web-search-warning">{report.status === "running" && !interrupted ? "当前" : "本次"}仅 {successProviders} 家返回网页来源，尚不具备多源检索覆盖。</p>}
    {report.notice && <p className="web-search-notice">{report.notice}</p>}
      {report.queries.length > 1 && <details className="web-search-queries"><summary>搜索问题 · {report.queries.length} 个</summary><ol>{report.queries.map(query => <li key={query}>{query}</li>)}</ol></details>}
      <div className="web-search-tabs" role="tablist" aria-label="搜索结果视图">
        {[{ id: "merged", label: "合并结果" }, ...providers.map(p => ({ id: p, label: p })), { id: "evidence", label: "原文核验" }].map(t => <button key={t.id} role="tab" type="button" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>)}
      </div>
      <div className="web-search-scroll" role="tabpanel">
        {tab === "merged" && <>{report.sources.map(s => <Source key={s.canonicalUrl ?? s.url} source={s} />)}{!report.sources.length && <p>尚无网页结果。</p>}</>}
        {providers.includes(tab) && report.runs.filter(r => r.provider === tab).map((r, i) => <div key={i}><h4>{r.query}</h4><p>{STATUS[r.status]} · {r.results.length} 个网页 · {(r.durationMs / 1000).toFixed(1)} 秒</p>{r.error && <p className="web-search-warning">{r.error}</p>}{r.results.map((s, n) => <div key={`${s.url}-${n}`}><small>原始排名 {n + 1}</small><Source source={s} /></div>)}{r.answer && <details><summary>供应商原始摘要 · 未独立核验</summary><pre>{r.answer}</pre>{r.answerTruncated && <small>供应商摘要超过长度上限，展示前 12,000 字符。</small>}</details>}</div>)}
        {tab === "evidence" && <>{!report.evidence?.length && <p>尚未进行原文语义核验。多家检索到同一网页不代表多份独立证据。</p>}{report.evidence?.map((e, i) => <article className="web-search-evidence" key={i}><strong>{e.claim}</strong><div className="web-search-badges"><span>{EVIDENCE[e.status]}</span>{e.model && <span>核验模型：{e.model}</span>}</div><p>{e.rationale}</p>{e.error && <p className="web-search-warning">{e.error}</p>}{e.citations.map((c, n) => <blockquote key={n}><small>{c.stance === "support" ? "支持" : c.stance === "contradict" ? "反驳" : "背景"} · {c.kind === "page" ? "原文" : "搜索摘要"}</small><p>{c.quote}</p><a href={/^https?:\/\//i.test(c.url) ? c.url : undefined} target="_blank" rel="noreferrer">{c.url}</a></blockquote>)}</article>)}<small>结论是对所引材料的语义判断；点击来源可检查上下文、日期和适用条件。</small></>}
      </div>
      <button type="button" className="web-search-followup" onClick={() => appendComposer(`请用 source_check 进一步核验以下搜索问题中的关键结论，读取原文并保留相互矛盾的证据：\n${report.queries.join("\n")}`)}>继续核验关键结论</button>
    </>}
  </section>;
}
