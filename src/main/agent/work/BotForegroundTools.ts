import type Database from "better-sqlite3";
import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { z } from "zod";
import type { WorkActor, WorkControlResult, WorkDto } from "../../../shared/bot-work";
import { DESKTOP_USER_GRANTS, WorkService } from "./WorkService";
import type { BotRegistry } from "./BotRegistry";
import type { BotConversationRepository } from "./BotConversationRepository";
import { botForegroundRequest } from "./BotForegroundIdentity";
import { BotWorkQuery, botWorkQuerySchema } from "./BotWorkQuery";

// Validate the wire text before trimming so its length and non-blank rules can be
// represented exactly in the model-visible JSON Schema as well as at execution.
const text = z.string().min(1).max(32000).regex(/\S/, "文本不能仅包含空白").trim();
const criterion = z.object({ text, requiresRealEnvironmentCheck: z.boolean().optional(), requiredEnvironment: text.optional() }).strict();
const fields = { title: text.optional(), goalDescription: text.optional(), constraints: z.array(text).max(30).optional(),
  criteria: z.array(criterion).max(12).optional() };
const guard = z.object({ expectedStateVersion: z.number().int().positive(), expectedIntentRevision: z.number().int().positive(),
  expectedOwnerEpoch: z.number().int().positive() }).strict();
const query = botWorkQuerySchema;
const watchRule = z.object({
  cronExpression: z.string().min(1).max(200).regex(/^\S+(?:\s+\S+){4}$/, "请使用五字段分钟级 Cron 时间表").optional().describe("五字段分钟级 Cron 时间表，按用户指定频率；不支持秒级轮询，不擅自提高检查频率"),
  timezone: z.string().min(1).max(100).optional().describe("IANA 时区，如 Asia/Shanghai；未指定时使用当前宿主时区"),
  nextWakeAt: z.number().int().nonnegative().optional().describe("一次性跟进或首次检查的 Unix 毫秒时间戳"),
  catchUpPolicy: z.enum(["latest", "each", "skip"]).optional().describe("离线后补最新一次、逐次补查或跳过；默认 latest"),
  stopConditionText: z.string().min(1).max(1000).optional().describe("保留用户给出的停止条件；检查后汇报是否满足，不自行宣称已完成"),
}).strict();
const timing = { mode: z.enum(["once", "watch"]).optional(), watchRule: watchRule.optional(),
  deadlineAt: z.number().int().nonnegative().optional().describe("承诺期限 Unix 毫秒时间戳，到期只读跟进，不等同于自动取消") };
const create = z.object({ ...fields, ...timing, title: text,
  startImmediately: z.boolean().optional().describe("持续跟踪默认等到首次检查；仅用户要求现在也检查时设 true") }).strict();
const change = z.object({ ...fields, ...timing, watchRule: watchRule.nullable().optional(),
  deadlineAt: timing.deadlineAt.nullable().optional(), workId: text, versionGuard: guard }).strict();
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

/** Foreground Work/memory controls. Read-only web tools are mounted separately by the host. */
export const BOT_FOREGROUND_TOOLS = new Set(["work_query_status", "work_create", "work_amend", "work_pause", "work_resume", "work_cancel", "memory_search"]);

