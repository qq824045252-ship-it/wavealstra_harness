import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { BotConversationRepository } from "../src/main/agent/work/BotConversationRepository";
import { botForegroundTools } from "../src/main/agent/work/BotForegroundTools";
import { BotWorkQuery } from "../src/main/agent/work/BotWorkQuery";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { LOCAL_USER_ID, type WorkDto } from "../src/shared/bot-work";

const root = mkdtempSync(join(tmpdir(), "bot-query-scale-"));
const db = new AppDatabase(join(root, "app.db"));
const bots = new BotRegistry(db.connection);
for (const [botId, userId] of [["owner", LOCAL_USER_ID], ["member", LOCAL_USER_ID], ["outsider", LOCAL_USER_ID], ["foreign", "another-user"]])
  bots.registerBot({ botId, userId, displayName: botId, authorization: DESKTOP_USER_GRANTS });
const works = new WorkService(db.connection, { bots });
const messages = new BotConversationRepository(db.connection);
const receipt = messages.accept(LOCAL_USER_ID, { botId: "owner", requestId: "scale-query", text: "查看所有委托" });
const tools = botForegroundTools({ db: db.connection, userId: LOCAL_USER_ID, botId: "owner", conversationId: receipt.conversationId,
  bots, messages, works, isAuthority: () => true, schedule: () => { throw Error("read must not dispatch"); }, wake: () => {}, memorySearch: () => [] });
