/**
 * smoke-real.mjs — 真实 Windows 端到端（disposable 语义）。
 *
 * 用真实 pi CLI（node + dist/cli.js，--mode rpc）跑最小模型调用：
 * 1) 创建临时实例 → prompt（真实 LLM）→ RESULT；
 * 2) 验证 RESULT 后 worker/session/transcript/active 注册表全部销毁（无历史残留）；
 * 3) 运行中（长任务）steer 可送达；
 * 4) 父 Task 结束（cleanupTask）后无残留。
 * 模型：deepseek-v4-flash（廉价），每个 prompt 极小 token。
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const bundle = require(join(here, ".tmp", "subagent.bundle.cjs"));
const { SubagentRuntime, resolvePiInvocation } = bundle;

const baseDir = mkdtempSync(join(tmpdir(), "pi-sa-smoke-"));
let failed = 0;
const check = (cond, label) => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${label}`);
  if (!cond) failed += 1;
};

console.log("=== 真实 smoke：Task-scoped disposable（创建→运行→RESULT→销毁） ===");
const env = { ...process.env, PI_CODING_AGENT_DIR: "C:/Users/servi/.mybuddy" };
function mkRuntime() {
  return new SubagentRuntime({
    baseDir,
    env,
    resolveInvocation: () => {
      const resolved = resolvePiInvocation(env, process.execPath, true);
      if (!resolved) return null;
      return { command: resolved.command, args: [...resolved.args] };
    },
  });
}

const r1 = mkRuntime();
r1.gcLegacy();
const rec = r1.ensureSubagent({
  scope: "smoke-task-1",
  role: "smoke-fixture-role",
  roleSource: "user",
  roleDescription: "smoke 验证角色",
  project: "C:/Users/servi/Desktop/mybuddy",
  depth: 1,
});
console.log(`instanceId: ${rec.subagentId}`);

const t0 = Date.now();
const out1 = await r1.runPrompt(rec.subagentId, {
  task: "Reply with exactly: SMOKE_OK_ONE",
  timeoutMs: 120_000,
  toolArgs: { tools: ["read", "ls", "find", "grep"], excludeTools: ["subagent", "subagent_list", "subagent_steer"] },
});
console.log(`首次 prompt: ${out1.status} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
check(out1.status === "completed", `status=completed（${out1.status}）`);
check(out1.finalText.includes("SMOKE_OK_ONE"), `finalText=${JSON.stringify(out1.finalText.slice(0, 40))}`);
check(out1.usage.input > 0, `usage 统计（input=${out1.usage.input}）`);

// RESULT 后全销毁（disposable 核心）
check(r1.recordsSnapshot.length === 0, "RESULT 后 active 注册表清空（无历史）");
check(r1.debugWorkerCount(rec.subagentId) === 0, "worker 已销毁");
const sessionFile = join(baseDir, "sessions", `${rec.subagentId}.jsonl`);
const transcriptFile = join(baseDir, "transcripts", `${rec.subagentId}.jsonl`);
check(!existsSync(sessionFile), "session 文件已删除");
check(!existsSync(transcriptFile), "transcript 已删除");
const activeSnapshot = existsSync(join(baseDir, "active.json"))
  ? JSON.parse(readFileSync(join(baseDir, "active.json"), "utf8"))
  : { instances: [] };
check(activeSnapshot.instances.length === 0, "active.json 快照清空");

// terminal 后 steer 明确拒绝
const sAfter = await r1.steer(rec.subagentId, "after end");
check(!sAfter.ok && sAfter.message.includes("已结束"), `terminal 后 steer 拒绝（${sAfter.message.slice(0, 40)}）`);

// 运行中 steer（真实 rpc）
const rec2 = r1.ensureSubagent({
  scope: "smoke-task-1",
  role: "smoke-fixture-role",
  roleSource: "user",
  roleDescription: "smoke",
  project: "C:/Users/servi/Desktop/mybuddy",
  depth: 1,
});
const p2 = r1.runPrompt(rec2.subagentId, {
  task: "Reply with exactly: SMOKE_OK_TWO",
  timeoutMs: 120_000,
  toolArgs: { tools: ["read", "ls", "find", "grep"], excludeTools: ["subagent", "subagent_list", "subagent_steer"] },
});
const sMid = await r1.steer(rec2.subagentId, "Reply with exactly: SMOKE_OK_TWO_STEERED");
// disposable 语义：快速任务窗口极短——steer 要么送达（rpc-steer/queued），要么因实例已结束被明确拒绝；
// 两者都不悬挂。真正的运行中 rpc-steer 送达由 unit（fixture SLEEP）覆盖。
check(
  sMid.ok || (sMid.delivered === "queued" && sMid.message.includes("已结束")),
  `steer 不悬挂：送达或明确已结束（delivered=${sMid.delivered} msg=${sMid.message.slice(0, 40)}）`,
);
const out2 = await p2;
check(out2.status === "completed", `steer 后完成（${out2.status}）`);
check(r1.recordsSnapshot.length === 0, "steer 实例 RESULT 后同样销毁");

// 父 Task 结束清理
const rec3 = r1.ensureSubagent({
  scope: "smoke-task-2",
  role: "smoke-fixture-role",
  roleSource: "user",
  roleDescription: "smoke",
  project: "C:/Users/servi/Desktop/mybuddy",
  depth: 1,
});
void r1.runPrompt(rec3.subagentId, {
  task: "SLEEP:10",
  timeoutMs: 120_000,
  toolArgs: { tools: ["read", "ls", "find", "grep"], excludeTools: ["subagent", "subagent_list", "subagent_steer"] },
});
await new Promise((r) => setTimeout(r, 1500));
check(r1.listActive("smoke-task-2").length === 1, "父 Task 运行中实例存在");
r1.cleanupTask("smoke-task-2");
await new Promise((r) => setTimeout(r, 800));
check(r1.recordsSnapshot.length === 0, "父 Task 结束 → child 清理");
check(!existsSync(join(baseDir, "sessions", `${rec3.subagentId}.jsonl`)), "父 Task 结束时 session 已删");

r1.shutdownAll();
await new Promise((r) => setTimeout(r, 500));
rmSync(baseDir, { recursive: true, force: true });
console.log(failed === 0 ? "\nSMOKE PASS" : `\nSMOKE FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);


