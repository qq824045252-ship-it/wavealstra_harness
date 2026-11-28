
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type { AppDatabase } from "../../db/AppDatabase";
import type { BotRegistry } from "./BotRegistry";
import { type BotSettingsDto } from "../../../shared/bot-settings";

/** Read frozen settings needed by historical Work bindings and Goal evidence. */
export class BotSettingsService {
  constructor(private readonly db: AppDatabase, private readonly bots: BotRegistry,
    private readonly userId: string, private readonly root: string) {
    const fixture = db.fixtureConnection;
    if (fixture && !fixture.readonly) fixture.exec(`CREATE TABLE IF NOT EXISTS bot_message_execution_settings (message_id TEXT PRIMARY KEY REFERENCES bot_messages(message_id) ON DELETE CASCADE, bot_id TEXT NOT NULL, settings_json TEXT NOT NULL, profile_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bot_execution_settings (
      bot_id TEXT PRIMARY KEY REFERENCES bots(bot_id) ON DELETE CASCADE, revision INTEGER NOT NULL, settings_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bot_work_settings (
      work_id TEXT PRIMARY KEY REFERENCES works(work_id) ON DELETE CASCADE, settings_json TEXT NOT NULL);
`);
  }
  async read(botId: string): Promise<BotSettingsDto> {
    if (!this.db.coreIdentity) return this.get(botId);
    const bot = await this.bots.readBot(botId);
    if (!bot || bot.userId !== this.userId) throw new Error("Bot 不属于当前用户");
    const data = await this.db.runtimeAuditReader?.readBotExecutionSettings(botId);
    if (data?.settingsJson) return JSON.parse(data.settingsJson) as BotSettingsDto;
    const id = createHash("sha256").update(botId).digest("hex").slice(0, 24);
    const profile = bot.expertProfile;
    return { botId, revision: 0, workspacePath: "", effectiveWorkspacePath: join(this.root, id),
      spaceId: `bot-space-${id}`, modelId: "", expertId: profile.configuration?.sourceExpertId ?? "",
      skillIds: profile.configuration?.sourceExpertId ? [] : profile.allowedSkillIds,
      mcpIds: profile.configuration?.sourceExpertId ? [] : profile.allowedMcpIds,
      connectorIds: profile.configuration?.sourceExpertId ? [] : profile.allowedConnectorIds };
  }

  get(botId: string): BotSettingsDto {
    const bot = this.bots.getBot(botId);
    if (!bot || bot.userId !== this.userId) throw new Error("Bot 不属于当前用户");
    const row = this.db.connection.prepare("SELECT settings_json FROM bot_execution_settings WHERE bot_id=?").get(botId) as {settings_json: string} | undefined;
    if (row) return JSON.parse(row.settings_json) as BotSettingsDto;
    const id = createHash("sha256").update(botId).digest("hex").slice(0, 24);
    const profile = bot.expertProfile;
    return { botId, revision: 0, workspacePath: "", effectiveWorkspacePath: join(this.root, id),
      spaceId: `bot-space-${id}`, modelId: "", expertId: profile.configuration?.sourceExpertId ?? "",
      skillIds: profile.configuration?.sourceExpertId ? [] : profile.allowedSkillIds,
      mcpIds: profile.configuration?.sourceExpertId ? [] : profile.allowedMcpIds,
      connectorIds: profile.configuration?.sourceExpertId ? [] : profile.allowedConnectorIds };
  }

  messageSettings(messageId: string | undefined, botId: string) {
    if (!messageId) return undefined;
    const row = this.db.connection.prepare("SELECT settings_json,profile_json FROM bot_message_execution_settings WHERE message_id=? AND bot_id=?")
      .get(messageId, botId) as { settings_json: string; profile_json: string } | undefined;
    return row ? { settings: JSON.parse(row.settings_json) as BotSettingsDto,
      profile: JSON.parse(row.profile_json) as import("../../../shared/bot-work").ExpertConfigSnapshotDto } : undefined;
  }

  /** Peer Work keeps the human as its source while executing B's frozen setup. */
  workMessageSettings(work: Pick<import("../../../shared/bot-work").WorkDto, "workId" | "sourceMessageId" | "inputSnapshotId">, botId: string) {
    const db = this.db.connection;
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='bot_collaboration_work_context'").get()) {
      const source = z.object({ receiver: z.string().nullable() }).optional().parse(db.prepare(`SELECT
        json_extract(x.context_json,'$.receiverUserMessageId') receiver FROM bot_collaboration_work_context x
        JOIN bot_collaborations c ON c.work_id=x.work_id AND c.user_id=? AND c.target_bot_id=?
        WHERE x.work_id=? AND x.input_snapshot_id=?`).get(this.userId, botId, work.workId, work.inputSnapshotId));
      if (source?.receiver) return this.messageSettings(source.receiver, botId);
    }
    return this.messageSettings(work.sourceMessageId, botId);
  }

  async readTaskWorkspace(taskId: string): Promise<string | undefined> {
    if (!this.db.coreIdentity) return this.taskWorkspace(taskId);
    const settingsJson = await this.db.runtimeAuditReader?.readBotTaskWorkspace(taskId);
    if (settingsJson === undefined) throw new Error("Core 未确认 Bot 任务工作目录读取");
    if (!settingsJson) return undefined;
    const settings = JSON.parse(settingsJson) as BotSettingsDto;
    if (!isAbsolute(settings.effectiveWorkspacePath)) throw new Error("事项工作目录必须是绝对路径");
    if (!settings.workspacePath) mkdirSync(settings.effectiveWorkspacePath, { recursive: true });
    if (!existsSync(settings.effectiveWorkspacePath) || !statSync(settings.effectiveWorkspacePath).isDirectory()) {
      throw new Error("Bot 工作文件夹已不存在，请恢复文件夹后重试，原任务不会迁移到其他目录");
    }
    return settings.effectiveWorkspacePath;
  }

  taskWorkspace(taskId: string): string | undefined {
    const row = this.db.connection.prepare(`SELECT s.settings_json FROM bot_work_settings s
      JOIN work_dispatch_requests d ON d.work_id=s.work_id WHERE d.task_id=?
      UNION ALL SELECT s.settings_json FROM bot_work_settings s JOIN work_team_executions t ON t.work_id=s.work_id WHERE t.task_id=? LIMIT 1`).get(taskId, taskId) as {settings_json: string} | undefined;
    if (!row) return undefined;
    const settings = JSON.parse(row.settings_json) as BotSettingsDto;
    if (!isAbsolute(settings.effectiveWorkspacePath)) throw new Error("事项工作目录必须是绝对路径");
    if (!settings.workspacePath) mkdirSync(settings.effectiveWorkspacePath, {recursive:true});
    if (!existsSync(settings.effectiveWorkspacePath) || !statSync(settings.effectiveWorkspacePath).isDirectory())
      throw new Error("Bot 工作文件夹已不存在，请恢复文件夹后重试，原任务不会迁移到其他目录");
    return settings.effectiveWorkspacePath;
  }

}
