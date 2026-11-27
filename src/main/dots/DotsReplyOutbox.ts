import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { AgentPromptRequest } from "../../shared/agent-ipc";
import type { ReplyCitation } from "../../shared/chat-reply-content";
import { collectReplyCitations } from "../../shared/chat-reply-sources";
import { dotsSummaryInterval } from "../../shared/dots-settings";
import { DOTS_TASK_ID, type DotsAssistantReply, type DotsDelegation, type DotsReplyOrigin, type DotsTaskDelivery } from "../../shared/dots";
import { normalizeDotsAssistantReply, readCommittedDotsDeliveries, type CommittedDotsDelivery, type DotsAppendOutcome } from "../agent/durable/DurableDotsReply";
import type { RuntimeAuditReader } from "../platform/runtime-audit";
import type { DotsFollowupDecision } from "./DotsFollowup";
import { activitySummary } from "./DotsActivity";
import { dotsGoalConclusion, dotsOriginalDestination } from "./DotsGoalConclusion";

export type DotsFollowup = (job: DotsDelegation, request?: AgentPromptRequest) =>
  Promise<DotsFollowupDecision>;
export type AppendDotsReply = (reply: DotsAssistantReply, isCurrent: () => boolean, outboxEventKey?: string) =>
  Promise<DotsAppendOutcome>;
type OutboxNative = Pick<RuntimeAuditReader, "batch4aWrite" | "supervised"> & Partial<Pick<RuntimeAuditReader, "prepareDotsReply">>;

type Event = { event_key: string; operation_id: string; status: string; interaction_id: string | null;
  task_id: string; snapshot: string; reply: string | null; settled: number };
type SampleTiming = { sampledAt?: number; reportAt?: number; sampleFingerprint?: string };

function goalDeliveryKey(taskId: string, completion: { id: string; stateVersion: number }) {
  return createHash("sha256").update(JSON.stringify([taskId, completion.id, completion.stateVersion])).digest("hex");
}

function deliverySnapshot({ reply, deliveredAt }: CommittedDotsDelivery, terminal: boolean, sourceConclusion?: string,
  sampleFingerprint?: string): string {
  return JSON.stringify({
    delivered: reply.kind,
    deliveryKey: reply.deliveryKey,
    ...(reply.completion && { completion: reply.completion }),
    ...(sourceConclusion !== undefined && { sourceConclusion: activitySummary(sourceConclusion) }),
    ...(sampleFingerprint && { sampleFingerprint, deliveredAt }),
    ...((reply.kind !== "progress" || terminal) && { summary: activitySummary(reply.text), deliveredAt, fileCount: reply.artifacts.length }),
  });
}

/** The application and conversation have separate SQLite transactions. A stable delivery key
 * lets the conversation acknowledge an already committed message after an interrupted handoff. */
export class DotsReplyOutbox {
  private handler?: { followup: DotsFollowup; append: AppendDotsReply; allowed: (taskId: string) => boolean;
    allowedReply: (kind: DotsAssistantReply["kind"]) => boolean };
  private writeTail = Promise.resolve();
  private pendingWriteCount = 0;
  private readonly pendingEvents = new Map<string, Event>();
  private readonly pendingRequests = new Map<string, string | null>();
  private readonly pendingOrigins = new Map<string, { conversationId: number; entryId: number }>();

  constructor(private db: Database.Database, private changed?: (operationId: string) => void,
    private readonly sampleIntervalMs = () => Number(dotsSummaryInterval.defaultSeconds) * 1_000,
    private readonly native?: OutboxNative) {
    if (!db.readonly) {
      db.exec(`CREATE TABLE IF NOT EXISTS dots_reply_origins(source TEXT PRIMARY KEY, conversation INTEGER NOT NULL, entry INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS dots_followup_plans(operation_id TEXT PRIMARY KEY,plan TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS dots_followup_requests(operation_id TEXT PRIMARY KEY, request TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS dots_reply_events(event_key TEXT PRIMARY KEY, operation_id TEXT NOT NULL, task_id TEXT NOT NULL,
          status TEXT NOT NULL, interaction_id TEXT, snapshot TEXT NOT NULL, reply TEXT, settled INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS dots_reply_pending ON dots_reply_events(task_id) WHERE settled=0;
        CREATE INDEX IF NOT EXISTS dots_reply_operation ON dots_reply_events(operation_id);
        INSERT OR IGNORE INTO dots_followup_requests SELECT operation_id,request_json FROM dots_delegations
          WHERE request_json IS NOT NULL AND status IN ('pending','running','blocked')`);
    } else if (this.native?.batch4aWrite) {
      this.enqueueOutbox({ kind: "dotsReplyStartupSync" }, "startupSync");
    }
  }

