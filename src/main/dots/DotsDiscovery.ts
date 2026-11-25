import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { discoveryUrl, type DiscoveryItem, type DiscoverySchedule, type DiscoveryStatus, type DotsDiscoveryStatus,
  type DreamSettings, type DreamTag, type RssSubscription } from "../../shared/dots-discovery";
import type { WebSearchSource } from "../../shared/web-search";
import { canonicalSearchUrl } from "../capabilities/web-access/search-aggregation";
import { atomicWriteJson } from "../task/TaskExecutionWorkspace";
import { readDotsRss, type RssEntry, type RssValidators } from "./DotsRss";

const minute = 60_000;
const day = 86_400_000;
const digest = (values: readonly string[]) => createHash("sha256").update(JSON.stringify(values)).digest("hex");
interface RssState extends DiscoveryStatus, RssValidators {
  url?: string;
  stamp?: string;
  scanAt?: number;
  seen?: string[];
  queue?: RssEntry[];
}
interface DreamState extends DiscoveryStatus {
  stamp?: string;
  windowEnd?: number;
  lastRunWindowEnd?: number;
  seen?: string[];
  explored?: Record<string, number>;
  queue?: { tag: string; items: DiscoveryItem[] };
}
type DreamSearch = (query: string, signal: AbortSignal) => Promise<WebSearchSource[]>;
type DreamCurate = (topic: string, items: DiscoveryItem[], signal: AbortSignal) => Promise<DiscoveryItem[]>;
type Deliver = (notice: { key: string; title: string; body: string }) => void;

function localClock(now: number, time: string, offset = 0) {
  const date = new Date(now);
  const [hours, minutes] = time.split(":").map(Number);
  date.setDate(date.getDate() + offset);
  return date.setHours(hours, minutes, 0, 0);
}

export function nextDiscoveryRun(schedule: DiscoverySchedule, now: number, random = Math.random): { nextAt: number; windowEnd?: number } {
  if (schedule.mode === "daily") {
    const today = localClock(now, schedule.time);
    return { nextAt: today > now ? today : localClock(now, schedule.time, 1) };
  }
  if (schedule.mode !== "random") return { nextAt: now + schedule.minutes * minute };
  const overnight = schedule.windowEnd <= schedule.windowStart;
  for (const offset of overnight ? [-1, 0, 1] : [0, 1]) {
    const start = localClock(now, schedule.windowStart, offset);
    const end = localClock(now, schedule.windowEnd, offset + (overnight ? 1 : 0));
    const earliest = Math.max(start, now + 1000);
    if (earliest < end) return { nextAt: earliest + Math.floor((end - earliest) * random()), windowEnd: end };
  }
  return { nextAt: now + day };
}

function keepUnique(values: string[], max: number) { return [...new Set(values)].slice(0, max); }

export class DotsDiscovery {
  private timer?: ReturnType<typeof setInterval>;
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();

