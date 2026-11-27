import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { BoardQuery } from "../src/shared/task-board";
import { DOTS_TASK_ID } from "../src/shared/dots";
import { encodeCronPlan } from "../src/main/db/CronPlanPersistence";
import { shutdownCoreWorker } from "../src/main/platform/core-client";
import { locateRuntimeAudit, RuntimeAuditReader } from "../src/main/platform/runtime-audit";
import { TaskBoardRepository } from "../src/main/task/TaskBoardRepository";

const executable = process.env.RUNTIME_AUDIT_BINARY ?? locateRuntimeAudit(process.cwd());
assert(executable && existsSync(executable), "This test requires the supervised Core worker");
const root = realpathSync(mkdtempSync(join(tmpdir(), "mybuddy-core-task-board-")));
const database = join(root, "app.duckdb");
const ui = new RuntimeAuditReader(executable, database, { coreDataDirectory: root });
const host = new RuntimeAuditReader(executable, database, { coreDataDirectory: root, coreRole: "background-service" });
const board = new TaskBoardRepository({ core: ui });
const hostBoard = new TaskBoardRepository({ core: host });
const now = Date.now() - 1000;
function day(offset: number) {
  const local = new Date(now);
  local.setHours(0, 0, 0, 0);
  local.setDate(local.getDate() + offset);
  return local.getTime();
}
const put = async (task: Pick<Parameters<RuntimeAuditReader["upsertTaskRecord"]>[0], "id" | "title" | "status" | "dueAt" | "spaceId" | "isFavorited">) => {
  const result = await ui.upsertTaskRecord({ ...task, at: now, preserveTitle: false, preserveWorkspace: false });
  assert.equal(result?.status, "saved");
};
const ids = async (query: BoardQuery) => (await board.page(query, now)).rows.map(row => row.id);

