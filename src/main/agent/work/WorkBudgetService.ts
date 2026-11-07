import type Database from "better-sqlite3";
import type { WorkBudgetDto, WorkBudgetPolicyDto, WorkBudgetReservationDto, WorkControlErrorCode, WorkDto } from "../../../shared/bot-work";
import type { WorkBudgetWindowDto, WorkPhase4ControlRequest } from "../../../shared/bot-work-phase4";
import { newId } from "./WorkRepository";
import type { WorkService } from "./WorkService";

export interface WorkBudgetReserveInput {
  workId: string;
  reservationId: string;
  tokens: number;
  windowId?: string;
  requestKind?: WorkBudgetReservationDto["requestKind"];
  requestId?: string;
  bindingId?: string;
  attemptId?: string;
  attemptIdentity?: string;
  receiptKey?: string;
}

export interface WorkProviderRequestInput {
  taskId: string;
  conversationId: string;
  generationTaskId: number;
  sourceKind: "main" | "subagent";
  estimatedTokens: number;
  requestKind?: "generation" | "compaction" | "child" | "retry";
}

export interface WorkProviderUsageInput {
  taskId: string;
  conversationId: string;
  generationTaskId: number;
  /** `reported` distinguishes a trusted provider receipt from a framework-synthesized zero. */
  reported: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface WorkBudgetSummary {
  window: WorkBudgetWindowDto;
  reservations: WorkBudgetReservationDto[];
}

type ReconcileBudgetInput = Extract<WorkPhase4ControlRequest, { kind: "reconcile-budget-reservation" }>;
interface ReconcileBudgetActor { kind: "user" | "bot"; userId: string; botId?: string }

interface WindowRow {
  window_id: string;
  work_id: string;
  policy_revision: number;
  scope: "work" | "window";
  period_start_at: number;
  period_end_at: number | null;
  timezone: string | null;
  limit_tokens: number;
  auto_rollover: number;
  carry_policy: "none" | "outstanding";
  status: "open" | "closed" | "exhausted";
  committed_tokens: number;
  reserved_tokens: number;
  unknown_tokens: number;
  created_at: number;
  closed_at: number | null;
}

interface RequestRow {
  request_id: string;
  work_id: string;
  window_id: string;
  binding_id: string | null;
  task_id: string;
  conversation_id: string | null;
  generation_task_id: number | null;
  request_kind: string;
  attempt_identity: string;
  estimated_tokens: number;
  reported_tokens: number | null;
  metering: "reserved" | "reported" | "unknown" | "released";
  receipt_key: string | null;
  created_at: number;
  settled_at: number | null;
}

/**
 * The single Work budget authority.
 *
 * `available = limit - committed(actual) - reserved - unknown`. The legacy
 * `WorkDto.budget.reservedTokens` projection is always `reserved + unknown`; it is derived
 * from the reservation ledger in the same transaction and is never used as a second source.
 */
export class WorkBudgetService {
  constructor(private readonly db: Database.Database, private readonly works: WorkService,
    private readonly options: { now?: () => number; isAuthority?: () => boolean } = {}) {
    this.ensureTables();
  }

  private now(): number { return this.options.now ? this.options.now() : Date.now(); }

  private ensureTables(): void {
    // Phase 4 schema is installed by AppDatabase. This guard only keeps unit callers honest.
    const exists = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_budget_windows'").get();
    if (!exists) throw new Error("Work 预算窗口表尚未初始化");
  }

  policyOf(work: WorkDto): WorkBudgetPolicyDto {
    const policy: Partial<WorkBudgetPolicyDto> = work.budgetPolicy ?? {};
    return {
      policyRevision: policy.policyRevision ?? work.budget.policyRevision ?? 1,
      scope: policy.scope ?? "work",
      maxTokens: policy.maxTokens ?? work.budget.maxTokens,
      windowDurationMs: policy.windowDurationMs ?? work.budget.windowDurationMs,
      timezone: policy.timezone ?? work.budget.windowTimezone,
      autoRollover: policy.autoRollover ?? work.budget.autoRollover ?? work.budget.allowNextWindow,
      carryPolicy: policy.carryPolicy ?? "none",
    };
  }

  ensureWindow(work: WorkDto): WorkBudgetWindowDto {
    return this.works.transaction(() => {
      const policy = this.policyOf(work);
      const byId = this.window(work.budget.windowId);
      if (byId) return this.reconcile(work.workId).window;
      const atLimit = work.authorization.budgetLimitTokens;
      const limit = Math.max(0, Math.min(policy.maxTokens, atLimit ?? Number.MAX_SAFE_INTEGER));
      const periodStart = work.budget.windowStartAt;
      const periodEnd = work.budget.windowExpiresAt ?? (policy.windowDurationMs ? periodStart + policy.windowDurationMs : undefined);
      this.db.prepare(`INSERT OR IGNORE INTO work_budget_windows
        (window_id,work_id,policy_revision,scope,period_start_at,period_end_at,timezone,limit_tokens,
         auto_rollover,carry_policy,status,committed_tokens,reserved_tokens,unknown_tokens,created_at,closed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,'open',0,0,0,?,NULL)`).run(
        work.budget.windowId, work.workId, policy.policyRevision, policy.scope, periodStart, periodEnd ?? null,
        policy.timezone ?? null, limit, policy.autoRollover ? 1 : 0, policy.carryPolicy, this.now(),
      );
      return this.reconcile(work.workId).window;
    });
  }

