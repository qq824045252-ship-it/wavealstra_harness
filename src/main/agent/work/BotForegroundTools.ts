import { readWorkFileSource } from "./WorkFileEventSource";
import { botReminderTool } from "./BotReminderTools";
import { workWatchIntentSchema } from "../../../shared/work-watch-intent";
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
import { BotWorkQuery, botWorkQuerySchema, type BotWorkQueryInput } from "./BotWorkQuery";
import { resolveWorkTarget } from "./BotWorkTargetSelection";
import { botScheduleOverview, botScheduleOverviewQuerySchema } from "./BotScheduleOverview";
import { peerKey } from "./BotPeerIngress";
import { botMemoryDurableEvidence } from "../../memory/BotMemorySource";

// Validate the wire text before trimming so its length and non-blank rules can be
// represented exactly in the model-visible JSON Schema as well as at execution.
const text = z.string().min(1).max(32000).regex(/\S/, "文本不能仅包含空白").trim();
const criterion = z.object({ text, requiresRealEnvironmentCheck: z.boolean().optional(), requiredEnvironment: text.optional() }).strict();
const fields = { title: text.optional(), goalDescription: text.optional(), constraints: z.array(text).max(30).optional(),
  criteria: z.array(criterion).max(12).optional() };
const guard = z.object({ expectedStateVersion: z.number().int().positive(), expectedIntentRevision: z.number().int().positive(),
  expectedOwnerEpoch: z.number().int().positive() }).strict();
const query = botWorkQuerySchema;
const watchRule = workWatchIntentSchema;
const timing = { mode: z.enum(["once", "watch"]).optional(), watchRule: watchRule.optional(),
  deadlineAt: z.number().int().nonnegative().optional().describe("承诺期限 Unix 毫秒时间戳，到期只读跟进，不等同于自动取消") };
const sourceMessageIds = z.array(z.string().min(1).max(500)).max(32).optional().describe("本轮冻结来源索引中，与当前目标有关的原要求、澄清问答和仍有效限制的消息ID。承接此前目标时明确选择这些来源；当前用户消息自动保留。不选择无关主题、已撤销要求或把助理转述当用户原话。");
const create = z.object({ ...fields, ...timing, title: text, sourceMessageIds,
  sourceIdentity: z.object({ provider: z.string().trim().min(1).max(500), account: z.string().trim().min(1).max(500),
    objectId: z.string().trim().min(1).max(500), action: z.string().trim().min(1).max(500), version: z.string().trim().min(1).max(500),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional() }).strict().optional()
    .describe("来源驱动事项必须使用来源的稳定provider/账户/对象ID/动作类型及版本；两个观察器必须给出相同身份，不使用标题、摘要或当前时间作身份/版本。不臆造未读取的来源标识。新版本续办需提供源端实际读回的单调revision（不是本地时间/自编序号）；无法比较顺序会返回未核对且不会安排新执行"),
  requestedOutcome: z.enum(["one_time", "ongoing"]).describe("你对用户本次目标的语义理解，结合上下文而非关键词：one_time是交付一次结果，ongoing是之后仍须继续观察/跟进。实现监控功能、总结历史周期数据不等于要求Bot持续监控。这是你的理解，不替代宿主保存的用户原文"),
  mode: z.enum(["once", "watch"]).describe("实际执行计划：立即一次执行用once；未来检查或持续关注用watch。ongoing不能降为once，一次性未来跟进也可用watch"),
  startImmediately: z.boolean().optional().describe("持续计划默认等到首次检查；用户要求现在也行动时设 true。持续推进现在可行动就设true，不要求预先虚构nextWakeAt；确实需要等待时才安排后续") }).strict();
const change = z.object({ ...fields, ...timing, sourceMessageIds, watchRule: watchRule.nullable().optional(),
  deadlineAt: timing.deadlineAt.nullable().optional(), workId: text, versionGuard: guard }).strict();
const control = z.object({ workId: text, reason: text.optional(), versionGuard: guard }).strict();
export const botWorkCreateSchema = create;
export const botWorkChangeSchema = change;
export const botWorkVersionGuardSchema = guard;
const memory = z.object({ query: text }).strict();
const memoryRemember = z.object({ scope: z.enum(["current", "conversation", "public"]).default("current"),
  kind: z.enum(["identity", "preference", "fact", "decision", "constraint"]),
  title: z.string().min(1).max(200), content: z.string().min(1).max(4000), userEvidence: text }).strict();
const memoryForget = z.object({ ids: z.array(text).min(1).max(20), userEvidence: text }).strict();
const teamCreate = z.object({ ...timing, sourceMessageIds, requestedOutcome: create.shape.requestedOutcome, mode: create.shape.mode, startImmediately: create.shape.startImmediately, templateId: z.string().min(1).max(200).optional(), title: z.string().min(1).max(240),
  goalDescription: z.string().min(1).max(2000), criteria: z.array(z.string().min(1).max(1000)).min(1).max(12),
  taskAssignment: workTeamTaskAssignmentSchema.optional().describe("按本次任务从候选 Bot 或模板内选成员并分配具体职责、依赖；负责人汇总。不用模板时必须提供。不能新建 Bot 或增加权限。依赖成员须排在前面，互不依赖的成员无需填写依赖。省略则沿用模板分工") }).strict();
const teamReplan = z.object({ workId: text, versionGuard: guard, taskAssignment: workTeamTaskAssignmentSchema,
  executionPolicy: z.enum(["sequential", "parallel"]).optional(), maxConcurrency: z.number().int().min(1).max(4).optional() }).strict();
