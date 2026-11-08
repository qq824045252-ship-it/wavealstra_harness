import type Database from "better-sqlite3";
import { z } from "zod";
import { isCriterionResolved, type WorkActor, type WorkControlResult, type WorkDto } from "../../../shared/bot-work";
import type { WorkSubitemDto } from "../../../shared/bot-work-phase3";
import type { CoverNotStartedParams } from "../../../shared/bot-work-review";
import type { WorkService } from "./WorkService";

const receiptSchema = z.object({ sourceFact: z.string(), operationId: z.string(), deliverableId: z.string(), criterionIds: z.array(z.string()),
  evidenceRefs: z.array(z.string()), reason: z.string(), resolvedAt: z.number(), inputSnapshotId: z.string(),
  intentRevision: z.number(), ownerEpoch: z.number(), artifactSnapshotId: z.string(), approvalVersion: z.number() });
type Coverage = z.infer<typeof receiptSchema>;
const sourceFact = (item: WorkSubitemDto) => JSON.stringify([item.factId, item.bindingId, item.itemId,
  item.nativeStatus, item.outcome, item.task, item.summary, item.required, item.dependencies, item.criterionIds,
  item.artifactRefs, item.writeConflicts, item.createdAt]);
const terminal = new Set(["completed", "failed", "stopped"]);
const failure = (message: string): Extract<WorkControlResult, { ok: false }> => ({ ok: false, code: "unmet_acceptance_criteria", message });

/** A review receipt supersedes a proven unstarted attempt, never its original fact
 * or permission decision. The receipt is revalidated against current evidence. */
export class WorkGapCoverage {
  constructor(private readonly db: Database.Database, private readonly works: WorkService) {
    db.exec(`CREATE TABLE IF NOT EXISTS work_gap_coverages (
      fact_id TEXT NOT NULL REFERENCES work_subitem_results(fact_id),
      work_id TEXT NOT NULL REFERENCES works(work_id), operation_id TEXT NOT NULL,
      receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)), created_at INTEGER NOT NULL,
      PRIMARY KEY(fact_id,operation_id)
    );`);
  }

  private approval(item: WorkSubitemDto, work: WorkDto) {
    if (item.nativeStatus !== "host_approval_not_started" || item.outcome !== "not_started"
      || item.childId || item.childConversationId || item.artifactRefs.length || item.writeConflicts.length
      || item.intentRevision !== work.intentRevision || item.inputSnapshotId !== work.inputSnapshotId) return undefined;
    const binding = this.works.repo.getBinding(item.bindingId);
    if (!binding || binding.invalidatedAt !== undefined || !terminal.has(binding.status)
      || !this.works.collaboration.isDelegationAdopted(binding, work)) return undefined;
    const value = this.works.approvals.list(work.workId).find(a => a.approvalId === item.itemId);
    if (!value || value.workId !== work.workId || value.bindingId !== item.bindingId || value.taskId !== binding.taskId
      || value.intentRevision !== item.intentRevision || value.inputSnapshotId !== item.inputSnapshotId
      || !["denied", "expired", "invalidated"].includes(value.status)
      || !["workspace:read", "workspace:write"].includes(value.requiredScope)
      || value.outcome === "continuation-outside-plan") return undefined;
    if (this.works.repo.listAdmissions(work.workId).some(a => a.operationId === value.operationId
      && ["admitted", "unknown", "consumed"].includes(a.state))) return undefined;
    // A queued or already claimed retry must be reconciled through its own identity.
    if (this.works.partialResults.plans(work.workId).some(p => p.sourceBindingId === item.bindingId
      && p.gapItemIds.includes(item.itemId) && ["pending", "dispatched"].includes(p.state))) return undefined;
    if (this.db.prepare("SELECT 1 FROM work_action_approval_claims WHERE source_gap_id=?").get(item.factId)) return undefined;
    const blocker = this.works.repo.getBlocker(item.itemId);
    if (!blocker || blocker.workId !== work.workId || blocker.kind !== "operational" || blocker.unknownExternalEffectRef
      || blocker.reasonCode || blocker.sourceRef || blocker.subscriptionId || blocker.windowId || blocker.causalChainId) return undefined;
    return value;
  }

  private evidence(work: WorkDto, item: WorkSubitemDto, deliverableId: string, criterionIds: string[]): string[] | undefined {
    const deliverable = this.works.repo.getDeliverable(deliverableId);
    const binding = deliverable && this.works.repo.getBinding(deliverable.executionId);
    if (!deliverable || !binding || deliverable.workId !== work.workId || deliverable.status !== "accepted"
      || !work.acceptedDeliverableIds.includes(deliverableId) || deliverable.isSpeculation || deliverable.hasWriteConflicts
      || deliverable.intentRevision !== work.intentRevision || deliverable.inputSnapshotId !== work.inputSnapshotId
      || binding.invalidatedAt !== undefined || !terminal.has(binding.status)
      || !this.works.collaboration.isDelegationAdopted(binding, work)) return undefined;
    const refs: string[] = [];
    for (const id of criterionIds) {
      const criterion = work.criteria.find(c => c.id === id);
      if (!criterion || criterion.status !== "satisfied" || !isCriterionResolved(criterion)
        || deliverable.uncoveredCriterionIds.includes(id)) return undefined;
      const evidence = criterion.evidenceRefs.map(ref => this.works.repo.getEvidence(ref)).filter(e => e
        && e.workId === work.workId && e.inputSnapshotId === work.inputSnapshotId && e.intentRevision === work.intentRevision
        && e.criterionIds.includes(id) && e.recordedAt >= item.createdAt);
      if (!evidence.length) return undefined;
      refs.push(...evidence.map(e => e!.evidenceId));
    }
    return criterionIds.length ? [...new Set(refs)].sort() : undefined;
  }

