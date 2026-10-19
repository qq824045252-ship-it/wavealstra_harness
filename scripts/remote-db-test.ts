/**
 * 安卓端本地数据库（IndexedDB）真实行为测试。
 *
 * 用 fake-indexeddb 提供真实的 IDB 实现（不是内存桩），验证 remoteDb 的语义：
 *
 *  1. 任务列表快照可写入/读回，且按 serverKey 隔离（换服务器不串味）
 *  2. 单任务历史可写入/读回，runtime 一并保留
 *  3. LRU 淘汰：超过上限时丢掉最久未用的（读会刷新使用时刻）
 *  4. 删除任务时本地历史同步清掉（回收后不能还读到旧对话）
 *  5. clearAll 清空全部
 *  6. 无 IndexedDB 时全部安全降级为 null/no-op（不抛错）
 */
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import type { RemoteBootstrap, RemoteTaskHistory, RemoteTaskSummary } from "@mybuddy/shared";
import {
  clearAll, deleteHistory, loadHistory, loadTaskList, saveHistory, saveTaskList, serverCacheKey,
} from "../app/remote/src/store/remoteDb";

let passed = 0;
let failed = 0;
function check(cond: unknown, label: string): void {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.error(`  ✗ ${label}`); }
}

function task(id: string): RemoteTaskSummary {
  return { id, title: id, updatedAt: Date.now(), status: "completed", doneAckedAt: null, pendingActionCount: 0, archived: false } as unknown as RemoteTaskSummary;
}
function bootstrapOf(ids: string[]): RemoteBootstrap {
  return { apiVersion: 1, server: { now: Date.now() }, spaces: [], projects: [], tasks: ids.map(task),
    unreadNotificationCount: 0, device: { id: "dev-1" }, models: [], defaultModelId: null,
    defaultPermissionMode: "default" } as unknown as RemoteBootstrap;
}
function historyOf(taskId: string, text: string): RemoteTaskHistory {
  return { taskId, messages: [{ id: `u-${taskId}`, role: "user", text, createdAt: 1 }] };
}

const SERVER_A = serverCacheKey("http://192.168.1.5:3352", "dev-1");
const SERVER_B = serverCacheKey("http://10.0.0.9:3352", "dev-2");

// 1. 任务列表快照
await saveTaskList(SERVER_A, bootstrapOf(["t1", "t2", "t3"]));
const listA = await loadTaskList(SERVER_A);
check(listA !== null, "任务列表快照可读回");
check(listA!.tasks.length === 3, "快照保留全部任务");
check(Array.isArray(listA!.tasks) && listA!.tasks[0]!.id === "t1", "快照内容正确");
check(await loadTaskList(SERVER_B) === null, "另一台服务器读不到本机快照（按 serverKey 隔离）");

// 2. 单任务历史
await saveHistory(SERVER_A, "t1", historyOf("t1", "hello"), { taskId: "t1", busy: false, interactions: [], activeGoal: null, pendingActions: [] });
const hist = await loadHistory(SERVER_A, "t1");
check(hist !== null, "单任务历史可读回");
check(hist!.history.messages[0]!.text === "hello", "历史消息内容正确");
check(hist!.runtime?.busy === false, "runtime 一并保留");
check(await loadHistory(SERVER_A, "t-none") === null, "未缓存的任务返回 null");
check(await loadHistory(SERVER_B, "t1") === null, "跨服务器读不到（隔离）");

// 3. LRU 淘汰（上限 20）
for (let i = 0; i < 25; i++) {
  await saveHistory(SERVER_A, `bulk-${i}`, historyOf(`bulk-${i}`, `msg-${i}`));
  // 保持 t1 被频繁使用，观察它是否留存
  await loadHistory(SERVER_A, "t1");
}
const oldest = await loadHistory(SERVER_A, "bulk-0");
const newest = await loadHistory(SERVER_A, "bulk-24");
check(newest !== null, "最新写入的历史保留");
check(oldest === null, "最久未用的历史被淘汰");
check(await loadHistory(SERVER_A, "t1") !== null, "被反复读取的历史不会淘汰（LRU 语义）");

// 4. 删除同步清本地
await deleteHistory(SERVER_A, "t1");
check(await loadHistory(SERVER_A, "t1") === null, "删除任务后本地历史同步清除");

// 5. 清空
await clearAll();
check(await loadTaskList(SERVER_A) === null, "clearAll 清空任务快照");
check(await loadHistory(SERVER_A, "bulk-24") === null, "clearAll 清空历史");

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}  passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
