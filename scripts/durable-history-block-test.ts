import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, type AssistantMessage } from "@earendil-works/pi-ai";
import { AgentDoc, InboxDoc, GenerationTask } from "@earendil-works/pi-durable";
import { ActiveDurableConversation } from "../src/main/agent/durable/DurableConversationBranch";
import { migrateDurableWorkspace, WorkspaceMigrationBusyError } from "../src/main/agent/durable/DurableWorkspaceMigration";
import { DurableBotRuntime } from "../src/main/agent/durable/DurableBotRuntime";

const directory = await mkdtemp(join(tmpdir(), "durable-history-block-"));
// Keep model/auth state out of the real user profile.
process.env.HOME = directory;
process.env.USERPROFILE = directory;
const cwd = join(directory, "workspace");
await mkdir(cwd);
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
let runtime = await DurableBotRuntime.open({ directory: join(directory, "state"), cwd, models: createModels(), toolMode: "native", instructions: () => "", onSnapshot: () => {} });
try {
  for (let batch = 0; batch < 12; batch++) {
    await runtime.conversation.commit(async tx => {
      for (let i = 0; i < 20; i++) {
        const n = batch * 20 + i;
        await tx.appendEntry(runtime.conversation.id, { kind: "pi.user", model: [{ role: "user", content: `question ${n}`, timestamp: n * 3 + 1 }] });
        const assistant: AssistantMessage = { role: "assistant", content: [{ type: "text", text: `answer ${n}` }, { type: "toolCall", id: `tool-${n}`, name: "fixture", arguments: {} }], stopReason: "toolUse", api: "openai-completions", model: "fixture", provider: "fixture", timestamp: n * 3 + 2, usage };
        await tx.appendEntry(runtime.conversation.id, { kind: "pi.assistant", model: [assistant] });
        await tx.appendEntry(runtime.conversation.id, { kind: "pi.tool", model: [{ role: "toolResult", toolCallId: `tool-${n}`, toolName: "fixture", content: [{ type: "text", text: "done" }], isError: false, timestamp: n * 3 + 3 }] });
        for (let hidden = 0; hidden < (n === 80 ? 12 : 1); hidden++) {
          await tx.appendEntry(runtime.conversation.id, { kind: "mybuddy.context-import", model: [{ role: "user", content: "hidden", timestamp: n * 3 + 3 }] });
        }
      }
    }, context);
    await runtime.refresh();
  }
  const snapshot = runtime.snapshot;
  assert(snapshot.historyBefore !== undefined);
  const liveIds = new Set(snapshot.messages.map(message => message.id));
  let before: number | undefined = snapshot.historyBefore;
  let messages = [...snapshot.messages];
  let blocks = 0;
  while (before !== undefined) {
    const block = await runtime.loadHistoryBlock(before, 7);
    assert(block.messages.length > 0);
    assert.equal(block.epoch, snapshot.epoch);
    assert(block.before === undefined || block.before < before);
    assert(block.messages.every(message => !liveIds.has(message.id)));
    assert.deepEqual(Object.keys(block).sort(), ["before", "epoch", "messages"]);
    messages = [...block.messages, ...messages];
    before = block.before;
    assert(++blocks < 500);
  }
  assert.equal(new Set(messages.map(message => message.id)).size, messages.length);
  assert.deepEqual(messages.map(message => message.text), Array.from({ length: 240 }, (_, n) => [`question ${n}`, `answer ${n}`]).flat());
  assert(messages.filter(message => message.role === "assistant").every(message => message.tools?.[0]?.status === "success"));
  assert.equal(runtime.snapshot, snapshot);
  console.log(`PASS ${blocks} history blocks, complete ordered transcript, tool results and live snapshot isolation`);
  const target = join(directory, "moved"); await mkdir(target);
  assert.equal(await runtime.canRebindWorkspace(), true);
  await runtime.conversation.commit(async tx => {
    (await tx.doc(ActiveDurableConversation)).regeneration = { kind: "pending", input: { operationId: "pending-move", content: "must not move" } };
  }, context);
  assert.equal(await runtime.canRebindWorkspace(), false);
  await assert.rejects(migrateDurableWorkspace(runtime.harness, cwd, target, context), WorkspaceMigrationBusyError);
  assert.equal((await runtime.conversation.agent(context)).cwd, cwd);
  await runtime.conversation.commit(async tx => { (await tx.doc(ActiveDurableConversation)).regeneration = undefined; }, context);
  const child = await runtime.harness.createConversation({ ownership: { kind: "ownerless" }, init: async (tx, id) => {
    (await tx.doc(AgentDoc, id)).cwd = cwd;
  } }, context);
  // An unrelated branch's queued input must prevent migration, even when the visible root is idle.
  await child.commit(async tx => { (await tx.doc(InboxDoc, child.id)).items.push({ id: 1, mode: "followUp", content: "queued" } as never); }, context);
  assert.equal(await runtime.canRebindWorkspace(), false);
  await assert.rejects(migrateDurableWorkspace(runtime.harness, cwd, target, context), WorkspaceMigrationBusyError);
  await child.commit(async tx => { (await tx.doc(InboxDoc, child.id)).items = []; }, context);
  await child.commit(async tx => { (await tx.doc(AgentDoc, child.id)).cwd = join(directory, "unexpected"); }, context);
  await assert.rejects(migrateDurableWorkspace(runtime.harness, cwd, target, context), /来源不一致/);
  assert.equal((await runtime.conversation.agent(context)).cwd, cwd, "failed migration transaction rolls back all branches");
  await child.commit(async tx => { (await tx.doc(AgentDoc, child.id)).cwd = cwd; }, context);
  const childId = child.id;
  const isolatedCwd = join(directory, "isolated-child"); await mkdir(isolatedCwd);
  const ownedChildId = await runtime.conversation.commit(async tx => {
    const owner = await tx.createTask(GenerationTask, {}, { ownership: { kind: "conversation" } });
    const owned = await tx.createConversation({ ownership: { kind: "task", taskId: owner } });
    (await tx.doc(AgentDoc, owned.id)).cwd = isolatedCwd;
    return owned.id;
  }, context);
  assert.equal(await runtime.canRebindWorkspace(), false, "even invisible native pending tasks fence a move");
  await runtime.conversation.abort(context);
  assert.equal(await runtime.canRebindWorkspace(), true);
  await runtime.close();
  const reopened = { directory: join(directory, "state"), cwd: target, workspaceMigrationFrom: cwd, models: createModels(), toolMode: "native" as const, instructions: () => "", onSnapshot: () => {} };
  runtime = await DurableBotRuntime.open(reopened);
  assert.equal((await runtime.conversation.agent(context)).cwd, target);
  assert.equal((await (await runtime.harness.conversation(childId, context))!.agent(context)).cwd, target);
  assert.equal((await (await runtime.harness.conversation(ownedChildId, context))!.agent(context)).cwd, isolatedCwd, "completed isolated subagent keeps its authorized worktree");
  await runtime.close();
  runtime = await DurableBotRuntime.open(reopened); // crash after native commit, before SQLite acknowledgement
  assert.equal((await runtime.conversation.agent(context)).cwd, target);
  assert.equal(runtime.snapshot.messages.at(-1)?.text, snapshot.messages.at(-1)?.text);
  console.log("PASS atomic native cwd migration, child inbox and regeneration fences, branch rollback and crash replay");

} finally {
  await runtime.close();
  await rm(directory, { recursive: true, force: true });
}