  private get requiresRustWrites(): boolean {
    return this.db.readonly || Boolean(this.native?.supervised);
  }

  flushWrites(): Promise<void> {
    return this.writeTail;
  }

  private enqueueOutbox(request: Record<string, unknown>, label: string): void {
    const batch4a = this.native?.batch4aWrite;
    if (!batch4a) throw new Error(`只读模式下缺少 Dots 回复队列 Rust 写入通道: ${label}`);
    this.pendingWriteCount += 1;
    this.writeTail = this.writeTail.then(() => batch4a.call(this.native, request)).then(() => undefined, error => {
      console.warn(`[DotsReplyOutbox] ${label} failed`, error);
    }).finally(() => {
      this.pendingWriteCount -= 1;
      if (this.pendingWriteCount === 0) {
        this.pendingEvents.clear();
        this.pendingRequests.clear();
        this.pendingOrigins.clear();
      }
    });
  }

  private getEvent(eventKey: string): Event | undefined {
    return this.pendingEvents.get(eventKey) ?? (this.db.prepare("SELECT * FROM dots_reply_events WHERE event_key=?").get(eventKey) as Event | undefined);
  }

  private listEventsByOperation(operationId: string): Event[] {
    const rows = this.db.prepare("SELECT * FROM dots_reply_events WHERE operation_id=? ORDER BY rowid").all(operationId) as Event[];
    const byKey = new Map(rows.map(r => [r.event_key, r]));
    for (const [k, ev] of this.pendingEvents) {
      if (ev.operation_id === operationId) byKey.set(k, ev);
    }
    return [...byKey.values()];
  }

  private listPendingEventsByTask(taskId: string): Event[] {
    const rows = this.db.prepare("SELECT * FROM dots_reply_events WHERE task_id=? AND settled=0 ORDER BY rowid").all(taskId) as Event[];
    const byKey = new Map(rows.map(r => [r.event_key, r]));
    for (const [k, ev] of this.pendingEvents) {
      if (ev.task_id === taskId) {
        if (ev.settled === 0) byKey.set(k, ev);
        else byKey.delete(k);
      }
    }
    return [...byKey.values()];
  }

  connect(followup: DotsFollowup, append: AppendDotsReply, allowed = (_taskId: string) => true,
    allowedReply = (_kind: DotsAssistantReply["kind"]) => true) {
    this.handler = { followup, append, allowed, allowedReply };
  }

  rememberOrigin(source: string, origin: DotsReplyOrigin) {
    if (this.requiresRustWrites) {
      const pending = this.pendingOrigins.get(source);
      const existing = pending ?? (this.db.prepare("SELECT conversation AS conversationId, entry AS entryId FROM dots_reply_origins WHERE source=?")
        .get(source) as { conversationId: number; entryId: number } | undefined);
      if (existing) {
        if (existing.conversationId !== origin.conversationId || existing.entryId !== origin.entryId) {
          throw new Error("原始 Dots 消息归属冲突");
        }
        return;
      }
      this.pendingOrigins.set(source, { conversationId: origin.conversationId, entryId: origin.entryId });
      this.enqueueOutbox({
        kind: "dotsReplyRememberOrigin",
        source,
        conversationId: origin.conversationId,
        entryId: origin.entryId,
      }, "rememberOrigin");
      return;
    }
    this.db.prepare("INSERT OR IGNORE INTO dots_reply_origins VALUES(?,?,?)").run(source, origin.conversationId, origin.entryId);
    if (!this.db.prepare("SELECT 1 FROM dots_reply_origins WHERE source=? AND conversation=? AND entry=?").get(source, origin.conversationId, origin.entryId))
      throw new Error("原始 Dots 消息归属冲突");
  }

