import { workExecutionObservationSchema } from "../../../shared/bot-work-phase3";
import type Database from "better-sqlite3";
import { isCriterionResolved, isRequiredCriterion, type WorkDto, type WorkExecutionBindingDto } from "../../../shared/bot-work";
import type { WorkService } from "./WorkService";

/** A delivered once-task ends without a human acceptance ceremony. This does not
 * accept deliverables, attest criteria, or turn a native stop into goal evidence. */
export class WorkAutomaticCompletion {
  constructor(private readonly db: Database.Database, private readonly works: WorkService,
    private readonly finish: (work: WorkDto, conclusion: "succeeded" | "ended_unsuccessfully", summary: string, bindingId: string) => void,
    private readonly isAuthority: () => boolean) {
    db.exec(`CREATE TABLE IF NOT EXISTS work_automatic_completion (
      binding_id TEXT PRIMARY KEY, work_id TEXT NOT NULL, consumed_at INTEGER, recovered INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS work_automatic_completion_deliveries (binding_id TEXT PRIMARY KEY, summary TEXT NOT NULL, outcome TEXT NOT NULL DEFAULT 'completed', goal_reviewed INTEGER NOT NULL DEFAULT 0)`);
    if (!(db.prepare("PRAGMA table_info(work_automatic_completion)").all() as Array<{name:string}>).some(row => row.name === "recovered"))
      db.exec("ALTER TABLE work_automatic_completion ADD COLUMN recovered INTEGER NOT NULL DEFAULT 0");
    if (!(db.prepare("PRAGMA table_info(work_automatic_completion_deliveries)").all() as Array<{name:string}>).some(row => row.name === "outcome"))
      db.exec("ALTER TABLE work_automatic_completion_deliveries ADD COLUMN outcome TEXT NOT NULL DEFAULT 'unknown'");
    if (!(db.prepare("PRAGMA table_info(work_automatic_completion_deliveries)").all() as Array<{name:string}>).some(row => row.name === "goal_reviewed"))
      db.exec("ALTER TABLE work_automatic_completion_deliveries ADD COLUMN goal_reviewed INTEGER NOT NULL DEFAULT 0");
  }

  observe(binding: WorkExecutionBindingDto, status: string): void {
    // Enrol new terminal receipts atomically; recoverUnreviewed handles older open work.
    if (!["completed", "failed", "stopped"].includes(status) || ["completed", "failed", "stopped", "invalidated"].includes(binding.status)) return;
    this.db.prepare("INSERT OR IGNORE INTO work_automatic_completion(binding_id,work_id) VALUES (?,?)")
      .run(binding.bindingId, binding.workId);
  }

  /** Reconcile still-open work missed by an older host, never closed history.
   * Enrolment requests a model review; it neither reruns effects nor declares success. */
  recoverUnreviewed(): void {
    if (!this.isAuthority()) return;
    this.db.prepare(`INSERT OR IGNORE INTO work_automatic_completion(binding_id,work_id,recovered)
      SELECT b.binding_id,w.work_id,1 FROM works w JOIN work_execution_bindings b ON b.work_id=w.work_id
      WHERE w.lifecycle='active' AND w.mode='once' AND w.cancel_requested_at IS NULL
        AND b.bot_id=w.owner_bot_id AND b.owner_epoch=w.owner_epoch
        AND b.intent_revision=w.intent_revision AND b.input_snapshot_id=w.input_snapshot_id
        AND b.invalidated_at IS NULL AND b.status='completed'
        AND EXISTS (SELECT 1 FROM work_native_inbox n WHERE n.binding_id=b.binding_id AND n.consumed_at IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM work_execution_bindings newer WHERE newer.work_id=w.work_id
          AND newer.bot_id=w.owner_bot_id AND newer.intent_revision=w.intent_revision
          AND newer.input_snapshot_id=w.input_snapshot_id AND newer.invalidated_at IS NULL
          AND newer.admitted_at>b.admitted_at)`).run();
  }

