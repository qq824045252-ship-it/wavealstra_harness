import { useState, type ReactNode } from "react";
import { IconBook, IconCheck, IconChevronRight, IconFileText, IconGitBranch } from "@/components/common/icons";
import { improvementAssetLabels, improvementOutcomeLabels, improvementPercent } from "@shared/improvement-report-format";
import type { ImprovementExcerpt, ImprovementOutcome, ImprovementVersionEvidence, ImprovementWeeklyMetrics, NativeImprovementApi, ObservationSource } from "@shared/native-improvement";

const receiptLabels: Record<string, string> = {
  opportunity: "适用", offered: "已提供", supplied: "已提供", executed: "已执行", applied: "已应用", recalled: "已召回",
  read: "已读取", passed: "检查通过", feedback: "报告缺项", accepted: "验收通过", correction: "再次纠正",
  error: "执行异常", falseTrigger: "误触发", unknown: "证据不足", missing: "发现缺项",
};
export const scopeLabels = { task: "任务", project: "项目", workspace: "工作空间" };
const dateTime = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
export function shortTime(at: number) { return dateTime.format(at); }
export function weekRange(week: string) {
  const start = new Date(week + "T00:00:00Z");
  const end = new Date(start.getTime() + 6 * 86400000);
  const format = (d: Date) => (d.getUTCMonth() + 1) + " 月 " + d.getUTCDate() + " 日";
  return format(start) + " – " + (start.getUTCMonth() === end.getUTCMonth() ? end.getUTCDate() + " 日" : format(end));
}
export function Disclosure({title, meta, children}: {title: string; meta?: ReactNode; children: ReactNode}) {
  return <details className="review-disclosure"><summary><IconChevronRight size={14}/><span>{title}</span>{meta && <small>{meta}</small>}</summary>
    <div className="review-disclosure-body">{children}</div></details>;
}
export function ReviewEmpty({children}: {children: ReactNode}) {
  return <div className="review-empty"><IconBook size={22}/><p>{children}</p></div>;
}
export function ReviewFacts({rows}: {rows: [string, ReactNode][]}) {
  return <dl className="review-facts">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}
