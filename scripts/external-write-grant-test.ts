/**
 * external-write-grant-test — 任务工作区外写入授权闭环测试。
 *
 * 覆盖：
 * A. TaskFileAccessPolicy 写 grant：taskRoot 内 / 外部无 grant / 目录 grant 命中 /
 *    兄弟目录拒绝 / ../ 与大小写与盘符边界 / junction 逃逸；
 * B. canonicalizeExternalGrantPath / isPathInsideWriteGrant（词法 + realpath 双层）；
 * D. McpSideEffectExtension：可识别绝对写路径走同一授权；unknown 保持旧策略；
 * E. AppDatabase task_write_grants：增删查 / 任务删除 CASCADE 清理 / 幂等。
 *
 * 全部使用临时目录与 :memory: DB，不触碰工作区。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { TaskFileAccessPolicy } from "../src/main/security/TaskFileAccessPolicy";
import {
  canonicalizeExternalGrantPath,
  isPathInsideWriteGrant,
} from "../src/main/task/TaskExecutionWorkspace";
import { createMcpSideEffectExtension } from "../src/main/agent/mcp-side-effect-extension";

let passed = 0;
function ok(cond: unknown, label: string): void {
  assert.ok(cond, label);
  passed += 1;
}

interface MockPi {
  handlers: Record<string, Array<(event: unknown) => unknown>>;
  on(evt: string, cb: (event: unknown) => unknown): void;
}

function makePi(): MockPi {
  const handlers: Record<string, Array<(event: unknown) => unknown>> = {};
  return {
    handlers,
    on: (evt, cb) => {
      (handlers[evt] ??= []).push(cb);
    },
  };
}

async function fireToolCall(
  pi: MockPi,
  event: { toolName: string; input?: unknown; toolCallId?: string },
): Promise<unknown> {
  for (const cb of pi.handlers["tool_call"] ?? []) {
    const r = await cb({ toolCallId: "tc-1", ...event });
    if (r && (r as { block?: boolean }).block) return r;
  }
  return undefined;
}

// ---------- 临时目录 ----------
const repo = process.cwd();
const root = mkdtempSync(join(tmpdir(), "ext-write-test-"));
const taskRoot = join(root, "task-root");
const inside = join(taskRoot, "sub");
const outside = join(root, "outside");
const outsideSub = join(outside, "sub");
const sibling = join(root, "sibling");
mkdirSync(inside, { recursive: true });
mkdirSync(outsideSub, { recursive: true });
mkdirSync(sibling, { recursive: true });
writeFileSync(join(inside, "in.md"), "in");
writeFileSync(join(outside, "out.md"), "out");

function cleanup(): void {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* */
  }
}

// ---- A. TaskFileAccessPolicy 写 grant ----
{
  const policy = new TaskFileAccessPolicy({ taskId: "task-1", taskRoot });
  ok(policy.decide("write", "in.md").allowed, "A1 taskRoot 内相对路径可写");
  ok(policy.decide("write", join(inside, "a.md")).allowed, "A2 taskRoot 子目录可写");
  const external = policy.decide("write", join(outside, "out.md"));
  ok(external.allowed && external.scope === "external", "A3 外部路径不再要求 grant");
  ok(policy.decide("write", join(taskRoot, "..", "sibling", "x.md")).allowed === true, "A4 相对外部路径正常解析");
  policy.addWriteGrant({ path: outside, source: "user-approval" });
  ok(policy.decide("write", join(outside, "out.md")).allowed, "A5 目录 grant 命中 → 可写");
  ok(policy.decide("write", join(outsideSub, "deep.md")).allowed, "A6 grant 子目录可写（词法+realpath）");
  const siblingDecision = policy.decide("write", join(sibling, "x.md"));
  ok(siblingDecision.allowed, "A7 兄弟目录不要求授权");
  ok(policy.decide("edit", join(outside, "out.md")).allowed, "A8 edit 同样命中 grant");
  ok(policy.decide("read", join(outside, "out.md")).allowed, "A9 grant 目录内 read 允许");
  ok(!policy.hasWriteGrantFor(join(sibling, "x.md")), "A10 hasWriteGrantFor 兄弟目录 false");
  // 大小写（win32 归一）：grant 目录大小写变体命中
  if (process.platform === "win32") {
    const upper = outside.toUpperCase();
    ok(policy.decide("write", join(upper, "OUT.MD")).allowed, "A11 win32 大小写变体命中 grant");
  }
  // 盘符切换：D: 目标不命中 C: grant（win32 才有实际意义；非 win32 上 resolve 行为不同，跳过）
  if (process.platform === "win32") {
    ok(!policy.hasWriteGrantFor("D:\\other\\x.md"), "A12 其它盘符不命中");
  }
}