  summary(workId: string): WorkBudgetSummary {
    const work = this.works.getWork(workId);
    if (!work) throw new Error("找不到 Work");
    const window = this.ensureWindow(work);
    return { window, reservations: this.works.repo.listReservations(workId) };
  }

  /** Read-only projection; never creates a window or reconciles during a journal read. */
  snapshot(workId: string): WorkBudgetWindowDto {
    const work = this.works.getWork(workId);
    if (!work) return { windowId: "unknown", policyRevision: 1, scope: "work", periodStartAt: 0, limitTokens: 0,
      committedTokens: 0, reservedTokens: 0, unknownTokens: 0, unknownUsageCount: 0, availableTokens: 0,
      autoRollover: false, carryPolicy: "none", status: "closed" };
    const row = this.window(work.budget.windowId);
    if (row) return this.toDto(row);
    const committed = work.budget.committedTokens ?? work.budget.usedTokens;
    const unknown = work.budget.unknownTokens ?? 0;
    const reserved = Math.max(0, work.budget.reservedTokens - unknown);
    return { windowId: work.budget.windowId, policyRevision: work.budget.policyRevision ?? 1, scope: "work",
      periodStartAt: work.budget.windowStartAt, periodEndAt: work.budget.windowExpiresAt,
      timezone: work.budget.windowTimezone, limitTokens: work.budget.maxTokens, committedTokens: committed,
      reservedTokens: reserved, unknownTokens: unknown, unknownUsageCount: work.budget.unknownUsageCount,
      availableTokens: Math.max(0, work.budget.maxTokens - committed - reserved - unknown),
      autoRollover: work.budget.autoRollover ?? work.budget.allowNextWindow, carryPolicy: "none", status: "open" };
  }

  availableTokens(workId: string): number | undefined {
    const work = this.works.getWork(workId);
    if (!work) return undefined;
    return this.summary(workId).window.availableTokens;
  }

  reserve(input: WorkBudgetReserveInput): { ok: true; reservation: WorkBudgetReservationDto } | { ok: false; code: "budget_exhausted" | "idempotency_conflict" | "not_found"; message: string } {
    const now = this.now();
    return this.works.transaction(() => {
      const work = this.works.getWork(input.workId);
      if (!work) return { ok: false as const, code: "not_found" as const, message: "找不到 Work" };
      if (!Number.isSafeInteger(input.tokens) || input.tokens < 0) return { ok: false as const, code: "budget_exhausted" as const, message: "预算预留额度无效" };
      const window = this.ensureWindow(work);
      const existing = this.works.repo.getReservation(input.reservationId);
      if (existing) {
        return existing.workId === work.workId && existing.tokens === input.tokens && existing.windowId === window.windowId
          ? { ok: true as const, reservation: existing }
          : { ok: false as const, code: "idempotency_conflict" as const, message: "预算预留身份已用于另一事项、窗口或额度" };
      }
      if (window.status !== "open") return { ok: false as const, code: "budget_exhausted" as const, message: "当前预算窗口已关闭" };
      if (window.periodEndAt !== undefined && window.periodEndAt <= now) {
        return { ok: false as const, code: "budget_exhausted" as const, message: "预算窗口已到期，等待合法的下一窗口" };
      }
      if (window.availableTokens < input.tokens) {
        const message = `预算不足：可用 ${window.availableTokens}，请求 ${input.tokens}`;
        this.block(work, window, message, now, input.tokens);
        return { ok: false as const, code: "budget_exhausted" as const, message };
      }
      const reservation: WorkBudgetReservationDto = {
        reservationId: input.reservationId, workId: work.workId, windowId: window.windowId, tokens: input.tokens,
        state: "reserved", createdAt: now, requestKind: input.requestKind ?? "dispatch",
        requestId: input.requestId, bindingId: input.bindingId, attemptId: input.attemptId,
        attemptIdentity: input.attemptIdentity, receiptKey: input.receiptKey, metering: "reserved",
      };
      this.works.repo.insertReservation(reservation);
      if (input.attemptIdentity) {
        this.db.prepare(`INSERT OR IGNORE INTO work_budget_requests
          (request_id,work_id,window_id,binding_id,task_id,conversation_id,generation_task_id,request_kind,
           attempt_identity,estimated_tokens,reported_tokens,metering,receipt_key,created_at,settled_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,NULL,'reserved',?,?,NULL)`).run(
          input.requestId ?? input.reservationId, work.workId, window.windowId, input.bindingId ?? null,
          this.taskIdFor(input.bindingId, input.attemptIdentity), null, null, input.requestKind ?? "generation",
          input.attemptIdentity, input.tokens, input.receiptKey ?? null, now,
        );
      }
      this.reconcile(work.workId);
      const exhausted = this.works.repo.getBlocker(this.blockerId(work.workId));
      if (exhausted?.status === "open") this.works.repo.clearBlocker(exhausted.blockerId, work.workId, now);
      return { ok: true as const, reservation };
    });
  }

