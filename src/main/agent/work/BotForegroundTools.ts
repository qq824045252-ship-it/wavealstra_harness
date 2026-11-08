import type Database from "better-sqlite3";
import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { z } from "zod";
import type { WorkActor, WorkControlResult, WorkDto } from "../../../shared/bot-work";
import { DESKTOP_USER_GRANTS, WorkService } from "./WorkService";
import type { BotRegistry } from "./BotRegistry";
import type { BotConversationRepository } from "./BotConversationRepository";
import { botForegroundRequest } from "./BotForegroundIdentity";

// Validate the wire text before trimming so its length and non-blank rules can be
// represented exactly in the model-visible JSON Schema as well as at execution.
const text = z.string().min(1).max(32000).regex(/\S/, "文本不能仅包含空白").trim();
const criterion = z.object({ text, requiresRealEnvironmentCheck: z.boolean().optional(), requiredEnvironment: text.optional() }).strict();
const fields = { title: text.optional(), goalDescription: text.optional(), constraints: z.array(text).max(30).optional(),
  criteria: z.array(criterion).max(12).optional() };
const guard = z.object({ expectedStateVersion: z.number().int().positive(), expectedIntentRevision: z.number().int().positive(),
  expectedOwnerEpoch: z.number().int().positive() }).strict();
const query = z.object({ workId: text.optional() }).strict();
const create = z.object({ ...fields, title: text }).strict();
const change = z.object({ ...fields, workId: text, versionGuard: guard }).strict();
const control = z.object({ workId: text, reason: text.optional(), versionGuard: guard }).strict();
const memory = z.object({ query: text }).strict();
// One source for Function Calling and runtime validation: nested strictness,
// array bounds and all three positive version guards must not drift apart.
const parameters = <Schema extends z.ZodType>(schema: Schema) =>
  Type.Unsafe<z.input<Schema>>(z.toJSONSchema(schema, { target: "draft-7", io: "input" }));
const inputParameters = { query: parameters(query), create: parameters(create), change: parameters(change),
  control: parameters(control), memory: parameters(memory) };

export interface BotForegroundToolOptions {
  db: Database.Database;
  userId: string;
  botId: string;
  conversationId: string;
  bots: BotRegistry;
  messages: BotConversationRepository;
  works: WorkService;
  schedule: (work: WorkDto, operationId: string, retryBlocked?: boolean) => void;
  wake: (workId?: string) => void;
  memorySearch: (query: string) => unknown;
  isAuthority: () => boolean;
}

/** This list is the entire foreground capability surface, including recovered tools. */
export const BOT_FOREGROUND_TOOLS = new Set(["work_query_status", "work_create", "work_amend", "work_pause", "work_resume", "work_cancel", "memory_search"]);

