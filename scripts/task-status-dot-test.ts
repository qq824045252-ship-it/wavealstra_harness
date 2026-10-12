/**
 * 侧栏状态点回归（bug: 绿点一直存在、点击不清除）。
 *
 * 约定：
 *  - 进行中 → 蓝点（getTaskDisplayStatus === "running"）
 *  - 已结束且未查看 → 绿点（isTaskDoneUnread === true）
 *  - 点击/打开任务 → ackTaskDone 写 done_acked_at → 绿点消失，且重启（重开 DB）后保持消失
 *  - 结束后再次运行并产出新消息 → 绿点自然回来
 *
 * 两层验证：
 *  A. 渲染层判定（utils/taskFilters）— 纯函数，无需 Electron
 *  B. DB 层（AppDatabase）— done_acked_at 建列/回填迁移、ackTaskDone、upsertTask 不退回未确认
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import {
  getTaskDisplayStatus,
  isTaskDoneUnread,
  taskCompletionMark,
} from "../src/renderer/src/utils/taskFilters";
import type { ChatMessage, Task } from "../src/renderer/src/types";

let passed = 0;
let failed = 0;
function assert(cond: unknown, label: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

function message(createdAt: number, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id: `m-${createdAt}`, role: "assistant", createdAt, blocks: [], ...extra };
}

function task(overrides: Partial<Task> = {}): Task {
  return { id: "t1", title: "任务", updatedAt: 0, messages: [], ...overrides };
}

console.log("== A. 展示状态判定（蓝点 / 绿点 / 无点）==");

// 进行中 = 蓝点，且绝不带绿点
const running = task({
  status: "in_progress",
  updatedAt: 500,
  messages: [message(1000, { streaming: true })],
});
assert(getTaskDisplayStatus(running) === "running", "进行中 → running（蓝点）");
assert(!isTaskDoneUnread(running), "进行中不带绿点");

// status 缺失时由消息推导：streaming → in_progress
const derivedRunning = task({ updatedAt: 500, messages: [message(1000, { streaming: true })] });
assert(getTaskDisplayStatus(derivedRunning) === "running", "无 status 时 streaming 消息 → running");

// 已结束 + 从未查看 → 绿点
const finishedUnread = task({
  status: "completed",
  updatedAt: 4000,
  messages: [message(1000), message(3000)],
});
assert(getTaskDisplayStatus(finishedUnread) === "done", "completed → done（已结束）");
assert(isTaskDoneUnread(finishedUnread), "已结束且从未查看 → 绿点");

// 失败同样算「已结束」，也要有绿点（但要等用户看过）
const failedUnread = task({ status: "failed", updatedAt: 4000, messages: [message(3000)] });
assert(isTaskDoneUnread(failedUnread), "失败且未查看 → 绿点");

// 打开过（doneAckedAt 追平完成标记）→ 无绿点（这就是「点击后绿点消失」）
const acked = task({
  status: "completed",
  updatedAt: 4000,
  doneAckedAt: taskCompletionMark(finishedUnread),
  messages: [message(1000), message(3000)],
});
assert(!isTaskDoneUnread(acked), "确认过（doneAckedAt = 完成标记）→ 绿点消失");
assert(getTaskDisplayStatus(acked) === "done", "确认后状态仍是「已结束」（只是不再亮绿点）");

// 结束后再次运行并产出新消息 → 绿点回来
const rerunUnread = task({
  status: "completed",
  updatedAt: 9000,
  doneAckedAt: 3000,
  messages: [message(1000), message(3000), message(8000)],
});
assert(isTaskDoneUnread(rerunUnread), "确认后又产出新结果 → 绿点回来");

// 噪声边界：重命名/置顶/归档会推进 updatedAt，但不得让绿点复活
const renamedAfterAck = task({
  status: "completed",
  updatedAt: 99_999,
  doneAckedAt: 3000,
  messages: [message(1000), message(3000)],
});
assert(
  !isTaskDoneUnread(renamedAfterAck),
  "确认后仅 updatedAt 变化（重命名/置顶）→ 绿点不复活（完成标记取消息时间）",
);

// 待确认（等待用户批准）优先于「已结束」，显示为「待确认」徽标而不是绿点
const awaitingApproval = task({
  status: "completed",
  updatedAt: 4000,
  messages: [
    message(3000, {
      blocks: [
        {
          type: "tool",
          toolCall: { id: "c1", tool: "bash", summary: "rm -rf build", status: "pending_approval" },
        },
      ],
    }),
  ],
});
assert(getTaskDisplayStatus(awaitingApproval) === "pending", "待审批 → pending（徽标，不是绿点）");
assert(!isTaskDoneUnread(awaitingApproval), "待审批期间不亮绿点");

// 空闲：planning（尚无消息）不亮任何点
const planning = task({ status: "planning", updatedAt: 4000 });
assert(getTaskDisplayStatus(planning) === "idle", "planning（无消息）→ idle，无点");
assert(!isTaskDoneUnread(planning), "planning 不亮绿点");

// 已知边界：无消息的失败用 updatedAt 兜底（没有消息可当完成标记）
const failedNoMessage = task({ status: "failed", updatedAt: 7000 });
assert(taskCompletionMark(failedNoMessage) === 7000, "无消息时完成标记退回 updatedAt");
assert(isTaskDoneUnread(failedNoMessage), "无消息的失败在未确认前仍亮绿点");

// 骨架任务（缺 messages 的部分对象，如测试夹具/store 中途构造）：状态判定不得抛异常
const skeleton = { id: "skeleton", title: "骨架任务", updatedAt: 5000 } as unknown as Task;
assert(getTaskDisplayStatus(skeleton) === "idle", "缺 messages 的骨架任务 → idle（不抛异常）");
assert(!isTaskDoneUnread(skeleton), "缺 messages 的骨架任务不亮绿点");

// 消息缺 blocks 的部分对象（setActiveTask 会走状态判定，不能因此把 store 打崩）
const blockless = task({
  status: undefined,
  updatedAt: 6000,
  messages: [{ id: "m1", role: "user", createdAt: 6000 } as unknown as ChatMessage],
});
assert(getTaskDisplayStatus(blockless) === "done", "缺 blocks 的消息按空块处理（无 pending）→ done");
assert(isTaskDoneUnread(blockless), "缺 blocks 的已结束任务照常亮绿点");

console.log("== B. DB 层（done_acked_at 持久化 + 老库回填）==");

const root = mkdtempSync(join(tmpdir(), "task-status-dot-"));
try {
  const dbPath = join(root, "app.db");
  const db = new AppDatabase(dbPath);
  db.upsertTask({ id: "t-ack", title: "已完成任务", status: "completed", updatedAt: 1000 });
  assert(db.getTask("t-ack")?.doneAckedAt === null, "新任务 done_acked_at 默认 NULL（未确认）");

  db.ackTaskDone("t-ack", 12_345);
  const ackedRow = db.getTask("t-ack");
  assert(ackedRow?.doneAckedAt === 12_345, "ackTaskDone 写入 done_acked_at");
  assert(ackedRow?.updatedAt === 1000, "ackTaskDone 不触碰 updated_at（读事件不重排侧栏）");

  // 普通 upsert（发消息/重命名/置顶）不得把已确认状态退回未确认
  db.upsertTask({ id: "t-ack", title: "改名了", status: "completed", updatedAt: 2000 });
  assert(db.getTask("t-ack")?.doneAckedAt === 12_345, "upsertTask 未提供 doneAckedAt → 保留已确认状态");
  assert(db.getTask("t-ack")?.title === "改名了", "upsertTask 其余字段照常更新");

  // 显式 null = 重置为未确认（再次运行前的可选路径）
  db.upsertTask({ id: "t-ack", title: "改名了", updatedAt: 3000, doneAckedAt: null });
  assert(db.getTask("t-ack")?.doneAckedAt === null, "upsertTask 显式 doneAckedAt=null → 重置为未确认");

  const listed = db.listTasks().find((t) => t.id === "t-ack");
  assert(listed !== undefined && "doneAckedAt" in listed, "listTasks 透出 doneAckedAt（hydration 有源）");

  db.close();

  // 重开 = 重启 App：确认状态必须存活（原 bug：重启后绿点又回来了）
  const reopened = new AppDatabase(dbPath);
  reopened.ackTaskDone("t-ack", 55_555);
  reopened.close();
  const reopenedAgain = new AppDatabase(dbPath);
  assert(reopenedAgain.getTask("t-ack")?.doneAckedAt === 55_555, "重启后已确认状态仍持久（绿点不再复活）");
  reopenedAgain.close();

  // 升级路径：老库（当前 schema 版本、缺 done_acked_at 列）→ 自动建列并回填为 updated_at
  const legacyPath = join(root, "legacy.db");
  const legacy = new AppDatabase(legacyPath);
  legacy.upsertTask({ id: "old-1", title: "历史完成任务", status: "completed", updatedAt: 4_242_424 });
  legacy.upsertTask({ id: "old-2", title: "历史运行中任务", status: "in_progress", updatedAt: 4_242_999 });
  legacy.connection.exec("ALTER TABLE tasks DROP COLUMN done_acked_at");
  const dropped = (legacy.connection.pragma("table_info(tasks)") as Array<{ name: string }>).some(
    (c) => c.name === "done_acked_at",
  );
  assert(!dropped, "老库模拟：done_acked_at 列已移除");
  legacy.close();

  const upgraded = new AppDatabase(legacyPath);
  const upgradedRow = upgraded.getTask("old-1");
  assert(
    upgradedRow?.doneAckedAt === 4_242_424,
    "升级自动补列并把历史任务回填为 updated_at（历史绿点不集体复活）",
  );
  assert(
    upgraded.getTask("old-2")?.doneAckedAt === 4_242_999,
    "回填逐行按各自 updated_at（不写死同一时间戳）",
  );
  upgraded.ackTaskDone("old-1", 8_888_888);
  assert(upgraded.getTask("old-1")?.doneAckedAt === 8_888_888, "升级后的库可正常确认");
  upgraded.close();

  const upgradedAgain = new AppDatabase(legacyPath);
  assert(
    upgradedAgain.getTask("old-1")?.doneAckedAt === 8_888_888,
    "升级库重启后确认状态仍持久",
  );
  upgradedAgain.close();
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}  passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