  commit(workId: string, reservationId: string, reportedTokens?: number): { ok: boolean; message?: string } {
    const now = this.now();
    return this.works.transaction(() => {
      const work = this.works.getWork(workId);
      if (!work) return { ok: false, message: "找不到 Work" };
      const reservation = this.works.repo.getReservation(reservationId);
      if (!reservation || reservation.workId !== workId) return { ok: false, message: "找不到该事项的预算预留" };
      if (reservation.state === "committed" || reservation.state === "released") return { ok: true };
      if (reportedTokens === undefined) {
        if (reservation.state !== "unknown") this.works.repo.updateReservation(reservationId, "unknown", now);
        this.db.prepare("UPDATE work_budget_requests SET metering='unknown',settled_at=? WHERE request_id=? OR attempt_identity=?")
          .run(now, reservation.requestId ?? reservationId, reservation.attemptIdentity ?? "");
        this.reconcile(workId);
        return { ok: true };
      }
      if (!Number.isSafeInteger(reportedTokens) || reportedTokens < 0) return { ok: false, message: "用量必须是非负安全整数" };
      this.works.repo.updateReservation(reservationId, "committed", now, reportedTokens);
      this.db.prepare(`UPDATE work_budget_requests SET reported_tokens=?,metering='reported',settled_at=?
        WHERE request_id=? OR attempt_identity=?`).run(reportedTokens, now, reservation.requestId ?? reservationId,
        reservation.attemptIdentity ?? "");
      this.reconcile(workId);
      return { ok: true };
    });
  }

  release(workId: string, reservationId: string): { ok: boolean; message?: string } {
    return this.works.transaction(() => {
      const reservation = this.works.repo.getReservation(reservationId);
      if (!reservation || reservation.workId !== workId) return { ok: false, message: "找不到该事项的预算预留" };
      if (reservation.state === "committed") return { ok: false, message: "已结算用量不能释放" };
      if (reservation.state === "unknown") return { ok: false, message: "未知用量必须提供核实依据并通过受守卫对账，不能直接释放" };
      if (reservation.state === "released") return { ok: true };
      this.works.repo.updateReservation(reservationId, "released", this.now());
      this.db.prepare("UPDATE work_budget_requests SET metering='released',settled_at=? WHERE request_id=? OR attempt_identity=?")
        .run(this.now(), reservation.requestId ?? reservationId, reservation.attemptIdentity ?? "");
      this.reconcile(workId);
      return { ok: true };
    });
  }

  /** Called by the owner/user control entry; the receipt and this audit commit together. */
  reconcileUnknown(work: WorkDto, input: ReconcileBudgetInput, actor: ReconcileBudgetActor):
    { ok: true } | { ok: false; code: WorkControlErrorCode; message: string } {
    return this.works.transaction(() => {
      if (this.options.isAuthority && !this.options.isAuthority()) {
        return { ok: false, code: "unauthorized_actor", message: "当前宿主不是事项控制权威，拒绝对账" };
      }
      const current = this.works.getWork(work.workId);
      if (!current || current.workId !== input.workId) return { ok: false, code: "not_found", message: "找不到 Work" };
      if (actor.userId !== current.userId || (actor.kind === "bot" && actor.botId !== current.ownerBotId)) {
        return { ok: false, code: "unauthorized_actor", message: "只有当前主负责人或用户可以核销未知预算" };
      }
      if (input.versionGuard.expectedOwnerEpoch !== current.ownerEpoch) {
        return { ok: false, code: "epoch_mismatch", message: "负责人代次已变更，请重新核对预算" };
      }
      if (input.versionGuard.expectedStateVersion !== current.stateVersion
        || input.versionGuard.expectedIntentRevision !== current.intentRevision) {
        return { ok: false, code: "version_conflict", message: "事项版本已变更，请重新核对预算" };
      }
      if (!Number.isSafeInteger(input.reportedTokens) || input.reportedTokens < 0
        || !input.reason.trim() || !input.evidenceRef.trim()
        || (input.resolution === "released" && input.reportedTokens !== 0)) {
        return { ok: false, code: "invalid_request", message: "对账需要核实用量、原因和凭据；只有确认未消耗时才能释放" };
      }
      const reservation = this.works.repo.getReservation(input.reservationId);
      const window = this.window(input.windowId);
      if (!reservation || reservation.workId !== current.workId || reservation.windowId !== input.windowId
        || !window || window.work_id !== current.workId) {
        return { ok: false, code: "not_found", message: "找不到该事项及原窗口中的预算预留" };
      }
      if (reservation.state !== "unknown") {
        return { ok: false, code: "invalid_request", message: "该预留已结算或仍在执行，请刷新账本后核对" };
      }
      const now = this.now();
      this.works.repo.updateReservation(reservation.reservationId, input.resolution, now, input.reportedTokens);
      this.db.prepare(`UPDATE work_budget_requests SET reported_tokens=?,metering=?,settled_at=?
        WHERE work_id=? AND window_id=? AND (request_id=? OR attempt_identity=?)`).run(
        input.reportedTokens, input.resolution === "committed" ? "reported" : "released", now,
        current.workId, reservation.windowId, reservation.requestId ?? reservation.reservationId, reservation.attemptIdentity ?? "",
      );
      this.works.repo.insertEvidence({
        evidenceId: this.reconciliationEvidenceId(reservation.reservationId), workId: current.workId,
        criterionIds: [], kind: actor.kind === "user" ? "user_attestation" : "inspection",
        provenance: actor.kind === "user" ? "user" : "system", sourceRef: input.evidenceRef.trim(),
        inputSnapshotId: current.inputSnapshotId, intentRevision: current.intentRevision,
        detail: JSON.stringify({ operationId: input.operationId, actor, reservationId: reservation.reservationId,
          windowId: reservation.windowId, previousState: reservation.state, reservedTokens: reservation.tokens,
          resolution: input.resolution, reportedTokens: input.reportedTokens, reason: input.reason.trim(),
          evidenceRef: input.evidenceRef.trim(), versionGuard: input.versionGuard }), recordedAt: now,
      });
      this.reconcile(current.workId);
      const updated = this.works.getWork(current.workId)!;
      this.works.repo.updateWork({ ...updated, stateVersion: updated.stateVersion + 1, updatedAt: now });
      return { ok: true };
    });
  }

