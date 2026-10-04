import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { PendingActionRegistry } from "../src/main/agent/PendingActionRegistry";
import { SessionApprovalBridge } from "../src/main/agent/SessionApprovalBridge";
import { SessionRegistry, type SessionEntry } from "../src/main/agent/SessionRegistry";
import type { AgentUiPatch } from "../src/shared/agent-ipc";

const root = mkdtempSync(join(tmpdir(), "mybuddy-session-approval-"));
const taskRoot = join(root, "task");
const outside = join(root, "outside");
mkdirSync(taskRoot, { recursive: true });
mkdirSync(outside, { recursive: true });
const db = new AppDatabase(join(root, "app.db"));
const registry = new SessionRegistry();
const pendingActions = new PendingActionRegistry();
const patches: AgentUiPatch[] = [];
const lifecycle: Array<{ kind: "action_required"; taskId: string; assistantMessageId: string; toolCallId: string }> = [];

db.upsertTask({ id: "approval-task", title: "Approval task", updatedAt: 1, welcomeMode: "coding" });

const bridge = new SessionApprovalBridge({
  db,
  registry,
  pendingActions,
  emitPatch: (patch) => patches.push(patch),
  emitLifecycle: (event) => lifecycle.push(event),
});

function entry(permissionMode: "default" | "readonly" | "auto" = "default"): SessionEntry {
  return {
    taskId: "approval-task",
    session: { dispose() {} } as SessionEntry["session"],
    unsubscribe() {},
    cwd: taskRoot,
    permissionMode,
    assistantMessageId: "assistant-1",
    pendingAssistantTurns: [],
    promptSubmissionTail: Promise.resolve(),
    promptQueueEpoch: 0,
    pendingApprovals: new Map(),
    pendingExternalWrites: new Map(),
    grantedExternalWriteToolCalls: new Set(),
  };
}

async function main(): Promise<void> {
  const initialGrant = join(root, "initial-grant");
  mkdirSync(initialGrant, { recursive: true });
  db.addTaskWriteGrant("approval-task", initialGrant);

  const binding = bridge.create("approval-task", taskRoot, "readonly");
  assert.equal(binding.getPermissionMode(), "readonly", "without live session, fallback permission is authoritative");
  assert(binding.sessionPolicy.hasWriteGrantFor(join(initialGrant, "existing.txt")), "policy loads persistent task write grants");

  const live = entry("default");
  registry.set(live);
  assert.equal(binding.getPermissionMode(), "default", "live session permission overrides create-time fallback");

  const externalPromise = binding.requestExternalWriteApproval({
    toolCallId: "ext-1",
    toolName: "write",
    summary: "Write outside task root",
    targetPath: join(outside, "result.txt"),
    taskRoot,
    canonicalDir: outside,
  });
  await Promise.resolve();
  assert(live.pendingExternalWrites.has("ext-1"), "default mode registers pending external-write resolver");
  assert.equal(pendingActions.get("approval-task", "ext-1")?.approvalKind, "external-write");
  assert(patches.some((patch) => patch.type === "tool_start" && patch.toolCallId === "ext-1" && patch.status === "pending_approval"));
  assert(lifecycle.some((event) => event.toolCallId === "ext-1"));
  assert(registry.resolveExternalWrite("approval-task", "ext-1", { kind: "allow-once" }));
  assert.deepEqual(await externalPromise, { kind: "allow-once" });
  assert(live.grantedExternalWriteToolCalls.has("ext-1"));

  const actionCountBeforeDedup = pendingActions.list("approval-task").length;
  assert.equal(
    await binding.requestApproval({
      toolCallId: "ext-1",
      toolName: "write",
      summary: "Second-stage permission",
      dangerous: true,
    }),
    true,
    "external-write approval suppresses duplicate tool approval for the same tool call",
  );
  assert.equal(live.pendingApprovals.size, 0);
  assert.equal(pendingActions.list("approval-task").length, actionCountBeforeDedup);

  const toolPromise = binding.requestApproval({
    toolCallId: "tool-1",
    toolName: "bash",
    summary: "Run command",
    dangerous: true,
  });
  await Promise.resolve();
  assert(live.pendingApprovals.has("tool-1"), "default mode registers pending tool approval");
  assert.equal(pendingActions.get("approval-task", "tool-1")?.approvalKind, "tool");
  assert(registry.resolveApproval("approval-task", "tool-1", true));
  assert.equal(await toolPromise, true);

  live.permissionMode = "auto";
  assert.deepEqual(
    await binding.requestExternalWriteApproval({
      toolCallId: "ext-auto",
      toolName: "write",
      summary: "Auto external",
      targetPath: join(outside, "auto.txt"),
      taskRoot,
      canonicalDir: outside,
    }),
    { kind: "allow-once" },
    "auto permission bypasses external-write prompt",
  );
  assert.equal(
    await binding.requestApproval({ toolCallId: "tool-auto", toolName: "bash", summary: "Auto tool", dangerous: true }),
    true,
    "auto permission bypasses tool prompt",
  );

  live.permissionMode = "readonly";
  assert.deepEqual(
    await binding.requestExternalWriteApproval({
      toolCallId: "ext-ro",
      toolName: "write",
      summary: "Readonly external",
      targetPath: join(outside, "readonly.txt"),
      taskRoot,
      canonicalDir: outside,
    }),
    { kind: "deny" },
    "readonly permission denies external writes without prompting",
  );

  const dynamicGrant = join(root, "dynamic-grant");
  mkdirSync(dynamicGrant, { recursive: true });
  assert.equal(binding.sessionPolicy.hasWriteGrantFor(join(dynamicGrant, "x.txt")), false);
  bridge.addWriteGrant("approval-task", dynamicGrant);
  assert.equal(binding.sessionPolicy.hasWriteGrantFor(join(dynamicGrant, "x.txt")), true, "new persistent grant updates live policy immediately");
  bridge.removeWriteGrant("approval-task", dynamicGrant);
  assert.equal(binding.sessionPolicy.hasWriteGrantFor(join(dynamicGrant, "x.txt")), false, "revoke removes live grant immediately");

  bridge.release("approval-task");
  bridge.addWriteGrant("approval-task", dynamicGrant);
  assert.equal(binding.sessionPolicy.hasWriteGrantFor(join(dynamicGrant, "x.txt")), false, "released session policy no longer receives grant updates");

  console.log("session approval bridge: PASS");
}

void main().finally(() => {
  registry.disposeAll();
  db.close();
  rmSync(root, { recursive: true, force: true });
});