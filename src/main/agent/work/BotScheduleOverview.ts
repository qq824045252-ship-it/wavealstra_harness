import type Database from "better-sqlite3";
import type { CronJobDto } from "../../../shared/agent-ipc";
import type { WorkSubscriptionDto } from "../../../shared/bot-work";
import type { CronService } from "../../cron/CronService";
import { botWorkQuerySchema, type BotWorkQuery, type BotWorkSummary } from "./BotWorkQuery";
import type { z } from "zod";
import type { WorkService } from "./WorkService";
import type { WorkSubscriptionCursor } from "./WorkWatchIngress";

/**
 * Read-only "我的安排" projection (issue #27 §6).
 *
 * Reminders stay in CronService and Works/Watch stay in the Work truth store;
 * this module only merges the facts those authorities already persist. It never
 * writes, never schedules, and never turns a reminder into a Work (or the
 * reverse): each item keeps an explicit `kind` and only its own identity keys.
 */

export interface ScheduleOverviewDependencies {
  /** Read-only source facts for watch notification policy. */
  db: Pick<Database.Database, "prepare">;
  works: {
    repo: Pick<WorkService["repo"], "listSubscriptions" | "listConversationIds">;
    ingress: Pick<WorkService["ingress"], "listCursors" | "adapter">;
  };
  catalogue: Pick<BotWorkQuery, "responsibilitiesPage" | "overviewPage" | "reminderConversationAllowed">;
  reminders?: () => CronService | undefined;
  userId: string;
  botId: string;
  teamId?: string;
  conversationId: string;
  now?: () => number;
}

export interface ScheduleOverviewTiming {
  kind: "at" | "every" | "cron" | "next_wake" | "deadline" | "event" | "none";
  expression: string | null;
  timezone: string | null;
  nextAt: number | null;
  nextAtIso: string | null;
  nextAtLocal: string | null;
  trigger: string;
}

export interface ScheduleOverviewReminderItem {
  kind: "reminder";
  id: string;
  reminderId: string;
  title: string;
  createdAt: number;
  content: string;
  enabled: boolean;
  state: string;
  deliveredCount: number;
  timing: ScheduleOverviewTiming;
  whatWillHappen: string;
  status: string;
  resultReturnsTo: { conversationId: string; label: string };
  hostMustBeRunning: true;
  deliveryBoundary: string;
}

export interface ScheduleOverviewEventSubscription {
  subscriptionId: string;
  source: string;
  targetKey: string;
  nextWakeAt: number | null;
  registeredSource: boolean;
  namespace: string | null;
  versionMode: string | null;
  canQueryHistory: boolean | null;
  cursors: Array<{ source: string; targetKey: string; highestAcceptedVersion: string | null;
    highestConsumedVersion: string | null; highestFrozenVersion: string | null;
    acceptedEvents: number; consumedEvents: number }>;
  trigger: string;
}

export interface ScheduleOverviewWorkItem {
  kind: "work";
  id: string;
  workId: string;
  collaborationId?: string;
  title: string;
  delegation?: BotWorkSummary["delegation"];
  workMode: "once" | "watch";
  lifecycle: BotWorkSummary["lifecycle"];
  notificationMode: "every_check" | "changes_only" | null;
  notifyInitial: boolean | null;
  stopConditionText: string | null;
  terminationReason: string | null;
  deadlineAt: number | null;
  timing: ScheduleOverviewTiming;
  eventSubscriptions: ScheduleOverviewEventSubscription[];
  whatWillHappen: string;
  status: BotWorkSummary["tracking"]["state"];
  statusDetail: string;
  statusReason: string | null;
  needsUserInput: boolean;
  openBlockerCount: number;
  latestProgress: string | null;
  resultReturnsTo: { conversationIds: string[]; currentConversation: boolean; label: string };
  hostMustBeRunning: true;
  deliveryBoundary: string;
}

