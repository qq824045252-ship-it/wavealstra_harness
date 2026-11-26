import { isReadOnlyScheduledFollowUp } from "./WorkScheduledFollowUp";
import { continuationProgress } from "./WorkContinuationProgress";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { WorkDto, WorkExecutionBindingDto } from "../../../shared/bot-work";
import { enqueueWorkOp, overlayFindAll, overlayMutate, overlayReadOne, overlaySet, requiresWorkRustWrites, workDomainInTx } from "./WorkDomainRuntime";
import type { WorkService } from "./WorkService";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
interface Recovery { source_binding_id: string; plan_id: string; fingerprint: string; mode: "recover" | "readback" | "exhausted" }
export function ensureAutomaticRecoveryTables(db: Database.Database): void {
  if (db.readonly) return;
  db.exec(`CREATE TABLE IF NOT EXISTS work_automatic_recovery (
    source_binding_id TEXT PRIMARY KEY REFERENCES work_execution_bindings(binding_id),
    plan_id TEXT NOT NULL, fingerprint TEXT NOT NULL, mode TEXT NOT NULL,
    created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS work_terminal_evidence_reads (
      binding_id TEXT PRIMARY KEY REFERENCES work_execution_bindings(binding_id), version INTEGER NOT NULL
    );`);
}

/** Host-owned continuation, never a second submission of the failed input. */
export class WorkAutomaticRecovery {
  constructor(private readonly db: Database.Database, private readonly works: WorkService) { ensureAutomaticRecoveryTables(db); }
  private findDispatchRequestByTask(taskId: string) {
    const dbRows = this.db.prepare("SELECT operation_id, work_id, task_id, continuation_plan_id FROM work_dispatch_requests WHERE task_id=?")
      .all(taskId) as Array<{ operation_id: string; work_id: string; task_id: string; continuation_plan_id: string | null }>;
    return overlayFindAll(this.db, "work_dispatch_requests", dbRows, r => String(r.operation_id), r => r.task_id === taskId)[0];
  }
  private findContinuationPlan(planId: string) {
    return overlayReadOne<{ plan_id: string; source_binding_id: string }>(this.db, "work_continuation_plans", planId, () =>
      this.db.prepare("SELECT plan_id, source_binding_id FROM work_continuation_plans WHERE plan_id=?").get(planId) as { plan_id: string; source_binding_id: string } | undefined);
  }
  ancestry(binding: WorkExecutionBindingDto): WorkExecutionBindingDto[] {
    const chain: WorkExecutionBindingDto[] = [], seen = new Set<string>();
    let current: WorkExecutionBindingDto | undefined = binding;
    while (current && !seen.has(current.bindingId)) {
      seen.add(current.bindingId); chain.push(current);
      const req = this.findDispatchRequestByTask(current.taskId);
      const plan = req?.continuation_plan_id ? this.findContinuationPlan(req.continuation_plan_id) : undefined;
      const source = plan && this.works.repo.getBinding(plan.source_binding_id);
      current = source && source.workId === binding.workId && source.intentRevision === binding.intentRevision
        && source.inputSnapshotId === binding.inputSnapshotId ? source : undefined;
    }
    return chain;
  }
  sourceReadOnly(binding: WorkExecutionBindingDto): boolean {
    // Readback is an execution goal, not an inherited permission restriction.
    return this.ancestry(binding).some(source => {
      const event = source.inboxEventId ? this.works.repo.getInbox(source.inboxEventId) : undefined;
      return isReadOnlyScheduledFollowUp(event,this.works.getWork(source.workId));
    });
  }

