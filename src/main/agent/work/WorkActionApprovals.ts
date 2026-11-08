import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { PermissionMode } from "../../../shared/agent-ipc";
import { workActionApprovalSchema, workActionDecisionSchema, type WorkActionApprovalDto, type WorkActionDecisionResult } from "../../../shared/bot-work-approval";
import type { WorkService } from "./WorkService";

export interface WorkActionRequest {
  taskRoot?: string; taskId: string; operationId: string; toolName: string; arguments: unknown; actionKind: string;
  summary: string; detail?: string; deniedReason?: string; permissionMode: PermissionMode; needsApproval: boolean;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const rowSchema = z.object({ approval_id: z.string(), work_id: z.string(), binding_id: z.string(), operation_id: z.string(),
  fingerprint: z.string(), decision_json: z.string().nullable(), data_json: z.string() });

/** A persisted, exact-action permission, never a mutation of Work/Bot/global scopes.
 * Observers may disappear; the absolute deadline and decision survive process restarts. */
export class WorkActionApprovals {
  constructor(private readonly db: Database.Database, private readonly works: WorkService,
    private readonly options: { now: () => number; isAuthority: () => boolean; ttlMs?: number }) {
    db.exec(`CREATE TABLE IF NOT EXISTS work_action_approvals (
      approval_id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(work_id),
      binding_id TEXT NOT NULL REFERENCES work_execution_bindings(binding_id), operation_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL, decision_json TEXT, data_json TEXT NOT NULL CHECK(json_valid(data_json)),
      UNIQUE(binding_id,operation_id)
    );
    CREATE TABLE IF NOT EXISTS work_action_approval_claims (
      source_gap_id TEXT PRIMARY KEY, approval_id TEXT NOT NULL
    );`);
  }

  list(workId: string): WorkActionApprovalDto[] {
    return this.db.prepare("SELECT * FROM work_action_approvals WHERE work_id=? ORDER BY rowid").all(workId)
      .map(raw => workActionApprovalSchema.parse(JSON.parse(rowSchema.parse(raw).data_json)));
  }
  private get(id: string) {
    const raw = this.db.prepare("SELECT * FROM work_action_approvals WHERE approval_id=?").get(id);
    if (!raw) return undefined;
    const row = rowSchema.parse(raw);
    return { ...row, value: workActionApprovalSchema.parse(JSON.parse(row.data_json)) };
  }
  private current(value: WorkActionApprovalDto): boolean {
    const work = this.works.getWork(value.workId), binding = this.works.repo.getBinding(value.bindingId);
    return !!work && !!binding && work.lifecycle === "active" && !binding.invalidatedAt
      && !["completed", "failed", "stopped", "invalidated"].includes(binding.status)
      && binding.taskId === value.taskId && binding.workId === work.workId
      && work.intentRevision === value.intentRevision && binding.intentRevision === value.intentRevision
      && work.inputSnapshotId === value.inputSnapshotId && binding.inputSnapshotId === value.inputSnapshotId
      && work.ownerEpoch === value.ownerEpoch && this.works.collaboration.isDelegationAdopted(binding, work)
      && (work.authorization.expiresAt === undefined || work.authorization.expiresAt > this.options.now());
  }

