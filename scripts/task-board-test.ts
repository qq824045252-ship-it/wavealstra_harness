import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { ArtifactRepository } from "../src/main/artifact/ArtifactRepository";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { BotConversationRepository } from "../src/main/agent/work/BotConversationRepository";
import { botWorkspaceSpaceId } from "../src/main/agent/work/BotWorkspaceNavigationService";
import { LOCAL_USER_ID, DEFAULT_BOT_ID } from "../src/shared/bot-work";
import { TaskBoardRepository } from "../src/main/task/TaskBoardRepository";
import { locateRuntimeAudit } from "../src/main/platform/runtime-audit";
import { CodeReviewService } from "../src/main/agent/CodeReviewService";
import { focusRows } from "../src/renderer/src/lib/taskBoardFocus";
import type { BoardPage, TaskBoardRow } from "../src/shared/task-board";

const useNative = process.argv.includes("--native");
const runtimeAuditExecutable = useNative ? locateRuntimeAudit(process.cwd()) : undefined;
if (useNative) assert.ok(runtimeAuditExecutable && existsSync(runtimeAuditExecutable));
const dir = mkdtempSync(join(tmpdir(), "mybuddy-board-"));
const path = join(dir, "app.db");
let db = new AppDatabase(path, { runtimeAuditExecutable });
const now = Date.now();
function day(offset: number) {
  const d = new Date(now);
  d.setDate(d.getDate() + offset);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
try {
  new ArtifactRepository(db.connection);
  new BotRegistry(db.connection).ensureDefaultBot(LOCAL_USER_ID);
  const bot = new BotConversationRepository(db.connection);
  db.upsertSpace({ id: botWorkspaceSpaceId(DEFAULT_BOT_ID), name: "历史工作空间" });
  const prior = bot.accept(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, requestId: "older", text: "历史对话" });
  let board = new TaskBoardRepository(db.connection, db.runtimeAuditReader);
  const ids = async (view: Parameters<typeof board.page>[0]) => (await board.page(view, now)).rows.map((r) => r.id);
  assert.equal((await board.page({ view: "recent" }, now)).rows[0]?.request?.messageId, prior.assistantMessageId);
  db.connection.transaction(() => {
    for (let i = 0; i < 1000; i++)
      db.upsertTask({ id: "auto-" + i, title: "例行同步", status: "completed", updatedAt: day(-7) });
  })();
  db.upsertTask({ id: "report", title: "参考报告", status: "completed", updatedAt: day(-35) });
  db.upsertTask({ id: "quote", title: "报价单", status: "in_progress", updatedAt: now, dueAt: day(4) });
  db.upsertTask({ id: "waiting", title: "旧审批", status: "pending", updatedAt: day(-42) });
  db.connection
    .prepare(
      "INSERT INTO conversation_interactions(id,task_id,execution_id,assistant_message_id,kind,title,status,created_at) VALUES (?,?,?,?,?,?,?,?)",
    )
    .run("ask", "waiting", "run", "msg", "short_text", "使用哪种口径？", "pending", day(-40));
  board.follow("quote", "原始需求", day(-35));
  board.follow("quote", "调整含税口径", day(-1));
  board.action("report", "visit", day(-2));
  board.action("report", "visit", day(-2) + 60_000);
  assert.deepEqual(await ids({ view: "frequent" }), []);
  board.action("report", "read", now);
  assert.deepEqual(await ids({ view: "frequent" }), [], "opening a home recommendation never feeds its own rank");
  board.action("report", "visit", now);
  assert.deepEqual(await ids({ view: "frequent" }), ["report"]);
  assert.equal((await board.page({ view: "frequent" })).rows[0].status, "completed");
  assert.deepEqual(await ids({ view: "recent", scope: null }), ["quote"]);
  assert.deepEqual(await ids({ view: "dates", dateKind: "follow", from: day(-35), until: day(-34) }), ["quote"]);
  assert.deepEqual(await ids({ view: "dates", dateKind: "due", from: day(4), until: day(5) }), ["quote"]);
  assert.deepEqual(await ids({ view: "dates", dateKind: "due", from: day(3), until: day(4) }), []);
  assert.equal((await board.page({ view: "attention" }, now)).rows[0].messageId, "msg");
  board.action("waiting", "later", now);
  assert.deepEqual(await ids({ view: "attention" }), []);
  board.patch({
    type: "tool_start",
    taskId: "waiting",
    messageId: "new-msg",
    toolCallId: "approval",
    tool: "shell",
    summary: "批准写入",
    status: "pending_approval",
  });
  assert.deepEqual(
    (await board.page({ view: "attention" }, now + 1)).rows.map((r) => r.id),
    ["waiting"],
  );
  assert.equal((await board.page({ view: "attention" }, now + 1)).rows[0].messageId, "new-msg");
  board.action("quote", "today", now);
  assert.ok((await ids({ view: "today" })).includes("quote"));
  board.action("quote", "later", now);
  assert.ok(!(await ids({ view: "today" })).includes("quote"));
  assert.ok((await board.page({ view: "attention" }, day(1))).rows.some((r) => r.id === "quote"));
  let cursor: Parameters<typeof board.page>[0]["cursor"];
  const unique = new Set<string>();
  do {
    const page = await board.page({ view: "all", search: "例行同步", cursor }, now);
    assert.ok(page.rows.length <= 25);
    for (const r of page.rows) {
      assert.ok(!unique.has(r.id));
      unique.add(r.id);
    }
    cursor = page.next;
  } while (cursor);
  assert.equal(unique.size, 1000);

  db.upsertTask({ id: "old-approval", title: "例行同步审批", status: "pending", updatedAt: day(-42) });
  board.patch({
    type: "tool_start",
    taskId: "old-approval",
    messageId: "approval-message",
    toolCallId: "old-approval-tool",
    tool: "shell",
    summary: "同意更新共享库存表？",
    status: "pending_approval",
  });
  const laneQuery = { view: "all", scope: null, search: "例行同步" } as const;
  const attentionLane = await board.page({ ...laneQuery, lane: "attention" }, now);
  assert.deepEqual(attentionLane.rows.map((row) => row.id), ["old-approval"], "an old approval remains on the first page beside 1,000 newer results");
  assert.equal(attentionLane.total, 1);
  assert.deepEqual(attentionLane.rows[0].wait, { kind: "approval", reason: "同意更新共享库存表？" });
  assert.equal(attentionLane.rows[0].messageId, "approval-message");
  const firstFinished = await board.page({ ...laneQuery, lane: "finished" }, now);
  const nextFinished = await board.page({ ...laneQuery, lane: "finished", cursor: firstFinished.next }, now);
  assert.equal(firstFinished.total, 1000);
  assert.equal(nextFinished.total, 1000, "a lane total includes rows before its cursor");
  assert.deepEqual(firstFinished.rows.slice(0, 2).map((row) => row.id), ["auto-0", "auto-1"]);
  assert.ok(firstFinished.rows.length < 25 && firstFinished.rows.length > 1, "only a bounded set of results renders in a lane");
  assert.equal(new Set([...firstFinished.rows, ...nextFinished.rows].map((row) => row.id)).size, firstFinished.rows.length + nextFinished.rows.length);
  assert.equal((await board.page({ ...laneQuery, lane: "running" }, now)).total, 0);
  board.follow("old-approval", "用户上传了本周数据", now);
  const recentApproval = (await board.page({ view: "recent", search: "例行同步审批" }, now)).rows[0];
  assert.equal(recentApproval.reason, "用户上传了本周数据");
  assert.equal(recentApproval.wait?.reason, "同意更新共享库存表？", "follow-up history cannot conceal the current blocker");
  board.patch({ type: "tool_update", taskId: "old-approval", messageId: "approval-message", toolCallId: "old-approval-tool", status: "denied" });
  assert.equal((await board.page({ ...laneQuery, lane: "attention" }, now)).total, 0);
  assert.deepEqual(await ids({ ...laneQuery, lane: "pending" }), ["old-approval"]);

  assert.deepEqual(await ids({ view: "running", scope: null }), ["quote"], "a running task remains discoverable without a fresh action");
  assert.equal(
    (await board.page({ view: "running", scope: null, preview: true }, now)).total,
    0,
    "a deferred running task stays out of the focus column until a new request arrives",
  );
  db.upsertTask({ id: "fresh-run", title: "新执行", status: "in_progress", updatedAt: now + 1 });
  assert.equal(
    (await board.page({ view: "running", scope: null, preview: true }, now)).total,
    1,
    "the running focus column reports its real total so a truncated column can say 还有 N 个被折叠",
  );
  const review = new CodeReviewService(db.connection);
  const reviewFile = join(dir, "old-report.txt");
  const finishCapture = review.capture("report", dir, reviewFile);
  writeFileSync(reviewFile, "更新的报告\n");
  await finishCapture?.();
  const reviewPreview = await board.page({ view: "review", scope: null, preview: true }, now);
  assert.deepEqual(reviewPreview.rows.map((row) => [row.id, row.pendingReviewCount]), [["report", 1]], "an old task with a real recorded file change reaches focus");
  assert.equal(reviewPreview.total, 1);
  const reviewFileId = review.list("report")[0].id;
  await review.decide({ taskId: "report", ids: [reviewFileId], action: "accept" }, () => dir, async (_path, operation) => operation());
  assert.equal((await board.page({ view: "review", scope: null, preview: true }, now)).total, 0, "accepted changes drop out of the pending review group");

  assert.deepEqual(await ids({ view: "results", preview: true }), []);
  db.connection
    .prepare(
      "INSERT INTO cron_jobs(id,name,prompt,schedule_type,schedule_expr,created_at,updated_at) VALUES('job','库存同步','','cron','* * * * *',?,?)",
    )
    .run(now, now);
  const run = db.connection.prepare(
    "INSERT INTO cron_runs(id,job_id,task_id,started_at,status) VALUES(?,'job',?,?,?)",
  );
  run.run("one", "auto-1", day(-2), "error");
  run.run("two", "auto-2", day(-1), "success");
  const grouped = (await board.page({ view: "automation" })).rows;
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].status, "completed");
  assert.match(grouped[0].reason!, /2 次/);
  assert.deepEqual(await ids({ view: "automation", jobId: "job" }), ["auto-2", "auto-1"]);
  await db.runtimeAuditReader?.close();
  db.close();
  db = new AppDatabase(path, { runtimeAuditExecutable });
  board = new TaskBoardRepository(db.connection, db.runtimeAuditReader);
  assert.deepEqual(await ids({ view: "frequent" }), ["report"]);
  assert.deepEqual((await ids({ view: "later" })).sort(), ["quote", "waiting"]);
  db.connection.transaction(() => {
    for (let i = 0; i < 5; i++)
      db.upsertTask({ id: `run-${i}`, title: `在跑任务 ${i}`, status: "in_progress", updatedAt: now + i });
  })();
  const crowdedRunning = await board.page({ view: "running", scope: null, preview: true }, now);
  assert.equal(crowdedRunning.total, 6, "every running task counts toward the focus column total");
  assert.equal(crowdedRunning.rows.length, 4, "the focus preview page stays bounded at four cards");
  assert.ok(crowdedRunning.next, "a column with more than four running tasks can continue into 查看全部");

  // 「我的焦点」纯函数：每栏 4 张、折叠数、跨栏共存都必须能被界面直接读出来。
  const row = (id: string): TaskBoardRow => ({
    id,
    title: id,
    spaceId: null,
    status: "in_progress",
    updatedAt: now,
    pinned: false,
    unread: false,
    at: now,
    rank: 0,
    planned: false,
  });
  const focusPage = (ids: string[], extra: Partial<BoardPage> = {}): BoardPage => ({
    rows: ids.map(row),
    ...extra,
  });
  const focus = (pages: Partial<Record<number, BoardPage>>) =>
    focusRows(Array.from({ length: 8 }, (_, i) => pages[i]));
  const everyColumn = focusRows(
    [0, 1, 2, 3, 4, 5, 6, 7].map(() => focusPage(["a", "b", "c", "d"])),
  );
  assert.deepEqual(
    everyColumn.map((section) => section.rows.length),
    [4, 4, 4, 4, 4, 4, 4, 4],
    "every focus column renders four cards",
  );
  assert.deepEqual(
    everyColumn.map((section) => section.more),
    [false, false, false, false, false, false, false, false],
    "nothing is reported as folded when the page already holds everything",
  );
  const shared = focus({ 1: focusPage(["a"]), 2: focusPage(["a", "b", "c", "d"]) });
  assert.deepEqual(shared[1].rows.map((r) => r.id), ["a"]);
  assert.deepEqual(
    shared[2].rows.map((r) => r.id),
    ["a", "b", "c", "d"],
    "a running task still shows in 正在执行 even when 待审查的改动 already lists it",
  );
  assert.equal(shared[2].more, false, "each column only reports its own folded items");
  const crowded = focus({
    2: focusPage(["a", "b", "c", "d"], { total: 6, next: { rank: 0, at: now, id: "d" } }),
  });
  assert.equal(crowded[2].rows.length, 4);
  assert.equal(crowded[2].folded, 2, "a known total yields the exact folded count");
  assert.equal(crowded[2].exact, true);
  assert.equal(crowded[2].more, true);
  const unknownTotal = focus({ 3: focusPage(["x", "y", "z", "w"], { next: { rank: 0, at: now, id: "w" } }) });
  assert.equal(unknownTotal[3].rows.length, 4, "最近在做 also renders four cards");
  assert.equal(unknownTotal[3].exact, false, "an unknown total only claims 还有更多");
  assert.equal(unknownTotal[3].more, true, "an unknown total still reports that more work is folded");
  console.log(
    "PASS lane paging with 1,000 results, wait routing, running and review focus, historical dates, activity, scheduled runs, focus folding and restart",
  );
} finally {
  await db.runtimeAuditReader?.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