export interface ScheduleOverviewCollaborationItem {
  kind: "collaboration";
  id: string;
  collaborationId: string;
  title: string;
  createdAt: number;
  targetBotId: string;
  targetDisplayName: string;
  status: string;
  statusSource: "collaboration_receipt";
  observedAt: number;
  needsUserInput: null;
  scopeChanged: boolean;
  requestPreview: string | null;
  replyPreview: string | null;
  statusDetail: string;
  resultReturnsTo: { conversationId: string; currentConversation: boolean };
  controlRoute: "bot_collaborate";
}
export type ScheduleOverviewItem = ScheduleOverviewReminderItem | ScheduleOverviewWorkItem | ScheduleOverviewCollaborationItem;
export const botScheduleOverviewQuerySchema = botWorkQuerySchema.omit({ view: true }).extend({
  status: botWorkQuerySchema.shape.status.describe("open/all合并各类安排；active/paused/closing/closed仅筛选Work生命周期，不代表协作回执或提醒状态。暂停提醒请用reminder_manage查询。"),
});
export type BotScheduleOverviewQuery = z.infer<typeof botScheduleOverviewQuerySchema>;

export interface BotScheduleOverviewResult {
  observedAt: number;
  readOnly: true;
  hostMustBeRunning: true;
  scope: { userId: string; botId: string; teamId: string | null };
  sources: { reminders: "scheduled" | "unavailable"; works: "responsibilities"; events: "work_subscriptions" };
  hostBoundary: string;
  counts: { reminders: number; onceWorks: number; watchWorks: number; collaborations: number; eventSubscriptions: number; total: number };
  total: number;
  limit: number;
  hasMore: boolean;
  nextCursor: string | null;
  nextQuery: BotScheduleOverviewQuery | null;
  order: string;
  truncated: boolean;
  notices: string[];
  items: ScheduleOverviewItem[];
}

const REMINDER_CONTENT_LIMIT = 500;
const PROGRESS_LIMIT = 400;
const EVENT_SOURCE_LIMIT = 8;

function localTime(at: number | null, timezone?: string | null): string | null {
  if (at === null || !Number.isFinite(at)) return null;
  try {
    return new Intl.DateTimeFormat("zh-CN", { ...(timezone ? { timeZone: timezone } : {}),
      dateStyle: "full", timeStyle: "long" }).format(at);
  } catch {
    // An unparseable historical timezone must not hide the exact instant.
    return new Date(at).toISOString();
  }
}

function timing(kind: ScheduleOverviewTiming["kind"], at: number | null, trigger: string,
  expression: string | null = null, timezone: string | null = null): ScheduleOverviewTiming {
  return { kind, expression, timezone, nextAt: at, nextAtIso: at === null ? null : new Date(at).toISOString(),
    nextAtLocal: localTime(at, timezone), trigger };
}

function reminderTiming(job: CronJobDto, nextAt: number | null): ScheduleOverviewTiming {
  const kind = job.scheduleType === "at" ? "at" : job.scheduleType === "every" ? "every" : "cron";
  const local = localTime(nextAt, job.timezone);
  const when = local ? `（${local}）` : "";
  const trigger = job.scheduleType === "at" ? `到 ${nextAt === null ? "已取消" : local ?? job.scheduleExpr} 直接发送`
    : job.scheduleType === "every" ? `每 ${job.scheduleExpr} 直接发送${when}`
    : `按 cron「${job.scheduleExpr}」直接发送${when}`;
  return timing(kind, nextAt, trigger, job.scheduleExpr, job.timezone);
}