  constructor(
    private readonly root: string,
    private readonly preferences: () => { rss: RssSubscription[]; dream: DreamSettings; paused: boolean },
    private readonly deliver: Deliver,
    private readonly search: DreamSearch,
    private readonly curate: DreamCurate,
    private readonly preferenceScore: (tag: DreamTag) => number,
    private readonly fetchFeed = readDotsRss,
    private readonly now = Date.now,
    private readonly random = Math.random,
  ) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.refresh(), 15_000);
    this.timer.unref();
    this.refresh();
  }

  async close() {
    clearInterval(this.timer);
    this.timer = undefined;
    const pending = [...this.active.values()];
    for (const { controller } of pending) controller.abort();
    await Promise.allSettled(pending.map(item => item.done));
  }

  private read<T>(key: string): T {
    try { return JSON.parse(readFileSync(join(this.root, key + ".json"), "utf8")) as T; }
    catch { return {} as T; }
  }

  private save(key: string, state: RssState | DreamState) {
    if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true, mode: 0o700 });
    atomicWriteJson(join(this.root, key + ".json"), state);
  }

  private rssState(feed: RssSubscription) {
    const state = this.read<RssState>("rss-" + feed.id);
    return state.url === feed.url ? state : { url: feed.url };
  }

  status(): DotsDiscoveryStatus {
    const publicState = (key: string, state: DiscoveryStatus): DiscoveryStatus => ({
      checkedAt: state.checkedAt, nextAt: state.nextAt, message: state.message, recent: state.recent,
      running: this.active.has(key),
    });
    return {
      rss: Object.fromEntries(this.preferences().rss.map(feed => {
        const state = this.rssState(feed);
        return [feed.id, { ...publicState("rss-" + feed.id, state), pending: state.queue?.length ?? 0, newItems: state.newItems }];
      })),
      dream: publicState("dream", this.read<DreamState>("dream")),
    };
  }

  async readRss(subscription: string | undefined, signal: AbortSignal) {
    const name = subscription?.trim().toLowerCase();
    const all = this.preferences().rss;
    const feeds = name ? all.filter(feed => feed.id.toLowerCase() === name || feed.name.toLowerCase() === name) : all.filter(feed => feed.enabled);
    if (!feeds.length) return { feeds: [], subscriptions: all.map(({ name }) => name), message: "没有找到对应的 RSS 订阅。" };
    const results = await Promise.all(feeds.slice(0, 6).map(async feed => {
      const state = this.rssState(feed);
      try {
        const result = await this.fetchFeed(feed.url, {}, signal);
        signal.throwIfAborted();
        const seen = state.seen && new Set(state.seen);
        return { name: feed.name, items: (result.entries ?? []).slice(0, 5).map(({ id, title, url }) => ({ title, url,
          newSinceLastCheck: seen ? !seen.has(id) || state.queue?.some(item => item.id === id) === true : undefined })) };
      } catch {
        signal.throwIfAborted();
        return { name: feed.name, message: "暂时无法读取这条订阅。" };
      }
    }));
    return { feeds: results, moreFeeds: feeds.length > results.length };
  }

  readDream() {
    const { checkedAt, recent, message } = this.read<DreamState>("dream");
    return { checkedAt, items: recent ?? [], message: message ?? (recent?.length ? undefined : "还没有保存过 Dream 探索结果。") };
  }

  async exploreDream(signal: AbortSignal) {
    const config = this.preferences().dream;
    const now = this.now(), state = this.read<DreamState>("dream");
    const tag = this.chooseDreamTag(config, state, now);
    if (!tag) return { items: [], message: "请先在 Dream 设置中启用至少一个兴趣标签。" };
    try {
      const { items, summaryFailed } = await this.findDreamItems(tag, state, now, signal);
      signal.throwIfAborted();
      return { tag: tag.name, checkedAt: now, items, message: summaryFailed ? "AI 摘要暂不可用，已保留来源。" : items.length ? undefined : "本次没有新的相关内容。" };
    } catch {
      signal.throwIfAborted();
      return { items: [], message: "搜索未完成，请检查 Web Search 服务配置。" };
    }
  }

  private launch(key: string, work: (signal: AbortSignal) => Promise<void>) {
    const existing = this.active.get(key);
    if (existing) return existing.done;
    const controller = new AbortController();
    const done = Promise.resolve().then(() => work(controller.signal)).finally(() => { this.active.delete(key); });
    this.active.set(key, { controller, done });
    return done;
  }

  refresh() {
    if (!this.timer) return;
    const { rss, dream, paused } = this.preferences();
    if (paused) {
      for (const { controller } of this.active.values()) controller.abort();
      return;
    }
    const now = this.now();
    const rssSlots = Math.max(0, 3 - [...this.active.keys()].filter(key => key.startsWith("rss-")).length);
    const due = rss.filter(feed => {
      if (!feed.enabled || this.active.has("rss-" + feed.id)) return false;
      const state = this.rssState(feed);
      return state.stamp !== JSON.stringify(feed.schedule) || (state.scanAt ?? 0) <= now ||
        (state.nextAt ?? 0) <= now;
    }).slice(0, rssSlots);
    for (const feed of due) void this.run("rss", feed.id, false).catch(() => undefined);
    if (dream.enabled && dream.tags.some(tag => tag.enabled) && !this.active.has("dream"))
      void this.run("dream", undefined, false).catch(() => undefined);
  }

  async run(kind: "rss" | "dream", id?: string, manual = true) {
    const { rss, dream, paused } = this.preferences();
    if (paused) {
      if (manual) throw new Error("Dots 主动跟进已暂停。");
      return;
    }
    if (kind === "dream") {
      if (!dream.tags.some(tag => tag.enabled)) throw new Error("请先启用一个兴趣标签。");
      await this.launch("dream", signal => this.runDream(dream, manual, signal));
      return;
    }
    const feed = rss.find(item => item.id === id);
    if (!feed) throw new Error("找不到这个订阅。");
    await this.launch("rss-" + feed.id, signal => this.runRss(feed, manual, signal));
  }

  private async runRss(feed: RssSubscription, manual: boolean, signal: AbortSignal) {
    const key = "rss-" + feed.id;
    const captured = JSON.stringify(feed);
    const current = () => !signal.aborted && !this.preferences().paused
      && JSON.stringify(this.preferences().rss.find(item => item.id === feed.id)) === captured;
    const now = this.now();
    const state = this.rssState(feed);
    const stamp = JSON.stringify(feed.schedule);
    if (state.stamp !== stamp) {
      state.stamp = stamp;
      state.nextAt = nextDiscoveryRun(feed.schedule, now).nextAt;
      state.scanAt = now;
    }
    const fetchDue = manual || (state.scanAt ?? 0) <= now || (state.nextAt ?? 0) <= now;
    if (fetchDue) {
      try {
        // Existing subscriptions may have validators and seen IDs but no preview.
        const validators = state.recent ? { etag: state.etag, modified: state.modified } : {};
        const read = await this.fetchFeed(feed.url, validators, signal);
        if (!current()) return;
        state.newItems = 0;
        if (read.entries) {
          const seen = new Set(state.seen ?? []);
          if (state.seen) {
            const unseen = read.entries.filter(entry => !seen.has(entry.id));
            state.newItems = unseen.length;
            state.queue = [...unseen, ...(state.queue ?? [])].slice(0, 250);
          }
          state.recent = read.entries.slice(0, 8).map(({ title, url }) => ({ title, url }));
          state.seen = keepUnique([...read.entries.map(entry => entry.id), ...seen], 800);
        }
        state.etag = read.etag;
        state.modified = read.modified;
        state.checkedAt = now;
        state.message = undefined;
      } catch (error) {
        if (!current()) return;
        const message = error instanceof Error ? error.message : "";
        state.message = /^(订阅|网址)/.test(message) ? message : "读取订阅失败，将稍后重试。";
      }
      const scanMinutes = feed.schedule.mode === "daily" ? 10 : Math.min(feed.schedule.minutes, 10);
      state.scanAt = now + (state.message ? 5 : feed.schedule.mode === "new" ? feed.schedule.minutes : scanMinutes) * minute;
    }
    if (!current()) return;
    const deliveryDue = manual || feed.schedule.mode === "new" || (state.nextAt ?? 0) <= now;
    if (deliveryDue && (feed.schedule.mode !== "new" || fetchDue || state.queue?.length))
      state.nextAt = feed.schedule.mode === "new" ? state.scanAt : nextDiscoveryRun(feed.schedule, now).nextAt;
    this.save(key, state);
    if (!deliveryDue || !state.queue?.length || !current()) return;
    const items = state.queue.slice(0, 8).map(({ title, url }) => ({ title, url }));
    this.deliver({ key: `${key}:${digest([feed.url, ...state.queue.map(item => item.id)])}`, title: `Dots · RSS · ${feed.name}`,
      body: `发现 ${state.queue.length} 条新内容。\n` + items.slice(0, 4).map(item => item.title).join("\n") });
    this.save(key, { ...state, queue: [] });
  }

  private async runDream(config: DreamSettings, manual: boolean, signal: AbortSignal) {
    const key = "dream";
    const state = this.read<DreamState>(key);
    const now = this.now();
    const stamp = JSON.stringify(config);
    const current = () => !signal.aborted && !this.preferences().paused && JSON.stringify(this.preferences().dream) === stamp;
    if (state.stamp !== stamp || state.nextAt === undefined || state.windowEnd && state.windowEnd <= now) {
      const from = config.schedule.mode === "random" ? Math.max(now, state.lastRunWindowEnd ?? now) : now;
      if (state.stamp !== stamp) state.queue = undefined;
      Object.assign(state, nextDiscoveryRun(config.schedule, from, this.random), { stamp });
      if (config.schedule.mode !== "random") state.windowEnd = undefined;
      this.save(key, state);
    }
    if (state.queue && current()) this.deliverDream(state);
    if (!manual && (state.nextAt ?? Infinity) > now) return;
    const tag = this.chooseDreamTag(config, state, now);
    if (!tag) return;
    try {
      const { items, summaryFailed } = await this.findDreamItems(tag, state, now, signal, current);
      if (!current()) return;
      if (items.length) {
        state.queue = { tag: tag.name, items };
        state.seen = keepUnique([...items.map(item => canonicalSearchUrl(item.url)), ...(state.seen ?? [])], 1000);
      }
      state.checkedAt = now;
      state.message = summaryFailed ? "已保留来源，AI 摘要暂不可用。" : items.length ? undefined : "本次没有新的相关内容。";
      state.explored = { ...state.explored, [tag.id]: now };
    } catch {
      if (!current()) return;
      state.message = "搜索未完成，请检查 Web Search 服务配置。";
    }
    const consumeScheduled = !manual || (state.nextAt ?? Infinity) <= now;
    if (config.schedule.mode === "random" && consumeScheduled) state.lastRunWindowEnd = state.windowEnd;
    const scheduleFrom = config.schedule.mode === "random" && consumeScheduled ? Math.max(now, state.windowEnd ?? now) : now;
    if (consumeScheduled || config.schedule.mode === "interval")
      Object.assign(state, nextDiscoveryRun(config.schedule, scheduleFrom, this.random));
    this.save(key, state);
    if (state.queue && current()) this.deliverDream(state);
  }

  private chooseDreamTag(config: DreamSettings, state: DreamState, now: number) {
    const topics = config.tags.filter(item => item.enabled).map(item => {
      const last = state.explored?.[item.id] ?? 0;
      const weight = config.useMemory ? Math.min(4, Math.max(0, this.preferenceScore(item))) : 0;
      return { item, priority: (now - last) * (1 + weight / 4) };
    });
    return topics.sort((a, b) => b.priority - a.priority)[0]?.item;
  }

  private async findDreamItems(tag: DreamTag, state: DreamState, now: number, signal: AbortSignal, current = () => !signal.aborted) {
    const seen = new Set(state.seen ?? []);
    const fresh: DiscoveryItem[] = [];
    for (const result of await this.search(tag.query, signal)) {
      const url = discoveryUrl(result.canonicalUrl || result.url);
      if (!url || !result.title || result.duplicateOf) continue;
      const published = result.publishedAt ? Date.parse(result.publishedAt) : NaN;
      if (Number.isFinite(published) && published < now - 7 * day) continue;
      const id = canonicalSearchUrl(url);
      if (seen.has(id)) continue;
      seen.add(id);
      fresh.push({ title: result.title.slice(0, 160), url, summary: result.snippet?.slice(0, 500) });
      if (fresh.length === 5) break;
    }
    if (!fresh.length || !current()) return { items: fresh, summaryFailed: false };
    try { return { items: await this.curate(tag.name, fresh, signal), summaryFailed: false }; }
    catch { return { items: fresh, summaryFailed: true }; }
  }

  private deliverDream(state: DreamState) {
    const queue = state.queue;
    if (!queue) return;
    this.deliver({ key: `dream:${digest(queue.items.map(item => canonicalSearchUrl(item.url)))}`,
      title: `Dots · Dream · ${queue.tag}`,
      body: queue.items.slice(0, 3).map(item => item.title + (item.summary ? " · " + item.summary : "")).join("\n") });
    state.recent = queue.items;
    state.queue = undefined;
    this.save("dream", state);
  }
}
