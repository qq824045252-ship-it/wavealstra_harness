import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { CoreGoalContinuationDriver, type CoreGoalContinuationOptions, type CoreGoalContinuationClaim,
  type ActiveCoreGoalContinuation, type CoreGoalContinuationLedger } from "../src/main/agent/work/CoreGoalContinuationDriver";
import { RuntimeAuditUnknownOperationError } from "../src/main/platform/runtime-audit";
import type { DurableBotSnapshot } from "../src/shared/durable-bot";
import { LOCAL_USER_ID } from "../src/shared/bot-work";

const taskId = "goal-task";
const workId = "current-goal";
const hostGeneration = "fixture-execution-host";
const ledger: CoreGoalContinuationLedger = { storeId: "fixture-store", storeCommitSeq: 8, intentRevision: 2, stateVersion: 3,
  ownerEpoch: 4, attemptSerial: 5, updatedAt: 6, canAdvance: true, state: "deferred", placementGuardVersion: 1, activeClaimGuardVersion: 1 };

function snapshot(entryId: number): DurableBotSnapshot {
  return { backend: "pi-durable", epoch: "epoch", historyId: "root", revision: entryId, conversationId: "7", toolMode: "native",
    busy: false, queued: 0, pendingInputs: [], compacting: false, outcome: "completed", messages: [
      { id: `durable-${entryId}`, entryId: String(entryId), role: "assistant", text: "previous actual response", createdAt: 1 },
    ] };
}

function fixture(options: Partial<CoreGoalContinuationOptions> = {}, replies: { lost?: number; authoritative?: CoreGoalContinuationLedger } = {}) {
  const commands: Record<string, unknown>[] = [];
  let writeAttempts = 0;
  let placed: CoreGoalContinuationClaim | undefined;
  const driver = new CoreGoalContinuationDriver({ hostGeneration,
    policy: () => ({ enabled: true, maxAttempts: 4, tokenBudget: 1200 }),
    inspect: async () => ({ snapshot: snapshot(9), storeId: ledger.storeId }),
    progressFingerprint: async () => "a".repeat(64),
    place: async (claim, validate) => {
      assert(await validate());
      placed = claim;
      return "accepted";
    },
    getClient: () => ({ isClosed: false, request: async <T>(payload: Record<string, unknown>): Promise<T> => {
      if (payload.operation === "readGoalContinuation") {
        const state = replies.authoritative ?? ledger;
        const query = payload.query as Record<string, unknown>;
        if (query.kind === "activeClaim") {
          assert.deepEqual(query, { kind: "activeClaim", userId: LOCAL_USER_ID, taskId, workId, storeId: ledger.storeId, hostGeneration,
            conversationId: 7, runTaskId: 18 });
          const current = state.intentRevision === ledger.intentRevision && state.state === "igniting";
          return (current ? { status: "current", workId, attemptSerial: state.attemptSerial } : { status: "stale" }) as T;
        }
        return state as T;
      }
      assert.equal(payload.operation, "writeGoalContinuation");
      const command = payload.command as Record<string, unknown>;
      commands.push(command);
      if (command.kind === "claim") {
        if (++writeAttempts <= (replies.lost ?? 0)) throw new RuntimeAuditUnknownOperationError("lost", "writeGoalContinuation");
        const claim = { ...command, status: "claimed", attemptSerial: ledger.attemptSerial + 1, attempt: 1, budget: 1200, tokensUsed: 0,
          requestId: "goal-continuation:current-goal:2:6", assistantMessageId: "goal-continuation-answer:current-goal:2:6" };
        return claim as T;
      }
      assert.equal(command.kind, "reportAttempt");
      return { status: "reported", state: "idle" } as T;
    } }), ...options });
  return { driver, commands, placed: () => placed };
}

{
  const { driver, commands, placed } = fixture();
  const [first, concurrent] = await Promise.all([driver.continue(taskId, workId), driver.continue(taskId, workId)]);
  assert.deepEqual(first, { status: "started" });
  assert.deepEqual(concurrent, { status: "skipped", reason: "igniting" });
  assert.equal(commands.length, 1);
  assert.equal(commands[0].expectedAttemptSerial, 5);
  assert.equal(commands[0].expectedStoreCommitSeq, 8);
  assert.equal(placed()?.sourceEntryId, 9);
  assert.equal(placed()?.requestId, "goal-continuation:current-goal:2:6");
  driver.onSettled(taskId, snapshot(9), workId);
  await setImmediate();
  assert.equal(commands.length, 1, "the original settlement must not report the new attempt");
  driver.onSettled(taskId, snapshot(12), null);
  await setImmediate();
  assert.deepEqual([commands[1]?.kind, commands[1]?.claimOperationId, commands[1]?.outcome], ["reportAttempt", commands[0].operationId, "settled"]);
  driver.dispose();
}