  /** Real provider boundary: one persisted attempt identity per actual request emission. */
  admitProviderRequest(input: WorkProviderRequestInput): { allowed: boolean; reservationId?: string; message?: string } {
    const binding = this.works.repo.bindingForTask(input.taskId);
    if (!binding) return { allowed: true };
    const work = this.works.getWork(binding.workId);
    if (!work) return { allowed: true };
    const now = this.now();
    const sequence = this.works.transaction(() => {
      this.db.prepare(`INSERT INTO work_budget_request_sequences(task_id,sequence) VALUES (?,0)
        ON CONFLICT(task_id) DO NOTHING`).run(input.taskId);
      this.db.prepare("UPDATE work_budget_request_sequences SET sequence=sequence+1 WHERE task_id=?").run(input.taskId);
      return (this.db.prepare("SELECT sequence FROM work_budget_request_sequences WHERE task_id=?").get(input.taskId) as { sequence: number }).sequence;
    });
    const attemptIdentity = `req:${input.taskId}:${sequence}`;
    const reservationId = `budget:${attemptIdentity}`;
    // The dispatch-level 4096 envelope is a pre-request guard, not a second charge. The
    // first real provider request replaces it with per-request allocations.
    const childAllocation = this.db.prepare("SELECT 1 FROM work_budget_requests WHERE binding_id=? LIMIT 1").get(binding.bindingId);
    if (!childAllocation && binding.reservationId) {
      const envelope = this.works.repo.getReservation(binding.reservationId);
      if (envelope?.state === "reserved" && (envelope.requestKind ?? "dispatch") === "dispatch") {
        this.works.repo.updateReservation(envelope.reservationId, "released", now);
        this.reconcile(binding.workId);
      }
    }
    const estimate = Math.max(1, Math.min(1_000_000, Math.ceil(input.estimatedTokens)));
    const result = this.reserve({ workId: work.workId, reservationId, tokens: estimate,
      requestKind: input.requestKind ?? (input.sourceKind === "subagent" ? "child" : "generation"),
      requestId: attemptIdentity, bindingId: binding.bindingId, attemptIdentity });
    if (!result.ok) {
      // The request never reached the provider; keep the reservation identity uncharged.
      this.block(work, this.summary(work.workId).window, result.message, now, estimate);
      return { allowed: false, message: result.message };
    }
    this.db.prepare(`UPDATE work_budget_requests SET task_id=?,conversation_id=?,generation_task_id=?
      WHERE request_id=?`).run(input.taskId, input.conversationId, input.generationTaskId, attemptIdentity);
    return { allowed: true, reservationId };
  }