function reminderItems(cron: CronService | undefined, deps: ScheduleOverviewDependencies,
  notices: string[]): Array<ScheduleOverviewReminderItem & { searchTitle: string; searchContent: string }> {
  if (!cron) { notices.push("提醒服务尚未初始化；本投影未包含纯提醒安排。"); return []; }
  let jobs: CronJobDto[];
  try { jobs = cron.list(); }
  catch (error) {
    notices.push(`提醒列表读取失败；本投影未包含纯提醒（${error instanceof Error ? error.message : String(error)}）。`);
    return [];
  }
  return jobs.filter(job => job.reminder?.userId === deps.userId
    && (deps.teamId ? job.reminder.teamId === deps.teamId : job.reminder.botId === deps.botId && !job.reminder.teamId)
    && deps.catalogue.reminderConversationAllowed(job.reminder.conversationId))
    .map(job => {
      const reminder = job.reminder!;
      const nextAt = job.nextRunAt ?? null;
      const state = reminder.state ?? (job.enabled ? "scheduled" : "paused");
      return {
        kind: "reminder" as const, id: job.id, reminderId: job.id, title: job.name.slice(0, 200), createdAt: job.createdAt,
        searchTitle: job.name, searchContent: job.prompt,
        content: job.prompt.slice(0, REMINDER_CONTENT_LIMIT), enabled: job.enabled, state,
        deliveredCount: job.runCount ?? 0, timing: reminderTiming(job, nextAt),
        // A reminder writes the saved text at the due time; it never runs a model
        // or creates a Work, so it must not be described as background execution.
        whatWillHappen: `到时直接把已保存内容「${job.name.slice(0, 200)}」发到本机对话；不调用模型、不创建 Work。`,
        status: job.enabled ? (state === "scheduled" ? "已安排" : state) : "已暂停",
        resultReturnsTo: { conversationId: reminder.conversationId, label: "本机应用内该提醒所属对话；到期直接写入消息" },
        hostMustBeRunning: true as const,
        deliveryBoundary: `本机应用内投递（${nextAt === null ? "当前没有下一次" : localTime(nextAt, job.timezone) ?? new Date(nextAt).toISOString()}）；宿主退出或休眠期间无法准时弹出，恢复后合并补发。`,
      };
    })
    .sort((a, b) => (a.timing.nextAt ?? Number.MAX_SAFE_INTEGER) - (b.timing.nextAt ?? Number.MAX_SAFE_INTEGER)
      || a.reminderId.localeCompare(b.reminderId));
}

interface WatchFacts { notificationMode: "every_check" | "changes_only" | null; notifyInitial: boolean | null; terminationReason: string | null }

function watchFacts(deps: ScheduleOverviewDependencies, workId: string): WatchFacts {
  const row = deps.db.prepare(`SELECT json_extract(watch_rule_json,'$.notificationMode') notificationMode,
    json_extract(watch_rule_json,'$.notifyInitial') notifyInitial,
    json_extract(watch_rule_json,'$.termination.reason') terminationReason
    FROM works WHERE work_id=?`).get(workId) as { notificationMode: string | null; notifyInitial: number | null;
      terminationReason: string | null } | undefined;
  const mode = row?.notificationMode === "changes_only" ? "changes_only"
    : row?.notificationMode === "every_check" ? "every_check" : null;
  return { notificationMode: mode, notifyInitial: row?.notifyInitial === null || row?.notifyInitial === undefined
    ? null : Boolean(row.notifyInitial), terminationReason: row?.terminationReason ?? null };
}

function eventSubscription(deps: ScheduleOverviewDependencies, subscription: WorkSubscriptionDto): ScheduleOverviewEventSubscription {
  const adapter = deps.works.ingress.adapter(subscription.source);
  let cursors: WorkSubscriptionCursor[] = [];
  try { cursors = deps.works.ingress.listCursors(subscription.subscriptionId); } catch { cursors = []; }
  const targetKey = subscription.sourceTarget ?? cursors[0]?.targetKey ?? "default";
  const mapped = cursors.slice(0, EVENT_SOURCE_LIMIT).map(cursor => ({
    source: cursor.source, targetKey: cursor.targetKey,
    highestAcceptedVersion: cursor.highestAcceptedVersion ?? null,
    highestConsumedVersion: cursor.highestConsumedVersion ?? null,
    highestFrozenVersion: cursor.highestFrozenVersion ?? null,
    acceptedEvents: cursor.acceptedEvents, consumedEvents: cursor.consumedEvents,
  }));
  const watermark = mapped.find(item => item.targetKey === targetKey) ?? mapped[0];
  const versionText = watermark?.highestConsumedVersion ?? watermark?.highestAcceptedVersion;
  return {
    subscriptionId: subscription.subscriptionId, source: subscription.source, targetKey,
    nextWakeAt: subscription.nextWakeAt ?? null, registeredSource: Boolean(adapter),
    namespace: adapter?.namespace ?? null, versionMode: adapter?.versionMode ?? null,
    canQueryHistory: adapter?.canQueryHistory ?? null, cursors: mapped,
    trigger: `来源「${subscription.source}」的目标「${targetKey}」出现新事件后触发${versionText ? `（当前已消费版本水位：${versionText}）` : ""}；来源不支持推送时由宿主按计划轮询检查，读取失败不会当作无变化。`,
  };
}

