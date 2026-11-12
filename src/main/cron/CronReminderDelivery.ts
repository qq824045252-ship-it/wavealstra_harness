import { createHash, randomUUID } from "node:crypto";
import type { AppDatabase } from "../db/AppDatabase";
import type { CronJobDto } from "../../shared/agent-ipc";
import { BotConversationRepository } from "../agent/work/BotConversationRepository";
import type { BotMessageEvent } from "../../shared/bot-conversation";
import { reminderResult } from "./CronReminderResults";
import { computeNextRunAt } from "./CronSchedule";

export interface ReminderDelivery {
  deliveryId: string; jobId: string; title: string; body: string; event: BotMessageEvent;
}

/** Notification-only execution for the existing cron scheduler. No model or Task. */
export class CronReminderDelivery {
  private readonly retryFallback = new Map<string, { dueAt: number; failures: number; retryAt: number }>();

  constructor(private readonly db: AppDatabase) {
    db.connection.exec(`CREATE TABLE IF NOT EXISTS cron_reminder_state (
      job_id TEXT PRIMARY KEY REFERENCES cron_jobs(id) ON DELETE CASCADE, next_due_at INTEGER);
      CREATE TABLE IF NOT EXISTS cron_reminder_delivery (
      delivery_id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
      payload_json TEXT NOT NULL, notification_at INTEGER);
      CREATE TABLE IF NOT EXISTS cron_reminder_operations (
      operation_id TEXT PRIMARY KEY, result_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cron_reminder_retries (
      job_id TEXT PRIMARY KEY REFERENCES cron_jobs(id) ON DELETE CASCADE,
      due_at INTEGER NOT NULL, failures INTEGER NOT NULL, retry_at INTEGER NOT NULL);`);
  }

  reset(job: CronJobDto, now = Date.now()): void {
    if (!job.reminder) return;
    const next = job.scheduleType === "at" ? Date.parse(job.scheduleExpr) : computeNextRunAt({ ...job, enabled: true }, now);
    this.db.connection.prepare(`INSERT INTO cron_reminder_state VALUES (?,?)
      ON CONFLICT(job_id) DO UPDATE SET next_due_at=excluded.next_due_at`).run(job.id, next ?? null);
    this.clearRetry(job.id);
  }

  clearRetry(jobId: string): void {
    this.db.connection.prepare("DELETE FROM cron_reminder_retries WHERE job_id=?").run(jobId);
    this.retryFallback.delete(jobId);
  }

  due(job: CronJobDto): number | undefined {
    if (!job.reminder || !job.enabled) return undefined;
    let row = this.db.connection.prepare("SELECT next_due_at FROM cron_reminder_state WHERE job_id=?").get(job.id) as { next_due_at: number | null } | undefined;
    if (!row) { this.reset(job); row = this.db.connection.prepare("SELECT next_due_at FROM cron_reminder_state WHERE job_id=?").get(job.id) as typeof row; }
    return row?.next_due_at ?? undefined;
  }

  nextAttemptAt(job: CronJobDto): number | undefined {
    const dueAt = this.due(job);
    if (dueAt === undefined) return undefined;
    const fallback = this.retryFallback.get(job.id);
    if (fallback?.dueAt === dueAt) return Math.max(dueAt, fallback.retryAt);
    const retry = this.db.connection.prepare("SELECT retry_at FROM cron_reminder_retries WHERE job_id=? AND due_at=?")
      .get(job.id, dueAt) as { retry_at: number } | undefined;
    return Math.max(dueAt, retry?.retry_at ?? dueAt);
  }

  defer(job: CronJobDto, dueAt: number, now = Date.now()): number | undefined {
    // A committed delivery or a changed schedule no longer owns this occurrence.
    if (this.due(job) !== dueAt) return undefined;
    const prior = this.db.connection.prepare("SELECT due_at,failures FROM cron_reminder_retries WHERE job_id=?")
      .get(job.id) as { due_at: number; failures: number } | undefined;
    const fallback = this.retryFallback.get(job.id);
    const failures = (fallback?.dueAt === dueAt ? fallback.failures : prior?.due_at === dueAt ? prior.failures : 0) + 1;
    const retryAt = now + Math.min(300000, 10000 * 2 ** Math.min(failures - 1, 5));
    try {
      this.db.connection.prepare(`INSERT INTO cron_reminder_retries VALUES (?,?,?,?)
        ON CONFLICT(job_id) DO UPDATE SET due_at=excluded.due_at,failures=excluded.failures,retry_at=excluded.retry_at`)
        .run(job.id, dueAt, failures, retryAt);
      this.retryFallback.delete(job.id);
    } catch (error) {
      // A database write failure can also prevent saving the retry journal.
      this.retryFallback.set(job.id, { dueAt, failures, retryAt });
      console.warn("[Cron] reminder retry persistence failed", { jobId: job.id, dueAt, retryAt, error });
    }
    return retryAt;
  }

