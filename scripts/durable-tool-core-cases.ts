import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AppDatabase } from "../src/main/db/AppDatabase";
import type { RuntimeAuditReader } from "../src/main/platform/runtime-audit";
import { ConversationInteractionRepository } from "../src/main/agent/ConversationInteractionRepository";
import { ConversationInteractionService } from "../src/main/agent/ConversationInteractionService";
import { ExecutionAttemptRepository, type ExecutionAttempt } from "../src/main/agent/ExecutionAttemptRepository";
import { ExecutionFailureRepository } from "../src/main/agent/ExecutionFailureRepository";

export async function verifyDurableToolPersistence(application: AppDatabase, background: RuntimeAuditReader) {
  const ui = application.runtimeAuditReader!;
  const primary = new ExecutionAttemptRepository(undefined, ui);
  const peer = new ExecutionAttemptRepository(undefined, background);
  const ctx = { taskId: "durable-tool-persistence", executionId: "durable:durable-tool-persistence:1:2", assistantMessageId: "tool-owner" };
  const another = { taskId: "durable-tool-other", executionId: "durable:durable-tool-other:3:4", assistantMessageId: "other-owner" };
  const at = Date.now();
  await Promise.all([ctx, another].map(context => application.writeTaskRecord({ id: context.taskId, title: context.taskId, updatedAt: at })));

  const input = { ...ctx, toolCallId: "write-a", toolName: "write", target: "durable-tool:1:2", verifierId: "durable-tool-result", verifierVersion: 1 };
  const [attempt, competing, independent] = await Promise.all([
    primary.beginDurableAsync(input), peer.beginDurableAsync(input),
    peer.beginDurableAsync({ ...input, ...another, target: "durable-tool:3:4" }),
  ]);
  assert.deepEqual(attempt, competing);
  assert.deepEqual(await peer.findDurableAsync(ctx, input.toolCallId), attempt);
  assert.equal(await background.readExecutionAttempt(attempt.id, another, input.toolCallId), null);
  const recovered = await primary.recoverInterruptedAsync();
  assert(recovered.some(row => row.id === attempt.id && row.causeCode === "application-restarted"));
  const checkedAt = Date.now();
  const settled: ExecutionAttempt = { ...attempt, status: "passed", transportStatus: "succeeded", phase: "finished", finishedAt: checkedAt,
    nativeReceipt: { ...ctx, version: 1, conversationId: 1, toolTaskId: 2, callId: input.toolCallId,
      toolName: "write", attemptId: attempt.id, status: "passed", transport: "returned", settlement: "consumed",
      verifierId: input.verifierId, verifierVersion: 1, checkedAt },
    verification: { ...ctx, attemptId: attempt.id, verifierId: input.verifierId, verifierVersion: 1, target: input.target,
      canonicalTarget: "written.txt", expected: {}, observed: { written: true }, status: "passed", checkedAt } };
  await Promise.all([primary.settleDurableAsync(settled), peer.settleDurableAsync(settled)]);
  assert.deepEqual(await peer.findDurableAsync(ctx, input.toolCallId), settled);
  assert.equal((await primary.findDurableAsync(another, input.toolCallId))?.id, independent.id);
  await assert.rejects(peer.settleDurableAsync({ ...settled, nativeReceipt: { ...settled.nativeReceipt!, toolName: "other" } }), /cannot be replaced/);

  const failures = new ExecutionFailureRepository(undefined, ui);
  const peerFailures = new ExecutionFailureRepository(undefined, background);
  const failure = { ...ctx, causeCode: "effect-unverified", phase: "verify", recovery: "requires-user-action", sideEffects: "unknown",
    target: attempt.target, message: "Pending receipt", nextAction: "Read the receipt" } as const;
  const [first, duplicate] = await Promise.all([failures.recordIfAbsentAsync(failure), peerFailures.recordIfAbsentAsync(failure)]);
  assert.deepEqual(first, duplicate);
  assert.equal(await failures.resolveMatchingAsync(ctx.taskId, { ...failure, target: "other-target" }), 0);
  assert.equal(await peerFailures.resolveMatchingAsync(ctx.taskId, { target: attempt.target, causeCodes: [failure.causeCode] }), 1);
  assert.equal((await failures.listForDisplay(ctx.taskId)).find(row => row.id === first.id)?.resolvedAt !== undefined, true);

  const key = "approval:write-a";
  const staleId = `interaction-durable-${createHash("sha256").update(JSON.stringify([ctx.taskId, ctx.executionId, key])).digest("hex")}`;
  const question = { kind: "interactionInsert", kindName: "short_text", title: "Test question", optionsJson: "[]",
    allowCustom: 0, status: "pending", version: 1, createdAt: at };
  await ui.batch1Write({ ...question, ...ctx, id: staleId });
  await ui.batch1Write({ ...question, ...another, id: "still-pending" });
  const published: string[] = [];
  const service = new ConversationInteractionService(new ConversationInteractionRepository(undefined, background), patch => {
    if (patch.type === "conversation_interaction_snapshot") published.push(patch.interaction.id);
  });
  await service.cancelDurableAsync(ctx, key, "Obsolete approval");
  await service.cancelExecutionAsync({ ...another, assistantMessageId: "wrong-owner" }, "Wrong owner");
  await service.cancelDurableAsync(ctx, key, "Replayed cancellation");
  assert.deepEqual(published, [staleId]);
  assert.equal((await ui.readConversationRuntime(another.taskId, "local"))?.interactions[0]?.status, "pending");
  await service.cancelExecutionAsync(another, "Execution interrupted");
  assert.deepEqual(published, [staleId, "still-pending"]);
  console.log("PASS Core preserves one durable attempt, immutable recovery evidence, deduplicated failure and scoped interaction cancellation");
}