try {
  assert.equal((await ui.upsertWorkspace({ id: "visible", name: "Visible", at: now }))?.status, "saved");
  assert.equal((await ui.upsertWorkspace({ id: "sp-gw-service", name: "Gateway", at: now }))?.status, "saved");
  for (const [id, title, spaceId] of [["working", "报价单", "visible"], ["unscoped", "Unscoped", undefined],
    ["gateway", "Gateway", "sp-gw-service"], ["gw-test", "Gateway task", "visible"],
    ["gateway-chat-" + "a".repeat(64), "Hidden gateway chat", undefined]] as const) {
    await put({ id, title, spaceId, status: "planning" });
  }
  assert.deepEqual(await ui.batch2Write({ kind: "openDots", at: now }), { ok: true });
  assert.deepEqual(await ids({ view: "all", scope: null }), ["unscoped"]);
  assert.deepEqual(await ids({ view: "all", scope: "visible" }), ["gw-test", "working"]);
  assert.equal((await ids({ view: "all" })).includes(DOTS_TASK_ID), false);
  assert.deepEqual((await board.page({ view: "all" }, now, { spaceIds: ["visible"] })).rows.map(row => row.id), ["working"]);
  assert.deepEqual((await board.page({ view: "all" }, now, { spaceIds: [] })).rows, []);
  assert.deepEqual(await ids({ view: "all", search: "报'价%" }), []);
  assert.equal((await host.setSidebarArchive({ kind: "space", id: "visible", archived: true, at: now }))?.status, "saved");
  await board.action("working", "today", now);
  assert.deepEqual(await ids({ view: "all", scope: "visible" }), []);
  assert.equal((await host.setSidebarArchive({ kind: "space", id: "visible", archived: false, at: now }))?.status, "saved");
  assert.deepEqual(await ids({ view: "today", scope: "visible" }), [], "hidden task was not scheduled while its workspace was archived");
  console.log("PASS native board binds search text and distinguishes unscoped, workspace and ordinary tasks");

  let releaseNote!: () => void;
  let enterNote!: () => void;
  const held = new Promise<void>(resolve => { releaseNote = resolve; });
  const entered = new Promise<void>(resolve => { enterNote = resolve; });
  const stalled = new TaskBoardRepository({ core: {
    taskBoard: ui.taskBoard.bind(ui),
    writeTaskBoardAction: ui.writeTaskBoardAction.bind(ui),
    async writeTaskBoardNote(note) {
      enterNote();
      await held;
      return ui.writeTaskBoardNote(note);
    },
  } });
  stalled.follow("working", "待写入的跟进", now);
  await entered;
  const deadline = new AbortController();
  try {
    const snapshot = await Promise.race([
      stalled.page({ view: "all", scope: null }, now),
      delay(2000, undefined, { signal: deadline.signal }).then(() => {
        throw new Error("page waited for a pending write on an unrelated task");
      }),
    ]);
    assert.deepEqual(snapshot.rows.map(row => row.id), ["unscoped"]);
  } finally {
    deadline.abort();
    releaseNote();
    await stalled.flush();
  }
  console.log("PASS native pages keep reading while an unrelated task's observation is pending");

  await put({ id: "waiting", title: "旧审批", status: "in_progress" });
  await put({ id: "quote", title: "历史跟进", status: "in_progress", dueAt: day(4), isFavorited: true });
  board.follow("quote", "初版报价", day(-2) + 10_000);
  board.follow("quote", "修订含税报价", day(-1) + 10_000);
  await Promise.all([board.action("quote", "visit", day(-3) + 42_000), hostBoard.action("waiting", "later", now)]);
  assert.deepEqual(await ids({ view: "frequent" }), ["quote"]);
  assert.deepEqual(await ids({ view: "later" }), ["waiting"]);
  assert.deepEqual(await ids({ view: "dates", dateKind: "due", from: day(4), until: day(5) }), ["quote"]);
  const recent = (await board.page({ view: "recent", search: "历史" }, now)).rows[0];
  assert.equal(recent?.reason, "修订含税报价");
  board.patch({ type: "tool_start", taskId: "waiting", messageId: "msg", toolCallId: "approval", tool: "shell",
    summary: "请批准操作", status: "pending_approval" });
  const attention = (await board.page({ view: "attention", search: "旧审批", preview: true }, Date.now())).rows[0];
  assert.deepEqual(attention?.wait, { kind: "approval", reason: "请批准操作" });
  assert.equal(attention?.toolCallId, "approval");
  assert.deepEqual(await ids({ view: "running", search: "旧审批" }), []);
  await hostBoard.action("quote", "today", now);
  assert.deepEqual(await ids({ view: "today", search: "历史" }), ["quote"]);
  await board.action("quote", "clear", now);
  assert.deepEqual(await ids({ view: "today", search: "历史" }), []);
  console.log("PASS day boundaries, activity, deferral and live approval projection through two clients");

  for (let index = 0; index < 23; index++) {
    await put({ id: `lane-${String(index).padStart(2, "0")}`, title: "连续分页", status: "completed" });
  }
  const query = { view: "all", lane: "finished", search: "连续分页" } as const;
  const seen: string[] = [];
  let cursor: BoardQuery["cursor"];
  do {
    const page = await board.page({ ...query, cursor }, now);
    assert.equal(page.total, 23);
    seen.push(...page.rows.map(row => row.id));
    cursor = page.next;
  } while (cursor && seen.length <= 23);
  assert.deepEqual(seen, Array.from({ length: 23 }, (_, i) => `lane-${String(i).padStart(2, "0")}`));
  await put({ id: "scheduled-task", title: "已完成自动化", status: "completed", spaceId: "visible" });
  const job = encodeCronPlan({ id: "review", name: "合同定时检查", scheduleType: "every", scheduleExpr: "1h", timezone: "UTC",
    enabled: true, prompt: "检查合同", createdAt: now, updatedAt: now, target: { kind: "task", taskId: "scheduled-task" } });
  assert.equal(await ui.writeCronPlan({ kind: "save", row: job, expected: null,
    guard: { tasks: ["scheduled-task"], projects: [], targetTaskId: "scheduled-task" } }), true);
  for (let index = 1; index <= 2; index++) {
    assert.equal(await host.writeCronRun({ kind: "record", run: { id: `run-${index}`, jobId: job.id,
      status: "success", startedAt: now - index * 1000, finishedAt: now, taskId: "scheduled-task" } }), true);
  }
  const jobs = await board.page({ view: "automation", scope: "visible", search: "定时" }, now);
  assert.deepEqual(jobs.rows.map(row => [row.id, row.status, row.reason]), [["review", "completed", "近 30 天运行 2 次 · 运行成功"]]);
  assert.equal((await board.page({ view: "automation", jobId: job.id }, now)).rows.length, 2);
  assert.deepEqual(await ids({ view: "automation", scope: null }), []);
  console.log("PASS cursor/count snapshot and automation drill-down use the real production board client");

  await put({ id: "terminal", title: "离线完成", status: "in_progress" });
  const endedAt = now + 100;
  assert.equal((await host.writeDurableTaskProjection({ kind: "snapshot", taskId: "terminal", status: "completed",
    activityAt: endedAt, workspaces: [] }))?.status, "applied");
  assert.equal((await host.writeDurableTaskProjection({ kind: "snapshot", taskId: "terminal", status: "completed",
    activityAt: endedAt + 1, workspaces: [] }))?.status, "applied");
  const results = { view: "results", from: day(0), until: day(1) } as const;
  assert.equal((await board.page({ ...results, search: "离线完成" }, now)).rows[0]?.at, endedAt);
  await put({ id: "artifact", title: "离线产物", status: "in_progress" });
  assert.equal((await host.writeArtifact<{ revision: number }>("artifact", "register-report", { kind: "register", row: {
    id: "report", task_id: "artifact", space_id: null, kind: "document", source_type: "workspace-file", entry_file: "report.md",
    root_dir: root, storage_path: null, version: 1, capabilities_json: "{}", title: "决算报告", mime_type: "text/markdown",
    created_by_message_id: null, created_by_tool_call_id: null, created_at: now, updated_at: now,
  } }))?.revision, 1);
  await host.writeArtifact("artifact", "refresh-report", { kind: "refresh", ids: ["report"], at: endedAt });
  const report = (await board.page({ ...results, search: "离线产物" }, now)).rows[0];
  assert.deepEqual([report?.at, report?.reason], [endedAt, "决算报告"]);
  await board.action("artifact", "read", endedAt + 1);
  assert.deepEqual(await ids({ ...results, search: "离线产物" }), []);
  const interaction = { id: "question", taskId: "terminal", executionId: "exec", assistantMessageId: "question-message",
    kindName: "short_text", title: "采用哪种口径？", optionsJson: "[]", allowCustom: 0, status: "pending", version: 1, createdAt: now };
  assert.ok((await ui.batch1Write<{ row: unknown }>({ kind: "interactionInsert", ...interaction }))?.row);
  const pending = (await board.page({ view: "attention", search: "离线完成" }, now)).rows[0];
  assert.deepEqual([pending?.interactionId, pending?.wait?.kind], ["question", "question"]);
  const settle = { kind: "interactionSettle", id: interaction.id, status: "resolved", answerJson: "{}", resolvedAt: endedAt };
  assert.deepEqual(await host.batch1Write({ ...settle, taskId: "artifact" }), { row: null });
  assert.ok((await host.batch1Write<{ row: unknown }>({ ...settle, taskId: "terminal" }))?.row);
  assert.equal((await board.page({ view: "recent", search: "离线完成" }, now)).rows[0]?.reason, interaction.title);
  console.log("PASS Core commits terminal, artifact and resolved question observations with their records");

  const userId = "user-local-primary";
  const botId = "board-bot";
  const conversationId = "board-bot-conversation";
  const requestId = "board-request";
  const bot = { op: "botUpsert", botId, userId, displayName: "Board bot", responsibilitySummary: "", expertProfileJson: "{}",
    memoryScopeJson: "{}", authorizationJson: "{}", foregroundAllowedToolsJson: "[]", notificationPolicyJson: "{}",
    status: "active", now, activeVersion: 1, expertId: "fixture", sourceRevision: "fixture", systemPromptHash: "fixture",
    allowedMcpIdsJson: "[]", allowedSkillIdsJson: "[]", allowedConnectorIdsJson: "[]", skillPackagesJson: "[]" };
  const message = { op: "botMsgInsert", botId, conversationId, requestId, workIdsJson: "[]", createdAt: now, updatedAt: now, orIgnore: false };
  const accepted = await host.batch4bWrite<{ ok: boolean }>({ op: "batch", ops: [bot,
    { op: "botConvInsert", botId, userId, conversationId, ingressKind: "desktop", sourceKind: "user", createdAt: now, updatedAt: now, orIgnore: false },
    { ...message, messageId: "question-to-bot", role: "user", text: "检查期末存量", status: "completed" },
    { ...message, messageId: "bot-answer", role: "assistant", text: "", status: "queued" },
    { op: "botSendReceiptInsert", botId, userId, conversationId, requestId, payloadHash: "board-request-hash",
      userMessageId: "question-to-bot", assistantMessageId: "bot-answer" },
  ] });
  assert.equal(accepted?.ok, true);
  const botRow = (await board.page({ view: "recent", search: "期末存量" }, now)).rows[0];
  assert.deepEqual([botRow?.request?.conversationId, botRow?.request?.messageId, botRow?.reason], [conversationId, "bot-answer", "检查期末存量"]);
  assert.deepEqual((await board.page({ view: "all", search: "期末存量" }, now, {})).rows, []);
  assert.deepEqual(await host.batch4bWrite({ op: "botMsgUpdate", messageId: "bot-answer", status: "completed", text: "完成", updatedAt: endedAt }), { ok: true });
  assert.equal((await board.page({ ...results, search: "期末存量" }, now)).rows[0]?.at, endedAt);
  await board.action(botRow.id, "visit", endedAt + 1);
  assert.deepEqual(await ids({ ...results, search: "期末存量" }), []);
  console.log("PASS native bot receipt and terminal status feed the board while ordinary views exclude bot requests");

  await put({ id: "failed-dispatch", title: "派发未成功", status: "failed" });
  const failure = await host.writeNotification({ kind: "publish", inApp: true, desktop: false, record: {
    id: "dispatch-failed", type: "task.failed", level: "error", sourceType: "task", taskId: "failed-dispatch", createdAt: now,
    title: "任务派发失败", body: "当前执行宿主不可用", dedupeKey: "failed-dispatch",
  } });
  assert.equal(failure?.status, "saved");
  const failed = (await board.page({ view: "attention", lane: "attention", search: "派发未成功" }, now)).rows[0];
  assert.deepEqual([failed?.id, failed?.status, failed?.failureReason], ["failed-dispatch", "failed", "当前执行宿主不可用"]);
  console.log("PASS failure details are visible on the attention card through the same DuckDB snapshot");

  await Promise.all([ui.close(), host.close()]);
  await shutdownCoreWorker(root, database);
  const reopened = new RuntimeAuditReader(executable, database, { coreDataDirectory: root });
  try {
    const persisted = new TaskBoardRepository({ core: reopened });
    assert.deepEqual((await persisted.page({ view: "later" }, now)).rows.map(row => row.id), ["waiting"]);
    const terminal = (await persisted.page({ ...results, search: "离线完成" }, now)).rows[0];
    assert.equal(terminal?.at, endedAt);
    assert.deepEqual((await persisted.page({ ...results, search: "离线产物" }, now)).rows, []);
    console.log("PASS deferral, result time and read action survive Core restart");
  } finally {
    await reopened.close();
  }
} finally {
  await Promise.all([ui.close(), host.close()]);
  await shutdownCoreWorker(root, database);
  rmSync(root, { recursive: true, force: true });
}
