import { isSharedBotConversation } from "./BotConversationAudience";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { botOrganizationReceiptSchema, botOrganizationSummarySchema, type BotOrganizationSummaryDto } from "../../../shared/bot-organization";
import { botSettingsSchema } from "../../../shared/bot-settings";
import type { BotDto } from "../../../shared/bot-work";
import { botCreateSchema } from "../../../shared/bot-create";
import type { BotConversationServiceOptions } from "./BotConversationService";
import type { BotConversationRepository, BotMessageReceipt } from "./BotConversationRepository";
import type { BotCreationService } from "./BotCreationService";
import type { BotSettingsService } from "./BotSettingsService";
import type { BotCollaborationService } from "./BotCollaborationService";
import { botWorkCreateSchema } from "./BotForegroundTools";

const id = z.string().trim().min(1).max(500);
const text = z.string().trim().min(1).max(8000);
const patch = botSettingsSchema.omit({ botId: true, expectedRevision: true }).partial().strict();
const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("existing"), botId: id, configuration: z.object({ expectedRevision: z.number().int().nonnegative(), changes: patch }).strict().optional() }).strict(),
  z.object({ kind: z.literal("create"), displayName: botCreateSchema.shape.displayName,
    responsibilitySummary: botCreateSchema.shape.responsibilitySummary,
    configuration: patch.optional(), whyExistingBotsDoNotFit: z.string().trim().min(1).max(2000) }).strict(),
]);
const contactSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("ask"), text }).strict(),
  z.object({ kind: z.literal("delegate"), plan: botWorkCreateSchema }).strict(),
]);
export const botOrganizationCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("discover"), requirement: text.optional(), afterBotId: id.optional() }).strict(),
  z.object({ action: z.literal("arrange"), target: targetSchema, contact: contactSchema }).strict(),
  z.object({ action: z.literal("query"), intentId: id.optional() }).strict(),
  z.object({ action: z.literal("resume"), intentId: id }).strict(),
]);
/** Provider tools require an object root; the strict action union is the boundary. */
export const botOrganizationToolSchema = z.object({
  action: z.enum(["discover", "arrange", "query", "resume"]), requirement: text.optional(), afterBotId: id.optional(),
  target: targetSchema.optional(), contact: contactSchema.optional(), intentId: id.optional(),
}).strict();
type Receipt = BotOrganizationSummaryDto["receipts"][number];
const choiceSchema = z.object({ id: z.string(), name: z.string(), available: z.boolean() });
const discoverySchema = z.object({
  bots: z.array(z.object({ botId: z.string(), displayName: z.string(), responsibilitySummary: z.string(),
    status: z.enum(["active", "paused", "disabled"]), organizationRole: z.enum(["primary", "ordinary"]),
    settingsRevision: z.number().int().nonnegative(), workspacePath: z.string(), effectiveWorkspacePath: z.string(), expertId: z.string(),
    modelId: z.string(), skillIds: z.array(z.string()), mcpIds: z.array(z.string()), connectorIds: z.array(z.string()) })),
  catalogue: z.object({ models: z.array(choiceSchema), experts: z.array(choiceSchema), skills: z.array(choiceSchema),
    mcps: z.array(choiceSchema), connectors: z.array(choiceSchema) }),
  totalBots: z.number().int().nonnegative().optional(), nextBotId: z.string().nullable().optional(),
  limitations: z.array(z.string()), searchedAt: z.number().int().nonnegative(),
});
const originSchema = z.object({ user_id: z.string(), bot_id: z.string(), request_id: z.string(), payload_hash: z.string(),
  conversation_id: z.string(), user_message_id: z.string(), assistant_message_id: z.string(),
  selected_work_id: z.string().nullable(), reference_message_id: z.string().nullable() });
const rowSchema = z.object({ organization_id: z.string(), request_hash: z.string(), request_json: z.string(),
  origin_json: z.string(), create_request_json: z.string().nullable(), expected_revision: z.number().nullable(),
  applied_revision: z.number().nullable(), value_json: z.string() });