  checkTarget(job: CronJobDto): string | undefined {
    if (!job.reminder) return undefined;
    const target = job.reminder;
    const row = this.db.connection.prepare(`SELECT 1 FROM bot_conversations c JOIN bots b ON b.bot_id=?
      WHERE c.conversation_id=? AND c.user_id=? AND b.user_id=c.user_id AND b.status='active'
      AND ((c.team_id IS NULL AND c.bot_id=b.bot_id AND ? IS NULL) OR c.team_id=?)`)
      .get(target.botId, target.conversationId, target.userId, target.teamId ?? null, target.teamId ?? null);
    return row ? undefined : "提醒所属 Bot 或对话已不可用";
  }

  deliver(job: CronJobDto, dueAt: number, now = Date.now(), preview = false): ReminderDelivery {
    if (!job.reminder) throw new Error("Not a reminder");
    const target = job.reminder;
    const deliveryId = preview ? `reminder-preview-${randomUUID()}` : `reminder-${createHash("sha256").update(`${job.id}:${dueAt}`).digest("hex")}`;
    const delivery = this.db.connection.transaction(() => {
      const prior = this.db.connection.prepare("SELECT payload_json FROM cron_reminder_delivery WHERE delivery_id=?").get(deliveryId) as { payload_json: string } | undefined;
      if (prior) return JSON.parse(prior.payload_json) as ReminderDelivery;
      const invalid = this.checkTarget(job); if (invalid) throw new Error(invalid);
      const late = !preview && now - dueAt > 5000;
      const formatted = new Intl.DateTimeFormat("zh-CN", { timeZone: job.timezone, dateStyle: "short", timeStyle: "medium" }).format(dueAt);
      const resultReference = reminderResult(this.db.connection, target, deliveryId);
      const body = `${preview ? "测试提醒：" : ""}${job.prompt}${resultReference.notice ? `\n\n${resultReference.notice}` : ""}${late ? `\n\n原定 ${formatted}（${job.timezone}）；设备离线、休眠或调度延迟后补发${job.scheduleType !== "at" ? "，错过的重复提醒已合并为这一条" : ""}。` : ""}`;
      // The report renderer displays summary as the main body. Keep this a
      // reminder, with its saved prompt and timing, rather than a new Work result.
      if (resultReference.feedback?.report) resultReference.feedback.report = {
        ...resultReference.feedback.report, title: job.name, summary: `⏰ ${body}`,
        sourceNotices: [...(resultReference.feedback.report.sourceNotices ?? []),
          `已有成果摘要（未重新执行）：${resultReference.feedback.report.summary}`],
      };
      const messageId = `bot-message-${deliveryId}`;
      this.db.connection.prepare(`INSERT INTO bot_messages(message_id,conversation_id,bot_id,request_id,role,text,status,created_at,updated_at)
        VALUES (?,?,?,?, 'assistant',?,'completed',?,?)`).run(messageId, target.conversationId, target.botId, deliveryId, `⏰ ${body}`, now, now);
      if (resultReference.feedback) this.db.connection.prepare("INSERT INTO bot_work_feedback(message_id,metadata_json) VALUES (?,?)")
        .run(messageId,JSON.stringify(resultReference.feedback));
      this.db.connection.prepare("UPDATE bot_conversations SET revision=revision+1,updated_at=? WHERE conversation_id=?").run(now, target.conversationId);
      const messages = new BotConversationRepository(this.db.connection);
      const conversation = messages.conversation(target.userId, target.botId, target.conversationId, target.teamId)!;
      const result: ReminderDelivery = { deliveryId, jobId: job.id, title: job.name, body,
        event: { botId: target.botId, teamId: target.teamId, conversationId: target.conversationId,
          revision: conversation.revision, message: messages.message(messageId)! } };
      if (!preview) {
      this.db.insertCronRun({ id: deliveryId, jobId: job.id, startedAt: now, finishedAt: now, status: "success" });
      this.db.touchCronLastRun(job.id);
      const next = job.scheduleType === "at" ? undefined : computeNextRunAt({ ...job, runCount: (job.runCount ?? 0) + 1 }, now);
      this.db.connection.prepare("UPDATE cron_reminder_state SET next_due_at=? WHERE job_id=?").run(next ?? null, job.id);
      this.db.connection.prepare("DELETE FROM cron_reminder_retries WHERE job_id=?").run(job.id);
      if (next === undefined) this.db.upsertCronJob({ ...job, enabled: false, updatedAt: now, lastRunAt: now, reminder: { ...target, state: "delivered" } });
      }
      this.db.connection.prepare("INSERT INTO cron_reminder_delivery(delivery_id,job_id,payload_json) VALUES (?,?,?)")
        .run(deliveryId, job.id, JSON.stringify(result));
      return result;
    }).immediate();
    if (!preview) this.retryFallback.delete(job.id);
    return delivery;
  }

  flush(sink?: (delivery: ReminderDelivery) => void): void {
    if (!sink) return;
    for (const row of this.db.connection.prepare("SELECT delivery_id,payload_json FROM cron_reminder_delivery WHERE notification_at IS NULL ORDER BY rowid LIMIT 100")
      .all() as Array<{ delivery_id: string; payload_json: string }>) {
      sink(JSON.parse(row.payload_json) as ReminderDelivery);
      this.db.connection.prepare("UPDATE cron_reminder_delivery SET notification_at=? WHERE delivery_id=?").run(Date.now(), row.delivery_id);
    }
  }
}
