import { BotWorkspaceNavigationService } from "./BotWorkspaceNavigationService";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import type { AppDatabase } from "../../db/AppDatabase";
import type { BotRegistry, StageExpertVersionInput } from "./BotRegistry";
import { botSettingsSchema, type BotSettingsDto, type BotSettingsView } from "../../../shared/bot-settings";

const settingsPatchSchema = botSettingsSchema.omit({ botId: true, expectedRevision: true }).partial();
const configureOperationSchema = z.object({
  operationId: z.string().trim().min(1).max(500),
  botId: botSettingsSchema.shape.botId,
  expectedRevision: botSettingsSchema.shape.expectedRevision,
  changes: settingsPatchSchema,
}).strict();
const storedSettingsSchema = botSettingsSchema.omit({ expectedRevision: true }).extend({
  revision: z.number().int().nonnegative(), spaceId: z.string(), effectiveWorkspacePath: z.string(),
});
const settingsOperationRowSchema = z.object({
  bot_id: z.string(), payload_hash: z.string(), settings_json: z.string(), applied_at: z.number().int().nonnegative(),
});
export type BotSettingsPatch = z.input<typeof settingsPatchSchema>;
export type BotSettingsConfigureOperation = z.input<typeof configureOperationSchema>;
export interface BotSettingsOperationResult { settings: BotSettingsDto; appliedAt: number; replayed: boolean }
interface SettingsOperation { operationId: string; payloadHash: string }
interface PreparedSettings {
  input: z.infer<typeof botSettingsSchema>;
  settings: BotSettingsDto;
  profile: StageExpertVersionInput;
  choices: Omit<BotSettingsView, "settings">;
}

