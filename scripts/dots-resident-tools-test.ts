import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { DOTS_TASK_ID } from "../src/shared/dots";
import { DOTS_RESIDENT_READ, resolveDotsPreferences } from "../src/shared/dots-settings";
import { DotsGoogleAccounts, type runDotsGoogle } from "../src/main/dots/DotsGoogleAccounts";
import { DotsGoogleReads } from "../src/main/dots/DotsGoogleReads";
import { DotsDiscovery } from "../src/main/dots/DotsDiscovery";

const root = mkdtempSync(join(tmpdir(), "mybuddy-dots-resident-"));
process.env.HOME = root;
process.env.USERPROFILE = root;
mkdirSync(join(root, ".mybuddy"));
const { AppDatabase } = await import("../src/main/db/AppDatabase");
const { ArtifactRepository } = await import("../src/main/artifact/ArtifactRepository");
const { DotsActions } = await import("../src/main/dots/DotsActions");
const { fixtureTaskBoard } = await import("./fixtures/legacy-task-board-store");
const { createAgentDurableFixture } = await import("./agent-durable-fixture");
const db = new AppDatabase(join(root, "app.db"));
new ArtifactRepository(db.connection);

const prompts = ["帮我查下有什么新邮件", "查看个人 Gmail 未读邮件", "查一下两个账号今天的日历", "RSS 有什么新更新", "看看最近的 Dream 探索结果", "Dream 现在探索一下"];
const call = (id: string, name: string, args: Record<string, string>) => ({ type: "toolCall" as const, id, name, arguments: args });
const text = (value: string) => ({ type: "text" as const, text: value });
const executions: Record<string, number> = {};
let scenario = 0;
let attempt = 0;
const fixture = await createAgentDurableFixture(root, db, input => {
  const tools = getCurrentTools(input.messages).map(tool => tool.name);
  const state = JSON.stringify(input.messages);
  assert.ok(tools.length);
  assert.match(getCurrentSystemPrompt(input.messages), /dots_resident_read/);
  const toolArgs: Record<string, string>[] = [{ source: "gmail" }, { source: "gmail" }, { source: "calendar" }, { source: "rss" }, { source: "dream" }, { source: "dream", view: "explore" }];
  if (scenario === 0 && attempt++ === 0) return [call("try-delegate", "dots_action", { action: "delegate", text: "查询 Gmail 新邮件" })];
  if (scenario === 0 && attempt === 2) {
    assert.ok(tools.includes(DOTS_RESIDENT_READ), "Dots model can see the resident tool");
    assert.match(state.slice(-1800), /direct_read_required/);
    return [call("requested-read", DOTS_RESIDENT_READ, toolArgs[scenario])];
  }
  if (scenario > 0 && attempt++ === 0) {
    assert.ok(tools.includes(DOTS_RESIDENT_READ));
    return [call("requested-read-" + scenario, DOTS_RESIDENT_READ, toolArgs[scenario] ?? { source: "gmail" })];
  }
  const expected = ["公司夹具邮件", "个人夹具邮件", "日历夹具", "RSS 夹具条目", "已保存的 Dream", "Dream 新结果", "常驻工具调用已关闭"];
  assert.match(state.slice(-1800), new RegExp(expected[scenario]));
  return [text(expected[scenario])];
}, { deferRecovery: true });

const accountsDir = join(root, "accounts");
for (const account of ["personal", "company"]) {
  mkdirSync(join(accountsDir, account, "profile-fixture"), { recursive: true });
  writeFileSync(join(accountsDir, account, "connection.json"), JSON.stringify({ profile: "profile-fixture", email: account + "@example.test",
    checkedAt: 1, access: { gmail: { ready: true }, calendar: { ready: true } } }));
}
const run: typeof runDotsGoogle = async (dir, args) => {
  const account = basename(dirname(dir));
  const params = JSON.parse(args.at(-1)!);
  const source = args[0] + ":" + account;
  executions[source] = (executions[source] ?? 0) + 1;
  assert.equal(basename(dir), "profile-fixture");
  if (args[0] === "calendar") {
    assert.equal(params.calendarId, "primary");
    assert.equal(new Date(params.timeMin).getHours(), 0);
    assert.equal(new Date(params.timeMin).getDate(), new Date().getDate());
    return { items: [{ summary: "日历夹具", start: { date: "2026-11-25" }, end: { date: "2026-11-26" } }] };
  }
  assert.equal(params.userId, "me");
  if (args[3] === "list") {
    assert.deepEqual(params.labelIds, ["INBOX", "UNREAD"]);
    return { messages: [{ id: account + "-mail" }] };
  }
  assert.equal(args[3], "get");
  assert.equal(params.format, "metadata");
  assert.equal(params.id, account + "-mail");
  return { internalDate: "1795536000000", payload: { headers: [{ name: "Subject", value: account === "company" ? "公司夹具邮件" : "个人夹具邮件" }] } };
};

