import { createHash } from "node:crypto";
import type { ToolDiagnosticEvent } from "../../shared/task-diagnostics";
import { defaultAnswerRuleId, defaultDotsSchedulingPolicy, type AnswerRuleDraft, type DotsSchedulingPolicy } from "../../shared/answer-routing";
import type Database from "better-sqlite3";
import type { AgentUiPatch, AgentPromptRequest } from "../../shared/agent-ipc";
import type { DotsAssistantReply, DotsDelegation, DotsDependencyWait, DotsReplyOrigin, DotsTaskOutput, DotsWorkerObservation } from "../../shared/dots";
import type { ReplyCitation } from "../../shared/chat-reply-content";
import { DOTS_TASK_ID } from "../../shared/dots";
import { DotsReplyOutbox, type AppendDotsReply, type DotsFollowup } from "./DotsReplyOutbox";
import { readDotsWorkerOutcome } from "./DotsWorkerOutcome";

export const dotsDelegationScopeMatches = `t.space_id IS d.space_id AND s.path IS d.space_path
  AND (t.cwd IS d.cwd OR (d.cwd IS NULL AND t.cwd IS d.space_path))`;

type Result = Pick<DotsDelegation, "text" | "artifacts" | "interactionId" | "dependencyWait"> & {
  status: "running" | "blocked" | "completed" | "failed";
  citations?: ReplyCitation[];
  acceptedGoalReceiptId?: string;
  verifiedCommit?: string;
  observation?: DotsWorkerObservation;
};
type RecoverSubmit = (request: AgentPromptRequest) => Promise<{ error?: {message: string}; cancelled?: boolean }>;
type RecoverAvailable = (taskId: string) => boolean;
type RecoverAccepted = (taskId: string, operationId: string) => Promise<boolean>;
type RecoverPolicy = (request: AgentPromptRequest, source: string) => boolean;
type Row = {
  proactive_reply?: number;
  seq: number; operation_id: string; task_id: string; source_message_id: string; status: DotsDelegation["status"];
  title: string; text: string; files: string; created_at: number; updated_at: number; supersedes: number; interaction_id: string | null; goal_id: string | null;
};

type Activity = { operation_id: string; at: number; tool: string; phase: "start" | "finish"; last_report_at: number | null; progress_at?: number | null };

function toDelegation(row: Row, activity?: Activity, dependencyWait?: DotsDependencyWait): DotsDelegation {
  return { id: row.operation_id, taskId: row.task_id, title: row.title, sourceMessageId: row.source_message_id,
    status: row.status, goalId: row.goal_id ?? undefined, proactiveReply: row.proactive_reply ? true : undefined, text: row.text, artifacts: JSON.parse(row.files),
    ...(dependencyWait && { dependencyWait }),
    ...(activity && { activity: { lastActivityAt: activity.at, lastProgressAt: activity.progress_at ?? undefined, lastReportAt: activity.last_report_at ?? undefined,
      tool: activity.tool, phase: activity.phase } }),
    createdAt: row.created_at, updatedAt: row.updated_at, interactionId: row.interaction_id ?? undefined };
}

/** This journal relates the Dots turn to a native submission. The native task owns execution. */
export class DotsDelegations {
  private readonly flights = new Map<string, Promise<void>>();
  private readonly dirty = new Set<string>();
  private disposed = false;
  private observationTimer?: ReturnType<typeof setTimeout>;
  private dependencyTimer?: ReturnType<typeof setTimeout>;
  private readonly recoverable: Row[];
  private readonly outbox: DotsReplyOutbox;
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly recoveryTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly recoveryFlights = new Set<Promise<void>>();
  private readonly liveOutput = new Map<string, DotsTaskOutput & { generationId: number }>();
  private liveNotify?: ReturnType<typeof setTimeout>;
  private writeTail = Promise.resolve();
  private pendingWriteCount = 0;
  private readonly pendingToolReceiptKeys = new Set<string>();
  private readonly pendingProgressKeys = new Set<string>();
  private readonly pendingNextAt = new Map<string, number | null>();
  private readonly pendingDelegations = new Map<string, Row>();
  private readonly pendingCwds = new Map<string, string>();
  private readonly pendingDepWaits = new Map<string, DotsDependencyWait>();

  constructor(private db: Database.Database, private inspect: (taskId: string, operationId: string) => Promise<Result | undefined>,
    private notify: () => void, private readonly sampleIntervalMs?: () => number,
    private readonly native?: Pick<import("../platform/runtime-audit").RuntimeAuditReader, "batch4aWrite" | "supervised">) {
    if (!db.readonly) {
      db.exec(`CREATE TABLE IF NOT EXISTS dots_delegations(
        seq INTEGER PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL, source_message_id TEXT NOT NULL,
        title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', text TEXT NOT NULL DEFAULT '', files TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, supersedes INTEGER NOT NULL DEFAULT 0, interaction_id TEXT, request_json TEXT, space_id TEXT, space_path TEXT, cwd TEXT, goal_id TEXT);
        CREATE TABLE IF NOT EXISTS dots_tool_observations(
          operation_id TEXT PRIMARY KEY, at INTEGER NOT NULL, tool TEXT NOT NULL, phase TEXT NOT NULL,
          next_at INTEGER, last_report_at INTEGER);
        CREATE INDEX IF NOT EXISTS dots_observation_due ON dots_tool_observations(next_at) WHERE next_at IS NOT NULL;
        CREATE TABLE IF NOT EXISTS dots_verified_progress(
          operation_id TEXT NOT NULL, identity TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(operation_id,identity));
        CREATE INDEX IF NOT EXISTS dots_verified_progress_latest ON dots_verified_progress(operation_id,at DESC);
        CREATE TABLE IF NOT EXISTS dots_tool_observation_receipts(
          operation_id TEXT NOT NULL, conversation TEXT NOT NULL, tool_task INTEGER NOT NULL, phase TEXT NOT NULL,
          PRIMARY KEY(operation_id,conversation,tool_task,phase));
        CREATE TABLE IF NOT EXISTS dots_control_receipts(operation_id TEXT PRIMARY KEY,target_task_id TEXT NOT NULL,outcome TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS dots_target_controls(task_id TEXT PRIMARY KEY,state TEXT NOT NULL,operation_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS dots_dependency_waits(operation_id TEXT PRIMARY KEY, prerequisite_id TEXT NOT NULL,
          title TEXT NOT NULL, deadline_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS dots_dependency_prerequisite ON dots_dependency_waits(prerequisite_id);
        CREATE TABLE IF NOT EXISTS dots_verified_commits(operation_id TEXT PRIMARY KEY,sha TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS dots_delegations_task_sequence ON dots_delegations(task_id,seq);
        CREATE INDEX IF NOT EXISTS dots_delegations_pending ON dots_delegations(task_id,seq) WHERE status IN ('pending','running','blocked');
        CREATE INDEX IF NOT EXISTS dots_delegations_source ON dots_delegations(source_message_id);`);
    }
    this.recoverable = db.prepare("SELECT * FROM dots_delegations WHERE status='pending' AND request_json IS NOT NULL ORDER BY seq").all() as Row[];
    this.outbox = new DotsReplyOutbox(db, operationId => {
      this.notify();
      if (!this.disposed) this.refreshDependentTasks(operationId);
    }, sampleIntervalMs, native);
  }