  /** undefined means this is an ordinary Task and its existing approval policy applies. */
  async request(input: WorkActionRequest, signal?: AbortSignal): Promise<boolean | undefined> {
    const binding = this.works.repo.bindingForTask(input.taskId);
    if (!binding) return undefined;
    // Non-workspace delegation stays under its existing host policy. Persist an
    // explicit refusal, but never turn it into a one-action scope grant.
    if (!["workspace:read", "workspace:write"].includes(input.actionKind)
      && !(input.actionKind === "delegate" && input.deniedReason)) return undefined;
    const work = this.works.getWork(binding.workId);
    if (!work || !this.options.isAuthority()) return false;
    const scopeMissing = !work.authorization.allowedScopes.includes(input.actionKind)
      || binding.delegatedScope.length > 0 && !binding.delegatedScope.includes(input.actionKind);
    const priorAdmission = this.works.repo.listAdmissions(work.workId).find(item => item.operationId === input.operationId);
    const possiblePriorEffect = !!priorAdmission && ["admitted", "unknown", "consumed"].includes(priorAdmission.state);
    const actionHash = hash([binding.workspaceBinding, input.taskRoot ?? binding.workspaceBinding, input.toolName, input.arguments, input.actionKind]);
    const continuation = this.approvalContinuation(binding.taskId);
    const approvalId = `work-approval:${hash([binding.bindingId, input.operationId])}`;
    const matching = continuation.filter(item => item.approval?.actionHash === actionHash);
    const alreadyFinished = matching.some(item => this.works.partialResults.list(work.workId).some(result =>
      result.bindingId === binding.bindingId && result.itemId === item.gap.itemId && result.outcome === "completed"));
    const alreadyClaimed = continuation.length > 0 && this.list(work.workId).some(value => value.bindingId === binding.bindingId
      && value.approvalId !== approvalId && value.actionHash === actionHash && value.requiredScope === "workspace:write"
      && value.outcome !== "continuation-outside-plan");
    let outsidePlan = input.actionKind === "workspace:write" && continuation.length > 0 && (!matching.length || alreadyFinished || alreadyClaimed);
    let restriction = possiblePriorEffect ? "原动作已有执行准入或未知效果，必须核对原回执；没有启动新的执行" : input.deniedReason ?? (outsidePlan
      ? "补跑仅允许已选缺口的原工具及原参数，拒绝新增或重复其他业务动作" : undefined);
    const fingerprint = hash([binding.taskId, binding.durableStoreKey, binding.conversationId, binding.workspaceBinding,
      input.taskRoot ?? binding.workspaceBinding, input.operationId, input.toolName, input.arguments, input.actionKind]);
    let stored = this.get(approvalId);
    if (stored && stored.fingerprint !== fingerprint) throw new Error("审批动作身份不能用于不同工具或参数");
    // Read-only shell commands are classified by the native policy. Never silently
    // turn application auto mode into Work authorization or allow readonly writes.
    if (stored && restriction && (["pending", "approved"].includes(stored.value.status) || stored.value.status === "consumed" && stored.value.outcome === "released")) {
      const reason = restriction;
      this.works.transaction(() => this.settle(stored!.value, possiblePriorEffect ? "invalidated" : "denied", reason));
    }
    if (!stored && !continuation.length && !restriction && !scopeMissing && (!input.needsApproval || input.permissionMode === "auto")) return true;
    if (!stored) {
      this.works.transaction(() => {
        if (!this.options.isAuthority()) throw new Error("审批登记时宿主权威已变化");
        const now = this.options.now();
        if (input.actionKind === "workspace:write" && matching.length && !outsidePlan) {
          for (const item of matching) {
            this.db.prepare("INSERT OR IGNORE INTO work_action_approval_claims(source_gap_id,approval_id) VALUES (?,?)").run(item.gap.factId, approvalId);
            const claim = z.object({ approval_id: z.string() }).parse(this.db.prepare("SELECT approval_id FROM work_action_approval_claims WHERE source_gap_id=?").get(item.gap.factId));
            if (claim.approval_id !== approvalId) {
              outsidePlan = true; restriction = "此缺口已由原动作占用；核对原回执前不能重复执行";
            }
          }
        }
        const denied = !!restriction || input.permissionMode === "readonly" && input.actionKind !== "workspace:read";
        const automatic = !denied && !scopeMissing && (!input.needsApproval || input.permissionMode === "auto");
        const value: WorkActionApprovalDto = { approvalId, workId: work.workId, bindingId: binding.bindingId,
          actionHash, taskId: binding.taskId, operationId: input.operationId, toolName: input.toolName,
          summary: input.summary, detail: input.detail ?? "", requiredScope: input.actionKind, scopeMissing,
          intentRevision: work.intentRevision, inputSnapshotId: work.inputSnapshotId, ownerEpoch: work.ownerEpoch,
          status: possiblePriorEffect ? "invalidated" : denied ? "denied" : automatic ? "approved" : "pending", version: 1, createdAt: now,
          expiresAt: now + (this.options.ttlMs ?? 5 * 60_000), outcome: outsidePlan ? "continuation-outside-plan" : restriction ?? (denied ? "readonly-policy" : undefined) };
        this.db.prepare("INSERT OR IGNORE INTO work_action_approvals(approval_id,work_id,binding_id,operation_id,fingerprint,data_json) VALUES (?,?,?,?,?,?)")
          .run(approvalId, work.workId, binding.bindingId, input.operationId, fingerprint, JSON.stringify(value));
        if (automatic) this.touch(work.workId);
        else this.block(value, denied ? restriction ?? "当前应用只读策略拒绝此操作，未执行" : scopeMissing
          ? `缺少 ${input.actionKind} 授权；仅此工具动作可由你授权后继续，已完成步骤不重跑`
          : "后台操作等待你确认，超时会默认拒绝，未执行");
      });
      stored = this.get(approvalId)!;
    }
    for (;;) {
      if (!this.options.isAuthority()) throw new Error("审批观察宿主已失去权威，保留请求等待原身份恢复");
      this.recover();
      const value = this.get(approvalId)!.value;
      if (value.status !== "pending") return value.status === "approved" && this.current(value);
      if (signal?.aborted) throw new Error("审批观察已中断；原请求保留并按原期限默认拒绝");
      await new Promise<void>(resolve => setTimeout(resolve, 100));
    }
  }