const hash = (...values: unknown[]) => createHash("sha256").update(JSON.stringify(values)).digest("hex");
const uuid = (identity: string): string => {
  const value = hash(identity).slice(0, 32).split(""); value[12] = "4"; value[16] = "8";
  const hex = value.join(""); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
export type BotOrganizationServiceOptions = BotConversationServiceOptions & {
  settings: BotSettingsService; creator: BotCreationService; collaborations: BotCollaborationService;
  messages: BotConversationRepository; publish: (messageId: string) => void;
};
export interface BotOrganizationResult {
  organization: BotOrganizationSummaryDto; replayed?: boolean; error?: string;
  bots?: z.infer<typeof discoverySchema>["bots"];
  catalogue?: Awaited<ReturnType<BotSettingsService["availableChoices"]>>;
  limitations?: string[]; totalBots?: number; nextBotId?: string | null; collaboration?: unknown;
}

/** Owns only pre-contact organization facts. Registry, settings, collaboration
 * and Work retain their existing identities, writers and execution recovery. */
export class BotOrganizationService {
  private readonly running = new Map<string, Promise<BotOrganizationResult>>();
  constructor(private readonly options: BotOrganizationServiceOptions) {
    options.db.exec(`CREATE TABLE IF NOT EXISTS bot_organization_records(
      organization_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,source_bot_id TEXT NOT NULL,
      admission_key TEXT NOT NULL,request_hash TEXT NOT NULL,request_json TEXT NOT NULL,
      origin_json TEXT NOT NULL,create_request_json TEXT,expected_revision INTEGER,applied_revision INTEGER,
      value_json TEXT NOT NULL CHECK(json_valid(value_json)),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
      UNIQUE(user_id,admission_key));
      CREATE INDEX IF NOT EXISTS idx_bot_organization_source ON bot_organization_records(user_id,source_bot_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS bot_organization_message_links(organization_id TEXT NOT NULL,message_id TEXT NOT NULL,
      PRIMARY KEY(organization_id,message_id));
      CREATE INDEX IF NOT EXISTS idx_bot_organization_message ON bot_organization_message_links(message_id);
      CREATE TABLE IF NOT EXISTS bot_organization_operations(user_id TEXT NOT NULL,operation_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,organization_id TEXT NOT NULL,PRIMARY KEY(user_id,operation_id));
      CREATE TABLE IF NOT EXISTS bot_organization_receipts(organization_id TEXT NOT NULL,receipt_key TEXT NOT NULL,
      value_json TEXT NOT NULL CHECK(json_valid(value_json)),PRIMARY KEY(organization_id,receipt_key));
      CREATE TABLE IF NOT EXISTS bot_organization_discovery_results(organization_id TEXT PRIMARY KEY,
      value_json TEXT NOT NULL CHECK(json_valid(value_json)));`);
  }

  eligible(parentMessageId: string): boolean {
    try { this.source(parentMessageId); return true; } catch { return false; }
  }

  async command(parentMessageId: string, operationId: string, input: unknown): Promise<BotOrganizationResult | { items: BotOrganizationSummaryDto[]; primaryBotId: string }> {
    const source = this.source(parentMessageId), command = botOrganizationCommandSchema.parse(input);
    const operation = `organization-op:${hash(parentMessageId, operationId)}`;
    if (command.action === "query" && !command.intentId) return { items: this.list(source.bot_id), primaryBotId: source.bot_id };
    if (command.action === "discover") return this.discover(source, parentMessageId, operation, command);
    if (command.action === "query" || command.action === "resume") {
      if (!command.intentId) throw new Error("缺少组织意图");
      const record = this.intent(command.intentId, source.bot_id);
      this.link(record.view.organizationId, parentMessageId);
      if (command.action === "query") return { organization: record.view,
        collaboration: this.options.collaborations.organizationCollaboration(record.view.intentId) };
      return this.run(record.view.intentId, parentMessageId, true);
    }
    const inputMessage = this.options.messages.message(source.user_message_id);
    if (!inputMessage || inputMessage.role !== "user") throw new Error("没有可核验的原用户要求");
    if (command.target.kind === "create") {
      const discoveries = this.list(source.bot_id, parentMessageId);
      if (!discoveries.some(item => item.kind === "discovery" && item.status === "succeeded"))
        throw new Error("创建执行者前必须先 discover，查询现有 Bot 和实际可用能力");
    }
    const { whyExistingBotsDoNotFit: _reason, ...creationIdentity } = command.target.kind === "create"
      ? command.target : { ...command.target, whyExistingBotsDoNotFit: undefined };
    const attachments = (inputMessage.attachments ?? []).map(attachment => ({ name: attachment.name,
      sha256: createHash("sha256").update(readFileSync(attachment.path)).digest("hex") }));
    const identity = hash(source.bot_id, source.conversation_id, inputMessage.text, attachments,
      { ...command, target: creationIdentity });
    const intentId = `bot-organization-${identity}`, requestHash = hash(command);
    this.options.db.transaction(() => {
      this.source(parentMessageId);
      const old = z.object({ request_hash: z.string(), organization_id: z.string() }).optional().parse(this.options.db.prepare(
        "SELECT request_hash,organization_id FROM bot_organization_operations WHERE user_id=? AND operation_id=?")
        .get(this.options.userId, operation));
      if (old && (old.request_hash !== requestHash || old.organization_id !== intentId)) throw new Error("idempotency_conflict: 同一组织操作不能更换计划");
      const present = this.row(intentId);
      if (!present) {
        const target = command.target.kind === "existing" ? this.target(command.target.botId, source.bot_id) : undefined;
        const now = Date.now(), discovery = this.list(source.bot_id, parentMessageId).find(item => item.kind === "discovery" && item.status === "succeeded");
        const base = this.base(intentId, source, now);
        const view = botOrganizationSummarySchema.parse({ ...base, kind: "intent", intentId,
          phase: target ? "configuring" : "creating", target: target ? { botId: target.botId, displayName: target.displayName } : null,
          collaborationId: null, times: { searchedAt: discovery?.kind === "discovery" ? discovery.searchedAt : null,
            botCreatedAt: null, configuredAt: null, contactStartedAt: null, linkedAt: null },
          summary: target ? "已选用现有 Bot，正在核对配置" : "已记录创建意图，尚未创建或接单" });
        const createRequest = command.target.kind === "create" ? botCreateSchema.parse({ requestId: uuid(intentId), displayName: command.target.displayName,
          responsibilitySummary: command.target.responsibilitySummary }) : undefined;
        const expectedRevision = command.target.kind === "existing" ? command.target.configuration?.expectedRevision ?? this.options.settings.get(command.target.botId).revision : null;
        this.options.db.prepare("INSERT INTO bot_organization_records VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(intentId, this.options.userId, source.bot_id, identity, requestHash, JSON.stringify(command), JSON.stringify(source),
            createRequest ? JSON.stringify(createRequest) : null, expectedRevision, null, JSON.stringify(view), now, now);
      }
      this.options.db.prepare("INSERT OR IGNORE INTO bot_organization_operations VALUES(?,?,?,?)")
        .run(this.options.userId, operation, requestHash, intentId);
      this.link(intentId, parentMessageId);
    }).immediate();
    this.publish(intentId);
    return this.run(intentId, parentMessageId);
  }

  context(parentMessageId: string): string {
    if (!this.eligible(parentMessageId)) return "";
    const parent = this.options.messages.message(parentMessageId);
    if (!parent) return "";
    const items = this.list(parent.botId).filter(item => item.kind === "intent");
    return `你是宿主持久标记的主 Bot。先 bot_organize(discover) 核对职责、能力和状态，优先复用合适的现有 Bot；返回 nextBotId 表示目录尚未读完，用 afterBotId 继续查询，不能把第一页没有匹配当作不存在；用户点名的对象必须尊重，缺少合适执行者才 arrange(create)。创建或配置不表示接单。已有 intentId 用 query/resume，已接入的 collaborationId 用 bot_collaborate，不重复建 Bot 或 Work。不能读取或搬走其他 Bot 的私人记忆、私人 Skill，不自动登录或获取新权限。\n已有真实组织记录：${JSON.stringify(items.slice(0, 12))}`;
  }

  /** Reconcile committed local facts only. Recovery never invents a fresh user
   * turn and never calls create/save/submit on an unfinished intention. */
  recover(): void {
    if (!this.options.isAuthority()) return;
    const rows = this.options.db.prepare("SELECT organization_id,source_bot_id FROM bot_organization_records WHERE user_id=?")
      .all(this.options.userId).map(row => z.object({ organization_id: z.string(), source_bot_id: z.string() }).parse(row));
    for (const row of rows) {
      if (!this.options.bots.isPrimaryBot(this.options.userId, row.source_bot_id)) continue;
      const saved = this.row(row.organization_id);
      if (!saved) continue;
      if (saved.view.kind === "discovery") {
        if (saved.view.status === "running") {
          this.update(row.organization_id, view => ({ ...view, status: "unknown", summary: "宿主曾中断，查找结果未确认，可重新查询", updatedAt: Date.now() }));
          this.receipt(row.organization_id, "discovery", "unknown", "中断前的目录读取没有完成回执", "discovery:interrupted");
        }
        continue;
      }
      const record = this.intent(row.organization_id, row.source_bot_id);
      const create = record.row.create_request_json ? this.options.creator.readCreation(JSON.parse(record.row.create_request_json)) : undefined;
      if (create?.ok && record.view.target === null) this.created(record.view.intentId, create.bot);
      const current = this.intent(row.organization_id, row.source_bot_id);
      const applied = this.options.settings.readConfigurationOperation(this.configurationKey(row.organization_id));
      if (applied && current.view.target && ["configuring", "configuration_failed"].includes(current.view.phase))
        this.configured(row.organization_id, applied.settings.revision, applied.appliedAt);
      const linked = this.options.collaborations.organizationCollaboration(row.organization_id);
      const plan = z.object({ contact: contactSchema }).parse(JSON.parse(record.row.request_json));
      if (linked && (linked.workId || plan.contact.kind === "ask" && linked.status === "returned" && linked.times.returnedAt !== null) && current.view.target)
        this.linked(row.organization_id, linked.collaborationId, plan.contact.kind === "ask" ? linked.times.returnedAt : linked.times.acceptedAt);
      else if (current.view.phase === "contacting" || linked?.status === "unknown")
        this.update(row.organization_id, view => view.kind !== "intent" || !view.target ? view : { ...view,
          phase: "contact_unknown", collaborationId: null, summary: "联系曾中断，保留实际记录；先核对结果，不自动重发", updatedAt: Date.now() });
      this.publish(row.organization_id);
    }
  }

  private source(parentMessageId: string): BotMessageReceipt {
    if (!this.options.isAuthority()) throw new Error("当前宿主没有 Bot 组织权");
    const parent = this.options.messages.message(parentMessageId);
    if (!parent || parent.role !== "assistant" || parent.teamId || !["queued", "running", "unknown"].includes(parent.status)
      || isSharedBotConversation(this.options.db, parent.conversationId)) throw new Error("组织操作需要当前有效的私人前台请求");
    const receipt = this.options.messages.receipt(this.options.userId, parent.botId, parent.requestId), bot = this.options.bots.getBot(parent.botId);
    if (!receipt || receipt.assistant_message_id !== parentMessageId || receipt.conversation_id !== parent.conversationId
      || !bot || bot.userId !== this.options.userId || bot.status !== "active" || !this.options.bots.isPrimaryBot(this.options.userId, bot.botId))
      throw new Error("只有宿主持久指定的主 Bot 可以创建或改配其他 Bot");
    return receipt;
  }

  private target(botId: string, sourceBotId: string): BotDto {
    const bot = this.options.bots.getBot(botId);
    if (!bot || bot.userId !== this.options.userId || bot.status !== "active" || bot.botId === sourceBotId)
      throw new Error("目标必须是当前用户的另一位活动个人 Bot");
    return bot;
  }

  private base(organizationId: string, source: BotMessageReceipt, now: number) {
    return { organizationId, sourceBotId: source.bot_id, sourceDisplayName: this.options.bots.getBot(source.bot_id)?.displayName ?? source.bot_id,
      sourceConversationId: source.conversation_id, sourceRequestId: source.request_id, sourceUserMessageId: source.user_message_id,
      sourceAssistantMessageId: source.assistant_message_id, createdAt: now, updatedAt: now, summary: "", receipts: [], totalReceipts: 0 };
  }

  private row(organizationId: string) {
    const row = rowSchema.optional().parse(this.options.db.prepare("SELECT * FROM bot_organization_records WHERE user_id=? AND organization_id=?")
      .get(this.options.userId, organizationId));
    return row ? { row, view: botOrganizationSummarySchema.parse(JSON.parse(row.value_json)) } : undefined;
  }
  private intent(intentId: string, sourceBotId: string) {
    const record = this.row(intentId);
    if (!record || record.view.sourceBotId !== sourceBotId || record.view.kind !== "intent") throw new Error("组织意图不属于当前主 Bot");
    return { row: record.row, view: record.view };
  }
  private list(sourceBotId: string, messageId?: string): BotOrganizationSummaryDto[] {
    const rows = this.options.db.prepare(`SELECT r.value_json FROM bot_organization_records r WHERE r.user_id=? AND r.source_bot_id=?
      ${messageId ? "AND EXISTS(SELECT 1 FROM bot_organization_message_links l WHERE l.organization_id=r.organization_id AND l.message_id=?)" : ""}
      ORDER BY r.created_at DESC,r.organization_id DESC LIMIT 30`).all(...(messageId ? [this.options.userId, sourceBotId, messageId] : [this.options.userId, sourceBotId]));
    return rows.map(row => botOrganizationSummarySchema.parse(JSON.parse(z.object({ value_json: z.string() }).parse(row).value_json)));
  }
  private link(organizationId: string, messageId: string): void {
    this.options.db.prepare("INSERT OR IGNORE INTO bot_organization_message_links VALUES(?,?)").run(organizationId, messageId);
  }
  private publish(organizationId: string): void {
    const rows = this.options.db.prepare("SELECT message_id FROM bot_organization_message_links WHERE organization_id=? ORDER BY rowid DESC LIMIT 20")
      .all(organizationId).map(row => z.object({ message_id: z.string() }).parse(row).message_id);
    for (const messageId of rows) this.options.publish(messageId);
  }
  private update(organizationId: string, change: (view: BotOrganizationSummaryDto) => unknown): BotOrganizationSummaryDto {
    return this.options.db.transaction(() => {
      const record = this.row(organizationId);
      if (!record) throw new Error("组织记录不存在");
      const next = botOrganizationSummarySchema.parse(change(record.view));
      this.options.db.prepare("UPDATE bot_organization_records SET value_json=?,updated_at=? WHERE user_id=? AND organization_id=?")
        .run(JSON.stringify(next), next.updatedAt, this.options.userId, organizationId);
      this.options.db.prepare(`UPDATE bot_message_revisions SET revision=revision+1 WHERE message_id IN(
        SELECT message_id FROM bot_organization_message_links WHERE organization_id=?)`).run(organizationId);
      this.options.db.prepare(`UPDATE bot_conversations SET revision=revision+1 WHERE conversation_id IN(
        SELECT m.conversation_id FROM bot_messages m JOIN bot_organization_message_links l ON l.message_id=m.message_id WHERE l.organization_id=?)`).run(organizationId);
      return next;
    }).immediate();
  }
  private receipt(organizationId: string, step: Receipt["step"], status: Receipt["status"], summary: string, identity: string, at = Date.now()): void {
    this.options.db.transaction(() => {
      const receiptId = `org-receipt-${hash(organizationId, identity)}`;
      const inserted = this.options.db.prepare("INSERT OR IGNORE INTO bot_organization_receipts VALUES(?,?,?)")
        .run(organizationId, identity, JSON.stringify({ receiptId, step, status, createdAt: at, summary }));
      if (!inserted.changes) return;
      const schema = z.array(botOrganizationReceiptSchema);
      const receipts = schema.parse(this.options.db.prepare("SELECT value_json FROM bot_organization_receipts WHERE organization_id=? ORDER BY rowid DESC LIMIT 40")
        .all(organizationId).map(row => JSON.parse(z.object({ value_json: z.string() }).parse(row).value_json)).reverse());
      const total = z.object({ total: z.number() }).parse(this.options.db.prepare("SELECT COUNT(*) total FROM bot_organization_receipts WHERE organization_id=?").get(organizationId)).total;
      this.update(organizationId, view => ({ ...view, updatedAt: Math.max(view.updatedAt, at), totalReceipts: total, receipts }));
    }).immediate();
    this.publish(organizationId);
  }
  private configurationKey(intentId: string): string { return `organization-settings:${hash(intentId)}`; }
  private created(intentId: string, bot: BotDto): void {
    this.update(intentId, view => view.kind !== "intent" || view.target !== null ? view : { ...view, phase: "configuring",
      target: { botId: bot.botId, displayName: bot.displayName }, collaborationId: null, summary: "已创建，尚未接单",
      times: { ...view.times, botCreatedAt: bot.createdAt }, updatedAt: Math.max(view.updatedAt, bot.createdAt) });
    this.receipt(intentId, "creation", "succeeded", `已实际创建 ${bot.displayName}（${bot.botId}）`, "creation:committed", bot.createdAt);
  }
  private configured(intentId: string, revision: number, at: number | null): void {
    this.options.db.prepare("UPDATE bot_organization_records SET applied_revision=? WHERE user_id=? AND organization_id=?")
      .run(revision, this.options.userId, intentId);
    this.update(intentId, view => view.kind !== "intent" || !view.target || view.phase === "linked" ? view : { ...view, phase: "ready",
      summary: at === null ? "已核对现有配置，尚未接单" : "配置已保存，尚未接单", collaborationId: null,
      times: { ...view.times, configuredAt: at }, updatedAt: Math.max(view.updatedAt, at ?? view.updatedAt) });
    this.receipt(intentId, "configuration", "succeeded", at === null ? "保留现有设置，未执行配置修改" : `配置版本 ${revision} 已真实保存`,
      "configuration:committed", at ?? Date.now());
  }
  private linked(intentId: string, collaborationId: string, at: number | null): void {
    this.update(intentId, view => view.kind !== "intent" || !view.target ? view : { ...view, phase: "linked", collaborationId,
      summary: "已接入原个人协作，执行和成果以事项记录为准", times: { ...view.times, linkedAt: view.times.linkedAt ?? at },
      updatedAt: Math.max(view.updatedAt, at ?? view.updatedAt) });
    this.receipt(intentId, "contact", "succeeded", `已关联真实协作 ${collaborationId}，创建不代表事项已完成`, "contact:committed", at ?? Date.now());
  }

  private async discover(source: BotMessageReceipt, parentMessageId: string, operation: string,
    command: Extract<z.infer<typeof botOrganizationCommandSchema>, { action: "discover" }>): Promise<BotOrganizationResult> {
    const organizationId = `bot-discovery-${hash(operation)}`, now = Date.now();
    const previous = this.row(organizationId);
    if (previous && previous.row.request_hash !== hash(command)) throw new Error("idempotency_conflict: 查询参数已改变");
    const cached = this.discovery(organizationId);
    if (cached && previous) return { organization: previous.view, ...cached, replayed: true };
    if (!previous) this.options.db.prepare("INSERT OR IGNORE INTO bot_organization_records VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(organizationId, this.options.userId, source.bot_id, organizationId, hash(command), JSON.stringify(command), JSON.stringify(source),
        null, null, null, JSON.stringify(botOrganizationSummarySchema.parse({ ...this.base(organizationId, source, now), kind: "discovery",
          status: "running", matchedBotCount: null, searchedAt: null, summary: "正在读取现有 Bot 与能力目录" })), now, now);
    this.link(organizationId, parentMessageId);
    this.receipt(organizationId, "discovery", "started", "已开始实际查找现有 Bot 和可用配置", "discovery:start");
    try {
      const catalogue = await this.options.settings.availableChoices();
      this.source(parentMessageId);
      const allBots = this.options.bots.listBots(this.options.userId).filter(bot => bot.botId !== source.bot_id)
        .sort((a, b) => a.botId < b.botId ? -1 : a.botId > b.botId ? 1 : 0);
      const remaining = command.afterBotId ? allBots.filter(bot => bot.botId > command.afterBotId!) : allBots;
      const page = remaining.slice(0, 100);
      const nextBotId = remaining.length > page.length ? page.at(-1)!.botId : null;
      const bots = page.map(bot => {
        const settings = this.options.settings.get(bot.botId);
        return { botId: bot.botId, displayName: bot.displayName, responsibilitySummary: bot.responsibilitySummary, status: bot.status,
          organizationRole: this.options.bots.isPrimaryBot(this.options.userId, bot.botId) ? "primary" as const : "ordinary" as const,
          settingsRevision: settings.revision, workspacePath: settings.workspacePath, effectiveWorkspacePath: settings.effectiveWorkspacePath,
          expertId: settings.expertId,
          modelId: settings.modelId, skillIds: [...new Set([...settings.skillIds, ...bot.expertProfile.allowedSkillIds])],
          mcpIds: [...new Set([...settings.mcpIds, ...bot.expertProfile.allowedMcpIds])],
          connectorIds: [...new Set([...settings.connectorIds, ...bot.expertProfile.allowedConnectorIds])] };
      });
      const result = discoverySchema.parse({ bots, catalogue, totalBots: allBots.length, nextBotId, searchedAt: Date.now(),
        limitations: [...(nextBotId ? ["Bot 目录尚未读取完整；请以 nextBotId 作为 afterBotId 继续 discover，不能据此断言没有合适的现有 Bot。"] : []), "MCP 已配置或启用不代表已成功连接。", "连接器安装和启用不代表已登录或可访问远端服务；没有验证的状态不得声称已连接。", "目录只提供身份、职责和能力元数据，不提供其他 Bot 的私人记忆或 Skill 正文。"] });
      this.options.db.transaction(() => {
        this.source(parentMessageId);
        this.options.db.prepare("INSERT OR IGNORE INTO bot_organization_discovery_results VALUES(?,?)").run(organizationId, JSON.stringify(result));
        const accepted = this.discovery(organizationId);
        if (!accepted) throw new Error("查找回执未保存");
        this.update(organizationId, view => ({ ...view, status: "succeeded", matchedBotCount: accepted.bots.length, searchedAt: accepted.searchedAt,
          summary: `本页 ${accepted.bots.length} 位其他 Bot，目录共 ${accepted.totalBots ?? accepted.bots.length} 位${accepted.nextBotId ? "，还有下一页" : ""}；请按职责、能力和状态优先复用`, updatedAt: accepted.searchedAt }));
        this.receipt(organizationId, "discovery", "succeeded", `实际读取了 ${accepted.bots.length} 位 Bot 及配置目录；未创建 Bot 或 Work`, "discovery:finished", accepted.searchedAt);
      }).immediate();
      return { organization: this.row(organizationId)!.view, ...this.discovery(organizationId) };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.update(organizationId, view => ({ ...view, status: "failed", summary: `查找失败：${detail}`, updatedAt: Date.now() }));
      this.receipt(organizationId, "discovery", "failed", detail, `discovery:failed:${hash(detail)}`);
      return { organization: this.row(organizationId)!.view, error: detail };
    }
  }

  private discovery(organizationId: string) {
    const row = z.object({ value_json: z.string() }).optional().parse(this.options.db.prepare(
      "SELECT value_json FROM bot_organization_discovery_results WHERE organization_id=?").get(organizationId));
    return row ? discoverySchema.parse(JSON.parse(row.value_json)) : undefined;
  }

  private run(intentId: string, parentMessageId: string, retryFailedAsk = false): Promise<BotOrganizationResult> {
    const previous = this.running.get(intentId);
    if (previous) return previous.then(() => this.perform(intentId, parentMessageId, retryFailedAsk));
    const task = this.perform(intentId, parentMessageId, retryFailedAsk).finally(() => { if (this.running.get(intentId) === task) this.running.delete(intentId); });
    this.running.set(intentId, task);
    return task;
  }

  private async perform(intentId: string, parentMessageId: string, retryFailedAsk: boolean): Promise<BotOrganizationResult> {
    const source = this.source(parentMessageId);
    let record = this.intent(intentId, source.bot_id);
    const plan = botOrganizationCommandSchema.parse(JSON.parse(record.row.request_json));
    if (plan.action !== "arrange") throw new Error("组织计划类型不可核对");
    let stage: "creation" | "configuration" | "contact" = record.view.target ? "configuration" : "creation";
    try {
      if (record.view.phase === "linked") return { organization: record.view, replayed: true };
      if (!record.view.target) {
        if (!record.row.create_request_json || plan.target.kind !== "create") throw new Error("缺少原始创建回执参数");
        const createRequest = botCreateSchema.parse(JSON.parse(record.row.create_request_json));
        this.receipt(intentId, "creation", "started", "正在按同一持久请求创建执行者", "creation:start");
        this.source(parentMessageId);
        const created = this.options.creator.createBot(createRequest);
        if (!created.ok) throw new Error(`${created.code}: ${created.message}`);
        this.created(intentId, created.bot);
      }
      record = this.intent(intentId, source.bot_id);
      if (!record.view.target) throw new Error("执行者身份尚未确认");
      const bot = this.target(record.view.target.botId, source.bot_id);
      stage = "configuration";
      if (["configuring", "configuration_failed"].includes(record.view.phase)) {
        const changes = plan.target.kind === "create" ? plan.target.configuration ?? {} : plan.target.configuration?.changes ?? {};
        if (Object.keys(changes).length) {
          this.receipt(intentId, "configuration", "started", "正在核对能力并保存明确选择的配置", "configuration:start");
          const expected = record.row.expected_revision ?? this.options.settings.get(bot.botId).revision;
          if (record.row.expected_revision === null) this.options.db.prepare("UPDATE bot_organization_records SET expected_revision=? WHERE user_id=? AND organization_id=? AND expected_revision IS NULL")
            .run(expected, this.options.userId, intentId);
          const fixedExpected = this.intent(intentId, source.bot_id).row.expected_revision;
          if (fixedExpected === null) throw new Error("配置版本未确认");
          const saved = await this.options.settings.configureOperation({ operationId: this.configurationKey(intentId), botId: bot.botId,
            expectedRevision: fixedExpected, changes }, () => { this.source(parentMessageId); });
          this.configured(intentId, saved.settings.revision, saved.appliedAt);
        } else this.configured(intentId, this.options.settings.get(bot.botId).revision, null);
      }
      record = this.intent(intentId, source.bot_id);
      if (plan.contact.kind === "none") return { organization: record.view };
      stage = "contact";
      this.source(parentMessageId);
      if (!this.options.messages.conversation(this.options.userId, source.bot_id, record.view.sourceConversationId))
        throw new Error("原来源会话已删除，保留已创建 Bot，不改投或新建执行");
      const approvedRevision = record.row.applied_revision;
      const configurationGuard = () => {
        this.source(parentMessageId);
        if (approvedRevision === null || this.options.settings.get(bot.botId).revision !== approvedRevision)
          throw new Error("目标配置已被其他位置修改，保留修改；请查询当前设置后明确选择，不回写旧配置");
      };
      configurationGuard();
      this.update(intentId, view => view.kind !== "intent" || !view.target ? view : { ...view, phase: "contacting", collaborationId: null,
        summary: "正在联系目标，接单与返回以真实回执为准",
        times: { ...view.times, contactStartedAt: view.times.contactStartedAt ?? Date.now() }, updatedAt: Date.now() });
      this.receipt(intentId, "contact", "started", plan.contact.kind === "ask" ? "正在真实联系目标 Bot" : "正在由目标 Bot 受理原委派", "contact:start");
      const collaboration = await this.options.collaborations.acceptOrganization({ intentId, currentParentMessageId: parentMessageId,
        origin: originSchema.parse(JSON.parse(record.row.origin_json)), targetBotId: bot.botId, contact: plan.contact,
        configurationGuard, retryFailedAsk });
      const linked = this.options.collaborations.organizationCollaboration(intentId);
      if (!linked || (plan.contact.kind === "delegate" && !linked.workId)) throw new Error("委派未受理，已创建 Bot 与原计划保留，可继续");
      if (plan.contact.kind === "ask" && (linked.status !== "returned" || linked.times.returnedAt === null))
        throw new Error(`咨询尚未成功返回（${linked.status}），保留原协作；已知失败可 resume，结果未知时先查询，不自动重发`);
      this.linked(intentId, linked.collaborationId, plan.contact.kind === "ask" ? linked.times.returnedAt : linked.times.acceptedAt);
      return { organization: this.intent(intentId, source.bot_id).view, collaboration };
    } catch (error) {
      const detail = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
      const contact = stage === "contact" ? this.options.collaborations.organizationCollaboration(intentId) : undefined;
      const uncertain = Boolean(plan.contact.kind === "ask" && contact && !contact.workId && contact.messageCount > 0
        && ["sent", "delivered", "accepted", "started", "ended", "returning", "unknown"].includes(contact.status));
      this.update(intentId, view => {
        if (view.kind !== "intent" || view.phase === "linked") return view;
        const phase = !view.target ? "creation_failed" : stage === "configuration" ? "configuration_failed" : uncertain ? "contact_unknown" : "contact_failed";
        return { ...view, phase, collaborationId: null, summary: `${stage === "creation" ? "创建" : stage === "configuration" ? "配置" : "联系或接单"}${uncertain ? "待核对" : "失败"}：${detail}`, updatedAt: Date.now() };
      });
      this.receipt(intentId, stage, uncertain ? "unknown" : "failed", detail, `${stage}:${uncertain ? "unknown" : "failed"}:${hash(detail)}`);
      return { organization: this.intent(intentId, source.bot_id).view, error: detail };
    }
  }
}