  private get requiresRustWrites(): boolean {
    return this.db.readonly || Boolean(this.native?.supervised);
  }

  async flushWrites(): Promise<void> {
    await this.writeTail;
    await this.outbox.flushWrites();
  }

  private enqueueWrite(request: Record<string, unknown>, label: string): void {
    const batch4a = this.native?.batch4aWrite;
    if (!batch4a) throw new Error(`只读模式下缺少 Dots 委派 Rust 写入通道: ${label}`);
    this.pendingWriteCount += 1;
    this.writeTail = this.writeTail.then(() => batch4a.call(this.native, request)).then(() => undefined, error => {
      console.warn(`[DotsDelegations] ${label} failed`, error);
    }).finally(() => {
      this.pendingWriteCount -= 1;
      if (this.pendingWriteCount === 0) {
        this.pendingToolReceiptKeys.clear();
        this.pendingProgressKeys.clear();
        this.pendingNextAt.clear();
        this.pendingDelegations.clear();
        this.pendingCwds.clear();
        this.pendingDepWaits.clear();
      }
    });
  }

  connect(followup: DotsFollowup, append: AppendDotsReply, allowed?: (taskId: string) => boolean,
    allowedReply?: (kind: DotsAssistantReply["kind"]) => boolean): void {
    this.outbox.connect(followup, append, allowed, allowedReply);
    for (const row of this.db.prepare("SELECT * FROM dots_delegations WHERE status='blocked'").all() as Row[])
      this.outbox.observe(toDelegation(row, undefined, this.dependencyWait(row.operation_id)));
    this.resumeObservations();
    this.scheduleObservation();
    this.scheduleDependencyDeadline();
  }

  latestTaskDelivery(taskId: string) {
    return this.outbox.latestTaskDelivery(taskId);
  }

  taskLiveOutput(operationId: string): DotsTaskOutput | undefined {
    return this.liveOutput.get(operationId);
  }

  private showOutput(operationId: string, generationId: number, text: string, active: boolean) {
    const preview = text.trim().slice(0, 1200);
    const previous = this.liveOutput.get(operationId);
    if (!preview || previous && previous.generationId > generationId) return;
    if (previous?.generationId === generationId &&
      ((!previous.active && active) || (previous.text === preview && previous.active === active))) return;
    this.liveOutput.set(operationId, { generationId, text: preview, active });
    if (this.liveNotify) return;
    this.liveNotify = setTimeout(() => {
      this.liveNotify = undefined;
      if (!this.disposed) this.notify();
    }, 80);
    this.liveNotify.unref();
  }

  private dependencyWait(operation: string, pendingOnly = false) {
    return this.db.prepare(`SELECT prerequisite_id AS operationId,title,deadline_at AS deadlineAt FROM dots_dependency_waits w
      WHERE operation_id=? AND (NOT ? OR EXISTS(SELECT 1 FROM dots_reply_events e
        WHERE e.operation_id=w.operation_id AND e.status='blocked' AND e.settled=0))`)
      .get(operation, Number(pendingOnly)) as DotsDependencyWait | undefined;
  }

  private refreshDependentTasks(operationId: string) {
    const targets = this.db.prepare(`SELECT DISTINCT d.task_id FROM dots_delegations changed
      JOIN dots_delegations root ON root.task_id=changed.task_id AND root.seq<=changed.seq
      JOIN dots_dependency_waits w ON w.prerequisite_id=root.operation_id
      JOIN dots_delegations d ON d.operation_id=w.operation_id AND d.status='blocked'
      JOIN dots_reply_events e ON e.operation_id=d.operation_id AND e.status='blocked' AND e.settled=0
      WHERE changed.operation_id=?`).pluck().all(operationId) as string[];
    for (const target of targets) this.refresh(target);
  }

  handleCoreEvent(event: { domain: string; kind: string; payload: unknown }): void {
    if (event.domain !== "dots" || this.disposed) return;
    const payload = (event.payload && typeof event.payload === "object" ? event.payload : {}) as Record<string, unknown>;
    if (event.kind === "dots.observationDue") {
      this.observeDue();
      return;
    }
    if (event.kind === "dots.dependencyDue" && typeof payload.taskId === "string") {
      this.refresh(payload.taskId);
    }
  }

  private scheduleDependencyDeadline() {
    if (this.dependencyTimer) clearTimeout(this.dependencyTimer);
    this.dependencyTimer = undefined;
    if (this.disposed || this.native?.supervised) return;
    const active = `FROM dots_dependency_waits w JOIN dots_delegations d ON d.operation_id=w.operation_id AND d.status='blocked'
      JOIN dots_reply_events e ON e.operation_id=d.operation_id AND e.status='blocked' AND e.settled=0`;
    const next = this.db.prepare(`SELECT min(w.deadline_at) ${active} WHERE w.deadline_at>?`).pluck().get(Date.now()) as number | null;
    if (next === null) return;
    this.dependencyTimer = setTimeout(() => {
      this.dependencyTimer = undefined;
      if (this.disposed) return;
      const targets = this.db.prepare(`SELECT DISTINCT d.task_id ${active} WHERE w.deadline_at<=?`).pluck().all(Date.now()) as string[];
      for (const target of targets) this.refresh(target);
      this.scheduleDependencyDeadline();
    }, Math.max(1, next - Date.now()));
    this.dependencyTimer.unref();
  }

