import { BotWorkspaceNavigationService } from "./BotWorkspaceNavigationService";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { AppDatabase } from "../../db/AppDatabase";
import type { BotRegistry, StageExpertVersionInput } from "./BotRegistry";
import { botSettingsSchema, type BotSettingsDto, type BotSettingsView } from "../../../shared/bot-settings";

/** Settings are per Bot. Work settings are captured once, so later edits never move old tasks. */
export class BotSettingsService {
  constructor(private readonly db: AppDatabase, private readonly bots: BotRegistry,
    private readonly userId: string, private readonly root: string,
    private readonly catalog: () => Promise<Omit<BotSettingsView, "settings">>,
    private readonly assemble: (input: ReturnType<typeof botSettingsSchema.parse>) => StageExpertVersionInput) {
    db.connection.exec(`CREATE TABLE IF NOT EXISTS bot_message_execution_settings (message_id TEXT PRIMARY KEY REFERENCES bot_messages(message_id) ON DELETE CASCADE, bot_id TEXT NOT NULL, settings_json TEXT NOT NULL, profile_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bot_execution_settings (
      bot_id TEXT PRIMARY KEY REFERENCES bots(bot_id) ON DELETE CASCADE, revision INTEGER NOT NULL, settings_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bot_work_settings (
      work_id TEXT PRIMARY KEY REFERENCES works(work_id) ON DELETE CASCADE, settings_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bot_work_member_settings (
      work_id TEXT NOT NULL REFERENCES works(work_id) ON DELETE CASCADE, bot_id TEXT NOT NULL,
      settings_json TEXT NOT NULL, PRIMARY KEY(work_id,bot_id));`);
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
  /** Resolve settings without side effects for discovery; prepare only an actual dispatch. */
  resolveWorkspace(botId: string, prepareDefault = false): string {
    const settings = this.get(botId);
    if (!prepareDefault) return settings.effectiveWorkspacePath;
    if (!settings.workspacePath) mkdirSync(settings.effectiveWorkspacePath, { recursive: true });
    try {
      const directory = realpathSync(settings.effectiveWorkspacePath);
      if (!statSync(directory).isDirectory()) throw new Error("not a directory");
      return directory;
    } catch {
      throw new Error("Bot 工作文件夹已不存在或无法访问，请在 Bot 设置中重新选择文件夹；未创建团队或派发任务");
    }
  }
  async view(botId: string): Promise<BotSettingsView> { return { settings: this.get(botId), ...await this.catalog() }; }
  async prepareMessage(botId: string, selection?: import("../../../shared/bot-conversation").BotComposerSelection) {
    const base = this.get(botId);
    if (!selection) return { settings: base, profile: this.bots.activeSnapshot(botId)! };
    if (selection.consultRequested && selection.externalAgentId) throw new Error("外部 Agent 不能同时使用多模型会诊，请重新选择");
    const choices = await this.catalog();
    for (const [ids, available, label] of [
      [selection.modelId ? [selection.modelId] : [], choices.models, "模型"],
      [selection.expertId ? [selection.expertId] : [], choices.experts, "专家"],
      [selection.skillIds, choices.skills, "技能"], [selection.mcpIds, choices.mcps, "MCP"],
      [selection.connectorIds, choices.connectors, "连接器"],
    ] as const) for (const id of ids) if (!available.some(item => item.id === id && item.available)) throw new Error(`${label}不可用：${id}，请重新选择`);
    const assembled = this.assemble({ ...base, ...selection, expectedRevision: base.revision });
    return { settings: { ...base, ...selection }, profile: {
      ...this.bots.activeSnapshot(botId)!, ...assembled, revision: assembled.sourceRevision,
      capturedAt: Date.now(), allowedSkillIds: assembled.allowedSkillIds ?? [],
      allowedMcpIds: assembled.allowedMcpIds ?? [], allowedConnectorIds: assembled.allowedConnectorIds ?? [],
    } };
  }
  captureMessage(messageId: string, botId: string, frozen: Awaited<ReturnType<BotSettingsService["prepareMessage"]>>) {
    this.db.connection.prepare("INSERT OR IGNORE INTO bot_message_execution_settings VALUES (?,?,?,?)")
      .run(messageId, botId, JSON.stringify(frozen.settings), JSON.stringify(frozen.profile));
  }
  messageSettings(messageId: string | undefined, botId: string) {
    if (!messageId) return undefined;
    const row = this.db.connection.prepare("SELECT settings_json,profile_json FROM bot_message_execution_settings WHERE message_id=? AND bot_id=?")
      .get(messageId, botId) as { settings_json: string; profile_json: string } | undefined;
    return row ? { settings: JSON.parse(row.settings_json) as BotSettingsDto,
      profile: JSON.parse(row.profile_json) as import("../../../shared/bot-work").ExpertConfigSnapshotDto } : undefined;
  }
  async save(request: unknown): Promise<BotSettingsView> {
    const input = botSettingsSchema.parse(request);
    const previous = this.get(input.botId);
    const choices = await this.catalog();
    for (const [ids, available, label] of [
      [input.modelId ? [input.modelId] : [], choices.models, "模型"],
      [input.expertId ? [input.expertId] : [], choices.experts, "专家"],
      [input.skillIds, choices.skills, "Skill"], [input.mcpIds, choices.mcps, "MCP"],
      [input.connectorIds, choices.connectors, "连接器"],
    ] as const) for (const id of ids) if (!available.some(item => item.id === id && item.available)) throw new Error(`${label}不可用：${id}，请重新选择`);
    if (input.workspacePath && (!isAbsolute(input.workspacePath) || !existsSync(input.workspacePath) || !statSync(input.workspacePath).isDirectory()))
      throw new Error("请选择已存在的文件夹绝对路径");
    const effectiveWorkspacePath = input.workspacePath ? realpathSync(input.workspacePath) : join(this.root, previous.spaceId.replace("bot-space-", ""));
    const { expectedRevision: _expectedRevision, ...values } = input;
    const next = { ...values, revision: previous.revision + 1, spaceId: previous.spaceId, effectiveWorkspacePath };
    const profile = this.assemble(input);
    return this.db.transaction(() => {
      if (this.get(input.botId).revision !== input.expectedRevision) throw new Error("Bot 设置已在其他窗口更新，请重新打开设置");
      const staged = this.bots.stageExpertVersion(input.botId, profile);
      if (!staged.ok) throw new Error(staged.message);
      const pending = this.bots.expertVersions(input.botId).find(item => item.version === staged.pendingVersion)!;
      const adopted = this.bots.adoptExpertVersion(input.botId, { pendingVersion: pending.version, snapshotId: pending.snapshotId });
      if (!adopted.ok) throw new Error(adopted.message);
      this.db.connection.prepare("INSERT INTO bot_execution_settings VALUES(?,?,?) ON CONFLICT(bot_id) DO UPDATE SET revision=excluded.revision,settings_json=excluded.settings_json")
        .run(input.botId, next.revision, JSON.stringify(next));
      this.ensureSpace(next);
      return { settings: next, ...choices };
    });
  }
  forWork(workId: string, botId: string, workspacePath?: string): BotSettingsDto {
    const row = this.db.connection.prepare("SELECT settings_json FROM bot_work_settings WHERE work_id=?").get(workId) as {settings_json: string} | undefined;
    if (row) { const frozen = JSON.parse(row.settings_json) as BotSettingsDto; return { ...frozen, spaceId: new BotWorkspaceNavigationService(this.db, this.userId).spaceForWork(workId, botId) }; }
    const work = this.db.connection.prepare("SELECT source_message_id FROM works WHERE work_id=?").get(workId) as { source_message_id?: string } | undefined;
    const base = { ...(this.messageSettings(work?.source_message_id, botId)?.settings ?? this.get(botId)), spaceId: new BotWorkspaceNavigationService(this.db, this.userId).spaceForWork(workId, botId) };
    const settings = workspacePath ? { ...base, workspacePath, effectiveWorkspacePath: workspacePath } : base;
    this.ensureSpace(settings);
    this.db.connection.prepare("INSERT OR IGNORE INTO bot_work_settings VALUES(?,?)").run(workId, JSON.stringify(settings));
    return settings;
  }
  forMember(workId: string, ownerBotId: string, memberBotId: string, workspacePath?: string): BotSettingsDto {
    const owner = this.forWork(workId, ownerBotId, workspacePath);
    if (memberBotId === ownerBotId) return owner;
    const row = this.db.connection.prepare("SELECT settings_json FROM bot_work_member_settings WHERE work_id=? AND bot_id=?").get(workId, memberBotId) as {settings_json: string} | undefined;
    if (row) return { ...JSON.parse(row.settings_json) as BotSettingsDto, spaceId: owner.spaceId };
    const member = this.get(memberBotId);
    const frozen = { ...member, spaceId: owner.spaceId, effectiveWorkspacePath: owner.effectiveWorkspacePath, workspacePath: owner.workspacePath };
    this.db.connection.prepare("INSERT INTO bot_work_member_settings VALUES(?,?,?)").run(workId, memberBotId, JSON.stringify(frozen));
    return frozen;
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
  private ensureSpace(settings: BotSettingsDto): void {
    // Filesystem preparation belongs to native dispatch, where failures become visible blockers.
    // Enqueue must persist first; a vanished folder must not leave a Work with no dispatch request.
    if (settings.spaceId.startsWith("bot-space-")) new BotWorkspaceNavigationService(this.db, this.userId).ensureBot(settings.botId);
    // Space is a grouping, not a mutable cwd override. Each Work carries its original folder.
  }
}