  project(item: WorkSubitemDto): WorkSubitemDto {
    const work = this.works.getWork(item.workId);
    const approval = work && this.approval(item, work);
    if (!work || !approval) return item;
    const raw = this.db.prepare("SELECT receipt_json FROM work_gap_coverages WHERE fact_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(item.factId);
    const row = z.object({ receipt_json: z.string() }).optional().parse(raw);
    const receipt = row && receiptSchema.parse(JSON.parse(row.receipt_json));
    const refs = receipt && this.evidence(work, item, receipt.deliverableId, receipt.criterionIds);
    const valid = receipt && refs && receipt.inputSnapshotId === work.inputSnapshotId && receipt.intentRevision === work.intentRevision
      && receipt.sourceFact === sourceFact(item) && receipt.ownerEpoch === work.ownerEpoch && receipt.approvalVersion === approval.version
      && receipt.artifactSnapshotId === this.works.artifacts.currentSnapshotId(work.workId)
      && receipt.evidenceRefs.every(ref => refs.includes(ref));
    return { ...item, coverageEligible: true, ...(valid ? { coverage: receipt } : {}) };
  }

  resolve(actor: WorkActor, params: CoverNotStartedParams): WorkControlResult {
    if (actor.kind !== "user") return { ok: false, code: "unauthorized_actor", message: "只有用户可确认替代证据覆盖未执行动作" };
    const target = this.works.getWork(params.workId);
    if (!target || target.userId !== actor.userId) return { ok: false, code: "not_found", message: "找不到事项" };
    const inspection = this.works.artifacts.capture(params.workId);
    return this.works.runCardControl(actor, "coverNotStarted", params,
      { guard: "full", ownerOnly: false, allowLifecycles: ["active", "paused"] }, (work, _resolved, now) => {
        if (!this.works.artifacts.validate(inspection, now)) return failure("产物已变化，请重新核验后确认覆盖");
        if (params.inputSnapshotId !== work.inputSnapshotId || (inspection.observed.length
          && params.artifactSnapshotId !== this.works.artifacts.snapshotId(inspection)))
          return failure("覆盖必须绑定当前输入与产物快照");
        if (this.works.repo.listAdmissions(work.workId).some(a => ["admitted", "unknown"].includes(a.state))
          || this.works.resourceGate.live().some(lease => lease.owner.workId === work.workId)
          || this.works.repo.listOpenBlockers(work.workId).some(b => b.kind === "external_effect"))
          return failure("仍有在途操作或未知效果，先核对原执行回执，不能用证据覆盖代替结算");
        const facts = this.works.partialResults.list(work.workId);
        const receipts: { item: WorkSubitemDto; value: Coverage }[] = [];
        for (const id of [...new Set(params.factIds)]) {
          const item = facts.find(fact => fact.factId === id);
          const approval = item && this.approval(item, work);
          if (!item || !approval || item.coverage) return failure("只能覆盖已核实未执行、没有待补跑或未知效果的审批缺口，请刷新核对");
          const evidenceRefs = this.evidence(work, item, params.deliverableId, params.criterionIds);
          if (!evidenceRefs) return failure("请选择当前已采纳成果与有后续证据的通过验收项；豁免、旧版本和未覆盖项不能作为替代证据");
          receipts.push({ item, value: { sourceFact: sourceFact(item), operationId: params.operationId, deliverableId: params.deliverableId,
            criterionIds: [...new Set(params.criterionIds)], evidenceRefs, reason: params.reason, resolvedAt: now,
            inputSnapshotId: work.inputSnapshotId, intentRevision: work.intentRevision, ownerEpoch: work.ownerEpoch,
            artifactSnapshotId: this.works.artifacts.currentSnapshotId(work.workId), approvalVersion: approval.version } });
        }
        // Validate the entire batch before writing any receipts or clearing blockers.
        for (const { item, value } of receipts) {
          this.db.prepare("INSERT INTO work_gap_coverages(fact_id,work_id,operation_id,receipt_json,created_at) VALUES (?,?,?,?,?)")
            .run(item.factId, work.workId, params.operationId, JSON.stringify(value), now);
          this.works.repo.clearBlocker(item.itemId, work.workId, now);
        }
        this.works.repo.updateWork({ ...work, stateVersion: work.stateVersion + 1, updatedAt: now });
        return { ok: true };
      });
  }
}
