import { useEffect, useRef, useState } from "react";
import type { WorkProjectionDto } from "@shared/bot-work";
import type { WorkReviewControlRequest } from "@shared/bot-work-review";

type CoverageRequest = Extract<WorkReviewControlRequest, { kind: "cover_not_started" }>["request"];
export type GapCoverageInput = Omit<CoverageRequest, "operationId" | "workId" | "versionGuard">;
const short = (value: string) => value.length > 110 ? `${value.slice(0, 110)}…` : value;

/** Covers obsolete attempts with reviewed evidence, not a permission to run them.
 * Eligibility is host-projected and rechecked atomically by the backend. */
export function WorkGapCoveragePanel({ work, disabled, locked, onEdit, onSubmit }: {
  work: WorkProjectionDto; disabled: boolean; locked: boolean;
  onEdit: (change: () => void) => void; onSubmit: (body: GapCoverageInput) => void;
}): React.JSX.Element | null {
  const [factIds, setFactIds] = useState<string[]>([]);
  const [deliverableId, setDeliverableId] = useState("");
  const [criterionIds, setCriterionIds] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [confirmNotice, setConfirmNotice] = useState("");
  // 只在"确实被重置"时提示；首次挂载或本来就未确认时不刷屏。
  const confirmedRef = useRef(false);
  const updateConfirmed = (value: boolean) => { confirmedRef.current = value; setConfirmed(value); };
  const snapshot = JSON.stringify([work.workId, work.stateVersion, work.intentRevision,
    work.ownerEpoch, work.inputSnapshotId, work.phase3?.artifactSnapshotId]);
  useEffect(() => {
    if (!confirmedRef.current) return;
    updateConfirmed(false);
    setConfirmNotice("事项已更新，填写内容已保留，请重新核对并勾选确认后再提交");
  }, [snapshot]);
  const gaps = work.phase3?.gaps ?? [];
  const covered = work.phase3?.subitems.filter(item => item.coverage) ?? [];
  if (!gaps.length && !covered.length) return null;
  const eligible = gaps.filter(item => item.coverageEligible);
  const accepted = work.deliverables.filter(item => item.status === "accepted"
    && work.acceptedDeliverableIds.includes(item.deliverableId)
    && item.intentRevision === work.intentRevision && item.inputSnapshotId === work.inputSnapshotId
    && !item.isSpeculation && !item.hasWriteConflicts);
  const verified = work.criteria.filter(item => item.status === "satisfied" && item.evidenceRefs.length > 0
    && item.verifiedIntentRevision === item.requiredIntentRevision);
  const validSelection = factIds.length > 0 && factIds.every(id => eligible.some(item => item.factId === id))
    && accepted.some(item => item.deliverableId === deliverableId)
    && criterionIds.length > 0 && criterionIds.every(id => verified.some(item => item.id === id));
  const edit = (change: () => void) => onEdit(() => {
    change();
    // 已勾选后再次修改任何字段：确认失效（不静默），并告诉用户原因。
    if (confirmed) { updateConfirmed(false); setConfirmNotice("内容已变更，确认已失效，请重新勾选后再提交"); }
  });
  // 提交按钮 disabled 时必须说明还差什么，而不是只变灰。
  const missing = [
    !factIds.length && "选择要覆盖的未执行缺口",
    !accepted.some(item => item.deliverableId === deliverableId) && "选择覆盖这些动作的已采纳成果",
    !criterionIds.length && "选择作为证据的已通过验收项",
    !reason.trim() && "填写覆盖依据",
    !confirmed && "勾选确认所选动作不再需要执行",
  ].filter((item): item is string => Boolean(item));
  return <section aria-label="必要子项缺口">
    {!!gaps.length && <>
      <h4>按完成关闭前仍需处理的必要子项（{gaps.length}）</h4>
      <ul>{gaps.map(item => <li key={item.factId}><details>
        <summary>{short(item.task || item.itemId)}（{item.outcome}）</summary>
        <p>{item.task || item.itemId}</p><p>{item.summary || "缺少完成凭据"}</p>
        <p>执行：{item.bindingId}</p>
        {item.coverageEligible ? <label><input type="checkbox" aria-label={`覆盖未执行缺口 ${item.factId}`}
          checked={factIds.includes(item.factId)} disabled={locked}
          onChange={event => edit(() => setFactIds(event.target.checked
            ? [...factIds, item.factId] : factIds.filter(id => id !== item.factId)))} />选择此未执行动作，由后续成果证据覆盖</label>
          : <p>此项不能使用未执行动作覆盖入口，请核对原执行回执或使用对应处理入口。</p>}
      </details></li>)}</ul>
      <p>只对宿主确认从未执行、现已被替代的审批动作记录覆盖。未知效果、在途动作和其他必要缺口不会因此解除。</p>
    </>}
    {!!eligible.length && <details aria-label="覆盖已被替代的未执行动作">
      <summary>用已采纳成果覆盖所选未执行动作（已选 {factIds.length} 项）</summary>
      <label>当前已采纳成果<select aria-label="缺口覆盖成果" value={deliverableId} disabled={locked}
        onChange={event => edit(() => setDeliverableId(event.target.value))}>
        <option value="">请选择实际覆盖这些动作的成果</option>
        {accepted.map(item => <option key={item.deliverableId} value={item.deliverableId}>{short(item.summary)}（{item.deliverableId}）</option>)}
      </select></label>
      {!accepted.length && <p>请先采纳当前输入版本的有效成果。</p>}
      <fieldset disabled={locked}><legend>选择已有证据且已通过的验收项</legend>
        {verified.map(item => <label key={item.id}><input type="checkbox" aria-label={`缺口覆盖验收 ${item.id}`}
          checked={criterionIds.includes(item.id)} onChange={event => edit(() => setCriterionIds(event.target.checked
            ? [...criterionIds, item.id] : criterionIds.filter(id => id !== item.id)))} />{item.text}</label>)}
      </fieldset>
      {!verified.length && <p>请先记录当前要求和产物的实测或验收证据。</p>}
      <label>覆盖依据<textarea aria-label="缺口覆盖依据" value={reason} maxLength={2000} disabled={locked}
        onChange={event => edit(() => setReason(event.target.value))} /></label>
      <label><input type="checkbox" aria-label="确认未执行动作已覆盖" checked={confirmed} disabled={locked}
        onChange={event => onEdit(() => { updateConfirmed(event.target.checked); if (event.target.checked) setConfirmNotice(""); })} />
        我已核对所选动作不再需要执行，选定成果和验收证据已覆盖其目标；不授权补跑，也不豁免其他缺口</label>
      {confirmNotice && <p role="status">{confirmNotice}</p>}
      {!locked && !!missing.length && <p role="status">还不能提交：请{missing.join("、")}。</p>}
      <button type="button" disabled={disabled || !validSelection || !reason.trim() || !confirmed}
        onClick={() => {
          updateConfirmed(false);
          onSubmit({ factIds, deliverableId, criterionIds, reason: reason.trim(), confirmed: true,
            inputSnapshotId: work.inputSnapshotId, artifactSnapshotId: work.phase3?.artifactSnapshotId });
        }}>记录已由后续证据覆盖</button>
    </details>}
    {!!covered.length && <details aria-label="未执行动作覆盖记录"><summary>已覆盖的未执行动作（{covered.length}）</summary>
      <ul>{covered.map(item => <li key={item.factId}>
        <details><summary>{short(item.task || item.itemId)}</summary><p>{item.coverage!.reason}</p>
          <p>成果：{item.coverage!.deliverableId}；验收项：{item.coverage!.criterionIds.join("、")}</p>
          <p>证据：{item.coverage!.evidenceRefs.join("、")}；操作：{item.coverage!.operationId}</p>
        </details>
      </li>)}</ul>
      <p>原始拒绝记录保留；覆盖不表示原动作曾执行成功。</p>
    </details>}
  </section>;
}