export function validateWatchIntent(requestedOutcome: "ongoing" | "one_time", input: { mode: "once" | "watch"; startImmediately?: boolean; watchRule?: z.infer<typeof watchRule> }): void {
  const rule = input.watchRule;
  const hasFutureAction = Boolean(rule?.cronExpression || rule?.eventSource) || rule?.nextWakeAt !== undefined;
  const actNow = input.startImmediately === true || rule?.triggerMode === "current_condition";
  if (requestedOutcome === "ongoing" && input.mode !== "watch")
    throw new Error("持续目标需要真实的后续安排或立即推进；请使用mode=watch，不能降为once");
  if (requestedOutcome === "one_time" && rule?.cronExpression)
    throw new Error("一次性目标不能创建无限周期；未来只检查一次请使用nextWakeAt，不设置cronExpression");
  if (input.mode === "watch" && !hasFutureAction && !(requestedOutcome === "ongoing" && actNow))
    throw new Error(requestedOutcome === "one_time" ? "一次未来执行需要明确的执行时间或已支持事件来源；没有等待要求就用mode=once立即执行"
      : "持续目标需要可执行的下一步或真实未来动作；现在能推进就用startImmediately=true，不应虚构等待时间");
  if (rule && input.mode !== "watch") throw new Error("持续跟踪规则必须使用 watch 模式");
  if (hasFutureAction && !rule?.scheduleBasis) throw new Error("检查安排须区分用户指定与助理建议");
  if (rule?.scheduleBasis === "recommended" && !rule.scheduleRationale?.trim()) throw new Error("建议检查频率须给出简短理由和可更改说明");
  if (rule?.eventSource && (rule.cronExpression || rule.nextWakeAt !== undefined)) throw new Error("事件订阅与定时轮询应明确选择一种，不冒充已接入事件");
  if (rule?.triggerMode === "next_event" && actNow) throw new Error("等待下一次事件不能同时执行当前状态检查");
}
// One source for Function Calling and runtime validation: nested strictness,
// array bounds and all three positive version guards must not drift apart.
const parameters = <Schema extends z.ZodType>(schema: Schema) =>
  Type.Unsafe<z.input<Schema>>(z.toJSONSchema(schema, { target: "draft-7", io: "input" }));
const inputParameters = { query: parameters(query), create: parameters(create), change: parameters(change),
  control: parameters(control), memory: parameters(memory) };

export interface BotForegroundToolOptions {
  reminders?: () => import("../../cron/CronService").CronService | undefined;
  db: Database.Database;
  userId: string;
  botId: string;
  teamId?: string;
  conversationId: string;
  bots: BotRegistry;
  messages: BotConversationRepository;
  works: WorkService;
  requestNamespace?: string;
  workspacePath?: string;
  captureWorkSettings?: (work: WorkDto) => void;
  schedule: (work: WorkDto, operationId: string, retryBlocked?: boolean) => void;
  wake: (workId?: string) => void;
  memorySearch: (query: string) => unknown | Promise<unknown>;
  recordWorkFeedback?: (source: import("./BotConversationRepository").BotMessageReceipt, work: WorkDto) => unknown;
  memoryRemember?: (input: z.infer<typeof memoryRemember>, userText: string) => unknown;
  memoryForget?: (ids: string[], userText: string, evidence: string, source?: { createdAt: number; messageId: string }) => unknown;
  isAuthority: () => boolean;
  botWorkspace?: (botId: string, prepareDefault?: boolean) => string;
}

