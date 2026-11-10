import type Database from "better-sqlite3";
import { workTeamTaskAssignmentSchema } from "../../../shared/bot-work-team";
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
  scheduleBasis: z.enum(["user_specified", "recommended"]).optional().describe("区分用户指定时间与助理建议安排；创建watch必填。没有指定频率时可按任务建议合理低频，不冒充用户原话"),
  scheduleRationale: z.string().min(1).max(1000).optional().describe("建议安排的理由及可更改说明；scheduleBasis=recommended时必填"),
  stopConditionText: z.string().min(1).max(1000).optional().describe("保留用户给出的停止条件；检查后汇报是否满足，不自行宣称已完成"),
}).strict();
const timing = { mode: z.enum(["once", "watch"]).optional(), watchRule: watchRule.optional(),
  deadlineAt: z.number().int().nonnegative().optional().describe("承诺期限 Unix 毫秒时间戳，到期只读跟进，不等同于自动取消") };
const create = z.object({ ...fields, ...timing, title: text,
  requestedOutcome: z.enum(["one_time", "ongoing"]).describe("你对用户本次目标的语义理解，结合上下文而非关键词：one_time是交付一次结果，ongoing是之后仍须继续观察/跟进。实现监控功能、总结历史周期数据不等于要求Bot持续监控。这是你的理解，不替代宿主保存的用户原文"),
  mode: z.enum(["once", "watch"]).describe("实际执行计划：立即一次执行用once；未来检查或持续关注用watch。ongoing不能降为once，一次性未来跟进也可用watch"),
  startImmediately: z.boolean().optional().describe("持续跟踪默认等到首次检查；仅用户要求现在也检查时设 true") }).strict();
const change = z.object({ ...fields, ...timing, watchRule: watchRule.nullable().optional(),
  deadlineAt: timing.deadlineAt.nullable().optional(), workId: text, versionGuard: guard }).strict();
const control = z.object({ workId: text, reason: text.optional(), versionGuard: guard }).strict();
const memory = z.object({ query: text }).strict();
const memoryForget = z.object({ ids: z.array(text).min(1).max(20), userEvidence: text }).strict();
const teamCreate = z.object({ templateId: z.string().min(1).max(200).optional(), title: z.string().min(1).max(240),
  goalDescription: z.string().min(1).max(2000), criteria: z.array(z.string().min(1).max(1000)).min(1).max(12),
  taskAssignment: workTeamTaskAssignmentSchema.optional().describe("按本次任务从候选 Bot 或模板内选成员并分配具体职责、依赖；负责人汇总。不用模板时必须提供。不能新建 Bot 或增加权限。依赖成员须排在前面，互不依赖的成员无需填写依赖。省略则沿用模板分工") }).strict();
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
  teamId?: string;
  conversationId: string;
  bots: BotRegistry;
  messages: BotConversationRepository;
  works: WorkService;
  requestNamespace?: string;
  schedule: (work: WorkDto, operationId: string, retryBlocked?: boolean) => void;
  wake: (workId?: string) => void;
  memorySearch: (query: string) => unknown;
  memoryForget?: (ids: string[], userText: string, evidence: string) => unknown;
  isAuthority: () => boolean;
  botWorkspace?: (botId: string, prepareDefault?: boolean) => string;
}

