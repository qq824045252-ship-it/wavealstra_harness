import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { AgentPromptRequest } from "../../shared/agent-ipc";
import type { ReplyCitation } from "../../shared/chat-reply-content";
import { isDotsAutomaticInput, type DotsAssistantReply, type DotsDelegation, type DotsReplyOrigin } from "../../shared/dots";
import type { DotsFollowupDecision } from "./DotsFollowup";

export type DotsFollowup = (job: DotsDelegation, request?: AgentPromptRequest) =>
  Promise<DotsFollowupDecision>;
export type AppendDotsReply = (reply: DotsAssistantReply, isCurrent: () => boolean) =>
  Promise<"appended" | "existing" | "pending" | "discarded">;

type Event = { event_key: string; operation_id: string; status: string; interaction_id: string | null;
  snapshot: string; reply: string | null };

/** The application and conversation have separate SQLite transactions. A stable delivery key
 * lets the conversation acknowledge an already committed message after an interrupted handoff. */
export class DotsReplyOutbox {
  private handler?: { followup: DotsFollowup; append: AppendDotsReply };
  constructor(private db: Database.Database) {
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

  connect(followup: DotsFollowup, append: AppendDotsReply) { this.handler = { followup, append }; }

  rememberOrigin(source: string, origin: DotsReplyOrigin) {
    this.db.prepare("INSERT OR IGNORE INTO dots_reply_origins VALUES(?,?,?)").run(source, origin.conversationId, origin.entryId);
    if (!this.db.prepare("SELECT 1 FROM dots_reply_origins WHERE source=? AND conversation=? AND entry=?").get(source, origin.conversationId, origin.entryId))
      throw new Error("原始 Dots 消息归属冲突");
  }

  track(operationId: string, request?: AgentPromptRequest) {
    if (request) this.db.prepare("INSERT OR IGNORE INTO dots_followup_requests VALUES(?,?)").run(operationId, JSON.stringify(request));
  }

  observe(job: DotsDelegation, citations?: ReplyCitation[]) {
    if (job.status === "pending" || job.status === "superseded" || (job.status === "running" && !job.text.trim())) return;
    const identity = [job.id, job.status, job.interactionId ?? "", job.status === "running" ? job.text : ""];
    const key = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
    this.db.prepare(`INSERT OR IGNORE INTO dots_reply_events(event_key,operation_id,task_id,status,interaction_id,snapshot) VALUES(?,?,?,?,?,?)`)
      .run(key, job.id, job.taskId, job.status, job.interactionId ?? null, JSON.stringify({ ...job, citations }));
  }

  targets(): string[] {
    if (!this.handler) return [];
    return this.db.prepare("SELECT DISTINCT task_id FROM dots_reply_events WHERE settled=0").pluck().all() as string[];
  }

  hasPending(target: string): boolean {
    return Boolean(this.handler && this.db.prepare("SELECT 1 FROM dots_reply_events WHERE task_id=? AND settled=0 LIMIT 1").get(target));
  }

  private destination(sourceMessageId: string): {sourceMessageId: string; origin?: DotsReplyOrigin} {
    if (sourceMessageId.startsWith("cron-") && isDotsAutomaticInput(sourceMessageId)) {
      const runId = sourceMessageId.slice("cron-".length, -"-input".length);
      const timer = this.db.prepare(`SELECT o.source,o.conversation,o.entry FROM cron_runs r
        JOIN dots_schedule_origins o ON o.job_id=r.job_id WHERE r.id=?`).get(runId) as
        {source:string;conversation:number;entry:number} | undefined;
      if (timer) return {sourceMessageId:timer.source, origin:{conversationId:timer.conversation,entryId:timer.entry}};
    }
    const origin = this.db.prepare("SELECT conversation AS conversationId,entry AS entryId FROM dots_reply_origins WHERE source=?").get(sourceMessageId) as DotsReplyOrigin | undefined;
    return {sourceMessageId, origin};
  }

  private disposition(event: Event): "active" | "hold" | "obsolete" {
    const row = this.db.prepare(`SELECT d.status,d.interaction_id,c.state,d.text,w.lifecycle,w.closure_conclusion,
      EXISTS(SELECT 1 FROM dots_delegations newer WHERE newer.task_id=d.task_id AND newer.seq>d.seq AND newer.supersedes=1 AND newer.status<>'superseded') replaced,
      EXISTS(SELECT 1 FROM dots_followup_plans p WHERE p.operation_id=d.operation_id
        AND json_extract(p.plan,'$.request.dotsGoalIntentRevision') <> w.intent_revision) goal_revised,
      EXISTS(SELECT 1 FROM dots_proactive_pauses p WHERE p.scope='' OR p.scope=d.space_id) paused
      FROM dots_delegations d LEFT JOIN dots_target_controls c ON c.task_id=d.task_id
      LEFT JOIN works w ON w.work_id=d.goal_id WHERE d.operation_id=?`).get(event.operation_id) as
      {status:string;interaction_id:string|null;state:string|null;replaced:number;paused:number;goal_revised:number;text:string;lifecycle:string|null;closure_conclusion:string|null} | undefined;
    if (!row || row.state === "stopped" || row.lifecycle === "closed" && row.closure_conclusion !== "succeeded" ||
      row.replaced || row.goal_revised || row.status !== event.status || row.interaction_id !== event.interaction_id ||
      (row.status === "running" && row.text !== (JSON.parse(event.snapshot) as DotsDelegation).text)) return "obsolete";
    if (event.status === "blocked" && event.interaction_id && !this.db.prepare(
      "SELECT 1 FROM conversation_interactions WHERE id=? AND task_id=(SELECT task_id FROM dots_delegations WHERE operation_id=?) AND status='pending'"
    ).get(event.interaction_id, event.operation_id)) return "obsolete";
    return row.paused || row.state === "paused" || row.lifecycle === "paused" ? "hold" : "active";
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

  private settle(event: Event) {
    this.db.transaction(() => {
      this.db.prepare("UPDATE dots_reply_events SET settled=1,reply=NULL,snapshot='' WHERE event_key=?").run(event.event_key);
      if (event.status === "completed" || event.status === "failed")
        this.db.prepare("DELETE FROM dots_followup_requests WHERE operation_id=?").run(event.operation_id);
    })();
  }

  private async deliver(event: Event, alive: () => boolean, handler: { followup: DotsFollowup; append: AppendDotsReply }) {
    const current = () => alive() && this.disposition(event) === "active";
    const disposition = this.disposition(event);
    if (disposition === "obsolete") this.settle(event);
    if (disposition !== "active") return false;
    let reply: DotsAssistantReply;
    if (event.reply) reply = JSON.parse(event.reply) as DotsAssistantReply;
    else {
      const { citations, ...job } = JSON.parse(event.snapshot) as DotsDelegation & { citations?: ReplyCitation[] };
      const request = this.db.prepare("SELECT request FROM dots_followup_requests WHERE operation_id=?").pluck().get(job.id) as string | undefined;
      const step = await handler.followup(job, request ? JSON.parse(request) : undefined);
      if (!alive() || (step.kind !== "continued" && this.disposition(event) === "hold")) return false;
      if (step.kind === "continued" || step.kind === "quiet") { this.settle(event); return false; }
      if (!current()) return false;
      reply = { deliveryKey: event.event_key, operationId: job.id, taskId: job.taskId, ...this.destination(job.sourceMessageId),
        title: job.title, kind: step.kind === "deliver" ? "conclusion" : "question", text: step.text ?? job.text,
        artifacts: step.artifacts ?? job.artifacts, ...(step.kind === "deliver" && citations?.length ? { citations } : {}) };
      this.db.prepare("UPDATE dots_reply_events SET reply=? WHERE event_key=?").run(JSON.stringify(reply), event.event_key);
    }
    const result = await handler.append(reply, current);
    if (!alive()) return false;
    if (result === "pending") return true;
    if (result !== "discarded" || this.disposition(event) !== "hold") this.settle(event);
    return false;
  }
}
