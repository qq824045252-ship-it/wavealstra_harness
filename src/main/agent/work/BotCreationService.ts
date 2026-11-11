import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { botCreateSchema, botRenameSchema, botWorkspaceAuthorizationSchema, type BotCreateResult } from "../../../shared/bot-create";
import { minimumAuthorization, type ExpertProfileDto } from "../../../shared/bot-work";
import type { BotRegistry } from "./BotRegistry";

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function comparableName(value: string): string {
  return value.trim().normalize("NFKC").toLowerCase();
}

/** Host-managed Bot identity; never starts execution or sends messages. */
export class BotCreationService {
  constructor(
    private readonly db: Database.Database,
    private readonly bots: BotRegistry,
    private readonly host: { userId: string; isAuthority: () => boolean },
  ) {}

  renameBot(request: unknown): BotCreateResult {
    const parsed = botRenameSchema.safeParse(request);
    if (!parsed.success) return { ok: false, code: "invalid_request", message: "名称需要 1–80 字，不能包含控制字符" };
    const input = parsed.data;
    try {
      return this.db.transaction((): BotCreateResult => {
        if (!this.host.isAuthority()) return { ok: false, code: "not_authority", message: "请在主宿主恢复后重试" };
        const bot = this.bots.getBot(input.botId);
        if (!bot || bot.userId !== this.host.userId) return { ok: false, code: "forbidden", message: "不能重命名此 Bot" };
        if (bot.displayName === input.displayName) return { ok: true, bot, replayed: true };
        if (bot.updatedAt !== input.expectedUpdatedAt) return { ok: false, code: "request_conflict", message: "Bot 已在其他位置更新，请关闭后重新打开重命名" };
        if (this.bots.listBots(this.host.userId).some(other => other.botId !== bot.botId && comparableName(other.displayName) === comparableName(input.displayName)))
          return { ok: false, code: "duplicate_name", message: "已有同名 Bot，请换一个名称" };
        const now = Math.max(Date.now(), bot.updatedAt + 1);
        this.db.prepare("UPDATE bots SET display_name=?, updated_at=? WHERE bot_id=? AND user_id=?")
          .run(input.displayName, now, bot.botId, this.host.userId);
        // Rename only the automatic grouping; user-named spaces and all paths remain unchanged.
        const spaceId = `bot-space-${createHash("sha256").update(bot.botId).digest("hex").slice(0, 24)}`;
        this.db.prepare("UPDATE spaces SET name=?, updated_at=? WHERE id=? AND name=?")
          .run(`${input.displayName} · 工作空间`, now, spaceId, `${bot.displayName} · 工作空间`);
        return { ok: true, bot: this.bots.getBot(bot.botId)!, replayed: false };
      }).immediate();
    } catch { return { ok: false, code: "storage_error", message: "名称未确认保存，请重新打开查看后重试" }; }
  }

  updateWorkspaceAuthorization(request: unknown): BotCreateResult {
    const parsed = botWorkspaceAuthorizationSchema.safeParse(request);
    if (!parsed.success) return { ok: false, code: "invalid_request", message: "请确认此设置只影响新委托" };
    const input = parsed.data;
    try {
      return this.db.transaction((): BotCreateResult => {
        if (!this.host.isAuthority()) return { ok: false, code: "not_authority", message: "请在主宿主恢复后重试" };
        const bot = this.bots.getBot(input.botId);
        if (!bot || bot.userId !== this.host.userId) return { ok: false, code: "forbidden", message: "不能修改此 Bot" };
        if (bot.updatedAt !== input.expectedUpdatedAt) return { ok: false, code: "request_conflict", message: "Bot 已更新，请刷新并重新确认" };
        // Old clients may still send this setting. It no longer changes execution.
        return { ok: true, bot, replayed: true };
      }).immediate();
    } catch { return { ok: false, code: "storage_error", message: "无法读取 Bot，请刷新后重试" }; }
  }

  createBot(request: unknown): BotCreateResult {
    const parsed = botCreateSchema.safeParse(request);
    if (!parsed.success) return { ok: false, code: "invalid_request", message: "请填写 1–80 字的名称及不超过 2000 字的职责；创建请求格式无效" };
    const input = parsed.data;
    // Stable, namespaced identity avoids a schema bump (which discards existing user databases).
    // The immutable initial expert version also serves as the durable request fingerprint.
    const botId = `bot-created-${digest([this.host.userId, input.requestId])}`;
    const creationRevision = `bot-create-v1:${digest(input.allowWorkspaceFiles ? [input.displayName, input.responsibilitySummary, true] : [input.displayName, input.responsibilitySummary])}`;
    try {
      return this.db.transaction((): BotCreateResult => {
        // Check the persisted host lease inside the write lock, not a renderer-supplied claim.
        if (!this.host.isAuthority()) return { ok: false, code: "not_authority", message: "当前窗口所在宿主没有 Bot 管理权，请在主宿主恢复后重试" };
        const existing = this.bots.getBot(botId);
        if (existing) {
          const initial = this.db.prepare("SELECT source_revision FROM bot_expert_versions WHERE bot_id=? AND version=1")
            .get(botId) as { source_revision: string } | undefined;
          if (existing.userId !== this.host.userId || initial?.source_revision !== creationRevision) {
            return { ok: false, code: "request_conflict", message: "此创建请求已用于另一组参数，请发起新的创建请求" };
          }
          return { ok: true, bot: existing, replayed: true };
        }
        if (this.bots.listBots(this.host.userId).some(bot => comparableName(bot.displayName) === comparableName(input.displayName))) {
          return { ok: false, code: "duplicate_name", message: "已有同名 Bot，请换一个名称" };
        }
        const instructions = [
          `你的名称是 ${JSON.stringify(input.displayName)}。`,
          input.responsibilitySummary ? `用户设定的职责：\n${input.responsibilitySummary}` : "用户尚未设定具体职责，请先澄清需要协助的事项。",
          "作为长期主负责人，澄清委托、维护 Work、核对成果与证据。根据用户委托安排执行，不把推测或执行完成当作目标验收。",
          "使用已配置的工具完成委托，不读取其他 Bot 的私人记忆。",
        ].join("\n\n");
        const profile: ExpertProfileDto = {
          expertId: `expert-${botId}`, revision: creationRevision,
          systemPromptHash: createHash("sha256").update(instructions).digest("hex"),
          version: 1, desiredVersion: 1, activeVersion: 1, capturedAt: Date.now(),
          allowedMcpIds: [], allowedSkillIds: [], allowedConnectorIds: [], skillPackages: [],
          configuration: { revision: creationRevision, name: input.displayName, instructions,
            skillIds: [], mcpIds: [], connectorIds: [] },
        };
        const bot = this.bots.registerBot({
          botId, userId: this.host.userId, displayName: input.displayName,
          responsibilitySummary: input.responsibilitySummary, expertProfile: profile,
          authorization: minimumAuthorization(),
        });
        return { ok: true, bot, replayed: false };
      }).immediate();
    } catch {
      // No raw SQLite messages, paths or configuration content cross the IPC boundary.
      return { ok: false, code: "storage_error", message: "Bot 暂未保存，请保留当前内容并重试" };
    }
  }
}
