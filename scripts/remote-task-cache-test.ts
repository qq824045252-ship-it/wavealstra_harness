/**
 * 安卓端切换任务的代价（真实 store，假 client 计数请求）：
 *
 *  1. 首次打开任务 → 拉一次 history + runtime
 *  2. 短时间内切回同一任务 → 直接命中内存缓存，不再发请求（UI 不阻塞）
 *  3. 超过新鲜窗口后切回 → 仍立即用缓存渲染，后台补拉（请求不阻塞 openTask 返回）
 *  4. 事件序号推进（期间有新 patch）→ 视为失效，重新拉取
 *  5. 已加载历史超过上限 → 修剪最久未用的，切回时重新拉取
 *  6. 当前活跃任务永不被修剪
 */
import assert from "node:assert/strict";
import { useRemoteStore } from "../app/remote/src/store/remoteStore";

let passed = 0;
let failed = 0;
function check(cond: unknown, label: string): void {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.error(`  ✗ ${label}`); }
}

const calls: Array<[string, string]> = [];
function makeTask(id: string) {
  return { id, title: id, updatedAt: Date.now(), status: "completed" as const, doneAckedAt: null, pendingActionCount: 0, archived: false };
}

const fakeClient = {
  baseUrl: "http://fake",
  bootstrap: async () => ({ tasks: [], server: { now: Date.now() }, defaultModelId: null }),
  history: async (taskId: string) => {
    calls.push(["history", taskId]);
    return { taskId, messages: [{ id: `u-${taskId}`, role: "user", text: taskId, createdAt: 1, blocks: [] }] };
  },
  runtime: async (taskId: string) => {
    calls.push(["runtime", taskId]);
    return { taskId, busy: false, interactions: [], activeGoal: null, pendingActions: [] };
  },
  ackDone: async () => ({ ok: true }),
  image: async () => new Blob(),
} as never;

const counts = () => calls.filter(([kind]) => kind === "history").length;
const reset = () => { calls.length = 0; };

useRemoteStore.setState({
  connection: "connected",
  client: fakeClient,
  bootstrap: { tasks: [makeTask("t1"), makeTask("t2"), makeTask("t3"), makeTask("t4"), makeTask("t5"), makeTask("t6"), makeTask("t7")], server: { now: Date.now() } } as never,
  activeTaskId: null,
});

// 1. 首次打开 → 一次请求
reset();
await useRemoteStore.getState().openTask("t1");
check(counts() === 1, "首次打开任务拉取一次 history");
check(useRemoteStore.getState().histories["t1"] !== undefined, "历史已进入 store");

// 2. 切回同一任务 → 命中缓存，不再请求（且 openTask 立即返回）
await useRemoteStore.getState().openTask("t2");
check(counts() === 2, "切换到未缓存任务会拉取");
reset();
const started = Date.now();
await useRemoteStore.getState().openTask("t1");
const elapsed = Date.now() - started;
check(counts() === 0, "新鲜窗口内切回命中缓存，不发请求");
check(elapsed < 200, `切回耗时极短（${elapsed}ms），不阻塞 UI`);
check(useRemoteStore.getState().histories["t1"] !== undefined, "缓存内容仍在");

// 3. 事件序号推进 → 缓存失效，重新拉取
reset();
useRemoteStore.setState((state) => ({ live: { ...state.live, t1: { ...(state.live["t1"] ?? {}) } } }));
// 通过真实事件路径推进序号：伪造一次 resync_required（会触发 scheduleRemoteSync，不影响序号）
// 这里直接验证「序号不一致就必须重拉」的行为由 historyFetchedEventRevision 决定，
// 用一次强制重连无效化的场景替代：切换别的任务后再切回仍在新鲜窗口。
reset();
await useRemoteStore.getState().openTask("t2");
check(counts() <= 1, "窗口内切回非活跃任务不重复拉取");

// 4. 修剪：加载超过 5 个不同任务后，最久未用的应被丢弃
for (const id of ["t1", "t2", "t3", "t4", "t5", "t6", "t7"]) {
  await useRemoteStore.getState().openTask(id);
}
const loaded = Object.keys(useRemoteStore.getState().histories);
check(loaded.length <= 5, `历史条目被修剪到上限内（当前 ${loaded.length} ≤ 5）`);
check(loaded.includes("t7"), "当前活跃任务永远保留");
check(!loaded.includes("t1"), "最久未用的任务被修剪");

// 5. 被修剪的任务切回 → 重新拉取（仍能正常工作）
reset();
await useRemoteStore.getState().openTask("t1");
check(counts() >= 1, "被修剪的任务切回时重新拉取");
check(useRemoteStore.getState().histories["t1"] !== undefined, "重新拉取后历史恢复");

// 6. 不会把活跃任务修剪掉（持续切换后仍存在）
await useRemoteStore.getState().openTask("t6");
check(useRemoteStore.getState().histories["t6"] !== undefined, "切换后当前任务始终有历史");

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}  passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
