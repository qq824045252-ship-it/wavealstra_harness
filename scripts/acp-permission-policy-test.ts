/**
 * ACP 权限策略测试：auto-allow / auto-deny 必须「不再打断用户」，且仍然留痕。
 *
 * 用户真机反馈：ACP 每做一步都弹权限卡，必须手动一个个点，长任务根本无法无人值守。
 *
 * 行为约定：
 *  - ask（默认）：照旧阻塞，pending_approval + pendingPermissions 等待人工选择
 *  - auto-allow：在 Agent 自己声明的 allow_* 里挑一个（优先 allow_once）自动放行，
 *                不发审批卡片、run 不进 blocked，但时间线仍记录这次调用与「已按策略自动放行」
 *  - auto-deny：挑 reject_* 自动拒绝；工具落 denied，Agent 收到 selected(reject)
 *  - 策略只认 Agent 声明的选项；挑不到（例如只有 reject 选项却要求 auto-allow）→ 退回询问
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { ExternalAgentRuntime } from "../src/main/external-agent/ExternalAgentRuntime";
import type { ExternalAgentPermissionPolicy, ExternalAgentUiEvent } from "../src/shared/external-agent";
import {
  normalizeExternalAgentPermissionPolicies,
  normalizeExternalAgentPermissionPolicy,
  resolvePolicyPermissionOptionId,
} from "../src/shared/external-agent";

let passed = 0;
function ok(label: string): void { passed += 1; console.log(`  ✓ ${label}`); }

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor<T>(probe: () => T | undefined, label: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined) return value;
    await sleep(25);
  }
  throw new Error(`timeout waiting for ${label}`);
}

// ---------- 纯函数：策略归一化 + 选项挑选 ----------
{
  assert.equal(normalizeExternalAgentPermissionPolicy("auto-allow"), "auto-allow");
  assert.equal(normalizeExternalAgentPermissionPolicy("auto-deny"), "auto-deny");
  assert.equal(normalizeExternalAgentPermissionPolicy("auto"), "ask", "未知值必须回退 ask（绝不静默放行）");
  assert.equal(normalizeExternalAgentPermissionPolicy(undefined), "ask");
  assert.deepEqual(normalizeExternalAgentPermissionPolicies({ devin: "auto-allow", bad: "nope", "": "auto-deny" }), { devin: "auto-allow" });
  assert.equal(normalizeExternalAgentPermissionPolicies({ devin: "ask" }), undefined, "全默认 → undefined");

  const options = [
    { optionId: "a-always", kind: "allow_always" },
    { optionId: "a-once", kind: "allow_once" },
    { optionId: "r-once", kind: "reject_once" },
  ];
  assert.equal(resolvePolicyPermissionOptionId("auto-allow", options), "a-once", "优先 allow_once（最小授权）");
  assert.equal(resolvePolicyPermissionOptionId("auto-deny", options), "r-once");
  assert.equal(resolvePolicyPermissionOptionId("ask", options), undefined, "ask 不自动挑选");
  assert.equal(
    resolvePolicyPermissionOptionId("auto-allow", [{ optionId: "only-always", kind: "allow_always" }]),
    "only-always",
    "只有 allow_always 时退而求其次",
  );
  assert.equal(
    resolvePolicyPermissionOptionId("auto-allow", [{ optionId: "r", kind: "reject_once" }]),
    undefined,
    "没有 allow_* → 必须退回询问，不能猜放行",
  );
  assert.equal(resolvePolicyPermissionOptionId("auto-deny", []), undefined);
  ok("策略归一化与选项挑选（含「挑不到就退回询问」）");
}

// ---------- 真实进程：三种策略的端到端行为 ----------
const root = mkdtempSync(join(tmpdir(), "mybuddy-acp-policy-"));
const cwd = join(root, "workspace");
mkdirSync(cwd);
const db = new AppDatabase(join(root, "app.db"));
const fixture = join(process.cwd(), "scripts", "fixtures", "mock-acp-agent.mjs");

function makeRuntime(policy: ExternalAgentPermissionPolicy | undefined): {
  runtime: ExternalAgentRuntime;
  events: ExternalAgentUiEvent[];
} {
  const events: ExternalAgentUiEvent[] = [];
  const runtime = new ExternalAgentRuntime(
    db,
    () => cwd,
    async () => [],
    () => [],
    undefined,
    (): Record<string, ExternalAgentPermissionPolicy> => (policy ? { devin: policy } : {}),
  );
  runtime.setSend((event) => events.push(event));
  (runtime as unknown as { listAgents: () => unknown }).listAgents = () => [{
    id: "devin", name: "Devin", protocol: "acp", available: true,
    availability: "ready", commandLabel: "mock-acp", detail: "mock", enabled: true,
    permissionPolicy: policy ?? "ask",
  }];
  (runtime as unknown as { launch: (m: unknown, cwd: string) => unknown }).launch = (_manifest: unknown, runCwd: string) =>
    spawn(process.execPath, [fixture], {
      cwd: runCwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, MOCK_ACP_BEHAVIOR: "default" },
    });
  return { runtime, events };
}

async function runOnce(runtime: ExternalAgentRuntime, taskId: string, suffix: string): Promise<void> {
  db.upsertTask({ id: taskId, title: "ACP policy test", updatedAt: Date.now() });
  runtime.prompt({
    taskId,
    agentId: "devin",
    text: "policy run",
    userMessageId: `u-${suffix}`,
    assistantMessageId: `a-${suffix}`,
  });
}

try {
  // ---- ask（默认）：仍然阻塞，产生审批卡片 ----
  {
    const { runtime, events } = makeRuntime(undefined);
    try {
      await runOnce(runtime, "task-ask", "ask");
      const card = await waitFor(
        () => events.find((event) => event.patch.type === "tool_start" && event.patch.status === "pending_approval"),
        "ask: pending_approval",
      );
      assert.ok(card);
      const run = runtime.active("task-ask")[0]!;
      assert.equal(run.status, "blocked");
      assert.equal(run.pendingPermissions.length, 1, "ask 策略必须暴露待审批项");
      assert.equal("permissionPolicy" in run, false, "descriptor 的 policy 由 listAgents 注入，run 本身不带");
      runtime.resolvePermission({ runId: run.runId, toolCallId: "permission-tool", optionId: "allow" });
      await waitFor(() => runtime.history("task-ask").runs.find((item) => item.status === "completed"), "ask completion");
      ok("ask：仍然弹审批并等待人工选择");
    } finally {
      runtime.dispose();
    }
  }

  // ---- auto-allow：不阻塞、不产生审批卡片、Agent 收到 allow ----
  {
    const { runtime, events } = makeRuntime("auto-allow");
    try {
      await runOnce(runtime, "task-allow", "allow");
      const done = await waitFor(
        () => runtime.history("task-allow").runs.find((run) => run.status === "completed"),
        "auto-allow completion",
      );
      assert.equal(done.status, "completed");
      assert.equal(
        events.some((event) => event.patch.type === "tool_start" && event.patch.status === "pending_approval"),
        false,
        "auto-allow 不得再发审批卡片",
      );
      const message = runtime.history("task-allow").messages.find((item) => item.id === "a-allow")!;
      assert.match(message.text, /permission-selected-allow/, "自动挑选的必须是 Agent 声明的 allow 选项");
      const autoEvent = events.find((event) => event.patch.type === "tool_update" && /自动放行/.test(String((event.patch as { output?: string }).output ?? "")));
      assert.ok(autoEvent, "自动放行必须在时间线留痕");
      ok("auto-allow：自动放行且留痕，不再打断");
    } finally {
      runtime.dispose();
    }
  }

  // ---- auto-deny：自动拒绝，工具落 denied ----
  {
    const { runtime, events } = makeRuntime("auto-deny");
    try {
      await runOnce(runtime, "task-deny", "deny");
      const done = await waitFor(
        () => runtime.history("task-deny").runs.find((run) => run.status === "completed"),
        "auto-deny completion",
      );
      assert.equal(done.status, "completed");
      assert.equal(
        events.some((event) => event.patch.type === "tool_start" && event.patch.status === "pending_approval"),
        false,
      );
      const message = runtime.history("task-deny").messages.find((item) => item.id === "a-deny")!;
      assert.match(message.text, /permission-selected-reject/, "自动拒绝必须回传 reject 选项");
      const denied = events.find((event) => event.patch.type === "tool_update" && (event.patch as { status?: string }).status === "denied");
      assert.ok(denied, "拒绝后工具状态必须是 denied");
      ok("auto-deny：自动拒绝并落 denied");
    } finally {
      runtime.dispose();
    }
  }

  // ---- 策略是「每次请求实时读取」：改配置不需要重启进程 ----
  {
    let policy: ExternalAgentPermissionPolicy = "ask";
    const events: ExternalAgentUiEvent[] = [];
    const runtime = new ExternalAgentRuntime(db, () => cwd, async () => [], () => [], undefined, () => ({ devin: policy }));
    runtime.setSend((event) => events.push(event));
    (runtime as unknown as { listAgents: () => unknown }).listAgents = () => [{
      id: "devin", name: "Devin", protocol: "acp", available: true, availability: "ready",
      commandLabel: "mock-acp", detail: "mock", enabled: true,
    }];
    (runtime as unknown as { launch: (m: unknown, cwd: string) => unknown }).launch = (_m: unknown, runCwd: string) =>
      spawn(process.execPath, [fixture], {
        cwd: runCwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
        env: { ...process.env, MOCK_ACP_BEHAVIOR: "default" },
      });
    try {
      assert.equal(runtime.permissionPolicyOf("devin"), "ask");
      policy = "auto-allow";
      assert.equal(runtime.permissionPolicyOf("devin"), "auto-allow", "策略读取必须是每次实时读设置");
      assert.equal(runtime.permissionPolicyOf("unknown-agent"), "ask", "未配置的 Agent 一律 ask");
      ok("策略实时生效（无需重启 Runtime）");
    } finally {
      runtime.dispose();
    }
  }

  console.log(`\nACP permission policy: PASS (${passed} checks)`);
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}
