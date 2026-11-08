import { useRef, useState } from "react";
import type { WorkProjectionDto } from "@shared/bot-work";
import type { WorkResourceRecoveryDto } from "@shared/bot-work-phase3";
import type { WorkPhase3ControlRequest, WorkPhase3ControlResult } from "@shared/bot-work-phase3-control";

/** A user attestation is evidence, never a force-unlock or a replay request. */
export function ResourceEffectReview({ work, recovery, busy, submit }: {
  work: WorkProjectionDto; recovery: WorkResourceRecoveryDto; busy: boolean;
  submit(request: WorkPhase3ControlRequest): Promise<WorkPhase3ControlResult | undefined>;
}): React.JSX.Element | null {
  const [conclusion, setConclusion] = useState<"not_occurred" | "occurred">("not_occurred");
  const [evidence, setEvidence] = useState("");
  const [stopConfirmed, setStopConfirmed] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const pending = useRef<{ signature: string; request: WorkPhase3ControlRequest } | null>(null);
  if (!recovery.actionId || recovery.exhaustedAt === undefined || recovery.pendingProbe) return null;
  const signature = JSON.stringify([work.workId, work.stateVersion, work.intentRevision, work.ownerEpoch,
    recovery.token, recovery.actionId, recovery.attempts, recovery.exhaustedAt, recovery.effectReviewPrepared?.readyAt, conclusion, evidence]);
  const ready = recovery.effectReviewPrepared?.readyAt !== undefined;
  const valid = ready && evidence.trim().length >= 10 && confirmation === signature;
  const prepare = async () => {
    if (stopConfirmed !== signature || busy) return;
    const prepareSignature = `prepare:${signature}`;
    if (pending.current?.signature !== prepareSignature) pending.current = { signature: prepareSignature, request: {
      kind: "prepare_resource_effect", request: { operationId: `desktop:${crypto.randomUUID()}`,
        workId: work.workId, token: recovery.token, actionId: recovery.actionId!, expectedAttempts: recovery.attempts,
        expectedExhaustedAt: recovery.exhaustedAt!, confirmStopOriginal: true,
        versionGuard: { expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch } },
    } };
    const response = await submit(pending.current.request);
    if (response) { pending.current = null; setStopConfirmed(null); }
  };
  const save = async () => {
    if (!valid || busy) return;
    if (pending.current?.signature !== signature) pending.current = { signature, request: {
      kind: "reconcile_resource_effect", request: {
        operationId: `desktop:${crypto.randomUUID()}`, workId: work.workId, token: recovery.token,
        actionId: recovery.actionId!, expectedAttempts: recovery.attempts, expectedExhaustedAt: recovery.exhaustedAt!,
        expectedReadyAt: recovery.effectReviewPrepared!.readyAt!, conclusion, evidence: evidence.trim(), confirmScopeReviewed: true, confirmStopOriginal: true,
        versionGuard: { expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch },
      },
    } };
    const response = await submit(pending.current.request);
    if (response) { pending.current = null; setConfirmation(null); }
  };
  return <details aria-label="核对原操作效果">
    <summary>记录已核对的原操作效果</summary>
    <p>仅结算资源 {recovery.token} 对应的这一次操作，不重做原命令，不自动完成事项。</p>
    <p>操作身份：{recovery.actionId}</p>
    {recovery.actionDescription && <pre>{recovery.actionDescription}</pre>}
    <p>原执行：{recovery.taskId} · 工作目录：{recovery.workspacePath}</p>
    <ul>{recovery.resourceScope?.map(scope => <li key={scope}>{scope}</li>)}</ul>
    {recovery.effectReview && <p>已保存核对：{recovery.effectReview.conclusion === "not_occurred" ? "未发生效果" : "已发生效果"} · {new Date(recovery.effectReview.reviewedAt).toLocaleString()}；仍需完成停止与资源安全检查。</p>}
    <p>请核对完整作用范围及文件、外部系统记录。不确定时请保留隔离，不能只凭当前工作目录推断未产生外部效果。</p>
    {!ready ? <>
      <p>第一步：先停止原执行和子任务。系统确认它们不再运行后，再核对最终效果，避免核对之后旧动作又产生写入。</p>
      <label><input aria-label="确认停止原执行以准备核对" type="checkbox" checked={stopConfirmed === signature} disabled={busy}
        onChange={event => setStopConfirmed(event.target.checked ? signature : null)} />停止这一次原执行及其子任务，保留已有结果，不重跑</label>
      <button type="button" disabled={busy || stopConfirmed !== signature} onClick={() => { void prepare(); }}>停止原执行并准备核对</button>
    </> : <>
    <p>原执行已静止。第二步：请现在核对最终文件和外部系统记录，再提交结论。</p>
    <label>核对结论<select aria-label="原操作效果核对结论" value={conclusion}
      onChange={event => { setConclusion(event.target.value as typeof conclusion); setConfirmation(null); }}>
      <option value="not_occurred">已核实未发生外部写入或其他效果</option>
      <option value="occurred">已核实发生过效果，按已发生结算</option>
    </select></label>
    <label>核对范围、结果与证据<textarea aria-label="原操作效果核对依据" value={evidence} minLength={10} maxLength={4000}
      placeholder="说明检查的路径或外部系统、实际结果和证据位置（至少 10 字）"
      onChange={event => { setEvidence(event.target.value); setConfirmation(null); }} /></label>
    <label><input aria-label="确认原操作完整范围并停止原执行" type="checkbox" checked={confirmation === signature} disabled={busy}
      onChange={event => setConfirmation(event.target.checked ? signature : null)} />我已核对该操作的完整作用范围，并同意按此最终结论结算；保留已产生的结果，不重做原动作</label>
    <button type="button" disabled={busy || !valid} onClick={() => { void save(); }}>保存效果结论并核对恢复</button>
    </>}
    <p>操作人、时间、范围和依据会留痕。系统还会确认原执行、子任务和输入清理均已停止；未确认前继续隔离。</p>
  </details>;
}
