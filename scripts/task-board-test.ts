import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { ArtifactRepository } from "../src/main/artifact/ArtifactRepository";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { BotConversationRepository } from "../src/main/agent/work/BotConversationRepository";
import { botWorkspaceSpaceId } from "../src/main/agent/work/BotWorkspaceNavigationService";
import { LOCAL_USER_ID, DEFAULT_BOT_ID } from "../src/shared/bot-work";
import { TaskBoardRepository } from "../src/main/task/TaskBoardRepository";
import { CodeReviewService } from "../src/main/agent/CodeReviewService";

const dir = mkdtempSync(join(tmpdir(), "mybuddy-board-"));
const path = join(dir, "app.db");
let db = new AppDatabase(path);
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
  let board = new TaskBoardRepository(db.connection);
  const ids = (view: Parameters<typeof board.page>[0]) => board.page(view, now).rows.map((r) => r.id);
  assert.equal(board.page({ view: "recent" }, now).rows[0]?.request?.messageId, prior.assistantMessageId);
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
  assert.deepEqual(ids({ view: "frequent" }), []);
  board.action("report", "read", now);
  assert.deepEqual(ids({ view: "frequent" }), [], "opening a home recommendation never feeds its own rank");
  board.action("report", "visit", now);
  assert.deepEqual(ids({ view: "frequent" }), ["report"]);
  assert.equal(board.page({ view: "frequent" }).rows[0].status, "completed");
  assert.deepEqual(ids({ view: "recent", scope: null }), ["quote"]);
  assert.deepEqual(ids({ view: "dates", dateKind: "follow", from: day(-35), until: day(-34) }), ["quote"]);
  assert.deepEqual(ids({ view: "dates", dateKind: "due", from: day(4), until: day(5) }), ["quote"]);
  assert.deepEqual(ids({ view: "dates", dateKind: "due", from: day(3), until: day(4) }), []);
  assert.equal(board.page({ view: "attention" }, now).rows[0].messageId, "msg");
  board.action("waiting", "later", now);
  assert.deepEqual(ids({ view: "attention" }), []);
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
    board.page({ view: "attention" }, now + 1).rows.map((r) => r.id),
    ["waiting"],
  );
  assert.equal(board.page({ view: "attention" }, now + 1).rows[0].messageId, "new-msg");
  board.action("quote", "today", now);
  assert.ok(ids({ view: "today" }).includes("quote"));
  board.action("quote", "later", now);
  assert.ok(!ids({ view: "today" }).includes("quote"));
  assert.ok(board.page({ view: "attention" }, day(1)).rows.some((r) => r.id === "quote"));
  let cursor: Parameters<typeof board.page>[0]["cursor"];
  const unique = new Set<string>();
  do {
    const page = board.page({ view: "all", search: "例行同步", cursor }, now);
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
  const attentionLane = board.page({ ...laneQuery, lane: "attention" }, now);
  assert.deepEqual(attentionLane.rows.map((row) => row.id), ["old-approval"], "an old approval remains on the first page beside 1,000 newer results");
  assert.equal(attentionLane.total, 1);
  assert.deepEqual(attentionLane.rows[0].wait, { kind: "approval", reason: "同意更新共享库存表？" });
  assert.equal(attentionLane.rows[0].messageId, "approval-message");
  const firstFinished = board.page({ ...laneQuery, lane: "finished" }, now);
  const nextFinished = board.page({ ...laneQuery, lane: "finished", cursor: firstFinished.next }, now);
  assert.equal(firstFinished.total, 1000);
  assert.equal(nextFinished.total, 1000, "a lane total includes rows before its cursor");
  assert.deepEqual(firstFinished.rows.slice(0, 2).map((row) => row.id), ["auto-0", "auto-1"]);
  assert.ok(firstFinished.rows.length < 25 && firstFinished.rows.length > 1, "only a bounded set of results renders in a lane");
  assert.equal(new Set([...firstFinished.rows, ...nextFinished.rows].map((row) => row.id)).size, firstFinished.rows.length + nextFinished.rows.length);
  assert.equal(board.page({ ...laneQuery, lane: "running" }, now).total, 0);
  board.follow("old-approval", "用户上传了本周数据", now);
  const recentApproval = board.page({ view: "recent", search: "例行同步审批" }, now).rows[0];
  assert.equal(recentApproval.reason, "用户上传了本周数据");
  assert.equal(recentApproval.wait?.reason, "同意更新共享库存表？", "follow-up history cannot conceal the current blocker");
  board.patch({ type: "tool_update", taskId: "old-approval", messageId: "approval-message", toolCallId: "old-approval-tool", status: "denied" });
  assert.equal(board.page({ ...laneQuery, lane: "attention" }, now).total, 0);
  assert.deepEqual(ids({ ...laneQuery, lane: "pending" }), ["old-approval"]);

  assert.deepEqual(ids({ view: "running", scope: null }), ["quote"], "a running task remains discoverable without a fresh action");
  const review = new CodeReviewService(db.connection);
  const reviewFile = join(dir, "old-report.txt");
  const finishCapture = review.capture("report", dir, reviewFile);
  writeFileSync(reviewFile, "更新的报告\n");
  await finishCapture?.();
  const reviewPreview = board.page({ view: "review", scope: null, preview: true }, now);
  assert.deepEqual(reviewPreview.rows.map((row) => [row.id, row.pendingReviewCount]), [["report", 1]], "an old task with a real recorded file change reaches focus");
  assert.equal(reviewPreview.total, 1);
  const reviewFileId = review.list("report")[0].id;
  await review.decide({ taskId: "report", ids: [reviewFileId], action: "accept" }, () => dir, async (_path, operation) => operation());
  assert.equal(board.page({ view: "review", scope: null, preview: true }, now).total, 0, "accepted changes drop out of the pending review group");

  assert.deepEqual(ids({ view: "results", preview: true }), []);
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
  const grouped = board.page({ view: "automation" }).rows;
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].status, "completed");
  assert.match(grouped[0].reason!, /2 次/);
  assert.deepEqual(ids({ view: "automation", jobId: "job" }), ["auto-2", "auto-1"]);
  db.close();
  db = new AppDatabase(path);
  board = new TaskBoardRepository(db.connection);
  assert.deepEqual(ids({ view: "frequent" }), ["report"]);
  assert.deepEqual(ids({ view: "later" }).sort(), ["quote", "waiting"]);
  console.log(
    "PASS lane paging with 1,000 results, wait routing, running and review focus, historical dates, activity, scheduled runs and restart",
  );
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