  track(operationId: string, request?: AgentPromptRequest) {
    if (!request) return;
    const requestJson = JSON.stringify(request);
    if (this.requiresRustWrites) {
      if (!this.pendingRequests.has(operationId)) {
        this.pendingRequests.set(operationId, requestJson);
      }
      this.enqueueOutbox({ kind: "dotsReplyTrack", operationId, requestJson }, "track");
      return;
    }
    this.db.prepare("INSERT OR IGNORE INTO dots_followup_requests VALUES(?,?)").run(operationId, requestJson);
  }

  observe(job: DotsDelegation, citations?: ReplyCitation[], acceptedGoalReceiptId?: string, restoreSilentlySettled = false) {
    if (job.status === "pending" || job.status === "superseded" || (job.status === "running" && !job.text.trim())) return;
    const identity = [job.id, job.status, job.interactionId ?? "", job.status === "running" ? job.text : ""];
    const key = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
    const snapshot = JSON.stringify({ ...job, citations, acceptedGoalReceiptId });
    if (this.requiresRustWrites) {
      const existing = this.getEvent(key);
      if (!existing) {
        this.pendingEvents.set(key, {
          event_key: key,
          operation_id: job.id,
          task_id: job.taskId,
          status: job.status,
          interaction_id: job.interactionId ?? null,
          snapshot,
          reply: null,
          settled: 0,
        });
      } else if (restoreSilentlySettled && existing.settled === 1 && existing.reply === null && existing.snapshot === "") {
        this.pendingEvents.set(key, { ...existing, settled: 0, snapshot });
      }
      this.enqueueOutbox({
        kind: "dotsReplyObserve",
        obs: {
          eventKey: key,
          operationId: job.id,
          taskId: job.taskId,
          status: job.status,
          interactionId: job.interactionId ?? null,
          snapshot,
          restoreSilentlySettled,
        },
      }, "observe");
      return;
    }
    this.db.prepare(`INSERT INTO dots_reply_events(event_key,operation_id,task_id,status,interaction_id,snapshot) VALUES(?,?,?,?,?,?)
      ON CONFLICT(event_key) DO UPDATE SET settled=0,snapshot=excluded.snapshot
      WHERE ? AND dots_reply_events.settled=1 AND dots_reply_events.reply IS NULL AND dots_reply_events.snapshot=''`)
      .run(key, job.id, job.taskId, job.status, job.interactionId ?? null, snapshot,
        Number(restoreSilentlySettled));
  }

  activityAvailability(job: DotsDelegation): "active" | "hold" | "obsolete" {
    if (!this.handler || !this.handler.allowed(job.taskId) || !this.handler.allowedReply("progress")) return "hold";
    return this.disposition({ event_key: "", operation_id: job.id, task_id: job.taskId, status: "activity",
      interaction_id: null, snapshot: "", reply: null, settled: 0 });
  }

  observeActivity(job: DotsDelegation, window: number, text: string): boolean {
    // Keep at most one unsent observation. Its stable key survives native receipt recovery.
    const hasPending = this.listEventsByOperation(job.id).some(ev => ev.status === "activity" && ev.settled === 0);
    if (hasPending) return false;
    const key = createHash("sha256").update(JSON.stringify([job.id, "activity", window])).digest("hex");
    const snapshot = JSON.stringify({ ...job, text });
    if (this.requiresRustWrites) {
      if (this.getEvent(key)) return false;
      this.pendingEvents.set(key, {
        event_key: key,
        operation_id: job.id,
        task_id: job.taskId,
        status: "activity",
        interaction_id: null,
        snapshot,
        reply: null,
        settled: 0,
      });
      this.enqueueOutbox({
        kind: "dotsReplyObserveActivity",
        eventKey: key,
        operationId: job.id,
        taskId: job.taskId,
        snapshot,
      }, "observeActivity");
      return true;
    }
    return this.db.prepare(`INSERT OR IGNORE INTO dots_reply_events(event_key,operation_id,task_id,status,interaction_id,snapshot)
      VALUES(?,?,?,'activity',NULL,?)`).run(key, job.id, job.taskId, snapshot).changes > 0;
  }

