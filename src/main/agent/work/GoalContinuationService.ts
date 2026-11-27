import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { AgentPromptRequest, AgentPromptResult, AgentUiPatch, ChatMessageDto } from "../../../shared/agent-ipc";
import type {
  ConversationGoalContinuationDto,
  ConversationGoalDto,
  GoalContinuationDeferReason,
  GoalContinuationOrigin,
} from "../../../shared/conversation-goal";
import type { DurableBotSnapshot } from "../../../shared/durable-bot";
import type { WorkDto } from "../../../shared/bot-work";
import type { ConversationGoalService } from "../ConversationGoalService";
import { GOAL_CONTINUATION_STALL_LIMIT as STALL_LIMIT, normalizeGoalContinuationAttempts } from "../ConversationRuntimeData";
import type { WorkService } from "./WorkService";
import { GoalContinuationStore, type GoalContinuationRow } from "./GoalContinuationStore";

/** The narrow runtime window the host is allowed to look at before igniting. */
export interface GoalContinuationRuntimeState {
  busy: boolean;
  queued: number;
  compacting: boolean;
  status?: DurableBotSnapshot["status"];
  outcome?: DurableBotSnapshot["outcome"];
  messages: ChatMessageDto[];
}

export interface GoalContinuationSubmitOrigin {
  goalContinuation: GoalContinuationOrigin;
}

export interface GoalContinuationServiceOptions {
  db: Database.Database;
  work: WorkService;
  goals: ConversationGoalService;
  emit: (patch: AgentUiPatch) => void;
  submit: (request: AgentPromptRequest, origin: GoalContinuationSubmitOrigin) => Promise<AgentPromptResult>;
  /** Opens/refreshes the native session and returns just the scheduling facts. */
  inspect: (taskId: string) => Promise<GoalContinuationRuntimeState | undefined>;
  artifactVersions?: (taskId: string, work: WorkDto) => Promise<readonly string[]>;
  waitingForInput: (taskId: string) => boolean;
  enabled: () => boolean;
  canAdvance?: (taskId: string, goalId: string) => boolean;
  maxAttempts: () => number;
  /** Global default; a per-Goal budget wins when set. null = unlimited. */
  tokenBudget: () => number | null;
}

const LOG = "[GoalContinuation]";
type CheckTrigger = NonNullable<ConversationGoalContinuationDto["lastCheck"]>["trigger"];

/**
 * Host-side Goal continuation.
 *
 * The Goal contract already lives in the system prompt; this service is the only
 * thing that points the conversation at it again after a turn settles. It never
 * decides completion: criteria are still attested by the user and the Work is the
 * single authority. Everything here is either a scheduling decision or measured
 * accounting; a stop is always written as an explicit deferral the user can read.
 */
export class GoalContinuationService {
  private readonly store: GoalContinuationStore;
  private readonly tails = new Map<string, Promise<void>>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(private readonly options: GoalContinuationServiceOptions) {
    this.store = new GoalContinuationStore(options.db);
  }