/** Foreground Work/memory controls. Read-only web tools are mounted separately by the host. */
export const BOT_FOREGROUND_TOOLS = new Set(["work_query_status", "work_create", "work_amend", "work_pause", "work_resume", "work_cancel", "memory_search", "memory_forget", "work_team_templates", "work_team_create"]);

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
  const catalogue = new BotWorkQuery(db, userId, botId, options.teamId);
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
      ? "受理长耗时、多步骤或文件/代码/桌面操作并派发后台。goalDescription、constraints、criteria 是你的规划，宿主会独立附上用户原文；忠实传达要求，计算结果和未验证假设不得写成用户约束。日常天气、新闻等实时查询直接使用前台 web_search/fetch_content，不创建 Work。用户已经提出的执行请求无需再确认创建任务。同一调用用requestedOutcome记录对用户目标的一次性/持续性理解，用mode和watchRule记录实际计划，不能省略mode后默认一次性。持续跟踪使用 mode=watch 与 watchRule.cronExpression，一次未来检查可使用nextWakeAt，不得只在文字中承诺；按用户指定频率和时区，未指定时明确区分建议安排。deadlineAt 是到期跟进，不是授权到期。创建无需先查询版本；已有相同事项则查询进度，避免重复创建。返回成功才可声称已受理或已安排；未来检查不得声称正在执行。"
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
        const operationId = `bot:${conversationId}:${options.requestNamespace ? `request:${options.requestNamespace}:` : ""}tool:${api.taskId}`;
        let result: WorkControlResult;
        let previousSnapshotId: string | undefined;
        let shouldSchedule = false;
        let startWatchImmediately = false;
        if (name === "work_create") {
          const { startImmediately, requestedOutcome, ...input } = create.parse(args);
          if (options.teamId) throw new Error("当前是团队会话，请用 work_team_create 为当前团队派发，不创建个人事项");
          const mode = input.mode;
          // Enforce the model's structured distinction, not a host-language
          // heuristic that claims to understand arbitrary natural-language intent.
          if (requestedOutcome === "ongoing" && mode !== "watch")
            throw new Error("持续目标不能按一次性计划受理；请保留ongoing理解并提供watch安排，不能只在目标文字里承诺持续");
          if (requestedOutcome === "one_time" && input.watchRule?.cronExpression)
            throw new Error("一次性目标不能创建无限周期；未来只检查一次请使用nextWakeAt，不设置cronExpression");
          if (requestedOutcome === "ongoing" && !input.watchRule?.cronExpression)
            throw new Error("持续目标需要后续周期安排；只有一次nextWakeAt不能满足持续跟进。可按任务建议合理频率并明确说明，也可询问必要偏好");
          if (mode === "watch" && !input.watchRule?.cronExpression && input.watchRule?.nextWakeAt === undefined)
            throw new Error("未来跟进需要有效检查时间或频率；可按任务建议合理安排并明确说明，不能仅保存一句承诺");
          if (input.watchRule && mode !== "watch") throw new Error("持续跟踪规则必须使用 watch 模式");
          if (mode === "watch" && !input.watchRule?.scheduleBasis)
            throw new Error("检查安排须区分用户指定与助理建议；建议频率必须明确说明，不能冒充用户已指定");
          if (input.watchRule?.scheduleBasis === "recommended" && !input.watchRule.scheduleRationale?.trim())
            throw new Error("建议检查频率须给出简短理由和可更改说明");
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
            if (amended.watchRule?.scheduleBasis === "recommended" && !amended.watchRule.scheduleRationale?.trim())
              throw new Error("新的建议检查安排须给出对应的简短理由和可更改说明");
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
          if (shouldSchedule && result.work.mode !== "watch" && !works.teams.get(result.work.workId)) options.schedule(result.work, operationId, name === "work_resume");
        }
        return result;
      });
      options.wake(result.ok ? result.work.workId : undefined);
      if (!result.ok) return output(result);
      // Operation receipts deliberately preserve historical snapshots; tracking
      // reports current scheduling facts even when the operation is replayed.
      const current = works.getWork(result.work.workId)!;
      const active = works.repo.listSubscriptions(result.work.workId).filter(item => !item.stoppedAt);
      const next = active.filter(item => item.nextWakeAt !== undefined).sort((a, b) => a.nextWakeAt! - b.nextWakeAt!)[0];
      return output({ ...result, ...(preservedUserCriteria.length ? { preservedUserCriteria,
        amendmentNotice: "用户直接设置或确认的验收条件仍然保留；criteria 只更新助理建议检查。本次没有删除或改写这些用户验收条件，不得声称已经撤销。修改用户验收条件请使用现有用户编辑入口。" } : {}), tracking: { activeSubscriptions: active.length,
        scheduleStatus: current.lifecycle !== "active" ? "inactive" : next?.nextWakeAt !== undefined
          ? next.nextWakeAt > Date.now() ? "scheduled" : "due" : "not_scheduled",
        scheduleBasis: current.watchRule?.scheduleBasis ?? null,
        scheduleRationale: current.watchRule?.scheduleRationale ?? null,
        ...(current.watchRule?.scheduleBasis === "recommended" ? { notice: "这是助理按任务建议的检查安排，不是用户明确指定的频率。请告知实际首次时间、时区、建议理由以及可随时更改。" } : {}),
        nextWakeAt: next?.nextWakeAt ?? null, timezone: next?.timezone ?? null,
        cronExpression: next?.cronExpression ?? null, deadlineAt: current.deadlineAt ?? null,
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
  defineTool({ name: "work_team_templates", description: "查询当前 Bot 负责的已保存团队分工。同时返回当前工作目录可用的现有候选 Bot。需要多人协作时先查成员名字与职责；无模板也可从 availableBots 选择成员直接组队，无需用户先保存模板。",
    parameters: parameters(z.object({}).strict()), replay: "safe",
    execute: async (_args, api, context) => {
      z.object({}).strict().parse(_args);
      const requestId = await botForegroundRequest(api, api.callId, context);
      assertActive(); receipt(requestId);
      const templates = works.teams.foregroundTemplates(userId, botId).filter(team => !options.teamId || team.templateId === options.teamId).map(template => ({ ...template,
        members: template.members.map(member => ({ ...member,
          displayName: bots.getBot(member.botId)?.displayName ?? member.botId,
          responsibilitySummary: bots.getBot(member.botId)?.responsibilitySummary ?? "" })) }));
      const workspacePath = options.teamId ? works.teams.resolveWorkspace(userId, options.teamId) : options.botWorkspace?.(botId);
      return output({ templates, availableBots: workspacePath ? works.teams.foregroundCandidates(userId, botId, workspacePath) : [], workspacePath: workspacePath ?? null });
    } }),
  defineTool({ name: "work_team_create", description: "创建并启动团队：先查 work_team_templates；可省略 templateId，提供 taskAssignment 从 availableBots 自主选择适合本次委托的成员和依赖，宿主默认有界并行。也可复用模板内成员和上限。负责人保持当前 Bot，权限仅来自已有范围，目录来自 Bot 设置。title/goalDescription/criteria 是执行规划，宿主独立保留用户原文与附件。用户要求执行即可开工，无需再次确认。不要另调用 work_create 重复派发。成功后可用 work_query_status 查询成员进度，work_pause/resume/cancel 控制已有团队。",
    parameters: parameters(teamCreate), replay: "safe",
    execute: async (args, api, context) => {
      const input = teamCreate.parse(args);
      if (options.teamId && input.templateId && input.templateId !== options.teamId) throw new Error("不能向其他团队派发任务");
      if (options.teamId) input.templateId = options.teamId;
      const requestId = await botForegroundRequest(api, api.callId, context);
      const result = works.transaction(() => {
        assertActive();
        const source = receipt(requestId);
        const workspacePath = input.templateId ? works.teams.resolveWorkspace(userId, input.templateId) : options.botWorkspace?.(botId, true);
        if (!workspacePath) throw new Error("当前 Bot 没有可用工作目录，请在 Bot 设置中指定文件夹");
        const result = works.teams.createFromForeground(actor(), { ...input,
          operationId: `bot:${conversationId}:${options.requestNamespace ? `request:${options.requestNamespace}:` : ""}team:${api.taskId}`, workspacePath, conversationId, sourceMessageId: source.user_message_id });
        if (result.ok && result.work) {
          messages.linkWorkUserInput(source, result.work);
          messages.linkWorkAttachments(source, result.work.workId, result.work.inputSnapshotId);
          messages.linkWork(source, result.work.workId);
          works.repo.linkConversation(result.work.workId, conversationId, "desktop", Date.now());
        }
        return result;
      });
      if (result.ok && result.work) options.wake(result.work.workId);
      return output(result);
    } }),
  defineTool({ name: "memory_search", description: "查询当前 Bot 私有记忆，不访问其他 Bot 或项目。",
    parameters: inputParameters.memory, replay: "safe",
    execute: async args => { assertActive(); if (options.teamId) throw new Error("团队会话不读取私人记忆"); return output(options.memorySearch(memory.parse(args).query)); } }),
  defineTool({ name: "memory_forget", description: "用户明确要求忘记时，先 memory_search 找到对应记录，再删除当前 Bot 的这些私人记忆。必须提供当前用户要求忘记的原话。只在工具成功后说已忘记；不删除聊天历史，不创建 Work。",
    parameters: parameters(memoryForget), replay: "safe",
    execute: async (args, api, context) => {
      assertActive();
      if (options.teamId) throw new Error("团队会话不修改私人记忆");
      const input = memoryForget.parse(args);
      const requestId = await botForegroundRequest(api, api.callId, context);
      const source = receipt(requestId);
      if (!options.memoryForget) throw new Error("当前记忆删除服务不可用");
      return output(options.memoryForget(input.ids, messages.message(source.user_message_id)!.text, input.userEvidence));
    } })];
}