{
  const { driver, commands } = fixture({}, { lost: 2 });
  assert.deepEqual(await driver.continue(taskId, workId), { status: "unknown" });
  assert.deepEqual(await driver.continue(taskId, workId), { status: "unknown" });
  assert.equal(commands.length, 2, "an unconfirmed claim must never create another operation");
  assert.deepEqual(commands[0], commands[1]);
  driver.dispose();
}

{
  const { driver, commands } = fixture({ place: async () => "unknown" });
  assert.deepEqual(await driver.continue(taskId, workId), { status: "unknown" });
  assert.equal(commands.length, 1, "an unconfirmed placement must not roll back a claim");
  driver.onSettled(taskId, snapshot(21), null);
  await setImmediate();
  assert.equal(commands[1]?.outcome, "settled");
  driver.dispose();
}

{
  const { driver, commands } = fixture({}, { authoritative: { ...ledger, placementGuardVersion: 0 } });
  assert.deepEqual(await driver.continue(taskId, workId), { status: "skipped", reason: "placement_not_supported" });
  assert.deepEqual(commands, []);
  driver.dispose();
}

{
  const { driver, commands } = fixture({ inspect: async () => ({ snapshot: { ...snapshot(9), queued: 1 }, storeId: ledger.storeId }) });
  assert.deepEqual(await driver.continue(taskId, workId), { status: "skipped", reason: "conversation_busy" });
  assert.deepEqual(commands, []);
  driver.dispose();
}

{
  const { driver, commands } = fixture();
  const witness = { expectedVersion: ledger.stateVersion, expectedIntentRevision: ledger.intentRevision, expectedOwnerEpoch: ledger.ownerEpoch,
    expectedContinuationRevision: ledger.updatedAt };
  for (const stale of [
    { ...witness, expectedVersion: ledger.stateVersion - 1 },
    { ...witness, expectedIntentRevision: ledger.intentRevision - 1 },
    { ...witness, expectedOwnerEpoch: ledger.ownerEpoch - 1 },
    { ...witness, expectedContinuationRevision: ledger.updatedAt - 1 },
  ]) {
    assert.deepEqual(await driver.continue(taskId, workId, stale), { status: "skipped", reason: "goal_changed" });
  }
  assert.deepEqual(commands, []);
  assert.deepEqual(await driver.continue(taskId, workId, witness), { status: "started" });
  assert.equal(commands.length, 1);
  driver.dispose();
}

{
  const { driver, commands } = fixture({}, { authoritative: { ...ledger, state: "idle" } });
  driver.onSettled(taskId, snapshot(8), workId);
  await setImmediate();
  assert.deepEqual(commands, [], "a later visible entry supersedes the original settle trigger");
  driver.dispose();
}

{
  const state: { authoritative: CoreGoalContinuationLedger } = { authoritative: ledger };
  const { driver, placed } = fixture({}, state);
  assert.deepEqual(await driver.continue(taskId, workId), { status: "started" });
  const claim = placed()!;
  state.authoritative = { ...ledger, state: "igniting", attemptSerial: claim.attemptSerial, storeCommitSeq: 15, stateVersion: 11 };
  const origin: ActiveCoreGoalContinuation = { ...claim, claimOperationId: claim.operationId, runTaskId: 18 };
  await driver.assertCurrent(origin);
  await assert.rejects(driver.assertCurrent({ ...origin, hostGeneration: "replacement-host" }), /授权已失效/);
  await assert.rejects(driver.assertCurrent({ ...origin, claimOperationId: "different-claim" }), /授权已失效/);
  state.authoritative = { ...state.authoritative, intentRevision: ledger.intentRevision + 1 };
  await assert.rejects(driver.assertCurrent(origin), /授权已失效/);
  driver.dispose();
}

console.log("PASS the Core Goal driver fences duplicate dispatch, newer input, and unconfirmed claims and placement");
