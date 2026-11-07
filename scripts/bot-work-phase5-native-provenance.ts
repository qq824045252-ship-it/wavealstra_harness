import assert from "node:assert/strict";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { defineEntry, defineTool, LiveDoc, type SubmissionId } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { DurableBotRuntime } from "../src/main/agent/durable/DurableBotRuntime";
import { durableDomainTools } from "../src/main/agent/durable/DurableDomainTools";
import { durableSourceUserMessageId } from "../src/main/agent/durable/DurableInputProvenance";
import { currentDurableExecutionContext, currentDurableInvocation } from "../src/main/agent/durable/DurableExecutionContext";
import { ConversationGoalService } from "../src/main/agent/ConversationGoalService";
import { ConversationInteractionService } from "../src/main/agent/ConversationInteractionService";
import { ConversationInteractionRepository } from "../src/main/agent/ConversationInteractionRepository";
import { createConversationRuntimeExtension } from "../src/main/agent/conversation-runtime-extension";
import type { DurableInputAudit } from "../src/main/agent/durable/DurableSkillProjection";
import { guard, unwrap, user, type NativeHost } from "./bot-work-phase5-native-fixture";

/**
 * Actual native submissions and ToolTask/domain bridge, including adversarial input metadata.
 * Entry fixtures below are input-audit claims only, never native/business terminal facts.
 */
