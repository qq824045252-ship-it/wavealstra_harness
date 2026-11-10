import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { BotConversationRepository } from "../src/main/agent/work/BotConversationRepository";
import { botForegroundTools } from "../src/main/agent/work/BotForegroundTools";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkControlResult } from "../src/shared/bot-work";

const root = await mkdtemp(join(tmpdir(), "bot-watch-intake-"));
const database = join(root, "fixture.db");
const db = new AppDatabase(database);
const bots = new BotRegistry(db.connection);
bots.registerBot({ userId: LOCAL_USER_ID, botId: DEFAULT_BOT_ID, displayName: "intake fixture", authorization: DESKTOP_USER_GRANTS });
const works = new WorkService(db.connection, { bots });
const messages = new BotConversationRepository(db.connection);
const scheduled: string[] = [];
let sequence = 0;
const first = messages.accept(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, requestId: "first-intake", text: "创建测试事项" });
const tool = botForegroundTools({ db: db.connection, userId: LOCAL_USER_ID, botId: DEFAULT_BOT_ID,
  conversationId: first.conversationId, bots, messages, works, isAuthority: () => true,
  schedule: work => scheduled.push(work.workId), wake: () => {}, memorySearch: () => [] }).find(item => item.name === "work_create")!;
const wire = Type.Unsafe(JSON.parse(JSON.stringify(tool.parameters)));
const counts = () => ({ works: works.listWorks(LOCAL_USER_ID, { includeClosed: true }).length,
  subscriptions: db.connection.prepare("SELECT COUNT(*) AS n FROM work_subscriptions").get(),
  bindings: db.connection.prepare("SELECT COUNT(*) AS n FROM work_execution_bindings").get(), scheduled: scheduled.length });
