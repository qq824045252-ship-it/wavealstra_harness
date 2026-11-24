import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discoverySchedule, normalizeDreamSettings, normalizeRssSubscriptions } from "../src/shared/dots-discovery";
import { DotsDiscovery, nextDiscoveryRun } from "../src/main/dots/DotsDiscovery";
import { parseDotsRss } from "../src/main/dots/DotsRss";

const at = (hours: number, minutes = 0) => new Date(2026, 10, 24, hours, minutes).getTime();
const base = "https://news.example.test/feed";
const rssDoc = (entries: string) => `<rss version="2.0"><channel><title>Updates</title>${entries}</channel></rss>`;
const item = (id: string, title: string) => `<item><title>${title}</title><guid>${id}</guid><link>/news/${id}</link></item>`;
assert.deepEqual(parseDotsRss(rssDoc(item("alpha", "Alpha &amp; Beta")), base).map(({ title, url }) => ({ title, url })),
  [{ title: "Alpha & Beta", url: "https://news.example.test/news/alpha" }]);
assert.deepEqual(parseDotsRss(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>new</id><title>Atom item</title><link href="/atom"/></entry></feed>`, base)
  .map(({ title, url }) => ({ title, url })), [{ title: "Atom item", url: "https://news.example.test/atom" }]);
assert.throws(() => parseDotsRss('<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///fixture">]><rss/>', base), /XML 声明/);
assert.deepEqual(parseDotsRss(rssDoc('<item><title>Unsafe</title><link>javascript:alert(1)</link></item>'), base), []);

const overnight = discoverySchedule({ mode: "random", windowStart: "22:00", windowEnd: "02:00" }, "dream");
const overnightSlot = nextDiscoveryRun(overnight, at(1), () => 0.5);
assert.equal(overnightSlot.windowEnd, at(2));
assert(overnightSlot.nextAt > at(1) && overnightSlot.nextAt < at(2));

const root = await mkdtemp(join(tmpdir(), "mybuddy-discovery-"));
const notices: { key: string; title: string; body: string }[] = [];
const terms: string[] = [];
const running: DotsDiscovery[] = [];
let clock = at(8);
let feedVersion = 1;
const rss = normalizeRssSubscriptions([
  { id: "daily", name: "日读", url: base, enabled: true, schedule: { mode: "daily", time: "08:30" } },
  { id: "instant", name: "即时", url: base + "/instant", enabled: true, schedule: { mode: "new", minutes: 5 } },
]);
let paused = false;
const dream = normalizeDreamSettings({
  enabled: true, useMemory: true, schedule: discoverySchedule({ mode: "random", windowStart: "09:00", windowEnd: "11:00" }, "dream"),
  tags: [{ id: "woods", name: "徒步", query: "公开徒步路线资讯", enabled: true },
    { id: "electronics", name: "电子", query: "公开电子设计资讯", enabled: true }],
});
const instance = () => {
  const host = new DotsDiscovery(root, () => ({ rss, dream, paused }), notice => notices.push(notice),
    async query => {
      terms.push(query);
      return [{ title: "公开资料", url: "https://article.example.test/new?utm_source=a", snippet: "公开摘要" },
        { title: "不可点击", url: "javascript:alert(1)", snippet: "" }];
    },
    async (_topic, sources) => sources.map(source => ({ ...source, summary: "精选解读" })),
    tag => tag.id === "electronics" ? 2 : 0,
    async (url, validators) => {
      if (validators.etag === String(feedVersion)) return validators;
      const entry = item("old", "既有内容") + (feedVersion > 1 ? item("new", "更新标题") : "");
      return { etag: String(feedVersion), entries: parseDotsRss(rssDoc(entry), url) };
    },
    () => clock,
    () => 0.5,
  );
  host.start();
  running.push(host);
  return host;
};
const until = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 100 && !condition(); attempt++) await delay(10);
  assert(condition(), "discovery did not settle");
};

try {
  let host = instance();
  await until(() => host.status().rss.daily.checkedAt === clock && host.status().rss.instant.checkedAt === clock && host.status().dream.nextAt === at(10));
  assert.equal(notices.length, 0);
  assert.equal(terms.length, 0);
  const cachedFeedPath = join(root, "rss-daily.json");
  const cachedFeed = JSON.parse(await readFile(cachedFeedPath, "utf8"));
  delete cachedFeed.recent;
  delete cachedFeed.newItems;
  await writeFile(cachedFeedPath, JSON.stringify(cachedFeed));
  await host.run("rss", "daily");
  assert.equal(host.status().rss.daily.recent?.[0]?.title, "既有内容", "没有新条目时，手动检查也能查看现有内容");
  assert.equal(host.status().rss.daily.newItems, 0);
  assert.equal(notices.length, 0, "手动预览不会将基线内容作为新增推送");

  feedVersion = 2;
  clock = at(8, 10);
  host.refresh();
  await until(() => notices.length === 1 && host.status().rss.daily.pending === 1);
  assert.equal(notices[0].title, "Dots · RSS · 即时");
  assert.match(notices[0].body, /更新标题/);
  clock = at(8, 30);
  host.refresh();
  await until(() => notices.length === 2 && host.status().rss.daily.pending === 0);
  assert.equal(notices[1].title, "Dots · RSS · 日读");
  assert(host.status().rss.daily.recent?.some(entry => entry.url === "https://news.example.test/news/new"));

  await host.close();
  host = instance();
  await until(() => host.status().dream.nextAt === at(10) && !host.status().dream.running);
  clock = at(10);
  host.refresh();
  await until(() => notices.length === 3 && !host.status().dream.running);
  assert.deepEqual(terms, ["公开电子设计资讯"]);
  assert.equal(notices[2].title, "Dots · Dream · 电子");
  assert.equal(host.status().dream.recent?.[0].summary, "精选解读");
  assert.equal(host.status().dream.nextAt, at(34));
  await host.run("dream");
  assert.equal(notices.length, 3);
  paused = true;
  await assert.rejects(host.run("dream"), /已暂停/);
  console.log("PASS RSS and Atom parsing, timed and immediate delivery, Dream topic privacy, window persistence, and content dedupe");
} finally {
  await Promise.all(running.map(host => host.close()));
  await rm(root, { recursive: true, force: true });
}