export function SourceExcerpt({source, itemKey, api}: {source: ObservationSource; itemKey: string; api: NativeImprovementApi}) {
  const [excerpt, setExcerpt] = useState<ImprovementExcerpt[]>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true); setError("");
    try { setExcerpt(await api.source(itemKey, source.taskId, source.conversationId, source.entry)); }
    catch (cause) { setError(String(cause)); } finally { setBusy(false); }
  }
  return <div className="review-source">
    <div className="review-line"><strong>{source.actor === "main" ? "主会话" : "原生子代理"} #{source.conversationId}</strong>
      <time>{shortTime(source.at)}</time></div>
    <p className="review-meta">任务 {source.taskId}{source.parent && " · 父会话 #" + source.parent} · 输入 #{source.input} · {source.childReceipt ? "派发" : "触发"} #{source.trigger} · 观察 #{source.entry}</p>
    {!excerpt && <button className="review-link" disabled={busy} onClick={() => void load()}><IconFileText size={14}/>{busy ? "读取中…" : "查看原始摘录"}</button>}
    {error && <p role="alert">{error}</p>}
    {excerpt?.map(e => <div className="review-entry" key={e.id}><small>#{e.id} · {e.kind}</small>
      {e.content.map((m,i) => m.text && !["user","assistant","toolResult"].includes(m.role) && /^[{\[]/.test(m.text.trim())
        ? <Disclosure key={i} title={m.role}><pre className="review-raw">{m.text}</pre></Disclosure>
        : <blockquote key={i}>{m.name && <strong>{m.name} · {m.failed ? "失败" : "成功"} </strong>}{m.text}</blockquote>)}</div>)}
  </div>;
}
export function WeeklyMetrics({metrics: m}: {metrics: ImprovementWeeklyMetrics}) {
  const rate = (a: number, b: number) => a + " / " + b + "　" + improvementPercent(a,b);
  return <ReviewFacts rows={[
    ["原生输入", m.userInputs + " 条"], ["适用交付任务", m.opportunities + " 个"], ["有版本运行证据", m.exposed + " 轮"],
    ["独立验收通过且无需纠正", rate(m.unassisted,m.opportunities)], ["验收通过", m.accepted + " 个"],
    ["用户纠正", m.corrections + " 次"], ["资产实际使用", rate(m.used,m.exposed)], ["已关联复发", rate(m.recurrences,m.exposed)],
    ["执行异常 / 误触发", m.errors + " / " + (m.falseTriggers ?? "未测量")],
    ["每百条输入的纠正次数", m.userInputs ? (100 * m.corrections / m.userInputs).toFixed(1) : "未测量"],
    ["复盘耗时", (m.durationMs / 1000).toLocaleString("zh-CN",{maximumFractionDigits: 1}) + " 秒"],
    ["归因模型请求 / 改进工具执行", m.modelRequests + " / " + m.toolCalls],
  ]}/>;
}
export function OutcomeDetails({outcome: o, name}: {outcome: ImprovementOutcome; name: string}) {
  return <Disclosure title={name + " · v" + o.revision} meta={o.week + " · " + improvementOutcomeLabels[o.state]}>
    <p>适用 {o.opportunities} 轮 · 通过 {o.accepted} 轮 · 复发 {o.corrections} 轮 · 异常 {o.errors} 轮</p>
    {o.assets?.length ? <div className="review-table-wrap"><table><thead><tr>{["资产","效果","使用 / 适用","通过","复发","异常"].map(h => <th key={h}>{h}</th>)}</tr></thead>
      <tbody>{o.assets.map(a => <tr key={a.kind}><th>{improvementAssetLabels[a.kind]}</th><td>{improvementOutcomeLabels[a.state]}</td>
        <td>{a.used} / {a.opportunities}</td><td>{a.accepted}</td><td>{a.corrections}</td><td>{a.errors}</td></tr>)}</tbody></table></div> : <p>此期没有分资产的使用记录。</p>}
  </Disclosure>;
}
export function VersionDetails({version: v, name, scope, disabled, outcomes, api}: {
  version: ImprovementVersionEvidence; name: string; scope: string; disabled: boolean; outcomes: ImprovementOutcome[]; api: NativeImprovementApi;
}) {
  const state = v.active ? "启用" : v.retired ? "已撤回" : disabled ? "已停用" : "历史版本";
  return <details className="review-record" data-version={v.packageId}>
    <summary><span className="review-glyph"><IconGitBranch size={18}/></span><span className="review-record-name"><strong>{name} <small>v{v.revision}</small></strong>
      <small>{scope} · {v.week} 发布 · {v.useCount} 条回执</small></span><span className={"review-status " + (v.active ? "is-good" : "")}>{state}</span><IconChevronRight size={15}/></summary>
    <div className="review-record-body">
      {v.assets?.length ? <div className="review-asset-list">{v.assets.map(a => <span key={a.kind}>{improvementAssetLabels[a.kind]}</span>)}</div> : null}
      <Disclosure title="发布前回放" meta={v.cases.filter(c => c.passed).length + " / " + v.cases.length + " 通过"}>
        {v.cases.length ? <ul className="review-checks">{v.cases.map((c,i) => <li key={i}><span>{c.name}</span>
          <span className={c.passed ? "is-good" : "is-alert"}>{c.passed && <IconCheck size={13}/>} {c.passed ? "通过" : "未通过"}</span></li>)}</ul> : <p>未保存回放证据。</p>}
      </Disclosure>
      <Disclosure title="运行回执" meta={v.useCount + " 条"}>
        {v.uses.length ? <><div className="review-table-wrap"><table><thead><tr><th>时间</th><th>资产</th><th>结果</th><th>执行位置</th></tr></thead>
          <tbody>{v.uses.map((u,i) => <tr key={i}><td>{shortTime(u.at)}</td><td>{improvementAssetLabels[u.kind]}</td><td>{receiptLabels[u.event] ?? u.event}</td>
            <td><span>{u.actor === "main" ? "主会话" : "子代理"} #{u.conversation} · 轮次 #{u.run}</span><small>{u.task}</small></td></tr>)}</tbody></table></div>
          {v.uses.length < v.useCount && <p className="review-meta">显示最近 {v.uses.length} 条。</p>}</> : <p>尚无运行回执。</p>}
      </Disclosure>
      {v.source && <Disclosure title="原始来源"><SourceExcerpt source={v.source} itemKey={v.packageId} api={api}/></Disclosure>}
      <Disclosure title="版本信息"><ReviewFacts rows={[
        ["版本标识", <code>{v.packageId}</code>],["上一版本", v.previous == null ? "无" : "v" + v.previous],
        ...(v.scope ? [["作用范围",scopeLabels[v.scope.kind] + " " + v.scope.id] as [string,ReactNode]] : []),
        ...(v.hash ? [["内容指纹",<code>{v.hash}</code>] as [string,ReactNode]] : []),
        ...(v.assets ?? []).map(a => [improvementAssetLabels[a.kind], <code>{a.hash}</code>] as [string,ReactNode]),
      ]}/></Disclosure>
      {outcomes.length ? outcomes.map(o => <OutcomeDetails key={o.week} outcome={o} name={name}/>) : <p className="review-meta">下一期回填尚未生成。</p>}
    </div></details>;
}
