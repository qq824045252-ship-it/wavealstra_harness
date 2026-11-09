import type Database from "better-sqlite3";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { DEFAULT_BOT_ID, type WorkActor } from "../../../shared/bot-work";
import type { BotCreateResult } from "../../../shared/bot-create";
import type { BotRegistry } from "./BotRegistry";
import { DESKTOP_USER_GRANTS, type WorkService } from "./WorkService";
const schema = z.object({ botId: z.string().min(1), expectedUpdatedAt: z.number().int().nonnegative() }).strict();

/** Explicit desktop deletion: conversation removal and Work handoff commit together. */
export class BotDeletionService {
  constructor(private readonly db: Database.Database, private readonly bots: BotRegistry,
    private readonly works: WorkService, private readonly host: { userId: string; isAuthority: () => boolean }) {}
  delete(request: unknown): BotCreateResult {
    const parsed = schema.safeParse(request);
    if (!parsed.success) return { ok: false, code: "invalid_request", message: "Bot 删除请求无效" };
    const { botId, expectedUpdatedAt } = parsed.data;
    try {
      return this.db.transaction((): BotCreateResult => {
        if (!this.host.isAuthority()) throw new Error("主宿主未连接，请恢复连接后重试。");
        const bot = this.bots.getBot(botId);
        if (!bot || bot.userId !== this.host.userId) throw new Error("找不到此 Bot，请刷新列表。");
        if (botId === DEFAULT_BOT_ID) throw new Error("默认 MyBuddy 用来接手其他 Bot 的事项，不能删除。");
        if (bot.updatedAt !== expectedUpdatedAt) throw new Error("Bot 已更新，请重新打开设置后删除。");
        const inflight = this.db.prepare(`SELECT b.work_id FROM work_execution_bindings b WHERE
          (b.bot_id=? OR b.work_id IN (SELECT work_id FROM works WHERE owner_bot_id=?))
          AND b.settled_at IS NULL LIMIT 1`).get(botId, botId) as { work_id: string } | undefined;
        if (inflight) throw new Error(`事项 ${inflight.work_id} 仍在执行或收尾。请打开该事项停止执行，待收尾完成后再删除；不会自动终止。`);
        if (this.db.prepare("SELECT 1 FROM bot_messages WHERE bot_id=? AND status IN ('queued','running') LIMIT 1").get(botId))
          throw new Error("Bot 正在回复，请点击对话输入框旁的停止按钮，待回复停止后再删除。");
        const target = this.bots.getBot(DEFAULT_BOT_ID);
        if (!target || target.userId !== bot.userId || target.status !== "active") throw new Error("默认 MyBuddy 不可用，暂不能接手事项。");
        const actor: WorkActor = { kind: "user", userId: this.host.userId, grants: { ...DESKTOP_USER_GRANTS, allowRedelegation: true } };
        const owned = this.db.prepare("SELECT work_id FROM works WHERE owner_bot_id=?").all(botId) as { work_id: string }[];
        for (const row of owned) {
          const work = this.works.getWork(row.work_id)!;
          if (work.lifecycle === "closed") {
            // Closed records are historical reassignment, never reopened or replayed.
            this.db.prepare("UPDATE works SET owner_bot_id=?,owner_epoch=owner_epoch+1,state_version=state_version+1,updated_at=? WHERE work_id=? AND state_version=?")
              .run(target.botId, Date.now(), work.workId, work.stateVersion);
          } else {
            const result = this.works.handoffOwner(actor, { workId: work.workId, operationId: `delete-bot:${randomUUID()}`,
              targetBotId: target.botId, versionGuard: { expectedStateVersion: work.stateVersion,
                expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch } });
            if (!result.ok) throw new Error(`事项“${work.title}”未能转交：${result.message}。请在事项详情处理或结束后重试；本次没有删除任何内容。`);
          }
          this.works.phase5.refreshSummary(work.workId);
        }
        // Team Works and results stay intact; only this Bot's membership is removed.
        const teams = this.db.prepare("SELECT work_id FROM work_participants WHERE bot_id=?").all(botId) as { work_id: string }[];
        this.db.prepare("DELETE FROM work_participants WHERE bot_id=?").run(botId);
        for (const row of teams) this.db.prepare("UPDATE works SET state_version=state_version+1,updated_at=? WHERE work_id=?").run(Date.now(), row.work_id);
        for (const table of ["bot_cancel_intents", "bot_work_reads", "work_conversations", "work_message_refs"])
          this.db.prepare(`DELETE FROM ${table} WHERE conversation_id IN (SELECT conversation_id FROM bot_conversations WHERE bot_id=?)`).run(botId);
        this.db.prepare("DELETE FROM bot_send_receipts WHERE bot_id=?").run(botId);
        this.db.prepare("DELETE FROM bot_messages WHERE bot_id=?").run(botId);
        this.db.prepare("DELETE FROM bot_conversations WHERE bot_id=?").run(botId);
        this.db.prepare("DELETE FROM bot_channel_bindings WHERE bot_id=?").run(botId);
        this.db.prepare("DELETE FROM bot_expert_versions WHERE bot_id=?").run(botId);
        this.db.prepare("DELETE FROM bots WHERE bot_id=?").run(botId);
        return { ok: true, bot, replayed: false };
      }).immediate();
    } catch (error) { return { ok: false, code: "request_conflict", message: error instanceof Error ? error.message : "删除未完成，请刷新后重试。" }; }
  }
}