  private tracking(row: Row): DotsSchedulingPolicy["trackingPolicy"] | undefined {
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='answer_rule_turns'").get()) {
      const turn = this.db.prepare("SELECT status,snapshot FROM answer_rule_turns WHERE task_id=? AND input_id=?")
        .get(DOTS_TASK_ID, row.source_message_id) as { status: string; snapshot: string | null } | undefined;
      if (turn?.status === "revoked") return;
      const applied = turn?.snapshot ? (JSON.parse(turn.snapshot) as AnswerRuleDraft).policy?.trackingPolicy : undefined;
      if (applied) return applied;
      const config = this.db.prepare("SELECT config FROM answer_rules WHERE id=?").pluck().get(defaultAnswerRuleId) as string | undefined;
      if (config) return (JSON.parse(config) as AnswerRuleDraft).policy?.trackingPolicy ?? defaultDotsSchedulingPolicy().trackingPolicy;
    }
    return defaultDotsSchedulingPolicy().trackingPolicy;
  }

  observeTool(event: ToolDiagnosticEvent): void {
    if (this.disposed || event.sourceKind !== "main" || !event.taskId || !event.dotsOperationId) return;
    const row = this.pendingDelegations.get(event.dotsOperationId)
      ?? (this.db.prepare(`SELECT * FROM dots_delegations WHERE task_id=? AND operation_id=?
      AND status IN ('pending','running')`).get(event.taskId, event.dotsOperationId) as Row | undefined);
    if (!row || row.task_id !== event.taskId || !["pending", "running"].includes(row.status)) return;
    const policy = this.tracking(row);
    let changed = false;
    if (this.requiresRustWrites) {
      const receiptKey = JSON.stringify([row.operation_id, event.conversationId, event.toolTaskId, event.phase]);
      if (this.pendingToolReceiptKeys.has(receiptKey) || this.db.prepare("SELECT 1 FROM dots_tool_observation_receipts WHERE operation_id=? AND conversation=? AND tool_task=? AND phase=?")
        .get(row.operation_id, event.conversationId, event.toolTaskId, event.phase)) return;
      this.pendingToolReceiptKeys.add(receiptKey);
      const nextAt = policy?.heartbeatMs ? event.at + policy.heartbeatMs : null;
      this.pendingNextAt.set(row.operation_id, nextAt);
      this.enqueueWrite({
        kind: "dotsDelegationObserveTool",
        operationId: row.operation_id,
        conversation: event.conversationId,
        toolTask: event.toolTaskId,
        phase: event.phase,
        at: event.at,
        tool: event.name,
        nextAt,
      }, "observeTool");
      changed = true;
    } else {
      changed = this.db.transaction(() => {
        if (!this.db.prepare("INSERT OR IGNORE INTO dots_tool_observation_receipts VALUES(?,?,?,?)")
          .run(row.operation_id, event.conversationId, event.toolTaskId, event.phase).changes) return false;
        this.db.prepare(`INSERT INTO dots_tool_observations(operation_id,at,tool,phase,next_at) VALUES(?,?,?,?,?)
          ON CONFLICT(operation_id) DO UPDATE SET at=excluded.at,tool=excluded.tool,phase=excluded.phase
          WHERE excluded.at>=dots_tool_observations.at`).run(row.operation_id, event.at, event.name, event.phase,
          policy?.heartbeatMs ? event.at + policy.heartbeatMs : null);
        return true;
      })();
    }
    if (!changed) return;
    this.notify();
    if (row.status === "pending") this.refresh(row.task_id);
    if (!this.observationTimer && policy?.heartbeatMs) this.scheduleObservation();
  }

  observeProgress(taskId: string, operationId: string, identity: string, at: number): void {
    if (this.disposed) return;
    if (this.requiresRustWrites) {
      const pending = this.pendingDelegations.get(operationId);
      const eligible = pending
        ? pending.task_id === taskId && ["pending", "running", "blocked", "completed"].includes(pending.status)
        : Boolean(this.db.prepare(`SELECT 1 FROM dots_delegations WHERE task_id=? AND operation_id=?
          AND status IN ('pending','running','blocked','completed')`).get(taskId, operationId));
      if (!eligible) return;
      const progressKey = JSON.stringify([operationId, identity]);
      if (this.pendingProgressKeys.has(progressKey) || this.db.prepare("SELECT 1 FROM dots_verified_progress WHERE operation_id=? AND identity=?")
        .get(operationId, identity)) return;
      this.pendingProgressKeys.add(progressKey);
      this.enqueueWrite({ kind: "dotsDelegationObserveProgress", taskId, operationId, identity, at }, "observeProgress");
      this.notify();
      return;
    }
    const accepted = this.db.prepare(`INSERT OR IGNORE INTO dots_verified_progress(operation_id,identity,at)
      SELECT operation_id,?,? FROM dots_delegations WHERE task_id=? AND operation_id=?
      AND status IN ('pending','running','blocked','completed')`).run(identity, at, taskId, operationId);
    if (accepted.changes) this.notify();
  }

  private resumeObservations(): void {
    const parked = this.db.prepare(`SELECT d.* FROM dots_delegations d JOIN dots_tool_observations a USING(operation_id)
      WHERE d.status='running' AND a.next_at IS NULL`).all() as Row[];
    if (this.requiresRustWrites) {
      const updates: Array<{ operationId: string; nextAt: number | null }> = [];
      for (const row of parked) {
        if (this.pendingNextAt.get(row.operation_id) != null) continue;
        const policy = this.tracking(row);
        if (policy?.heartbeatMs && this.outbox.activityAvailability(toDelegation(row)) === "active") {
          const nextAt = Date.now() + policy.heartbeatMs;
          this.pendingNextAt.set(row.operation_id, nextAt);
          updates.push({ operationId: row.operation_id, nextAt });
        }
      }
      if (updates.length) this.enqueueWrite({ kind: "dotsDelegationSetObservationNextAt", updates }, "resumeObservations");
      return;
    }
    const next = this.db.prepare("UPDATE dots_tool_observations SET next_at=? WHERE operation_id=? AND next_at IS NULL");
    for (const row of parked) {
      const policy = this.tracking(row);
      if (policy?.heartbeatMs && this.outbox.activityAvailability(toDelegation(row)) === "active")
        next.run(Date.now() + policy.heartbeatMs, row.operation_id);
    }
  }

  private scheduleObservation(): void {
    if (this.disposed || this.native?.supervised) return;
    if (this.observationTimer) clearTimeout(this.observationTimer);
    let next = this.db.prepare("SELECT next_at FROM dots_tool_observations WHERE next_at IS NOT NULL ORDER BY next_at LIMIT 1")
      .pluck().get() as number | undefined;
    for (const val of this.pendingNextAt.values()) {
      if (val !== null && (next === undefined || val < next)) next = val;
    }
    this.observationTimer = next === undefined ? undefined : setTimeout(() => this.observeDue(), Math.max(0, next - Date.now()));
    this.observationTimer?.unref();
  }

  private observeDue(): void {
    this.observationTimer = undefined;
    if (this.disposed) return;
    const now = Date.now();
    const due = this.db.prepare(`SELECT d.*,a.at,a.tool,a.phase,a.next_at,a.last_report_at,
      (SELECT at FROM dots_verified_progress p WHERE p.operation_id=d.operation_id ORDER BY at DESC LIMIT 1) AS progress_at FROM dots_tool_observations a
      JOIN dots_delegations d USING(operation_id) WHERE a.next_at<=?`).all(now) as
      (Row & Activity & { next_at: number })[];
    if (this.requiresRustWrites) {
      const targets = new Set<string>();
      const updates: Array<{ operationId: string; nextAt: number | null }> = [];
      for (const row of due) {
        const effectiveNextAt = this.pendingNextAt.has(row.operation_id) ? this.pendingNextAt.get(row.operation_id)! : row.next_at;
        if (effectiveNextAt === null || effectiveNextAt > now) continue;
        const policy = this.tracking(row);
        const job = toDelegation(row, row);
        const active = row.status === "pending" ||
          (row.status === "running" && this.outbox.activityAvailability(job) === "active");
        const nextAt = active && policy?.heartbeatMs ? now + policy.heartbeatMs : null;
        this.pendingNextAt.set(row.operation_id, nextAt);
        updates.push({ operationId: row.operation_id, nextAt });
        if (!active || row.status !== "running" || !policy?.heartbeatMs) continue;
        const silent = now - row.at >= policy.silenceMs;
        const activity = row.phase === "start" ? `最近观察到工具 ${row.tool} 开始执行。` : `最近观察到工具 ${row.tool} 返回。`;
        const progress = row.progress_at === undefined || row.progress_at === null || now - row.progress_at >= policy.silenceMs
          ? "近期没有新的可核实进展。" : "近期已登记可核实的阶段产物。";
        const text = activity + (silent ? "已有一段时间未观察到新的工具活动。" : "") + progress;
        if (this.outbox.observeActivity(job, effectiveNextAt, text)) targets.add(row.task_id);
      }
      if (updates.length) this.enqueueWrite({ kind: "dotsDelegationSetObservationNextAt", updates }, "observeDue");
      for (const task of targets) this.flushActivity(task);
      this.scheduleObservation();
      return;
    }
    const targets = this.db.transaction(() => {
      const next = this.db.prepare("UPDATE dots_tool_observations SET next_at=? WHERE operation_id=?");
      const targets = new Set<string>();
      for (const row of due) {
        const policy = this.tracking(row);
        const job = toDelegation(row, row);
        const active = row.status === "pending" ||
          (row.status === "running" && this.outbox.activityAvailability(job) === "active");
        next.run(active && policy?.heartbeatMs ? now + policy.heartbeatMs : null, row.operation_id);
        if (!active || row.status !== "running" || !policy?.heartbeatMs) continue;
        const silent = now - row.at >= policy.silenceMs;
        const activity = row.phase === "start" ? `最近观察到工具 ${row.tool} 开始执行。` : `最近观察到工具 ${row.tool} 返回。`;
        const progress = row.progress_at === undefined || row.progress_at === null || now - row.progress_at >= policy.silenceMs
          ? "近期没有新的可核实进展。" : "近期已登记可核实的阶段产物。";
        const text = activity + (silent ? "已有一段时间未观察到新的工具活动。" : "") + progress;
        if (this.outbox.observeActivity(job, row.next_at, text)) targets.add(row.task_id);
      }
      return targets;
    })();
    for (const task of targets) this.flushActivity(task);
    this.scheduleObservation();
  }

  private flushActivity(task: string): void {
    if (this.flights.has(task)) { this.dirty.add(task); return; }
    const flight = this.outbox.flush(task, () => !this.disposed).then(retry => {
      if (retry) this.retryLater(task, true);
    }).catch(() => this.retryLater(task, true)).finally(() => {
      this.flights.delete(task);
      if (this.dirty.delete(task)) this.refresh(task);
    });
    this.flights.set(task, flight);
  }

  rememberOrigin(source: string, origin: DotsReplyOrigin) { this.outbox.rememberOrigin(source, origin); }

  link(taskId: string, operationId: string, sourceMessageId: string, supersedes = false, request?: AgentPromptRequest): void {
    if (!taskId || taskId === DOTS_TASK_ID || !operationId || !sourceMessageId) throw new Error("Dots 委派缺少有效来源或目标");
    if (request && (request.taskId !== taskId || request.userMessageId !== operationId)) throw new Error("委派请求身份不符");
    const now = Date.now();
    if (this.requiresRustWrites) {
      const requestJson = request ? JSON.stringify(request) : null;
      const goalId = request?.dotsGoalId ?? null;
      const existingPending = this.pendingDelegations.get(operationId);
      const existingDb = existingPending ?? (this.db.prepare("SELECT * FROM dots_delegations WHERE operation_id=?").get(operationId) as Row | undefined);
      let inserted = false;
      if (existingDb) {
        if (existingDb.task_id !== taskId || existingDb.source_message_id !== sourceMessageId) {
          throw new Error("原任务不存在或委派标识已被占用");
        }
      } else {
        const taskRow = this.db.prepare("SELECT t.id, t.title, t.space_id, s.path AS space_path, t.cwd FROM tasks t LEFT JOIN spaces s ON s.id=t.space_id WHERE t.id=?")
          .get(taskId) as { id: string; title: string; space_id: string | null; space_path: string | null; cwd: string | null } | undefined;
        if (!taskRow) throw new Error("原任务不存在或委派标识已被占用");
        inserted = true;
        this.pendingDelegations.set(operationId, {
          seq: Date.now(),
          operation_id: operationId,
          task_id: taskId,
          source_message_id: sourceMessageId,
          status: "pending",
          title: taskRow.title,
          text: "",
          files: "[]",
          created_at: now,
          updated_at: now,
          supersedes: Number(supersedes),
          interaction_id: null,
          goal_id: goalId,
        });
      }
      this.enqueueWrite({
        kind: "dotsDelegationLink",
        operationId,
        taskId,
        sourceMessageId,
        now,
        supersedes,
        requestJson,
        goalId,
      }, "link");
      this.outbox.track(operationId, request);
      if (inserted) { this.notify(); this.refreshDependentTasks(operationId); }
      return;
    }
    const inserted = this.db.transaction(() => {
      const insert = this.db.prepare(`INSERT OR IGNORE INTO dots_delegations(operation_id,task_id,source_message_id,title,created_at,updated_at,supersedes,request_json,space_id,space_path,cwd,goal_id)
      SELECT ?,t.id,?,t.title,?,?,?,?,t.space_id,s.path,t.cwd,? FROM tasks t LEFT JOIN spaces s ON s.id=t.space_id WHERE t.id=?`)
      .run(operationId, sourceMessageId, now, now, Number(supersedes), request ? JSON.stringify(request) : null, request?.dotsGoalId ?? null, taskId);
      if (!insert.changes && !this.db.prepare("SELECT 1 FROM dots_delegations WHERE operation_id=? AND task_id=? AND source_message_id=?").get(operationId, taskId, sourceMessageId))
        throw new Error("原任务不存在或委派标识已被占用");
      this.outbox.track(operationId, request);
      return insert.changes;
    })();
    if (inserted) { this.notify(); this.refreshDependentTasks(operationId); }
  }

  /** Replay only the admission gap inherited from the prior host, using the original native id. */
  async recover(submit: RecoverSubmit, available: RecoverAvailable,
    accepted: RecoverAccepted = async (taskId, operationId) => Boolean(await this.inspect(taskId, operationId)),
    allowed: RecoverPolicy = () => true,
    initialWorkspaceMatches?: (taskId: string, cwd: string) => boolean): Promise<void> {
    if (this.disposed) return;
    await this.outbox.recoverDelivered(() => !this.disposed)
      .catch(error => console.warn("[Dots] 恢复已交付任务的列表状态失败", error));
    if (this.disposed) return;
    const workspaceRecovery = initialWorkspaceMatches && this.recoverInitialWorkspaces(initialWorkspaceMatches);
    const groups = new Map<string, Row[]>();
    for (const row of this.recoverable.splice(0)) {
      const group = groups.get(row.task_id) ?? [];
      group.push(row);
      groups.set(row.task_id, group);
    }
    await Promise.all([workspaceRecovery, ...[...groups.values()].map(rows => this.recoverTarget(rows, submit, available, accepted, allowed))]);
    this.refresh();
  }

  private async recoverInitialWorkspaces(matches: (taskId: string, cwd: string) => boolean) {
    // These links predate directory resolution. Only adopt the original task's private directory.
    const scope = `FROM dots_delegations d JOIN tasks t ON t.id=d.task_id
      LEFT JOIN spaces s ON s.id=t.space_id JOIN durable_bot_bindings b ON b.task_id=t.id AND b.cwd=t.cwd
      WHERE d.cwd IS NULL AND d.space_path IS NULL AND s.path IS NULL AND t.space_id IS d.space_id AND t.archived=0
        AND NOT EXISTS(SELECT 1 FROM dots_delegations newer WHERE newer.task_id=d.task_id AND newer.seq>d.seq)
        AND (d.status IN ('pending','running','blocked') OR (d.status='completed' AND d.goal_id IS NULL
          AND EXISTS(SELECT 1 FROM dots_reply_origins o WHERE o.source=d.source_message_id)
          AND EXISTS(SELECT 1 FROM dots_reply_events e WHERE e.operation_id=d.operation_id AND e.status='completed'
            AND e.settled=1 AND e.snapshot='')
          AND EXISTS(SELECT 1 FROM dots_followup_plans p WHERE p.operation_id=d.operation_id
            AND json_array_length(p.plan,'$.steps') <= json_extract(p.plan,'$.step')+1)))`;
    const rows = this.db.prepare(`SELECT d.*,t.cwd AS workspace ${scope}`).all() as (Row & { workspace: string })[];
    const pin = this.db.prepare(`UPDATE dots_delegations SET cwd=? WHERE seq=(
      SELECT d.seq ${scope} AND d.seq=? AND d.status=? AND t.cwd=?) RETURNING *`);
    await Promise.all(rows.map(async row => {
      try {
        if (this.disposed || !matches(row.task_id, row.workspace)) return;
        let result: Result | undefined;
        if (row.status === "completed") {
          if (readDotsWorkerOutcome(row.text)?.dotsState !== "complete") return;
          result = await this.inspect(row.task_id, row.operation_id);
          if (this.disposed || result?.status !== "completed" || !matches(row.task_id, row.workspace)) return;
          const outcome = readDotsWorkerOutcome(result.text);
          if (outcome?.dotsState !== "complete" || (!outcome.result.trim() && !result.artifacts.length)) return;
        }
        let repaired = false;
        if (this.requiresRustWrites) {
          const batch4a = this.native?.batch4aWrite;
          if (!batch4a) throw new Error("只读模式下缺少 Dots 委派工作空间恢复 Rust 写入通道");
          const stillMatching = this.db.prepare(`SELECT d.* ${scope} AND d.seq=? AND d.status=? AND t.cwd=?`)
            .get(row.seq, row.status, row.workspace) as Row | undefined;
          if (stillMatching) {
            const updated: Row & { cwd?: string } = { ...stillMatching, cwd: row.workspace };
            let alsoObserve: Record<string, unknown> | null = null;
            if (result) {
              const job = { ...toDelegation(updated), text: result.text, artifacts: result.artifacts };
              const identity = [job.id, job.status, job.interactionId ?? "", job.status === "running" ? job.text : ""];
              alsoObserve = {
                eventKey: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
                operationId: job.id,
                taskId: job.taskId,
                status: job.status,
                interactionId: job.interactionId ?? null,
                snapshot: JSON.stringify({ ...job, citations: result.citations }),
                restoreSilentlySettled: true,
              };
            } else if (updated.status === "blocked") {
              const job = toDelegation(updated);
              const identity = [job.id, job.status, job.interactionId ?? "", ""];
              alsoObserve = {
                eventKey: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
                operationId: job.id,
                taskId: job.taskId,
                status: job.status,
                interactionId: job.interactionId ?? null,
                snapshot: JSON.stringify(job),
                restoreSilentlySettled: true,
              };
            }
            const opRes = await batch4a.call(this.native, {
              kind: "dotsDelegationUpdateCwd",
              seq: row.seq,
              operationId: null,
              taskId: row.task_id,
              expectedStatus: row.status,
              expectedCwd: row.workspace,
              cwd: row.workspace,
              alsoObserve,
            }) as { updated?: boolean } | undefined;
            repaired = Boolean(opRes?.updated);
            if (repaired) {
              this.pendingCwds.set(updated.operation_id, row.workspace);
              if (result) this.outbox.observe({ ...toDelegation(updated), text: result.text, artifacts: result.artifacts }, result.citations, undefined, true);
              else if (updated.status === "blocked") this.outbox.observe(toDelegation(updated), undefined, undefined, true);
            }
          }
        } else {
          repaired = this.db.transaction(() => {
            const updated = pin.get(row.workspace, row.seq, row.status, row.workspace) as Row | undefined;
            if (!updated) return false;
            if (result) {
              this.outbox.observe({ ...toDelegation(updated), text: result.text, artifacts: result.artifacts }, result.citations, undefined, true);
            } else if (updated.status === "blocked") {
              this.outbox.observe(toDelegation(updated), undefined, undefined, true);
            }
            return true;
          })();
        }
        if (repaired) { this.notify(); this.refresh(row.task_id); }
      } catch (error) {
        console.warn("[Dots] 恢复委派目录失败", row.operation_id, error);
      }
    }));
  }

  private recoverTarget(rows: Row[], submit: RecoverSubmit, available: RecoverAvailable, accepted: RecoverAccepted, allowed: RecoverPolicy, retryDelay = 100): Promise<void> {
    const flight = this.recoverRows(rows, submit, available, accepted, allowed, retryDelay)
      .finally(() => this.recoveryFlights.delete(flight));
    this.recoveryFlights.add(flight);
    return flight;
  }

  private async recoverRows(rows: Row[], submit: RecoverSubmit, available: RecoverAvailable, accepted: RecoverAccepted, allowed: RecoverPolicy, retryDelay: number): Promise<void> {
    const deferred: Row[] = [];
    for (const [index, row] of rows.entries()) {
      if (this.disposed) return;
      const { task_id: taskId, operation_id: operationId } = row;
      const pending = this.db.prepare("SELECT 1 FROM dots_delegations WHERE seq=? AND status='pending' AND request_json IS NOT NULL");
      if (!pending.get(row.seq)) continue;
      try {
        const existing = await accepted(taskId, operationId);
        if (this.disposed) return;
        if (existing) {
          this.refresh(taskId);
          continue;
        }
        if (!pending.get(row.seq)) continue;
        const current = this.db.prepare(`SELECT d.request_json FROM dots_delegations d JOIN tasks t ON t.id=d.task_id LEFT JOIN spaces s ON s.id=t.space_id
          WHERE d.seq=? AND d.status='pending' AND ${dotsDelegationScopeMatches}
            AND NOT EXISTS (SELECT 1 FROM dots_target_controls c WHERE c.task_id=t.id AND c.state IN ('paused','stopped') AND c.operation_id<>d.operation_id)`).get(row.seq) as {request_json: string} | undefined;
        if (!current || !available(taskId)) { this.failed(taskId,operationId,"原任务已移动、暂停或不可用"); continue; }
        const request = JSON.parse(current.request_json) as AgentPromptRequest;
        if (request.taskId !== taskId || request.userMessageId !== operationId) { this.failed(taskId,operationId,"原请求归属已变更"); continue; }
        if (!allowed(request, row.source_message_id)) { deferred.push(row); continue; }
        const result = await submit(request);
        if (this.disposed) return;
        if (result.error || result.cancelled) this.failed(taskId,operationId,result.error?.message ?? "执行已取消");
        this.refresh(taskId);
      } catch (error) {
        if (this.disposed) return;
        const message = "暂时无法确认原任务是否已接收。Dots 会继续核对同一请求。";
        if (!pending.get(row.seq)) continue;
        const now = Date.now();
        if (this.requiresRustWrites) {
          const cur = this.pendingDelegations.get(row.operation_id) ?? row;
          if (cur.text !== message) {
            this.pendingDelegations.set(row.operation_id, { ...cur, text: message, updated_at: now });
            this.enqueueWrite({ kind: "dotsDelegationUpdateText", seq: row.seq, text: message, updatedAt: now }, "recoverText");
            this.notify();
            console.warn("[Dots] 暂时无法恢复原委派", taskId, error);
          }
        } else {
          const updated = this.db.prepare("UPDATE dots_delegations SET text=?,updated_at=? WHERE seq=? AND text<>?")
            .run(message, now, row.seq, message);
          if (updated.changes) {
            this.notify();
            console.warn("[Dots] 暂时无法恢复原委派", taskId, error);
          }
        }
        deferred.push(...rows.slice(index));
        break;
      }
    }
    if (!deferred.length || this.disposed) return;
    const timer = setTimeout(() => {
      this.recoveryTimers.delete(timer);
      if (!this.disposed) void this.recoverTarget(deferred, submit, available, accepted, allowed, Math.min(retryDelay * 2, 30_000))
        .catch(error => console.warn("[Dots] 恢复委派失败", error));
    }, retryDelay);
    timer.unref();
    this.recoveryTimers.add(timer);
  }

  failed(taskId: string, operationId: string, reason: string): void {
    const now = Date.now();
    if (this.requiresRustWrites) {
      const pending = this.pendingDelegations.get(operationId);
      const row = pending ?? (this.db.prepare("SELECT * FROM dots_delegations WHERE task_id=? AND operation_id=?")
        .get(taskId, operationId) as Row | undefined);
      if (!row || row.task_id !== taskId || row.status !== "pending") return;
      const updated: Row = { ...row, status: "failed", text: reason, updated_at: now };
      this.pendingDelegations.set(operationId, updated);
      const job = toDelegation(updated);
      const identity = [job.id, job.status, job.interactionId ?? "", ""];
      const obs = {
        eventKey: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
        operationId: job.id,
        taskId: job.taskId,
        status: job.status,
        interactionId: job.interactionId ?? null,
        snapshot: JSON.stringify(job),
        restoreSilentlySettled: false,
      };
      this.enqueueWrite({
        kind: "dotsDelegationFail",
        taskId,
        operationId,
        reason,
        updatedAt: now,
        observations: [obs],
      }, "failed");
      this.outbox.observe(job);
      this.notify();
      this.refresh(taskId);
      this.refreshDependentTasks(operationId);
      return;
    }
    const changed = this.db.transaction(() => {
      const row = this.db.prepare("UPDATE dots_delegations SET status='failed',text=?,request_json=NULL,updated_at=? WHERE task_id=? AND operation_id=? AND status='pending' RETURNING *")
        .get(reason, now, taskId, operationId) as Row | undefined;
      if (row) this.outbox.observe(toDelegation(row));
      return Boolean(row);
    })();
    if (changed) { this.notify(); this.refresh(taskId); this.refreshDependentTasks(operationId); }
  }

  list(sourceIds?: string[]): DotsDelegation[] {
    if (sourceIds && !sourceIds.length) return [];
    const select = `SELECT d.*, EXISTS(SELECT 1 FROM dots_reply_events e WHERE e.operation_id=d.operation_id) AS proactive_reply
      FROM dots_delegations d`;
    const rows = (sourceIds
      ? this.db.prepare(select + " WHERE source_message_id IN (SELECT value FROM json_each(?)) ORDER BY seq").all(JSON.stringify(sourceIds))
      : this.db.prepare(select + " ORDER BY seq").all()) as Row[];
    const byOp = new Map<string, Row>(rows.map(r => [r.operation_id, r]));
    for (const [opId, pending] of this.pendingDelegations) {
      if (!sourceIds || sourceIds.includes(pending.source_message_id)) {
        const existing = byOp.get(opId);
        byOp.set(opId, existing ? { ...existing, ...pending, seq: existing.seq } : pending);
      }
    }
    const merged = [...byOp.values()].sort((a, b) => a.seq - b.seq);
    const activity = this.db.prepare(`SELECT a.*,
      (SELECT at FROM dots_verified_progress p WHERE p.operation_id=a.operation_id ORDER BY at DESC LIMIT 1) AS progress_at
      FROM dots_tool_observations a WHERE a.operation_id=?`);
    return merged.map(row => toDelegation(row, activity.get(row.operation_id) as Activity | undefined,
      row.status === "blocked" ? (this.pendingDepWaits.get(row.operation_id) ?? this.dependencyWait(row.operation_id, true)) : undefined));
  }

  onPatch(patch: AgentUiPatch): void {
    if (!("taskId" in patch)) return;
    const state = patch.type === "durable_snapshot" ? patch.snapshot : patch.type === "durable_delta" ? patch.delta.state : undefined;
    const rows = patch.type === "durable_snapshot" ? patch.snapshot.messages : patch.type === "durable_delta" ? patch.delta.upserts : [];
    if (this.sampleIntervalMs) {
      const live = rows.filter(row => row.dotsWorkerOutput && row.text.trim()).at(-1);
      if (live?.dotsWorkerOutput) {
        const { operationId, generationId } = live.dotsWorkerOutput;
        this.showOutput(operationId, generationId, live.text, true);
      }
    }
    const checkpoint = rows.some(row => row.dotsWorkerProgress);
    const observation = this.sampleIntervalMs && rows.some(row => row.role === "assistant" && row.entryId && (row.text.trim() || row.thinking?.trim()));
    if (checkpoint || observation || patch.type === "conversation_interaction_snapshot" || patch.type === "conversation_goal_snapshot"
      || state?.status === "waiting_input" || (state && !state.busy && (!state.queued || state.outcome !== undefined))) this.refresh(patch.taskId);
  }

  refresh(taskId?: string): void {
    if (this.disposed) return;
    if (taskId === DOTS_TASK_ID) {
      for (const target of this.outbox.targets()) this.refresh(target);
      return;
    }
    if (!taskId) {
      this.resumeObservations();
      this.scheduleObservation();
      this.scheduleDependencyDeadline();
      const targets = this.db.prepare("SELECT DISTINCT task_id FROM dots_delegations WHERE status IN ('pending','running','blocked')").all() as { task_id: string }[];
      for (const target of new Set([...targets.map(row => row.task_id), ...this.outbox.targets()])) this.refresh(target);
      return;
    }
    if (this.flights.has(taskId)) { this.dirty.add(taskId); return; }
    if (!this.outbox.hasPending(taskId) && !this.db.prepare("SELECT 1 FROM dots_delegations WHERE task_id=? AND status IN ('pending','running','blocked') LIMIT 1").get(taskId)) return;
    const flight = this.reconcile(taskId).catch(error => {
      console.warn("[Dots] 读取委派状态失败", taskId, error);
      this.retryLater(taskId);
    }).then(async () => {
      if (!this.disposed && await this.outbox.flush(taskId, () => !this.disposed)) this.retryLater(taskId);
    }).catch(error => {
      console.warn("[Dots] 回传委派失败", taskId, error);
      this.retryLater(taskId);
    }).finally(() => {
      this.flights.delete(taskId);
      if (this.dirty.delete(taskId)) this.refresh(taskId);
    });
    this.flights.set(taskId, flight);
  }

  private retryLater(taskId: string, outboxOnly = false) {
    if (this.disposed || this.retries.has(taskId)) return;
    const timer = setTimeout(() => {
      this.retries.delete(taskId);
      if (outboxOnly) this.flushActivity(taskId);
      else this.refresh(taskId);
    }, Math.min(2_000, this.outbox.nextSampleDelay(taskId) ?? 2_000));
    timer.unref();
    this.retries.set(taskId, timer);
  }

  private async reconcile(taskId: string): Promise<void> {
    const rows = this.db.prepare("SELECT * FROM dots_delegations WHERE task_id=? AND status IN ('pending','running','blocked') ORDER BY seq DESC").all(taskId) as Row[];
    for (const row of rows) {
      if (!this.db.prepare("SELECT 1 FROM tasks WHERE id=?").get(taskId)) {
        const now = Date.now();
        if (this.requiresRustWrites) {
          const activeRows = this.db.prepare("SELECT * FROM dots_delegations WHERE task_id=? AND status IN ('pending','running','blocked')").all(taskId) as Row[];
          const observations = activeRows.map(entry => {
            const lost: Row = { ...entry, status: "failed", text: "原任务已删除", interaction_id: null, updated_at: now };
            this.pendingDelegations.set(lost.operation_id, lost);
            const job = toDelegation(lost);
            const identity = [job.id, job.status, job.interactionId ?? "", ""];
            return {
              eventKey: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
              operationId: job.id,
              taskId: job.taskId,
              status: job.status,
              interactionId: job.interactionId ?? null,
              snapshot: JSON.stringify(job),
              restoreSilentlySettled: false,
              job,
            };
          });
          this.enqueueWrite({
            kind: "dotsDelegationFail",
            taskId,
            operationId: null,
            reason: "原任务已删除",
            updatedAt: now,
            observations: observations.map(({ job: _job, ...obs }) => obs),
          }, "reconcileTaskDeleted");
          for (const item of observations) this.outbox.observe(item.job);
        } else {
          this.db.transaction(() => {
            const lost = this.db.prepare("UPDATE dots_delegations SET status='failed',text='原任务已删除',interaction_id=NULL,request_json=NULL,updated_at=? WHERE task_id=? AND status IN ('pending','running','blocked') RETURNING *").all(now, taskId) as Row[];
            for (const entry of lost) this.outbox.observe(toDelegation(entry));
          })();
        }
        this.notify();
        return;
      }
      if (row.status === "blocked" && this.dependencyWait(row.operation_id)) continue;
      const result = await this.inspect(taskId, row.operation_id);
      if (this.disposed) return;
      if (!result) continue;
      const sample = this.sampleIntervalMs && result.status === "running" ? result.observation : undefined;
      if (sample) {
        this.showOutput(row.operation_id, sample.generationId, sample.preview, false);
        const tracking = this.tracking(row);
        if (tracking?.milestones) this.outbox.observeSample(toDelegation(row), sample);
      }
      if (result.status !== "running") this.liveOutput.delete(row.operation_id);
      let changed = false;
      if (this.requiresRustWrites) {
        const now = Date.now();
        const files = JSON.stringify(result.artifacts);
        const current = this.pendingDelegations.get(row.operation_id)
          ?? (this.db.prepare("SELECT * FROM dots_delegations WHERE seq=?").get(row.seq) as Row | undefined);
        const willChange = Boolean(
          current
          && ["pending", "running", "blocked"].includes(current.status)
          && (current.status !== result.status || current.interaction_id !== (result.interactionId ?? null)
            || current.text !== result.text || current.files !== files),
        );
        if (willChange && current) {
          const updated: Row = {
            ...current,
            status: result.status,
            text: result.text,
            interaction_id: result.interactionId ?? null,
            files,
            updated_at: now,
          };
          this.pendingDelegations.set(updated.operation_id, updated);
          if (result.dependencyWait) this.pendingDepWaits.set(row.operation_id, result.dependencyWait);
          if (result.status !== "running") this.pendingNextAt.set(row.operation_id, null);
          let observation: Record<string, unknown> | null = null;
          if (result.status !== "running" || (!sample && this.tracking(updated)?.milestones)) {
            const job = toDelegation(updated, undefined, result.dependencyWait);
            if (!(job.status === "running" && !job.text.trim())) {
              const identity = [job.id, job.status, job.interactionId ?? "", job.status === "running" ? job.text : ""];
              observation = {
                eventKey: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
                operationId: job.id,
                taskId: job.taskId,
                status: job.status,
                interactionId: job.interactionId ?? null,
                snapshot: JSON.stringify({ ...job, citations: result.citations, acceptedGoalReceiptId: result.acceptedGoalReceiptId }),
                restoreSilentlySettled: false,
              };
            }
            this.outbox.observe(job, result.citations, result.acceptedGoalReceiptId);
          }
          const batch4a = this.native?.batch4aWrite;
          if (!batch4a) throw new Error("只读模式下缺少 Dots 委派对账 Rust 写入通道");
          const opRes = await batch4a.call(this.native, {
            kind: "dotsDelegationReconcile",
            seq: row.seq,
            taskId,
            operationId: row.operation_id,
            status: result.status,
            text: result.text,
            interactionId: result.interactionId ?? null,
            files,
            updatedAt: now,
            dependencyWait: result.dependencyWait ? {
              prerequisiteId: result.dependencyWait.operationId,
              title: result.dependencyWait.title,
              deadlineAt: result.dependencyWait.deadlineAt,
            } : null,
            verifiedCommit: result.status === "completed" ? (result.verifiedCommit ?? null) : null,
            clearObsNextAt: result.status !== "running",
            supersedeBeforeCreatedAt: row.supersedes ? row.created_at : null,
            observation,
          }) as { changed?: boolean } | undefined;
          changed = Boolean(opRes?.changed);
        }
      } else {
        changed = this.db.transaction(() => {
          const now = Date.now();
          const files = JSON.stringify(result.artifacts);
          const update = this.db.prepare("UPDATE dots_delegations SET status=?,text=?,interaction_id=?,files=?,request_json=NULL,updated_at=? WHERE seq=? AND status IN ('pending','running','blocked') AND (status<>? OR interaction_id IS NOT ? OR text<>? OR files<>?) RETURNING *")
            .get(result.status, result.text, result.interactionId ?? null, files, now, row.seq, result.status, result.interactionId ?? null, result.text, files) as Row | undefined;
          if (!update) return false;
          if (result.dependencyWait) this.db.prepare("INSERT OR IGNORE INTO dots_dependency_waits VALUES(?,?,?,?)")
            .run(row.operation_id, result.dependencyWait.operationId, result.dependencyWait.title, result.dependencyWait.deadlineAt);
          if (result.status === "completed" && result.verifiedCommit) this.db.prepare("INSERT OR IGNORE INTO dots_verified_commits VALUES(?,?)")
            .run(row.operation_id, result.verifiedCommit);
          if (result.status !== "running" || (!sample && this.tracking(update)?.milestones))
            this.outbox.observe(toDelegation(update, undefined, result.dependencyWait), result.citations, result.acceptedGoalReceiptId);
          if (result.status !== "running")
            this.db.prepare("UPDATE dots_tool_observations SET next_at=NULL WHERE operation_id=?").run(row.operation_id);
          if (row.supersedes) this.db.prepare(`UPDATE dots_delegations SET status='superseded',interaction_id=NULL,request_json=NULL,updated_at=?
            WHERE task_id=? AND seq<? AND (status IN ('pending','running','blocked') OR (status='completed' AND updated_at>=?))`)
            .run(now, taskId, row.seq, row.created_at);
          return true;
        })();
      }
      if (changed) {
        this.notify();
        if (result.dependencyWait) this.scheduleDependencyDeadline();
        if (result.status !== "running") this.refreshDependentTasks(row.operation_id);
      }
    }
  }

  async drain(): Promise<void> {
    while (this.flights.size || this.recoveryFlights.size) await Promise.all([...this.flights.values(), ...this.recoveryFlights]);
  }

  close(): void {
    this.disposed = true;
    if (this.observationTimer) clearTimeout(this.observationTimer);
    if (this.dependencyTimer) clearTimeout(this.dependencyTimer);
    if (this.liveNotify) clearTimeout(this.liveNotify);
    this.liveOutput.clear();
    this.dirty.clear();
    for (const timer of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
    for (const timer of this.recoveryTimers) clearTimeout(timer);
    this.recoveryTimers.clear();
  }
}
