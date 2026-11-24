import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { AgentPromptRequest } from "../../shared/agent-ipc";
import type { ReplyCitation } from "../../shared/chat-reply-content";
import { collectReplyCitations } from "../../shared/chat-reply-sources";
import { DOTS_TASK_ID, type DotsAssistantReply, type DotsDelegation, type DotsReplyOrigin, type DotsTaskDelivery } from "../../shared/dots";
import { readCommittedDotsDeliveries, type CommittedDotsDelivery, type DotsAppendOutcome } from "../agent/durable/DurableDotsReply";
import type { DotsFollowupDecision } from "./DotsFollowup";
import { activitySummary } from "./DotsActivity";
import { dotsGoalConclusion, dotsOriginalDestination } from "./DotsGoalConclusion";

export type DotsFollowup = (job: DotsDelegation, request?: AgentPromptRequest) =>
  Promise<DotsFollowupDecision>;
export type AppendDotsReply = (reply: DotsAssistantReply, isCurrent: () => boolean) =>
  Promise<DotsAppendOutcome>;

type Event = { event_key: string; operation_id: string; status: string; interaction_id: string | null;
  task_id: string; snapshot: string; reply: string | null; settled: number };

function goalDeliveryKey(taskId: string, completion: { id: string; stateVersion: number }) {
  return createHash("sha256").update(JSON.stringify([taskId, completion.id, completion.stateVersion])).digest("hex");
}

function deliverySnapshot({ reply, deliveredAt }: CommittedDotsDelivery, terminal: boolean): string {
  return JSON.stringify({
    delivered: reply.kind,
    deliveryKey: reply.deliveryKey,
    ...(reply.completion && { completion: reply.completion }),
    ...((reply.kind !== "progress" || terminal) && { summary: activitySummary(reply.text), deliveredAt, fileCount: reply.artifacts.length }),
  });
}

/** The application and conversation have separate SQLite transactions. A stable delivery key
 * lets the conversation acknowledge an already committed message after an interrupted handoff. */
export class DotsReplyOutbox {
  private handler?: { followup: DotsFollowup; append: AppendDotsReply; allowed: (taskId: string) => boolean;
    allowedReply: (kind: DotsAssistantReply["kind"]) => boolean };
  constructor(private db: Database.Database, private changed?: (operationId: string) => void) {
    db.exec(`CREATE TABLE IF NOT EXISTS dots_reply_origins(source TEXT PRIMARY KEY, conversation INTEGER NOT NULL, entry INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS dots_followup_plans(operation_id TEXT PRIMARY KEY,plan TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dots_followup_requests(operation_id TEXT PRIMARY KEY, request TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dots_reply_events(event_key TEXT PRIMARY KEY, operation_id TEXT NOT NULL, task_id TEXT NOT NULL,
        status TEXT NOT NULL, interaction_id TEXT, snapshot TEXT NOT NULL, reply TEXT, settled INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS dots_reply_pending ON dots_reply_events(task_id) WHERE settled=0;
      CREATE INDEX IF NOT EXISTS dots_reply_operation ON dots_reply_events(operation_id);
      INSERT OR IGNORE INTO dots_followup_requests SELECT operation_id,request_json FROM dots_delegations
        WHERE request_json IS NOT NULL AND status IN ('pending','running','blocked')`);
  }

  connect(followup: DotsFollowup, append: AppendDotsReply, allowed = (_taskId: string) => true,
    allowedReply = (_kind: DotsAssistantReply["kind"]) => true) {
    this.handler = { followup, append, allowed, allowedReply };
  }

  rememberOrigin(source: string, origin: DotsReplyOrigin) {
    this.db.prepare("INSERT OR IGNORE INTO dots_reply_origins VALUES(?,?,?)").run(source, origin.conversationId, origin.entryId);
    if (!this.db.prepare("SELECT 1 FROM dots_reply_origins WHERE source=? AND conversation=? AND entry=?").get(source, origin.conversationId, origin.entryId))
      throw new Error("原始 Dots 消息归属冲突");
  }

  track(operationId: string, request?: AgentPromptRequest) {
    if (request) this.db.prepare("INSERT OR IGNORE INTO dots_followup_requests VALUES(?,?)").run(operationId, JSON.stringify(request));
  }

