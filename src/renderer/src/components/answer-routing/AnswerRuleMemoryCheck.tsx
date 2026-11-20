import { useState } from "react";
import type { AnswerRuleMemoryMatch, AnswerRuleMemoryReview, AnswerRuleReviewInput, AnswerRoutingApi } from "@shared/answer-routing";

const labels = { exact: "文字相同", equivalent: "含义相同", extends: "规则包含这条记忆", overlap: "部分重合", conflict: "可能冲突" };

export default function AnswerRuleMemoryCheck({ draft, api, onUse, onDistill }: {
  draft: AnswerRuleReviewInput;
  api: AnswerRoutingApi;
  onUse: (memory: AnswerRuleMemoryMatch) => void;
  onDistill: (proposal: Pick<AnswerRuleReviewInput, "instruction" | "include" | "exclude">) => void;
}) {
  const [review, setReview] = useState<AnswerRuleMemoryReview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [instruction, setInstruction] = useState("");
  async function check() {
    setBusy(true);
    setError("");
    setReview(undefined);
    try {
      const result = await api.reviewMemory(draft);
      setReview(result);
      setInstruction(result.distillation?.instruction ?? "");
    }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  const proposal = review?.distillation;
  const conflicts = proposal?.conflicts ?? review?.matches.filter(match => match.relation === "conflict").map(match => match.reason) ?? [];
  return <section className="answer-rule-memory-check" aria-label="AI 去重并提炼">
    <div className="answer-routing-actions">
      <button type="button" className="btn" disabled={busy || !draft.instruction.trim()} onClick={() => void check()}>
        {busy ? "正在比对并提炼…" : review ? "重新提炼" : "AI 去重并提炼"}
      </button>
    </div>
    {error && <p role="alert" className="answer-routing-error">{error}</p>}
    {review?.semanticUnavailable && <p role="status">AI 提炼未完成，已保留可核对的比对结果。</p>}
    {proposal && <div className="answer-rule-distillation">
      <label>提炼后的回答做法<textarea value={instruction} maxLength={2000} rows={5} onChange={e => setInstruction(e.target.value)} /></label>
      <small>匹配问法　{proposal.include.join("、") || "沿用当前问法"}</small>
      {!!proposal.exclude.length && <small>跳过问法　{proposal.exclude.join("、")}</small>}
      <small>{proposal.sources.length ? `采用的记忆　${proposal.sources.map(s => s.title).join("、")}` : "本稿依据当前规则提炼。"}</small>
    </div>}
    {!!conflicts.length && <div><strong>需要你决定的分歧</strong><ul>{conflicts.map(text => <li key={text}>{text}</li>)}</ul></div>}
    {proposal && <div className="answer-routing-actions"><button type="button" className="btn primary" disabled={!instruction.trim()}
      onClick={() => onDistill({instruction: instruction.trim(), include: proposal.include, exclude: proposal.exclude})}>采用为独立草稿</button>
      <small>保存规则后生效，原记忆保留。</small></div>}
    {!!review?.matches.length && <details><summary>查看比对依据（{review.matches.length}）</summary>
    {review.matches.map(match => <article className="answer-rule-memory-match" key={match.memoryId}>
      <h4>{labels[match.relation]} · {match.title}</h4>
      <p>{match.reason}</p>
      <blockquote>{match.content}{match.truncated && "…（节选）"}</blockquote>
      {match.relation === "extends" && <><strong>规则中另外保留</strong><p>{match.additionalInstruction}</p></>}
      {match.relation === "extends" ? <button type="button" className="btn" onClick={() => onUse(match)}>引用记忆并保留额外做法</button>
        : !match.truncated && (match.relation === "exact" || match.relation === "equivalent")
        ? <button type="button" className="btn" onClick={() => onUse(match)}>采用这条记忆的原文并关联</button>
        : null}
    </article>)}
    {review?.matches.some(match => ["exact", "equivalent", "extends"].includes(match.relation)) &&
      <small>引用后随草稿保存。关闭记忆会暂停关联规则，修改来源后需复核，删除来源会一并移除规则。</small>}</details>}
  </section>;
}