  tracked(bindingId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM work_automatic_completion WHERE binding_id=?").get(bindingId);
  }
  pending(): string[] {
    return (this.db.prepare("SELECT binding_id FROM work_automatic_completion WHERE consumed_at IS NULL").all() as Array<{ binding_id: string }>).map(row => row.binding_id);
  }
  recordDelivery(bindingId: string, summary: string, outcome: "completed" | "partial" | "unknown" = "completed", goalReviewed = false): void {
    this.db.prepare("INSERT OR IGNORE INTO work_automatic_completion_deliveries(binding_id,summary,outcome,goal_reviewed) VALUES (?,?,?,?)").run(bindingId, summary, outcome, Number(goalReviewed));
  }
  drain(): void {
    for (const bindingId of this.pending()) {
      const row = { binding_id: bindingId };
      const delivered = this.db.prepare("SELECT summary,outcome,goal_reviewed FROM work_automatic_completion_deliveries WHERE binding_id=?").get(bindingId) as { summary: string; outcome: string; goal_reviewed: number } | undefined;
      if (!delivered) continue;
      if (!this.isAuthority()) return;
      this.works.transaction(() => {
        if (!this.isAuthority()) return;
        const outcome = this.outcome(row.binding_id);
        if (!outcome || this.works.repo.listOpenBlockers(outcome.work.workId).some(item => item.waitingForUserInput && item.kind === "operational" && !item.unknownExternalEffectRef)) return;
        // The goal review, not untouched manual-attestation rows or a past tool error,
        // determines whether the user's requested deliverable was achieved.
        // Native delivery failures still cannot be promoted to success.
        const conclusion = delivered.outcome === "completed"
          ? delivered.goal_reviewed && outcome.executionDelivered ? "succeeded" : outcome.conclusion
          : "ended_unsuccessfully";
        this.finish(outcome.work, conclusion, delivered.goal_reviewed ? delivered.summary
          : outcome.conclusion === "succeeded" ? delivered.summary : `${delivered.summary}\n${outcome.summary}`, row.binding_id);
        this.consume(row.binding_id);
        this.works.emitCurrentProjection(outcome.work.workId);
      });
    }
  }