/** Settings are per Bot. Work settings are captured once, so later edits never move old tasks. */
export class BotSettingsService {
  constructor(private readonly db: AppDatabase, private readonly bots: BotRegistry,
    private readonly userId: string, private readonly root: string,
    private readonly catalog: (botId?: string) => Promise<Omit<BotSettingsView, "settings">>,
    private readonly assemble: (input: ReturnType<typeof botSettingsSchema.parse>) => StageExpertVersionInput) {
    db.connection.exec(`CREATE TABLE IF NOT EXISTS bot_message_execution_settings (message_id TEXT PRIMARY KEY REFERENCES bot_messages(message_id) ON DELETE CASCADE, bot_id TEXT NOT NULL, settings_json TEXT NOT NULL, profile_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bot_execution_settings (
      bot_id TEXT PRIMARY KEY REFERENCES bots(bot_id) ON DELETE CASCADE, revision INTEGER NOT NULL, settings_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bot_work_settings (
      work_id TEXT PRIMARY KEY REFERENCES works(work_id) ON DELETE CASCADE, settings_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bot_work_member_settings (
      work_id TEXT NOT NULL REFERENCES works(work_id) ON DELETE CASCADE, bot_id TEXT NOT NULL,
      settings_json TEXT NOT NULL, PRIMARY KEY(work_id,bot_id));
      CREATE TABLE IF NOT EXISTS bot_settings_operations (
      user_id TEXT NOT NULL, operation_id TEXT NOT NULL, bot_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL, settings_json TEXT NOT NULL CHECK(json_valid(settings_json)),
      applied_at INTEGER NOT NULL, PRIMARY KEY(user_id,operation_id));`);
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
    return this.prepareMessageWorkspace(settings);
  }
  /** Prepare the captured directory at execution, never substitute newer Bot settings. */
  prepareMessageWorkspace(settings: BotSettingsDto): string {
    this.get(settings.botId);
    if (!isAbsolute(settings.effectiveWorkspacePath)) throw new Error("Bot 工作文件夹必须是绝对路径");
    if (!settings.workspacePath) {
      const expected = join(this.root, createHash("sha256").update(settings.botId).digest("hex").slice(0, 24));
      if (relative(expected, settings.effectiveWorkspacePath) !== "") throw new Error("Bot 默认工作文件夹身份不匹配");
      mkdirSync(settings.effectiveWorkspacePath, { recursive: true });
    }
    try {
      const directory = realpathSync(settings.effectiveWorkspacePath);
      if (!statSync(directory).isDirectory()) throw new Error("not a directory");
      return directory;
    } catch {
      throw new Error("Bot 工作文件夹已不存在或无法访问，请在 Bot 设置中重新选择文件夹；未创建团队或派发任务");
    }
  }
  async availableChoices(botId?: string): Promise<Omit<BotSettingsView, "settings">> {
    if (botId) this.get(botId);
    return this.catalog(botId);
  }
  async view(botId: string): Promise<BotSettingsView> { return { settings: this.get(botId), ...await this.availableChoices(botId) }; }
  async prepareMessage(botId: string, selection?: import("../../../shared/bot-conversation").BotComposerSelection) {
    const base = this.get(botId);
    if (!selection) return { settings: base, profile: this.bots.activeSnapshot(botId)! };
    if (selection.consultRequested && selection.externalAgentId) throw new Error("外部 Agent 不能同时使用多模型会诊，请重新选择");
    const choices = await this.catalog(botId);
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
    const prepared = await this.prepareSettings(input);
    return { settings: this.commitSettings(prepared, () => {}).settings, ...prepared.choices };
  }
  async configureOperation(request: BotSettingsConfigureOperation, authorize: () => void): Promise<BotSettingsOperationResult> {
    authorize();
    const operation = configureOperationSchema.parse(request);
    const previous = this.get(operation.botId);
    const receipt = { operationId: operation.operationId,
      payloadHash: createHash("sha256").update(JSON.stringify(operation)).digest("hex") };
    const replay = this.operationResult(operation.botId, receipt);
    if (replay) return replay;
    const input = botSettingsSchema.parse({
      botId: operation.botId, expectedRevision: operation.expectedRevision,
      workspacePath: previous.workspacePath, modelId: previous.modelId, expertId: previous.expertId,
      skillIds: previous.skillIds, mcpIds: previous.mcpIds, connectorIds: previous.connectorIds,
      ...operation.changes,
    });
    return this.commitSettings(await this.prepareSettings(input), authorize, receipt);
  }
  private async prepareSettings(input: z.infer<typeof botSettingsSchema>): Promise<PreparedSettings> {
    const previous = this.get(input.botId);
    const choices = await this.catalog(input.botId);
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
    return { input, settings: next, profile, choices };
  }
  private commitSettings(prepared: PreparedSettings, authorize: () => void, operation?: SettingsOperation): BotSettingsOperationResult {
    const { input, settings, profile } = prepared;
    return this.db.connection.transaction(() => {
      authorize();
      if (operation) {
        const replay = this.operationResult(input.botId, operation);
        if (replay) return replay;
      }
      if (this.get(input.botId).revision !== input.expectedRevision) throw new Error("Bot 设置已在其他窗口更新，请重新打开设置");
      const staged = this.bots.stageExpertVersion(input.botId, profile);
      if (!staged.ok) throw new Error(staged.message);
      const pending = this.bots.expertVersions(input.botId).find(item => item.version === staged.pendingVersion)!;
      const adopted = this.bots.adoptExpertVersion(input.botId, { pendingVersion: pending.version, snapshotId: pending.snapshotId });
      if (!adopted.ok) throw new Error(adopted.message);
      this.db.connection.prepare("INSERT INTO bot_execution_settings VALUES(?,?,?) ON CONFLICT(bot_id) DO UPDATE SET revision=excluded.revision,settings_json=excluded.settings_json")
        .run(input.botId, settings.revision, JSON.stringify(settings));
      this.ensureSpace(settings);
      const appliedAt = Date.now();
      if (operation) this.db.connection.prepare(`INSERT INTO bot_settings_operations
        (user_id,operation_id,bot_id,payload_hash,settings_json,applied_at) VALUES(?,?,?,?,?,?)`)
        .run(this.userId, operation.operationId, input.botId, operation.payloadHash, JSON.stringify(settings), appliedAt);
      return { settings, appliedAt, replayed: false };
    }).immediate();
  }
  private operationResult(botId: string, operation: SettingsOperation): BotSettingsOperationResult | undefined {
    const receipt = this.configurationReceipt(operation.operationId);
    if (!receipt) return undefined;
    if (receipt.botId !== botId || receipt.payloadHash !== operation.payloadHash)
      throw new Error("idempotency_conflict: 同一配置操作不能更换 Bot、版本或设置");
    return receipt.result;
  }
  readConfigurationOperation(operationId: string): BotSettingsOperationResult | undefined {
    return this.configurationReceipt(operationId)?.result;
  }
  private configurationReceipt(operationId: string) {
    const row = settingsOperationRowSchema.optional().parse(this.db.connection.prepare(
      "SELECT bot_id,payload_hash,settings_json,applied_at FROM bot_settings_operations WHERE user_id=? AND operation_id=?")
      .get(this.userId, operationId));
    if (!row) return undefined;
    return { botId: row.bot_id, payloadHash: row.payload_hash,
      result: { settings: storedSettingsSchema.parse(JSON.parse(row.settings_json)), appliedAt: row.applied_at, replayed: true } };
  }
  forWork(workId: string, botId: string, workspacePath?: string): BotSettingsDto {
    const row = this.db.connection.prepare("SELECT settings_json FROM bot_work_settings WHERE work_id=?").get(workId) as {settings_json: string} | undefined;
    if (row) { const frozen = JSON.parse(row.settings_json) as BotSettingsDto; return { ...frozen, spaceId: new BotWorkspaceNavigationService(this.db, this.userId).spaceForWork(workId, botId) }; }
    const work = this.db.connection.prepare("SELECT source_message_id,input_snapshot_id FROM works WHERE work_id=?").get(workId) as { source_message_id?: string; input_snapshot_id: string } | undefined;
    const selected = work && this.workMessageSettings({ workId, sourceMessageId: work.source_message_id, inputSnapshotId: work.input_snapshot_id }, botId);
    const base = { ...(selected?.settings ?? this.get(botId)), spaceId: new BotWorkspaceNavigationService(this.db, this.userId).spaceForWork(workId, botId) };
    const settings = workspacePath ? { ...base, workspacePath, effectiveWorkspacePath: workspacePath } : base;
    this.ensureSpace(settings);
    this.db.connection.prepare("INSERT OR IGNORE INTO bot_work_settings VALUES(?,?)").run(workId, JSON.stringify(settings));
    return settings;
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
