/**
 * 「最后活动时间」契约：一个字段、一条规则、一个写入口。
 *
 * 事故回顾：durable 实时占位行用 `turnStartedAt ?? 0` 当 createdAt，渲染层把「最后一条消息的
 * createdAt」直接当任务时间，侧栏于是显示「20774 天」（epoch 0 到今天的天数），而
 * `tasks.updated_at` 一直是对的——补丁全打在显示层所以永远治不好。
 *
 * 本用例锁住四件事：
 *   1. 领域规则：什么是真实时刻、只许前进、非法候选值永不获胜；
 *   2. 显示层：未知时间渲染成「—」，不得生成任何天数；
 *   3. DB 写入：upsertTask 不接受把时间写成 0 或往回写；
 *   4. durable 历史投影：「最近活动」与投影窗口无关，且不会被 0 污染。
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "mybuddy-activity-time-test-"));
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;
process.on("exit", () => rmSync(sandbox, { recursive: true, force: true }));

const {
  advanceActivity,
  activityTimeOrUndefined,
  isActivityTime,
  latestActivityTime,
} = await import("../shared/src/activity-time");
const { relativeTime } = await import("../src/renderer/src/store/app/format");
const { mapTaskRowToTask } = await import("../src/renderer/src/store/app/tasks/taskMapper");
const { AppDatabase } = await import("../src/main/db/AppDatabase");
const { TaskContextUsageWrites } = await import("../src/main/agent/TaskContextUsageWrites");
const { locateRuntimeAudit } = await import("../src/main/platform/runtime-audit");
const { DurableHistoryProjection } = await import("../src/main/agent/durable/DurableHistoryProjection");

const INSTANT = 1_700_000_000_000;

function invalidValues(): unknown[] {
  return [0, -1, -INSTANT, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined, null, "", "1700000000000", {}, []];
}

// 1. 领域规则 -----------------------------------------------------------------
for (const value of invalidValues()) {
  assert.equal(isActivityTime(value), false, `${String(value)} is not an instant`);
  assert.equal(activityTimeOrUndefined(value), undefined, `${String(value)} has no instant`);
}
assert.equal(isActivityTime(INSTANT), true);
assert.equal(activityTimeOrUndefined(INSTANT), INSTANT);

assert.equal(latestActivityTime(0, undefined, Number.NaN, INSTANT, INSTANT - 5_000), INSTANT);
assert.equal(latestActivityTime(0, undefined, Number.NaN), undefined, "no valid candidate means unknown, not now");

assert.equal(advanceActivity(INSTANT, INSTANT + 1_000), INSTANT + 1_000, "a newer instant advances");
assert.equal(advanceActivity(INSTANT, INSTANT - 1_000), INSTANT, "an older instant never rewinds");
assert.equal(advanceActivity(INSTANT, 0), INSTANT, "epoch 0 never wins over a real instant");
assert.equal(advanceActivity(INSTANT, Number.NaN), INSTANT, "NaN never wins over a real instant");
assert.equal(advanceActivity(undefined, INSTANT), INSTANT, "a real instant is adopted when nothing is stored");
assert.equal(advanceActivity(undefined, 0, 42), 42, "with nothing valid on either side the caller's clock is the honest answer");
assert.equal(advanceActivity(0, 0, 42), 42, "a stored epoch 0 is not an instant either");

// 2. 显示层 -------------------------------------------------------------------
const now = Date.now();
assert.equal(relativeTime(0), "—", "epoch 0 must never render as 20774 days");
assert.equal(relativeTime(undefined), "—");
assert.equal(relativeTime(Number.NaN), "—");
assert.equal(relativeTime(now), "刚刚");
assert.equal(relativeTime(now + 60_000), "刚刚", "a clock skew into the future is not a negative age");
assert.equal(relativeTime(now - 5 * 60_000), "5分钟前");
assert.equal(relativeTime(now - 5 * 60_000, { compact: true }), "5分钟");
assert.equal(relativeTime(now - 3 * 3_600_000), "3小时前");
assert.equal(relativeTime(now - 3 * 3_600_000, { compact: true }), "3小时");
assert.equal(relativeTime(now - 2 * 86_400_000), "2天前");
assert.equal(relativeTime(now - 2 * 86_400_000, { compact: true }), "2天");

// 3. DB 写入：唯一权威来源只许前进 ---------------------------------------------
const mapped = mapTaskRowToTask({ id: "task", title: "task", updatedAt: 0 }, {
  enabledModelIds: new Set<string>(),
  defaultModelId: "model",
  permissionModeDefault: "default",
});
assert.equal(isActivityTime(mapped.updatedAt), true, "a row read with a corrupt time still maps to a real instant");

const native = process.argv.includes("--native");
const runtimeAuditExecutable = native ? locateRuntimeAudit(process.cwd()) : undefined;
if (native) assert.ok(runtimeAuditExecutable && existsSync(runtimeAuditExecutable));
const db = new AppDatabase(join(sandbox, "app.db"), { runtimeAuditExecutable });
try {
  db.upsertTask({ id: "fresh", title: "fresh", updatedAt: 0, welcomeMode: "general" });
  assert.equal(isActivityTime(db.getTask("fresh")?.updatedAt), true, "a brand new row never starts at epoch 0");

  db.upsertTask({ id: "task", title: "task", updatedAt: INSTANT, welcomeMode: "general" });
  assert.equal(db.getTask("task")?.updatedAt, INSTANT);

  db.upsertTask({ id: "task", title: "renamed", updatedAt: 0, welcomeMode: "general" });
  assert.equal(db.getTask("task")?.updatedAt, INSTANT, "a projected epoch 0 is never written to tasks.updated_at");
  assert.equal(db.getTask("task")?.title, "renamed", "the rest of the row still updates");

  db.upsertTask({ id: "task", title: "task", updatedAt: INSTANT - 60_000, welcomeMode: "general" });
  assert.equal(db.getTask("task")?.updatedAt, INSTANT, "tasks.updated_at never moves backwards");

  db.upsertTask({ id: "task", title: "task", updatedAt: INSTANT + 60_000, welcomeMode: "general" });
  assert.equal(db.getTask("task")?.updatedAt, INSTANT + 60_000, "a newer instant is stored");

  db.setTaskContextUsage("fresh", 50, 4096, 0.5);
  if (native) db.connection.pragma("query_only = ON");
  const persisted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const writes = new TaskContextUsageWrites(async batch => {
    await db.writeTaskContextUsageBatch(batch).catch(error => { persisted.reject(error); throw error; });
    persisted.resolve();
    await release.promise;
  });
  try {
    writes.enqueue({ taskId: "task", usedTokens: 100, contextWindow: 4096, cacheHitRate: null });
    writes.enqueue({ taskId: "task", usedTokens: 300, contextWindow: 4096, cacheHitRate: 0.25 });
    await persisted.promise;
    assert.deepEqual(db.getTaskContextUsage("task"), { usedTokens: 300, contextWindow: 4096, cacheHitRate: 0.25 });

    writes.enqueue({ taskId: "task", usedTokens: 120, contextWindow: 8192, cacheHitRate: null });
    writes.enqueue({ taskId: "fresh", usedTokens: null, contextWindow: 4096, cacheHitRate: null });
    assert.deepEqual(writes.latest("task"), { taskId: "task", usedTokens: 120, contextWindow: 8192, cacheHitRate: null });
    assert.equal(db.getTaskContextUsage("task")?.usedTokens, 300);
  } finally {
    release.resolve();
    await writes.close();
  }
  assert.deepEqual(db.getTaskContextUsage("task"), { usedTokens: 120, contextWindow: 8192, cacheHitRate: null });
  assert.equal(db.getTaskContextUsage("fresh"), null);
  assert.equal(db.getTask("task")?.updatedAt, INSTANT + 60_000);
  console.log("PASS latest context usage survives a pending write and preserves activity time");
} finally {
  await db.runtimeAuditReader?.close();
  db.close();
}

// 4. durable 历史投影：最近活动与窗口无关 -------------------------------------
type Entry = Parameters<(typeof DurableHistoryProjection)["prototype"]["merge"]>[0][number];
const userEntry = (id: number, timestamp: number): Entry => ({
  id: id as Entry["id"],
  conversationId: 1 as Entry["conversationId"],
  kind: "mybuddy.user",
  model: [{ role: "user", content: [{ type: "text", text: `message ${id}` }], timestamp }],
});

const history = new DurableHistoryProjection();
history.merge([userEntry(10, 0)], new Map(), {});
assert.equal(history.observedAt, undefined, "an entry without a timestamp is not an activity instant");
assert.equal(history.turnStartedAt, undefined);

history.merge([userEntry(12, INSTANT)], new Map(), {});
assert.equal(history.observedAt, INSTANT);
assert.equal(history.turnStartedAt, INSTANT);

history.merge([userEntry(14, 0), userEntry(16, INSTANT - 1_000)], new Map(), {});
assert.equal(history.observedAt, INSTANT, "the newest observed instant is remembered, even after rows leave the window");
assert.equal(history.turnStartedAt, INSTANT, "a zero timestamp never clears the turn start");

console.log("PASS activity time has one rule: valid instants only, monotonic, unknown rendered as —");