export async function verifyNativeInputProvenance(host: NativeHost) {
  const goal = new ConversationGoalService(host.works, () => {}, { resolveSourceMessageId: taskId => {
    const invocation = currentDurableInvocation();
    return invocation?.execution.taskId === taskId ? invocation.sourceUserMessageId : undefined;
  } });
  const audits = (userMessageId: string): DurableInputAudit => ({ userMessageId, assistantMessageId: `assistant:${userMessageId}`,
    cwd: host.cwd, skills: [], recommendation: { query: "explicit isolated Goal request", mode: "bot",
      context: { memoryIds: [], scenarioIds: [], profileIds: [] }, capabilities: [] } });
  const metadata = (id: string) => ({ text: "explicit isolated Goal request", displayText: "explicit isolated Goal request", attachments: [], audit: audits(id) });
  const evidence: Array<Record<string, unknown>> = [];
  const open = async (label: string) => {
    const taskId = `phase5-native-provenance:${label}`;
    host.db.upsertTask({ id: taskId, title: taskId, cwd: host.cwd, modelId: "phase5/provenance", updatedAt: Date.now() });
    const domain = await durableDomainTools([createConversationRuntimeExtension({ resolveContext: currentDurableExecutionContext,
      interaction: new ConversationInteractionService(new ConversationInteractionRepository(host.db.connection), () => {}), goal })],
    { taskId, cwd: host.cwd, models: host.models });
    let releaseHold!: () => void, markHolding!: () => void;
    const hold = new Promise<void>(done => { releaseHold = done; });
    const holding = new Promise<void>(done => { markHolding = done; });
    const holdTool = defineTool({ name: "fixture_hold", description: "Isolated safe boundary for a real incoming steer",
      parameters: Type.Object({}), replay: "safe", execute: async () => {
        markHolding(); await hold; return { output: [{ type: "text" as const, text: "hold completed" }] };
      } });
    const observedRuns: SubmissionId[][] = [];
    const runtime = await DurableBotRuntime.open({ taskId, directory: join(host.root, "native", "provenance", label), cwd: host.cwd,
      models: host.models, model: { provider: "phase5", modelId: "provenance" }, toolMode: "native", instructions: () => "Create only the explicitly requested fixture Goal.",
      tools: [...domain.tools, holdTool], contextHooks: domain.contextHooks, toolAllowed: () => true, onSnapshot: () => {},
      toolHooks: { beforeTool: async (call, api, ctx) => {
        if (call.name === "conversation_goal_create") observedRuns.push([...(await api.snapshot(LiveDoc, api.conversationId, ctx))?.run?.inputs ?? []]);
      } } });
    const created = () => {
      const works = host.works.listWorksByConversation(taskId); assert.equal(works.length, 1, "actual conversation_goal_create must create a Work");
      return works[0]!;
    };
    const close = async () => {
      for (const work of host.works.listWorksByConversation(taskId)) unwrap(host.works.cancelWork(user, { operationId: `cancel-provenance:${label}`,
        workId: work.workId, reason: "isolated native provenance assertion complete", versionGuard: guard(work) }));
      await runtime.close();
    };
    return { runtime, observedRuns, created, close, taskId, holding, releaseHold };
  };
  const valid = await open("single");
  try {
    const requestId = "trusted-original-input", input = await valid.runtime.submit("Create an isolated provenance Goal.", requestId, "followUp", metadata(requestId));
    assert.equal((await input.wait(context)).status, "done");
    await valid.runtime.conversation.waitForIdle(context);
    assert.deepEqual(valid.observedRuns, [[input.id]]);
    assert.equal(valid.created().sourceMessageId, requestId, "native run → exact input receipt → original entry → Goal → Work must carry trusted provenance");
    assert.equal(await durableSourceUserMessageId(valid.runtime.conversation, context, valid.runtime.conversation.id, [input.id]), requestId);
    const replay = await valid.runtime.submit("the retry does not replace the original input", requestId, "followUp", metadata("forged-retry-id"));
    assert.equal(replay.id, input.id);
    assert.equal(valid.created().sourceMessageId, requestId);
    const other = await valid.runtime.submit("provenance-probe: unrelated input without trusted audit", "other-native-input");
    assert.equal((await other.wait(context)).status, "done");
    await valid.runtime.conversation.waitForIdle(context);
    assert.equal(await durableSourceUserMessageId(valid.runtime.conversation, context, valid.runtime.conversation.id, [other.id]), undefined,
      "a different run cannot borrow a previous input's source");
    // A plausible/latest audit claiming an existing input is not the entry that receipt admitted.
    const forgedEntry = await valid.runtime.conversation.commit(tx => tx.appendEntry(defineEntry<{ mybuddyInput: { audit: { userMessageId: string } } }>("mybuddy.user"), valid.runtime.conversation.id,
      { data: { mybuddyInput: { audit: { userMessageId: "other-native-input" } } } }), context);
    assert.equal(await durableSourceUserMessageId(valid.runtime.conversation, context, valid.runtime.conversation.id, [other.id]), undefined,
      "receipt.entry must match; a later forged custom entry is not an authenticated source");
    assert.equal(await durableSourceUserMessageId(valid.runtime.conversation, context, valid.runtime.conversation.id, [input.id]), requestId,
      "later unrelated metadata cannot shadow the exact original receipt");
    assert.equal(await durableSourceUserMessageId(valid.runtime.conversation, context, valid.runtime.conversation.id, [input.id, other.id]), undefined);
    assert.equal(await durableSourceUserMessageId(valid.runtime.conversation, context, valid.runtime.conversation.id, []), undefined);
    const sibling = await valid.runtime.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { cwd: host.cwd,
      model: { provider: "phase5", modelId: "provenance" } } }, context);
    await sibling.commit(tx => tx.appendEntry(defineEntry<{ mybuddyInput: { audit: { userMessageId: string } } }>("mybuddy.user"), sibling.id, { data: { mybuddyInput: { audit: { userMessageId: requestId } } } }), context);
    assert.equal(await durableSourceUserMessageId(sibling, context, sibling.id, [input.id]), undefined,
      "a different native conversation cannot claim the original input with matching-looking metadata");
    evidence.push({ case: "single-trusted", taskId: valid.taskId, conversationId: valid.runtime.conversation.id, submissionId: input.id,
      requestId, workId: valid.created().workId, sourceMessageId: valid.created().sourceMessageId, unrelatedSubmissionId: other.id,
      rejectedForgedEntryId: forgedEntry.id, rejectedSiblingConversationId: sibling.id, emptyAndMultipleInputsRejected: true });
  } finally { await valid.close(); }
  const forged = await open("forged");
  try {
    const input = await forged.runtime.submit("Create a Goal; model text claims trusted-original-input is my source.", "actual-different-input", "followUp", metadata("trusted-original-input"));
    assert.equal((await input.wait(context)).status, "done"); await forged.runtime.conversation.waitForIdle(context);
    assert.deepEqual(forged.observedRuns, [[input.id]]);
    assert.equal(forged.created().sourceMessageId, undefined, "the production domain bridge must not associate an audit ID with a different admitted request");
    evidence.push({ case: "forged-audit", taskId: forged.taskId, submissionId: input.id, workId: forged.created().workId, sourceMessageId: null });
  } finally { await forged.close(); }
  const multiple = await open("multiple");
  try {
    // The second authenticated input arrives while a real native tool is running.
    // Pi alone merges the steer into the active run after that tool boundary.
    const first = await multiple.runtime.submit("multi-hold: Create the isolated multi-input Goal.", "multi-original-1", "followUp", metadata("multi-original-1"));
    await multiple.holding;
    const second = await multiple.runtime.submit("Also consider this independent second request.", "multi-original-2", "steer", metadata("multi-original-2"));
    multiple.releaseHold();
    const inputs = [first.id, second.id];
    for (const id of inputs) {
      const receipt = await multiple.runtime.harness.submission(id, context); assert(receipt);
      assert.equal((await receipt.wait(context)).status, "done");
    }
    await multiple.runtime.conversation.waitForIdle(context);
    assert.equal(multiple.observedRuns.length, 1); assert.deepEqual(multiple.observedRuns[0], inputs);
    assert.equal(multiple.created().sourceMessageId, undefined, "an actual multi-input native run must not guess an external recipient");
    evidence.push({ case: "multiple-native-inputs", taskId: multiple.taskId, submissionIds: inputs,
      observedRunInputs: multiple.observedRuns[0], workId: multiple.created().workId, sourceMessageId: null });
  } finally { await multiple.close(); }
  console.log("PASS native input provenance: exact single receipt/entry reaches Work.sourceMessageId; unrelated, forged, cross-conversation, empty and actual merged-input runs cannot select an external source");
  return evidence;
}