/** Foreground Work/memory controls. Read-only web tools are mounted separately by the host. */
export const BOT_FOREGROUND_TOOLS = new Set(["reminder_manage", "schedule_overview", "work_query_status", "work_watch_sources", "work_create", "work_amend", "work_pause", "work_resume", "work_cancel", "memory_search", "memory_forget", "memory_remember", "work_team_templates", "work_team_create", "work_team_replan"]);

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
  const catalogue = new BotWorkQuery(db, userId, botId, options.teamId,
    messages.origins.isShared(conversationId) ? conversationId : undefined);
  // Deterministic title resolution only when no stronger fact exists. Bounded SQL
  // pages; never hydrates Work detail or interprets model arguments.
  const openWorksForTargets = () => {
    const items: Array<{ workId: string; title: string }> = [];
    let query: BotWorkQueryInput = { status: "open", limit: 50 };
    for (let page = 0; page < 10; page++) {
      const result = catalogue.page(query);
      items.push(...result.items.map(item => ({ workId: item.workId, title: item.title })));
      if (!result.hasMore) return { items, complete: true };
      if (!result.nextQuery) return { items, complete: false };
      query = result.nextQuery;
    }
    return { items, complete: false };
  };
  const select = (workId: string, source: ReturnType<typeof receipt>, requestedAction?: "pause" | "resume" | "cancel" | "amend") => {
    if (!catalogue.canRead(workId) && catalogue.outgoingCollaboration(workId))
      throw new Error("委派给其他 Bot 的事项仅可在这里查询；修改须沿原 collaborationId 调用 bot_collaborate query，再携带其 versionGuard 控制原事项");
    const reference = source.reference_message_id ? messages.message(source.reference_message_id)?.workIds ?? [] : [];
    const userMessage = messages.message(source.user_message_id);
    // Read the actual user input, not model arguments or the current UI selection.
    // Include unknown/foreign IDs so they cannot fall back to an unrelated card.
    const explicit = [...new Set(userMessage?.text.match(/(?<![A-Za-z0-9_-])work-[A-Za-z0-9_-]+(?![A-Za-z0-9_-])/g) ?? [])];
    const linked = userMessage?.workIds ?? [];
    const higherPriority = Boolean(explicit.length || reference.length || source.selected_work_id);
    const available = openWorksForTargets();
    // Negative clauses must also protect a selected/replied target. Include the
    // requested readable title even if the bounded catalogue did not reach it;
    // it supplies exclusion evidence only, never uniqueness across unseen rows.
    if (!available.items.some(item => item.workId === workId) && catalogue.canRead(workId)) {
      const requested = works.getWork(workId);
      if (requested) available.items.push({ workId, title: requested.title });
    }
    const resolution = resolveWorkTarget({ userText: userMessage?.text ?? "", explicitWorkIds: explicit, requestedAction,
      referencedWorkIds: reference, selectedWorkId: source.selected_work_id ?? undefined, linkedWorkIds: linked,
      openWorks: available.items, openWorksComplete: available.complete,
      soleOpenWorkId: higherPriority ? undefined : catalogue.soleOpenWorkId(), requestedWorkId: workId });
    if (!resolution.ok) throw new Error(resolution.message);
    // Links support follow-up calls/replay for Work created in this request; they
    // never override an explicit target or rescue ambiguous named titles.
    const target = catalogue.canRead(resolution.workId) ? works.getWork(resolution.workId) : undefined;
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
      ? "受理长耗时、多步骤或文件/代码/桌面操作并派发后台。goalDescription、constraints、criteria 是你的规划，宿主会独立附上用户原文；criteria应按交付用途说明实际检查及所需环境，必要检查不能只写“任务完成”或“文件已生成”；忠实传达要求，计算结果和未验证假设不得写成用户约束。日常天气、新闻等实时查询直接使用前台 web_search/fetch_content，不创建 Work。用户已经提出的执行请求无需再确认创建任务。同一调用用requestedOutcome记录对用户目标的一次性/持续性理解，用mode和watchRule记录实际计划，不能省略mode后默认一次性。持续目标使用 mode=watch；只读观察用watchRule.executionMode=observe，持续执行/修复/更新原成果用continuous，即使有周期cron也应显式设continuous。周期跟踪给 watchRule.cronExpression；若现在就能推进、之后才需等待，用 startImmediately=true 先执行；确实需要等待时再给 watchRule.nextWakeAt 或真实 eventSource 安排跟进；一次未来检查可用nextWakeAt，不得只在文字中承诺。ongoing不能降为once；startImmediately可先持续推进，无需编造等待时间。按用户指定频率和时区，未指定时明确区分建议安排。deadlineAt 是到期跟进，不是授权到期。仅为新的独立目标创建。用户改已有事项的输出、执行方向、约束或验收条件时必须先查询原Work并用work_amend；即使涉及文件写入、原执行仍在途或需要等待，也不得另建修正Work与原执行竞争。创建新目标无需先查询版本。返回成功才可声称已受理或已安排；未来检查不得声称正在执行。"
      : `${name}: 操作用户明确指定的已有事项，先查询并携带返回的 versionGuard；冲突重新查询。work_amend 可直接修改原事项的goalDescription、constraints、criteria、title和watchRule/期限；修改执行目标时保留不变的用户要求，携带原workId与本次查询的versionGuard。必须检查查询返回的现有goalDescription、constraints和criteria，在同一次work_amend中完整更新所有受本次修改影响的规划字段；省略字段会原样保留，不会自动删除已过时的步骤。新目标替换旧目标时，去掉助理旧计划中已被替换的中间写入或重复启动步骤，不能只改description/criteria却遗留冲突constraints；未受影响的真实用户限制必须保留，不把助理计划当用户硬性要求。已完成且未受影响的部分继续复用，修订不是重新执行整个原请求。正在执行也应修订原Work，宿主负责在边界使旧意图失效并安排后续，不用work_create另建修正任务，不自行sleep等待后再用另一Work覆盖文件。watchRule=null 停止后续跟踪而保留事项；work_pause/resume 暂停/恢复，work_cancel 取消整个事项。仅改时间表不会立即重跑原任务。团队watch调整时间只传watchRule/deadlineAt及身份/版本，不要顺手改标题或目标，否则会使成员分工失效；真正改目标后必须继续调用work_team_replan修订剩余分工，不能只报告amend成功。用户明确控制多个事项时按动作和目标逐项调用，先查询每项版本，准确区分暂停A/恢复B/保持C；一项失败只重查重试该项，不重复已成功动作，不把未来条件执行成立即动作。批评、催促、抱怨不是暂停或取消意图；仅明确要求停止/取消时调用对应控制。`,
    parameters: name === "work_create" ? inputParameters.create
      : name === "work_amend" ? inputParameters.change : inputParameters.control,
    replay: "safe",
    execute: async (args, api, context) => {
      const requestId = await botForegroundRequest(api, api.callId, context);
      // Read the authorized configured file before opening a database transaction.
      // The transaction below revalidates the live request and amendment version.
      let fileBaseline: Awaited<ReturnType<typeof readWorkFileSource>> | undefined;
      if (name === "work_create" || name === "work_amend") {
        const parsed = name === "work_create" ? create.parse(args) : change.parse(args);
        assertActive();
        const source = receipt(requestId);
        const target = name === "work_amend" ? select((parsed as z.infer<typeof change>).workId, source, "amend") : undefined;
        const operationId = `bot:${conversationId}:${options.requestNamespace ? `request:${options.requestNamespace}:` : ""}tool:${api.taskId}`;
        const prior = works.repo.getReceipt(userId, operationId);
        const rule = parsed.watchRule;
        if (rule?.eventSource === "file" || rule && !rule.eventSource && target?.watchRule?.eventSource === "file") {
          if (!works.ingress.availableEventSources().some(item => item.source === "file")) throw Error("文件事件接收器当前不可用");
          if ("sourceIdentity" in parsed && parsed.sourceIdentity !== undefined) throw Error("本地文件事件使用实际内容基线，不同时设置外部 sourceIdentity");
          if (target && target.ownerBotId !== botId) throw Error("只能配置负责人 Bot 的文件事件来源");
          if (target && !prior) {
            const expected = (parsed as z.infer<typeof change>).versionGuard;
            const read = db.prepare("SELECT guard_json FROM bot_work_reads WHERE conversation_id=? AND request_id=? AND work_id=?")
              .get(conversationId, source.request_id, target.workId) as { guard_json: string } | undefined;
            if (!read || read.guard_json !== JSON.stringify(expected) || target.stateVersion !== expected.expectedStateVersion
              || target.intentRevision !== expected.expectedIntentRevision || target.ownerEpoch !== expected.expectedOwnerEpoch)
              throw Error("读取新文件基线前必须查询当前 Work 并携带完整版本守卫");
          }
          if ((rule.catchUpPolicy ?? target?.watchRule?.catchUpPolicy) === "each") throw Error("文件事件无法回放每一次写入，请使用 latest 或 skip");
          if (Object.keys(rule.eventFilter ?? {}).length) throw Error("文件事件仅按 eventTarget 绑定，不支持内容事件过滤器");
          const path = rule.eventTarget ?? target?.watchRule?.eventTarget;
          if (!path) throw Error("文件事件必须指定 eventTarget 绝对文件路径");
          const stored = prior ? (JSON.parse(prior.result_snapshot_json) as WorkDto).goalSources.find(item => item.sourceType === "file" && item.sourceRef === path) : undefined;
          fileBaseline = stored ?? await readWorkFileSource(path);
          // Retain observation identity when a settings-only edit keeps the same file content.
          fileBaseline = target?.goalSources.find(item => item.sourceType === "file" && item.sourceRef === path
            && item.inputSnapshotId === fileBaseline!.inputSnapshotId) ?? fileBaseline;
        }
      }
      let preservedUserCriteria: Array<{ id: string; text: string }> = [];
      const result = works.transaction(() => {
        const bot = assertActive();
        const source = receipt(requestId);
        const peer = messages.peers.origin(source.user_message_id);
        if (peer?.kind === "return") throw new Error("回流不是新的执行请求");
        const human = messages.userSource(source);
        const relation = peer ? messages.collaborations.get(userId, peer.collaborationId) : undefined;
        if (peer && (!relation || relation.targetBotId !== botId)) throw new Error("协作目标身份已变化");
        if (peer && relation?.workId && name !== "work_create" && "workId" in args && args.workId !== relation.workId)
          throw new Error("本次协作只能控制其原 Work");
        const operationId = name === "work_create" && peer ? `peer-work:${peerKey(peer.collaborationId)}`
          : name === "work_pause" || name === "work_resume" || name === "work_cancel"
            ? `bot-control:${peerKey(source.user_message_id, name, control.parse(args).workId)}`
            : `bot:${conversationId}:${options.requestNamespace ? `request:${options.requestNamespace}:` : ""}tool:${api.taskId}`;
        if (name === "work_create" && relation?.workId) {
          const existing = works.getWork(relation.workId);
          if (!existing || existing.ownerBotId !== botId) throw new Error("原协作 Work 归属待核对");
          messages.linkWork(source, existing.workId);
          return { ok: true as const, replayed: true, work: existing };
        }
        let result: WorkControlResult;
        let previousSnapshotId: string | undefined;
        let shouldSchedule = false;
        let startWatchImmediately = false;
        let selectedSources: string[] | undefined;
        if (name === "work_create") {
          const { startImmediately, requestedOutcome, sourceMessageIds, ...input } = create.parse(args);
          selectedSources = sourceMessageIds;
          messages.validateWorkUserInput(human, selectedSources);
          if (options.teamId) throw new Error("当前是团队会话，请用 work_team_create 为当前团队派发，不创建个人事项");
          const mode = input.mode;
          // Enforce the model's structured distinction, not a host-language
          // heuristic that claims to understand arbitrary natural-language intent.
          validateWatchIntent(requestedOutcome, { ...input, startImmediately });
          if (input.watchRule?.eventSource && !works.ingress.availableEventSources().some(item => item.source === input.watchRule!.eventSource))
            throw new Error("此事件来源尚未接入；请查询work_watch_sources，明确说明只能定时检查并提供真实轮询时间，不要声称事件订阅成功");
          if (requestedOutcome === "ongoing" && startImmediately && !input.watchRule?.cronExpression && input.watchRule?.nextWakeAt === undefined && !input.watchRule?.eventSource)
            input.watchRule = { ...input.watchRule, executionMode: "continuous" };
          shouldSchedule = mode !== "watch";
          startWatchImmediately = mode === "watch" && (startImmediately === true || input.watchRule?.triggerMode === "current_condition");
          result = works.createWork(actor(), { ...input, mode, workspacePath: options.workspacePath,
            watchRule: input.watchRule ? { ...input.watchRule, requestedOutcome, subscriptions: [input.watchRule.eventSource ?? "cron"],
              timezone: input.watchRule.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
              ...(fileBaseline ? { maxMergeWaitMs: 1000 } : {}) } : undefined,
            criteria: input.criteria?.map(item => ({ ...item, origin: "assistant_proposal" as const })), operationId, ownerBotId: botId,
            conversationId: peer ? human.conversation_id : conversationId, sourceMessageId: human.user_message_id, inputSnapshotId: fileBaseline?.inputSnapshotId ?? `input:${human.user_message_id}`,
            ...(fileBaseline ? { goalSources: [fileBaseline] } : {}), authorization: bot.authorization });
        } else {
          const input = name === "work_amend" ? change.parse(args) : control.parse(args);
          const target = select(input.workId, source, name === "work_amend" ? "amend" : name === "work_pause" ? "pause" : name === "work_resume" ? "resume" : "cancel");
          previousSnapshotId = target.inputSnapshotId;
          // Team membership grants shared facts, not control of the owner's Work.
          if (target.ownerBotId !== botId) throw new Error("团队成员只能查看和讨论此事项；请联系负责人修改、暂停或取消");
          if (name !== "work_amend") {
            const saved = works.repo.getReceipt(userId, operationId);
            if (saved) return { ok: true as const, replayed: true, work: target };
          }
          const read = db.prepare(`SELECT guard_json FROM bot_work_reads WHERE conversation_id=? AND request_id=? AND work_id=?`)
            .get(conversationId, source.request_id, input.workId);
          const readGuard = z.object({ guard_json: z.string() }).safeParse(read);
          if (!readGuard.success || readGuard.data.guard_json !== JSON.stringify(input.versionGuard)) throw new Error("必须先查询 Work，并使用本回合读取的完整版本守卫");
          if (name === "work_amend") {
            const { sourceMessageIds, ...amended } = change.parse(args);
            selectedSources = sourceMessageIds;
            messages.validateWorkUserInput(human, selectedSources);
            if (amended.watchRule?.eventSource && !works.ingress.availableEventSources().some(item => item.source === amended.watchRule!.eventSource))
              throw new Error("此事件来源尚未接入；请查询work_watch_sources，明确说明只能定时检查");
            if (amended.watchRule?.scheduleBasis === "recommended" && !amended.watchRule.scheduleRationale?.trim())
              throw new Error("新的建议检查安排须给出对应的简短理由和可更改说明");
            if (amended.watchRule && !amended.watchRule.cronExpression && amended.watchRule.nextWakeAt === undefined
              && !amended.watchRule.eventSource && amended.watchRule.executionMode !== "continuous"
              && !target.watchRule?.cronExpression && target.watchRule?.nextWakeAt === undefined && !target.watchRule?.eventSource && target.watchRule?.executionMode !== "continuous")
              throw new Error("持续跟踪需要检查时间或频率，不能保存空时间表");
            const contentChanged = Object.keys(fields).some(key => amended[key as keyof typeof fields] !== undefined);
            shouldSchedule = contentChanged && (amended.mode ?? target.mode) !== "watch";
            const retained = target.criteria.filter(item => item.origin !== "assistant_proposal");
            if (amended.criteria) preservedUserCriteria = retained.map(item => ({ id: item.id, text: item.text }));
            result = works.amendWork(actor(), { ...amended, operationId,
              criteria: amended.criteria ? [...retained.map(item => ({ id: item.id, text: item.text,
                requiresRealEnvironmentCheck: item.requiresRealEnvironmentCheck, requiredEnvironment: item.requiredEnvironment })),
                ...amended.criteria.map(item => ({ ...item, origin: "assistant_proposal" as const }))] : undefined,
              watchRule: amended.watchRule ? { ...amended.watchRule, subscriptions: [amended.watchRule.eventSource ?? target.watchRule?.eventSource ?? "cron"],
                timezone: amended.watchRule.timezone ?? target.watchRule?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone } : amended.watchRule,
              ...(contentChanged ? { inputSnapshotId: `input:${human.user_message_id}`, sourceMessageId: human.user_message_id } : {}),
              ...(fileBaseline ? { goalSources: [fileBaseline], inputSnapshotId: fileBaseline.inputSnapshotId } : {}) });
          }
          else if (name === "work_pause") result = works.pauseWork(actor(), { ...input, operationId });
          else if (name === "work_resume") { result = works.resumeWork(actor(), { ...input, operationId }); shouldSchedule = target.mode !== "watch"; }
          else result = works.cancelWork(actor(), { ...input, operationId });
        }
        if (result.ok) {
          if (fileBaseline && name === "work_amend" && !result.replayed) {
            // Reconfiguring next_event establishes a new baseline, not an offline change.
            for (const subscription of works.repo.listSubscriptions(result.work.workId))
              if (!subscription.stoppedAt && subscription.source === "file" && subscription.sourceTarget === fileBaseline.sourceRef)
                works.ingress.setCursor(subscription.subscriptionId, "file", fileBaseline.sourceRef,
                  { enumerationWatermark: fileBaseline.inputSnapshotId });
          }
          if (startWatchImmediately && !result.replayed) {
            const subscription = works.repo.listSubscriptions(result.work.workId).find(item => !item.stoppedAt);
            if (!subscription) throw new Error("持续跟踪缺少已持久保存的时间表");
            const eventId = `watch-start:${operationId}`;
            works.repo.insertInbox({ eventId, dedupeKey: eventId, source: subscription.source, sourceEventId: eventId,
              eventType: "work.tick", workId: result.work.workId, subscriptionId: subscription.subscriptionId,
              intentRevision: result.work.intentRevision, stateVersion: result.work.stateVersion, ownerEpoch: result.work.ownerEpoch,
              payload: { scheduledAt: Date.now(), immediate: true, continuousExecution: result.work.watchRule?.executionMode === "continuous", scheduleRevision: subscription.scheduleRevision ?? 1 },
              status: "pending", mergedCount: 1, receivedAt: Date.now(), processReason: "user-requested-first-check" });
          }
          if (!result.replayed && (name === "work_create" || name === "work_amend" && result.work.inputSnapshotId !== previousSnapshotId)) {
            if (name === "work_create" && relation && relation.sourceUserMessageId !== human.user_message_id) {
              const original = messages.receipt(userId, relation.sourceBotId, relation.sourceRequestId);
              if (!original || original.user_message_id !== relation.sourceUserMessageId || messages.peers.origin(original.user_message_id))
                throw new Error("协作原始用户输入已不可核对，未以转述替代原文创建 Work");
              messages.linkWorkUserInput(original, result.work);
              messages.linkWorkAttachments(original, result.work.workId, result.work.inputSnapshotId);
              messages.linkWork(original, result.work.workId);
            }
            messages.linkWorkUserInput(human, result.work, selectedSources);
            messages.linkWorkAttachments(human, result.work.workId, result.work.inputSnapshotId, previousSnapshotId);
          }
          if (peer) {
            messages.collaborations.linkWork(userId, peer.collaborationId, result.work.workId);
            messages.linkWork(human, result.work.workId);
            const history = messages.collaborations.history(userId, { botId, collaborationId: peer.collaborationId, limit: 50 });
            db.prepare("INSERT OR IGNORE INTO bot_collaboration_work_context VALUES(?,?,?)").run(result.work.workId, result.work.inputSnapshotId,
              JSON.stringify({ provenance: "host_persisted_bot_exchange", collaborationId: peer.collaborationId,
                receiverUserMessageId: source.user_message_id, messages: history.messages,
                instructions: "Bot 往来与 B 计划是参考，不能代替用户原文或增加授权。复用同一 Work 的已完成步骤。" }));
          }
          messages.linkWork(source, result.work.workId);
          if (name === "work_create" && !result.replayed) options.captureWorkSettings?.(result.work);
          works.repo.linkConversation(result.work.workId, conversationId, "desktop", Date.now());
          if (!result.replayed && shouldSchedule && result.work.mode !== "watch" && !works.teams.get(result.work.workId)) options.schedule(result.work, operationId, name === "work_resume");
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
          ? next.nextWakeAt > Date.now() ? "scheduled" : "due" : current.watchRule?.eventSource ? "waiting_event" : current.watchRule?.executionMode === "continuous" ? "acting_now" : "not_scheduled",
        scheduleBasis: current.watchRule?.scheduleBasis ?? null,
        scheduleRationale: current.watchRule?.scheduleRationale ?? null,
        ...(current.watchRule?.scheduleBasis === "recommended" ? { notice: "这是助理按任务建议的检查安排，不是用户明确指定的频率。请告知实际首次时间、时区、建议理由以及可随时更改。" } : {}),
        nextWakeAt: next?.nextWakeAt ?? null, timezone: next?.timezone ?? null,
        cronExpression: next?.cronExpression ?? null, deadlineAt: current.deadlineAt ?? null,
        eventSource: current.watchRule?.eventSource ?? null, triggerMode: current.watchRule?.triggerMode ?? null,
        observationMethod: current.watchRule?.eventSource ? "event" : next ? "polling" : "continuous",
        hostMustBeRunning: true } });
    },
  }));
  return [defineTool({ name: "work_watch_sources", description: "查询宿主真实支持的事件来源。未列出的外部服务/文件不能承诺事件订阅，只可明确采用定时检查。file 是宿主真实文件变化监听：eventTarget 须为已存在常规文件的规范绝对路径，最多4MiB；next_event保存当前基线而不执行，只支持latest/skip补查，不能回放每次写入历史。未接收的hook不公开。", parameters: parameters(z.object({}).strict()), replay: "safe",
    execute: async () => output({ sources: works.ingress.availableEventSources().map(({ source, namespace, canQueryHistory, versionMode }) => ({source, namespace, canQueryHistory, versionMode})),
      pollingFallback: "没有可用事件来源时，明确说明只能定时检查，用cronExpression或nextWakeAt安排，不称为事件监听" }) }), botReminderTool(options),defineTool({ name: "work_query_status", description: "查询当前 Bot 负责、参与及由本 Bot 沿原协作委派的事项。委派项带delegation，只可读原协作公开摘要和成果，修改须走bot_collaborate，不能把可见性当成普通work_*控制权限。概览用 view:summary，默认仅未结束事项、每页20项；支持 status、search、期限窗口deadlineFrom（含）/deadlineBefore（不含）、needsUserInput、sort、limit、cursor。到期/逾期查询使用期限窗口和sort:deadline_asc；等用户回复用needsUserInput:true，不以最新20项代替筛选。期限窗口用请求时间及指定时区计算的Unix毫秒，不是下次检查时间。返回准确总数与nextQuery续页参数。只展示摘要，不能把本页数当总数；用 workId 按需读取详情：本人原有范围返回完整成果和普通Work版本守卫；委派项只返回原协作公开成果，修改须按controlRoute调用bot_collaborate query获取其守卫。detail 必须指定 workId。不会启动业务工具。",
    parameters: inputParameters.query, replay: "safe",
    execute: async (args, api, context) => {
      const requestId = await botForegroundRequest(api, api.callId, context);
      return output(works.transaction(() => {
      assertActive();
      const source = receipt(requestId);
      const input = query.parse(args);
      if (input.view === "detail" && !input.workId) throw new Error("完整详情必须指定 workId；概览请用 view:summary");
      if (input.workId && input.view !== "summary") {
        if (input.cursor || input.search || input.status || input.limit || input.deadlineFrom !== undefined || input.deadlineBefore !== undefined || input.needsUserInput !== undefined || input.sort) throw new Error("按 workId 读取详情时不要携带列表筛选或游标");
        if (!catalogue.canRead(input.workId)) {
          const delegation = catalogue.outgoingCollaboration(input.workId);
          if (!delegation) return [];
          const page = messages.collaborations.history(userId, { botId, collaborationId: delegation.collaborationId, limit: 30 });
          return [{ ...page.collaboration.work, workId: input.workId, ownerBotId: delegation.targetBotId,
            readOnly: true, delegation, collaboration: page.collaboration, messages: page.messages, events: page.events,
            totalMessages: page.totalMessages, hasMore: page.nextCursor !== null,
            nextQuery: page.nextCursor ? { action: "query", collaborationId: delegation.collaborationId, limit: 30, cursor: page.nextCursor } : null,
            controlRoute: { tool: "bot_collaborate", query: { action: "query", collaborationId: delegation.collaborationId },
              instructions: "这是原协作公开给你的摘要和成果，不包含对方私人执行记录。修改须先沿该 query 获取原协作 versionGuard；不能用普通 work_* 控制工具。" } }];
        }
        const work = works.getWork(input.workId)!;
        const versionGuard = { expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch };
        db.prepare(`INSERT INTO bot_work_reads(conversation_id,request_id,work_id,guard_json) VALUES (?,?,?,?)
          ON CONFLICT(conversation_id,request_id,work_id) DO UPDATE SET guard_json=excluded.guard_json`)
          .run(conversationId, source.request_id, work.workId, JSON.stringify(versionGuard));
        const projection = works.getProjection(work.workId);
        const visibleMessages = works.collaboration.list(actor(), work.workId);
        return [{ ...projection, methodFeedback: options.recordWorkFeedback?.(source, work), phase3: projection?.phase3 ? { ...projection.phase3,
          collaborationMessages: visibleMessages, handoffs: visibleMessages.filter(message => message.kind === "handoff") } : undefined,
          versionGuard }];
      }
      const legacy = Object.keys(input).length === 0;
      const page = catalogue.responsibilitiesPage(legacy ? { status: "all" } : input);
      const recordRead = db.prepare(`INSERT INTO bot_work_reads(conversation_id,request_id,work_id,guard_json) VALUES (?,?,?,?)
        ON CONFLICT(conversation_id,request_id,work_id) DO UPDATE SET guard_json=excluded.guard_json`);
      for (const item of page.items) if (!item.delegation || catalogue.canRead(item.workId))
        recordRead.run(conversationId, source.request_id, item.workId, JSON.stringify(item.versionGuard));
      if (!legacy) return page;
      // Preserve the old list's array shape. Metadata belongs to an item because
      // JSON.stringify ignores non-index properties attached to an Array.
      const { items, ...queryPage } = page;
      return items.map((item, index) => index === 0 ? { ...item, queryPage } : item);
    })); } }), ...mutations,
  defineTool({ name: "schedule_overview",
    description: "只读汇总当前用户/Bot 的“我的安排”：合并纯提醒(kind=reminder)、本人负责/参与/已委派的事项(kind=work)及尚无Work的协作(kind=collaboration)。支持status、search、workId、limit、cursor、sort及期限/待用户输入筛选；默认open、每页20项，按total/counts报告完整匹配数，hasMore时用nextQuery继续，不能把本页当全部。期限窗口和needsUserInput只筛Work事实，不把提醒时间或协作状态冒充Work期限/阻碍。团队和共享会话只读原有本范围。逐项说明具体时间或触发条件、实际会做什么、当前状态和结果回到哪里。提醒由 CronService 到期直接发已保存内容，不调用模型、不创建 Work；事项是真实后台执行。二者不会互相冒充：提醒没有工作模式，事项不是提醒。本工具不写库、不新建 Work、不新建调度器，只投影既有 Cron/Work/Watch 事实。宿主离线或休眠时不会到点执行/投递(hostMustBeRunning)，恢复后按各自补查策略处理；已登记安排不等于正在执行。用户问“明天有什么安排/提醒和跟进”时优先用本工具一次查询，不要用 work_query_status 逐项猜测，也不要为查安排创建 Work。",
    parameters: parameters(botScheduleOverviewQuerySchema), replay: "safe",
    execute: async (args, api, context) => {
      const input = botScheduleOverviewQuerySchema.parse(args);
      const requestId = await botForegroundRequest(api, api.callId, context);
      return output(options.db.transaction(() => {
        assertActive(); receipt(requestId);
        return botScheduleOverview({ db, works, catalogue, reminders: options.reminders, userId, botId,
          teamId: options.teamId, conversationId, now: Date.now }, input);
      }).deferred());
    } }),
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
  defineTool({ name: "work_team_create", description: "创建并启动团队：先查 work_team_templates；可省略 templateId，提供 taskAssignment 从 availableBots 自主选择适合本次委托的成员和依赖，宿主默认有界并行。也可复用模板内成员和上限。负责人保持当前 Bot，权限仅来自已有范围，目录来自 Bot 设置。title/goalDescription/criteria 是执行规划，宿主独立保留用户原文与附件。用户要求执行即可开工，无需再次确认。不要另调用 work_create 重复派发。持续委托必须传 requestedOutcome=ongoing 和 mode=watch：周期观察给 watchRule.cronExpression；若现在就有可执行步骤、之后才需等待，传 startImmediately=true ；确实需要等待时再给 watchRule.nextWakeAt 或真实 eventSource 安排跟进，不能创建once后文字承诺持续。每轮重新观察由成员执行、负责人汇总，默认等首次检查。成功后可用 work_query_status 查询成员进度，work_pause/resume/cancel 控制已有团队。",
    parameters: parameters(teamCreate), replay: "safe",
    execute: async (args, api, context) => {
      const { requestedOutcome, startImmediately, sourceMessageIds, ...input } = teamCreate.parse(args);
      validateWatchIntent(requestedOutcome, { ...input, startImmediately });
          if (input.watchRule?.eventSource && !works.ingress.availableEventSources().some(item => item.source === input.watchRule!.eventSource))
            throw new Error("此事件来源尚未接入；请查询work_watch_sources，明确说明只能定时检查并提供真实轮询时间，不要声称事件订阅成功");
          if (requestedOutcome === "ongoing" && startImmediately && !input.watchRule?.cronExpression && input.watchRule?.nextWakeAt === undefined && !input.watchRule?.eventSource)
            input.watchRule = { ...input.watchRule, executionMode: "continuous" };
      if (input.watchRule?.eventSource) throw new Error("团队事件订阅暂不支持，请创建个人事项或明确使用轮询");
      if (options.teamId && input.templateId && input.templateId !== options.teamId) throw new Error("不能向其他团队派发任务");
      if (options.teamId) input.templateId = options.teamId;
      const requestId = await botForegroundRequest(api, api.callId, context);
      const result = works.transaction(() => {
        assertActive();
        const source = receipt(requestId);
        if (messages.peers.origin(source.user_message_id)) throw new Error("个人 Bot 协作不创建临时团队；使用接收 Bot 自己的个人 Work");
        messages.validateWorkUserInput(source, sourceMessageIds);
        const workspacePath = input.templateId ? works.teams.resolveWorkspace(userId, input.templateId) : options.botWorkspace?.(botId, true);
        if (!workspacePath) throw new Error("当前 Bot 没有可用工作目录，请在 Bot 设置中指定文件夹");
        const result = works.teams.createFromForeground(actor(), { ...input,
          ...(input.mode === "watch" ? { watchRule: { ...input.watchRule, requestedOutcome } } : {}),
          operationId: `bot:${conversationId}:${options.requestNamespace ? `request:${options.requestNamespace}:` : ""}team:${api.taskId}`, workspacePath, conversationId, sourceMessageId: source.user_message_id });
        if (result.ok && result.work) {
          if (startImmediately && result.work.mode === "watch" && !result.replayed) {
            works.teams.requestImmediateWatch(result.work);
          }
          messages.linkWorkUserInput(source, result.work, sourceMessageIds);
          messages.linkWorkAttachments(source, result.work.workId, result.work.inputSnapshotId);
          messages.linkWork(source, result.work.workId);
          works.repo.linkConversation(result.work.workId, conversationId, "desktop", Date.now());
        }
        return result;
      });
      if (result.ok && result.work) options.wake(result.work.workId);
      return output(result);
    } }),
  defineTool({ name: "work_team_replan", description: "调整同一团队事项的剩余分工。先 work_query_status 读取当前团队、成果和 versionGuard，再查 work_team_templates 的候选成员。目标不变而原方法失败、需要换人或增加必要验证时直接调整计划，不用work_amend伪造用户改目标。用户真正修改目标时先work_amend，再调用本工具接续新分工。taskAssignment保留仍适用的职责和依赖，仅修改确需调整的部分；已完成且不受影响的成果继续复用，不重跑写入或发送。不创建新Work，不改变用户目标。",
    parameters: parameters(teamReplan), replay: "safe",
    execute: async (args, api, context) => {
      const input = teamReplan.parse(args);
      const requestId = await botForegroundRequest(api, api.callId, context);
      const result = works.transaction(() => {
        assertActive();
        const source = receipt(requestId);
        if (messages.peers.origin(source.user_message_id)) throw new Error("团队计划修订须来自负责人当前用户请求或宿主结果复核");
        const target = select(input.workId, source, "amend");
        if (target.ownerBotId !== botId || !works.teams.get(target.workId)) throw new Error("只能修订当前负责人已有团队的计划");
        const read = z.object({ guard_json: z.string() }).optional().parse(db.prepare(
          "SELECT guard_json FROM bot_work_reads WHERE conversation_id=? AND request_id=? AND work_id=?").get(conversationId, source.request_id, input.workId));
        if (read?.guard_json !== JSON.stringify(input.versionGuard)) throw new Error("请先查询团队 Work，并使用本回合读取的完整版本守卫");
        const revised = works.teams.replanFromForeground(actor(), { ...input,
          operationId: `bot-team-replan:${peerKey(source.user_message_id, String(api.taskId))}`,
          conversationId, sourceMessageId: source.user_message_id });
        if (revised.ok) messages.linkWork(source, target.workId);
        return revised;
      });
      if (result.ok) options.wake(input.workId);
      return output(result);
    } }),
  defineTool({ name: "memory_search", description: "查询当前对话可见记忆：本 Bot 或团队、本次会话，以及用户明确共享的公共记忆；不读其他 Bot 私人记忆。",
    parameters: inputParameters.memory, replay: "safe",
    execute: async args => { assertActive(); return output(await options.memorySearch(memory.parse(args).query)); } }),
  defineTool({ name: "memory_remember", description: "用户明确要求记住或更正一条事实/偏好时保存到宿主绑定范围。current是当前Bot专属或当前团队；仅本次对话的约束用conversation；只有用户明确说所有Bot共享时才用public。引用当前用户原话，成功后才能说已记住。不把临时要求保存为长期规则。",
    parameters: parameters(memoryRemember), replay: "safe",
    execute: async (args, api, context) => {
      assertActive();
      const input = memoryRemember.parse(args);
      const requestId = await botForegroundRequest(api, api.callId, context);
      const source = receipt(requestId);
      if (!options.memoryRemember) throw new Error("当前记忆保存服务不可用");
      const human = messages.userSource(source), userText = messages.message(human.user_message_id)!.text;
      if (messages.peers.origin(source.user_message_id) && !botMemoryDurableEvidence(userText, input.userEvidence))
        throw new Error("Bot 转述不能作为用户记忆证据，须原用户明确要求保存的真实原话");
      return output(options.memoryRemember(input, userText));
    } }),
  defineTool({ name: "memory_forget", description: "用户明确要求忘记时，先 memory_search 找到对应记录，再从当前Bot、团队或本次会话移除记忆；公共范围必须由用户明确说公共或所有Bot。必须提供当前用户要求忘记的原话。只在工具成功后说已忘记；不删除聊天历史，不创建 Work。",
    parameters: parameters(memoryForget), replay: "safe",
    execute: async (args, api, context) => {
      assertActive();
      const input = memoryForget.parse(args);
      const requestId = await botForegroundRequest(api, api.callId, context);
      const source = receipt(requestId);
      if (!options.memoryForget) throw new Error("当前记忆删除服务不可用");
      const human = messages.userSource(source), original = messages.message(human.user_message_id)!;
      return output(options.memoryForget(input.ids, original.text, input.userEvidence, { createdAt: original.createdAt, messageId: original.messageId }));
    } })];
}
