import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DOTS_TASK_ID } from "../src/shared/dots";
import { normalizeDreamSettings, normalizeRssSubscriptions, discoverySchedule } from "../src/shared/dots-discovery";
import { DotsDiscovery } from "../src/main/dots/DotsDiscovery";
import { DotsProactiveDelivery } from "../src/main/dots/DotsProactiveDelivery";
import { mapRemoteHistoryMessage } from "../src/main/remote/RemoteDtoMapper";
import { createDotsWorkspace } from "../src/main/dots/DotsWorkspace";

const root = mkdtempSync(join(tmpdir(), "mybuddy-dots-notices-"));
process.env.HOME = root;
process.env.USERPROFILE = root;
mkdirSync(join(root, ".mybuddy"), { recursive: true });
const { AppDatabase } = await import("../src/main/db/AppDatabase");
const { ArtifactRepository } = await import("../src/main/artifact/ArtifactRepository");
const { DotsActions } = await import("../src/main/dots/DotsActions");
const { DurableBotRuntime } = await import("../src/main/agent/durable/DurableBotRuntime");
const { createAgentDurableFixture } = await import("./agent-durable-fixture");
const db = new AppDatabase(join(root, "app.db"));
new ArtifactRepository(db.connection);
const busy = Promise.withResolvers<void>();
const release = Promise.withResolvers<void>();
const modelInputs: string[] = [];
let fixture = await createAgentDurableFixture(root, db, async input => {
  if (!JSON.stringify(input.messages).includes("正常提问")) return [{ type: "text", text: '{"candidates":[]}' }];
  modelInputs.push(JSON.stringify(input.messages));
  if (modelInputs.at(-1)?.includes("占用会话的正常提问")) {
    busy.resolve();
    await release.promise;
  }
  return [{ type: "text", text: "正常模型回复" }];
}, { deferRecovery: true });
function configureDots() {
  fixture.agent.setDotsActions(new DotsActions(db, fixture.agent, { link() { throw new Error("Unexpected delegation"); } }));
}
configureDots();
await fixture.agent.updateAppSettings({ memoryEnabled: false });
const previousWorkspace = join(root, "old-mixed-workspace");
const previousStorage = join(root, "dots-durable");
mkdirSync(previousWorkspace);
writeFileSync(join(previousWorkspace, "outside-source.ts"), "export const source = 'external';\n");
const legacyRuntime = await DurableBotRuntime.open({ directory: previousStorage, cwd: previousWorkspace, models: fixture.models,
  toolMode: "native", instructions: () => "", onSnapshot: () => {} });
await legacyRuntime.close();
db.openDots();
db.connection.prepare("INSERT INTO durable_bot_bindings(task_id,backend,directory,cwd) VALUES (?,'pi-durable',?,?)")
  .run(DOTS_TASK_ID, previousStorage, previousWorkspace);
let paused = true;
const append = (key: string, text: string, current: () => boolean) => fixture.agent.appendDotsProactive(key, text, current);
let outbox = new DotsProactiveDelivery(db.connection, () => paused, append);
const history = async () => (await fixture.agent.loadTaskHistory(DOTS_TASK_ID)).messages.filter(row => row.dotsProactive);
db.connection.prepare(`INSERT INTO notifications
  (id,type,level,title,body,source_type,source_id,task_id,dedupe_key,created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?)`).run("legacy", "automation.completed", "info", "Dots · Dream · 留存通知", "第一份已完成的简报",
  "automation", "dots-discovery", DOTS_TASK_ID, "dream:legacy", Date.now());
const restore = () => outbox.restoreNotifications(key => key === "dream:legacy"
  ? [{ title: "留存文章", url: "https://news.example.test/retained" }] : undefined);
const rss = normalizeRssSubscriptions([{ id: "feed", name: "订阅测试", enabled: true, url: "https://news.example.test/feed",
  schedule: { mode: "new", minutes: 5 } }]);
const dream = normalizeDreamSettings({ enabled: true, schedule: discoverySchedule({ mode: "daily" }, "dream"),
  tags: [{ id: "topic", name: "设计", query: "近期公开设计", enabled: true }] });
