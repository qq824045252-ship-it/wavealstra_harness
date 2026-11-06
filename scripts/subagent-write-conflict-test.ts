/**
 * D-2 单元测试：并行同文件写冲突守卫（纯逻辑，无 pi-durable 运行时依赖）。
 *
 * 跑法（不改 package.json）：
 *   esbuild scripts/subagent-write-conflict-test.ts --bundle --platform=node --format=esm \
 *     --outfile=out/tests/subagent-write-conflict-test.mjs && node out/tests/subagent-write-conflict-test.mjs
 */
import assert from "node:assert/strict";
import { resolve, sep } from "node:path";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import {
  canonicalWritePath, createParallelWriteGuard, formatWriteConflict, guardSubagentWriteCall, guardedChildWriteCount,
  isWriteToolName, registerGuardedChildWrite, releaseGuardedChildWrite, WRITE_TOOL_NAMES, wrapWriteTool,
  WriteConflictError, type WriteClaim,
} from "../src/main/capabilities/subagent/write-conflict";

const CONV1 = 101, CONV2 = 102, CONV3 = 103;
/** 每个 MyBuddy task 有独立 durable store：两个并发 task 的 child conversationId 会相同。 */
const TASK_A = "task-a", TASK_B = "task-b";
const cwd = sep === "\\" ? "C:\\work" : "/work";
const file = (name: string) => resolve(cwd, name);
const canonical = (name: string) => canonicalWritePath(name, cwd);

// ---- 1. write/edit 才算写工具，其它工具不介入 -----------------------------------------------
assert.deepEqual([...WRITE_TOOL_NAMES], ["write", "edit"]);
assert.equal(isWriteToolName("write"), true);
assert.equal(isWriteToolName("edit"), true);
assert.equal(isWriteToolName("read"), false);
assert.equal(isWriteToolName("bash"), false, "bash 写仍绕过检测");
assert.equal(isWriteToolName(undefined), false);

// ---- 2. 路径归一：相对路径按 child 的 cwd 解析，Windows 大小写不敏感 -------------------------
assert.equal(canonicalWritePath(file("src/a.ts"), cwd), canonical("src/a.ts"), "absolute path stays the same file");
assert.equal(canonical("./src/a.ts"), canonical("src/a.ts"));
assert.equal(canonical("../outside.ts"), canonical("../outside.ts"));
if (sep === "\\") assert.equal(canonical("SRC/A.TS"), canonical("src/a.ts"), "Windows 文件系统大小写不敏感");

// ---- 3. 同一 dispatch 内第二个 child 写同一路径 → 冲突 ---------------------------------------
const guard = createParallelWriteGuard();
const first = guard.claim({ childId: "shard-1", label: "皮卡丘", cwd, tool: "write", path: "report.md" });
assert.equal(first.childId, "shard-1");
assert.equal(first.path, canonical("report.md"));
assert.throws(() => guard.claim({ childId: "shard-2", label: "杰尼龟", cwd, tool: "write", path: "report.md" }), (error: unknown) => {
  assert(error instanceof WriteConflictError, "conflict must be a WriteConflictError");
  assert.equal(error.code, "subagent_write_conflict");
  const message = error.message;
  assert.ok(message.includes(canonical("report.md")), `message must name the path: ${message}`);
  assert.ok(message.includes("shard-1"), `message must name the first writer: ${message}`);
  assert.ok(message.includes("shard-2"), `message must name the second writer: ${message}`);
  assert.ok(message.includes("皮卡丘") && message.includes("杰尼龟"), `message must name both children: ${message}`);
  assert.ok(message.includes("并行子代理必须写不同文件"), "message must carry the actionable hint");
  assert.ok(message.includes('isolation:"shared"') && message.includes("chain"), "message must offer the alternatives");
  assert.ok(message.includes("已被阻止"), "message must say the write was blocked");
  return true;
});
// 同一 child 重复写同一文件是合法的（顺序编辑）。
assert.doesNotThrow(() => guard.claim({ childId: "shard-1", label: "皮卡丘", cwd, tool: "edit", path: "report.md" }));
// 不同路径互不影响。
assert.doesNotThrow(() => guard.claim({ childId: "shard-2", label: "杰尼龟", cwd, tool: "write", path: "other.md" }));
assert.equal(guard.claims().length, 2);
// 冲突按 child 记账（回传给父代理）。
assert.deepEqual(guard.conflictsFor("shard-2").length, 1);
assert.match(guard.conflictsFor("shard-2")[0]!, /write conflict blocked: .*report\.md already written by shard-1 \(write\)/);
assert.deepEqual(guard.conflictsFor("shard-1"), []);

