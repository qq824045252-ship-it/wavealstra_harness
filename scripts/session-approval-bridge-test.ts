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

  for (const mode of ["default", "readonly", "auto"] as const) {
    const binding = bridge.create("approval-task", taskRoot, mode);
    registry.set(entry(mode));
    assert.equal(binding.getPermissionMode(), "auto");
    assert.equal(await binding.requestApproval({ toolCallId: `tool-${mode}`, toolName: "bash", summary: "command", dangerous: true }), true);
    assert.deepEqual(await binding.requestExternalWriteApproval({ taskId: "approval-task", toolCallId: `write-${mode}`, toolName: "write", targetPath: join(outside, "file.txt"), taskRoot, canonicalDir: outside, summary: "write" }), { kind: "allow-once" });
    assert(binding.sessionPolicy.decide("write", join(outside, "file.txt")).allowed);
    assert.equal(patches.length, 0);
    assert.equal(lifecycle.length, 0);
    assert.equal(registry.get("approval-task")!.pendingApprovals.size, 0);
    assert.equal(registry.get("approval-task")!.pendingExternalWrites.size, 0);
  }
  assert.equal(db.listTaskWriteGrants("approval-task").length, 1, "historical grants are preserved but inert");
  bridge.release("approval-task");

  console.log("session approval bridge: PASS");
}

void main().finally(() => {
  registry.disposeAll();
  db.close();
  rmSync(root, { recursive: true, force: true });
});