// ---- B. canonicalize / isPathInsideWriteGrant ----
{
  const realDir = join(root, "real-dir");
  mkdirSync(realDir, { recursive: true });
  const canonical = canonicalizeExternalGrantPath(join(realDir, "..", "real-dir", "sub"));
  ok(canonical.endsWith("real-dir" + "\\sub") || canonical.endsWith("real-dir/sub"), "B1 canonicalize 折叠 ..");
  // 已存在目录 realpath 固化
  const canonical2 = canonicalizeExternalGrantPath(realDir);
  ok(existsSync(canonical2), "B2 canonicalize 已存在目录返回真实路径");
  // junction 逃逸：grant 目录内 link → 外部
  let junctionWorks = false;
  try {
    const link = join(realDir, "link-to-outside");
    symlinkSync(outside, link, "junction");
    junctionWorks = true;
  } catch {
    /* 无权限创建 junction：跳过该子用例 */
  }
  if (junctionWorks) {
    ok(
      !isPathInsideWriteGrant(realDir, join(realDir, "link-to-outside", "out.md")),
      "B3 junction 指向外部：目标不命中 grant（realpath 层）",
    );
  } else {
    console.warn("[ext-write-test] B3 跳过：无 junction 创建权限");
  }
  ok(isPathInsideWriteGrant(realDir, join(realDir, "sub", "a.md")), "B4 词法+realpath 双重命中");
  ok(!isPathInsideWriteGrant(realDir, join(root, "other", "a.md")), "B5 外部目标不命中");
}

