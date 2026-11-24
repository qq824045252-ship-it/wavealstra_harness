import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dotsGoogleAccounts, dotsGoogleSources, type DotsGoogleAccount, type DotsGoogleRule, type DotsGoogleRules,
  type DotsGoogleSource, type DotsGoogleStatus } from "../../shared/dots-google";
import { atomicWriteJson } from "../task/TaskExecutionWorkspace";
import { DotsGoogleAccounts, DotsGoogleError, runDotsGoogle } from "./DotsGoogleAccounts";

interface Reminder { id: string; title: string; dueAt: number; endAt: number; startsAt: number; allDay: boolean }
interface ScanState {
  stamp?: string;
  nextAt?: number;
  checkedAt?: number;
  message?: string;
  cursor?: string;
  events?: Reminder[];
  delivered?: Record<string, number>;
}
interface Notice { key: string; title: string; body: string }
const minute = 60_000;
const day = 86_400_000;
const accountLabel = { personal: "个人", company: "公司" } as const;

export function nextDotsGoogleCheck(rule: DotsGoogleRule, now: number): number {
  if (rule.mode === "interval") return now + rule.intervalMinutes * minute;
  const [hour, min] = rule.dailyTime.split(":").map(Number);
  const date = new Date(now);
  date.setHours(hour, min, 0, 0);
  if (date.getTime() <= now) {
    date.setDate(date.getDate() + 1);
    date.setHours(hour, min, 0, 0);
  }
  return date.getTime();
}