  /**
   * Commit one trusted provider generation receipt. The same receipt is idempotent.
   * Earlier attempts of the same generation stay unknown: a retry may already be billed.
   */
  settleProviderUsage(input: WorkProviderUsageInput): { ok: boolean; message?: string } {
    return this.works.transaction(() => {
      const binding = this.works.repo.bindingForTask(input.taskId);
      if (!binding) return { ok: true };
      const work = this.works.getWork(binding.workId);
      if (!work) return { ok: true };
      const receiptKey = `gen:${input.taskId}:${input.conversationId}:${input.generationTaskId}`;
      const requests = this.requestsForGeneration(input.taskId, input.conversationId, input.generationTaskId);
      if (!requests.length) return { ok: true };
      const reservations = this.works.repo.listReservations(binding.workId);
      const reservationFor = (request: RequestRow) => reservations.find(item => item.attemptIdentity === request.attempt_identity);
      if (!input.reported) {
        // Framework-synthesized zero, abort or missing usage is not proof of no consumption.
        // Do not consume the receipt identity: a later trusted report must still reconcile it.
        for (const row of requests) {
          const reservation = reservationFor(row);
          if (reservation && reservation.state === "reserved") this.commit(binding.workId, reservation.reservationId, undefined);
        }
        return { ok: true };
      }
      const components = [input.inputTokens ?? 0, input.outputTokens ?? 0, input.cacheReadTokens ?? 0, input.cacheWriteTokens ?? 0];
      const actual = components.reduce((sum, value) => sum + value, 0);
      if (!components.every(value => Number.isSafeInteger(value) && value >= 0) || !Number.isSafeInteger(actual)) {
        return { ok: false, message: "供应商用量必须是非负安全整数，原预留继续保留" };
      }
      // Always bind a generation to its last actual request (or an already bound receipt),
      // including a request reconciled manually. Filtering terminal requests would assign a
      // late receipt to an earlier retry and charge the generation a second time.
      const target = reservations.find(item => item.receiptKey === receiptKey) ?? reservationFor(requests.at(-1)!);
      if (!target) return { ok: false, message: "找不到该供应商请求的预算预留" };
      const now = this.now();
      const receiptEvidenceId = `budget-provider-receipt:${receiptKey}`;
      const priorReceipt = this.works.repo.getEvidence(receiptEvidenceId);
      const reconciled = this.works.repo.getEvidence(this.reconciliationEvidenceId(target.reservationId));
      const previous = target.state === "released" ? 0 : target.reportedTokens;
      let committedTokens = actual;
      if (priorReceipt) {
        if (previous === actual) return { ok: true };
        // Conflicting trusted reports are retained, never summed or used to silently lower
        // consumption. Repeated reports with the same quantity remain idempotent.
        committedTokens = Math.max(previous ?? 0, actual);
        this.recordReceiptConflict(work, target, receiptKey, previous ?? 0, actual, "provider", now);
      } else {
        this.works.repo.insertEvidence({ evidenceId: receiptEvidenceId, workId: work.workId, criterionIds: [],
          kind: "tool_receipt", provenance: "system", sourceRef: receiptKey,
          inputSnapshotId: work.inputSnapshotId, intentRevision: work.intentRevision,
          detail: JSON.stringify({ receiptKey, reservationId: target.reservationId, windowId: target.windowId,
            attemptIdentity: target.attemptIdentity, reportedTokens: actual }), recordedAt: now });
        if (reconciled && previous !== actual) {
          this.recordReceiptConflict(work, target, receiptKey, previous ?? 0, actual, "reconciliation", now);
        }
      }
      if (target.state !== "committed" || target.reportedTokens !== committedTokens || target.receiptKey !== receiptKey) {
        this.works.repo.updateReservation(target.reservationId, "committed", now, committedTokens);
        this.db.prepare("UPDATE work_budget_reservations SET receipt_key=? WHERE reservation_id=?").run(receiptKey, target.reservationId);
        this.db.prepare(`UPDATE work_budget_requests SET reported_tokens=?,metering='reported',receipt_key=?,settled_at=?
          WHERE work_id=? AND window_id=? AND (request_id=? OR attempt_identity=?)`).run(
          committedTokens, receiptKey, now, work.workId, target.windowId, target.requestId ?? target.reservationId, target.attemptIdentity ?? "",
        );
      }
      for (const request of requests) {
        const reservation = reservationFor(request);
        if (reservation && reservation.reservationId !== target.reservationId && reservation.state === "reserved") {
          this.commit(binding.workId, reservation.reservationId, undefined);
        }
      }
      this.reconcile(binding.workId);
      return { ok: true };
    });
  }

  /** Persist an explicit user policy; existing usage/causality is never cleared. */
  setPolicy(work: WorkDto, input: { maxTokens: number; windowMs?: number; timezone?: string; autoRollover?: boolean }): WorkDto | string {
    return this.works.transaction(() => {
      const current = this.summary(work.workId);
      if (current.reservations.some(item => item.state === "reserved" || item.state === "unknown")) return "仍有在途或未知用量，不能修改预算政策";
      const authorizationLimit = work.authorization.budgetLimitTokens;
      const maxTokens = Math.min(input.maxTokens, authorizationLimit ?? Number.MAX_SAFE_INTEGER);
      if (!Number.isSafeInteger(maxTokens) || maxTokens < 0) return "预算上限必须是非负安全整数";
      const now = this.now();
      const nextRevision = (work.budgetPolicy?.policyRevision ?? work.budget.policyRevision ?? 1) + 1;
      const policy: WorkBudgetPolicyDto = { policyRevision: nextRevision, scope: "window",
        maxTokens, windowDurationMs: input.windowMs, timezone: input.timezone,
        autoRollover: Boolean(input.autoRollover) && input.windowMs !== undefined, carryPolicy: "none" };
      const windowId = `bw:${work.workId}:${nextRevision}:${now}`;
      const nextBudget: WorkBudgetDto = { ...work.budget, windowId, maxTokens, usedTokens: 0, reservedTokens: 0,
        unknownUsageCount: work.budget.unknownUsageCount, windowStartAt: now,
        windowExpiresAt: input.windowMs ? now + input.windowMs : undefined, allowNextWindow: policy.autoRollover,
        committedTokens: 0, unknownTokens: 0, policyRevision: nextRevision, windowTimezone: input.timezone,
        windowDurationMs: input.windowMs, autoRollover: policy.autoRollover };
      this.db.prepare("UPDATE work_budget_windows SET status='closed',closed_at=? WHERE work_id=? AND status!='closed'")
        .run(now, work.workId);
      this.db.prepare(`INSERT INTO work_budget_windows
        (window_id,work_id,policy_revision,scope,period_start_at,period_end_at,timezone,limit_tokens,
         auto_rollover,carry_policy,status,committed_tokens,reserved_tokens,unknown_tokens,created_at,closed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,'open',0,0,0,?,NULL)`).run(
        windowId, work.workId, nextRevision, policy.scope, now, nextBudget.windowExpiresAt ?? null,
        input.timezone ?? null, maxTokens, policy.autoRollover ? 1 : 0, policy.carryPolicy, now,
      );
      const next: WorkDto = { ...work, budget: nextBudget, budgetPolicy: policy, stateVersion: work.stateVersion + 1, updatedAt: now };
      this.works.repo.updateWork(next);
      return next;
    });
  }