  decide(userId: string, input: unknown): WorkActionDecisionResult {
    const parsed = workActionDecisionSchema.safeParse(input);
    if (!parsed.success) return { ok: false, code: "invalid_request", message: "审批身份或版本无效" };
    return this.works.transaction(() => {
      if (!this.options.isAuthority()) return { ok: false, code: "forbidden", message: "当前宿主不持有审批权威" };
      this.recover();
      const request = parsed.data, row = this.get(request.approvalId), value = row?.value;
      const work = value && this.works.getWork(value.workId);
      if (!row || !value || !work || work.userId !== userId || value.workId !== request.workId || value.bindingId !== request.bindingId)
        return { ok: false, code: "not_found", message: "找不到属于当前用户与执行的审批" };
      const decision = JSON.stringify(request);
      if (row.decision_json === decision) return { ok: true, approval: value, replayed: true };
      if (value.status !== "pending") return { ok: false, code: "already_resolved", message: "审批已结束，不能再次执行" };
      if (value.version !== request.expectedVersion || work.stateVersion !== request.expectedStateVersion
        || work.intentRevision !== request.expectedIntentRevision || work.ownerEpoch !== request.expectedOwnerEpoch || !this.current(value))
        return { ok: false, code: "version_conflict", message: "事项或审批已变化，请刷新后重新判断" };
      if (request.approved && value.scopeMissing && (!request.grantScopeOnce || !["workspace:read", "workspace:write"].includes(value.requiredScope)))
        return { ok: false, code: "invalid_request", message: "必须明确授权本次缺失的工作区范围；其他授权请通过事项配置处理" };
      const next = this.settle(value, request.approved ? "approved" : "denied", request.approved ? "user-approved-once" : "user-denied");
      this.db.prepare("UPDATE work_action_approvals SET decision_json=? WHERE approval_id=?").run(decision, value.approvalId);
      return { ok: true, approval: next, replayed: false };
    });
  }

