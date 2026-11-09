import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { PermissionMode } from "../../../shared/agent-ipc";
import { workActionApprovalSchema, workActionDecisionSchema, type WorkActionApprovalDto, type WorkActionAuthorization, type WorkActionDecisionResult } from "../../../shared/bot-work-approval";
import { conservativeDescriptor, type WorkActionDescriptor } from "../../../shared/bot-work-action";
import type { WorkAutonomyRule } from "../../../shared/bot-work-autonomy";
import type { WorkService } from "./WorkService";
import { classifyWorkAction, mcpIdentityOf, targetsInsideWorkspace } from "./WorkActionClassifier";
import { WorkDecisionLedger } from "./WorkDecisionLedger";
import { WorkAutonomyPolicy } from "./WorkAutonomyPolicy";
import { WorkDeferredActions, deferredTargetUnchanged, type WorkDeferredPayload } from "./WorkDeferredActions";

export interface WorkActionRequest {
  taskRoot?: string; taskId: string; operationId: string; toolName: string; arguments: unknown; actionKind: string;
  summary: string; detail?: string; deniedReason?: string; permissionMode: PermissionMode; needsApproval: boolean;
  /** P0-D：显式请求非阻塞挂起。默认仍等待决定，只有确认支持 defer 的调用方开启。 */
  deferrable?: boolean;
  originalCall?: { name: string; arguments: unknown };
  continuationApprovalId?: string;
  continuationDeliveryId?: string;
  sourceConversationId?: string;
  nativeContext?: WorkDeferredPayload["nativeContext"];
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const rowSchema = z.object({ approval_id: z.string(), work_id: z.string(), binding_id: z.string(), operation_id: z.string(),
  fingerprint: z.string(), decision_json: z.string().nullable(), data_json: z.string() });

/** 结构化分类失败不能把动作降级成低风险：一律按保守的未分类动作处理。 */
function describeAction(input: WorkActionRequest): WorkActionDescriptor {
  try {
    const descriptor = classifyWorkAction({ toolName: input.toolName, arguments: input.arguments,
      mcp: mcpIdentityOf(input.toolName), effect: input.needsApproval ? "side-effect" : "read" });
    if (descriptor.operation === "shell_read" && input.actionKind === "workspace:write")
      return conservativeDescriptor("命令外观只读，但没有匹配可信只读执行适配器；请拆成明确路径的单条读取，不能直接按只读放行任意 Shell");
    return descriptor;
  } catch {
    return conservativeDescriptor("动作参数无法结构化归类，按未分类外部写入处理");
  }
}

/** Deferred payloads cannot persist credential values. Credential-aware adapters
 * must provide a supported reference resolver before those actions can be queued. */
function hasCredentialValues(value: unknown): boolean {
  if (typeof value === "string") return /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._~-]{12,}|(?:api[_-]?key|access[_-]?token|password)\s*[=:]\s*[^\s]{6,})/i.test(value);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) => /^(?:password|passwd|secret|clientSecret|apiKey|api_key|accessToken|access_token|refreshToken|refresh_token|authorization|cookie|privateKey)$/i.test(key)
    && typeof item === "string" && item.length > 0 || hasCredentialValues(item));
}

/** A persisted, exact-action permission, never a mutation of Work/Bot/global scopes.
 * Observers may disappear; the absolute deadline and decision survive process restarts. */
export class WorkActionApprovals {
  readonly deferred: WorkDeferredActions;
  private readonly ledger: WorkDecisionLedger;
  private readonly autonomy: WorkAutonomyPolicy;
  private readonly ruleCache = new Map<string, Set<string>>();
  constructor(private readonly db: Database.Database, private readonly works: WorkService,
    private readonly options: { now: () => number; isAuthority: () => boolean; ttlMs?: number }) {
    this.ledger = new WorkDecisionLedger(db, options.now);
    this.autonomy = new WorkAutonomyPolicy(this.ledger, options.now);
    db.exec(`CREATE TABLE IF NOT EXISTS work_action_approvals (
      approval_id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(work_id),
      binding_id TEXT NOT NULL REFERENCES work_execution_bindings(binding_id), operation_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL, decision_json TEXT, data_json TEXT NOT NULL CHECK(json_valid(data_json)),
      UNIQUE(binding_id,operation_id)
    );
    CREATE TABLE IF NOT EXISTS work_action_approval_claims (
      source_gap_id TEXT PRIMARY KEY, approval_id TEXT NOT NULL
    );`);
    this.deferred = new WorkDeferredActions(db);
  }

