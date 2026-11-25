import { dotsGoogleAccounts, type DotsGoogleAccount, type DotsGoogleRules, type DotsGoogleSource } from "../../shared/dots-google";
import { DotsGoogleAccounts, DotsGoogleError, runDotsGoogle } from "./DotsGoogleAccounts";

export type DotsGoogleRead = { source: "gmail"; view?: "unread" | "recent" }
  | { source: "calendar"; from?: string; days?: number };

const limit = 8;
const object = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown) => Array.isArray(value) ? value.map(object) : [];
function label(value: unknown, fallback: string) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 240) || fallback : fallback;
}

function calendarRange(from: string | undefined, days: number, now: number) {
  const current = new Date(now);
  if (from) {
    const [year, month, day] = from.split("-").map(Number);
    current.setFullYear(year, month - 1, day);
    if (current.getFullYear() !== year || current.getMonth() !== month - 1 || current.getDate() !== day)
      throw new Error("请提供有效的日历日期。");
    current.setHours(0, 0, 0, 0);
  }
  const end = new Date(current);
  end.setDate(end.getDate() + days);
  return { timeMin: current.toISOString(), timeMax: end.toISOString() };
}

export class DotsGoogleReads {
  constructor(private readonly accounts: DotsGoogleAccounts, private readonly rules: () => DotsGoogleRules,
    private readonly run = runDotsGoogle) {}

  async read(input: DotsGoogleRead, requested: readonly DotsGoogleAccount[], now: number, signal?: AbortSignal) {
    const configured = this.rules()[input.source].accounts;
    const connected = dotsGoogleAccounts.filter(account => this.accounts.current(account));
    const accounts = requested.length ? requested : configured.length ? configured : connected;
    if (!accounts.length) return { source: input.source, accounts: [], message: "请在 Dots 设置 → 常驻能力 → Google 连接账号。" };
    const range = input.source === "calendar" ? calendarRange(input.from, input.days ?? 1, now) : undefined;
    const results = await Promise.all(accounts.map(async account => {
      const selected = this.accounts.current(account);
      if (!selected?.access[input.source].ready)
        return { account, status: "unavailable", message: selected?.access[input.source].message ?? "此账号还没有连接或授予读取权限。" };
      const query = (path: string[], params: Record<string, unknown>) => {
        signal?.throwIfAborted();
        return this.run(selected.directory, [...path, "--params", JSON.stringify(params)], { signal, timeoutMs: 15_000 });
      };
      try {
        const data = range ? await this.calendar(query, range) : await this.gmail(query, input.source === "gmail" && input.view === "recent");
        signal?.throwIfAborted();
        if (this.accounts.current(account)?.directory !== selected.directory)
          return { account, status: "unavailable", message: "查询期间账号连接已更换，请重试。" };
        return { account, status: "ok", ...data };
      } catch (error) {
        signal?.throwIfAborted();
        return { account, status: "error", message: error instanceof DotsGoogleError ? error.message : "Google 查询失败，请检查网络、授权和 gws。" };
      }
    }));
    return { source: input.source, checkedAt: now, ...(range ?? {}), accounts: results };
  }

  private async gmail(query: Query, recent: boolean) {
    const path = ["gmail", "users", "messages"];
    const found = await query([...path, "list"], { userId: "me", labelIds: recent ? ["INBOX"] : ["INBOX", "UNREAD"],
      maxResults: limit, fields: "messages(id),nextPageToken" });
    const refs = list(found.messages).slice(0, limit);
    const loaded = await Promise.all(refs.map(async ({ id }) => {
      if (typeof id !== "string" || !id) throw new DotsGoogleError("Gmail 返回了无效的邮件标识。");
      const data = await query([...path, "get"], { userId: "me", id, format: "metadata", metadataHeaders: ["From", "Subject", "Date"],
        fields: "internalDate,payload(headers(name,value))" });
      const headers = list(object(data.payload).headers);
      const header = (name: string) => headers.find(item => String(item.name).toLowerCase() === name)?.value;
      const internalDate = Number(data.internalDate);
      const time = internalDate > 0 && internalDate < 8.64e15 ? internalDate : Date.parse(String(header("date") ?? ""));
      return { from: label(header("from"), "未知发件人"), subject: label(header("subject"), "无主题"),
        receivedAt: Number.isFinite(time) ? new Date(time).toISOString() : undefined };
    }));
    return { items: loaded.sort((a, b) => (b.receivedAt ?? "").localeCompare(a.receivedAt ?? "")), more: Boolean(found.nextPageToken) };
  }

  private async calendar(query: Query, range: { timeMin: string; timeMax: string }) {
    const found = await query(["calendar", "events", "list"], { calendarId: "primary", ...range, singleEvents: true,
      orderBy: "startTime", maxResults: limit, fields: "items(summary,start(date,dateTime),end(date,dateTime)),nextPageToken" });
    return { items: list(found.items).slice(0, limit).map(event => {
      const start = object(event.start), end = object(event.end);
      return { title: label(event.summary, "无标题日程"), startsAt: start.dateTime ?? start.date, endsAt: end.dateTime ?? end.date, allDay: Boolean(start.date) };
    }), more: Boolean(found.nextPageToken) };
  }
}

type Query = (path: string[], params: Record<string, unknown>) => Promise<Record<string, unknown>>;