  observeSample(job: DotsDelegation, observation: { id: string; text: string }): boolean {
    const key = createHash("sha256").update(JSON.stringify([job.id, "sample", observation.id])).digest("hex");
    const sampleFingerprint = createHash("sha256").update(observation.text.replace(/\s+/gu, " ").trim()).digest("hex");
    if (this.requiresRustWrites) {
      const existing = this.listEventsByOperation(job.id);
      if (existing.some(ev => ev.status === "sample" && (ev.event_key === key
        || (() => { try { return JSON.parse(ev.snapshot || "{}").sampleFingerprint === sampleFingerprint; } catch { return false; } })()))) {
        return false;
      }
      const queued = existing.find(ev => ev.status === "sample" && ev.settled === 0 && ev.reply === null);
      const timing = queued ? JSON.parse(queued.snapshot) as SampleTiming : undefined;
      if (queued) {
        this.pendingEvents.set(queued.event_key, { ...queued, settled: 1, snapshot: "" });
      }
      const sampledAt = timing?.sampledAt ?? Date.now();
      const snapshot = JSON.stringify({
        ...job, text: observation.text, sampledAt, sampleFingerprint, reportAt: timing?.reportAt,
      });
      this.pendingEvents.set(key, {
        event_key: key,
        operation_id: job.id,
        task_id: job.taskId,
        status: "sample",
        interaction_id: null,
        snapshot,
        reply: null,
        settled: 0,
      });
      this.enqueueOutbox({
        kind: "dotsReplyObserveSample",
        previousEventKey: queued?.event_key ?? null,
        eventKey: key,
        operationId: job.id,
        taskId: job.taskId,
        snapshot,
      }, "observeSample");
      return true;
    }
    return this.db.transaction(() => {
      if (this.db.prepare(`SELECT 1 FROM dots_reply_events WHERE operation_id=? AND status='sample' AND
        (event_key=? OR CASE WHEN json_valid(snapshot) THEN json_extract(snapshot,'$.sampleFingerprint') END=?)`)
        .get(job.id, key, sampleFingerprint)) return false;
      const queued = this.db.prepare(`SELECT event_key, snapshot FROM dots_reply_events
        WHERE operation_id=? AND status='sample' AND settled=0 AND reply IS NULL`).get(job.id) as
        { event_key: string; snapshot: string } | undefined;
      const timing = queued ? JSON.parse(queued.snapshot) as SampleTiming : undefined;
      if (queued) this.db.prepare("UPDATE dots_reply_events SET settled=1,snapshot='' WHERE event_key=?").run(queued.event_key);
      const sampledAt = timing?.sampledAt ?? Date.now();
      this.db.prepare(`INSERT INTO dots_reply_events(event_key,operation_id,task_id,status,interaction_id,snapshot)
        VALUES(?,?,?,'sample',NULL,?)`).run(key, job.id, job.taskId, JSON.stringify({
        ...job, text: observation.text, sampledAt, sampleFingerprint, reportAt: timing?.reportAt,
      }));
      return true;
    })();
  }

  private sampleReadyAt(event: Pick<Event, "snapshot" | "operation_id">): number {
    const timing = JSON.parse(event.snapshot) as SampleTiming;
    const lastDelivered = this.db.prepare(`SELECT MAX(CASE WHEN json_valid(snapshot) THEN json_extract(snapshot,'$.deliveredAt') END)
      FROM dots_reply_events WHERE operation_id=? AND status='sample' AND settled=1`).pluck().get(event.operation_id) as number | null;
    const interval = this.sampleIntervalMs();
    const due = timing.reportAt ?? (timing.sampledAt ?? 0) + interval;
    return Math.max(due, (lastDelivered ?? 0) + interval);
  }

  nextSampleDelay(taskId: string): number | undefined {
    const pending = this.listPendingEventsByTask(taskId).filter(event => event.status === "sample");
    const now = Date.now();
    const delays = pending.map(event => this.sampleReadyAt(event) - now).filter(delay => delay > 0);
    return delays.length ? Math.min(...delays) : undefined;
  }

  targets(): string[] {
    if (!this.handler) return [];
    const dbTargets = this.db.prepare("SELECT DISTINCT task_id FROM dots_reply_events WHERE settled=0").pluck().all() as string[];
    if (!this.pendingEvents.size) return dbTargets;
    const tasks = new Set(dbTargets);
    for (const ev of this.pendingEvents.values()) {
      if (ev.settled === 0) tasks.add(ev.task_id);
      else if (!this.listPendingEventsByTask(ev.task_id).length) tasks.delete(ev.task_id);
    }
    return [...tasks];
  }

  hasPending(target: string): boolean {
    return Boolean(this.handler && this.listPendingEventsByTask(target).length);
  }

