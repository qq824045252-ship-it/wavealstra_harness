/**
 * P2 短测：FileAccessPolicy / MCP / Shell 等级（含 opt-in os-sandbox）
 * 运行：pnpm run test:task-isolation-p2
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyShellIsolationSpawnContext,
  createExecutionBackend,
  createExecutionBackendFromSettings,
  DEFAULT_ISOLATION_LEVEL,
  getIsolationCapability,
  normalizeIsolationLevel,
} from "../src/main/security/TaskExecutionIsolation";
import {
  extractPathField,
  getDefaultMcpSideEffectRegistry,
  McpSideEffectRegistry,
  parseMcpToolIdentity,
} from "../src/main/security/McpSideEffectPolicy";
import { TaskFileAccessPolicy } from "../src/main/security/TaskFileAccessPolicy";
import { createMcpSideEffectExtension } from "../src/main/agent/mcp-side-effect-extension";

const root = mkdtempSync(join(tmpdir(), "mybuddy-p2-"));
const taskRoot = join(root, "task");
mkdirSync(taskRoot, { recursive: true });
writeFileSync(join(taskRoot, "in.md"), "ok");
const outside = join(root, "out.md");
writeFileSync(outside, "x");

let failed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(() => fn())
    .then(() => console.log(`PASS  ${name}`))
    .catch((err) => {
      failed++;
      console.error(`FAIL  ${name}: ${err instanceof Error ? err.message : err}`);
    });
}

async function main(): Promise<void> {
  await check("policy: canonical paths remain available without app write grants", () => {
    const p = new TaskFileAccessPolicy({ taskId: "t1", taskRoot });
    assert.equal(p.decide("write", "in.md").allowed, true);
    assert.equal(p.decide("write", outside).allowed, true);
  });

  await check("policy: legacy read grant does not restrict writes", () => {
    const p = new TaskFileAccessPolicy({ taskId: "t1", taskRoot });
    p.addReadGrant({ path: outside, source: "attachment" });
    assert.equal(p.decide("read", outside).allowed, true);
    assert.equal(p.decide("write", outside).allowed, true);
  });

  await check("MCP: historical classification metadata remains readable, not an execution gate", () => {
    const reg = new McpSideEffectRegistry();
    reg.registerAdapter({
      providerId: "fs-tool",
      toolName: "write_file",
      operation: "write",
      extractPaths: (input) => extractPathField(input),
    });
    const r = reg.evaluateToolCall({
      providerId: "fs-tool",
      toolName: "write_file",
      args: { path: "a.md" },
    });
    assert.equal(r.allowed, false);
    assert.equal(r.requiresApproval, true);

    const locked = new McpSideEffectRegistry();
    locked.registerPolicy({
      providerId: "locked",
      localFileAccess: "none",
      externalMutation: false,
      supportsRoots: false,
      requiresApproval: false,
    });
    // 无 adapter 时靠 write_file 名称启发式
    const none = locked.evaluateToolCall({
      providerId: "locked",
      toolName: "write_file",
      args: { path: "a.md" },
    });
    assert.equal(none.allowed, false);
    assert.equal(none.requiresApproval, false);

    // 默认 registry 含 * / write_file adapter
    const def = getDefaultMcpSideEffectRegistry();
    const generic = def.evaluateToolCall({
      providerId: "any-server",
      toolName: "write_file",
      args: { path: "b.md" },
    });
    assert.equal(generic.isLocalWrite, true);
    assert.equal(generic.requiresApproval, true);
  });

  await check("MCP: tool identity and dispatch remain available without approval", async () => {
    assert.equal(parseMcpToolIdentity("write"), null);
    const id = parseMcpToolIdentity("mcp__github_write_file");
    assert.ok(id);
    assert.equal(id!.providerId, "github");
    assert.equal(id!.shortToolName, "write_file");

    const approvals: string[] = [];
    let handler: ((ev: unknown) => unknown) | undefined;
    const pi = {
      on: (_e: string, cb: (ev: unknown) => unknown) => {
        handler = cb;
      },
    };
    const reg = new McpSideEffectRegistry();
    reg.registerAdapter({
      providerId: "github",
      toolName: "write_file",
      operation: "write",
      extractPaths: (input) => extractPathField(input),
    });
    createMcpSideEffectExtension({
      taskId: "t1",
      taskRoot,
      registry: reg,
      getPermissionMode: () => "default",
      requestApproval: async (info) => {
        approvals.push(info.toolName);
        return false;
      },
    })(pi as never);

    const blockedBuiltin = await handler?.({
      type: "tool_call",
      toolCallId: "1",
      toolName: "write",
      input: { path: "x" },
    });
    assert.equal(blockedBuiltin, undefined, "内置 write 不由 MCP 门禁处理");

    const denied = (await handler?.({
      type: "tool_call",
      toolCallId: "2",
      toolName: "mcp__github_write_file",
      input: { path: join(taskRoot, "a.md") },
    })) as { block?: boolean } | undefined;
    assert.equal(denied, undefined, "legacy callback cannot block MCP dispatch");
    assert.equal(approvals.length, 0, "no app approval callback is invoked");

    // Outside paths are passed to the configured provider without app authorization.
    approvals.length = 0;
    const outsideAbs = (await handler?.({
      type: "tool_call",
      toolCallId: "3",
      toolName: "mcp__github_write_file",
      input: { path: outside },
    })) as { block?: boolean; reason?: string } | undefined;
    assert.equal(outsideAbs, undefined);
    assert.equal(approvals.length, 0, "external paths do not invoke removed approval gates");
  });

  await check("默认 guarded；非法设置回退 guarded", () => {
    assert.equal(DEFAULT_ISOLATION_LEVEL, "guarded");
    assert.equal(normalizeIsolationLevel(undefined), "guarded");
    assert.equal(normalizeIsolationLevel("nope"), "guarded");
    assert.equal(createExecutionBackendFromSettings(undefined).level, "guarded");
    const cap = getIsolationCapability("os-sandbox");
    assert.equal(cap.experimental, true);
    assert.equal(cap.escapeTested, false);
    assert.equal(cap.isDefault, false);
  });

  await check("os-sandbox: app writePaths approval retired; process execution still works", async () => {
    const backend = createExecutionBackend("os-sandbox");
    assert.equal(backend.level, "os-sandbox");

    const blocked = await backend.run({
      taskId: "t1",
      taskRoot,
      command: process.execPath,
      args: ["-e", "process.stdout.write('1')"],
      writePaths: [outside],
      timeoutMs: 5000,
    });
    assert.equal(blocked.blocked, false);
    assert.equal(blocked.exitCode, 0);
    assert.equal(blocked.stdout.trim(), "1");
    assert.equal(blocked.experimental, true);

    const ok = await backend.run({
      taskId: "t1",
      taskRoot,
      command: process.execPath,
      args: ["-e", "process.stdout.write('hi')"],
      writePaths: [join(taskRoot, "in.md")],
      timeoutMs: 8000,
    });
    assert.equal(ok.blocked, false);
    assert.equal(ok.experimental, true);
    assert.equal(ok.stdout.includes("hi"), true);
    assert.equal(ok.exitCode, 0);
  });

  await check("spawnHook 上下文：强制 cwd + os-sandbox 清 NODE_OPTIONS", () => {
    const baseEnv = {
      PATH: "/bin",
      NODE_OPTIONS: "--require ./evil.js",
      ELECTRON_RUN_AS_NODE: "1",
      KEEP: "yes",
    } as NodeJS.ProcessEnv;

    const guarded = applyShellIsolationSpawnContext("guarded", taskRoot, {
      command: "echo hi",
      cwd: outside,
      env: { ...baseEnv },
    });
    assert.equal(guarded.cwd, taskRoot);
    assert.equal(guarded.env.MYBUDDY_SHELL_ISOLATION, "guarded");
    assert.equal(guarded.env.NODE_OPTIONS, "--require ./evil.js", "guarded 不剥 NODE_OPTIONS");

    const sand = applyShellIsolationSpawnContext("os-sandbox", taskRoot, {
      command: "echo hi",
      cwd: outside,
      env: { ...baseEnv },
    });
    assert.equal(sand.cwd, taskRoot);
    assert.equal(sand.env.MYBUDDY_SHELL_ISOLATION, "os-sandbox");
    assert.equal(sand.env.NODE_OPTIONS, undefined);
    assert.equal(sand.env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(sand.env.KEEP, "yes");
    assert.equal(sand.env.MYBUDDY_TASK_ROOT, taskRoot);
  });

  rmSync(root, { recursive: true, force: true });
  console.log(failed ? `\nP2 short: FAIL (${failed})` : "\nP2 short: ALL PASS");
  process.exitCode = failed ? 1 : 0;
}

main();
