import type Database from "better-sqlite3";
import type { WorkBudgetDto, WorkBudgetPolicyDto, WorkBudgetReservationDto, WorkDto } from "../../../shared/bot-work";
import type { WorkBudgetWindowDto } from "../../../shared/bot-work-phase4";
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
        this.block(work, window, message, now);
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
      const exhausted = this.works.repo.getBlocker("budget:exhausted");
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
      this.works.repo.updateReservation(reservationId, "released", this.now());
      this.db.prepare("UPDATE work_budget_requests SET metering='released',settled_at=? WHERE request_id=? OR attempt_identity=?")
        .run(this.now(), reservation.requestId ?? reservationId, reservation.attemptIdentity ?? "");
      this.reconcile(workId);
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
      this.block(work, this.summary(work.workId).window, result.message, now);
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
      const receiptKey = `gen:${input.taskId}:${input.conversationId}:${input.generationTaskId}`;
      const settled = this.db.prepare("SELECT 1 FROM work_budget_reservations WHERE receipt_key=?").get(receiptKey);
      if (settled) return { ok: true };
      const requests = this.requestsForGeneration(input.taskId, input.conversationId, input.generationTaskId)
        .filter(row => row.metering === "reserved");
      if (!requests.length) return { ok: true };
      const actual = (input.inputTokens ?? 0) + (input.outputTokens ?? 0) + (input.cacheReadTokens ?? 0) + (input.cacheWriteTokens ?? 0);
      const last = requests.at(-1)!;
      const lastReservation = this.works.repo.getReservation(last.request_id)
        ?? this.works.repo.listReservations(binding.workId).find(item => item.attemptIdentity === last.attempt_identity);
      if (!lastReservation) return { ok: true };
      this.db.prepare("UPDATE work_budget_reservations SET receipt_key=? WHERE reservation_id=?").run(receiptKey, lastReservation.reservationId);
      if (input.reported && Number.isSafeInteger(actual)) {
        this.commit(binding.workId, lastReservation.reservationId, actual);
        for (const earlier of requests.slice(0, -1)) {
          const reservation = this.works.repo.listReservations(binding.workId)
            .find(item => item.attemptIdentity === earlier.attempt_identity);
          if (reservation && reservation.state === "reserved") this.commit(binding.workId, reservation.reservationId, undefined);
        }
      } else {
        // Framework-synthesized zero, abort or missing usage is not proof of no consumption.
        for (const row of requests) {
          const reservation = this.works.repo.listReservations(binding.workId)
            .find(item => item.attemptIdentity === row.attempt_identity);
          if (reservation && reservation.state === "reserved") this.commit(binding.workId, reservation.reservationId, undefined);
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
      if (current.window.reservedTokens + current.window.unknownTokens > 0) return "仍有在途或未知用量，不能修改预算政策";
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
      this.db.prepare("UPDATE work_budget_windows SET status='closed',closed_at=? WHERE work_id=? AND status='open'")
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
      this.db.prepare("UPDATE work_budget_windows SET status='closed',closed_at=? WHERE work_id=? AND status='open'")
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
      if (current.reservedTokens + current.unknownTokens > 0) {
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
      let committed = 0, reserved = 0, unknown = 0, unknownCount = 0;
      for (const reservation of reservations) {
        if (reservation.windowId !== windowId) continue;
        if (reservation.state === "committed") committed += reservation.reportedTokens ?? reservation.tokens;
        else if (reservation.state === "reserved") reserved += reservation.tokens;
        else if (reservation.state === "unknown") { unknown += reservation.tokens; unknownCount++; }
      }
      if (unknownCount !== work.budget.unknownUsageCount) unknownCount = unknownCount;
      const status: WindowRow["status"] = existing.status === "closed" ? "closed"
        : committed + reserved + unknown >= existing.limit_tokens ? "exhausted" : "open";
      this.db.prepare(`UPDATE work_budget_windows SET committed_tokens=?,reserved_tokens=?,unknown_tokens=?,status=?
        WHERE window_id=?`).run(committed, reserved, unknown, status, windowId);
      const nextBudget: WorkBudgetDto = { ...work.budget, maxTokens: existing.limit_tokens,
        usedTokens: committed, reservedTokens: reserved + unknown, unknownUsageCount: unknownCount,
        windowStartAt: existing.period_start_at, windowExpiresAt: existing.period_end_at ?? undefined,
        allowNextWindow: Boolean(existing.auto_rollover) || work.budget.allowNextWindow,
        committedTokens: committed, unknownTokens: unknown,
        policyRevision: existing.policy_revision, windowTimezone: existing.timezone ?? work.budget.windowTimezone,
        autoRollover: Boolean(existing.auto_rollover) };
      if (JSON.stringify(nextBudget) !== JSON.stringify(work.budget)) this.works.repo.updateWork({ ...work, budget: nextBudget });
      return { window: this.toDto(this.window(windowId)!), reservations };
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
    return this.db.prepare(`SELECT * FROM work_budget_requests WHERE task_id=? AND conversation_id=?
      AND generation_task_id=? ORDER BY created_at ASC,rowid ASC`).all(taskId, conversationId, generationTaskId) as RequestRow[];
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
    };
  }

  private block(work: WorkDto, window: WorkBudgetWindowDto, message: string, now: number): void {
    const blockerId = "budget:exhausted";
    const existing = this.works.repo.getBlocker(blockerId);
    const details = { windowId: window.windowId, limitTokens: window.limitTokens, committedTokens: window.committedTokens,
      reservedTokens: window.reservedTokens, unknownTokens: window.unknownTokens, availableTokens: window.availableTokens };
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