  private committedDeliveries(keys: string[]) {
    const directory = this.db.prepare("SELECT directory FROM durable_bot_bindings WHERE task_id=?")
      .pluck().get(DOTS_TASK_ID) as string | undefined;
    return directory ? readCommittedDotsDeliveries(directory, keys) : Promise.resolve([]);
  }

  private matchesReceipt(event: Event, receipt: CommittedDotsDelivery, destination: Pick<DotsAssistantReply, "sourceMessageId" | "origin">) {
    const { reply } = receipt;
    return reply.taskId === event.task_id && reply.operationId === event.operation_id && reply.sourceMessageId === destination.sourceMessageId
      && (!destination.origin || (reply.origin?.conversationId === destination.origin.conversationId && reply.origin.entryId === destination.origin.entryId));
  }

  async latestTaskDelivery(taskId: string): Promise<DotsTaskDelivery | undefined> {
    const event = this.db.prepare(`SELECT e.*,d.source_message_id,json_extract(e.snapshot,'$.deliveryKey') AS delivery_key
      FROM dots_delegations d JOIN dots_reply_events e ON e.operation_id=d.operation_id AND e.task_id=d.task_id
      WHERE d.task_id=? AND e.settled=1 AND json_valid(e.snapshot)
        AND json_extract(e.snapshot,'$.delivered')='conclusion' AND delivery_key IS NOT NULL
      ORDER BY json_extract(e.snapshot,'$.deliveredAt') DESC,d.seq DESC,e.rowid DESC LIMIT 1`)
      .get(taskId) as (Event & { source_message_id: string; delivery_key: string }) | undefined;
    if (!event) return;
    const [receipt] = await this.committedDeliveries([event.delivery_key]);
    if (!this.db.open || receipt?.reply.kind !== "conclusion") return;
    const { reply } = receipt;
    // Formal Goal delivery can select an earlier commissioning input in its accepted lineage.
    const source = reply.completion ? reply.sourceMessageId : event.source_message_id;
    if (!this.matchesReceipt(event, receipt, dotsOriginalDestination(this.db, source))) return;
    return { deliveryKey: reply.deliveryKey, operationId: event.operation_id, artifacts: reply.artifacts.filter(file => file.saved) };
  }

  /** Rebuild incomplete projections by reading the original conversation's committed messages. */
  async recoverDelivered(alive: () => boolean): Promise<void> {
    const events = this.db.prepare(`SELECT e.*,d.source_message_id,d.goal_id FROM dots_reply_events e
      JOIN dots_delegations d ON d.operation_id=e.operation_id AND d.task_id=e.task_id
      WHERE (e.settled=0 AND e.reply IS NOT NULL) OR (e.settled=1 AND e.status IN ('completed','failed','blocked')
        AND CASE WHEN json_valid(e.snapshot) THEN json_extract(e.snapshot,'$.deliveryKey') IS NULL ELSE e.snapshot='' END)`)
      .all() as (Event & {source_message_id: string; goal_id: string | null})[];
    if (!events.length) return;
    const candidates = events.map(event => {
      const prepared = event.reply ? JSON.parse(event.reply) as DotsAssistantReply : undefined;
      const old = event.settled && event.snapshot ? JSON.parse(event.snapshot) as { delivered?: DotsAssistantReply["kind"]; completion?: DotsAssistantReply["completion"] } : undefined;
      const accepted = event.goal_id && !prepared && old?.delivered !== "question"
        ? dotsGoalConclusion(this.db, event.task_id, event.operation_id)?.completion : undefined;
      const goal = old?.completion ?? accepted;
      const keys = prepared ? [prepared.deliveryKey] : goal ? [goalDeliveryKey(event.task_id, goal), event.event_key] : [event.event_key];
      return { event, keys, kind: prepared?.kind ?? old?.delivered, destination: prepared ?? accepted?.destination ?? dotsOriginalDestination(this.db, event.source_message_id) };
    });
    const committed = await this.committedDeliveries([...new Set(candidates.flatMap(candidate => candidate.keys))]);
    if (!alive()) return;
    const byKey = new Map(committed.map(receipt => [receipt.reply.deliveryKey, receipt]));
    for (const {event, keys, kind, destination} of candidates) {
      for (const key of keys) {
        const receipt = byKey.get(key);
        if (!receipt || kind && kind !== receipt.reply.kind || !this.matchesReceipt(event, receipt, destination)) continue;
        this.settle(event, receipt);
        break;
      }
    }
  }