const discoveryDir = join(root, "discovery");
mkdirSync(discoveryDir);
writeFileSync(join(discoveryDir, "dream.json"), JSON.stringify({ recent: [{ title: "已保存的 Dream", url: "https://example.test/saved" }] }));
const preferences = () => resolveDotsPreferences(fixture.agent.getAppSettings().dotsSettings);
const discovery = new DotsDiscovery(discoveryDir, () => ({ ...preferences(), paused: true }),
  () => { assert.fail("前台查询不会消耗后台推送队列"); }, async query => {
    assert.equal(query, "公开设计");
    return [{ title: "Dream 新结果", url: "https://example.test/dream", snippet: "新结果摘要" }];
  }, async (_tag, items) => items, () => 0, async (url, validators) => {
    assert.equal(url, "https://example.test/feed");
    assert.deepEqual(validators, {});
    return { entries: [{ id: "entry", title: "RSS 夹具条目", url: "https://example.test/entry" }] };
  });

try {
  fixture.agent.setDotsActions(new DotsActions(db, fixture.agent, { link() { assert.fail("查邮箱不应创建普通任务"); } }, fixtureTaskBoard(db.connection)));
  fixture.agent.setDotsResident({ discovery, google: new DotsGoogleReads(
    new DotsGoogleAccounts(accountsDir, async () => {}, async () => undefined, [], run), () => preferences().google, run) });
  await fixture.agent.updateAppSettings({ memoryEnabled: false, dotsSettings: {
    google: { ...preferences().google, gmail: { ...preferences().google.gmail, accounts: ["company"] } },
    rss: [{ id: "feed", name: "设计", url: "https://example.test/feed", enabled: true, schedule: preferences().dream.schedule }],
    dream: { ...preferences().dream, tags: [{ id: "tag", name: "设计", query: "公开设计", enabled: true }] },
  } });
  db.openDots();
  const ask = async (question: string) => {
    attempt = 0;
    await fixture.prompt({ taskId: DOTS_TASK_ID, userMessageId: `fixture-user-${scenario}`, assistantMessageId: `fixture-answer-${scenario}`, text: question });
    return (await fixture.agent.loadTaskHistory(DOTS_TASK_ID)).messages.at(-1)?.text;
  };
  assert.equal(await ask(prompts[0]), "公司夹具邮件");
  assert.deepEqual(executions, { "gmail:company": 2 });
  scenario = 1;
  assert.equal(await ask(prompts[1]), "个人夹具邮件");
  scenario = 2;
  assert.equal(await ask(prompts[2]), "日历夹具");
  assert.equal(executions["calendar:personal"], 1);
  assert.equal(executions["calendar:company"], 1);
  scenario = 3;
  assert.equal(await ask(prompts[3]), "RSS 夹具条目");
  scenario = 4;
  assert.equal(await ask(prompts[4]), "已保存的 Dream");
  scenario = 5;
  assert.equal(await ask(prompts[5]), "Dream 新结果");
  assert.equal(discovery.readDream().items[0].title, "已保存的 Dream");
  scenario = 6;
  await fixture.agent.updateAppSettings({ dotsSettings: { operations: { "resident.gmail": false } } });
  assert.equal(await ask(prompts[0]), "常驻工具调用已关闭");
  assert.deepEqual(executions, { "gmail:company": 2, "gmail:personal": 2, "calendar:personal": 1, "calendar:company": 1 });
  assert.ok(db.getTask(DOTS_TASK_ID));
  assert.equal(db.listTasks().length, 0);
  console.log("PASS Dots foreground Gmail, account isolation, calendar, RSS and Dream, no delegation and per-source tool setting");
} finally {
  await discovery.close();
  await fixture.close();
  db.close();
}
