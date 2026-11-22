import type Database from "better-sqlite3";
import type { AgentUiPatch, AgentPromptRequest } from "../../shared/agent-ipc";
import type { DotsAssistantReply, DotsDelegation, DotsReplyOrigin } from "../../shared/dots";
import type { ReplyCitation } from "../../shared/chat-reply-content";
import { DOTS_TASK_ID } from "../../shared/dots";
import { DotsReplyOutbox, type AppendDotsReply, type DotsFollowup } from "./DotsReplyOutbox";

type Result = Pick<DotsDelegation, "text" | "artifacts" | "interactionId"> & {
  status: "running" | "blocked" | "completed" | "failed";
  citations?: ReplyCitation[];
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

function toDelegation(row: Row): DotsDelegation {
  return { id: row.operation_id, taskId: row.task_id, title: row.title, sourceMessageId: row.source_message_id,
    status: row.status, goalId: row.goal_id ?? undefined, proactiveReply: row.proactive_reply ? true : undefined, text: row.text, artifacts: JSON.parse(row.files),
    createdAt: row.created_at, updatedAt: row.updated_at, interactionId: row.interaction_id ?? undefined };
}

/** This journal relates the Dots turn to a native submission. The native task owns execution. */
export class DotsDelegations {
  private readonly flights = new Map<string, Promise<void>>();
  private readonly dirty = new Set<string>();
  private disposed = false;
  private readonly recoverable: Row[];
  private readonly outbox: DotsReplyOutbox;
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly recoveryTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly recoveryFlights = new Set<Promise<void>>();
  constructor(private db: Database.Database, private inspect: (taskId: string, operationId: string) => Promise<Result | undefined>,
    private notify: () => void) {
    db.exec(`CREATE TABLE IF NOT EXISTS dots_delegations(
      seq INTEGER PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL, source_message_id TEXT NOT NULL,
      title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', text TEXT NOT NULL DEFAULT '', files TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, supersedes INTEGER NOT NULL DEFAULT 0, interaction_id TEXT, request_json TEXT, space_id TEXT, space_path TEXT, cwd TEXT, goal_id TEXT);
      CREATE TABLE IF NOT EXISTS dots_control_receipts(operation_id TEXT PRIMARY KEY,target_task_id TEXT NOT NULL,outcome TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dots_target_controls(task_id TEXT PRIMARY KEY,state TEXT NOT NULL,operation_id TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS dots_delegations_pending ON dots_delegations(task_id,seq) WHERE status IN ('pending','running','blocked');
      CREATE INDEX IF NOT EXISTS dots_delegations_source ON dots_delegations(source_message_id);`);
    this.recoverable = db.prepare("SELECT * FROM dots_delegations WHERE status='pending' AND request_json IS NOT NULL ORDER BY seq").all() as Row[];
    this.outbox = new DotsReplyOutbox(db);
  }

  connect(followup: DotsFollowup, append: AppendDotsReply, allowed?: (taskId: string) => boolean,
    allowedReply?: (kind: DotsAssistantReply["kind"]) => boolean): void {
    this.outbox.connect(followup, append, allowed, allowedReply);
    for (const row of this.db.prepare("SELECT * FROM dots_delegations WHERE status='blocked'").all() as Row[])
      this.outbox.observe(toDelegation(row));
  }

  rememberOrigin(source: string, origin: DotsReplyOrigin) { this.outbox.rememberOrigin(source, origin); }

  link(taskId: string, operationId: string, sourceMessageId: string, supersedes = false, request?: AgentPromptRequest): void {
    if (!taskId || taskId === DOTS_TASK_ID || !operationId || !sourceMessageId) throw new Error("Dots 委派缺少有效来源或目标");
    if (request && (request.taskId !== taskId || request.userMessageId !== operationId)) throw new Error("委派请求身份不符");
    const now = Date.now();
    const inserted = this.db.transaction(() => {
      const insert = this.db.prepare(`INSERT OR IGNORE INTO dots_delegations(operation_id,task_id,source_message_id,title,created_at,updated_at,supersedes,request_json,space_id,space_path,cwd,goal_id)
      SELECT ?,t.id,?,t.title,?,?,?,?,t.space_id,s.path,t.cwd,? FROM tasks t LEFT JOIN spaces s ON s.id=t.space_id WHERE t.id=?`)
      .run(operationId, sourceMessageId, now, now, Number(supersedes), request ? JSON.stringify(request) : null, request?.dotsGoalId ?? null, taskId);
      if (!insert.changes && !this.db.prepare("SELECT 1 FROM dots_delegations WHERE operation_id=? AND task_id=? AND source_message_id=?").get(operationId, taskId, sourceMessageId))
        throw new Error("原任务不存在或委派标识已被占用");
      this.outbox.track(operationId, request);
      return insert.changes;
    })();
    if (inserted) this.notify();
  }

  /** Replay only the admission gap inherited from the prior host, using the original native id. */
  async recover(submit: RecoverSubmit, available: RecoverAvailable,
    accepted: RecoverAccepted = async (taskId, operationId) => Boolean(await this.inspect(taskId, operationId)),
    allowed: RecoverPolicy = () => true): Promise<void> {
    if (this.disposed) return;
    const groups = new Map<string, Row[]>();
    for (const row of this.recoverable.splice(0)) {
      const group = groups.get(row.task_id) ?? [];
      group.push(row);
      groups.set(row.task_id, group);
    }
    await Promise.all([...groups.values()].map(rows => this.recoverTarget(rows, submit, available, accepted, allowed)));
    this.refresh();
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
          WHERE d.seq=? AND d.status='pending' AND t.space_id IS d.space_id AND s.path IS d.space_path
            AND (t.cwd IS d.cwd OR (d.cwd IS NULL AND t.cwd IS d.space_path))
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
        const updated = this.db.prepare("UPDATE dots_delegations SET text=?,updated_at=? WHERE seq=? AND text<>?")
          .run(message, Date.now(), row.seq, message);
        if (updated.changes) {
          this.notify();
          console.warn("[Dots] 暂时无法恢复原委派", taskId, error);
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
    const changed = this.db.transaction(() => {
      const row = this.db.prepare("UPDATE dots_delegations SET status='failed',text=?,request_json=NULL,updated_at=? WHERE task_id=? AND operation_id=? AND status='pending' RETURNING *")
        .get(reason, Date.now(), taskId, operationId) as Row | undefined;
      if (row) this.outbox.observe(toDelegation(row));
      return Boolean(row);
    })();
    if (changed) { this.notify(); this.refresh(taskId); }
  }

  list(sourceIds?: string[]): DotsDelegation[] {
    if (sourceIds && !sourceIds.length) return [];
    const select = `SELECT d.*, EXISTS(SELECT 1 FROM dots_reply_events e WHERE e.operation_id=d.operation_id) AS proactive_reply
      FROM dots_delegations d`;
    const rows = sourceIds
      ? this.db.prepare(select + " WHERE source_message_id IN (SELECT value FROM json_each(?)) ORDER BY seq").all(JSON.stringify(sourceIds))
      : this.db.prepare(select + " ORDER BY seq").all();
    return (rows as Row[]).map(toDelegation);
  }

  onPatch(patch: AgentUiPatch): void {
    if (!("taskId" in patch)) return;
    const state = patch.type === "durable_snapshot" ? patch.snapshot : patch.type === "durable_delta" ? patch.delta.state : undefined;
    const rows = patch.type === "durable_snapshot" ? patch.snapshot.messages : patch.type === "durable_delta" ? patch.delta.upserts : [];
    const checkpoint = rows.some(row => row.dotsWorkerProgress);
    if (checkpoint || patch.type === "conversation_interaction_snapshot" || patch.type === "conversation_goal_snapshot"
      || state?.status === "waiting_input" || (state && !state.busy && !state.queued)) this.refresh(patch.taskId);
  }

  refresh(taskId?: string): void {
    if (this.disposed) return;
    if (taskId === DOTS_TASK_ID) {
      for (const target of this.outbox.targets()) this.refresh(target);
      return;
    }
    if (!taskId) {
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

  private retryLater(taskId: string) {
    if (this.disposed || this.retries.has(taskId)) return;
    const timer = setTimeout(() => { this.retries.delete(taskId); this.refresh(taskId); }, 2000);
    timer.unref();
    this.retries.set(taskId, timer);
  }

  private async reconcile(taskId: string): Promise<void> {
    const rows = this.db.prepare("SELECT * FROM dots_delegations WHERE task_id=? AND status IN ('pending','running','blocked') ORDER BY seq DESC").all(taskId) as Row[];
    for (const row of rows) {
      if (!this.db.prepare("SELECT 1 FROM tasks WHERE id=?").get(taskId)) {
        this.db.transaction(() => {
          const lost = this.db.prepare("UPDATE dots_delegations SET status='failed',text='原任务已删除',interaction_id=NULL,request_json=NULL,updated_at=? WHERE task_id=? AND status IN ('pending','running','blocked') RETURNING *").all(Date.now(), taskId) as Row[];
          for (const entry of lost) this.outbox.observe(toDelegation(entry));
        })();
        this.notify();
        return;
      }
      const result = await this.inspect(taskId, row.operation_id);
      if (this.disposed) return;
      if (!result) continue;
      const changed = this.db.transaction(() => {
        const now = Date.now();
        const files = JSON.stringify(result.artifacts);
        const update = this.db.prepare("UPDATE dots_delegations SET status=?,text=?,interaction_id=?,files=?,request_json=NULL,updated_at=? WHERE seq=? AND status IN ('pending','running','blocked') AND (status<>? OR interaction_id IS NOT ? OR text<>? OR files<>?) RETURNING *")
          .get(result.status, result.text, result.interactionId ?? null, files, now, row.seq, result.status, result.interactionId ?? null, result.text, files) as Row | undefined;
        if (!update) return false;
        this.outbox.observe(toDelegation(update), result.citations);
        if (row.supersedes) this.db.prepare(`UPDATE dots_delegations SET status='superseded',interaction_id=NULL,request_json=NULL,updated_at=?
          WHERE task_id=? AND seq<? AND (status IN ('pending','running','blocked') OR (status='completed' AND updated_at>=?))`)
          .run(now, taskId, row.seq, row.created_at);
        return true;
      })();
      if (changed) this.notify();
    }
  }

  async drain(): Promise<void> {
    while (this.flights.size || this.recoveryFlights.size) await Promise.all([...this.flights.values(), ...this.recoveryFlights]);
  }

  close(): void {
    this.disposed = true;
    this.dirty.clear();
    for (const timer of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
    for (const timer of this.recoveryTimers) clearTimeout(timer);
    this.recoveryTimers.clear();
  }
}