  /** Explicit user/owner window open (legacy control path); still one persisted ledger row. */
  openExplicitWindow(work: WorkDto, input: { windowId: string; maxTokens: number; windowExpiresAt?: number; allowNextWindow: boolean }): WorkDto | string {
    return this.works.transaction(() => {
      if (!input.allowNextWindow) return "policy";
      if (this.works.repo.listReservations(work.workId).some(item => item.state === "reserved" || item.state === "unknown")) {
        return "仍有在途或未知用量，不能重置预算窗口";
      }
      const current = this.ensureWindow(work);
      if (current.committedTokens + current.reservedTokens + current.unknownTokens > 0
        && current.periodEndAt && current.periodEndAt > this.now()) return "当前预算窗口尚未结束";
      if (!Number.isSafeInteger(input.maxTokens) || input.maxTokens < 0) return "预算上限必须是非负安全整数";
      const limit = Math.min(input.maxTokens, work.authorization.budgetLimitTokens ?? Number.MAX_SAFE_INTEGER);
      const now = this.now();
      this.db.prepare("UPDATE work_budget_windows SET status='closed',closed_at=? WHERE work_id=? AND status!='closed'")
        .run(now, work.workId);
      this.db.prepare(`INSERT OR IGNORE INTO work_budget_windows
        (window_id,work_id,policy_revision,scope,period_start_at,period_end_at,timezone,limit_tokens,
         auto_rollover,carry_policy,status,committed_tokens,reserved_tokens,unknown_tokens,created_at,closed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,'open',0,0,0,?,NULL)`).run(
        input.windowId, work.workId, this.policyOf(work).policyRevision, "window", now,
        input.windowExpiresAt ?? null, work.budget.windowTimezone ?? null, limit, 0, "none", now,
      );
      const next: WorkDto = { ...work, budget: { ...work.budget, windowId: input.windowId, maxTokens: limit,
        usedTokens: 0, reservedTokens: 0, committedTokens: 0, unknownTokens: 0, windowStartAt: now,
        windowExpiresAt: input.windowExpiresAt, allowNextWindow: true },
        stateVersion: work.stateVersion + 1, updatedAt: now };
      this.works.repo.updateWork(next);
      return next;
    });
  }

  /**
   * Open the one legal next window. Skips missed periods instead of accumulating them.
   * Refuses while reservations/unknown usage from the old window remain.
   */
  rollover(work: WorkDto, now = this.now()): { ok: true; window: WorkBudgetWindowDto } | { ok: false; message: string } {
    return this.works.transaction(() => {
      const policy = this.policyOf(work);
      const current = this.ensureWindow(work);
      if (!policy.autoRollover || !policy.windowDurationMs) return { ok: false, message: "当前预算政策不允许自动续期" };
      if (current.periodEndAt === undefined) return { ok: false, message: "当前预算没有可续期的窗口边界" };
      if (now < current.periodEndAt) return { ok: false, message: "当前预算窗口尚未到期" };
      if (this.works.repo.listReservations(work.workId).some(item => item.state === "reserved" || item.state === "unknown")) {
        this.block(work, current, "上一窗口仍有在途或未知用量，不能自动发放新窗口额度", now);
        return { ok: false, message: "仍有在途或未知用量，需先对账" };
      }
      const periodStart = current.periodStartAt + Math.floor((now - current.periodStartAt) / policy.windowDurationMs) * policy.windowDurationMs;
      if (periodStart <= current.periodStartAt) return { ok: false, message: "时钟回拨或周期未推进，不重开窗口" };
      const windowId = `bw:${work.workId}:${policy.policyRevision}:${periodStart}`;
      const existing = this.window(windowId);
      if (existing) return { ok: true, window: this.toDto(existing) };
      this.db.prepare("UPDATE work_budget_windows SET status='closed',closed_at=? WHERE window_id=?").run(now, current.windowId);
      this.db.prepare(`INSERT INTO work_budget_windows
        (window_id,work_id,policy_revision,scope,period_start_at,period_end_at,timezone,limit_tokens,
         auto_rollover,carry_policy,status,committed_tokens,reserved_tokens,unknown_tokens,created_at,closed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,'open',0,0,0,?,NULL)`).run(
        windowId, work.workId, policy.policyRevision, policy.scope, periodStart, periodStart + policy.windowDurationMs,
        policy.timezone ?? null, current.limitTokens, policy.autoRollover ? 1 : 0, policy.carryPolicy, now,
      );
      const nextBudget: WorkBudgetDto = { ...work.budget, windowId, maxTokens: current.limitTokens, usedTokens: 0,
        reservedTokens: 0, committedTokens: 0, unknownTokens: 0, windowStartAt: periodStart,
        windowExpiresAt: periodStart + policy.windowDurationMs, allowNextWindow: true, policyRevision: policy.policyRevision,
        windowTimezone: policy.timezone, windowDurationMs: policy.windowDurationMs, autoRollover: true };
      this.works.repo.updateWork({ ...work, budget: nextBudget, stateVersion: work.stateVersion + 1, updatedAt: now });
      return { ok: true, window: this.reconcile(work.workId).window };
    });
  }