function workItem(deps: ScheduleOverviewDependencies, summary: BotWorkSummary, currentConversation: string): ScheduleOverviewWorkItem {
  const subscriptions = deps.works.repo.listSubscriptions(summary.workId);
  const events = subscriptions.filter(subscription => subscription.source !== "cron").map(subscription => eventSubscription(deps, subscription));
  const cronSubscription = subscriptions.find(subscription => subscription.source === "cron");
  const facts = watchFacts(deps, summary.workId);
  const cronExpression = summary.watchRule?.cronExpression ?? cronSubscription?.cronExpression ?? null;
  const timezone = summary.watchRule?.timezone ?? cronSubscription?.timezone ?? null;
  const nextWakeAt = summary.nextWakeAt;
  const deadlineAt = summary.deadlineAt;
  let workTiming: ScheduleOverviewTiming;
  if (summary.mode === "watch" && cronExpression) {
    workTiming = timing("cron", nextWakeAt, `按 cron「${cronExpression}」（${timezone ?? "宿主机时区"}）到点检查`, cronExpression, timezone);
  } else if (nextWakeAt !== null) {
    workTiming = timing("next_wake", nextWakeAt, `到 ${localTime(nextWakeAt, timezone) ?? new Date(nextWakeAt).toISOString()} 检查/跟进一次`, null, timezone);
  } else if (summary.mode === "watch" && events.length) {
    workTiming = timing("event", null, events[0]!.trigger);
  } else if (summary.mode === "once" && deadlineAt !== null) {
    workTiming = timing("deadline", deadlineAt, `承诺期限 ${localTime(deadlineAt) ?? new Date(deadlineAt).toISOString()} 到期后只读跟进；期限不是自动取消`);
  } else {
    workTiming = timing("none", null, "已受理，等待后台执行；没有独立定时或事件触发。");
  }
  const conversationIds = deps.works.repo.listConversationIds(summary.workId);
  const notificationMode = summary.mode === "watch" ? facts.notificationMode : null;
  const action = summary.mode === "watch"
    ? `按已保存安排重新检查/观察并汇报实际结果${notificationMode === "changes_only" ? "；仅在本轮来源证据变化时通知，无变化保持安静" : "；每轮汇报"}`
    : "在后台真实执行并回报实际结果；不是只发一条提醒";
  const stop = summary.mode === "watch" ? summary.watchRule?.stopConditionText ?? null : null;
  return {
    kind: "work", id: summary.workId, workId: summary.workId, title: summary.title, workMode: summary.mode, delegation: summary.delegation,
    lifecycle: summary.lifecycle, notificationMode, notifyInitial: summary.mode === "watch" ? facts.notifyInitial : null,
    stopConditionText: stop, terminationReason: facts.terminationReason, deadlineAt,
    timing: workTiming, eventSubscriptions: events,
    whatWillHappen: `${action}${stop ? `；结束条件：${stop}` : ""}`,
    status: summary.tracking.state, statusDetail: summary.tracking.nextStep,
    statusReason: summary.tracking.reason, needsUserInput: summary.needsUserInput,
    openBlockerCount: summary.openBlockerCount,
    latestProgress: summary.progressSummary?.slice(0, PROGRESS_LIMIT) ?? summary.latestDeliverableSummary?.slice(0, PROGRESS_LIMIT) ?? null,
    resultReturnsTo: { conversationIds, currentConversation: conversationIds.includes(currentConversation),
      label: conversationIds.length ? (conversationIds.includes(currentConversation) ? "当前对话（同一事项会话）" : "事项原会话")
        : "事项详情页；尚未登记原会话" },
    hostMustBeRunning: true as const,
    deliveryBoundary: "结果回到原事项会话；宿主退出或休眠期间不会到点执行/投递，恢复后按已保存的补查策略处理。已安排不等于正在执行。",
  };
}

