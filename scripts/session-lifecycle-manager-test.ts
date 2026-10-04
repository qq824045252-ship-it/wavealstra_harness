import assert from "node:assert/strict";
import { PendingActionRegistry } from "../src/main/agent/PendingActionRegistry";
import { SessionLifecycleManager } from "../src/main/agent/SessionLifecycleManager";
import { SessionRegistry, type SessionEntry } from "../src/main/agent/SessionRegistry";

const registry = new SessionRegistry();
const pendingActions = new PendingActionRegistry();
const detached: string[] = [];
const attached: string[] = [];
const releasedApprovals: string[] = [];
const backfilled: string[] = [];
const clearedMemory: string[] = [];
const counters = new Map<string, number>();
let disposed = 0;

const mcpRuntime = {
  detachSession(taskId: string) { detached.push(taskId); },
  attachSession(taskId: string) { attached.push(taskId); },
};
const approvals = { release(taskId: string) { releasedApprovals.push(taskId); } };
const usageStats = { backfillSession(path: string) { backfilled.push(path); } };

const manager = new SessionLifecycleManager({
  registry,
  mcpRuntime: mcpRuntime as never,
  pendingActions,
  approvals: approvals as never,
  usageStats: usageStats as never,
  userTurnCounters: counters,
  clearPendingMemoryTurns: (taskId) => clearedMemory.push(taskId),
});

function makeEntry(taskId: string, opts: { streaming?: boolean; queued?: boolean; sessionFile?: string } = {}): SessionEntry {
  return {
    taskId,
    session: {
      isStreaming: Boolean(opts.streaming),
      sessionFile: opts.sessionFile,
      dispose() { disposed += 1; },
    } as SessionEntry["session"],
    unsubscribe() {},
    cwd: `C:/tmp/${taskId}`,
    permissionMode: "default",
    pendingAssistantTurns: opts.queued
      ? [{ messageId: "queued", executionId: "exec", queuedAt: 1, behavior: "followUp" }]
      : [],
    promptSubmissionTail: Promise.resolve(),
    promptQueueEpoch: 0,
    pendingApprovals: new Map(),
    pendingExternalWrites: new Map(),
    grantedExternalWriteToolCalls: new Set(),
  };
}

registry.set(makeEntry("release-me", { sessionFile: "C:/sessions/release-me.jsonl" }));
counters.set("C:/sessions/release-me.jsonl", 3);
pendingActions.register({
  taskId: "release-me",
  assistantMessageId: "a1",
  toolCallId: "tool-1",
  tool: "bash",
  summary: "pending",
  dangerous: true,
  approvalKind: "tool",
  createdAt: 1,
});
manager.release("release-me");
assert.equal(registry.get("release-me"), undefined);
assert(detached.includes("release-me"));
assert.equal(pendingActions.list("release-me").length, 0);
assert.equal(counters.has("C:/sessions/release-me.jsonl"), false);
assert(releasedApprovals.includes("release-me"));
assert(backfilled.includes("C:/sessions/release-me.jsonl"));
assert(clearedMemory.includes("release-me"));

const streaming = makeEntry("streaming", { streaming: true });
registry.set(streaming);
assert.equal(manager.releaseIfIdle("streaming"), "dirty");
assert.equal(streaming.assemblyDirty, true);
assert(registry.get("streaming"));

const queued = makeEntry("queued", { queued: true });
registry.set(queued);
const idle = makeEntry("idle");
registry.set(idle);
const invalidated = manager.invalidateAll();
assert(invalidated.dirty.includes("streaming") && invalidated.dirty.includes("queued"));
assert(invalidated.released.includes("idle"));
assert.equal(queued.assemblyDirty, true);
assert.equal(registry.get("idle"), undefined);

manager.attachExtensions("streaming", {} as never);
assert(attached.includes("streaming"));
let failedDisposed = 0;
manager.cleanupFailedCreate("failed-create", { dispose() { failedDisposed += 1; } });
assert(detached.includes("failed-create"));
assert(releasedApprovals.includes("failed-create"));
assert.equal(failedDisposed, 1);

const committed = makeEntry("committed");
manager.commit(committed);
assert.equal(registry.get("committed"), committed);
manager.disposeAll();
assert.equal(registry.values().length, 0);
assert(detached.includes("committed"));
assert(releasedApprovals.includes("committed"));
assert(disposed >= 4, "registry disposal should dispose released/all remaining sessions");

console.log("session lifecycle manager: PASS");