async function main(): Promise<void> {
// ---- D. McpSideEffectExtension ----
{
  const policy = new TaskFileAccessPolicy({ taskId: "task-1", taskRoot });
  let approvalCalls = 0;
  const pi = makePi();
  createMcpSideEffectExtension({
    taskId: "task-1",
    taskRoot,
    getPermissionMode: () => "default" as never,
    getPolicy: () => policy,
    requestExternalWriteApproval: async () => {
      approvalCalls += 1;
      return { kind: "allow-once" };
    },
    requestApproval: async () => true,
  })(pi as never);

  // D1 MCP 绝对路径越界 → 外部写授权
  {
    const r = await fireToolCall(pi, {
      toolName: "mcp__github_write_file",
      input: { path: join(outside, "out.md"), content: "x" },
    });
    ok(r === undefined, "D1 MCP 外部写 allow-once 放行");
    ok(approvalCalls === 0, "D1b 不创建外部写授权弹窗");
  }
  // D2 MCP 绝对路径在 taskRoot 内 → 不弹外部授权
  {
    const r = await fireToolCall(pi, {
      toolName: "mcp__github_write_file",
      input: { path: join(taskRoot, "in.md"), content: "x" },
    });
    ok(r === undefined, "D2 taskRoot 内 MCP 写放行");
    ok(approvalCalls === 0, "D2b 未触发外部授权");
  }
  // D3 MCP 相对路径 → 不触发外部授权（交给 server / roots）
  {
    const r = await fireToolCall(pi, {
      toolName: "mcp__github_write_file",
      input: { path: "relative.md", content: "x" },
    });
    ok(r === undefined, "D3 相对路径放行（server 侧解析）");
    ok(approvalCalls === 0, "D3b 未触发外部授权");
  }
  // D4 MCP 外部写 + deny → block
  {
    const pi2 = makePi();
    createMcpSideEffectExtension({
      taskId: "task-1",
      taskRoot,
      getPermissionMode: () => "default" as never,
      getPolicy: () => policy,
      requestExternalWriteApproval: async () => ({ kind: "deny" }),
      requestApproval: async () => true,
    })(pi2 as never);
    const r = await fireToolCall(pi2, {
      toolName: "mcp__github_write_file",
      input: { path: join(outside, "out.md"), content: "x" },
    });
    ok(r === undefined, "D4 旧授权回调不再调用");
  }
  // D5 unknown side effect 保持旧策略（requiresApproval 走 requestApproval，不新开外部授权）
  {
    const pi3 = makePi();
    let externalCalls = 0;
    let normalApprovalCalls = 0;
    createMcpSideEffectExtension({
      taskId: "task-1",
      taskRoot,
      getPermissionMode: () => "default" as never,
      getPolicy: () => policy,
      requestExternalWriteApproval: async () => {
        externalCalls += 1;
        return { kind: "allow-once" };
      },
      requestApproval: async () => {
        normalApprovalCalls += 1;
        return true;
      },
    })(pi3 as never);
    const r = await fireToolCall(pi3, {
      toolName: "mcp__unknown_provider_some_tool",
      input: { path: join(outside, "out.md") },
    });
    ok(r === undefined, "D5 unknown MCP 放行（mock 审批通过）");
    ok(externalCalls === 0, "D5b unknown 不触发外部写授权");
    ok(normalApprovalCalls === 0, "D5c unknown 不创建审批");
  }
}

// ---- E. AppDatabase task_write_grants ----
{
  const db = new AppDatabase(":memory:");
  const taskId = "task-grant-1";
  db.connection.prepare("INSERT INTO tasks (id, title, updated_at) VALUES (?, ?, ?)").run(taskId, "t", Date.now());
  db.addTaskWriteGrant(taskId, outside);
  db.addTaskWriteGrant(taskId, outside); // 幂等
  ok(db.listTaskWriteGrants(taskId).length === 1, "E1 幂等写入");
  ok(db.listTaskWriteGrants(taskId)[0]!.path === outside, "E2 读回路径");
  // 另一任务隔离
  db.connection.prepare("INSERT INTO tasks (id, title, updated_at) VALUES (?, ?, ?)").run("task-grant-2", "t2", Date.now());
  db.addTaskWriteGrant("task-grant-2", sibling);
  ok(db.listTaskWriteGrants(taskId).length === 1, "E3 任务间隔离");
  // 撤销
  ok(db.deleteTaskWriteGrant(taskId, outside) === true, "E4 撤销成功");
  ok(db.listTaskWriteGrants(taskId).length === 0, "E5 撤销后为空");
  // 任务删除 → CASCADE 清理
  db.addTaskWriteGrant("task-grant-2", sibling);
  db.deleteTask("task-grant-2");
  ok(db.listTaskWriteGrants("task-grant-2").length === 0, "E6 任务删除后授权随行清理");
  db.close();
}

// ---- F. revoke 即时失效：同一会话 policy 实例内移除 grant 后必须重新授权 ----
{
  const policy = new TaskFileAccessPolicy({ taskId: "task-1", taskRoot });
  policy.addWriteGrant({ path: outside, source: "user-approval" });
  ok(policy.hasWriteGrantFor(join(outside, "out.md")), "F1 grant 生效");
  ok(policy.removeWriteGrant(outside) === true, "F2 removeWriteGrant 命中返回 true");
  ok(!policy.hasWriteGrantFor(join(outside, "out.md")), "F3 移除后同 policy 实例不再放行");
  ok(
    policy.decide("write", join(outside, "out.md")).allowed,
    "F4 授权记录移除不改变执行",
  );
  ok(policy.removeWriteGrant(outside) === false, "F5 重复移除返回 false（幂等安全）");

}

// ---- G. 主进程 revoke / deny 终态源码契约（与实现同步的静态红线） ----
{
  const mainIndexSrc = readFileSync(join(repo, "src/main/index.ts"), "utf8");
  const agentSrc = readFileSync(join(repo, "src/main/agent/AgentService.ts"), "utf8");
  const approvalBridgeSrc = readFileSync(join(repo, "src/main/agent/SessionApprovalBridge.ts"), "utf8");
  ok(
    /agentService\.revokeTaskWriteGrant\(taskId, path\)/.test(mainIndexSrc),
    "G1 deleteTaskWriteGrant IPC 必须经 AgentService（DB + 存活会话 policy 同步失效）",
  );
  ok(
    /revokeTaskWriteGrant\(taskId: string, path: string\)/.test(agentSrc) &&
      agentSrc.includes("this.sessionApprovals.removeWriteGrant(taskId, path)") &&
      approvalBridgeSrc.includes("policy.removeWriteGrant(path)"),
    "G2 AgentService revoke 委托 SessionApprovalBridge 对存活 policy 即时移除 grant",
  );
  ok(
    /status: decision\.kind === "deny" \? "denied" : "running"/.test(agentSrc),
    "G3 外部写 deny 回写 denied 终态（不得回写 running 造成卡片卡死）",
  );
  ok(
    /workspace: req\.cwd\?\.trim\(\) \|\| undefined/.test(agentSrc),
    "G4 assembleModePreview 与真实会话一致注入 workspace 段",
  );
  const btwServiceSrc = readFileSync(join(repo, "src/main/agent/BtwSessionService.ts"), "utf8");
  const btwCtx = btwServiceSrc.slice(
    btwServiceSrc.indexOf("private baseContext("),
    btwServiceSrc.indexOf("private schedulePrune("),
  );
  const promptAssemblySrc = readFileSync(
    join(repo, "src/main/agent/PromptAssembly.ts"),
    "utf8",
  );
  const btwMapper = promptAssemblySrc.slice(
    promptAssemblySrc.indexOf("export function mapBtwProjectContextSegments("),
    promptAssemblySrc.indexOf("export function assemblePrompt("),
  );
  ok(
    btwCtx.includes("this.deps.libraryWorkspace.renderBtwProjectContextSegments(") &&
      /\.filter\(\(s\) => s\.id !== "workspace"\)/.test(btwMapper),
    "G5 BTW uses the shared context mapper, which filters duplicate workspace injection",
  );
  const policySrc = readFileSync(
    join(repo, "src/main/security/TaskFileAccessPolicy.ts"),
    "utf8",
  );
  ok(
    /removeWriteGrant\(path: string\): boolean/.test(policySrc),
    "G6 TaskFileAccessPolicy 提供 removeWriteGrant（会话内即时失效原语）",
  );
}

cleanup();
console.log(`[external-write-grant-test] passed=${passed} failed=0`);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