  /** Called from the Durable settle hook, including aborted/failed settles. */
  onSettled(taskId: string, snapshot: DurableBotSnapshot, expectedGoalId?: string | null): void {
    if (this.disposed || !this.options.enabled()) return;
    // onProjected runs inside the runtime projection; defer the decision one tick
    // so an ignition submission never re-enters that loop.
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.disposed) return;
      this.enqueue(taskId, async () => {
        if (expectedGoalId !== undefined && this.liveWork(taskId)?.workId !== expectedGoalId) return;
        await this.evaluate(taskId, "settled", snapshot);
      });
    }, 0);
    this.timers.add(timer);
  }

  /** A real user input clears "waiting for the user" stops; it also tells the
   * host that the stall detector's old baseline is no longer the whole story. */
  noteUserInput(taskId: string): void {
    if (this.disposed) return;
    const work = this.liveWork(taskId);
    if (!work) return;
    const row = this.store.get(work.workId);
    if (!row || row.state !== "deferred" || row.deferReason === "budget" || row.deferReason === "attempts") return;
    const now = Date.now();
    this.store.clearDeferral(work.workId, now, true);
    this.emitGoal(taskId, work.workId);
    console.info(`${LOG} cleared task=${taskId} work=${work.workId} reason=user_message`);
  }

  /** Pause is enforced by the Work lifecycle; resume is an explicit reason to look again. */
  onGoalStatusChange(goal: ConversationGoalDto, status: "paused" | "active"): void {
    if (this.disposed) return;
    const work = this.options.work.getWork(goal.id);
    if (!work) return;
    const taskId = this.primaryTaskId(work) ?? goal.taskId;
    if (status === "paused") {
      console.info(`${LOG} paused task=${taskId} work=${work.workId}`);
      return;
    }
    const row = this.store.get(work.workId);
    if (row?.state === "deferred") {
      // Resume is an explicit user action; a no-progress baseline from before
      // the pause must not immediately re-defer the same Goal.
      this.store.clearDeferral(work.workId, Date.now(), true);
      this.emitGoal(taskId, work.workId);
    }
    this.enqueue(taskId, () => this.evaluate(taskId, "resumed"));
  }

  /** Crash/restart: a host-pointed run cannot be replayed, so it becomes visible debt. */
  reconcileRestart(): void {
    if (this.disposed) return;
    for (const row of this.store.reconcileRestart(Date.now())) {
      this.emitGoal(row.taskId, row.workId);
      console.info(`${LOG} deferred task=${row.taskId} work=${row.workId} reason=restart`);
    }
  }

  refreshPolicy(): void {
    const held = this.options.db.prepare("SELECT DISTINCT task_id FROM conversation_goal_last_check WHERE reason='dots_policy'")
      .pluck().all() as string[];
    for (const taskId of held) this.enqueue(taskId, () => this.evaluate(taskId, "resumed"));
  }

  /** Establish the usage watermark when a Goal is created, before its first turn. */
  register(goal: ConversationGoalDto): void {
    if (this.disposed) return;
    const work = this.options.work.getWork(goal.id);
    if (!work) return;
    const taskId = this.primaryTaskId(work);
    if (!taskId) return;
    const cursor = this.cumulativeTokens(taskId);
    this.store.ensure({ workId: work.workId, taskId, intentRevision: work.intentRevision }, cursor, Date.now());
    this.emitGoal(taskId, work.workId);
  }

  /** Per-Goal budget is user-owned configuration, not a Work fact; it lives on the ledger. */
  setBudget(workId: string, budget: number | null): void {
    if (this.disposed) return;
    const work = this.options.work.getWork(workId);
    if (!work) return;
    const taskId = this.primaryTaskId(work);
    if (!taskId) return;
    const cursor = this.cumulativeTokens(taskId);
    this.store.ensure({ workId, taskId, intentRevision: work.intentRevision }, cursor, Date.now());
    this.store.setBudget(workId, budget);
    this.emitGoal(taskId, workId);
    console.info(`${LOG} budget task=${taskId} work=${workId} value=${budget ?? "unlimited"}`);
  }

  /** Explicit "continue": fresh attempts and budget window, then one ignition attempt. */
  resume(goalId: string): { ok: true; goal: ConversationGoalDto } | { ok: false; message: string } {
    const work = this.options.work.getWork(goalId);
    if (!work) return { ok: false, message: "找不到该 Goal" };
    if (work.lifecycle === "closed" || work.lifecycle === "closing") return { ok: false, message: "Goal 已结束，无法继续" };
    if (work.lifecycle === "paused") return { ok: false, message: "Goal 已暂停，请先恢复 Goal" };
    const taskId = this.primaryTaskId(work);
    if (!taskId) return { ok: false, message: "找不到 Goal 所属对话" };
    const cursor = this.cumulativeTokens(taskId);
    this.store.ensure({ workId: work.workId, taskId, intentRevision: work.intentRevision }, cursor, Date.now());
    this.store.explicitResume(work.workId, cursor, Date.now());
    this.emitGoal(taskId, work.workId);
    console.info(`${LOG} resumed task=${taskId} work=${work.workId}`);
    this.enqueue(taskId, () => this.evaluate(taskId, "continued"));
    const goal = this.options.goals.getLive(taskId, work.workId);
    return goal ? { ok: true, goal } : { ok: false, message: "Goal 已不存在" };
  }

  /** DTO projection for the Goal chip and prompt. It must not fail a prompt or
   * a Goal patch when the ledger is temporarily unreadable (e.g. shutdown). */
  read(workId: string): ConversationGoalContinuationDto {
    const maxAttempts = this.maxAttempts();
    const fallbackBudget = this.options.tokenBudget();
    let row: GoalContinuationRow | undefined;
    try { row = this.store.get(workId); } catch { row = undefined; }
    const enabled = this.options.enabled();
    let lastCheck: ConversationGoalContinuationDto["lastCheck"];
    let lastWake: ConversationGoalContinuationDto["lastWake"];
    if (row) {
      try { lastCheck = this.store.lastCheck(row); } catch { lastCheck = undefined; }
      try { lastWake = this.store.lastWake(row); } catch { lastWake = undefined; }
    }
    if (!row) return { state: "idle", attempts: 0, maxAttempts, tokensUsed: 0,
      tokenBudget: fallbackBudget, enabled };
    const tokenBudget = row.tokenBudget ?? fallbackBudget;
    return {
      state: row.state, attempts: row.attempts, maxAttempts, tokensUsed: row.tokensUsed, tokenBudget,
      enabled, taskId: row.taskId, progressStalls: row.progressStalls, stallLimit: STALL_LIMIT,
      ...(lastCheck ? { lastCheck } : {}),
      ...(lastWake ? { lastWake } : {}),
      ...(row.deferredAt != null ? { lastStoppedAt: row.deferredAt } : {}),
      ...(row.deferReason ? { deferReason: row.deferReason } : {}),
      ...(row.lastContinuationAt ? { lastContinuationAt: row.lastContinuationAt } : {}),
    };
  }

  /** Idempotent usage event from a terminal assistant message. The host records
   * only while a Goal ledger exists, so a Goal starts with a zero baseline and
   * a later Goal does not inherit earlier spend. */
  noteResponse(taskId: string, eventKey: string, usage: {
    input?: number | null; output?: number | null; cacheRead?: number | null;
  }, expectedGoalId?: string): void {
    if (this.disposed) return;
    const work = this.liveWork(taskId);
    if (!work || (expectedGoalId !== undefined && expectedGoalId !== work.workId)) return;
    const row = this.store.get(work.workId);
    if (!row) return;
    const tokens = [usage.input, usage.output, usage.cacheRead]
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0)
      .reduce((sum, value) => sum + value, 0);
    if (tokens <= 0) return;
    this.store.recordUsage(taskId, eventKey, tokens, Date.now());
    this.account(taskId);
  }

  /** Tool completes are the accounting sample points; the settle takes the final delta. */
  account(taskId: string): void {
    if (this.disposed) return;
    if (this.options.work.repo.bindingForTask(taskId)) return;
    const work = this.liveWork(taskId);
    if (!work) return;
    const row = this.store.get(work.workId);
    if (!row || (row.state !== "idle" && row.state !== "igniting")) return;
    const cumulative = this.cumulativeTokens(taskId);
    const budget = row.tokenBudget ?? this.options.tokenBudget();
    const before = row;
    const updated = this.store.account(work.workId, cumulative, budget, Date.now());
    if (updated?.state === "exhausted" && before.state !== "exhausted") {
      console.info(`${LOG} exhausted task=${taskId} work=${work.workId} reason=budget tokens=${updated.tokensUsed} budget=${budget}`);
      this.emitGoal(taskId, work.workId);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.tails.clear();
  }

  // --------------------------------------------------------------- evaluation

  private enqueue(taskId: string, run: () => Promise<void>): void {
    const prior = this.tails.get(taskId) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(run).catch(error => {
      console.warn(`${LOG} evaluation failed task=${taskId}`, error);
    });
    this.tails.set(taskId, next);
    void next.finally(() => { if (this.tails.get(taskId) === next) this.tails.delete(taskId); });
  }

  private async evaluate(taskId: string, trigger: CheckTrigger, settled?: DurableBotSnapshot): Promise<void> {
    if (this.disposed || !this.options.enabled()) return;
    if (this.options.work.repo.bindingForTask(taskId)) return this.skip(taskId, undefined, "binding");
    let work = this.liveWork(taskId);
    if (!work) return this.skip(taskId, undefined, "no_goal");
    work = this.options.work.getWork(work.workId) ?? work;
    const checkedWork = work;
    const skip = (reason: string, checkRow?: GoalContinuationRow) => {
      this.recordCheck(taskId, checkedWork, trigger, reason);
      this.skip(taskId, checkedWork, reason, checkRow);
      this.emitGoal(taskId, checkedWork.workId);
    };
    const now = Date.now();
    this.account(taskId);
    const cursor = this.cumulativeTokens(taskId);
    let row = this.store.ensure({ workId: work.workId, taskId, intentRevision: work.intentRevision }, cursor, now);

    const fromSettle = settled !== undefined;
    const wasIgniting = row.state === "igniting";
    let fingerprint: string | undefined;
    if (wasIgniting && fromSettle) {
      fingerprint = await this.fingerprint(taskId, work);
      if (this.disposed) return;
      const current = this.store.get(work.workId);
      if (current?.state === "igniting" && current.attemptSerial === row.attemptSerial) {
        row = this.store.recordProgress(work.workId, fingerprint, row.progressFingerprint === fingerprint, now) ?? current;
        this.store.settleRun(work.workId);
      }
    }
    // A non-settle evaluation (resume/pause hook) must not mistake an in-flight
    // host run for a finished one; wait for its own settle.
    if (wasIgniting && !fromSettle) return skip("igniting", row);

    if (work.mode === "watch") return skip("watch", row);
    if (work.lifecycle !== "active") return skip(work.lifecycle, row);
    if (this.options.canAdvance?.(taskId, work.workId) === false) return skip("dots_policy", row);
    if (work.criteria.length > 0 && work.criteria.every(criterion =>
      criterion.status === "satisfied" || criterion.status === "waived")) return skip("complete_pending", row);

    row = this.store.get(work.workId) ?? row;
    if (row.state === "deferred") return skip("deferred", row);
    if (row.state === "exhausted") return skip("exhausted", row);

    const runtime = await this.options.inspect(taskId);
    if (this.disposed) return;
    const latest = this.liveWork(taskId);
    if (!latest || latest.workId !== work.workId || latest.stateVersion !== work.stateVersion) return skip("goal_changed", row);
    if (!this.options.enabled()) return skip("disabled", row);
    if (this.options.canAdvance?.(taskId, work.workId) === false) return skip("dots_policy", row);
    const currentRow = this.store.get(work.workId);
    if (!currentRow || currentRow.updatedAt !== row.updatedAt || currentRow.state !== row.state) return skip("ledger_changed", row);
    if (!runtime) return skip("no_session", row);
    if (this.options.waitingForInput(taskId) || runtime.status === "waiting_input") return skip("waiting_input", row);
    if (runtime.queued > 0) return skip("queued", row);
    if (runtime.busy) return skip("busy", row);
    if (runtime.compacting) return skip("compacting", row);
    if (runtime.outcome === "aborted" || runtime.outcome === "failed") {
      const reason = runtime.outcome === "aborted" ? "user_interrupt" : "run_failed";
      this.recordCheck(taskId, work, trigger, reason);
      return this.defer(taskId, work, reason, now, row);
    }

    const maxAttempts = this.maxAttempts();
    if (row.attempts >= maxAttempts) {
      this.recordCheck(taskId, work, trigger, "attempts");
      this.store.exhaust(work.workId, "attempts", now);
      console.info(`${LOG} exhausted task=${taskId} work=${work.workId} reason=attempts attempts=${row.attempts}/${maxAttempts}`);
      this.emitGoal(taskId, work.workId);
      return;
    }
    const budget = row.tokenBudget ?? this.options.tokenBudget();
    if (budget !== null && row.tokensUsed >= budget) {
      this.recordCheck(taskId, work, trigger, "budget");
      this.store.exhaust(work.workId, "budget", now);
      console.info(`${LOG} exhausted task=${taskId} work=${work.workId} reason=budget tokens=${row.tokensUsed}/${budget}`);
      this.emitGoal(taskId, work.workId);
      return;
    }
    if (row.progressStalls >= STALL_LIMIT) {
      this.recordCheck(taskId, work, trigger, "no_progress");
      this.store.defer(work.workId, "no_progress", now);
      console.info(`${LOG} deferred task=${taskId} work=${work.workId} reason=no_progress stalls=${row.progressStalls}`);
      this.emitGoal(taskId, work.workId);
      return;
    }

    fingerprint ??= await this.fingerprint(taskId, work);
    if (this.disposed || !this.options.enabled()) return;
    const latestWork = this.liveWork(taskId);
    if (latestWork?.workId !== work.workId || latestWork.stateVersion !== work.stateVersion) return skip("goal_changed", row);
    if (this.options.canAdvance?.(taskId, work.workId) === false) return skip("dots_policy", row);
    const current = this.store.get(work.workId);
    if (!current || current.updatedAt !== row.updatedAt || current.state !== row.state) return skip("ledger_changed", row);
    this.recordCheck(taskId, work, trigger, "submitting");
    await this.ignite(taskId, work, row, runtime, fingerprint, maxAttempts, budget, trigger);
  }

  private async ignite(taskId: string, work: WorkDto, row: GoalContinuationRow, runtime: GoalContinuationRuntimeState, fingerprint: string,
    maxAttempts: number, budget: number | null, trigger: CheckTrigger): Promise<void> {
    if (this.disposed) return;
    const now = Date.now();
    const runCursor = this.entryCursor(runtime.messages);
    const attempt = this.store.beginAttempt(work.workId, runCursor, fingerprint, now);
    this.emitGoal(taskId, work.workId);
    try {
      const accepted = await this.options.submit(this.buildRequest({
        taskId, work, attempt: attempt.attempt, serial: attempt.serial, maxAttempts, budget, tokensUsed: row.tokensUsed,
      }), {
        goalContinuation: { workId: work.workId, intentRevision: work.intentRevision, ownerEpoch: work.ownerEpoch, attempt: attempt.attempt },
      });
      if (!accepted.receipt) throw new Error(accepted.error?.message ?? "自动续跑未被接受");
    } catch (error) {
      this.store.rollbackAttempt(work.workId, Date.now());
      this.recordCheck(taskId, work, trigger, "submit_failed");
      this.emitGoal(taskId, work.workId);
      console.warn(`${LOG} submit failed task=${taskId} work=${work.workId} attempt=${attempt.attempt}`, error);
      return;
    }
    this.store.recordWake(work.workId, taskId, work.intentRevision, { trigger, at: Date.now() });
    this.recordCheck(taskId, work, trigger, "submitted");
    this.emitGoal(taskId, work.workId);
    console.info(`${LOG} ignite task=${taskId} work=${work.workId} attempt=${attempt.attempt}/${maxAttempts} serial=${attempt.serial}`);
  }

  private buildRequest(input: {
    taskId: string; work: WorkDto; attempt: number; serial: number; maxAttempts: number;
    budget: number | null; tokensUsed: number;
  }): AgentPromptRequest {
    const { taskId, work, attempt, serial, maxAttempts, budget, tokensUsed } = input;
    const remaining = budget === null ? null : Math.max(0, budget - tokensUsed);
    return {
      taskId,
      text: continuationNudge(attempt, maxAttempts, remaining),
      displayText: `Goal 自动续跑 #${attempt}/${maxAttempts}`,
      // The submission identity uses the monotonic serial, not the visible attempt:
      // an explicit "continue" resets attempts, and reusing the same id would
      // return the old submission instead of igniting a new run.
      userMessageId: `goal-continuation:${work.workId}:${work.intentRevision}:${serial}`,
      assistantMessageId: `goal-continuation-answer:${work.workId}:${work.intentRevision}:${serial}`,
      // The decision was made while idle, but a user input can land in the narrow
      // window before admission. Steer keeps both inputs instead of dropping one.
      streamingBehavior: "steer" as const,
      announceUserMessage: false,
    };
  }

  private defer(taskId: string, work: WorkDto, reason: GoalContinuationDeferReason, now: number, row: GoalContinuationRow): void {
    if (row.state !== "deferred" || row.deferReason !== reason) this.store.defer(work.workId, reason, now);
    this.emitGoal(taskId, work.workId);
    console.info(`${LOG} deferred task=${taskId} work=${work.workId} reason=${reason} attempt=${row.attempts}`);
  }

  private skip(taskId: string, work: WorkDto | undefined, reason: string, row?: GoalContinuationRow): void {
    // Every ordinary conversation settles without a Goal. Logging that decision
    // twice per turn would bury the cases that actually matter.
    if (!work && (reason === "no_goal" || reason === "binding")) return;
    console.info(`${LOG} skip task=${taskId} work=${work?.workId ?? "-"} reason=${reason}${row ? ` attempt=${row.attempts}` : ""}`);
  }

  private recordCheck(taskId: string, work: WorkDto, trigger: CheckTrigger, reason: string): void {
    this.store.recordCheck(work.workId, taskId, work.intentRevision, { trigger, reason, at: Date.now() });
  }

  private liveWork(taskId: string): WorkDto | undefined {
    try { return this.options.work.findLiveWorkForConversation(taskId); }
    catch { return undefined; }
  }

  /** Public for the Goal projection: a Work links both its canonical Bot
   * conversation and the desktop conversation.
   * Only the latter is a schedulable task, so never derive the task id from the
   * first linked conversation (that would point at "bot-conversation-<uuid>"). */
  resolveTaskId(workId: string): string | undefined {
    const work = this.options.work.getWork(workId);
    return work ? this.primaryTaskId(work) : undefined;
  }

  private primaryTaskId(work: WorkDto): string | undefined {
    const candidates = [...new Set([work.legacyTaskId, ...this.options.work.repo.listConversationIds(work.workId)]
      .filter((id): id is string => Boolean(id)))];
    const task = candidates.find(id => this.options.db.prepare("SELECT 1 FROM tasks WHERE id=?").get(id));
    return task ?? work.legacyTaskId ?? candidates[0];
  }

  private cumulativeTokens(taskId: string): number {
    return this.store.cumulativeUsage(taskId);
  }

  private entryCursor(messages: readonly ChatMessageDto[]): number {
    return messages.reduce((cursor, message) => Math.max(cursor, entryNumberOf(message)), 0);
  }

  private async fingerprint(taskId: string, work: WorkDto): Promise<string> {
    const evidence = this.options.work.repo.listEvidence(work.workId)
      .filter(item => item.intentRevision === work.intentRevision && item.inputSnapshotId === work.inputSnapshotId)
      .map(item => JSON.stringify([item.kind, item.sourceRef, item.sourceSha, [...item.criterionIds].sort(), item.detail]));
    const artifacts = await this.options.artifactVersions?.(taskId, work) ?? [];
    return createHash("sha256").update(JSON.stringify([
      work.intentRevision, work.progressSummary?.trim().replace(/\s+/gu, " ") ?? null,
      work.criteria.map(criterion => [criterion.id, criterion.status, criterion.verifiedIntentRevision, criterion.waivedReason ?? null]),
      [...new Set(evidence)].sort(), artifacts,
    ])).digest("hex");
  }

  private maxAttempts(): number {
    return normalizeGoalContinuationAttempts(this.options.maxAttempts());
  }

  private emitGoal(taskId: string, workId: string): void {
    try {
      const goal = this.options.goals.getLive(taskId, workId);
      if (goal) this.options.emit({ type: "conversation_goal_snapshot", taskId, goal });
    } catch (error) {
      // The chip must never fail a continuation decision; history still holds the row.
      console.warn(`${LOG} goal projection failed task=${taskId} work=${workId}`, error);
    }
  }
}

function entryNumberOf(message: ChatMessageDto): number {
  const explicit = message.entryId ? Number(message.entryId) : NaN;
  if (Number.isFinite(explicit)) return explicit;
  const match = /^durable-(\d+)$/.exec(message.id);
  return match ? Number(match[1]) : 0;
}

export function continuationNudge(attempt: number, maxAttempts: number, remainingTokens: number | null): string {
  return `（宿主自动续跑 #${attempt}/${maxAttempts}）继续推进「对话 Goal」里仍未满足的验收条件：
先做下一步可执行的动作，再汇报进展与剩下的项。成果已准备好时单独提交结项。
若没有可执行的下一步，或收到结项拒绝且没有新增依据，写清已完成项、阻碍和所需输入，然后结束本轮。`
    + (remainingTokens === null ? "" : `\n本次 Goal 自动续跑预算剩余约 ${remainingTokens} token；预算将尽时只做收尾与交接。`);
}
