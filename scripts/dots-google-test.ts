import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DotsGoogleAccounts, type runDotsGoogle } from "../src/main/dots/DotsGoogleAccounts";
import { DotsGoogleMonitor } from "../src/main/dots/DotsGoogleMonitor";
import { normalizeDotsSettings } from "../src/shared/dots-settings";

const root = await mkdtemp(join(tmpdir(), "mybuddy-dots-google-"));
const clientDirectory = join(root, "client");
const authRoot = join(root, "accounts");
await mkdir(clientDirectory);
await writeFile(join(clientDirectory, "client_secret.json"), JSON.stringify({
  installed: { client_id: "fixture.apps.googleusercontent.com", client_secret: "fixture-oauth-client" },
}));

const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?client_id=fixture&redirect_uri=http%3A%2F%2Flocalhost%3A34567";
const opened: string[] = [];
let loginFails = false;
let duplicate = false;
const events: string[] = [];
let calendarApis = 0;
let clock = new Date(2026, 10, 24, 8, 0).getTime();
const startsAt = new Date(2026, 10, 24, 8, 40).toISOString();
const endsAt = new Date(2026, 10, 24, 9, 10).toISOString();
const command: typeof runDotsGoogle = async (dir, args, options) => {
  const account = basename(dirname(dir));
  const email = (duplicate ? "personal" : account) + "@example.test";
  if (args[0] === "auth") {
    options?.onOutput?.("stderr", Buffer.from("https://elsewhere.test/oauth\n" + authUrl.slice(0, 30)));
    options?.onOutput?.("stderr", Buffer.from(authUrl.slice(30) + "\n"));
    if (loginFails) throw new Error("raw provider message");
    return { status: "success", account: email };
  }
  const params = JSON.parse(args.at(-1)!);
  if (args.includes("getProfile")) return params.fields === "emailAddress" ? { emailAddress: email } : { historyId: "100" };
  if (args.includes("history")) return params.pageToken ? {
    historyId: "102", history: [{ messagesAdded: [{ message: { id: "second" } }, { message: { id: "first" } }] }],
  } : {
    historyId: params.startHistoryId, ...(params.startHistoryId === "100"
      ? { history: [{ messagesAdded: [{ message: { id: "first" } }] }], nextPageToken: "page-2" } : {}),
  };
  if (params.fields === "kind") return { kind: "calendar#events" };
  calendarApis += 1;
  return { items: [{ id: "meeting", summary: "公司例会", start: { dateTime: startsAt }, end: { dateTime: endsAt } }] };
};
const openBrowser = async (url: string) => { opened.push(url); };
const pickClient = async () => undefined;
const accounts = new DotsGoogleAccounts(authRoot, openBrowser, pickClient, [clientDirectory], command);
const monitors: DotsGoogleMonitor[] = [];
let paused = false;

try {
  await accounts.login("personal");
  await accounts.login("company");
  assert.deepEqual(opened, [authUrl, authUrl]);
  assert.equal(accounts.status().personal.connection?.email, "personal@example.test");
  assert.deepEqual(accounts.status().company.connection?.access, { gmail: { ready: true }, calendar: { ready: true } });

  loginFails = true;
  await accounts.login("personal");
  assert.equal(accounts.status().personal.connection?.email, "personal@example.test");
  assert.equal(accounts.status().personal.message, "操作失败，请检查网络和 gws 安装后重试。");
  loginFails = false;
  duplicate = true;
  await accounts.login("company");
  assert.equal(accounts.status().company.connection?.email, "company@example.test");
  assert.match(accounts.status().company.message ?? "", /邮箱已连接/);
  duplicate = false;

  const restarted = new DotsGoogleAccounts(authRoot, openBrowser, pickClient, [clientDirectory], command);
  const rules = normalizeDotsSettings({ google: {
    gmail: { accounts: ["personal"], intervalMinutes: 5 },
    calendar: { accounts: ["company"], mode: "daily", dailyTime: "08:45" },
  } }).google;
  const startMonitoring = () => {
    const monitor = new DotsGoogleMonitor(restarted, () => rules, () => paused,
      notice => events.push(notice.title + " · " + notice.body), command, () => clock);
    monitors.push(monitor);
    monitor.start();
    return monitor;
  };
  const until = async (condition: () => boolean) => {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (condition()) return;
      await delay(10);
    }
    assert(condition(), "timed check did not settle");
  };
  let monitor = startMonitoring();
  await until(() => monitor.status().gmail.personal?.checkedAt === clock && monitor.status().calendar.company?.checkedAt === clock);
  assert.deepEqual(events, []);
  assert.equal(monitor.status().gmail.personal?.nextAt, new Date(2026, 10, 24, 8, 5).getTime());
  assert.equal(monitor.status().calendar.company?.nextAt, new Date(2026, 10, 24, 8, 45).getTime());

  clock = new Date(2026, 10, 24, 8, 5).getTime();
  monitor.refresh();
  await until(() => monitor.status().gmail.personal?.checkedAt === clock);
  assert.deepEqual(events, ["Dots · 个人邮箱 · 收件箱有 2 封新邮件。"]);
  assert.equal(calendarApis, 1);

  clock = new Date(2026, 10, 24, 8, 10).getTime();
  paused = true;
  monitor.refresh();
  assert.equal(events.length, 1);
  paused = false;
  monitor.refresh();
  await until(() => monitor.status().gmail.personal?.checkedAt === clock && events.length === 2);
  assert.match(events[1], /公司日历.*08:40.*公司例会/);
  await monitor.close();
  await restarted.login("company");
  clock += 60_000;
  monitor = startMonitoring();
  monitor.refresh();
  assert.equal(events.length, 2);
  assert.equal(calendarApis, 1);
  console.log("PASS Dots Google browser authorization, account isolation, failed replacement recovery, independent checks, and reminder dedupe after restart");
} finally {
  await Promise.all(monitors.map(monitor => monitor.close()));
  await accounts.close();
  await rm(root, { recursive: true, force: true });
}