  /** Recompute window and Work projections from the reservation ledger in one transaction. */
  reconcile(workId: string): WorkBudgetSummary {
    return this.works.transaction(() => {
      const work = this.works.getWork(workId);
      if (!work) throw new Error("找不到 Work");
      const windowId = work.budget.windowId;
      const existing = this.window(windowId);
      if (!existing) throw new Error("预算窗口尚未创建");
      const reservations = this.works.repo.listReservations(workId);
      const totals = new Map<string, { committed: number; reserved: number; unknown: number; unknownCount: number }>();
      for (const reservation of reservations) {
        const total = totals.get(reservation.windowId) ?? { committed: 0, reserved: 0, unknown: 0, unknownCount: 0 };
        if (reservation.state === "committed") total.committed += reservation.reportedTokens ?? reservation.tokens;
        else if (reservation.state === "reserved") total.reserved += reservation.tokens;
        else if (reservation.state === "unknown") { total.unknown += reservation.tokens; total.unknownCount++; }
        totals.set(reservation.windowId, total);
      }
      // A trusted late receipt belongs to its original window, even after explicit
      // reconciliation allowed rollover. Rebuild historical rows without charging the new one.
      const windows = this.db.prepare("SELECT * FROM work_budget_windows WHERE work_id=?").all(workId) as WindowRow[];
      for (const window of windows) {
        const total = totals.get(window.window_id) ?? { committed: 0, reserved: 0, unknown: 0, unknownCount: 0 };
        const status: WindowRow["status"] = window.status === "closed" ? "closed"
          : total.committed + total.reserved + total.unknown >= window.limit_tokens ? "exhausted" : "open";
        if (window.committed_tokens !== total.committed || window.reserved_tokens !== total.reserved
          || window.unknown_tokens !== total.unknown || window.status !== status) {
          this.db.prepare(`UPDATE work_budget_windows SET committed_tokens=?,reserved_tokens=?,unknown_tokens=?,status=?
            WHERE window_id=? AND work_id=?`).run(total.committed, total.reserved, total.unknown, status, window.window_id, workId);
        }
      }
      const { committed, reserved, unknown, unknownCount } = totals.get(windowId)
        ?? { committed: 0, reserved: 0, unknown: 0, unknownCount: 0 };
      const nextBudget: WorkBudgetDto = { ...work.budget, maxTokens: existing.limit_tokens,
        usedTokens: committed, reservedTokens: reserved + unknown, unknownUsageCount: unknownCount,
        windowStartAt: existing.period_start_at, windowExpiresAt: existing.period_end_at ?? undefined,
        allowNextWindow: Boolean(existing.auto_rollover) || work.budget.allowNextWindow,
        committedTokens: committed, unknownTokens: unknown,
        policyRevision: existing.policy_revision, windowTimezone: existing.timezone ?? work.budget.windowTimezone,
        autoRollover: Boolean(existing.auto_rollover) };
      if (JSON.stringify(nextBudget) !== JSON.stringify(work.budget)) this.works.repo.updateWork({ ...work, budget: nextBudget });
      const window = this.toDto(this.window(windowId)!);
      const blocker = this.works.repo.getBlocker(this.blockerId(workId));
      if (blocker?.status === "open") {
        const required = blocker.details?.requestedTokens;
        const requestCanFit = blocker.details?.blockKind === "request" && typeof required === "number"
          && window.status === "open" && (window.periodEndAt === undefined || window.periodEndAt > this.now())
          && window.availableTokens >= required;
        const rolloverCompleted = blocker.details?.blockKind === "rollover" && blocker.windowId !== window.windowId;
        // Merely reading a nonempty budget is not proof the refused request can fit.
        // Clear only after sufficient ledger capacity or a completed window transition.
        if (requestCanFit || rolloverCompleted) this.works.repo.clearBlocker(blocker.blockerId, workId, this.now());
      }
      return { window, reservations };
    });
  }

  listWindows(workId: string): WorkBudgetWindowDto[] {
    return (this.db.prepare("SELECT * FROM work_budget_windows WHERE work_id=? ORDER BY period_start_at DESC").all(workId) as WindowRow[])
      .map(row => this.toDto(row));
  }

  listRequests(workId: string): RequestRow[] {
    return this.db.prepare("SELECT * FROM work_budget_requests WHERE work_id=? ORDER BY created_at DESC,rowid DESC")
      .all(workId) as RequestRow[];
  }

  private requestsForGeneration(taskId: string, conversationId: string, generationTaskId: number): RequestRow[] {
    // Wall-clock timestamps can move backwards between attempts. The serialized
    // insertion order is the persisted request emission order, including after restart.
    return this.db.prepare(`SELECT * FROM work_budget_requests WHERE task_id=? AND conversation_id=?
      AND generation_task_id=? ORDER BY rowid ASC`).all(taskId, conversationId, generationTaskId) as RequestRow[];
  }

  private taskIdFor(bindingId: string | undefined, attemptIdentity: string): string {
    if (bindingId) {
      const binding = this.works.repo.getBinding(bindingId);
      if (binding) return binding.taskId;
    }
    return attemptIdentity.split(":")[1] ?? "unknown-task";
  }

  private window(windowId: string): WindowRow | undefined {
    return this.db.prepare("SELECT * FROM work_budget_windows WHERE window_id=?").get(windowId) as WindowRow | undefined;
  }