export function botScheduleOverview(deps: ScheduleOverviewDependencies, query: BotScheduleOverviewQuery = {}): BotScheduleOverviewResult {
  const input = botScheduleOverviewQuerySchema.parse(query);
  const now = deps.now ? deps.now() : Date.now();
  const notices: string[] = [];
  const cron = deps.reminders?.();
  const reminderList = reminderItems(cron, deps, notices);
  const page = deps.catalogue.overviewPage(input, reminderList.map(item => ({ reminderId: item.reminderId,
    title: item.searchTitle, content: item.searchContent, createdAt: item.createdAt, state: item.state })));
  if (page.hasMore) notices.push(`符合筛选的安排共 ${page.total} 项；本页 ${page.references.length} 项，请使用 nextQuery 继续读取。`);
  if (input.deadlineFrom !== undefined || input.deadlineBefore !== undefined || input.needsUserInput !== undefined)
    notices.push("期限和待用户输入筛选仅依据 Work 的已保存事实；提醒时间不是承诺期限，尚无可读 Work 的协作不推测这些字段。");
  const items = page.references.map((reference): ScheduleOverviewItem => {
    if (reference.kind === "work") {
      const summary = deps.catalogue.responsibilitiesPage({ workId: reference.workId, status: "all", limit: 1 }).items[0];
      if (!summary) throw new Error("事项范围已变化，请重新查询第一页");
      const item = workItem(deps, summary, deps.conversationId);
      if (summary.delegation) item.resultReturnsTo = { conversationIds: [summary.delegation.sourceConversationId],
        currentConversation: summary.delegation.sourceConversationId === deps.conversationId, label: "协作成果回到原发起对话" };
      return { ...item, id: reference.id, collaborationId: reference.collaborationId ?? undefined };
    }
    if (reference.kind === "reminder") {
      const reminder = reminderList.find(item => `reminder:${item.reminderId}` === reference.id);
      if (!reminder) throw new Error("提醒范围已变化，请重新查询第一页");
      const { searchTitle: _title, searchContent: _content, ...item } = reminder;
      return { ...item, id: reference.id };
    }
    return { kind: "collaboration", id: reference.id, collaborationId: reference.collaborationId,
      title: reference.title, createdAt: reference.createdAt, targetBotId: reference.targetBotId, targetDisplayName: reference.targetDisplayName,
      status: reference.state, statusSource: "collaboration_receipt", observedAt: now, needsUserInput: null,
      scopeChanged: Boolean(reference.scopeChanged), requestPreview: reference.requestPreview, replyPreview: reference.replyPreview,
      statusDetail: reference.scopeChanged ? "原关联事项的负责人或可读范围已变化，保留协作记录；请沿原协作核对，未读取新负责人的事项详情。"
        : "这是实际协作送达或回流状态，尚无可读 Work；回执不代表用户目标已经完成。",
      resultReturnsTo: { conversationId: reference.sourceConversationId, currentConversation: reference.sourceConversationId === deps.conversationId },
      controlRoute: "bot_collaborate" };
  });
  return {
    observedAt: now, readOnly: true, hostMustBeRunning: true,
    scope: { userId: deps.userId, botId: deps.botId, teamId: deps.teamId ?? null },
    sources: { reminders: cron ? "scheduled" : "unavailable", works: "responsibilities", events: "work_subscriptions" },
    hostBoundary: "所有提醒与事项调度都依赖本机宿主在线：宿主退出或系统休眠期间不会到点执行/投递，恢复后按各自补查策略处理；已登记安排不等于正在执行。",
    counts: page.counts, total: page.total, limit: page.limit, hasMore: page.hasMore, nextCursor: page.nextCursor,
    nextQuery: page.nextQuery, order: page.order, truncated: page.hasMore, notices, items,
  };
}
