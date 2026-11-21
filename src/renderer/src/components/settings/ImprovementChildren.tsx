import { useState } from "react";
import type { ChildReviewEvidence, ImprovementChild, NativeImprovementApi } from "@shared/native-improvement";
import { IconBot, IconChevronRight } from "@/components/common/icons";
import { Disclosure, ReviewEmpty, ReviewFacts, shortTime } from "./ImprovementEvidence";

const labels: Record<string,string> = { completed:"已完成", cancelled:"已取消", timedout:"超时", failed:"失败", blocked:"写入受阻", unknown:"终态缺少凭据",
  done:"已回答", queued:"排队中", placed:"已放入会话", processed:"已放入会话", settled:"已回答", unanswered:"未回答", unprocessed:"未处理" };
function ChildEvidence({child,api}: {child: ImprovementChild; api: NativeImprovementApi}) {
  const [detail,setDetail] = useState<ChildReviewEvidence>();
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  const [toolLimit,setToolLimit] = useState(20);
  async function load() {
    setBusy(true); setError("");
    try { setDetail(await api.child(child.taskId,child.conversation)); }
    catch(e) { setError(String(e)); } finally { setBusy(false); }
  }
  const tone = child.status === "completed" ? "is-good" : ["failed","timedout","blocked"].includes(child.status) ? "is-alert" : "";
  return <details className="review-record"><summary><span className="review-glyph"><IconBot size={18}/></span>
    <span className="review-record-name"><strong>{child.role}</strong><small>{shortTime(child.startedAt)} · 工具 {child.tools} 次 · 插话 {child.steers} 条</small></span>
    <span className={"review-status " + tone}>{labels[child.status]}</span><IconChevronRight size={15}/></summary><div className="review-record-body">
    <p>任务 {child.taskId} · 父会话 #{child.parent} → 子会话 #{child.conversation} · {child.model}</p>
    {child.stopRequest && <p>停止请求来自{{"child-panel":"子代理面板","task-stop":"所属任务停止","model-scope-change":"可用模型变更",deadline:"到达时限"}[child.stopRequest]}</p>}
    <button className="review-link" disabled={busy} onClick={() => void load()}>{busy ? "读取中…" : detail ? "刷新原始证据" : "查看交接与结果"}</button>
    {error && <p role="alert">{error}</p>}
    {detail && <>
      <div className="review-entry"><small>派发要求</small><blockquote>{detail.assignment}</blockquote></div>
      {detail.answer && <div className="review-entry"><small>子代理回答 #{detail.answer.entry}</small><blockquote>{detail.answer.text}</blockquote></div>}
      <p>父会话返回条目 {detail.parentReturnEntry ? "#" + detail.parentReturnEntry : "缺少可定位的回执"} · 耗时 {child.durationMs == null ? "未知" : child.durationMs + " ms"}</p>
      {detail.returnDiagnostic && <blockquote>{detail.returnDiagnostic}</blockquote>}
      <Disclosure title="派发与插话" meta={detail.submissions.length + " 次派发 · " + detail.steers.length + " 条插话"}>
        <p>父工具任务 #{child.ownerTask} {detail.parentCallId} · 父轮提交 {detail.parentSubmissions?.map(id => "#" + id).join("、") || "缺少记录"}</p>
        {detail.submissions.map(s => <p key={s.id}>派发 #{s.id} · {labels[s.status] ?? s.status}{s.entry && " · 输入 #" + s.entry}{s.answer && " · 回答 #" + s.answer} {s.reason}</p>)}
        {detail.steers.map(s => <div className="review-entry" key={s.submissionId}><small>{s.origin === "user" ? "用户" : s.origin === "parent" ? "父代理" : "来源未知"}插话 · {labels[s.status]} · 提交 #{s.submissionId}</small>
          <blockquote>{s.instruction}</blockquote><p>{s.requestId} {s.reason}{s.entryId && " · 放入会话 #" + s.entryId}{s.answerEntryId && " · 回答 #" + s.answerEntryId}</p></div>)}
      </Disclosure>
      {!!detail.tools.length && <Disclosure title="工具执行" meta={detail.tools.length + " 次"}><div className="review-table-wrap"><table><thead>
        <tr><th>工具</th><th>状态</th><th>调用记录</th></tr></thead><tbody>{detail.tools.slice(0,toolLimit).map(t => <tr key={t.task}>
          <th>{t.name ?? "未知工具"}{t.nested && "（嵌套）"}</th><td>{labels[t.status] ?? t.status}</td><td>#{t.task} · {t.callId}{t.resultEntry && " · 结果 #" + t.resultEntry}</td>
        </tr>)}</tbody></table></div>{detail.tools.length > toolLimit && <button className="review-link" onClick={() => setToolLimit(n => n + 20)}>更多工具记录</button>}</Disclosure>}
      <Disclosure title="执行诊断" meta={detail.diagnostics.requests + " 次模型请求"}><ReviewFacts rows={[
        ["输入 / 缓存读取 / 输出", [detail.diagnostics.inputTokens,detail.diagnostics.cacheReadTokens,detail.diagnostics.outputTokens].map(n => n ?? "未知").join(" / ") + " token"],
        ["交互等待", detail.diagnostics.waits + " 次，已回答 " + detail.diagnostics.answered + " 次"],
        ["已结束等待累计", detail.diagnostics.waitMs == null ? "未知" : detail.diagnostics.waitMs + " ms"],
        ["派发角色指纹", <code>{detail.roleFingerprint ?? "缺少记录"}</code>],
      ]}/>{detail.hooks.map(h => <p key={h.id + "/" + h.revision}>Hook {h.id} · v{h.revision} · 执行 {h.executions} 次</p>)}</Disclosure>
    </>}
  </div></details>;
}
export function ImprovementChildren({children: rows,api}: {children: ImprovementChild[]; api: NativeImprovementApi}) {
  const [filter,setFilter] = useState(false);
  const [limit,setLimit] = useState(20);
  const attention = rows.filter(c => ["failed","timedout","blocked"].includes(c.status) || c.unansweredSteers > 0);
  const visible = filter ? attention : rows;
  return <><div className="review-tools"><h3>交接记录</h3>{!!rows.length && <label className="review-filter">
    <input type="checkbox" checked={filter} onChange={e => {setFilter(e.target.checked);setLimit(20);}}/> 仅看需关注的交接（{attention.length}）</label>}</div>
    {visible.length ? <div className="review-list">{visible.slice(0,limit).map(c => <ChildEvidence key={c.taskId + "/" + c.conversation + "/" + c.childId} child={c} api={api}/>)}</div>
      : <ReviewEmpty>{filter ? "没有失败、受阻、超时或插话未回答的交接。" : "尚无已复盘的子代理交接。"}</ReviewEmpty>}
    {visible.length > limit && <button className="review-link" onClick={() => setLimit(limit + 20)}>查看更多交接</button>}
  </>;
}
