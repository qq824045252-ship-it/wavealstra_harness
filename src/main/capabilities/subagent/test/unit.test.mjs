/**
 * unit.test.mjs — Subagent 扩展单元 + fixture 集成测试（Task-scoped disposable）。
 *
 * 核心覆盖：create→running→steer→result→全清理；failed/cancelled/timedout 清理；
 * 父 Task 结束清理多 child；活动 ID 重复拒绝；terminal 后拒绝；
 * 并发互斥无双 spawn；gcLegacy 迁移；权限/模型/思考/waiter 回归。
 */
import { EventEmitter } from "node:events";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const bundle = require(join(here, ".tmp", "subagent.bundle.cjs"));

const {
  resolvePiCliJs, resolvePiInvocation,
  computeChildTools, tightenPolicy, resolveSubagentModelThinking,
  SubagentRuntime, MAX_SUBAGENT_DEPTH, DEFAULT_TASK_TIMEOUT_MS,
  createRecord, applyOutcome, EMPTY_USAGE,
  parseRpcLine, JsonlLineBuffer, spawnRpcChild,
} = bundle;

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.error(`  ✗ ${label}`); }
}
const has = (arr, item) => Array.isArray(arr) && arr.includes(item);
const n = (p) => String(p).replace(/\\/g, "/");