async function invoke(args: unknown, text = "2持续追踪", replayId?: string) {
  const id = replayId ?? `intake-${++sequence}`;
  messages.accept(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, conversationId: first.conversationId, requestId: id, text });
  const api = { callId: id, taskId: id, memo: async () => id } as unknown as ToolExecutionApi;
  const result = await tool.execute(args as never, api, BACKGROUND_CONTEXT);
  const output = result.output?.find(item => item.type === "text"); assert(output?.type === "text");
  return JSON.parse(output.text) as WorkControlResult & { tracking: { scheduleStatus: string; nextWakeAt: number | null;
    scheduleBasis: string | null; scheduleRationale: string | null; notice?: string } };
}
async function rejectWithoutSideEffects(args: unknown) {
  const before = counts();
  let rejected = false;
  try { rejected = !(await invoke(args)).ok; } catch { rejected = true; }
  assert(rejected, `invalid intake accepted: ${JSON.stringify(args)}`);
  assert.deepEqual(counts(), before, "invalid intake must not create, dispatch or arm a partial Work");
}
try {
  const once = { title: "一次结果", requestedOutcome: "one_time", mode: "once" };
  for (const args of [{ title: once.title }, { title: once.title, mode: "once" },
    { title: once.title, requestedOutcome: "one_time" }, { ...once, requestedOutcome: "sometimes" }]) {
    assert.equal(Value.Check(wire, args), false, "required intent and plan are exposed in actual function-call schema");
    await rejectWithoutSideEffects(args);
  }
  const future = Date.now() + 3_600_000;
  for (const args of [
    { ...once, requestedOutcome: "ongoing" },
    { title: "ongoing without timing", requestedOutcome: "ongoing", mode: "watch" },
    { title: "one-time cannot recur", requestedOutcome: "one_time", mode: "watch", watchRule: { cronExpression: "0 9 * * *", scheduleBasis: "user_specified" } },
    { title: "ongoing only one wake", requestedOutcome: "ongoing", mode: "watch", watchRule: { nextWakeAt: future, scheduleBasis: "user_specified" } },
    { title: "watch without origin", requestedOutcome: "ongoing", mode: "watch", watchRule: { cronExpression: "0 9 * * *", timezone: "UTC" } },
    { title: "recommendation without reason", requestedOutcome: "ongoing", mode: "watch", watchRule: { cronExpression: "0 9 * * *", scheduleBasis: "recommended" } },
    { title: "expired one shot", requestedOutcome: "one_time", mode: "watch", watchRule: { nextWakeAt: Date.now() - 1000, scheduleBasis: "user_specified" } },
    { title: "invalid zone", requestedOutcome: "ongoing", mode: "watch", watchRule: { cronExpression: "0 9 * * *", timezone: "not/a/timezone", scheduleBasis: "user_specified" } },
  ]) await rejectWithoutSideEffects(args);
  assert.equal(counts().works, 0);

  const explicit = await invoke({ title: "Hourly repository observations", requestedOutcome: "ongoing", mode: "watch",
    watchRule: { cronExpression: "0 * * * *", timezone: "Asia/Shanghai", scheduleBasis: "user_specified" } },
    "Keep an eye on this repository. Check hourly in Shanghai time.");
  assert(explicit.ok); assert.equal(explicit.work.mode, "watch");
  const subscription = works.repo.listSubscriptions(explicit.work.workId)[0];
  assert.equal(explicit.tracking.nextWakeAt, subscription.nextWakeAt);
  assert(explicit.tracking.nextWakeAt! > Date.now()); assert.equal(explicit.tracking.scheduleStatus, "scheduled");
  assert.equal(explicit.tracking.scheduleBasis, "user_specified"); assert.equal(explicit.tracking.notice, undefined);
  assert.equal(scheduled.length, 0, "future recurring work is not run immediately");

  const rationale = "Repository progress usually changes slowly; start with a daily check. You can change this schedule anytime.";
  const recommended = await invoke({ title: "Repository progress", requestedOutcome: "ongoing", mode: "watch",
    watchRule: { cronExpression: "0 9 * * *", timezone: "UTC", scheduleBasis: "recommended", scheduleRationale: rationale } });
  assert(recommended.ok); assert.equal(recommended.work.mode, "watch");
  assert.equal(recommended.work.watchRule?.scheduleBasis, "recommended");
  assert.equal(recommended.work.watchRule?.scheduleRationale, rationale);
  assert.equal(recommended.tracking.scheduleRationale, rationale); assert(recommended.tracking.notice);
  assert.equal(recommended.tracking.scheduleStatus, "scheduled"); assert(recommended.tracking.nextWakeAt! > Date.now());

  const oneShot = await invoke({ title: "One future check", requestedOutcome: "one_time", mode: "watch",
    watchRule: { nextWakeAt: future, timezone: "UTC", scheduleBasis: "user_specified" } }, "Check once tomorrow, not repeatedly.");
  assert(oneShot.ok); assert.equal(oneShot.tracking.nextWakeAt, future); assert.equal(oneShot.work.watchRule?.cronExpression, undefined);
  assert.equal(scheduled.length, 0);

  // The host enforces typed facts. It does not interpret Chinese keywords or
  // require quotes to match frequency prose; semantic accuracy belongs to live model tests.
  for (const text of ["实现持续追踪功能，完成代码后交付一次报告", "只总结过去一周每天的进展", "不用持续了，只查这次", "Summarize last week's daily progress once."]) {
    const result = await invoke({ ...once, title: text }, text);
    assert(result.ok); assert.equal(result.work.mode, "once");
    assert.equal(result.tracking.scheduleStatus, "not_scheduled"); assert.equal(result.tracking.nextWakeAt, null);
  }
  assert.equal(scheduled.length, 4);
  const reopened = new AppDatabase(database);
  try {
    const recovered = new WorkService(reopened.connection, { bots: new BotRegistry(reopened.connection) }).getWork(recommended.work.workId)!;
    assert.equal(recovered.watchRule?.scheduleBasis, "recommended"); assert.equal(recovered.watchRule?.scheduleRationale, rationale);
  } finally { reopened.close(); }
  const actor = { kind: "user" as const, userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS };
  const trackedId = recommended.work.workId;
  const guard = () => {
    const work = works.getWork(trackedId)!;
    return { expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch };
  };
  const amend = (params: Parameters<WorkService["amendWork"]>[1]) => {
    const result = works.amendWork(actor, { ...params, versionGuard: guard() });
    assert(result.ok, JSON.stringify(result));
    return result.work.watchRule!;
  };
  const change = (params: Omit<Parameters<WorkService["amendWork"]>[1], "workId" | "operationId">) =>
    amend({ ...params, workId: trackedId, operationId: `amend-intake-${++sequence}` });
  const recommend = () => change({ watchRule: { scheduleBasis: "recommended", scheduleRationale: rationale } });
  let rule = change({ title: "Renamed repository", goalDescription: "Observe progress" });
  assert.equal(rule.scheduleBasis, "recommended"); assert.equal(rule.scheduleRationale, rationale);
  rule = change({ watchRule: { cronExpression: "0 9 * * *", timezone: "UTC" } });
  assert.equal(rule.scheduleBasis, "recommended", "unchanged timing preserves provenance");
  for (const timing of [{ cronExpression: "0 10 * * *" }, { timezone: "Asia/Shanghai" }, { nextWakeAt: future + 1000 }]) {
    recommend();
    rule = change({ watchRule: timing });
    assert.equal(rule.scheduleBasis, undefined); assert.equal(rule.scheduleRationale, undefined);
  }
  recommend();
  rule = change({ watchRule: { scheduleBasis: "user_specified" } });
  assert.equal(rule.scheduleBasis, "user_specified"); assert.equal(rule.scheduleRationale, undefined);
  rule = change({ watchRule: { cronExpression: "0 11 * * *", scheduleBasis: "recommended", scheduleRationale: "New cadence reason" } });
  assert.equal(rule.scheduleBasis, "recommended"); assert.equal(rule.scheduleRationale, "New cadence reason");

  rule = change({ watchRule: { cronExpression: "0 13 * * *", scheduleBasis: "recommended" } });
  assert.equal(rule.scheduleBasis, "recommended");
  assert.equal(rule.scheduleRationale, undefined, "changed recommended cadence must not inherit the previous reason");

  const configure = (timing: { cronExpression?: string; timezone?: string; nextWakeAt?: number }) => {
    const sub = works.repo.listSubscriptions(trackedId).find(item => !item.stoppedAt)!;
    const result = works.phase4Control(actor, { kind: "configure-subscription", operationId: `configure-intake-${++sequence}`,
      workId: trackedId, subscriptionId: sub.subscriptionId, versionGuard: guard(), source: sub.source,
      catchUpPolicy: sub.catchUpPolicy, ...timing });
    assert(result.ok, JSON.stringify(result));
    return works.getWork(trackedId)!.watchRule!;
  };
  recommend();
  rule = configure({});
  assert.equal(rule.scheduleBasis, "recommended", "non-timing configuration preserves provenance");
  for (const timing of [{ cronExpression: "0 12 * * *" }, { timezone: "Europe/London" }, { nextWakeAt: future + 2000 }]) {
    recommend();
    rule = configure(timing);
    assert.equal(rule.scheduleBasis, undefined, "phase4 must not infer a user-specified basis");
    assert.equal(rule.scheduleRationale, undefined);
  }
  const replayArgs = { title: "Replay current schedule", requestedOutcome: "ongoing", mode: "watch",
    watchRule: { cronExpression: "0 9 * * *", timezone: "UTC", scheduleBasis: "user_specified" } };
  const replayId = "create-paused-replay";
  const created = await invoke(replayArgs, "Track repository daily", replayId);
  assert(created.ok); assert.equal(created.tracking.scheduleStatus, "scheduled");
  const paused = works.pauseWork(actor, { operationId: "pause-before-create-replay", workId: created.work.workId,
    versionGuard: { expectedStateVersion: created.work.stateVersion, expectedIntentRevision: created.work.intentRevision,
      expectedOwnerEpoch: created.work.ownerEpoch } });
  assert(paused.ok, JSON.stringify(paused));
  const beforeReplay = counts();
  const replayed = await invoke(replayArgs, "Track repository daily", replayId);
  assert(replayed.ok); assert.equal(replayed.replayed, true);
  assert.equal(replayed.work.workId, created.work.workId);
  assert.equal(replayed.tracking.scheduleStatus, "inactive", "historical create receipt cannot advertise a paused schedule");
  assert.deepEqual(counts(), beforeReplay, "create replay does not duplicate Work, subscription or dispatch");
  console.log("PASS structured watch intake: required intent/plan, no partial writes for contradictions, explicit/recommended cadence persistence, actual next wake, one future check, and no host keyword gate");
} finally { db.close(); await rm(root, { recursive: true, force: true }); }
