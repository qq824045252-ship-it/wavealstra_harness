export type DiscoveryMode = "interval" | "daily" | "new" | "random";
export interface DiscoverySchedule {
  mode: DiscoveryMode;
  minutes: number;
  time: string;
  windowStart: string;
  windowEnd: string;
}
export interface RssSubscription { id: string; name: string; url: string; enabled: boolean; schedule: DiscoverySchedule }
export interface DreamTag { id: string; name: string; query: string; enabled: boolean }
export interface DreamSettings { enabled: boolean; useMemory: boolean; schedule: DiscoverySchedule; tags: DreamTag[] }
export interface DiscoveryItem { title: string; url: string; summary?: string }
export interface DiscoveryStatus {
  checkedAt?: number;
  nextAt?: number;
  message?: string;
  running?: boolean;
  pending?: number;
  newItems?: number;
  recent?: DiscoveryItem[];
}
export interface DotsDiscoveryStatus { rss: Record<string, DiscoveryStatus>; dream: DiscoveryStatus }
export interface DotsDiscoveryApi {
  status(): Promise<DotsDiscoveryStatus>;
  run(kind: "rss" | "dream", id?: string): Promise<DotsDiscoveryStatus>;
  suggestTags(): Promise<string[]>;
}
export const DotsDiscoveryIpc = { status: "dots-discovery:status", run: "dots-discovery:run", suggestTags: "dots-discovery:suggest-tags" } as const;

export function discoveryUrl(value: string, base?: string): string | undefined {
  if (value.length > 2048) return;
  try {
    const url = new URL(value, base);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return;
    url.hash = "";
    return url.href;
  } catch { return; }
}

const defaultRssSchedule: DiscoverySchedule = { mode: "daily", minutes: 10, time: "08:30", windowStart: "09:00", windowEnd: "21:00" };
const defaultDreamSchedule: DiscoverySchedule = { ...defaultRssSchedule, mode: "random", minutes: 720 };
const clock = (value: unknown, fallback: string) =>
  typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : fallback;

export function discoverySchedule(input: Partial<DiscoverySchedule> | undefined, kind: "rss" | "dream"): DiscoverySchedule {
  const defaults = kind === "rss" ? defaultRssSchedule : defaultDreamSchedule;
  const minimum = kind === "rss" ? 1 : 30;
  const minutes = input?.minutes;
  const mode = input?.mode;
  const allowedMode = mode === "interval" || mode === "daily" || mode === "new" && kind === "rss" || mode === "random" && kind === "dream";
  const windowStart = clock(input?.windowStart, defaults.windowStart);
  const windowEnd = clock(input?.windowEnd, defaults.windowEnd);
  return {
    mode: allowedMode ? mode : defaults.mode,
    minutes: typeof minutes === "number" && Number.isInteger(minutes) && minutes >= minimum && minutes <= 1440
      ? minutes : defaults.minutes,
    time: clock(input?.time, defaults.time),
    windowStart,
    windowEnd: windowEnd === windowStart ? (windowStart === defaults.windowEnd ? defaults.windowStart : defaults.windowEnd) : windowEnd,
  };
}

const safeText = (value: unknown, length: number) =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, length) : "";

export function normalizeRssSubscriptions(records: unknown): RssSubscription[] {
  if (!Array.isArray(records)) return [];
  const ids = new Set<string>(), urls = new Set<string>();
  const result: RssSubscription[] = [];
  for (const row of records.slice(0, 64)) {
    if (!row || typeof row.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(row.id) || ids.has(row.id)) continue;
    const url = typeof row.url === "string" ? discoveryUrl(row.url.trim()) : undefined;
    if (!url || urls.has(url)) continue;
    ids.add(row.id); urls.add(url);
    result.push({ id: row.id, url, name: safeText(row.name, 80) || new URL(url).hostname,
      enabled: row.enabled === true, schedule: discoverySchedule(row.schedule, "rss") });
  }
  return result;
}

export function normalizeDreamSettings(input?: Partial<DreamSettings>): DreamSettings {
  const tags: DreamTag[] = [];
  const ids = new Set<string>(), queries = new Set<string>();
  if (Array.isArray(input?.tags)) for (const tag of input.tags.slice(0, 40)) {
    if (!tag || typeof tag.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(tag.id) || ids.has(tag.id)) continue;
    const name = safeText(tag.name, 40);
    const query = safeText(tag.query, 160) || name;
    if (!name || queries.has(query.toLowerCase())) continue;
    ids.add(tag.id); queries.add(query.toLowerCase());
    tags.push({ id: tag.id, name, query, enabled: tag.enabled === true });
  }
  return { enabled: input?.enabled === true, useMemory: input?.useMemory !== false,
    schedule: discoverySchedule(input?.schedule, "dream"), tags };
}