{
  const dir = mkdtempSync(join(tmpdir(), "subagent-context-"));
  try {
    mkdirSync(join(dir, ".mybuddy"));
    writeFileSync(join(dir, ".mybuddy", "shared-context.md"), "来源：project.md；禁止修改原件");
    const probe = bundle.inspectSharedContext(dir);
    assert(probe.injected && probe.bytes === Buffer.byteLength(probe.text), "shared context reports actual UTF-8 bytes");
    const context = bundle.buildContextBlock({
      cwd: dir, roleName: "worker", roleDescription: "", tools: ["read"],
      permissionMode: "readonly", deniedTools: ["write"], depth: 1, sharedContext: probe.text,
    });
    assert(context.includes("验收命令/条件") && context.includes("未验证项") && context.includes("来源：project.md"), "handoff/output contract and visible constraint");
    assert(context.includes("write") && context.includes("不扩大工具权限"), "handoff does not expand authority");
    writeFileSync(join(dir, ".mybuddy", "shared-context.md"), "x".repeat(bundle.SHARED_CONTEXT_MAX_BYTES + 1));
    const rejected = bundle.inspectSharedContext(dir);
    assert(!rejected.injected && rejected.reason === "over_limit" && rejected.text === null, "oversized shared file rejected visibly");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log("== resolvePiCliJs / resolvePiInvocation ==");
{
  const exists = (p) => p === "C:/cli.js";
  assert(n(resolvePiCliJs({ PI_CLI_PATH: "C:/cli.js" }, () => null, exists)) === "C:/cli.js", "PI_CLI_PATH 优先");
  const apd = "C:/npm/npm/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";
  assert(n(resolvePiCliJs({ APPDATA: "C:/npm" }, () => null, (p) => n(p) === apd)) === apd, "APPDATA npm 全局候选");
  assert(resolvePiCliJs({}, () => null, () => false) === null, "未找到 → null");
  const cli = "C:/npm/npm/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";
  const r = resolvePiInvocation({ APPDATA: "C:/npm" }, "C:/electron.exe", true, () => null, (p) => n(p) === cli);
  assert(r && r.command === "node" && n(r.args[0]) === cli, "Electron → node.exe + CLI JS");
  assert(resolvePiInvocation({}, "C:/electron.exe", true, () => null, () => false) === null, "未定位 → null");
}

console.log("== computeChildTools / tightenPolicy（权限回归） ==");
{
  const noRole = computeChildTools({ permissionMode: "default" });
  assert(noRole.tools && has(noRole.tools, "read") && !has(noRole.tools, "bash"), "默认只读分析集（无 bash）");
  assert(has(noRole.excludeTools, "subagent"), "递归工具恒排除");
  const explicit = computeChildTools({ roleTools: ["write", "edit", "bash"], permissionMode: "default" });
  assert(has(explicit.tools, "bash"), "显式授权保留 bash");
  const readonly = computeChildTools({ roleTools: ["bash", "read"], permissionMode: "readonly" });
  assert(readonly.tools && has(readonly.tools, "read") && !has(readonly.tools, "bash"), "readonly 硬裁剪");
  const auto = computeChildTools({ permissionMode: "auto" });
  assert(auto.tools === null && has(auto.excludeTools, "subagent"), "auto 不设白名单但排除递归");
  const d = tightenPolicy({ tools: null, excludeTools: ["subagent"] }, "default");
  assert(d.tools && !has(d.tools, "bash"), "auto→default 收紧");
  const a = tightenPolicy({ tools: ["read", "bash"], excludeTools: ["subagent"] }, "auto");
  assert(a.changed === false && has(a.tools, "bash"), "readonly→auto 不放宽");
}

console.log("== 模型优先级 / thinking transport model binding ==");
{
  const bound = resolveSubagentModelThinking({
    defaultModel: "opencode-go/deepseek-v4-flash",
    transportThinking: "high",
    transportThinkingModelId: "opencode-go/deepseek-v4-flash",
  });
  assert(bound.model === "opencode-go/deepseek-v4-flash" && bound.thinking === "high" && bound.thinkingSource === "transport", "transport 只对绑定模型生效");

  const roleSwitch = resolveSubagentModelThinking({
    roleModel: "other/model",
    defaultModel: "opencode-go/deepseek-v4-flash",
    transportThinking: "high",
    transportThinkingModelId: "opencode-go/deepseek-v4-flash",
  });
  assert(roleSwitch.model === "other/model" && roleSwitch.thinking === null && roleSwitch.modelSource === "role", "role 改模型不会继承默认模型 transport");
  assert(roleSwitch.diagnostics.some((x) => x.includes("绑定")), "model mismatch 有明确诊断");

  const g = resolveSubagentModelThinking({ globalDefaultModel: "gg/model" });
  assert(g.model === "gg/model" && g.thinking === null && g.modelSource === "global", "global 只兜底模型，不提供全局 thinking");

  const invalid = resolveSubagentModelThinking({
    globalDefaultModel: "gg/model",
    transportThinking: "ultra",
    transportThinkingModelId: "gg/model",
  });
  assert(invalid.thinking === null && invalid.diagnostics.length > 0, "非法内部 transport 回模型默认 + 诊断");
}

console.log("== registry 纯函数（active-only） ==");
{
  const rec = createRecord({ subagentId: "sa-1", scope: "task-1", role: "w", roleSource: "user", roleDescription: "d", project: "C:/p", depth: 1 });
  assert(rec.scope === "task-1" && rec.status === "idle", "创建含 scope");
  const done = applyOutcome({ ...rec, status: "running" }, { status: "completed", usage: { input: 10, turns: 1 } });
  assert(done.status === "completed" && done.usage.input === 10, "applyOutcome 累加（terminal 后由调用方移除）");
}

console.log("== rpc 帧解析 ==");
{
  assert(parseRpcLine('{"a":1}\r')?.a === 1, "容忍 \\r");
  assert(parseRpcLine("") === null, "空行 → null");
  const lb = new JsonlLineBuffer();
  const lines = [];
  lb.onLine = (l) => lines.push(l);
  lb.push('{"a":1}\n{"b"');
  lb.push(':2}\r\n');
  lb.flush();
  assert(lines.length === 2, "跨 chunk 分行");
}

// ---------- fixture 集成 ----------
class FakeProc extends EventEmitter {
  constructor() { super(); this.stdout = new EventEmitter(); this.stderr = new EventEmitter(); this.killed = false; this.pid = 4242; }
  kill() { this.killed = true; setImmediate(() => this.emit("close", null)); }
}

function makeRuntime(baseDir, extraArgs = []) {
  const fixture = join(here, "fixture-rpc-child.mjs");
  return new SubagentRuntime({
    baseDir,
    env: { ...process.env },
    resolveInvocation: () => ({ command: process.execPath, args: [fixture, ...extraArgs] }),
  });
}

function countsFor(baseDir, id) {
  const f = join(baseDir, "sessions", `${id}-counts.json`);
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
}

const policy = { tools: ["read"], excludeTools: ["subagent", "subagent_list", "subagent_steer"] };

console.log("== 生命周期：create→running→steer→result→全清理（disposable） ==");
{
  const baseDir = mkdtempSync(join(tmpdir(), "pi-sa-lc-"));
  const runtime = makeRuntime(baseDir);
  runtime.gcLegacy();
  const rec = runtime.ensureSubagent({ scope: "task-A", role: "fixture", roleSource: "user", roleDescription: "d", project: process.cwd(), depth: 1 });
  assert(rec.scope === "task-A", "实例绑定父 Task scope");

  // 运行中（工具调用进行中）可 steer：先启动不 await
  const p = runtime.runPrompt(rec.subagentId, { task: "SLEEP:1 long", timeoutMs: 30_000, toolArgs: policy });
  await new Promise((r) => setTimeout(r, 300));
  assert(runtime.get(rec.subagentId, "task-A") !== undefined, "运行中实例在 active 注册表");
  assert(runtime.get(rec.subagentId, "task-B") === undefined, "其它 scope 不可见（跨 Task 拒绝访问）");
  const steer = await runtime.steer(rec.subagentId, "steer during run");
  assert(steer.ok, "运行中 steer 可送达");
  const out = await p;
  assert(out.status === "completed", `运行完成（${out.status}）`);

  // terminal 后全清理
  assert(runtime.recordsSnapshot.length === 0, "active 注册表已清空（无历史）");
  assert(runtime.debugWorkerCount(rec.subagentId) === 0, "worker 已销毁");
  assert(!existsSync(join(baseDir, "sessions", `${rec.subagentId}.jsonl`)), "session 文件已删除");
  assert(!existsSync(join(baseDir, "transcripts", `${rec.subagentId}.jsonl`)), "transcript 已删除");
  const active = JSON.parse(readFileSync(join(baseDir, "active.json"), "utf8"));
  assert(active.instances.length === 0, "active.json 快照已清空");
  // terminal 后 steer/cancel 拒绝
  const s2 = await runtime.steer(rec.subagentId, "after end");
  assert(!s2.ok && s2.message.includes("已结束"), `terminal 后 steer 明确拒绝（${s2.message.slice(0, 40)}）`);
  const c2 = await runtime.cancel(rec.subagentId);
  assert(!c2.ok && c2.message.includes("已结束"), "terminal 后 cancel 明确拒绝");
  runtime.shutdownAll();
  rmSync(baseDir, { recursive: true, force: true });
}

console.log("== failed / cancelled / timedout 同样清理 ==");
{
  const baseDir = mkdtempSync(join(tmpdir(), "pi-sa-fc-"));
  const runtime = makeRuntime(baseDir);
  runtime.gcLegacy();
  for (const [task, expect] of [["FAIL fail", "failed"], ["NEVER", "timedout"]]) {
    const rec = runtime.ensureSubagent({ scope: "task-F", role: "fixture", roleSource: "user", roleDescription: "d", project: process.cwd(), depth: 1 });
    const out = await runtime.runPrompt(rec.subagentId, { task, timeoutMs: 400, toolArgs: policy });
    assert(out.status === expect, `${task} → ${expect}`);
    assert(runtime.recordsSnapshot.length === 0, `${expect} 后注册表清空`);
  }
  // cancelled（host abort）
  const rec3 = runtime.ensureSubagent({ scope: "task-F", role: "fixture", roleSource: "user", roleDescription: "d", project: process.cwd(), depth: 1 });
  const ac = new AbortController();
  const p3 = runtime.runPrompt(rec3.subagentId, { task: "SLEEP:5", timeoutMs: 30_000, signal: ac.signal, toolArgs: policy });
  await new Promise((r) => setTimeout(r, 300));
  ac.abort();
  const out3 = await p3;
  assert(out3.status === "cancelled", "abort → cancelled");
  assert(runtime.recordsSnapshot.length === 0 && !existsSync(join(baseDir, "sessions", `${rec3.subagentId}.jsonl`)), "cancelled 后全清理");
  runtime.shutdownAll();
  rmSync(baseDir, { recursive: true, force: true });
}

console.log("== 父 Task 结束清理多个 child（cleanupTask） ==");
{
  const baseDir = mkdtempSync(join(tmpdir(), "pi-sa-ct-"));
  const runtime = makeRuntime(baseDir);
  runtime.gcLegacy();
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const rec = runtime.ensureSubagent({ scope: "task-P", role: "fixture", roleSource: "user", roleDescription: "d", project: process.cwd(), depth: 1 });
    ids.push(rec.subagentId);
    void runtime.runPrompt(rec.subagentId, { task: "SLEEP:3", timeoutMs: 30_000, toolArgs: policy });
  }
  await new Promise((r) => setTimeout(r, 500));
  assert(runtime.listActive("task-P").length === 3, "父 Task 3 个 child 均在 active");
  assert(runtime.listActive("task-other").length === 0, "其它 Task 无实例");
  runtime.cleanupTask("task-P");
  await new Promise((r) => setTimeout(r, 400));
  assert(runtime.recordsSnapshot.length === 0, "父 Task 结束 → 全部 child 清理");
  for (const id of ids) {
    assert(!existsSync(join(baseDir, "sessions", `${id}.jsonl`)), `session 已删（${id.slice(0, 8)}…）`);
  }
  // P1 修复：cleanupTask 必须先归档 usage 再删除（父 Task shutdown 不丢统计）
  const archivePath = join(baseDir, "usage-archive.jsonl");
  assert(existsSync(archivePath), "usage-archive.jsonl 已生成");
  const archiveLines = readFileSync(archivePath, "utf8").split("\n").filter((l) => l.trim());
  assert(archiveLines.length === 3, `cleanupTask 归档 3 个 child（${archiveLines.length}）`);
  for (const line of archiveLines) {
    const parsed = JSON.parse(line);
    assert(typeof parsed.subagentId === "string" && typeof parsed.finishedAt === "number", "归档行含 subagentId+finishedAt");
  }
  runtime.shutdownAll();
  rmSync(baseDir, { recursive: true, force: true });
}

console.log("== 同 scope active reuse / 跨 scope 拒绝 ==");
{
  const baseDir = mkdtempSync(join(tmpdir(), "pi-sa-sc-"));
  const runtime = makeRuntime(baseDir);
  runtime.gcLegacy();
  const r1 = runtime.ensureSubagent({ scope: "task-X", role: "fixture", roleSource: "user", roleDescription: "d", project: process.cwd(), depth: 1, subagentId: "shared-id" });
  let sameRejected = false;
  try {
    runtime.ensureSubagent({ scope: "task-X", role: "fixture", roleSource: "user", roleDescription: "d", project: process.cwd(), depth: 1, subagentId: "shared-id" });
  } catch {
    sameRejected = true;
  }
  assert(sameRejected && runtime.get(r1.subagentId) === r1, "同 scope 同 id → 拒绝且保留原实例");
  let crossRejected = false;
  try {
    runtime.ensureSubagent({ scope: "task-Y", role: "fixture", roleSource: "user", roleDescription: "d", project: process.cwd(), depth: 1, subagentId: "shared-id" });
  } catch {
    crossRejected = true;
  }
  assert(crossRejected, "跨 Task 同 id → 拒绝");
  runtime.shutdownAll();
  rmSync(baseDir, { recursive: true, force: true });
}

console.log("== 并发互斥（无双 spawn） + 模型/思考传入 ==");
{
  const baseDir = mkdtempSync(join(tmpdir(), "pi-sa-cx-"));
  const runtime = makeRuntime(baseDir, ["--state-delay", "1500"]);
  runtime.gcLegacy();
  const rec = runtime.ensureSubagent({ scope: "task-C", role: "fixture", roleSource: "user", roleDescription: "d", project: process.cwd(), depth: 1 });
  const p1 = runtime.runPrompt(rec.subagentId, { task: "first", timeoutMs: 30_000, model: "a/b", thinking: "high", modelSource: "role", thinkingSource: "transport", toolArgs: policy });
  const p2 = runtime.runPrompt(rec.subagentId, { task: "second", timeoutMs: 30_000, toolArgs: policy });
  const out1 = await p1;
  const out2 = await p2;
  if (out1.status !== "completed") console.error("First concurrent fixture outcome:", JSON.stringify(out1));
  assert(out1.status === "completed", "第一发完成");
  assert(out2.status === "failed" && out2.errorMessage && out2.errorMessage.includes("已结束"), "同 id 并发第二发：第一发清理后明确拒绝（disposable 唯一实例）");
  assert(runtime.debugWorkerCount(rec.subagentId) === 0, "清理后无 worker 残留");
  runtime.shutdownAll();
  rmSync(baseDir, { recursive: true, force: true });
}

console.log("== gcLegacy：旧 registry/session/transcript 迁移清理 ==");
{
  const baseDir = mkdtempSync(join(tmpdir(), "pi-sa-gc-"));
  const sessions = join(baseDir, "sessions");
  const transcripts = join(baseDir, "transcripts");
  mkdirSync(sessions, { recursive: true });
  mkdirSync(transcripts, { recursive: true });
  // 模拟旧历史：registry.json + 旧 session/transcript + 旧 active.json 遗留
  writeFileSync(join(baseDir, "registry.json"), JSON.stringify({ records: [{ subagentId: "old-1", sessionFile: join(sessions, "old-1.jsonl") }] }), "utf8");
  writeFileSync(join(sessions, "old-1.jsonl"), "{}", "utf8");
  writeFileSync(join(transcripts, "old-1.jsonl"), "{}", "utf8");
  writeFileSync(join(sessions, "orphan.jsonl"), "{}", "utf8");
  writeFileSync(join(baseDir, "active.json"), JSON.stringify({ instances: [{ subagentId: "crash-1", sessionFile: join(sessions, "crash-1.jsonl") }] }), "utf8");
  writeFileSync(join(sessions, "crash-1.jsonl"), "{}", "utf8");
  const runtime = makeRuntime(baseDir);
  runtime.gcLegacy();
  assert(!existsSync(join(baseDir, "registry.json")), "旧 registry.json 已迁移删除");
  assert(!existsSync(join(sessions, "old-1.jsonl")) && !existsSync(join(transcripts, "old-1.jsonl")), "旧历史 session/transcript 清理");
  assert(!existsSync(join(sessions, "crash-1.jsonl")), "崩溃遗留 session 清理");
  assert(!existsSync(join(sessions, "orphan.jsonl")), "孤儿 session 清理");
  const active = JSON.parse(readFileSync(join(baseDir, "active.json"), "utf8"));
  assert(active.instances.length === 0, "active.json 清空（无历史）");
  runtime.shutdownAll();
  rmSync(baseDir, { recursive: true, force: true });
}

console.log("== waiter 清理 / 默认值 ==");
{
  assert(DEFAULT_TASK_TIMEOUT_MS === 600_000, "DEFAULT_TASK_TIMEOUT_MS=600s");
  assert(MAX_SUBAGENT_DEPTH === 2, "MAX_SUBAGENT_DEPTH=2");
  const baseDir = mkdtempSync(join(tmpdir(), "pi-sa-w-"));
  const fixture = join(here, "fixture-rpc-child.mjs");
  const child = spawnRpcChild({ command: process.execPath, args: [fixture], cwd: process.cwd(), env: { ...process.env } });
  const pending = child.waitFor((ev) => ev.type === "agent_settled", 60_000);
  assert(child.pendingWaiterCount() === 1, "waiter 挂起计数 1");
  child.cancelWaiters();
  assert(child.pendingWaiterCount() === 0, "cancelWaiters 后 0");
  const resolved = await Promise.race([pending, new Promise((r) => setTimeout(() => r("TIMEOUT"), 1000))]);
  assert(resolved === null, "被取消 waitFor resolve null");
  child.kill();
  rmSync(baseDir, { recursive: true, force: true });
}

console.log(`\n结果: passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);