  private toDto(row: WindowRow): WorkBudgetWindowDto {
    const reservations = this.works.repo.listReservations(row.work_id).filter(item => item.windowId === row.window_id);
    return {
      windowId: row.window_id, policyRevision: row.policy_revision, scope: row.scope,
      periodStartAt: row.period_start_at, periodEndAt: row.period_end_at ?? undefined,
      timezone: row.timezone ?? undefined, limitTokens: row.limit_tokens,
      committedTokens: row.committed_tokens, reservedTokens: row.reserved_tokens, unknownTokens: row.unknown_tokens,
      unknownUsageCount: reservations.filter(item => item.state === "unknown").length,
      availableTokens: Math.max(0, row.limit_tokens - row.committed_tokens - row.reserved_tokens - row.unknown_tokens),
      autoRollover: Boolean(row.auto_rollover), carryPolicy: row.carry_policy, status: row.status,
      pendingRollover: row.auto_rollover && row.period_end_at !== null && row.period_end_at <= this.now()
        && row.status !== "closed" && reservations.some(item => item.state === "reserved" || item.state === "unknown")
        ? "上一窗口仍有在途或未知用量，需先对账" : undefined,
      unknownReservations: reservations.filter(item => item.state === "unknown").map(item => ({
        reservationId: item.reservationId, windowId: item.windowId, tokens: item.tokens,
        requestKind: item.requestKind, requestId: item.requestId, bindingId: item.bindingId,
        attemptIdentity: item.attemptIdentity, createdAt: item.createdAt,
      })),
    };
  }

  private reconciliationEvidenceId(reservationId: string): string { return `budget-reconciliation:${reservationId}`; }
  private blockerId(workId: string): string { return `budget:exhausted:${workId}`; }

  private recordReceiptConflict(work: WorkDto, reservation: WorkBudgetReservationDto, receiptKey: string,
    previousTokens: number, reportedTokens: number, source: "provider" | "reconciliation", now: number): void {
    const evidenceId = `budget-receipt-conflict:${receiptKey}:${reportedTokens}`;
    if (this.works.repo.getEvidence(evidenceId)) return;
    const details = { reservationId: reservation.reservationId, windowId: reservation.windowId, receiptKey,
      previousTokens, reportedTokens, previousState: reservation.state, source,
      reconciliationEvidenceId: source === "reconciliation" ? this.reconciliationEvidenceId(reservation.reservationId) : undefined };
    this.works.repo.insertEvidence({ evidenceId, workId: work.workId, criterionIds: [], kind: "tool_receipt",
      provenance: "system", sourceRef: receiptKey, inputSnapshotId: work.inputSnapshotId,
      intentRevision: work.intentRevision, detail: JSON.stringify(details), recordedAt: now });
    // One open blocker per Work/reason is a schema invariant. Each conflicting receipt
    // keeps its own immutable evidence; the blocker aggregates only bounded references.
    const blockerId = `budget:receipt-conflict:${work.workId}`;
    const existing = this.works.repo.getBlocker(blockerId);
    const previousCount = existing?.details?.conflictCount;
    const previousEvidence = existing?.details?.recentEvidenceIds;
    const recentEvidenceIds = Array.isArray(previousEvidence)
      ? previousEvidence.filter((item): item is string => typeof item === "string").slice(-19) : [];
    const blockerDetails = { ...details,
      conflictCount: typeof previousCount === "number" && Number.isSafeInteger(previousCount) ? previousCount + 1 : 1,
      recentEvidenceIds: [...recentEvidenceIds, evidenceId] };
    const reason = source === "reconciliation"
      ? "供应商迟到回执与显式核销不一致，已将实际用量记回原窗口，请核对凭据"
      : "同一供应商回执报告了不同用量，按较高值记账并保留冲突证据，请核对凭据";
    if (!existing) {
      this.works.repo.insertBlocker({ blockerId, workId: work.workId, kind: "operational",
        reasonCode: "budget-reconciliation-conflict", reason, details: blockerDetails, windowId: reservation.windowId,
        sourceRef: evidenceId, waitingForUserInput: true, status: "open", createdAt: now });
    } else {
      this.db.prepare(`UPDATE work_blockers SET reason=?,details_json=?,source_ref=?,window_id=?,status='open',cleared_at=NULL
        WHERE blocker_id=? AND work_id=?`).run(reason, JSON.stringify(blockerDetails), evidenceId, reservation.windowId, blockerId, work.workId);
    }
  }

  private block(work: WorkDto, window: WorkBudgetWindowDto, message: string, now: number, requestedTokens?: number): void {
    const blockerId = this.blockerId(work.workId);
    const existing = this.works.repo.getBlocker(blockerId);
    const details = { windowId: window.windowId, limitTokens: window.limitTokens, committedTokens: window.committedTokens,
      reservedTokens: window.reservedTokens, unknownTokens: window.unknownTokens, availableTokens: window.availableTokens,
      blockKind: requestedTokens === undefined ? "rollover" : "request", requestedTokens };
    if (!existing) this.works.repo.insertBlocker({ blockerId, workId: work.workId, kind: "operational",
      reasonCode: "budget-exhausted", reason: message, details, windowId: window.windowId,
      waitingForUserInput: true, status: "open", createdAt: now });
    else this.db.prepare("UPDATE work_blockers SET reason=?,details_json=?,window_id=?,status='open',cleared_at=NULL WHERE blocker_id=?")
      .run(message, JSON.stringify(details), window.windowId, blockerId);
  }
}

export function budgetReservationId(kind: string): string {
  return `budget:${kind}:${newId("r")}`;
}
