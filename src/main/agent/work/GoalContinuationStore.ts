import type Database from "better-sqlite3";
import type {
  ConversationGoalContinuationDto,
  GoalContinuationDeferReason,
  GoalContinuationState,
} from "../../../shared/conversation-goal";
import { enqueueWorkOp, overlayFindAll, overlayMutate, overlayReadOne, overlaySet, requiresWorkRustWrites, workDomainRunTx } from "./WorkDomainRuntime";

/**
 * Ledger of host-side Goal continuations.
 *
 * Work stays the single completion authority. This table only records how many
 * host-pointed turns were spent, what they measured, and why the host stopped.
 * It is an additive table, so the database schema version is not bumped; a stale
 * `igniting` row is reconciled on restart instead of being replayed.
 *
 * Invariants:
 * - one live row per Work; Work closing leaves the row for audit but stops ignition;
 * - `attempts` moves only when the host actually submits;
 * - `tokens_used` moves only by measured deltas, never by an estimate;
 * - `usage_cursor` never moves backwards (an unmeasured newer record cannot
 *   manufacture a negative delta or refund spent budget).
 */
export interface GoalContinuationRow {
  workId: string;
  taskId: string;
  intentRevision: number;
  attempts: number;
  /** Monotonic submission identity, never reset: request ids must stay unique
   * across an explicit "continue" that resets the visible attempt window. */
  attemptSerial: number;
  tokensUsed: number;
  tokenBudget: number | null;
  usageCursor: number;
  progressFingerprint: string | null;
  progressStalls: number;
  runCursor: number;
  lastTokenAt: number | null;
  lastContinuationAt: number | null;
  state: GoalContinuationState;
  deferReason: GoalContinuationDeferReason | null;
  deferredAt: number | null;
  updatedAt: number;
}

interface RawRow {
  work_id: string;
  task_id: string;
  intent_revision: number;
  attempts: number;
  attempt_serial: number;
  tokens_used: number;
  tokens_budget: number | null;
  usage_cursor: number;
  progress_fingerprint: string | null;
  progress_stalls: number;
  run_cursor: number;
  last_token_at: number | null;
  last_continuation_at: number | null;
  state: GoalContinuationState;
  defer_reason: GoalContinuationDeferReason | null;
  deferred_at: number | null;
  updated_at: number;
}

const DEFER_REASONS: readonly GoalContinuationDeferReason[] = [
  "user_interrupt", "turn_aborted", "run_failed", "restart", "no_progress",
  "manual_stop", "attempts", "budget",
];