// ---- 4. edit 也算写冲突（write 之后 edit 同一文件同样被阻止） --------------------------------
const editGuard = createParallelWriteGuard();
editGuard.claim({ childId: "a", label: "a", cwd, tool: "write", path: "doc.md" });
assert.throws(() => editGuard.claim({ childId: "b", label: "b", cwd, tool: "edit", path: "doc.md" }), WriteConflictError);
const editFirst = createParallelWriteGuard();
editFirst.claim({ childId: "a", label: "a", cwd, tool: "edit", path: "doc.md" });
assert.throws(() => editFirst.claim({ childId: "b", label: "b", cwd, tool: "write", path: "doc.md" }), WriteConflictError);

// ---- 5. 绝对路径与相对路径指向同一文件时也算冲突 -------------------------------------------
const absGuard = createParallelWriteGuard();
absGuard.claim({ childId: "a", label: "a", cwd, tool: "write", path: file("same.md") });
assert.throws(() => absGuard.claim({ childId: "b", label: "b", cwd, tool: "write", path: "same.md" }), WriteConflictError);
// 不同 cwd 解析到不同文件：不冲突（worktree 隔离时同相对路径 = 不同文件）。
assert.doesNotThrow(() => absGuard.claim({ childId: "b", label: "b", cwd: resolve(cwd, "worktree"), tool: "write", path: "same.md" }));

// ---- 6. 未注册的会话（父会话 / single / chain）不启用 ---------------------------------------
const hookGuard = createParallelWriteGuard();
registerGuardedChildWrite(CONV1, TASK_A, { guard: hookGuard, childId: "shard-1", label: "皮卡丘", cwd });
registerGuardedChildWrite(CONV2, TASK_A, { guard: hookGuard, childId: "shard-2", label: "杰尼龟", cwd });
assert.equal(guardedChildWriteCount(), 2);
const writeCall = (path: string, content = "x") => ({ name: "write", arguments: { path, content } });
// 父会话（根本没注册）写同一文件：放行。
assert.equal(guardSubagentWriteCall(writeCall("report.md"), undefined, TASK_A), undefined);
// 非写工具：放行。
assert.equal(guardSubagentWriteCall({ name: "read", arguments: { path: "report.md" } }, CONV1, TASK_A), undefined);
assert.equal(guardSubagentWriteCall({ name: "bash", arguments: { command: "echo hi > report.md" } }, CONV2, TASK_A), undefined,
  "bash 写绕过守卫（已知边界，不拦截）");
// 缺 path / 非字符串 path：交给工具自己报参数错误，不在这里抢答。
assert.equal(guardSubagentWriteCall({ name: "write", arguments: {} }, CONV1, TASK_A), undefined);
assert.equal(guardSubagentWriteCall({ name: "write", arguments: { path: 42 } }, CONV1, TASK_A), undefined);
assert.equal(guardSubagentWriteCall({ name: "write" }, CONV1, TASK_A), undefined);
// 第一个 child：放行并认领。
assert.equal(guardSubagentWriteCall(writeCall("report.md"), CONV1, TASK_A), undefined);
// 第二个 child：被阻止，block 文本可读。
const blocked = guardSubagentWriteCall(writeCall("report.md"), CONV2, TASK_A);
assert.ok(blocked && typeof blocked.block === "string", "second child must be blocked");
assert.match(blocked.block, /并行子代理写冲突/);
assert.match(blocked.block, /shard-1/);
assert.match(blocked.block, /shard-2/);
// 同一个 child 再写同一文件：放行（顺序写）。
assert.equal(guardSubagentWriteCall(writeCall("report.md"), CONV1, TASK_A), undefined);
// 释放后不再拦截（dispatch 结束；不跨 dispatch 抑制）。
releaseGuardedChildWrite(CONV2, TASK_A);
assert.equal(guardedChildWriteCount(), 1);
assert.equal(guardSubagentWriteCall(writeCall("report.md"), CONV2, TASK_A), undefined);
releaseGuardedChildWrite(CONV1, TASK_A);
assert.equal(guardedChildWriteCount(), 0);
// 重新注册一个全新的 dispatch：前一 dispatch 的认领不残留。
const nextGuard = createParallelWriteGuard();
registerGuardedChildWrite(CONV3, TASK_A, { guard: nextGuard, childId: "shard-3", label: "妙蛙种子", cwd });
assert.equal(guardSubagentWriteCall(writeCall("report.md"), CONV3, TASK_A), undefined, "claims must not leak across dispatches");
releaseGuardedChildWrite(CONV3, TASK_A);