let hasUpdate = false;
let modelSearches = 0;
const discovery = new DotsDiscovery(join(root, "sources"), () => ({ rss, dream, paused }), notice => outbox.post(notice),
  async () => {
    ++modelSearches;
    return [{ title: "搜索结果", url: "https://news.example.test/dream", snippet: "搜索摘要" }];
  },
  async (_topic, items) => items.map(item => ({ ...item, summary: "整理后的摘要" })), () => 0,
  async () => ({ entries: hasUpdate ? [{ id: "new", title: "[新条目]", url: "https://news.example.test/new" }]
    : [{ id: "old", title: "旧条目", url: "https://news.example.test/old" }] }),
);
try {
  restore();
  outbox.start();
  assert.equal((await history()).length, 0);
  paused = false;
  await outbox.refresh();
  const [legacy] = await history();
  assert.ok(legacy, "留存通知进入 Dots 对话");
  assert.match(legacy.text, /\[留存文章\]\(<https:\/\/news\.example\.test\/retained>\)/);
  assert.equal(modelSearches, 0, "回填留存的结果无需搜索");
  assert.equal(mapRemoteHistoryMessage(legacy).dotsProactive, true);
  const firstWorkspace = fixture.agent.getAppSettings().dotsCurrentWorkspace!;
  assert.ok(firstWorkspace);
  assert.equal(dirname(dirname(firstWorkspace)), realpathSync(join(root, ".mybuddy", "dots", "workspaces")));
  assert.ok(existsSync(join(previousWorkspace, "outside-source.ts")));
  assert.ok(!existsSync(join(firstWorkspace, "outside-source.ts")));
  await discovery.run("rss", "feed");
  await outbox.refresh();
  assert.equal((await history()).length, 1, "首次订阅基线不发送消息");

  const foreground = fixture.prompt({ taskId: DOTS_TASK_ID, userMessageId: "busy-user", assistantMessageId: "busy-answer", text: "占用会话的正常提问" });
  await Promise.race([busy.promise, foreground.then(() => { throw new Error("模型没有进入预期运行"); })]);
  hasUpdate = true;
  await discovery.run("rss", "feed");
  await discovery.run("dream");
  await outbox.refresh();
  assert.equal((await history()).length, 1, "前台执行中不会插进主动消息");
  release.resolve();
  await foreground;
  await outbox.refresh();
  const sent = await history();
  assert.equal(sent.length, 3);
  assert.match(sent[1].text, /RSS.*订阅测试/);
  assert.match(sent[1].text, /https:\/\/news\.example\.test\/new/);
  assert.match(sent[2].text, /整理后的摘要/);
  assert.match(sent[2].text, /https:\/\/news\.example\.test\/dream/);
  const briefTexts = (workspace: string, source: string) => {
    const folder = join(workspace, "常驻能力", source);
    return readdirSync(folder).map(file => readFileSync(join(folder, file), "utf8"));
  };
  assert.deepEqual(briefTexts(firstWorkspace, "RSS"), [sent[1].text + "\n"]);
  assert.deepEqual(briefTexts(firstWorkspace, "Dream").sort(), [legacy.text + "\n", sent[2].text + "\n"].sort());
  await fixture.prompt({ taskId: DOTS_TASK_ID, userMessageId: "after-user", assistantMessageId: "after-answer", text: "发送后的正常提问" });
  assert.doesNotMatch(modelInputs.at(-1) ?? "", /https:\/\/news\.example\.test/);
  await outbox.close();
  await fixture.close();
  fixture = await createAgentDurableFixture(root, db, undefined, { deferRecovery: true });
  configureDots();
  await fixture.agent.resumePersistedTasks();
  outbox = new DotsProactiveDelivery(db.connection, () => false, append);
  restore();
  outbox.start();
  await outbox.refresh();
  assert.deepEqual((await history()).map(row => row.id), sent.map(row => row.id));
  assert.equal((await fixture.agent.openDots()).cwd, firstWorkspace);
  const newRoot = join(root, "custom-workspaces");
  mkdirSync(newRoot);
  await fixture.agent.updateAppSettings({ dotsSettings: { workspaceRoot: newRoot } });
  assert.equal((await fixture.agent.openDots()).cwd, firstWorkspace);
  writeFileSync(join(firstWorkspace, "留在旧对话.txt"), "旧文件");
  await fixture.agent.newDotsConversation();
  const secondWorkspace = (await fixture.agent.openDots()).cwd!;
  assert.equal(dirname(dirname(secondWorkspace)), realpathSync(newRoot));
  assert.ok(!existsSync(join(secondWorkspace, "留在旧对话.txt")));
  outbox.post({ source: "Google", key: "test-gmail", title: "邮箱提醒", body: "有一封新邮件" });
  await outbox.refresh();
  assert.match(briefTexts(secondWorkspace, "Google")[0], /有一封新邮件/);
  await fixture.agent.newDotsConversation();
  const thirdWorkspace = (await fixture.agent.openDots()).cwd!;
  assert.equal(dirname(thirdWorkspace), dirname(secondWorkspace));
  assert.notEqual(thirdWorkspace, secondWorkspace);
  assert.ok(existsSync(join(firstWorkspace, "留在旧对话.txt")));
  assert.match(briefTexts(secondWorkspace, "Google")[0], /有一封新邮件/);
  const blockedFolder = join(thirdWorkspace, "常驻能力");
  writeFileSync(blockedFolder, "暂时无法创建简报目录");
  outbox.post({ source: "RSS", key: "retry-rss", title: "归档重试", body: "消息先送达" });
  await outbox.refresh();
  assert.equal((await history()).filter(row => row.text.includes("消息先送达")).length, 1);
  await fixture.agent.newDotsConversation();
  assert.notEqual((await fixture.agent.openDots()).cwd, thirdWorkspace);
  renameSync(blockedFolder, join(thirdWorkspace, "test-blocker.txt"));
  db.connection.prepare("UPDATE dots_proactive_delivery SET archive_retry_at=0 WHERE delivery_key=?").run("retry-rss");
  await outbox.refresh();
  assert.match(briefTexts(thirdWorkspace, "RSS")[0], /消息先送达/);
  const lastMinute = createDotsWorkspace(newRoot, new Date(2026, 10, 25, 23, 59));
  const nextDay = createDotsWorkspace(newRoot, new Date(2026, 10, 26, 0, 1));
  assert.equal(basename(dirname(lastMinute)), "2026-11-25");
  assert.equal(basename(dirname(nextDay)), "2026-11-26");
  console.log("PASS Dots proactive history, retained recovery, busy queue, dated workspaces, separate archives and restart dedupe");
} finally {
  release.resolve();
  await discovery.close();
  await outbox.close();
  await fixture.close();
  db.close();
}