export function botForegroundTools(options: BotForegroundToolOptions) {
  const { db, works, bots, messages, userId, botId, conversationId } = options;
  const receipt = (requestId: string) => {
    const value = messages.receipt(userId, botId, requestId);
    if (!value) throw new Error("前台调用缺少持久用户输入身份");
    const message = messages.message(value.assistant_message_id);
    const userMessage = messages.message(value.user_message_id);
    if (value.conversation_id !== conversationId || !message || message.role !== "assistant"
      || message.conversationId !== conversationId || message.botId !== botId || message.requestId !== requestId
      || !userMessage || userMessage.role !== "user" || userMessage.conversationId !== conversationId
      || userMessage.botId !== botId || userMessage.requestId !== requestId
      || !["queued", "running", "unknown"].includes(message.status)) throw new Error("原始用户消息已结束或不属于当前对话");
    return value;
  };
  const catalogue = new BotWorkQuery(db, userId, botId);
  const select = (workId: string, source: ReturnType<typeof receipt>) => {
    const reference = source.reference_message_id ? messages.message(source.reference_message_id)?.workIds ?? [] : [];
    const userMessage = messages.message(source.user_message_id);
    // Read the actual user input, not model arguments or the current UI selection.
    // Include unknown/foreign IDs so they cannot fall back to an unrelated card.
    const explicit = [...new Set(userMessage?.text.match(/(?<![A-Za-z0-9_-])work-[A-Za-z0-9_-]+(?![A-Za-z0-9_-])/g) ?? [])];
    const linked = userMessage?.workIds ?? [];
    const soleOpen = explicit.length || reference.length || source.selected_work_id ? undefined : catalogue.soleOpenWorkId();
    const allowed = explicit.length ? explicit.length === 1 ? explicit : []
      : reference.length ? reference.length === 1 ? reference : []
      : source.selected_work_id ? [source.selected_work_id]
      : soleOpen ? [soleOpen] : [];
    // Links support follow-up calls/replay for Work created in this request, but
    // cannot override an explicit target or rescue ambiguous explicit IDs.
    if (!allowed.includes(workId) && !(explicit.length === 0 && linked.includes(workId))) throw new Error("请明确要控制的 Work 卡片或 workId；多个事项不能按模糊消息全局控制");
    const target = catalogue.canRead(workId) ? works.getWork(workId) : undefined;
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
    name, description: name === "work_create"
      ? "受理长耗时、多步骤或文件/代码/桌面操作并派发后台。goalDescription、constraints、criteria 是你的规划，宿主会独立附上用户原文；忠实传达要求，计算结果和未验证假设不得写成用户约束。日常天气、新闻等实时查询直接使用前台 web_search/fetch_content，不创建 Work。用户已经提出的执行请求无需再确认创建任务。持续跟踪使用 mode=watch 与 watchRule（cronExpression 或 nextWakeAt），不得只在文字中承诺；按用户指定频率和时区。deadlineAt 是到期跟进，不是授权到期。创建无需先查询版本；已有相同事项则查询进度，避免重复创建。返回成功才可声称已受理或已安排；未来检查不得声称正在执行。"
      : `${name}: 操作用户明确指定的已有事项，先查询并携带返回的 versionGuard；冲突重新查询。work_amend 可改 watchRule/期限，watchRule=null 停止后续跟踪而保留事项；work_pause/resume 暂停/恢复，work_cancel 取消整个事项。仅改时间表不会立即重跑原任务。批评、催促、抱怨不是暂停或取消意图；仅明确要求停止/取消时调用对应控制。`,
    parameters: name === "work_create" ? inputParameters.create
      : name === "work_amend" ? inputParameters.change : inputParameters.control,
    replay: "safe",
    execute: async (args, api, context) => {
      const requestId = await botForegroundRequest(api, api.callId, context);
      let preservedUserCriteria: Array<{ id: string; text: string }> = [];
      const result = works.transaction(() => {
        const bot = assertActive();
        if (["work_create", "work_amend", "work_resume"].includes(name)
          && bot.authorization.expiresAt !== undefined && bot.authorization.expiresAt <= Date.now()) throw new Error("Bot 授权已过期，需由用户明确续权");
        const source = receipt(requestId);
        const operationId = `bot:${conversationId}:tool:${api.taskId}`;
        let result: WorkControlResult;
        let previousSnapshotId: string | undefined;
        let shouldSchedule = false;
        let startWatchImmediately = false;
        if (name === "work_create") {
          const { startImmediately, ...input } = create.parse(args);
          const mode = input.mode ?? (input.watchRule ? "watch" : "once");
          if (mode === "watch" && !input.watchRule?.cronExpression && input.watchRule?.nextWakeAt === undefined)
            throw new Error("持续跟踪需要用户指定的检查时间或频率，不能仅保存一句承诺");
          if (input.watchRule && mode !== "watch") throw new Error("持续跟踪规则必须使用 watch 模式");
          shouldSchedule = mode !== "watch";
          startWatchImmediately = mode === "watch" && startImmediately === true;
          result = works.createWork(actor(), { ...input, mode,
            watchRule: input.watchRule ? { ...input.watchRule, subscriptions: ["cron"],
              timezone: input.watchRule.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone } : undefined,
            criteria: input.criteria?.map(item => ({ ...item, origin: "assistant_proposal" as const })), operationId, ownerBotId: botId,
            conversationId, sourceMessageId: source.user_message_id, inputSnapshotId: `input:${source.user_message_id}`,
            authorization: bot.authorization });
        } else {
          const input = name === "work_amend" ? change.parse(args) : control.parse(args);
          const target = select(input.workId, source);
          previousSnapshotId = target.inputSnapshotId;
          // Team membership grants shared facts, not control of the owner's Work.
          if (target.ownerBotId !== botId) throw new Error("团队成员只能查看和讨论此事项；请联系负责人修改、暂停或取消");
          const read = db.prepare(`SELECT guard_json FROM bot_work_reads WHERE conversation_id=? AND request_id=? AND work_id=?`)
            .get(conversationId, source.request_id, input.workId);
          const readGuard = z.object({ guard_json: z.string() }).safeParse(read);
          if (!readGuard.success || readGuard.data.guard_json !== JSON.stringify(input.versionGuard)) throw new Error("必须先查询 Work，并使用本回合读取的完整版本守卫");
          if (name === "work_amend") {
            const amended = change.parse(args);
            if (amended.watchRule && !amended.watchRule.cronExpression && amended.watchRule.nextWakeAt === undefined
              && !target.watchRule?.cronExpression && target.watchRule?.nextWakeAt === undefined)
              throw new Error("持续跟踪需要检查时间或频率，不能保存空时间表");
            const contentChanged = Object.keys(fields).some(key => amended[key as keyof typeof fields] !== undefined);
            shouldSchedule = contentChanged && (amended.mode ?? target.mode) !== "watch";
            const retained = target.criteria.filter(item => item.origin !== "assistant_proposal");
            if (amended.criteria) preservedUserCriteria = retained.map(item => ({ id: item.id, text: item.text }));
            result = works.amendWork(actor(), { ...amended, operationId,
              criteria: amended.criteria ? [...retained.map(item => ({ id: item.id, text: item.text,
                requiresRealEnvironmentCheck: item.requiresRealEnvironmentCheck, requiredEnvironment: item.requiredEnvironment })),
                ...amended.criteria.map(item => ({ ...item, origin: "assistant_proposal" as const }))] : undefined,
              watchRule: amended.watchRule ? { ...amended.watchRule, subscriptions: ["cron"],
                timezone: amended.watchRule.timezone ?? target.watchRule?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone } : amended.watchRule,
              ...(contentChanged ? { inputSnapshotId: `input:${source.user_message_id}`, sourceMessageId: source.user_message_id } : {}) });
          }
          else if (name === "work_pause") result = works.pauseWork(actor(), { ...input, operationId });
          else if (name === "work_resume") { result = works.resumeWork(actor(), { ...input, operationId }); shouldSchedule = target.mode !== "watch"; }
          else result = works.cancelWork(actor(), { ...input, operationId });
        }
        if (result.ok) {
          if (startWatchImmediately && !result.replayed) {
            const subscription = works.repo.listSubscriptions(result.work.workId).find(item => item.source === "cron" && !item.stoppedAt);
            if (!subscription) throw new Error("持续跟踪缺少已持久保存的时间表");
            const eventId = `watch-start:${operationId}`;
            works.repo.insertInbox({ eventId, dedupeKey: eventId, source: "cron", sourceEventId: eventId,
              eventType: "work.tick", workId: result.work.workId, subscriptionId: subscription.subscriptionId,
              intentRevision: result.work.intentRevision, stateVersion: result.work.stateVersion, ownerEpoch: result.work.ownerEpoch,
              payload: { scheduledAt: Date.now(), immediate: true, scheduleRevision: subscription.scheduleRevision ?? 1 },
              status: "pending", mergedCount: 1, receivedAt: Date.now(), processReason: "user-requested-first-check" });
          }
          if (name === "work_create" || name === "work_amend" && result.work.inputSnapshotId !== previousSnapshotId) {
            messages.linkWorkUserInput(source, result.work);
            messages.linkWorkAttachments(source, result.work.workId, result.work.inputSnapshotId, previousSnapshotId);
          }
          messages.linkWork(source, result.work.workId);
          works.repo.linkConversation(result.work.workId, conversationId, "desktop", Date.now());
          if (shouldSchedule && result.work.mode !== "watch") options.schedule(result.work, operationId, name === "work_resume");
        }
        return result;
      });
      options.wake(result.ok ? result.work.workId : undefined);
      if (!result.ok) return output(result);
      const active = works.repo.listSubscriptions(result.work.workId).filter(item => !item.stoppedAt);
      const next = active.filter(item => item.nextWakeAt !== undefined).sort((a, b) => a.nextWakeAt! - b.nextWakeAt!)[0];
      return output({ ...result, ...(preservedUserCriteria.length ? { preservedUserCriteria,
        amendmentNotice: "用户直接设置或确认的验收条件仍然保留；criteria 只更新助理建议检查。本次没有删除或改写这些用户验收条件，不得声称已经撤销。修改用户验收条件请使用现有用户编辑入口。" } : {}), tracking: { activeSubscriptions: active.length,
        nextWakeAt: next?.nextWakeAt ?? null, timezone: next?.timezone ?? null,
        cronExpression: next?.cronExpression ?? null, deadlineAt: result.work.deadlineAt ?? null,
        hostMustBeRunning: true } });
    },
  }));
  return [defineTool({ name: "work_query_status", description: "查询当前 Bot 的事项。概览用 view:summary，默认仅未结束事项、每页20项；支持 status、search、limit、cursor，返回准确总数与nextQuery续页参数。只展示摘要，不能把本页数当总数；用 workId 按需读取完整成果和版本守卫。detail 必须指定 workId。不会启动业务工具。",
    parameters: inputParameters.query, replay: "safe",
    execute: async (args, api, context) => {
      const requestId = await botForegroundRequest(api, api.callId, context);
      return output(works.transaction(() => {
      assertActive();
      const source = receipt(requestId);
      const input = query.parse(args);
      if (input.view === "detail" && !input.workId) throw new Error("完整详情必须指定 workId；概览请用 view:summary");
      if (input.workId && input.view !== "summary") {
        if (input.cursor || input.search || input.status || input.limit) throw new Error("按 workId 读取详情时不要携带列表筛选或游标");
        if (!catalogue.canRead(input.workId)) return [];
        const work = works.getWork(input.workId)!;
        const versionGuard = { expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch };
        db.prepare(`INSERT INTO bot_work_reads(conversation_id,request_id,work_id,guard_json) VALUES (?,?,?,?)
          ON CONFLICT(conversation_id,request_id,work_id) DO UPDATE SET guard_json=excluded.guard_json`)
          .run(conversationId, source.request_id, work.workId, JSON.stringify(versionGuard));
        const projection = works.getProjection(work.workId);
        const visibleMessages = works.collaboration.list(actor(), work.workId);
        return [{ ...projection, phase3: projection?.phase3 ? { ...projection.phase3,
          collaborationMessages: visibleMessages, handoffs: visibleMessages.filter(message => message.kind === "handoff") } : undefined,
          versionGuard }];
      }
      const legacy = Object.keys(input).length === 0;
      const page = catalogue.page(legacy ? { status: "all" } : input);
      const recordRead = db.prepare(`INSERT INTO bot_work_reads(conversation_id,request_id,work_id,guard_json) VALUES (?,?,?,?)
        ON CONFLICT(conversation_id,request_id,work_id) DO UPDATE SET guard_json=excluded.guard_json`);
      for (const item of page.items) recordRead.run(conversationId, source.request_id, item.workId, JSON.stringify(item.versionGuard));
      if (!legacy) return page;
      // Preserve the old list's array shape. Metadata belongs to an item because
      // JSON.stringify ignores non-index properties attached to an Array.
      const { items, ...queryPage } = page;
      return items.map((item, index) => index === 0 ? { ...item, queryPage } : item);
    })); } }), ...mutations,
  defineTool({ name: "memory_search", description: "查询当前 Bot 私有记忆，不访问其他 Bot 或项目。",
    parameters: inputParameters.memory, replay: "safe",
    execute: async args => { assertActive(); return output(options.memorySearch(memory.parse(args).query)); } })];
}