  private disposition(event: Event): "active" | "hold" | "obsolete" {
    const row = this.db.prepare(`SELECT d.status,d.interaction_id,c.state,d.text,w.lifecycle,w.closure_conclusion,
      EXISTS(SELECT 1 FROM tasks t WHERE t.id=d.task_id) task_exists,
      EXISTS(SELECT 1 FROM dots_delegations newer WHERE newer.task_id=d.task_id AND newer.seq>d.seq AND newer.supersedes=1 AND newer.status<>'superseded') replaced,
      EXISTS(SELECT 1 FROM dots_followup_plans p WHERE p.operation_id=d.operation_id
        AND json_extract(p.plan,'$.request.dotsGoalIntentRevision') <> w.intent_revision) goal_revised,
      EXISTS(SELECT 1 FROM dots_proactive_pauses p WHERE p.scope='' OR p.scope=d.space_id) paused
      FROM dots_delegations d LEFT JOIN dots_target_controls c ON c.task_id=d.task_id
      LEFT JOIN works w ON w.work_id=d.goal_id WHERE d.operation_id=?`).get(event.operation_id) as
      {status:string;interaction_id:string|null;state:string|null;replaced:number;paused:number;goal_revised:number;text:string;lifecycle:string|null;closure_conclusion:string|null;task_exists:number} | undefined;
    if (!row?.task_exists || row.state === "stopped" || row.lifecycle === "closed" && row.closure_conclusion !== "succeeded" ||
      row.replaced || row.goal_revised || row.status !== (event.status === "activity" || event.status === "sample" ? "running" : event.status) ||
      row.interaction_id !== event.interaction_id ||
      (event.status === "running" && row.text !== (JSON.parse(event.snapshot) as DotsDelegation).text)) return "obsolete";
    if ((event.status === "activity" || event.status === "running" || event.status === "sample") &&
      this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='answer_rule_turns'").get() &&
      this.db.prepare(`SELECT 1 FROM answer_rule_turns t JOIN dots_delegations d ON d.source_message_id=t.input_id
        WHERE d.operation_id=? AND t.task_id=? AND t.status='revoked'`).get(event.operation_id, DOTS_TASK_ID)) return "obsolete";
    if (event.status === "blocked" && event.interaction_id && !this.db.prepare(
      "SELECT 1 FROM conversation_interactions WHERE id=? AND task_id=(SELECT task_id FROM dots_delegations WHERE operation_id=?) AND status='pending'"
    ).get(event.interaction_id, event.operation_id)) return "obsolete";
    const held = row.paused || row.state === "paused" || row.lifecycle === "paused";
    if (event.status === "activity" && event.snapshot) {
      // A queued heartbeat is a sample, not a milestone. Re-sample after a
      // pause or after the worker has produced newer facts.
      if (held) return "obsolete";
      const sample = (JSON.parse(event.snapshot) as DotsDelegation).activity;
      const latest = this.db.prepare(`SELECT a.at,a.tool,a.phase,
        (SELECT max(p.at) FROM dots_verified_progress p WHERE p.operation_id=a.operation_id) AS progress_at
        FROM dots_tool_observations a WHERE a.operation_id=?`).get(event.operation_id) as
        { at: number; tool: string; phase: string; progress_at: number | null } | undefined;
      if (!sample || !latest || sample.lastActivityAt !== latest.at || sample.tool !== latest.tool ||
        sample.phase !== latest.phase || (sample.lastProgressAt ?? null) !== latest.progress_at) return "obsolete";
    }
    return held ? "hold" : "active";
  }

  /** Return true when an original receipt or a transient write still needs another wake-up. */
  async flush(target: string, alive: () => boolean): Promise<boolean> {
    if (!this.handler) return false;
    const events = this.listPendingEventsByTask(target);
    let retry = false;
    for (const event of events) {
      if (!alive()) break;
      try {
        if (await this.deliver(event, alive, this.handler)) retry = true;
      } catch (error) {
        console.warn("[Dots] 暂时无法回传委派", event.operation_id, error);
        retry = true;
      }
    }
    return retry;
  }