  approvedTaskAction(taskId: string, operationId: string, toolName: string): boolean | undefined {
    const binding = this.works.repo.bindingForTask(taskId); if (!binding) return undefined;
    const value = this.list(binding.workId).find(value => value.bindingId === binding.bindingId && value.operationId === operationId);
    return !!value && value.toolName === toolName && this.permits(binding.bindingId, operationId, value.requiredScope);
  }
  permits(bindingId: string, operationId: string, actionKind: string): boolean {
    const row = this.db.prepare("SELECT * FROM work_action_approvals WHERE binding_id=? AND operation_id=?").get(bindingId, operationId);
    if (!row) return false;
    const value = workActionApprovalSchema.parse(JSON.parse(rowSchema.parse(row).data_json));
    const admission = this.works.repo.listAdmissions(value.workId).find(a => a.operationId === value.operationId);
    if (admission && admission.state !== "admitted") return false;
    return value.status === "approved" && value.requiredScope === actionKind && this.current(value)
      && (value.expiresAt > this.options.now() || admission?.state === "admitted" && admission.admittedAt < value.expiresAt);
  }
  settleAction(taskId: string, operationId: string, outcome: string): void {
    const binding = this.works.repo.bindingForTask(taskId); if (!binding) return;
    const value = this.list(binding.workId).find(value => value.bindingId === binding.bindingId && value.operationId === operationId);
    const recovered = (value?.status === "invalidated" || value?.status === "consumed" && value.outcome === "unknown") && outcome === "consumed"
      && this.works.repo.listAdmissions(binding.workId).some(a => a.operationId === operationId && a.state === "consumed");
    if (value && (value.status === "approved" || recovered)) {
      this.settle(value, "consumed", outcome);
      if (outcome === "consumed" && value.actionHash) for (const item of this.approvalContinuation(taskId)) {
        if (item.approval?.actionHash !== value.actionHash) continue;
        this.works.partialResults.record(binding, [{ itemId: item.gap.itemId, task: item.gap.task,
          required: true, dependencies: item.gap.dependencies, criterionIds: item.gap.criterionIds,
          nativeStatus: "host_approval_continuation_verified", outcome: "completed", artifactRefs: [], writeConflicts: [],
          summary: "仅补齐原先未执行且本次明确授权的动作，工具回执已核对；保留其他步骤和验收要求", origin: "native" }], this.options.now());
        this.works.repo.clearBlocker(item.gap.itemId, binding.workId, this.options.now());
      }
    }
  }
  /** Cancellation retires only not-started approvals. Unknown/active effects keep
   * their reconciliation obligations; Work's enclosing control owns projection. */
  retireForStop(workId: string): void {
    for (const value of this.list(workId)) {
      if (this.works.repo.listAdmissions(workId).some(a => a.operationId === value.operationId && ["admitted", "unknown"].includes(a.state))) continue;
      if (["pending", "approved"].includes(value.status)) this.db.prepare("UPDATE work_action_approvals SET data_json=? WHERE approval_id=?")
        .run(JSON.stringify({ ...value, status: "invalidated", version: value.version + 1, resolvedAt: this.options.now(), outcome: "work-stopped" }), value.approvalId);
      this.works.repo.clearBlocker(value.approvalId, workId, this.options.now());
    }
  }
  /** Called on boot and by the background scheduler even with no renderer attached. */
  recover(): void {
    if (!this.options.isAuthority()) return;
    this.works.transaction(() => {
      for (const row of this.db.prepare("SELECT * FROM work_action_approvals WHERE json_extract(data_json,'$.status') IN ('pending','approved')").all()) {
        const value = workActionApprovalSchema.parse(JSON.parse(rowSchema.parse(row).data_json));
        if (!this.current(value)) this.settle(value, "invalidated", "事项、负责人或执行身份已失效，未恢复原动作");
        // Once admitted, execution/effect settlement owns the outcome, not a wall clock.
        else if (value.expiresAt <= this.options.now() && !this.works.repo.listAdmissions(value.workId).some(a => a.operationId === value.operationId && ["admitted", "unknown", "consumed"].includes(a.state)))
          this.settle(value, "expired", "审批超时，默认拒绝；该动作未执行");
      }
    });
  }
  private approvalContinuation(taskId: string) {
    const raw = this.db.prepare("SELECT continuation_plan_id FROM work_dispatch_requests WHERE task_id=?").get(taskId);
    const row = z.object({ continuation_plan_id: z.string().nullable() }).optional().parse(raw);
    const binding = this.works.repo.bindingForTask(taskId);
    const plan = binding && row?.continuation_plan_id && this.works.partialResults.plans(binding.workId).find(plan => plan.planId === row.continuation_plan_id);
    if (!binding || !plan) return [];
    const items = this.works.partialResults.list(binding.workId).filter(item => item.bindingId === plan.sourceBindingId && plan.gapItemIds.includes(item.itemId));
    return items.filter(gap => gap.nativeStatus === "host_approval_not_started").map(gap => ({ gap, approval: this.get(gap.itemId)?.value }));
  }
  private settle(value: WorkActionApprovalDto, status: WorkActionApprovalDto["status"], outcome: string): WorkActionApprovalDto {
    const next = { ...value, status, outcome, version: value.version + 1, resolvedAt: this.options.now() };
    this.db.prepare("UPDATE work_action_approvals SET data_json=? WHERE approval_id=?").run(JSON.stringify(next), value.approvalId);
    if (status === "approved" || status === "consumed") {
      this.works.repo.clearBlocker(value.approvalId, value.workId, this.options.now());
      this.touch(value.workId);
    } else this.block(next, `${outcome === "user-denied" ? "你已拒绝继续此操作" : outcome}。保留已完成步骤；没有重新提交整个任务。`);
    return next;
  }
  private block(value: WorkActionApprovalDto, reason: string): void {
    const work = this.works.getWork(value.workId);
    if (["workspace:read", "workspace:write"].includes(value.requiredScope)
      && ["denied", "expired", "invalidated"].includes(value.status) && work && !["closing", "closed"].includes(work.lifecycle)
      && value.outcome !== "continuation-outside-plan" && !this.works.repo.listAdmissions(value.workId).some(a => a.operationId === value.operationId && ["admitted", "unknown", "consumed"].includes(a.state))) {
      const binding = this.works.repo.getBinding(value.bindingId);
      if (binding) this.works.partialResults.record(binding, [{ itemId: value.approvalId,
        task: `仅处理先前未执行的动作：${value.toolName}。${value.summary}\n${value.detail}。保留其他已完成步骤，不得重跑整个委托；缺少授权时仍需用户确认。`,
        required: true, dependencies: [], criterionIds: [], nativeStatus: "host_approval_not_started", outcome: "not_started",
        artifactRefs: [], writeConflicts: [], summary: reason, origin: "native" }], this.options.now());
    }
    const text = `${value.summary}：${reason}`;
    if (!this.works.repo.getBlocker(value.approvalId)) this.works.repo.insertBlocker({ blockerId: value.approvalId,
      workId: value.workId, kind: "operational", reason: text, waitingForUserInput: true, status: "open", createdAt: this.options.now() });
    else this.db.prepare("UPDATE work_blockers SET reason=?,waiting_for_user_input=1,status='open',cleared_at=NULL WHERE blocker_id=?").run(text, value.approvalId);
    if (value.outcome === "continuation-outside-plan") this.works.repo.clearBlocker(value.approvalId, value.workId, this.options.now());
    this.touch(value.workId);
  }
  private touch(workId: string): void {
    const work = this.works.getWork(workId); if (!work) return;
    this.works.repo.updateWork({ ...work, stateVersion: work.stateVersion + 1, updatedAt: this.options.now() });
    this.works.emitCurrentProjection(workId);
  }
}