  evidenceRead(bindingId: string): boolean {
    const row = overlayReadOne<{ version: number }>(this.db, "work_terminal_evidence_reads", bindingId, () =>
      this.db.prepare("SELECT binding_id,version FROM work_terminal_evidence_reads WHERE binding_id=?").get(bindingId) as { binding_id: string; version: number } | undefined);
    return row?.version === 1;
  }
  markEvidenceRead(bindingId: string): void {
    if (requiresWorkRustWrites(this.db)) {
      overlaySet(this.db, "work_terminal_evidence_reads", bindingId, { binding_id: bindingId, version: 1 });
      enqueueWorkOp(this.db, { op: "workTerminalEvidenceReadUpsert", bindingId });
      return;
    }
    this.db.prepare("INSERT INTO work_terminal_evidence_reads(binding_id,version) VALUES (?,1) ON CONFLICT(binding_id) DO UPDATE SET version=1").run(bindingId);
  }
  readOnlyPlan(planId: string): boolean {
    const record = this.record(planId);
    const source = record && this.works.repo.getBinding(record.source_binding_id);
    return !!record && (record.mode === "readback" || !!source && this.sourceReadOnly(source));
  }
  settleReadback(work: WorkDto, binding: WorkExecutionBindingDto, now: number): boolean {
    if (binding.status !== "completed" || work.lifecycle !== "active" || binding.invalidatedAt
      || binding.intentRevision !== work.intentRevision || binding.inputSnapshotId !== work.inputSnapshotId
      || !this.works.collaboration.isDelegationAdopted(binding, work) || !this.works.scheduledBindingCurrent(binding)) return false;
    const req = this.findDispatchRequestByTask(binding.taskId);
    const plan = req?.continuation_plan_id ? this.record(req.continuation_plan_id) : undefined;
    const existing = overlayReadOne(this.db, "work_automatic_recovery", binding.bindingId, () =>
      this.db.prepare("SELECT * FROM work_automatic_recovery WHERE source_binding_id=?").get(binding.bindingId) as Record<string, unknown> | undefined);
    if (plan?.mode !== "readback" || existing) return false;
    const planId = `automatic-recovery:${binding.bindingId}`;
    if (requiresWorkRustWrites(this.db)) {
      overlaySet(this.db, "work_automatic_recovery", binding.bindingId, {
        source_binding_id: binding.bindingId, plan_id: planId, fingerprint: "readback-delivered", mode: "exhausted", created_at: now,
      });
      enqueueWorkOp(this.db, { op: "workAutoRecoveryInsert", sourceBindingId: binding.bindingId, planId, fingerprint: "readback-delivered", mode: "exhausted", createdAt: now });
    } else {
      this.db.prepare("INSERT INTO work_automatic_recovery(source_binding_id,plan_id,fingerprint,mode,created_at) VALUES (?,?,?,'exhausted',?)")
        .run(binding.bindingId, planId, "readback-delivered", now);
    }
    this.finish(work, binding, "已交付现有成果和具体缺项，本次恢复没有重新执行未核实的业务动作，原目标未完全达成。", now);
    return true;
  }
  private finish(work: WorkDto, binding: WorkExecutionBindingDto, reason: string, now: number): void {
    this.works.repo.insertBlocker({ blockerId: `recovery-ended:${binding.bindingId}`, workId: work.workId,
      kind: "operational", waitingForUserInput: false, status: "cleared", reason, createdAt: now });
    const current = this.works.getWork(work.workId)!;
    if (current.mode === "watch") {
      this.works.repo.updateWork({ ...current, progressSummary: `${reason} 本轮处理结束，后续关注计划保持运行。`, stateVersion: current.stateVersion + 1, updatedAt: now });
      return;
    }
    if (this.works.automaticCompletion.tracked(binding.bindingId)) {
      this.works.repo.updateWork({ ...current, progressSummary: reason, stateVersion: current.stateVersion + 1, updatedAt: now });
      return; // New terminal events are reported by the result lane before ending.
    }
    const closure = this.works.closeWork({ kind: "bot", botId: current.ownerBotId, userId: current.userId,
      host: "background", grants: current.authorization }, { operationId: `recovery-ended:${binding.bindingId}`,
      workId: current.workId, conclusion: "ended_unsuccessfully", closureSummary: reason,
      versionGuard: { expectedStateVersion: current.stateVersion, expectedIntentRevision: current.intentRevision, expectedOwnerEpoch: current.ownerEpoch } });
    if (!closure.ok) throw Error(`恢复收尾失败：${closure.message}`);
  }
  readOnlyTask(taskId: string): boolean {
    const req = this.findDispatchRequestByTask(taskId);
    if (!req?.continuation_plan_id) return false;
    const rec = this.record(req.continuation_plan_id);
    if (!rec) return false;
    return this.readOnlyPlan(rec.plan_id);
  }
  isSyntheticItem(binding: WorkExecutionBindingDto, itemId: string): boolean {
    const req = this.findDispatchRequestByTask(binding.taskId);
    const rec = req?.continuation_plan_id ? this.record(req.continuation_plan_id) : undefined;
    return !!rec && itemId === `recover:${rec.source_binding_id}`;
  }
  record(planId: string): Recovery | undefined {
    const dbRows = this.db.prepare("SELECT * FROM work_automatic_recovery WHERE plan_id=?").all(planId) as Array<Recovery & Record<string, unknown>>;
    return overlayFindAll<Recovery & Record<string, unknown>>(this.db, "work_automatic_recovery", dbRows, r => String(r.source_binding_id), r => r.plan_id === planId)[0];
  }
  prepare(work: WorkDto, binding: WorkExecutionBindingDto, now: number): boolean {
    if (!workDomainInTx(this.db)) throw Error("恢复计划必须与派发事务原子提交");
    const rust = requiresWorkRustWrites(this.db);
    const current = this.works.getWork(work.workId);
    if (!current) return false;
    work = current;
    if (work.lifecycle !== "active" || binding.status !== "failed" || binding.invalidatedAt
      || binding.intentRevision !== work.intentRevision || binding.inputSnapshotId !== work.inputSnapshotId
      || !this.works.collaboration.isDelegationAdopted(binding, work) || !this.works.scheduledBindingCurrent(binding)) return false;
    if (this.works.repo.listBindings(work.workId).some(other => other.bindingId !== binding.bindingId
      && other.botId === binding.botId && other.intentRevision === binding.intentRevision && other.inputSnapshotId === binding.inputSnapshotId
      && other.admittedAt > binding.admittedAt && ["pending", "submitted", "running", "completed"].includes(other.status))) return false;
    const existingRecovery = overlayReadOne(this.db, "work_automatic_recovery", binding.bindingId, () =>
      this.db.prepare("SELECT * FROM work_automatic_recovery WHERE source_binding_id=?").get(binding.bindingId) as Record<string, unknown> | undefined);
    if (existingRecovery
      || this.works.partialResults.plans(work.workId).some(plan => plan.sourceBindingId === binding.bindingId && plan.state !== "cancelled")) return false;
    // The terminal reader must first recover outputs that older projections dropped.
    if (!this.evidenceRead(binding.bindingId)) return false;
    const sourceIds = new Set(this.ancestry(binding).map(source => source.bindingId));
    const results = this.works.repo.listDeliverables(work.workId).filter(result => sourceIds.has(result.executionId ?? "") && result.status !== "superseded");
    const artifacts = [...new Set(results.flatMap(result => result.artifactRefs))].sort();
    // Compare durable progress, not model wording: changing an error sentence
    // cannot buy another identical retry. Current artifact fingerprints include
    // bytes already verified by the native result receiver.
    const fingerprint = continuationProgress(this.works, work);
    const matchingBindingIds = new Set(this.works.repo.listBindings(work.workId)
      .filter(b => b.intentRevision === work.intentRevision && b.inputSnapshotId === work.inputSnapshotId)
      .map(b => b.bindingId));
    const priorDbRows = this.db.prepare(`SELECT recovery.* FROM work_automatic_recovery recovery JOIN work_execution_bindings binding
      ON binding.binding_id=recovery.source_binding_id WHERE binding.work_id=? AND binding.intent_revision=? AND binding.input_snapshot_id=?`)
      .all(work.workId, work.intentRevision, work.inputSnapshotId) as Array<Recovery & Record<string, unknown>>;
    const prior = overlayFindAll<Recovery & Record<string, unknown>>(this.db, "work_automatic_recovery", priorDbRows,
      r => String(r.source_binding_id), r => matchingBindingIds.has(String(r.source_binding_id)));
    const sourceReq = this.findDispatchRequestByTask(binding.taskId);
    const sourcePlan = sourceReq?.continuation_plan_id ? this.record(sourceReq.continuation_plan_id) : undefined;
    const repeated = prior.some(row => row.fingerprint === fingerprint);
    const mode = sourcePlan?.mode === "readback" ? "exhausted" : repeated ? "readback" : "recover";
    const planId = `automatic-recovery:${binding.bindingId}`;
    if (rust) {
      overlaySet(this.db, "work_automatic_recovery", binding.bindingId, {
        source_binding_id: binding.bindingId, plan_id: planId, fingerprint, mode, created_at: now,
      });
      enqueueWorkOp(this.db, { op: "workAutoRecoveryInsert", sourceBindingId: binding.bindingId, planId, fingerprint, mode, createdAt: now });
    } else {
      this.db.prepare("INSERT INTO work_automatic_recovery(source_binding_id,plan_id,fingerprint,mode,created_at) VALUES (?,?,?,?,?)")
        .run(binding.bindingId, planId, fingerprint, mode, now);
    }
    if (mode === "exhausted") {
      const reason = `自动恢复未取得新进展，已停止重复同一失败方法。已完成的成果保留在对话中。未完成原因：${binding.settlementNote || "原生执行没有返回可用结果"}`;
      this.finish(work, binding, reason, now);
      return true;
    }
    const itemId = `recover:${binding.bindingId}`;
    const task = mode === "readback"
      ? "仅读取、核对和交付已有成果及具体缺项。不重新执行写入、发送、发布、删除等业务效果。"
      : "接续原执行尚未完成的步骤；先读取已有成果，失败方法改用可用替代方式；不得重复已完成的业务效果。";
    this.works.partialResults.record(binding, [{ itemId, task, required: true, dependencies: [],
      criterionIds: work.criteria.filter(item => item.status !== "satisfied").map(item => item.id),
      nativeStatus: "failed", outcome: "failed", artifactRefs: artifacts, writeConflicts: [], summary: binding.settlementNote ?? "执行中断" }], now);
    const gapIds = [itemId, ...this.works.partialResults.gaps(work.workId)
      .filter(item => item.bindingId === binding.bindingId && item.itemId !== itemId).map(item => item.itemId)];
    const gapItemsJson = JSON.stringify(gapIds);
    if (rust) {
      overlaySet(this.db, "work_continuation_plans", planId, {
        plan_id: planId, work_id: work.workId, source_binding_id: binding.bindingId, operation_id: planId,
        intent_revision: work.intentRevision, input_snapshot_id: work.inputSnapshotId, owner_epoch: work.ownerEpoch,
        owner_bot_id: work.ownerBotId, gap_items_json: gapItemsJson, reason: task, state: "pending", created_at: now,
      });
      enqueueWorkOp(this.db, {
        op: "workContinuationPlanWrite", mode: "insert", planId, workId: work.workId, sourceBindingId: binding.bindingId,
        operationId: planId, intentRevision: work.intentRevision, inputSnapshotId: work.inputSnapshotId,
        ownerEpoch: work.ownerEpoch, ownerBotId: work.ownerBotId, gapItemsJson, reason: task, createdAt: now, taskId: null,
      });
      for (const id of gapIds) {
        const gapKey = digest([binding.bindingId, id]);
        overlayMutate(this.db, "work_continuation_gaps", gapKey, () =>
          this.db.prepare("SELECT * FROM work_continuation_gaps WHERE gap_key=?").get(gapKey) as Record<string, unknown> | undefined,
        cur => cur ?? { gap_key: gapKey, plan_id: planId });
        enqueueWorkOp(this.db, { op: "workContinuationGapInsert", gapKey, planId });
      }
    } else {
      this.db.prepare(`INSERT INTO work_continuation_plans(plan_id,work_id,source_binding_id,operation_id,intent_revision,input_snapshot_id,
        owner_epoch,owner_bot_id,gap_items_json,reason,state,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?)`)
        .run(planId, work.workId, binding.bindingId, planId, work.intentRevision, work.inputSnapshotId, work.ownerEpoch,
          work.ownerBotId, gapItemsJson, task, now);
      for (const id of gapIds) this.db.prepare("INSERT OR IGNORE INTO work_continuation_gaps(gap_key,plan_id) VALUES (?,?)")
        .run(digest([binding.bindingId, id]), planId);
    }
    return true;
  }
  input(binding: WorkExecutionBindingDto, planId: string): string | undefined {
    const record = this.record(planId); if (!record || record.mode === "exhausted") return undefined;
    const source = this.works.repo.getBinding(record.source_binding_id); if (!source) throw Error("恢复缺少原执行绑定");
    const sourceIds = new Set(this.ancestry(source).map(item => item.bindingId));
    const results = this.works.repo.listDeliverables(binding.workId).filter(result => sourceIds.has(result.executionId ?? "") && result.status !== "superseded");
    const facts = this.works.partialResults.list(binding.workId).filter(item => sourceIds.has(item.bindingId));
    return JSON.stringify({ recovery: { planId, sourceBindingId: source.bindingId, originalWorkspace: source.workspaceBinding,
      failure: source.settlementNote, mode: record.mode,
      completed: facts.filter(item => item.outcome === "completed"),
      remaining: this.works.partialResults.gaps(binding.workId).filter(item => sourceIds.has(item.bindingId)).map(item => ({ itemId: item.itemId, task: item.task, outcome: item.outcome, criterionIds: item.criterionIds })),
      retainedResults: results.map(result => ({ summary: result.summary, artifacts: result.artifactRefs })),
      uncertainOperations: this.works.repo.listAdmissions(binding.workId)
        .filter(item => item.state === "unknown" && item.bindingId && sourceIds.has(item.bindingId))
        .map(item => ({ operationId: item.operationId, actionKind: item.actionKind })),
      instructions: record.mode === "readback"
        ? "只读核对已有成果并给用户交付部分结果、来源及具体缺项。未知外部效果不得重发重做；不要声称未知动作未发生。不要再次调用同一个失败方法。"
        : "这是原事项的定向恢复，不是重做原任务。普通工具失败直接处理，未知效果不阻止独立步骤。先读取已有报告与成功步骤；只补缺失部分。uncertainOperations 保留原调用身份，不代表未执行；核对实际状态或幂等回执前不得盲目重发同一未知操作。网络/解析/依赖失败时换方法或数据源，不要重复同一失败调用。已有文件不得重建、已发消息不得重发。有用结果立刻汇报；无法继续时交付部分结果和具体原因，不要求用户批准重试。",
      itemId: `recover:${source.bindingId}` }, originalGoal: JSON.parse(this.works.repo.executionInput(this.ancestry(source).at(-1) ?? source)) });
  }
}