  private settle(event: Event, receipt?: CommittedDotsDelivery) {
    if (this.requiresRustWrites) {
      const current = this.getEvent(event.event_key);
      if (!current || current.settled !== event.settled || current.snapshot !== event.snapshot) return;
      const sourceConclusion = receipt?.reply.kind === "conclusion"
        ? (() => {
            try { return current.reply ? (JSON.parse(current.reply) as { text?: string }).text : undefined; }
            catch { return undefined; }
          })()
        : undefined;
      const sampleFingerprint = receipt && event.status === "sample"
        ? (JSON.parse(event.snapshot) as SampleTiming).sampleFingerprint ?? event.event_key : undefined;
      const newSnapshot = receipt ? deliverySnapshot(receipt, event.status === "completed" || event.status === "failed",
        sourceConclusion ?? undefined, sampleFingerprint) : "";
      this.pendingEvents.set(event.event_key, { ...current, settled: 1, reply: null, snapshot: newSnapshot });
      const deleteFollowupRequest = event.status === "completed" || event.status === "failed";
      if (deleteFollowupRequest) this.pendingRequests.set(event.operation_id, null);
      this.enqueueOutbox({
        kind: "dotsReplySettle",
        eventKey: event.event_key,
        settled: event.settled,
        expectedSnapshot: event.snapshot,
        newSnapshot,
        deliveredActivityAt: event.status === "activity" && receipt ? receipt.deliveredAt : null,
        deleteFollowupRequest,
        operationId: event.operation_id,
      }, "settle");
      if (event.status !== "running" && event.status !== "activity") this.changed?.(event.operation_id);
      return;
    }
    const changed = this.db.transaction(() => {
      const sourceConclusion = receipt?.reply.kind === "conclusion"
        ? this.db.prepare("SELECT json_extract(reply,'$.text') FROM dots_reply_events WHERE event_key=?").pluck()
          .get(event.event_key) as string | null | undefined
        : undefined;
      const sampleFingerprint = receipt && event.status === "sample"
        ? (JSON.parse(event.snapshot) as SampleTiming).sampleFingerprint ?? event.event_key : undefined;
      // The conversation owns the full reply. Keep the receipt and a short Activity summary.
      const update = this.db.prepare("UPDATE dots_reply_events SET settled=1,reply=NULL,snapshot=? WHERE event_key=? AND settled=? AND snapshot=?")
        .run(receipt ? deliverySnapshot(receipt, event.status === "completed" || event.status === "failed",
          sourceConclusion ?? undefined, sampleFingerprint) : "",
          event.event_key, event.settled, event.snapshot);
      if (!update.changes) return false;
      if (event.status === "activity" && receipt)
        this.db.prepare("UPDATE dots_tool_observations SET last_report_at=? WHERE operation_id=?").run(receipt.deliveredAt, event.operation_id);
      if (event.status === "completed" || event.status === "failed")
        this.db.prepare("DELETE FROM dots_followup_requests WHERE operation_id=?").run(event.operation_id);
      return true;
    })();
    if (changed && event.status !== "running" && event.status !== "activity") this.changed?.(event.operation_id);
  }