const tool = tools.find(item => item.name === "work_query_status")!;
const schema = Type.Unsafe(JSON.parse(JSON.stringify(tool.parameters)));
let calls = 0;
async function invoke(input: unknown) {
  assert(Value.Check(schema, input), "model-visible schema accepts input");
  const api = { callId: `call-${++calls}`, taskId: `task-${calls}`, memo: async () => receipt.requestId } as unknown as ToolExecutionApi;
  const result = await tool.execute(input as never, api, BACKGROUND_CONTEXT);
  const output = result.output?.find(block => block.type === "text"); assert(output?.type === "text");
  return JSON.parse(output.text);
}
try {
  const created = works.createWork({ kind: "user", userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS },
    { operationId: "base", title: "Template", ownerBotId: "owner" });
  assert(created.ok);
  const base = created.work;
  // Real file-backed SQLite, real repository and real tool. Repeated large payloads
  // are deliberately stored so an accidental full hydration/projection is expensive.
  const long = "必须保留的报告原文。".repeat(500);
  db.connection.transaction(() => {
    for (let i = 0; i < 12000; i++) {
      const lifecycle = (["active", "paused", "closing", "closed"] as const)[i % 4]!;
      const work: WorkDto = { ...base, workId: `work-scale-${String(i).padStart(5, "0")}`,
        userId: i < 8000 ? LOCAL_USER_ID : "another-user", ownerBotId: i < 6000 ? "owner" : i < 8000 ? "outsider" : "foreign",
        title: i === 1 ? "Literal 100%_match" : `Query ${i}`, goalDescription: long, lifecycle,
        closureSummary: lifecycle === "closed" ? long : undefined, progressSummary: long,
        // Ties ensure keyset pagination needs both keys; updates must not reorder it.
        createdAt: 1000 + Math.floor(i / 10), updatedAt: 2000 + i, closedAt: lifecycle === "closed" ? 3000 : undefined,
        closureConclusion: lifecycle === "closed" ? "succeeded" : undefined };
      works.repo.insertWork(work);
    }
    // Duplicate owner membership must not double counts; foreign-user membership
    // must never expand access across the user boundary.
    const insert = db.connection.prepare(`INSERT INTO work_participants(work_id,bot_id,role,delegated_scope_json,expert_snapshot_json,added_at) VALUES (?,?,'watcher','[]','{}',1)`);
    for (const id of ["work-scale-00000", "work-scale-06000", "work-scale-08000"]) insert.run(id, "owner");
    insert.run("work-scale-00000", "member");
  })();
  const query = new BotWorkQuery(db.connection, LOCAL_USER_ID, "owner");
  const getProjection = works.getProjection.bind(works);
  const getWork = works.getWork.bind(works);
  const listWorks = works.listWorks.bind(works);
  works.getProjection = () => { throw Error("list must not build projections"); };
  works.getWork = () => { throw Error("list must not hydrate Work"); };
  works.listWorks = () => { throw Error("list must not load all Work"); };
  const start = performance.now();
  const page = await invoke({ view: "summary" });
  const elapsed = performance.now() - start;
  assert.equal(page.items.length, 20); assert.equal(page.total, 4502);
  assert.deepEqual(page.statusCounts, { active: 1502, paused: 1500, closing: 1500, closed: 1500 });
  assert.equal(page.hasMore, true); assert(page.nextCursor);
  assert.equal(JSON.stringify(page).includes(long), false); assert(JSON.stringify(page).length < 30000);
  assert(page.items.every((item: { lifecycle: string }) => item.lifecycle !== "closed"));
  assert(elapsed < 3000, `first page took ${elapsed}ms`);
  const legacy = await invoke({});
  assert(Array.isArray(legacy)); assert.equal(legacy.length, 20);
  assert.equal(legacy[0].queryPage.total, 6002); assert.equal(legacy[0].queryPage.hasMore, true);
  assert(legacy[0].queryPage.nextCursor, "legacy JSON retains explicit truncation and next cursor");
  const legacyNext = await invoke(legacy[0].queryPage.nextQuery);
  assert.equal(legacyNext.total, 6002);
  assert(!legacyNext.items.some((item: { workId: string }) => legacy.some((old: { workId: string }) => old.workId === item.workId)));
  assert.equal((await invoke({ status: "closed", limit: 2 })).total, 1500);
  assert.equal((await invoke({ view: "summary", workId: "work-scale-00003" })).total, 1);
  assert.equal((await invoke({ view: "summary", search: "%_" })).items.length, 1);
  assert.equal((await invoke({ view: "summary", search: "missing-name" })).total, 0);
  assert.equal((await invoke({ view: "summary", workId: "work-scale-08000", status: "all" })).total, 0);
  assert.equal(query.canRead("work-scale-08000"), false);
  assert.equal(query.canRead("work-scale-06000"), true);
  const memberQuery = new BotWorkQuery(db.connection, LOCAL_USER_ID, "member");
  const sparseStart = performance.now();
  assert.equal(memberQuery.page({}).total, 1);
  const sparseElapsed = performance.now() - sparseStart;
  const searchStart = performance.now();
  const searchPage = query.page({ search: "报告原文", limit: 50 });
  const searchElapsed = performance.now() - searchStart;
  assert.equal(searchPage.total, 4501);
  const searchNext = query.page(searchPage.nextQuery!);
  assert.equal(searchNext.total, searchPage.total);
  assert(!searchNext.items.some(item => searchPage.items.some(old => old.workId === item.workId)));
  assert(searchElapsed < 3000 && sparseElapsed < 3000, "large-goal substring and sparse membership remain practical");
  assert.throws(() => memberQuery.page({ cursor: page.nextCursor }), /不匹配/);
  assert.throws(() => query.page({ cursor: page.nextCursor, status: "all" }), /不匹配/);
  assert.throws(() => query.page({ cursor: "not-a-cursor" }), /无效/);
  assert.throws(() => new BotWorkQuery(db.connection, "another-user", "owner").page({ cursor: page.nextCursor }), /不匹配/);
  for (const invalid of [{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { status: "invented" }, { search: " " }, { cursor: "x".repeat(2049) }])
    assert.equal(Value.Check(schema, invalid), false);
  await assert.rejects(invoke({ view: "detail" }), /必须指定/);
  // Traverse one status fully, including equal timestamps. Updating an earlier
  // page's progress cannot duplicate or skip rows, unlike updatedAt cursors.
  const ids = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  do {
    const result = query.page({ status: "closed", limit: 50, cursor });
    for (const item of result.items) { assert(!ids.has(item.workId)); ids.add(item.workId); }
    if (++pages === 1) db.connection.prepare("UPDATE works SET updated_at=999999 WHERE work_id=?").run(result.items.at(-1)!.workId);
    cursor = result.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(ids.size, 1500); assert.equal(pages, 30);
  const watchId = "work-scale-00000";
  db.connection.prepare(`INSERT INTO work_blockers(blocker_id,work_id,reason,kind,waiting_for_user_input,status,created_at)
    VALUES ('need-input',?,'请确认范围','operational',1,'open',1)`).run(watchId);
  db.connection.prepare(`INSERT INTO work_blockers(blocker_id,work_id,reason,kind,waiting_for_user_input,status,created_at)
    VALUES ('cleared-input',?,'已处理','operational',1,'cleared',1)`).run(watchId);
  db.connection.prepare(`UPDATE works SET mode='watch',deadline_at=12345,watch_rule_json=? WHERE work_id=?`)
    .run(JSON.stringify({ cronExpression: "0 * * * *", timezone: "Asia/Shanghai", stopConditionText: "达到目标后停止", nextWakeAt: 1 }), watchId);
  db.connection.prepare(`INSERT INTO work_subscriptions(subscription_id,work_id,source,catch_up_policy,max_merge_wait_ms,max_queue_depth,
    next_wake_at,created_at,updated_at) VALUES ('live-watch',?,'schedule','latest',0,1,999,1,1)`).run(watchId);
  db.connection.prepare(`INSERT INTO work_subscriptions(subscription_id,work_id,source,catch_up_policy,max_merge_wait_ms,max_queue_depth,
    next_wake_at,created_at,updated_at,stopped_at) VALUES ('stopped-watch',?,'schedule','latest',0,1,2,1,1,3)`).run(watchId);
  const watch = query.page({ workId: watchId }).items[0]!;
  assert.equal(watch.openBlockerCount, 1); assert.equal(watch.needsUserInput, true);
  assert.equal(watch.nextWakeAt, 999); assert.equal(watch.activeSubscriptionCount, 1); assert.equal(watch.stoppedSubscriptionCount, 1);
  assert.equal(watch.deadlineAt, 12345); assert.equal(watch.watchRule?.stopConditionText, "达到目标后停止");
  assert.equal(watch.tracking.state, "waiting_input");
  assert.equal(watch.tracking.reason, "请确认范围");
  db.connection.prepare("UPDATE work_blockers SET status='cleared' WHERE work_id=?").run(watchId);
  assert.equal(query.page({ workId: watchId }).items[0]!.tracking.state, "scheduled");
  db.connection.prepare("UPDATE work_subscriptions SET next_wake_at=NULL WHERE work_id=? AND stopped_at IS NULL").run(watchId);
  assert.equal(query.page({ workId: watchId }).items[0]!.tracking.state, "waiting_event");
  db.connection.prepare("UPDATE work_subscriptions SET stopped_at=10 WHERE work_id=?").run(watchId);
  assert.equal(query.page({ workId: watchId }).items[0]!.tracking.state, "not_running");
  const insertBinding = db.connection.prepare(`INSERT INTO work_execution_bindings
    (binding_id,work_id,operation_id,bot_id,task_id,durable_store_key,conversation_id,intent_revision,owner_epoch,
     input_snapshot_id,expert_snapshot_json,workspace_binding,status,admitted_at,settlement_note)
    VALUES (@id,@workId,@id,'owner',@task,'store','conversation',@revision,1,@snapshot,'{}','/test',@status,@time,@note)`);
  const bind = (id: string, task: string, status: string, time: number, revision = 1, note: string | null = null) =>
    insertBinding.run({ id, task, status, time, revision, note, workId: watchId, snapshot: base.inputSnapshotId });
  bind("old-intent", "old-task", "running", 1, 0);
  assert.equal(query.page({ workId: watchId }).items[0]!.tracking.state, "not_running", "old intent is not current execution");
  bind("attempt-1", "task-a", "failed", 2, 1, "服务返回503");
  assert.equal(query.page({ workId: watchId }).items[0]!.tracking.state, "failed");
  assert.equal(query.page({ workId: watchId }).items[0]!.tracking.reason, "服务返回503");
  bind("attempt-2", "task-a", "pending", 2);
  assert.equal(query.page({ workId: watchId }).items[0]!.tracking.state, "queued");
  assert.equal(query.page({ workId: watchId }).items[0]!.tracking.execution.failed, 0, "superseded retry is not a current failure");
  db.connection.prepare("UPDATE work_execution_bindings SET status='running' WHERE binding_id='attempt-2'").run();
  const running = query.page({ workId: watchId }).items[0]!;
  assert.equal(running.tracking.state, "running");
  assert.equal(running.tracking.execution.running, 1);
  assert.equal(running.versionGuard.expectedStateVersion, watch.versionGuard.expectedStateVersion, "binding changes observed without control-version changes");
  db.connection.prepare("UPDATE work_execution_bindings SET status='completed' WHERE binding_id='attempt-2'").run();
  assert.equal(query.page({ workId: watchId }).items[0]!.tracking.state, "result_ready");
  bind("member-b", "task-b", "unknown", 4, 1, "回执未核实");
  assert.equal(query.page({ workId: watchId }).items[0]!.tracking.state, "unverified", "one completed member does not hide unknown member");
  db.connection.prepare("UPDATE works SET lifecycle='paused' WHERE work_id=?").run(watchId);
  assert.equal(query.page({ workId: watchId }).items[0]!.tracking.state, "paused");
  db.connection.prepare("UPDATE works SET lifecycle='active' WHERE work_id=?").run(watchId);
  works.getProjection = getProjection; works.getWork = getWork; works.listWorks = listWorks;
  const fullReport = "完整成果".repeat(12000);
  db.connection.prepare(`INSERT INTO work_deliverables(deliverable_id,work_id,producer_bot_id,execution_id,intent_revision,owner_epoch,
    input_snapshot_id,status,summary,created_at) VALUES ('long-report',?,'owner','test-execution',1,1,?,'proposed',?,1)`)
    .run(watchId, base.inputSnapshotId, fullReport);
  const reportSummary = await invoke({ view: "summary", workId: watchId });
  assert.equal(reportSummary.items[0].latestDeliverableSummary, fullReport.slice(0, 400));
  assert.equal(reportSummary.items[0].latestDeliverableStatus, "proposed");
  const details = await invoke({ workId: watchId });
  assert(Array.isArray(details)); assert.equal(details[0].deliverables[0].summary, fullReport);
  assert.deepEqual(await invoke({ workId: "work-scale-08000" }), []);
  assert.deepEqual(await invoke({ workId: "work-scale-06001" }), []);
  // Only returned rows acquire request-scoped control guards, not all 6002 rows.
  const readCount = db.connection.prepare("SELECT COUNT(*) n FROM bot_work_reads").get() as { n: number };
  assert(readCount.n < 80);
  // Daily review must find old commitments without loading every recent Work.
  for (let i = 0; i < 75; i++) works.repo.insertWork({ ...base,
    workId: `daily-${String(i).padStart(3, "0")}`, title: `Daily commitment ${i}`,
    createdAt: 900000 + Math.floor(i / 2), updatedAt: 900000 + i,
    deadlineAt: i < 10 ? 5000 + Math.floor(i / 2) : i < 70 ? 10000 : undefined });
  assert(!query.page({ search: "Daily commitment" }).items.some(item => item.deadlineAt !== null && item.deadlineAt < 6000),
    "baseline reproduction: latest-created default hides every old urgent commitment");
  const dueInput = { view: "summary", search: "Daily commitment", deadlineBefore: 6000, sort: "deadline_asc", limit: 3 };
  assert(Value.Check(schema, dueInput), "daily review schema must support deadline filtering and priority sorting");
  const duePage = await invoke(dueInput);
  assert.equal(duePage.total, 10, "old due commitments are counted independently of the latest page");
  assert.deepEqual(duePage.items.map((item: { workId: string }) => item.workId), ["daily-001", "daily-000", "daily-003"]);
  const dueIds = new Set<string>();
  let due = duePage;
  do {
    for (const item of due.items) { assert(!dueIds.has(item.workId)); dueIds.add(item.workId); }
    if (!due.nextQuery) break;
    assert.equal(due.nextQuery.deadlineBefore, 6000); assert.equal(due.nextQuery.sort, "deadline_asc");
    due = await invoke(due.nextQuery);
  } while (true);
  assert.equal(dueIds.size, 10, "equal-deadline pagination has no skips or duplicates");
  const allDailyIds = new Set<string>();
  let daily = await invoke({ view: "summary", search: "Daily commitment", sort: "deadline_asc", limit: 3 });
  let lastDeadline = -1, sawNull = false;
  do {
    for (const item of daily.items) {
      assert(!allDailyIds.has(item.workId)); allDailyIds.add(item.workId);
      if (item.deadlineAt === null) sawNull = true;
      else { assert(!sawNull, "no-deadline rows sort last"); assert(item.deadlineAt >= lastDeadline); lastDeadline = item.deadlineAt; }
    }
    if (!daily.nextQuery) break;
    daily = await invoke(daily.nextQuery);
  } while (true);
  assert.equal(allDailyIds.size, 75); assert(sawNull);
  assert.equal((await invoke({ view: "summary", search: "Daily commitment", deadlineFrom: 5001, deadlineBefore: 5003 })).total, 4);
  assert.equal((await invoke({ view: "summary", search: "Daily commitment", deadlineBefore: 5000 })).total, 0);
  assert.equal((await invoke({ view: "summary", search: "Daily commitment", deadlineFrom: 10000 })).total, 60);
  db.connection.prepare(`INSERT INTO work_blockers(blocker_id,work_id,reason,kind,waiting_for_user_input,status,created_at)
    VALUES ('daily-input-1','daily-000','确认交付范围','operational',1,'open',1),
      ('daily-input-2','daily-002','确认预算','operational',1,'open',1),
      ('daily-cleared','daily-003','已确认','operational',1,'cleared',1),
      ('daily-machine','daily-004','服务维护','operational',0,'open',1)`).run();
  const waiting = await invoke({ view: "summary", search: "Daily commitment", needsUserInput: true, deadlineBefore: 6000, sort: "deadline_asc", limit: 1 });
  assert.equal(waiting.total, 2); assert.equal(waiting.items[0].workId, "daily-000");
  assert.equal(waiting.items[0].tracking.reason, "确认交付范围");
  assert.equal(waiting.nextQuery.needsUserInput, true);
  assert.equal((await invoke(waiting.nextQuery)).items[0].workId, "daily-002");
  const noInput = await invoke({ view: "summary", search: "Daily commitment", needsUserInput: false, limit: 1 });
  assert.equal(noInput.total, 73); assert.equal(noInput.nextQuery.needsUserInput, false);
  for (const change of [{ deadlineBefore: 5009 }, { deadlineFrom: 5001 }, { needsUserInput: true }, { sort: "created_desc" }])
    await assert.rejects(invoke({ ...duePage.nextQuery, ...change }), /不匹配/);
  for (const invalid of [{ deadlineFrom: -1 }, { deadlineBefore: 2.5 }, { deadlineBefore: Number.MAX_SAFE_INTEGER + 1 },
    { needsUserInput: "true" }, { sort: "deadline_desc" }]) assert.equal(Value.Check(schema, invalid), false);
  await assert.rejects(invoke({ deadlineFrom: 5, deadlineBefore: 5 }), /窗口无效/);
  await assert.rejects(invoke({ deadlineFrom: 6, deadlineBefore: 5 }), /窗口无效/);
  for (const extra of [{ deadlineFrom: 0 }, { deadlineBefore: 0 }, { needsUserInput: false }, { sort: "deadline_asc" }])
    await assert.rejects(invoke({ workId: watchId, ...extra }), /列表筛选/);
  assert.equal(new BotWorkQuery(db.connection, LOCAL_USER_ID, "outsider").page({ search: "Daily commitment", deadlineBefore: 6000 }).total, 0);
  assert.equal(new BotWorkQuery(db.connection, "another-user", "owner").page({ search: "Daily commitment", needsUserInput: true }).total, 0);
  db.connection.prepare("UPDATE works SET lifecycle='closed' WHERE work_id='daily-000'").run();
  const openWaiting = await invoke({ view: "summary", search: "Daily commitment", needsUserInput: true });
  assert.equal(openWaiting.total, 1); assert.equal(openWaiting.statusCounts.closed, 1);
  assert.equal((await invoke({ view: "summary", search: "Daily commitment", needsUserInput: true, status: "closed" })).total, 1);
  db.connection.prepare("UPDATE work_blockers SET status='cleared' WHERE blocker_id='daily-input-2'").run();
  assert.equal((await invoke({ view: "summary", search: "Daily commitment", needsUserInput: true })).total, 0,
    "resolved user inputs disappear immediately without changing unrelated Work state");
  db.connection.pragma("wal_checkpoint(TRUNCATE)");
  console.log(`PASS real SQLite 12076 Work, ${Math.round(statSync(join(root, "app.db")).size / 1024 / 1024)}MB: ${elapsed.toFixed(1)}ms first page, ${searchElapsed.toFixed(1)}ms search, ${sparseElapsed.toFixed(1)}ms sparse-member, ${JSON.stringify(page).length} chars, no hydration/projections, exact counts, stable traversal, cross-user isolation, original detail and watch schedule`);
} finally { db.close(); rmSync(root, { recursive: true, force: true }); }