type PageRequest = (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
async function readPages(request: PageRequest, params: Record<string, unknown>,
  visit: (page: Record<string, unknown>) => void) {
  let pageToken: string | undefined;
  const visited = new Set<string>();
  do {
    const page = await request(pageToken ? { ...params, pageToken } : params);
    visit(page);
    pageToken = typeof page.nextPageToken === "string" ? page.nextPageToken : undefined;
    if (!pageToken) return;
    if (visited.has(pageToken) || visited.size >= 49)
      throw new DotsGoogleError("Google 查询结果过多或分页异常，已保留上次检查进度。");
    visited.add(pageToken);
  } while (pageToken);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DotsGoogleError("Google 返回的数据格式无效。");
  return value as Record<string, unknown>;
}

function rows(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new DotsGoogleError("Google 返回的数据列表无效。");
  return value;
}

const formatTime = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

function reminder(value: unknown): Reminder | undefined {
  const item = record(value);
  const start = record(item.start);
  const end = record(item.end);
  const allDay = typeof start.date === "string";
  const startsAt = Date.parse(allDay ? `${start.date}T09:00:00` : String(start.dateTime));
  const endAt = Date.parse(allDay ? `${end.date}T00:00:00` : String(end.dateTime));
  if (typeof item.id !== "string" || !Number.isFinite(startsAt) || !Number.isFinite(endAt) || endAt <= startsAt) return;
  return {
    id: `${item.id}:${startsAt}`, title: typeof item.summary === "string" ? item.summary.slice(0, 160) : "无标题日程",
    startsAt, endAt, allDay, dueAt: startsAt - (allDay ? 0 : 30 * minute),
  };
}

export class DotsGoogleMonitor {
  private timer?: ReturnType<typeof setInterval>;
  private readonly active = new Map<string, AbortController>();

  constructor(
    private readonly accounts: DotsGoogleAccounts,
    private readonly rules: () => DotsGoogleRules,
    private readonly paused: () => boolean,
    private readonly deliver: (notice: Notice) => void,
    private readonly run = runDotsGoogle,
    private readonly now = Date.now,
  ) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.refresh(), 15_000);
    this.timer.unref();
    this.refresh();
  }

  close() {
    clearInterval(this.timer);
    this.timer = undefined;
    for (const controller of this.active.values()) controller.abort();
  }

  private statePath(directory: string, source: DotsGoogleSource) { return join(directory, source + "-watch.json"); }

  private state(directory: string, source: DotsGoogleSource): ScanState {
    try { return JSON.parse(readFileSync(this.statePath(directory, source), "utf8")) as ScanState; }
    catch { return {}; }
  }

  status(): DotsGoogleStatus["sources"] {
    const status: DotsGoogleStatus["sources"] = { gmail: {}, calendar: {} };
    const rules = this.rules();
    for (const source of dotsGoogleSources) {
      for (const account of rules[source].accounts) {
        const current = this.accounts.current(account);
        if (!current) continue;
        const { checkedAt, nextAt, message } = this.state(current.directory, source);
        status[source][account] = { checkedAt, nextAt, message };
      }
    }
    return status;
  }

  refresh() {
    if (!this.timer || this.paused()) return;
    const rules = this.rules();
    for (const source of dotsGoogleSources) {
      const rule = rules[source];
      for (const account of dotsGoogleAccounts) {
        if (!rule.accounts.includes(account)) continue;
        const connection = this.accounts.current(account);
        if (!connection?.access[source].ready) continue;
        const key = `${account}:${source}`;
        if (this.active.has(key)) continue;
        const controller = new AbortController();
        this.active.set(key, controller);
        void this.scan(account, source, rule, connection.directory, controller.signal)
          .catch(() => undefined)
          .finally(() => this.active.delete(key));
      }
    }
  }

  private async scan(account: DotsGoogleAccount, source: DotsGoogleSource, rule: DotsGoogleRule, directory: string, signal: AbortSignal) {
    const stamp = JSON.stringify(rule);
    const current = () => !signal.aborted && !this.paused() && this.accounts.current(account)?.directory === directory
      && JSON.stringify(this.rules()[source]) === stamp;
    const now = this.now();
    const file = this.statePath(directory, source);
    const state = this.state(directory, source);
    const query = (args: string[], params: Record<string, unknown>) =>
      this.run(directory, [...args, "--params", JSON.stringify(params)], { signal });
    if (state.stamp !== stamp || state.nextAt === undefined || state.nextAt <= now) {
      try {
        if (source === "gmail") {
          const gmail = await this.scanGmail(query, state, now);
          if (!current()) return;
          if (gmail.count) this.deliver({
            key: `dots-google:${directory}:gmail:${state.cursor}`, title: `Dots · ${accountLabel[account]}邮箱`,
            body: `收件箱有 ${gmail.count} 封新邮件。`,
          });
          state.cursor = gmail.cursor;
        } else {
          const events = await this.scanCalendar(query, now);
          if (!current()) return;
          state.events = events;
        }
        state.checkedAt = now;
        state.nextAt = nextDotsGoogleCheck(rule, now);
        state.message = undefined;
      } catch (error) {
        if (!current()) return;
        state.nextAt = Math.min(nextDotsGoogleCheck(rule, now), now + 5 * minute);
        state.message = error instanceof DotsGoogleError ? error.message : "检查失败，将稍后重试。";
      }
      state.stamp = stamp;
      atomicWriteJson(file, state);
    }
    if (source === "calendar" && current() && !state.message) this.deliverCalendar(file, state, account, directory, now);
  }

  private async scanGmail(query: (args: string[], params: Record<string, unknown>) => Promise<Record<string, unknown>>,
    state: ScanState, now: number) {
    const profile = async () => {
      const value = await query(["gmail", "users", "getProfile"], { userId: "me", fields: "historyId" });
      if (typeof value.historyId !== "string" || !/^\d+$/.test(value.historyId)) throw new DotsGoogleError("Gmail 同步回执无效。");
      return value.historyId;
    };
    if (!state.cursor) return { cursor: await profile(), count: 0 };
    let cursor: string | undefined;
    const ids = new Set<string>();
    try {
      await readPages(params => query(["gmail", "users", "history", "list"], params),
        { userId: "me", startHistoryId: state.cursor, labelId: "INBOX", historyTypes: ["messageAdded"],
          fields: "historyId,nextPageToken,history(messagesAdded(message(id)))" }, page => {
          if (typeof page.historyId === "string" && /^\d+$/.test(page.historyId)) cursor = page.historyId;
          for (const entry of rows(page.history)) for (const added of rows(record(entry).messagesAdded)) {
            const id = record(record(added).message).id;
            if (typeof id === "string") ids.add(id);
          }
        });
    } catch (error) {
      if (!(error instanceof DotsGoogleError) || error.status !== 404) throw error;
      const baseline = await profile();
      const after = Math.floor((state.checkedAt ?? now) / 1000);
      ids.clear();
      await readPages(params => query(["gmail", "users", "messages", "list"], params),
        { userId: "me", labelIds: ["INBOX"], q: `after:${after} before:${Math.ceil(now / 1000)}`, fields: "messages(id),nextPageToken" }, page => {
          for (const entry of rows(page.messages)) {
            const id = record(entry).id;
            if (typeof id === "string") ids.add(id);
          }
        });
      return { cursor: baseline, count: ids.size };
    }
    if (!cursor) throw new DotsGoogleError("Gmail 同步回执缺少检查进度。");
    return { cursor, count: ids.size };
  }

  private async scanCalendar(query: (args: string[], params: Record<string, unknown>) => Promise<Record<string, unknown>>, now: number) {
    const events: Reminder[] = [];
    await readPages(params => query(["calendar", "events", "list"], params),
      { calendarId: "primary", timeMin: new Date(now).toISOString(), timeMax: new Date(now + 2 * day).toISOString(),
        singleEvents: true, showDeleted: false, fields: "nextPageToken,items(id,summary,start,end)" }, page => {
        for (const value of rows(page.items)) {
          const event = reminder(value);
          if (event) events.push(event);
        }
      });
    return events;
  }

  private deliverCalendar(file: string, state: ScanState, account: DotsGoogleAccount, directory: string, now: number) {
    const delivered = Object.fromEntries(Object.entries(state.delivered ?? {}).filter(([, end]) => end > now - day));
    const due = state.events?.filter(event => event.dueAt <= now && (event.allDay ? event.endAt : event.startsAt) > now && !delivered[event.id]) ?? [];
    if (!due.length) return;
    for (const event of due) {
      this.deliver({
        key: `dots-google:${directory}:calendar:${event.id}`, title: `Dots · ${accountLabel[account]}日历`,
        body: event.allDay ? `今天 · ${event.title}` : `${formatTime.format(event.startsAt)} · ${event.title}`,
      });
      delivered[event.id] = event.endAt;
    }
    atomicWriteJson(file, { ...state, delivered });
  }
}