  private async deliver(event: Event, alive: () => boolean, handler: NonNullable<DotsReplyOutbox["handler"]>) {
    if (event.status === "sample" && this.sampleReadyAt(event) > Date.now()) return true;
    const disposition = this.disposition(event);
    const preparedReply = event.reply ? JSON.parse(event.reply) as DotsAssistantReply : undefined;
    if (disposition !== "active" || !handler.allowed(event.task_id) || preparedReply && !handler.allowedReply(preparedReply.kind)) {
      const receipt = preparedReply && (await this.committedDeliveries([preparedReply.deliveryKey]))[0];
      if (!alive()) return false;
      if (receipt && preparedReply && receipt.reply.kind === preparedReply.kind && this.matchesReceipt(event, receipt, preparedReply)) this.settle(event, receipt);
      else if (this.disposition(event) === "obsolete" || preparedReply && !handler.allowedReply(preparedReply.kind)) this.settle(event);
      return false;
    }
    const current = () => alive() && handler.allowed(event.task_id) && this.disposition(event) === "active";
    const { citations, acceptedGoalReceiptId, ...job } = JSON.parse(event.snapshot) as DotsDelegation & {
      citations?: ReplyCitation[]; acceptedGoalReceiptId?: string;
    };
    let reply: DotsAssistantReply;
    if (preparedReply) reply = preparedReply;
    else {
      const pendingRequest = this.pendingRequests.get(job.id);
      const request = pendingRequest !== undefined
        ? (pendingRequest ?? undefined)
        : (this.db.prepare("SELECT request FROM dots_followup_requests WHERE operation_id=?").pluck().get(job.id) as string | undefined);
      const step = event.status === "activity" || event.status === "sample" ? { kind: "progress" as const, text: job.text, artifacts: [] }
        : await handler.followup(job, request ? JSON.parse(request) : undefined);
      if (!alive() || (step.kind !== "continued" && this.disposition(event) === "hold")) return false;
      if (step.kind === "deferred") return false;
      if (step.kind === "continued" || step.kind === "quiet") { this.settle(event); return false; }
      const afterFollowup = this.disposition(event);
      if (afterFollowup === "obsolete") this.settle(event);
      if (afterFollowup !== "active") return false;
      const accepted = step.completion;
      if (accepted && accepted.id !== acceptedGoalReceiptId) {
        this.settle(event);
        return false;
      }
      const destination = accepted?.destination ?? dotsOriginalDestination(this.db, job.sourceMessageId);
      const replyCitations = accepted ? accepted.citations : citations;
      const deliveryKey = accepted ? goalDeliveryKey(accepted.taskId, accepted)
        : event.event_key;
      reply = { deliveryKey, operationId: job.id, taskId: job.taskId, ...destination,
        ...(accepted && { completion: { id: accepted.id, workId: accepted.workId, intentRevision: accepted.intentRevision,
          stateVersion: accepted.stateVersion } }),
        title: job.title, kind: step.kind === "deliver" ? "conclusion" : step.kind === "progress" ? "progress" : "question", text: step.text ?? job.text,
        ...(step.retryApproval && { retryApproval: true }),
        ...(event.status === "sample" && { presentation: "report" }),
        artifacts: step.artifacts ?? job.artifacts,
        ...(step.kind === "deliver" && (step.text ?? job.text).trim() && replyCitations?.length ? { citations: replyCitations } : {}) };
    }
    if (job.goalId && !reply.completion && reply.kind === "conclusion" && reply.citations?.length) {
      // Also check replies prepared before the current body and citation selection were linked.
      const matched = collectReplyCitations(reply.text, reply.citations.map(citation => ({ ...citation, text: citation.excerpt })));
      reply.citations = matched.length ? matched : undefined;
    }
    if (this.native?.supervised && this.native.prepareDotsReply) {
      if (!current()) return false;
      if (!handler.allowedReply(reply.kind)) { this.settle(event); return false; }
      const receipt = await this.native.prepareDotsReply(event.event_key, event.snapshot, normalizeDotsAssistantReply(reply));
      if (!receipt || receipt.status === "invalid") throw new Error("Core 未确认 Dots 回传的原对话和正文");
      return false;
    }
    const prepared = JSON.stringify(reply);
    if (prepared !== event.reply) {
      if (this.requiresRustWrites) {
        const latest = this.getEvent(event.event_key) ?? event;
        this.pendingEvents.set(event.event_key, { ...latest, reply: prepared });
        event = { ...event, reply: prepared };
        this.enqueueOutbox({ kind: "dotsReplySetReply", eventKey: event.event_key, replyJson: prepared }, "setReply");
      } else {
        this.db.prepare("UPDATE dots_reply_events SET reply=? WHERE event_key=?").run(prepared, event.event_key);
      }
      if (reply.kind === "conclusion") this.changed?.(event.operation_id);
    }
    if (!handler.allowedReply(reply.kind)) { this.settle(event); return false; }
    const acceptedCurrent = () => {
      if (!reply.completion) return true;
      const current = dotsGoalConclusion(this.db, job.taskId, job.id)?.completion;
      return current?.id === reply.completion.id && current.stateVersion === reply.completion.stateVersion;
    };
    const result = await handler.append(reply, () => current() && acceptedCurrent() && handler.allowedReply(reply.kind));
    if (!alive()) return false;
    if (result.status === "pending") return true;
    if ("reply" in result) this.settle(event, result);
    else if (handler.allowed(event.task_id) && this.disposition(event) !== "hold") this.settle(event);
    return false;
  }
}