function ensureTables(db: Database.Database): void {
  if (db.readonly) return;
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_goal_continuations (
    work_id TEXT PRIMARY KEY REFERENCES works(work_id) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    intent_revision INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    attempt_serial INTEGER NOT NULL DEFAULT 0,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    tokens_budget INTEGER,
    time_used_seconds INTEGER NOT NULL DEFAULT 0,
    usage_cursor INTEGER NOT NULL DEFAULT 0,
    progress_fingerprint TEXT,
    progress_stalls INTEGER NOT NULL DEFAULT 0,
    run_cursor INTEGER NOT NULL DEFAULT 0,
    last_token_at INTEGER,
    last_continuation_at INTEGER,
    state TEXT NOT NULL DEFAULT 'idle'
      CHECK (state IN ('idle','igniting','deferred','exhausted')),
    defer_reason TEXT
      CHECK (defer_reason IS NULL OR defer_reason IN
        ('user_interrupt','turn_aborted','run_failed','restart','no_progress','manual_stop','attempts','budget')),
    deferred_at INTEGER,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_goal_continuations_task
    ON conversation_goal_continuations(task_id, state);
  CREATE TABLE IF NOT EXISTS conversation_goal_usage_events (
    event_key TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    tokens INTEGER NOT NULL,
    recorded_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_goal_usage_task ON conversation_goal_usage_events(task_id);
  CREATE TABLE IF NOT EXISTS conversation_goal_last_check (
    work_id TEXT PRIMARY KEY REFERENCES conversation_goal_continuations(work_id) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    intent_revision INTEGER NOT NULL,
    trigger TEXT NOT NULL CHECK(trigger IN ('settled','resumed','continued')),
    reason TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS conversation_goal_last_wake (
    work_id TEXT PRIMARY KEY REFERENCES conversation_goal_continuations(work_id) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    intent_revision INTEGER NOT NULL,
    trigger TEXT NOT NULL CHECK(trigger IN ('settled','resumed','continued')),
    at INTEGER NOT NULL
  );`);
  // Defensive only: an earlier dev build may have created this table without the
  // later progress columns. The product database policy does not keep old formats.
  const columns = new Set((db.prepare("PRAGMA table_info(conversation_goal_continuations)").all() as Array<{ name: string }>)
    .map(column => column.name));
  if (!columns.has("progress_stalls")) db.exec("ALTER TABLE conversation_goal_continuations ADD COLUMN progress_stalls INTEGER NOT NULL DEFAULT 0");
  if (!columns.has("run_cursor")) db.exec("ALTER TABLE conversation_goal_continuations ADD COLUMN run_cursor INTEGER NOT NULL DEFAULT 0");
  if (!columns.has("attempt_serial")) db.exec("ALTER TABLE conversation_goal_continuations ADD COLUMN attempt_serial INTEGER NOT NULL DEFAULT 0");
}

function rowOf(raw: RawRow | undefined): GoalContinuationRow | undefined {
  if (!raw) return undefined;
  // The CHECK constraint should already reject unknown reasons; if an older
  // database slipped through, keep the row readable without trusting the value.
  const deferReason = DEFER_REASONS.includes(raw.defer_reason as GoalContinuationDeferReason) ? raw.defer_reason : null;
  return {
    workId: raw.work_id, taskId: raw.task_id, intentRevision: raw.intent_revision,
    attempts: raw.attempts, attemptSerial: raw.attempt_serial, tokensUsed: raw.tokens_used, tokenBudget: raw.tokens_budget,
    usageCursor: raw.usage_cursor, progressFingerprint: raw.progress_fingerprint,
    progressStalls: raw.progress_stalls, runCursor: raw.run_cursor,
    lastTokenAt: raw.last_token_at, lastContinuationAt: raw.last_continuation_at,
    state: raw.state, deferReason, deferredAt: raw.deferred_at,
    updatedAt: raw.updated_at,
  };
}

export class GoalContinuationStore {
  constructor(private readonly db: Database.Database) { ensureTables(db); }

  private getRaw(workId: string): RawRow | undefined {
    return overlayReadOne<RawRow & Record<string, unknown>>(this.db, "conversation_goal_continuations", workId, () =>
      this.db.prepare("SELECT * FROM conversation_goal_continuations WHERE work_id=?").get(workId) as (RawRow & Record<string, unknown>) | undefined);
  }

  private saveRaw(raw: RawRow): GoalContinuationRow {
    const row = { ...raw } as RawRow & Record<string, unknown>;
    overlaySet(this.db, "conversation_goal_continuations", raw.work_id, row);
    enqueueWorkOp(this.db, {
      op: "goalContinuationUpsert",
      workId: raw.work_id,
      taskId: raw.task_id,
      intentRevision: raw.intent_revision,
      attempts: raw.attempts,
      attemptSerial: raw.attempt_serial,
      tokensUsed: raw.tokens_used,
      tokensBudget: raw.tokens_budget,
      timeUsedSeconds: Number(row.time_used_seconds ?? 0),
      usageCursor: raw.usage_cursor,
      progressFingerprint: raw.progress_fingerprint,
      progressStalls: raw.progress_stalls,
      runCursor: raw.run_cursor,
      lastTokenAt: raw.last_token_at,
      lastContinuationAt: raw.last_continuation_at,
      state: raw.state,
      deferReason: raw.defer_reason,
      deferredAt: raw.deferred_at,
      updatedAt: raw.updated_at,
    });
    return rowOf(raw)!;
  }

  get(workId: string): GoalContinuationRow | undefined {
    return rowOf(this.getRaw(workId));
  }

  lastCheck(row: GoalContinuationRow): ConversationGoalContinuationDto["lastCheck"] {
    const stored = overlayReadOne<{ task_id: string; intent_revision: number; trigger: "settled" | "resumed" | "continued"; reason: string; at: number }>(
      this.db, "conversation_goal_last_check", row.workId,
      () => this.db.prepare(`SELECT work_id, task_id, intent_revision, trigger, reason, at FROM conversation_goal_last_check
        WHERE work_id=?`).get(row.workId) as { work_id: string; task_id: string; intent_revision: number; trigger: "settled" | "resumed" | "continued"; reason: string; at: number } | undefined);
    if (!stored || stored.task_id !== row.taskId || stored.intent_revision !== row.intentRevision) return undefined;
    return { trigger: stored.trigger, reason: stored.reason, at: stored.at };
  }

  lastWake(row: GoalContinuationRow): ConversationGoalContinuationDto["lastWake"] {
    const stored = overlayReadOne<{ task_id: string; intent_revision: number; trigger: "settled" | "resumed" | "continued"; at: number }>(
      this.db, "conversation_goal_last_wake", row.workId,
      () => this.db.prepare(`SELECT work_id, task_id, intent_revision, trigger, at FROM conversation_goal_last_wake
        WHERE work_id=?`).get(row.workId) as { work_id: string; task_id: string; intent_revision: number; trigger: "settled" | "resumed" | "continued"; at: number } | undefined);
    if (!stored || stored.task_id !== row.taskId || stored.intent_revision !== row.intentRevision) return undefined;
    return { trigger: stored.trigger, at: stored.at };
  }

  recordWake(workId: string, taskId: string, intentRevision: number,
    wake: NonNullable<ConversationGoalContinuationDto["lastWake"]>): void {
    if (requiresWorkRustWrites(this.db)) {
      const existing = this.getRaw(workId);
      if (!existing || existing.task_id !== taskId || existing.intent_revision !== intentRevision) return;
      overlaySet(this.db, "conversation_goal_last_wake", workId, {
        work_id: workId, task_id: taskId, intent_revision: intentRevision, trigger: wake.trigger, at: wake.at,
      });
      enqueueWorkOp(this.db, { op: "goalWakeUpsert", workId, taskId, intentRevision, trigger: wake.trigger, at: wake.at });
      return;
    }
    this.db.prepare(`INSERT INTO conversation_goal_last_wake(work_id,task_id,intent_revision,trigger,at)
      SELECT work_id,task_id,intent_revision,?,? FROM conversation_goal_continuations
      WHERE work_id=? AND task_id=? AND intent_revision=?
      ON CONFLICT(work_id) DO UPDATE SET task_id=excluded.task_id,intent_revision=excluded.intent_revision,
        trigger=excluded.trigger,at=excluded.at`)
      .run(wake.trigger, wake.at, workId, taskId, intentRevision);
  }

  recordCheck(workId: string, taskId: string, intentRevision: number,
    check: NonNullable<ConversationGoalContinuationDto["lastCheck"]>): void {
    if (requiresWorkRustWrites(this.db)) {
      const existing = this.getRaw(workId);
      if (!existing || existing.task_id !== taskId || existing.intent_revision !== intentRevision) return;
      overlaySet(this.db, "conversation_goal_last_check", workId, {
        work_id: workId, task_id: taskId, intent_revision: intentRevision, trigger: check.trigger, reason: check.reason, at: check.at,
      });
      enqueueWorkOp(this.db, { op: "goalCheckUpsert", workId, taskId, intentRevision, trigger: check.trigger, reason: check.reason, at: check.at });
      return;
    }
    this.db.prepare(`INSERT INTO conversation_goal_last_check(work_id,task_id,intent_revision,trigger,reason,at)
      SELECT work_id,task_id,intent_revision,?,?,? FROM conversation_goal_continuations
      WHERE work_id=? AND task_id=? AND intent_revision=?
      ON CONFLICT(work_id) DO UPDATE SET task_id=excluded.task_id,intent_revision=excluded.intent_revision,
        trigger=excluded.trigger,reason=excluded.reason,at=excluded.at`)
      .run(check.trigger, check.reason, check.at, workId, taskId, intentRevision);
  }

  /** Create the row (or adopt a new requirement revision) with the current usage watermark. */
  ensure(input: { workId: string; taskId: string; intentRevision: number }, usageCursor: number, now: number): GoalContinuationRow {
    const rust = requiresWorkRustWrites(this.db);
    const raw = this.getRaw(input.workId);
    if (!raw) {
      if (rust) {
        return this.saveRaw({
          work_id: input.workId, task_id: input.taskId, intent_revision: input.intentRevision,
          attempts: 0, attempt_serial: 0, tokens_used: 0, tokens_budget: null,
          time_used_seconds: 0,
          usage_cursor: usageCursor, progress_fingerprint: null, progress_stalls: 0, run_cursor: 0,
          last_token_at: null, last_continuation_at: null,
          state: "idle", defer_reason: null, deferred_at: null, updated_at: now,
        } as RawRow);
      }
      this.db.prepare(`INSERT INTO conversation_goal_continuations(work_id,task_id,intent_revision,usage_cursor,updated_at)
        VALUES (?,?,?,?,?)
        ON CONFLICT(work_id) DO NOTHING`)
        .run(input.workId, input.taskId, input.intentRevision, usageCursor, now);
      return this.get(input.workId)!;
    }
    if (raw.intent_revision !== input.intentRevision) {
      // A new requirement is a new accounting window: the user changed the goal,
      // so spent attempts and a stale no-progress stall no longer describe it.
      if (rust) {
        return this.saveRaw({
          ...raw,
          task_id: input.taskId, intent_revision: input.intentRevision,
          attempts: 0, tokens_used: 0, usage_cursor: Math.max(raw.usage_cursor, usageCursor),
          progress_fingerprint: null, progress_stalls: 0, run_cursor: 0,
          state: "idle", defer_reason: null, deferred_at: null, updated_at: now,
        });
      }
      this.db.prepare(`UPDATE conversation_goal_continuations
        SET task_id=?, intent_revision=?, attempts=0, tokens_used=0, usage_cursor=?,
            progress_fingerprint=NULL, progress_stalls=0, run_cursor=0,
            state='idle', defer_reason=NULL, deferred_at=NULL, updated_at=?
        WHERE work_id=?`)
        .run(input.taskId, input.intentRevision, Math.max(raw.usage_cursor, usageCursor), now, input.workId);
      return this.get(input.workId)!;
    }
    if (raw.task_id !== input.taskId) {
      // A branch/renamed conversation continues the same requirement. Moving the
      // anchor must not silently reset attempts or the budget window.
      if (rust) return this.saveRaw({ ...raw, task_id: input.taskId, updated_at: now });
      this.db.prepare("UPDATE conversation_goal_continuations SET task_id=?, updated_at=? WHERE work_id=?")
        .run(input.taskId, now, input.workId);
      return this.get(input.workId)!;
    }
    return rowOf(raw)!;
  }

  /** Reserve the attempt number before submitting, so the request id is stable across retries.
   * `attempt` is the visible window (resettable), `serial` the monotonic submission identity. */
  beginAttempt(workId: string, runCursor: number, fingerprint: string, now: number): { attempt: number; serial: number } {
    return workDomainRunTx(this.db, () => {
      if (requiresWorkRustWrites(this.db)) {
        const raw = this.getRaw(workId);
        if (!raw) return { attempt: 0, serial: 0 };
        const updated = this.saveRaw({
          ...raw,
          attempts: raw.attempts + 1, attempt_serial: raw.attempt_serial + 1,
          state: "igniting", defer_reason: null, deferred_at: null,
          run_cursor: runCursor, progress_fingerprint: fingerprint,
          last_continuation_at: now, updated_at: now,
        });
        return { attempt: updated.attempts, serial: updated.attemptSerial };
      }
      this.db.prepare(`UPDATE conversation_goal_continuations
        SET attempts=attempts+1, attempt_serial=attempt_serial+1, state='igniting', defer_reason=NULL, deferred_at=NULL,
            run_cursor=?, progress_fingerprint=?, last_continuation_at=?, updated_at=?
        WHERE work_id=?`).run(runCursor, fingerprint, now, now, workId);
      const row = this.get(workId);
      return { attempt: row?.attempts ?? 0, serial: row?.attemptSerial ?? 0 };
    });
  }

  /** The host never retries a submission it failed to admit; give the attempt back. */
  rollbackAttempt(workId: string, now: number): void {
    if (requiresWorkRustWrites(this.db)) {
      const raw = this.getRaw(workId);
      if (!raw) return;
      this.saveRaw({
        ...raw,
        state: "deferred", defer_reason: "run_failed", deferred_at: now, updated_at: now,
        attempts: raw.attempts > 0 ? raw.attempts - 1 : 0,
      });
      return;
    }
    this.defer(workId, "run_failed", now);
    this.db.prepare(`UPDATE conversation_goal_continuations
      SET attempts=CASE WHEN attempts > 0 THEN attempts-1 ELSE 0 END WHERE work_id=?`).run(workId);
  }

  /** A settle for a host-pointed run returns the ledger to idle before the next decision. */
  settleRun(workId: string): void {
    if (requiresWorkRustWrites(this.db)) {
      const raw = this.getRaw(workId);
      if (raw && raw.state === "igniting") this.saveRaw({ ...raw, state: "idle" });
      return;
    }
    this.db.prepare("UPDATE conversation_goal_continuations SET state='idle' WHERE work_id=? AND state='igniting'").run(workId);
  }

  defer(workId: string, reason: GoalContinuationDeferReason, now: number): void {
    if (requiresWorkRustWrites(this.db)) {
      const raw = this.getRaw(workId);
      if (raw) this.saveRaw({ ...raw, state: "deferred", defer_reason: reason, deferred_at: now, updated_at: now });
      return;
    }
    this.db.prepare(`UPDATE conversation_goal_continuations
      SET state='deferred', defer_reason=?, deferred_at=?, updated_at=? WHERE work_id=?`)
      .run(reason, now, now, workId);
  }

  exhaust(workId: string, reason: GoalContinuationDeferReason, now: number): void {
    if (requiresWorkRustWrites(this.db)) {
      const raw = this.getRaw(workId);
      if (raw) this.saveRaw({ ...raw, state: "exhausted", defer_reason: reason, deferred_at: now, updated_at: now });
      return;
    }
    this.db.prepare(`UPDATE conversation_goal_continuations
      SET state='exhausted', defer_reason=?, deferred_at=?, updated_at=? WHERE work_id=?`)
      .run(reason, now, now, workId);
  }

  /** User input or an explicit "continue" clears the stop flag; user input also
   * resets the stall counter because the new message is information the host did
   * not have before. */
  clearDeferral(workId: string, now: number, resetStalls: boolean): void {
    if (requiresWorkRustWrites(this.db)) {
      const raw = this.getRaw(workId);
      if (!raw || raw.state !== "deferred") return;
      this.saveRaw({
        ...raw,
        state: "idle", defer_reason: null, deferred_at: null,
        progress_stalls: resetStalls ? 0 : raw.progress_stalls, updated_at: now,
      });
      return;
    }
    this.db.prepare(`UPDATE conversation_goal_continuations
      SET state='idle', defer_reason=NULL, deferred_at=NULL,
          progress_stalls=CASE WHEN ? THEN 0 ELSE progress_stalls END, updated_at=?
      WHERE work_id=? AND state='deferred'`)
      .run(resetStalls ? 1 : 0, now, workId);
  }

  setBudget(workId: string, budget: number | null): void {
    if (requiresWorkRustWrites(this.db)) {
      const raw = this.getRaw(workId);
      if (raw) this.saveRaw({ ...raw, tokens_budget: budget });
      return;
    }
    this.db.prepare("UPDATE conversation_goal_continuations SET tokens_budget=? WHERE work_id=?").run(budget, workId);
  }

  /**
   * Delta accounting. Returns the row after the write; the caller decides whether
   * a budget hit must be announced. `budget` is the effective budget (per-goal
   * value or the global default), so a settings change applies without rewriting
   * every row.
   */
  account(workId: string, cumulativeTokens: number, budget: number | null, now: number): GoalContinuationRow | undefined {
    const rust = requiresWorkRustWrites(this.db);
    const raw = this.getRaw(workId);
    const row = rowOf(raw);
    if (!raw || !row || (row.state !== "idle" && row.state !== "igniting")) return row;
    const delta = Math.max(0, cumulativeTokens - row.usageCursor);
    if (delta === 0 && cumulativeTokens <= row.usageCursor) {
      // Unknown/older reader: keep the timestamp so idle time still accrues.
      if (rust) return this.saveRaw({ ...raw, last_token_at: now, updated_at: now });
      this.db.prepare("UPDATE conversation_goal_continuations SET last_token_at=?, updated_at=? WHERE work_id=?").run(now, now, workId);
      return this.get(workId);
    }
    const tokensUsed = row.tokensUsed + delta;
    const budgetHit = budget !== null && tokensUsed >= budget;
    if (rust) {
      const prevTimeUsed = Number((raw as RawRow & { time_used_seconds?: number }).time_used_seconds ?? 0);
      const addedSeconds = raw.last_token_at === null ? 0 : Math.max(0, Math.trunc((now - raw.last_token_at) / 1000));
      return this.saveRaw({
        ...raw,
        tokens_used: tokensUsed,
        usage_cursor: Math.max(row.usageCursor, cumulativeTokens),
        time_used_seconds: prevTimeUsed + addedSeconds,
        last_token_at: now,
        updated_at: now,
        state: budgetHit ? "exhausted" : raw.state,
        defer_reason: budgetHit ? "budget" : raw.defer_reason,
        deferred_at: budgetHit ? now : raw.deferred_at,
      } as RawRow);
    }
    this.db.prepare(`UPDATE conversation_goal_continuations
      SET tokens_used=?, usage_cursor=?,
          time_used_seconds=time_used_seconds + CASE
            WHEN last_token_at IS NULL THEN 0
            ELSE MAX(0, (? - last_token_at) / 1000) END,
          last_token_at=?, updated_at=?,
          state=CASE WHEN ? THEN 'exhausted' ELSE state END,
          defer_reason=CASE WHEN ? THEN 'budget' ELSE defer_reason END,
          deferred_at=CASE WHEN ? THEN ? ELSE deferred_at END
      WHERE work_id=?`)
      .run(tokensUsed, Math.max(row.usageCursor, cumulativeTokens),
        now, now, now, budgetHit ? 1 : 0, budgetHit ? 1 : 0, budgetHit ? 1 : 0, now, workId);
    return this.get(workId);
  }

  recordProgress(workId: string, fingerprint: string, stalled: boolean, now: number): GoalContinuationRow | undefined {
    if (requiresWorkRustWrites(this.db)) {
      const raw = this.getRaw(workId);
      if (!raw) return undefined;
      return this.saveRaw({
        ...raw,
        progress_fingerprint: fingerprint,
        progress_stalls: stalled ? raw.progress_stalls + 1 : 0,
        updated_at: now,
      });
    }
    this.db.prepare(`UPDATE conversation_goal_continuations
      SET progress_fingerprint=?,
          progress_stalls=CASE WHEN ? THEN progress_stalls+1 ELSE 0 END,
          updated_at=?
      WHERE work_id=?`).run(fingerprint, stalled ? 1 : 0, now, workId);
    return this.get(workId);
  }

  /** Cumulative measured tokens for this task, as recorded by the host's
   * idempotent usage-event ledger. */
  cumulativeUsage(taskId: string): number {
    const dbRows = this.db.prepare("SELECT event_key, task_id, tokens, recorded_at FROM conversation_goal_usage_events WHERE task_id=?")
      .all(taskId) as Array<{ event_key: string; task_id: string; tokens: number; recorded_at: number }>;
    const rows = overlayFindAll(this.db, "conversation_goal_usage_events", dbRows, r => String(r.event_key), r => r.task_id === taskId);
    return rows.reduce((sum, r) => sum + Number(r.tokens ?? 0), 0);
  }

  /** Idempotent: the same terminal assistant message may be observed twice
   * (live response + committed projection), and a restart may replay it again. */
  recordUsage(taskId: string, eventKey: string, tokens: number, now: number): void {
    if (requiresWorkRustWrites(this.db)) {
      overlayMutate(this.db, "conversation_goal_usage_events", eventKey, () =>
        this.db.prepare("SELECT * FROM conversation_goal_usage_events WHERE event_key=?").get(eventKey) as Record<string, unknown> | undefined,
      cur => cur ?? { event_key: eventKey, task_id: taskId, tokens, recorded_at: now });
      enqueueWorkOp(this.db, { op: "goalUsageEventInsert", eventKey, taskId, tokens, recordedAt: now });
      return;
    }
    this.db.prepare("INSERT OR IGNORE INTO conversation_goal_usage_events(event_key,task_id,tokens,recorded_at) VALUES (?,?,?,?)")
      .run(eventKey, taskId, tokens, now);
  }

  /** Explicit user "continue": fresh attempts and a fresh token window. */
  explicitResume(workId: string, usageCursor: number, now: number): void {
    if (requiresWorkRustWrites(this.db)) {
      const raw = this.getRaw(workId);
      if (raw) {
        this.saveRaw({
          ...raw,
          attempts: 0, tokens_used: 0, usage_cursor: usageCursor,
          progress_fingerprint: null, progress_stalls: 0, run_cursor: 0,
          state: "idle", defer_reason: null, deferred_at: null, updated_at: now,
        });
      }
      return;
    }
    this.db.prepare(`UPDATE conversation_goal_continuations
      SET attempts=0, tokens_used=0, usage_cursor=?, progress_fingerprint=NULL,
          progress_stalls=0, run_cursor=0, state='idle', defer_reason=NULL,
          deferred_at=NULL, updated_at=?
      WHERE work_id=?`).run(usageCursor, now, workId);
  }

  /** Crash/restart never resumes silently: the host keeps the row, the user decides. */
  reconcileRestart(now: number): GoalContinuationRow[] {
    const dbRows = this.db.prepare("SELECT * FROM conversation_goal_continuations WHERE state='igniting'")
      .all() as Array<RawRow & Record<string, unknown>>;
    const rows = overlayFindAll(this.db, "conversation_goal_continuations", dbRows, r => String(r.work_id), r => r.state === "igniting")
      .map(row => rowOf(row)).filter((row): row is GoalContinuationRow => Boolean(row));
    for (const row of rows) this.defer(row.workId, "restart", now);
    return rows.map(row => ({ ...row, state: "deferred" as const, deferReason: "restart" as const }));
  }
}
