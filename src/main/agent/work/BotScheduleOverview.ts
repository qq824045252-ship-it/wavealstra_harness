import type Database from "better-sqlite3";
import type { CronJobDto } from "../../../shared/agent-ipc";
import type { WorkSubscriptionDto } from "../../../shared/bot-work";
import type { CronService } from "../../cron/CronService";
import type { BotWorkQuery, BotWorkSummary } from "./BotWorkQuery";
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
  catalogue: Pick<BotWorkQuery, "page">;
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
  title: string;
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

export type ScheduleOverviewItem = ScheduleOverviewReminderItem | ScheduleOverviewWorkItem;

export interface BotScheduleOverviewResult {
  observedAt: number;
  readOnly: true;
  hostMustBeRunning: true;
  scope: { userId: string; botId: string; teamId: string | null };
  sources: { reminders: "scheduled" | "unavailable"; works: "open_works"; events: "work_subscriptions" };
  hostBoundary: string;
  counts: { reminders: number; onceWorks: number; watchWorks: number; eventSubscriptions: number; total: number };
  truncated: boolean;
  notices: string[];
  items: ScheduleOverviewItem[];
}

const OPEN_WORK_PAGE_SIZE = 50;
/** Bounded projection: a plan question must never scan/hydrate every Work. */
const OPEN_WORK_PAGE_LIMIT = 10;
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
  notices: string[]): ScheduleOverviewReminderItem[] {
  if (!cron) { notices.push("提醒服务尚未初始化；本投影未包含纯提醒安排。"); return []; }
  let jobs: CronJobDto[];
  try { jobs = cron.list(); }
  catch (error) {
    notices.push(`提醒列表读取失败；本投影未包含纯提醒（${error instanceof Error ? error.message : String(error)}）。`);
    return [];
  }
  return jobs.filter(job => job.reminder?.userId === deps.userId
    && (deps.teamId ? job.reminder.teamId === deps.teamId : job.reminder.botId === deps.botId && !job.reminder.teamId)
    // Delivered/cancelled reminders are history, not upcoming arrangements.
    && job.reminder.state !== "cancelled" && job.reminder.state !== "delivered")
    .map(job => {
      const reminder = job.reminder!;
      const nextAt = job.nextRunAt ?? null;
      const state = reminder.state ?? (job.enabled ? "scheduled" : "paused");
      return {
        kind: "reminder" as const, id: job.id, reminderId: job.id, title: job.name,
        content: job.prompt.slice(0, REMINDER_CONTENT_LIMIT), enabled: job.enabled, state,
        deliveredCount: job.runCount ?? 0, timing: reminderTiming(job, nextAt),
        // A reminder writes the saved text at the due time; it never runs a model
        // or creates a Work, so it must not be described as background execution.
        whatWillHappen: `到时直接把已保存内容「${job.name}」发到本机对话；不调用模型、不创建 Work。`,
        status: job.enabled ? (state === "scheduled" ? "已安排" : state) : "已暂停",
        resultReturnsTo: { conversationId: reminder.conversationId, label: "本机应用内该提醒所属对话；到期直接写入消息" },
        hostMustBeRunning: true as const,
        deliveryBoundary: `本机应用内投递（${nextAt === null ? "当前没有下一次" : localTime(nextAt, job.timezone) ?? new Date(nextAt).toISOString()}）；宿主退出或休眠期间无法准时弹出，恢复后合并补发。`,
      };
    })
    .sort((a, b) => (a.timing.nextAt ?? Number.MAX_SAFE_INTEGER) - (b.timing.nextAt ?? Number.MAX_SAFE_INTEGER)
      || a.reminderId.localeCompare(b.reminderId));
}

function openWorkPage(catalogue: Pick<BotWorkQuery, "page">) {
  const items: BotWorkSummary[] = [];
  let query: Parameters<BotWorkQuery["page"]>[0] = { status: "open", limit: OPEN_WORK_PAGE_SIZE };
  let total = 0;
  for (let page = 0; page < OPEN_WORK_PAGE_LIMIT; page++) {
    const result = catalogue.page(query);
    total = result.total;
    items.push(...result.items);
    if (!result.hasMore || !result.nextQuery) return { items, total, truncated: false };
    query = result.nextQuery;
  }
  return { items, total, truncated: items.length < total };
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
    kind: "work", id: summary.workId, workId: summary.workId, title: summary.title, workMode: summary.mode,
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

export function botScheduleOverview(deps: ScheduleOverviewDependencies): BotScheduleOverviewResult {
  const now = deps.now ? deps.now() : Date.now();
  const notices: string[] = [];
  const cron = deps.reminders?.();
  const reminderList = reminderItems(cron, deps, notices);
  const page = openWorkPage(deps.catalogue);
  if (page.truncated)
    notices.push(`未结束事项共 ${page.total} 项，本投影只读取了最近 ${page.items.length} 项；更早安排请用 work_query_status 分页查询。`);
  const items: ScheduleOverviewItem[] = [
    ...reminderList,
    ...page.items.map(summary => workItem(deps, summary, deps.conversationId)),
  ].sort((a, b) => (a.timing.nextAt ?? Number.MAX_SAFE_INTEGER) - (b.timing.nextAt ?? Number.MAX_SAFE_INTEGER)
    || (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === "reminder" ? -1 : 1));
  const onceWorks = page.items.filter(item => item.mode === "once").length;
  const watchWorks = page.items.filter(item => item.mode === "watch").length;
  const eventSubscriptions = items.reduce((sum, item) => sum + (item.kind === "work" ? item.eventSubscriptions.length : 0), 0);
  return {
    observedAt: now, readOnly: true, hostMustBeRunning: true,
    scope: { userId: deps.userId, botId: deps.botId, teamId: deps.teamId ?? null },
    sources: { reminders: cron ? "scheduled" : "unavailable", works: "open_works", events: "work_subscriptions" },
    hostBoundary: "所有提醒与事项调度都依赖本机宿主在线：宿主退出或系统休眠期间不会到点执行/投递，恢复后按各自补查策略处理；已登记安排不等于正在执行。",
    counts: { reminders: reminderList.length, onceWorks, watchWorks, eventSubscriptions, total: items.length },
    truncated: page.truncated, notices, items,
  };
}