  list(workId: string): WorkActionApprovalDto[] {
    return this.db.prepare("SELECT * FROM work_action_approvals WHERE work_id=? ORDER BY rowid").all(workId)
      .map(raw => { const value = workActionApprovalSchema.parse(JSON.parse(rowSchema.parse(raw).data_json));
        this.deferred.get(value.approvalId);
        const deferred = this.deferred.state(value.approvalId);
        return deferred ? { ...value, continuation: { status: deferred.status, reason: deferred.reason } } : value; });
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
      && (! ["completed", "failed", "stopped", "invalidated"].includes(binding.status)
        || ["completed", "failed"].includes(binding.status) && !!this.deferred.get(value.approvalId))
      && binding.taskId === value.taskId && binding.workId === work.workId
      && work.intentRevision === value.intentRevision && binding.intentRevision === value.intentRevision
      && work.inputSnapshotId === value.inputSnapshotId && binding.inputSnapshotId === value.inputSnapshotId
      && work.ownerEpoch === value.ownerEpoch && this.works.collaboration.isDelegationAdopted(binding, work)
      && (work.authorization.expiresAt === undefined || work.authorization.expiresAt > this.options.now());
  }

  /** undefined means this is an ordinary Task and its existing approval policy applies. */
  async request(input: WorkActionRequest, signal?: AbortSignal): Promise<WorkActionAuthorization> {
    const binding = this.works.repo.bindingForTask(input.taskId);
    if (!binding) return { kind: "not_applicable" };
    // Non-workspace delegation stays under its existing host policy. Persist an
    // explicit refusal, but never turn it into a one-action scope grant.
    if (!["workspace:read", "workspace:write"].includes(input.actionKind)
      && !(input.actionKind === "delegate" && input.deniedReason)) return { kind: "not_applicable" };
    const work = this.works.getWork(binding.workId);
    if (!work || !this.options.isAuthority()) return { kind: "deny", reason: "当前宿主不持有该事项的审批权威，动作未执行" };
    if (input.continuationApprovalId && !this.deferred.forOperation(input.operationId)) {
      const candidate = this.deferred.get(input.continuationApprovalId);
      const source = candidate && this.get(candidate.approvalId)?.value;
      if (!candidate || candidate.deliveryId !== input.continuationDeliveryId || source?.bindingId !== binding.bindingId || candidate.payload.toolName !== input.toolName
        || hash(candidate.payload.arguments) !== hash(input.arguments)
        || candidate.payload.taskRoot !== (input.taskRoot ?? binding.workspaceBinding)
        || candidate.payload.sourceConversationId !== input.sourceConversationId
        || !this.claimDeferred(candidate.approvalId, input.operationId, input.continuationDeliveryId))
        return { kind: "deny", reason: "暂缓动作的原始参数、执行身份或有效授权不匹配，未补跑" };
    }
    const resumed = this.deferred.forOperation(input.operationId);
    if (resumed) {
      const original = this.get(resumed.approvalId)?.value;
      const payload = resumed.payload;
      const exact = original?.bindingId === binding.bindingId && payload.taskRoot === (input.taskRoot ?? binding.workspaceBinding)
        && payload.toolName === input.toolName && hash(payload.arguments) === hash(input.arguments) && payload.actionKind === input.actionKind;
      if (!exact || !deferredTargetUnchanged(payload) || input.deniedReason || !this.permits(binding.bindingId, input.operationId, input.actionKind))
        return { kind: "deny", reason: input.deniedReason ?? "补跑身份、参数或授权已变化，未执行" };
      return { kind: "allow", source: "exact" };
    }
    const scopeMissing = !work.authorization.allowedScopes.includes(input.actionKind)
      || binding.delegatedScope.length > 0 && !binding.delegatedScope.includes(input.actionKind);
    const credentialPayload = input.deferrable && (describeAction(input).effect === "credential"
      || hasCredentialValues(input.arguments) || hasCredentialValues(input.originalCall?.arguments));
    if (credentialPayload) input = { ...input, summary: "凭据相关操作需要安全引用", detail: "该工具尚无可恢复的凭据引用适配器，未保存敏感参数，未执行；请通过安全凭据入口处理该动作。" };
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
    let restriction = possiblePriorEffect ? "原动作已有执行准入或未知效果，必须核对原回执；没有启动新的执行" : input.deniedReason ?? (credentialPayload ? "不能将凭据明文登记为延迟执行参数，需要安全凭据引用" : undefined) ?? (outsidePlan
      ? "补跑仅允许已选缺口的原工具及原参数，拒绝新增或重复其他业务动作" : undefined);
    const fingerprint = hash([binding.taskId, binding.durableStoreKey, binding.conversationId, binding.workspaceBinding,
      input.taskRoot ?? binding.workspaceBinding, input.operationId, input.toolName, input.arguments, input.actionKind]);
    let stored = this.get(approvalId);
    let grantedBy: "policy" | "precedent" | "scope" | "auto" | "exact" = "exact";
    let skipped: "policy" | "precedent" | "scope" | "auto" | undefined;
    const persistedAction = stored && this.deferred.get(stored.value.approvalId);
    if (persistedAction && persistedAction.status !== "deferred")
      return { kind: "deny", reason: "原动作已交给唯一持久补跑记录，不能再次从模型调用执行；请查看原动作回执" };
    if (stored && stored.fingerprint !== fingerprint) throw new Error("审批动作身份不能用于不同工具或参数");
    // Read-only shell commands are classified by the native policy. Never silently
    // turn application auto mode into Work authorization or allow readonly writes.
    if (stored && restriction && (["pending", "approved"].includes(stored.value.status) || stored.value.status === "consumed" && stored.value.outcome === "released")) {
      const reason = restriction;
      this.works.transaction(() => this.settle(stored!.value, possiblePriorEffect ? "invalidated" : "denied", reason));
    }
    const existingDeferred = this.list(work.workId).find(value => value.bindingId === binding.bindingId
      && value.actionHash === actionHash && value.intentRevision === work.intentRevision
      && value.inputSnapshotId === work.inputSnapshotId && value.ownerEpoch === work.ownerEpoch
      && ["queued", "running", "consumed", "unknown"].includes(value.continuation?.status ?? ""));
    if (existingDeferred) return { kind: "defer", approvalId: existingDeferred.approvalId,
      reason: "同一原动作已有持久补跑或执行回执，未创建新动作，也未重复执行；请查看原审批状态" };
    // 同一动作（版本未变）已暂不处理/拒绝时不再重复打扰。
    const versionSameAction = this.list(work.workId).find(value => value.bindingId === binding.bindingId
      && value.actionHash === actionHash && value.intentRevision === work.intentRevision
      && value.inputSnapshotId === work.inputSnapshotId && value.ownerEpoch === work.ownerEpoch
      && ["pending", "ignored", "denied", "expired"].includes(value.status));
    if (!stored && versionSameAction && input.deferrable) {
      if (versionSameAction.status === "pending") return { kind: "defer", approvalId: versionSameAction.approvalId,
        reason: versionSameAction.outcome ?? "等待你确认，该动作未执行" };
      if (versionSameAction.status === "ignored") return { kind: "defer", approvalId: versionSameAction.approvalId,
        reason: "你已选择暂不处理该动作（未执行）；其它步骤可以继续" };
      return { kind: "deny", reason: versionSameAction.outcome ?? "该动作先前未获准执行" };
    }
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
        // P0-B：所有入口只有一条路径——确定性自治策略先决定“谁来决定”，
        // 再进入原生授权/资源/效果通道。auto 只是策略的一个输入，不能绕过
        // hard gate、显式 deny、真实 scope 上限或未分类的外部效果。
        const descriptor = describeAction(input);
        const decisionContext = { userId: work.userId, botId: binding.botId, workId: work.workId,
          bindingId: binding.bindingId, actionHash, projectId: work.projectId, workspaceId: binding.workspaceBinding,
          delegatedScope: binding.delegatedScope, permissionMode: input.permissionMode,
          scopeGranted: !scopeMissing,
          targetInsideWorkspace: targetsInsideWorkspace(input.taskRoot ?? binding.workspaceBinding, input.toolName, input.arguments) };
        const verdict = restriction ? undefined : this.autonomy.decide(descriptor, decisionContext);
        const decision = verdict && verdict.kind !== "ask"
          ? this.autonomy.record(verdict, descriptor, decisionContext, verdict.reason) : undefined;
        const denied = !!restriction || verdict?.kind === "deny";
        const automatic = !denied && !scopeMissing && verdict?.kind === "allow";
        // 原生层本来就不需要审批的读取不落审批行：决定已记入 work_decisions，没必要每个读都写一份审批记录。
        if (automatic && !input.needsApproval) { skipped = verdict?.kind === "allow" ? verdict.source : "auto"; return; }
        const value: WorkActionApprovalDto = { approvalId, workId: work.workId, bindingId: binding.bindingId,
          descriptor: { effect: descriptor.effect, operation: descriptor.operation, provider: descriptor.provider,
            target: descriptor.target, environment: descriptor.environment, reversibility: descriptor.reversibility,
            blastRadius: descriptor.blastRadius, hardGate: descriptor.hardGate || (verdict?.kind === "ask" && verdict.hardGate),
            reason: descriptor.reason },
          question: verdict?.kind === "ask" && !automatic ? verdict.reason : undefined,
          ruleScope: { projectId: work.projectId, workspaceId: binding.workspaceBinding, botId: binding.botId },
          actionHash, taskId: binding.taskId, operationId: input.operationId, toolName: input.toolName,
          summary: input.summary, detail: input.detail ?? "", requiredScope: input.actionKind, scopeMissing,
          intentRevision: work.intentRevision, inputSnapshotId: work.inputSnapshotId, ownerEpoch: work.ownerEpoch,
          status: possiblePriorEffect ? "invalidated" : denied ? "denied" : automatic ? "approved" : "pending", version: 1, createdAt: now,
          expiresAt: now + (this.options.ttlMs ?? 5 * 60_000),
          outcome: outsidePlan ? "continuation-outside-plan" : restriction
            ?? (denied ? (verdict?.kind === "deny" ? verdict.reason : "自动化策略拒绝此动作，未执行") : undefined),
          decision: decision && verdict ? { decisionId: decision.decisionId,
            source: verdict.kind === "allow" ? verdict.source : "policy",
            citedRuleIds: verdict.citedRuleIds,
            citedDecisionIds: verdict.kind === "allow" ? verdict.citedDecisionIds : [] } : undefined };
        this.db.prepare("INSERT OR IGNORE INTO work_action_approvals(approval_id,work_id,binding_id,operation_id,fingerprint,data_json) VALUES (?,?,?,?,?,?)")
          .run(approvalId, work.workId, binding.bindingId, input.operationId, fingerprint, JSON.stringify(value));
        if (input.deferrable && value.status === "pending") this.deferred.register(approvalId, {
          taskRoot: input.taskRoot ?? binding.workspaceBinding, toolName: input.toolName,
          arguments: z.record(z.string(), z.json()).parse(input.arguments), actionKind: input.actionKind,
          permissionMode: input.permissionMode,
          originalCall: { name: input.originalCall?.name ?? input.toolName, arguments: z.record(z.string(), z.json()).parse(input.originalCall?.arguments ?? input.arguments) },
          sourceConversationId: input.sourceConversationId, nativeContext: input.nativeContext,
        }, now);
        if (automatic) {
          grantedBy = verdict?.kind === "allow" ? verdict.source : "auto";
          this.touch(work.workId);
        }
        else this.block(value, denied ? (verdict?.kind === "deny" ? verdict.reason : restriction ?? "自动化策略拒绝此动作，未执行")
          : scopeMissing ? `缺少 ${input.actionKind} 授权；仅此工具动作可由你授权后继续，已完成步骤不重跑`
          : "后台操作等待你确认，超时会默认拒绝，未执行");
      });
      if (skipped) return { kind: "allow", source: skipped };
      stored = this.get(approvalId)!;
    }
    // P0-D：deferrable 调用方不占执行栈——动作以 not_started 挂起，稍后由
    // continuation 只恢复这一动作；默认调用方保持原有等待语义。
    if (input.deferrable) {
      this.recover();
      const value = this.get(approvalId)!.value;
      if (value.status === "approved" && this.current(value)) return { kind: "allow", source: grantedBy };
      if (value.status === "ignored") return { kind: "defer", approvalId, reason: "你已选择暂不处理该动作（未执行）" };
      if (value.status === "pending") {
        this.recordDeferredGap(value);
        return { kind: "defer", approvalId, reason: value.outcome ?? "等待你确认，该动作未执行" };
      }
      return { kind: "deny", reason: value.outcome ?? "该动作未获准执行" };
    }
    for (;;) {
      if (!this.options.isAuthority()) throw new Error("审批观察宿主已失去权威，保留请求等待原身份恢复");
      this.recover();
      const value = this.get(approvalId)!.value;
      if (value.status !== "pending") {
        if (value.status === "approved" && this.current(value)) return { kind: "allow", source: grantedBy };
        if (value.status === "ignored") return { kind: "defer", approvalId, reason: "你已选择暂不处理该动作（未执行）" };
        return { kind: "deny", reason: value.outcome ?? "该动作未获准执行" };
      }
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
      const mode = request.decision ?? (request.approved === false ? "deny" : "allow");
      const decision = JSON.stringify(request);
      if (row.decision_json === decision) return { ok: true, approval: value, replayed: true };
      if (mode !== "refresh" && value.status !== "pending") return { ok: false, code: "already_resolved", message: "审批已结束，不能再次执行" };
      if (value.version !== request.expectedVersion || work.stateVersion !== request.expectedStateVersion
        || work.intentRevision !== request.expectedIntentRevision || work.ownerEpoch !== request.expectedOwnerEpoch || !this.current(value))
        return { ok: false, code: "version_conflict", message: "事项或审批已变化，请刷新后重新判断" };
      if (mode === "refresh") {
        const deferred = this.deferred.get(value.approvalId);
        if (!deferred || !["expired", "ignored"].includes(value.status) || deferred.status !== "deferred" || request.saveRule)
          return { ok: false, code: "invalid_request", message: "该动作不能刷新：需要完整原始参数且确认从未执行；未知效果不能重放" };
        const fresh = { ...value, status: "pending" as const, version: value.version + 1,
          expiresAt: this.options.now() + (this.options.ttlMs ?? 5 * 60_000), resolvedAt: undefined, outcome: undefined };
        this.db.prepare("UPDATE work_action_approvals SET data_json=?,decision_json=? WHERE approval_id=?")
          .run(JSON.stringify(fresh), decision, value.approvalId);
        this.block(fresh, "原动作已重新展示，尚未授权执行");
        return { ok: true, approval: fresh, replayed: false };
      }
      if (mode === "allow" && value.scopeMissing && (!request.grantScopeOnce || !["workspace:read", "workspace:write"].includes(value.requiredScope)))
        return { ok: false, code: "invalid_request", message: "必须明确授权本次缺失的工作区范围；其他授权请通过事项配置处理" };
      if (request.saveRule && (mode !== "allow" || value.descriptor?.hardGate))
        return { ok: false, code: "invalid_request", message: "hard gate 或非允许决定不能保存为长期规则" };
      // “允许本次并保存规则”先把全部范围验证完，再写决定；任何失败都不得留下部分批准。
      let rule: Omit<WorkAutonomyRule, "ruleId" | "createdAt"> | undefined;
      if (mode === "allow" && request.saveRule) {
        const scope = request.saveRule === "project" ? { projectId: value.ruleScope?.projectId }
          : request.saveRule === "workspace" ? { workspaceId: value.ruleScope?.workspaceId }
          : undefined;
        if (!value.descriptor || !scope || !Object.values(scope).some(Boolean))
          return { ok: false, code: "invalid_request", message: request.saveRule === "repo"
            ? "该事项没有可信的仓库身份，不能保存仓库级规则"
            : "该事项没有可绑定的项目/工作区，不能保存长期规则" };
        if (!value.descriptor.target || !value.descriptor.provider)
          return { ok: false, code: "invalid_request", message: "该动作没有可精确绑定的目标，只能允许本次，不能保存为更宽的长期规则" };
        rule = { userId, botId: value.ruleScope?.botId, decision: "allow",
          reason: "你在审批卡上选择以后这样处理",
          // 规则只能覆盖这次看到的具体效果/操作/环境/目标，不能比已批准的动作更宽。
          scope: { ...scope, effect: [value.descriptor.effect], operation: [value.descriptor.operation],
            environment: [value.descriptor.environment], target: [value.descriptor.target],
            ...(value.descriptor.provider ? { provider: [value.descriptor.provider] } : {}) }, createdBy: "user" };
      }
      const next = this.settle(value, mode === "allow" ? "approved" : mode === "ignore" ? "ignored" : "denied",
        mode === "allow" ? "user-approved-once" : mode === "ignore" ? "user-ignored" : "user-denied");
      if (mode === "allow" && this.deferred.get(value.approvalId)) {
        if (!this.deferred.enqueue(value.approvalId, this.options.now())) throw new Error("原动作不能重复排队");
      }
      if (rule) this.ledger.addRule(rule);
      this.db.prepare("UPDATE work_action_approvals SET decision_json=? WHERE approval_id=?").run(decision, value.approvalId);
      return { ok: true, approval: next, replayed: false };
    });
  }

  deferredSource(approvalId: string): WorkActionApprovalDto | undefined { return this.get(approvalId)?.value; }

  claimDeferred(approvalId: string, attemptOperationId: string, expectedDeliveryId: string): boolean {
    return this.works.transaction(() => {
      this.recover();
      const value = this.get(approvalId)?.value, action = this.deferred.get(approvalId);
      if (!this.options.isAuthority() || !value || !action || action.status !== "queued"
        || action.deliveryId !== expectedDeliveryId || value.status !== "approved" || !this.current(value) || !this.citationsValid(value)
        || value.expiresAt <= this.options.now()) return false;
      if (this.works.repo.listAdmissions(value.workId).some(a => a.operationId === value.operationId
        && ["admitted", "unknown", "consumed"].includes(a.state))) return false;
      if (!deferredTargetUnchanged(action.payload)) {
        this.settle(value, "invalidated", "原动作的工作目录或文件实际目标已变化，动作未执行；请重新核对目标");
        return false;
      }
      const claimed = this.deferred.claim(approvalId, attemptOperationId, this.options.now());
      if (claimed) this.touch(value.workId);
      return claimed;
    });
  }
  finishDeferred(approvalId: string, outcome: "consumed" | "released" | "unknown", reason: string | undefined, expectedDeliveryId: string): void {
    this.works.transaction(() => {
      const action = this.deferred.get(approvalId), value = this.get(approvalId)?.value;
      if (!action || !value || action.deliveryId !== expectedDeliveryId || ["consumed", "invalidated"].includes(action.status)) return;
      if (action.attemptOperationId) this.settleAction(value.taskId, action.attemptOperationId, outcome);
      else {
        this.deferred.settle(approvalId, outcome === "released" ? "invalidated" : "unknown", this.options.now(), reason ?? "原生补跑没有可核对的结算回执，未重放");
        this.block(value, reason ?? "补跑受阻，需要核对原执行状态；没有重复执行");
      }
    });
  }
  permitsDeferred(bindingId: string, operationId: string, actionKind: string): boolean {
    return !!this.deferred.forOperation(operationId) && this.permits(bindingId, operationId, actionKind);
  }

  listAutonomyRules(userId: string) { return this.ledger.listRules(userId); }
  /** 撤销后立即重新评估尚未执行的动作，不等下一次请求或调度。 */
  revokeAutonomyRule(userId: string, ruleId: string): boolean {
    return this.works.transaction(() => {
      if (!this.ledger.revokeRule(ruleId, userId)) return false;
      this.recover();
      return true;
    });
  }

  approvedTaskAction(taskId: string, operationId: string, toolName: string): boolean | undefined {
    const binding = this.works.repo.bindingForTask(taskId); if (!binding) return undefined;
    const resumed = this.deferred.forOperation(operationId);
    const value = this.list(binding.workId).find(value => value.bindingId === binding.bindingId
      && (resumed ? value.approvalId === resumed.approvalId : value.operationId === operationId));
    return !!value && value.toolName === toolName && this.permits(binding.bindingId, operationId, value.requiredScope);
  }
  permits(bindingId: string, operationId: string, actionKind: string): boolean {
    this.ruleCache.clear();
    const deferred = this.deferred.forOperation(operationId);
    const row = deferred ? this.db.prepare("SELECT * FROM work_action_approvals WHERE approval_id=? AND binding_id=?").get(deferred.approvalId, bindingId)
      : this.db.prepare("SELECT * FROM work_action_approvals WHERE binding_id=? AND operation_id=?").get(bindingId, operationId);
    if (!row) return false;
    const value = workActionApprovalSchema.parse(JSON.parse(rowSchema.parse(row).data_json));
    if (deferred && deferred.status !== "running") return false;
    if (!deferred && this.deferred.state(value.approvalId)) return false;
    const admission = this.works.repo.listAdmissions(value.workId).find(a => a.operationId === operationId);
    if (admission && admission.state !== "admitted") return false;
    if (deferred && !admission && !deferredTargetUnchanged(deferred.payload)) return false;
    return value.status === "approved" && value.requiredScope === actionKind && this.current(value) && this.citationsValid(value)
      && (value.expiresAt > this.options.now() || admission?.state === "admitted" && admission.admittedAt < value.expiresAt);
  }
  settleAction(taskId: string, operationId: string, outcome: string): void {
    const binding = this.works.repo.bindingForTask(taskId); if (!binding) return;
    const deferred = this.deferred.forOperation(operationId);
    const value = this.list(binding.workId).find(value => value.bindingId === binding.bindingId
      && (deferred ? value.approvalId === deferred.approvalId : value.operationId === operationId));
    if (deferred && value) {
      this.deferred.settle(value.approvalId, outcome === "consumed" ? "consumed" : outcome === "released" ? "invalidated" : "unknown", this.options.now(),
        outcome === "released" ? "补跑没有执行；请核对原因，未自动重试" : outcome === "unknown" ? "原效果未知，禁止重放" : undefined);
      if (outcome !== "consumed") this.block(value, outcome === "released"
        ? "补跑动作未执行，需要核对原因；没有自动重试" : "补跑动作效果未知，等待原生回执核对；没有重放");
      if (outcome === "consumed") {
        this.works.partialResults.record(binding, [{ itemId: value.approvalId, task: value.summary, required: true,
          dependencies: [], criterionIds: [], nativeStatus: "host_approval_continuation_verified", outcome: "completed",
          artifactRefs: [], writeConflicts: [], summary: "批准后仅执行原动作，原生回执已结算", origin: "native" }], this.options.now());
        this.works.repo.clearBlocker(value.approvalId, value.workId, this.options.now());
      }
    }
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
      const deferred = this.deferred.get(value.approvalId);
      if (deferred && ["deferred", "queued"].includes(deferred.status)) this.deferred.settle(value.approvalId, "invalidated", this.options.now(), "work-stopped");
      this.works.repo.clearBlocker(value.approvalId, workId, this.options.now());
    }
  }
  /** Called on boot and by the background scheduler even with no renderer attached. */
  recover(): void {
    if (!this.options.isAuthority()) return;
    this.ruleCache.clear();
    this.works.transaction(() => {
      // Repair presentation flags from prior versions without clearing the blocker,
      // changing approval outcomes, or granting a fresh execution.
      const terminal = this.db.prepare(`SELECT a.* FROM work_action_approvals a
        JOIN work_blockers b ON b.blocker_id=a.approval_id
        WHERE b.status='open' AND b.waiting_for_user_input=1
        AND json_extract(a.data_json,'$.status') IN ('denied','expired','invalidated')`).all();
      const changed = new Set<string>();
      for (const row of terminal) {
        const value = workActionApprovalSchema.parse(JSON.parse(rowSchema.parse(row).data_json));
        this.db.prepare("UPDATE work_blockers SET waiting_for_user_input=0 WHERE blocker_id=? AND work_id=?")
          .run(value.approvalId, value.workId);
        changed.add(value.workId);
      }
      for (const workId of changed) this.touch(workId);
      for (const row of this.db.prepare("SELECT * FROM work_action_approvals WHERE json_extract(data_json,'$.status') IN ('pending','approved')").all()) {
        const value = workActionApprovalSchema.parse(JSON.parse(rowSchema.parse(row).data_json));
        // 已准入/未知/已消费的动作交给执行回执结算，不因时钟或规则变化假装回滚。
        const inFlight = this.works.repo.listAdmissions(value.workId)
          .some(a => (a.operationId === value.operationId || a.operationId === this.deferred.get(value.approvalId)?.attemptOperationId) && ["admitted", "unknown", "consumed"].includes(a.state));
        if (!this.current(value)) this.settle(value, "invalidated", "事项、负责人或执行身份已失效，未恢复原动作");
        // 撤销/过期后的规则不能再支撑已经放行但尚未执行的动作。
        else if (!inFlight && !this.citationsValid(value)) this.settle(value, "invalidated", "支撑该动作的授权规则已撤销或过期，未执行；需要重新确认");
        else if (!inFlight && value.expiresAt <= this.options.now()) this.settle(value, "expired", "审批超时，默认拒绝；该动作未执行");
      }
    });
  }
  /** 引用来源必须每次都复核：撤销/过期/被 supersede 后不再支持任何尚未执行的动作。 */
  private citationsValid(value: WorkActionApprovalDto): boolean {
    const decision = value.decision;
    if (!decision) return true;
    const work = this.works.getWork(value.workId);
    if (!work) return false;
    const active = this.activeRules(work.userId);
    return decision.citedRuleIds.every(ruleId => active.has(ruleId))
      && decision.citedDecisionIds.every(decisionId => this.ledger.isDecisionValid(decisionId, work.userId, active));
  }
  private activeRules(userId: string): Set<string> {
    const cached = this.ruleCache.get(userId);
    if (cached) return cached;
    const active = this.ledger.activeRuleIds(userId);
    this.ruleCache.set(userId, active);
    return active;
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
    const deferred = this.deferred.get(value.approvalId);
    if (deferred && status === "expired" && deferred.status === "queued")
      this.deferred.settle(value.approvalId, "deferred", this.options.now(), "批准已过期，重新展示并确认后才可补跑");
    if (deferred && ["invalidated", "denied"].includes(status) && ["deferred", "queued"].includes(deferred.status))
      this.deferred.settle(value.approvalId, "invalidated", this.options.now(), outcome);
    this.db.prepare("UPDATE work_action_approvals SET data_json=? WHERE approval_id=?").run(JSON.stringify(next), value.approvalId);
    if (status === "approved" || status === "consumed" && outcome === "consumed") {
      this.works.repo.clearBlocker(value.approvalId, value.workId, this.options.now());
      this.touch(value.workId);
    } else this.block(next, outcome === "user-ignored"
      ? "你选择暂不处理该动作：它没有被执行，也没有取消整个事项；其它步骤可以继续，不会重复询问"
      : `${outcome === "user-denied" ? "你已拒绝继续此操作" : outcome}。保留已完成步骤；没有重新提交整个任务。`);
    return next;
  }
  /** P0-D：暂缓的动作必须留下 not_started 缺口，后续批准才能定向补跑。 */
  private recordDeferredGap(value: WorkActionApprovalDto): void {
    const work = this.works.getWork(value.workId);
    if (!work || ["closing", "closed"].includes(work.lifecycle)) return;
    if (this.works.repo.listAdmissions(value.workId).some(a => a.operationId === value.operationId
      && ["admitted", "unknown", "consumed"].includes(a.state))) return;
    const binding = this.works.repo.getBinding(value.bindingId);
    if (!binding) return;
    if (this.works.partialResults.list(value.workId).some(item => item.itemId === value.approvalId)) return;
    this.works.transaction(() => this.works.partialResults.record(binding, [{ itemId: value.approvalId,
      task: `仅处理先前未执行的动作：${value.toolName}。${value.summary}\n${value.detail}。保留其他已完成步骤，不得重跑整个委托。`,
      required: true, dependencies: [], criterionIds: [], nativeStatus: "host_approval_not_started", outcome: "not_started",
      artifactRefs: [], writeConflicts: [], summary: "该动作已暂缓，未执行；等待主人决定", origin: "native" }], this.options.now()));
  }
  private block(value: WorkActionApprovalDto, reason: string): void {
    const work = this.works.getWork(value.workId);
    if (["workspace:read", "workspace:write"].includes(value.requiredScope)
      && ["denied", "ignored", "expired", "invalidated"].includes(value.status) && work && !["closing", "closed"].includes(work.lifecycle)
      && value.outcome !== "continuation-outside-plan" && !this.works.repo.listAdmissions(value.workId).some(a => a.operationId === value.operationId && ["admitted", "unknown", "consumed"].includes(a.state))) {
      const binding = this.works.repo.getBinding(value.bindingId);
      if (binding) this.works.partialResults.record(binding, [{ itemId: value.approvalId,
        task: `仅处理先前未执行的动作：${value.toolName}。${value.summary}\n${value.detail}。保留其他已完成步骤，不得重跑整个委托；缺少授权时仍需用户确认。`,
        required: true, dependencies: [], criterionIds: [], nativeStatus: "host_approval_not_started", outcome: "not_started",
        artifactRefs: [], writeConflicts: [], summary: reason, origin: "native" }], this.options.now());
    }
    const text = `${value.summary}：${reason}`;
    const waitingForUserInput = value.status === "pending";
    if (!this.works.repo.getBlocker(value.approvalId)) this.works.repo.insertBlocker({ blockerId: value.approvalId,
      workId: value.workId, kind: "operational", reason: text, waitingForUserInput, status: "open", createdAt: this.options.now() });
    else this.db.prepare("UPDATE work_blockers SET reason=?,waiting_for_user_input=?,status='open',cleared_at=NULL WHERE blocker_id=?").run(text, waitingForUserInput ? 1 : 0, value.approvalId);
    if (value.outcome === "continuation-outside-plan") this.works.repo.clearBlocker(value.approvalId, value.workId, this.options.now());
    this.touch(value.workId);
  }
  private touch(workId: string): void {
    const work = this.works.getWork(workId); if (!work) return;
    this.works.repo.updateWork({ ...work, stateVersion: work.stateVersion + 1, updatedAt: this.options.now() });
    this.works.emitCurrentProjection(workId);
  }
}