// ---- 6b. 跨 task 同 conversationId 互不干扰 --------------------------------------------------
// 每个 MyBuddy task 有独立 durable store，IdAllocator 都从 2 起：两个并发 task 的 child
// conversationId 会相同。注册表必须按 (taskId, conversationId) 建键，否则会误认领/误 block。
const SHARED_CONV = 7;
const guardA = createParallelWriteGuard();
const guardB = createParallelWriteGuard();
registerGuardedChildWrite(SHARED_CONV, TASK_A, { guard: guardA, childId: "a-1", label: "A 分片", cwd });
registerGuardedChildWrite(SHARED_CONV, TASK_B, { guard: guardB, childId: "b-1", label: "B 分片", cwd });
assert.equal(guardedChildWriteCount(), 2, "同一个 conversationId 在两个 task 里必须是两条注册项");
// task-A 的 child 写 x：只认领到 A 的 guard。
assert.equal(guardSubagentWriteCall(writeCall("x.md"), SHARED_CONV, TASK_A), undefined);
// task-B 的同号 child 写同一路径：不得被 A 的认领误 block（不同 task、不同 guard）。
assert.equal(guardSubagentWriteCall(writeCall("x.md"), SHARED_CONV, TASK_B), undefined, "另一 task 的同号会话不得继承本 task 的认领");
assert.deepEqual(guardA.claims().map(claim => claim.childId), ["a-1"]);
assert.deepEqual(guardB.claims().map(claim => claim.childId), ["b-1"]);
// B 再写自己认领的路径：同一个 child，放行。
assert.equal(guardSubagentWriteCall(writeCall("x.md"), SHARED_CONV, TASK_B), undefined);
// 未知 / 缺失 taskId 不命中任何注册项（保护丢失方向，安全）。
assert.equal(guardSubagentWriteCall(writeCall("x.md"), SHARED_CONV, "task-c"), undefined, "unknown task must not match");
assert.equal(guardSubagentWriteCall(writeCall("x.md"), SHARED_CONV, undefined), undefined, "missing taskId must not match");
// taskId 为空时注册被忽略，不产生不可达条目。
registerGuardedChildWrite(SHARED_CONV, undefined, { guard: createParallelWriteGuard(), childId: "ghost", label: "ghost", cwd });
registerGuardedChildWrite(SHARED_CONV, "", { guard: createParallelWriteGuard(), childId: "ghost-2", label: "ghost", cwd });
assert.equal(guardedChildWriteCount(), 2, "an empty taskId must not create a registry entry");
// 释放只删自己 task 的键：A 释放后 B 的注册项仍在。
releaseGuardedChildWrite(SHARED_CONV, TASK_A);
assert.equal(guardedChildWriteCount(), 1);
assert.equal(guardSubagentWriteCall(writeCall("x.md"), SHARED_CONV, TASK_A), undefined);
assert.equal(guardSubagentWriteCall(writeCall("y.md"), SHARED_CONV, TASK_B), undefined);
releaseGuardedChildWrite(SHARED_CONV, TASK_B);
assert.equal(guardedChildWriteCount(), 0);

// ---- 7. wrapWriteTool：非写工具原样返回，写工具先认领再执行 ---------------------------------
type FakeCalls = { executed: string[] };
const calls: FakeCalls = { executed: [] };
const fakeTool = (name: string): ToolRegistration => ({
  name, description: `${name} fixture`, parameters: { type: "object" },
  execute: async () => {
    calls.executed.push(name);
    return { output: [{ type: "text", text: `${name} ok` }] };
  },
}) as unknown as ToolRegistration;
const fakeApi = {
  agent: async () => ({ cwd }),
} as unknown as ToolExecutionApi;
const fakeContext = {} as Parameters<ToolRegistration["execute"]>[2];

const read = fakeTool("read");
assert.equal(wrapWriteTool(read, "shard-1", createParallelWriteGuard()), read, "non-write tools pass through unchanged");

const wrapGuard = createParallelWriteGuard();
const writeA = wrapWriteTool(fakeTool("write"), "shard-a", wrapGuard, "皮卡丘");
const writeB = wrapWriteTool(fakeTool("write"), "shard-b", wrapGuard, "杰尼龟");
const written = await writeA.execute({ path: "wrapped.md", content: "a" } as never, fakeApi, fakeContext);
assert.deepEqual(written, { output: [{ type: "text", text: "write ok" }] });
await assert.rejects(writeB.execute({ path: "wrapped.md", content: "b" } as never, fakeApi, fakeContext), WriteConflictError);
assert.deepEqual(calls.executed, ["write"], "the blocked write must never reach the tool body");
// 另一个文件照常执行。
await writeB.execute({ path: "wrapped-b.md", content: "b" } as never, fakeApi, fakeContext);
assert.deepEqual(calls.executed, ["write", "write"]);

// ---- 8. 冲突文案单元校验 -------------------------------------------------------------------
const claim: WriteClaim = { path: canonical("x.md"), childId: "first", label: "甲", tool: "edit" };
const message = formatWriteConflict(claim, { childId: "second", label: "乙", tool: "write", path: canonical("x.md") });
assert.ok(message.includes("first") && message.includes("second"));
assert.ok(message.includes("edit") && message.includes("write"));
assert.ok(message.includes('isolation:"shared"'));

console.log("PASS subagent write-conflict guard: path claims, cross-child conflict (write/edit), same-child sequential writes, "
  + "different paths/cwds, hook passthrough for parent/unregistered/non-write/codeless args, dispatch isolation, "
  + "cross-task conversationId collisions isolated by (taskId, conversationId), wrapWriteTool");