  observe(job: DotsDelegation, citations?: ReplyCitation[], acceptedGoalReceiptId?: string, restoreSilentlySettled = false) {
    if (job.status === "pending" || job.status === "superseded" || (job.status === "running" && !job.text.trim())) return;
    const identity = [job.id, job.status, job.interactionId ?? "", job.status === "running" ? job.text : ""];
    const key = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
    this.db.prepare(`INSERT INTO dots_reply_events(event_key,operation_id,task_id,status,interaction_id,snapshot) VALUES(?,?,?,?,?,?)
      ON CONFLICT(event_key) DO UPDATE SET settled=0,snapshot=excluded.snapshot
      WHERE ? AND dots_reply_events.settled=1 AND dots_reply_events.reply IS NULL AND dots_reply_events.snapshot=''`)
      .run(key, job.id, job.taskId, job.status, job.interactionId ?? null, JSON.stringify({ ...job, citations, acceptedGoalReceiptId }),
        Number(restoreSilentlySettled));
  }

  activityAvailability(job: DotsDelegation): "active" | "hold" | "obsolete" {
    if (!this.handler || !this.handler.allowed(job.taskId) || !this.handler.allowedReply("progress")) return "hold";
    return this.disposition({ event_key: "", operation_id: job.id, task_id: job.taskId, status: "activity",
      interaction_id: null, snapshot: "", reply: null, settled: 0 });
  }

  observeActivity(job: DotsDelegation, window: number, text: string): boolean {
    // Keep at most one unsent observation. Its stable key survives native receipt recovery.
    if (this.db.prepare("SELECT 1 FROM dots_reply_events WHERE operation_id=? AND status='activity' AND settled=0").get(job.id))
      return false;
    const key = createHash("sha256").update(JSON.stringify([job.id, "activity", window])).digest("hex");
    return this.db.prepare(`INSERT OR IGNORE INTO dots_reply_events(event_key,operation_id,task_id,status,interaction_id,snapshot)
      VALUES(?,?,?,'activity',NULL,?)`).run(key, job.id, job.taskId, JSON.stringify({ ...job, text })).changes > 0;
  }

  targets(): string[] {
    if (!this.handler) return [];
    return this.db.prepare("SELECT DISTINCT task_id FROM dots_reply_events WHERE settled=0").pluck().all() as string[];
  }

  hasPending(target: string): boolean {
    return Boolean(this.handler && this.db.prepare("SELECT 1 FROM dots_reply_events WHERE task_id=? AND settled=0 LIMIT 1").get(target));
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
      row.replaced || row.goal_revised || row.status !== (event.status === "activity" ? "running" : event.status) ||
      row.interaction_id !== event.interaction_id ||
      (event.status === "running" && row.text !== (JSON.parse(event.snapshot) as DotsDelegation).text)) return "obsolete";
    if ((event.status === "activity" || event.status === "running") &&
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
    const events = this.db.prepare("SELECT * FROM dots_reply_events WHERE task_id=? AND settled=0 ORDER BY rowid").all(target) as Event[];
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
    const changed = this.db.transaction(() => {
      // The conversation owns the full reply. Keep the receipt and a short Activity summary.
      const update = this.db.prepare("UPDATE dots_reply_events SET settled=1,reply=NULL,snapshot=? WHERE event_key=? AND settled=? AND snapshot=?")
        .run(receipt ? deliverySnapshot(receipt, event.status === "completed" || event.status === "failed") : "",
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
      const request = this.db.prepare("SELECT request FROM dots_followup_requests WHERE operation_id=?").pluck().get(job.id) as string | undefined;
      const step = event.status === "activity" ? { kind: "progress" as const, text: job.text, artifacts: [] }
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
        artifacts: step.artifacts ?? job.artifacts,
        ...(step.kind === "deliver" && (step.text ?? job.text).trim() && replyCitations?.length ? { citations: replyCitations } : {}) };
    }
    if (job.goalId && !reply.completion && reply.kind === "conclusion" && reply.citations?.length) {
      // Also check replies prepared before the current body and citation selection were linked.
      const matched = collectReplyCitations(reply.text, reply.citations.map(citation => ({ ...citation, text: citation.excerpt })));
      reply.citations = matched.length ? matched : undefined;
    }
    const prepared = JSON.stringify(reply);
    if (prepared !== event.reply)
      this.db.prepare("UPDATE dots_reply_events SET reply=? WHERE event_key=?").run(prepared, event.event_key);
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