export function botForegroundTools(options: BotForegroundToolOptions) {
  const { db, works, bots, messages, userId, botId, conversationId } = options;
  const receipt = (requestId: string) => {
    const value = messages.receipt(userId, botId, requestId);
    if (!value) throw new Error("前台调用缺少持久用户输入身份");
    const message = messages.message(value.assistant_message_id);
    if (value.conversation_id !== conversationId || !message || message.role !== "assistant"
      || message.conversationId !== conversationId || message.botId !== botId || message.requestId !== requestId
      || !["queued", "running", "unknown"].includes(message.status)) throw new Error("原始用户消息已结束或不属于当前对话");
    return value;
  };
  const available = () => works.listWorks(userId, { includeClosed: true }).filter(work => work.ownerBotId === botId);
  const select = (workId: string, source: ReturnType<typeof receipt>) => {
    const reference = source.reference_message_id ? messages.message(source.reference_message_id)?.workIds ?? [] : [];
    const userMessage = messages.message(source.user_message_id);
    const known = available();
    const candidates = known.filter(work => work.lifecycle !== "closed");
    // Read the actual user input, not model arguments or the current UI selection.
    // Include unknown/foreign IDs so they cannot fall back to an unrelated card.
    const explicit = [...new Set(userMessage?.text.match(/(?<![A-Za-z0-9_-])work-[A-Za-z0-9_-]+(?![A-Za-z0-9_-])/g) ?? [])];
    const linked = userMessage?.workIds ?? [];
    const allowed = explicit.length ? explicit.length === 1 ? explicit : []
      : reference.length ? reference.length === 1 ? reference : []
      : source.selected_work_id ? [source.selected_work_id]
      : candidates.length === 1 ? [candidates[0]!.workId] : [];
    // Links support follow-up calls/replay for Work created in this request, but
    // cannot override an explicit target or rescue ambiguous explicit IDs.
    if (!allowed.includes(workId) && !(explicit.length === 0 && linked.includes(workId))) throw new Error("请明确要控制的 Work 卡片或 workId；多个事项不能按模糊消息全局控制");
    const target = known.find(work => work.workId === workId);
    if (!target) throw new Error("Work 不属于当前用户与 Bot");
    return target;
  };
  const assertActive = () => {
    const bot = bots.getBot(botId);
    if (!options.isAuthority() || !bot || bot.userId !== userId || bot.status !== "active") throw new Error("当前宿主或 Bot 不可受理新动作");
    return bot;
  };
  const actor = (): WorkActor => ({ kind: "bot", userId, botId, host: "foreground", grants: DESKTOP_USER_GRANTS });
  const output = (value: unknown) => ({ output: [{ type: "text" as const, text: JSON.stringify(value) }] });
  const mutations = (["work_create", "work_amend", "work_pause", "work_resume", "work_cancel"] as const).map(name => defineTool({
    name, description: `${name}: 仅对用户明确委托或选中的事项操作。先查询并原样携带读取时三元 versionGuard；冲突须重新判断。不能扩大授权、续权或代替验收。`,
    parameters: name === "work_create" ? inputParameters.create
      : name === "work_amend" ? inputParameters.change : inputParameters.control,
    replay: "safe",
    execute: async (args, api, context) => {
      const requestId = await botForegroundRequest(api, api.callId, context);
      const result = works.transaction(() => {
        const bot = assertActive();
        if (["work_create", "work_amend", "work_resume"].includes(name)
          && bot.authorization.expiresAt !== undefined && bot.authorization.expiresAt <= Date.now()) throw new Error("Bot 授权已过期，需由用户明确续权");
        const source = receipt(requestId);
        const operationId = `bot:${conversationId}:tool:${api.taskId}`;
        let result: WorkControlResult;
        if (name === "work_create") {
          const input = create.parse(args);
          result = works.createWork(actor(), { ...input, operationId, ownerBotId: botId,
            conversationId, sourceMessageId: source.user_message_id, inputSnapshotId: `input:${source.user_message_id}`,
            authorization: bot.authorization });
        } else {
          const input = name === "work_amend" ? change.parse(args) : control.parse(args);
          select(input.workId, source);
          const read = db.prepare(`SELECT guard_json FROM bot_work_reads WHERE conversation_id=? AND request_id=? AND work_id=?`)
            .get(conversationId, source.request_id, input.workId);
          const readGuard = z.object({ guard_json: z.string() }).safeParse(read);
          if (!readGuard.success || readGuard.data.guard_json !== JSON.stringify(input.versionGuard)) throw new Error("必须先查询 Work，并使用本回合读取的完整版本守卫");
          if (name === "work_amend") result = works.amendWork(actor(), { ...change.parse(args), operationId,
            inputSnapshotId: `input:${source.user_message_id}`, sourceMessageId: source.user_message_id });
          else if (name === "work_pause") result = works.pauseWork(actor(), { ...input, operationId });
          else if (name === "work_resume") result = works.resumeWork(actor(), { ...input, operationId });
          else result = works.cancelWork(actor(), { ...input, operationId });
        }
        if (result.ok) {
          messages.linkWork(source, result.work.workId);
          works.repo.linkConversation(result.work.workId, conversationId, "desktop", Date.now());
          if (["work_create", "work_amend", "work_resume"].includes(name)) options.schedule(result.work, operationId, name === "work_resume");
        }
        return result;
      });
      options.wake(result.ok ? result.work.workId : undefined);
      return output(result);
    },
  }));
  return [defineTool({ name: "work_query_status", description: "读取当前 Bot 的已知 Work、成果、预算及版本守卫。不会启动业务工具。",
    parameters: inputParameters.query, replay: "safe",
    execute: async (args, api, context) => {
      const requestId = await botForegroundRequest(api, api.callId, context);
      return output(works.transaction(() => {
      assertActive();
      const source = receipt(requestId);
      const input = query.parse(args);
      return available().filter(work => !input.workId || work.workId === input.workId).map(work => {
        const versionGuard = { expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch };
        db.prepare(`INSERT INTO bot_work_reads(conversation_id,request_id,work_id,guard_json) VALUES (?,?,?,?)
          ON CONFLICT(conversation_id,request_id,work_id) DO UPDATE SET guard_json=excluded.guard_json`)
          .run(conversationId, source.request_id, work.workId, JSON.stringify(versionGuard));
        const projection = works.getProjection(work.workId);
        const visibleMessages = works.collaboration.list(actor(), work.workId);
        return { ...projection, phase3: projection?.phase3 ? { ...projection.phase3,
          collaborationMessages: visibleMessages, handoffs: visibleMessages.filter(message => message.kind === "handoff") } : undefined,
          budget: work.budget, versionGuard };
      });
    })); } }), ...mutations,
  defineTool({ name: "memory_search", description: "查询当前 Bot 私有记忆，不访问其他 Bot 或项目。",
    parameters: inputParameters.memory, replay: "safe",
    execute: async args => { assertActive(); return output(options.memorySearch(memory.parse(args).query)); } })];
}