  outcome(bindingId: string): { work: WorkDto; conclusion: "succeeded" | "ended_unsuccessfully"; summary: string; executionDelivered: boolean } | undefined {
    if (!this.db.prepare("SELECT 1 FROM work_automatic_completion WHERE binding_id=? AND consumed_at IS NULL").get(bindingId)) return;
    const binding = this.works.repo.getBinding(bindingId);
    const work = binding && this.works.getWork(binding.workId);
    if (!binding || !work) return;
    if (work.lifecycle === "closed" || binding.invalidatedAt || binding.intentRevision !== work.intentRevision
      || binding.inputSnapshotId !== work.inputSnapshotId || binding.ownerEpoch !== work.ownerEpoch) {
      this.consume(bindingId); return;
    }
    if (work.mode !== "once" || binding.botId !== work.ownerBotId) { this.consume(bindingId); return; }
    if (work.lifecycle !== "active" || !["completed", "failed", "stopped"].includes(binding.status)
      || !this.works.collaboration.isDelegationAdopted(binding, work)) return;
    const bindings = this.works.repo.listBindings(work.workId);
    if (bindings.some(item => item.botId === binding.botId && item.bindingId !== bindingId
      && item.intentRevision === work.intentRevision && item.inputSnapshotId === work.inputSnapshotId
      && item.admittedAt > binding.admittedAt && !item.invalidatedAt)) { this.consume(bindingId); return; }
    if (bindings.some(item => ["pending", "submitted", "running", "unknown"].includes(item.status))
      || this.works.repo.listAdmissions(work.workId).some(item => item.state === "admitted")
      || this.works.partialResults.plans(work.workId).some(item => ["pending", "dispatched"].includes(item.state))
      || this.db.prepare("SELECT 1 FROM work_dispatch_requests WHERE work_id=? AND state IN ('pending','blocked')").get(work.workId)) return;
    const team = this.works.teams.get(work.workId);
    const continuation = this.db.prepare("SELECT continuation_plan_id FROM work_dispatch_requests WHERE task_id=?").get(binding.taskId) as { continuation_plan_id: string | null } | undefined;
    const ownerContinuation = continuation?.continuation_plan_id && this.works.partialResults.plans(work.workId)
      .some(plan => plan.planId === continuation.continuation_plan_id && plan.ownerBotId === work.ownerBotId);
    if (team && !ownerContinuation && !team.executions.some(item => item.role === "owner_summary" && item.bindingId === bindingId)) return;
    // Finish the existing owner report delivery before making the team immutable.
    if (team && !ownerContinuation && !this.db.prepare("SELECT 1 FROM work_team_executions WHERE work_id=? AND role='owner_summary' AND reported_binding_id=? AND reported=1").get(work.workId, bindingId)) return;
    if (team?.executions.some(item => ["queued", "recovering", "pending", "submitted", "running", "unknown"].includes(item.status))) return;
    const results = this.works.repo.listDeliverables(work.workId).filter(item => item.executionId === bindingId
      && item.intentRevision === work.intentRevision && item.inputSnapshotId === work.inputSnapshotId && item.status !== "superseded");
    // The native receiver must have actually preserved a result, not just a status.
    // Missing result content becomes an explicit unsuccessful delivery, not a silent active Work.
    const blockers = this.works.repo.listOpenBlockers(work.workId);
    const native = this.db.prepare("SELECT payload_json FROM work_native_inbox WHERE binding_id=? AND consumed_at IS NOT NULL ORDER BY received_at DESC,rowid DESC LIMIT 1").get(bindingId) as { payload_json: string } | undefined;
    const observation = native && workExecutionObservationSchema.safeParse(JSON.parse(native.payload_json));
    const receivedOutput = observation?.success && observation.data.status === "completed"
      && (observation.data.summary.trim() || observation.data.artifactRefs.length);
    const missing = [
      ...binding.status === "completed" ? [] : [binding.settlementNote || `执行状态：${binding.status}`],
      ...receivedOutput ? [] : ["执行没有返回可用的结果正文或产物"],
      ...this.works.partialResults.gaps(work.workId).map(item => `${item.task}：${item.summary || item.outcome}`),
      ...work.criteria.filter(item => isRequiredCriterion(item) && !isCriterionResolved(item)).map(item => `尚未核实：${item.text}`),
      ...results.flatMap(item => [...item.uncoveredScope, ...item.hasWriteConflicts ? ["成果存在写入冲突"] : [],
        ...item.isSpeculation ? ["成果包含尚未验证的推测"] : [], ...item.status === "rejected" ? [item.rejectedReason || "成果已被拒绝"] : []]),
      ...blockers.map(item => item.reason),
      ...this.works.repo.listAdmissions(work.workId).filter(item => item.state === "unknown").map(() => "有工具效果尚未核实，未重放原动作"),
      ...(team?.executions.filter(item => !["completed", "recovered"].includes(item.status)).map(item => `${item.responsibility}：${item.error || item.notStartedReason || item.status}`) ?? []),
    ];
    const reasons = [...new Set(missing)];
    return { work, executionDelivered: Boolean(receivedOutput) && binding.status === "completed"
      && !results.some(item => item.hasWriteConflicts || item.status === "rejected"), conclusion: reasons.length ? "ended_unsuccessfully" : "succeeded",
      summary: reasons.length
        ? `本次执行已结束，已有成果已返回；仍有未完成或未核实部分：${reasons.join("；")}`
        : "本次执行已完成，成果已返回，已自动移入已结束。这是执行交付状态，不代表用户已验收或全部结论经过独立验证。" };
  }

  consume(bindingId: string): void {
    this.db.prepare("UPDATE work_automatic_completion SET consumed_at=? WHERE binding_id=?").run(Date.now(), bindingId);
  }
}
