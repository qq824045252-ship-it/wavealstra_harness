import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { DOTS_TASK_ID, type DotsAssistantReply } from "../src/shared/dots";
import type { AgentUiPatch } from "../src/shared/agent-ipc";
import { createAgentDurableFixture } from "./agent-durable-fixture";
import { DotsActions } from "../src/main/dots/DotsActions";
import { ArtifactRepository } from "../src/main/artifact/ArtifactRepository";

export async function verifyDurableDotsReplies(root: string) {
  await mkdir(root, { recursive: true });
  const db = new AppDatabase(join(root, "app.db"));
  new ArtifactRepository(db.connection);
  db.openDots();
  db.upsertTask({ id: "reply-worker", title: "Archive worker", updatedAt: Date.now() });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let workerStage: "register" | "ask" | "complete" = "complete";
  const fixture = await createAgentDurableFixture(root, db, async input => {
    const tools = getCurrentTools(input.messages);
    if (!tools.length) return [{ type: "text", text: '{"candidates":[]}' }];
    if (!tools.some(t => t.name === "dots_action") && workerStage === "register") {
      workerStage = "ask";
      return [{ type: "toolCall", id: "preserve-index", name: "register_artifact", arguments: { path: "partial.tsv" } }];
    }
    if (!tools.some(t => t.name === "dots_action") && workerStage === "ask") {
      workerStage = "complete";
      return [{ type: "text", text: JSON.stringify({ dotsState: "progress", result: "已登记第一卷目录。", remainingQuote: "检查卷号。" }) },
        { type: "toolCall", id: "ask-binding", name: "request_user_input",
        arguments: { kind: "short_text", title: "卷号如何填写？", description: "请提供馆藏编号。" } }];
    }
    entered(); await gate;
    return [{ type: "text", text: "已接单。" }];
  });
  const agent = fixture.agent, patches: AgentUiPatch[] = [];
  agent.setDotsActions(new DotsActions(db, agent, { link() { throw new Error("Unexpected delegate"); } }));
  const unsubscribe = agent.onPatch(patch => patches.push(patch));
  try {
    const sourceMessageId = "native-delivery-archive-request";
    const accepted = await agent.prompt({ taskId: DOTS_TASK_ID, modelId: "fixture/model", text: "委派整理档案。",
      userMessageId: sourceMessageId, assistantMessageId: "archive-ack" });
    await started;
    const active = await agent.loadTaskHistory(DOTS_TASK_ID, undefined, "current");
    const source = active.messages.find(m => m.role === "user" && m.inputRequestId === sourceMessageId)!;
    const reply: DotsAssistantReply = { deliveryKey: "receipt:archive:1", operationId: "archive-op-1", taskId: "reply-worker",
      sourceMessageId, origin: { conversationId: Number(active.durable?.conversationId), entryId: Number(source.entryId) },
      title: "档案", kind: "conclusion", text: "第一次编目已交付。", artifacts: [{ id: "ledger-copy", name: "目录.tsv", version: 2,
        saved: { snapshotPath: join(root, "目录.tsv"), name: "目录.tsv" } }] };
    assert.equal((await agent.appendDotsReply(reply)).status, "pending");
    release();
    assert.equal((await agent.waitForSubmission(accepted.receipt!)).receipt?.status, "done");
    const requestsBeforeDelivery = fixture.requests.length;
    let results: string[] = [];
    for (let i=0; i<100; i++) {
      results = (await Promise.all([agent.appendDotsReply(reply), agent.appendDotsReply(reply)])).map(result => result.status);
      if (!results.includes("pending")) break;
      await delay(10);
    }
    assert.deepEqual(results.sort(), ["appended","existing"]);
    const messages = (await agent.loadTaskHistory(DOTS_TASK_ID)).messages;
    assert.deepEqual(messages.map(m => [m.role,m.text]), [["user","委派整理档案。"],["assistant","已接单。"],["assistant",reply.text]]);
    const delivered = messages.at(-1)!;
    assert(delivered.createdAt > messages[1]!.createdAt);
    assert.deepEqual(delivered.dotsDelivery, reply);
    assert.equal(fixture.requests.length, requestsBeforeDelivery, "delivery never starts another native generation");
    assert(patches.some(p => p.type === "durable_delta" && p.taskId === DOTS_TASK_ID && p.delta.upserts.some(m => m.id === delivered.id)));
    assert(!(await agent.loadTaskHistory(reply.taskId)).messages.some(m => m.dotsDelivery));
    const cancelled = { ...reply, deliveryKey: "withdrawn-during-commit" };
    let checks = 0;
    assert.equal((await agent.appendDotsReply(cancelled, () => ++checks < 3)).status, "discarded");
    assert(!(await agent.loadTaskHistory(DOTS_TASK_ID)).messages.some(m => m.dotsDelivery?.deliveryKey === cancelled.deliveryKey));
    await agent.releaseDurableTask(DOTS_TASK_ID);
    const restored = await agent.loadTaskHistory(DOTS_TASK_ID, { aroundEntryId: Number(delivered.entryId) });
    assert.deepEqual(restored.messages.find(m => m.id === delivered.id)?.dotsDelivery, reply);
    const replay = await agent.appendDotsReply({ ...reply, text: "重放时重新组装的文字", artifacts: [] }, () => false);
    assert.deepEqual(replay, { status: "existing", reply, deliveredAt: delivered.createdAt });
    await fixture.prompt({ taskId: DOTS_TASK_ID, userMessageId: "ask-after-delivery", assistantMessageId: "next-answer", text: "继续。" });
    assert(fixture.requests.at(-1)?.input.messages.some(m => m.role === "assistant" && m.content.some(p => p.type === "text" && p.text === reply.text)));
    assert.equal((await agent.appendDotsReply(cancelled)).status, "appended", "the withdrawn transaction left no ghost receipt");
    const filesOnly = { ...reply, deliveryKey: "files-only", text: "" };
    await assert.rejects(agent.appendDotsReply({ ...filesOnly, artifacts: [] }), /Dots 交付需要正文或结果文件/);
    assert.equal((await agent.appendDotsReply(filesOnly)).status, "appended");
    await agent.releaseDurableTask(DOTS_TASK_ID);
    const fileMessage = (await agent.loadTaskHistory(DOTS_TASK_ID)).messages.find(m => m.dotsDelivery?.deliveryKey === filesOnly.deliveryKey);
    assert.ok(fileMessage);
    assert.equal(fileMessage.text, "");
    assert.deepEqual(fileMessage.dotsDelivery?.artifacts, filesOnly.artifacts);
    const wrongAnchor = { ...reply, origin: { ...reply.origin!, entryId: Number(delivered.entryId) }, deliveryKey: "wrong-user-entry" };
    assert.equal((await agent.appendDotsReply(wrongAnchor)).status, "discarded");
    await agent.deleteUserMessage({ taskId: DOTS_TASK_ID, userMessageIndex: 0, entryId: source.entryId });
    assert.equal((await agent.appendDotsReply({ ...reply, deliveryKey: "late-after-branch" })).status, "discarded");
    assert.equal((await agent.appendDotsReply({ ...reply, origin: undefined, deliveryKey: "old-after-branch" })).status, "discarded");
    assert.equal((await agent.appendDotsReply(reply, () => false)).status, "existing");
    assert.equal((await agent.loadTaskHistory(DOTS_TASK_ID)).messages.length, 0);
    const workerCwd = agent.resolveTaskExecutionWorkspaceCwd(reply.taskId);
    await writeFile(join(workerCwd, "partial.tsv"), "A1\t卷一");
    workerStage = "register";
    const partialRequest = "request-with-partial-work";
    const working = await agent.prompt({ taskId: reply.taskId, modelId: "fixture/model", text: "检查卷号。",
      userMessageId: partialRequest, assistantMessageId: "worker-asks" });
    for (let i = 0; i < 200 && !agent.getConversationRuntimeSnapshot(reply.taskId).interactions.some(q => q.status === "pending"); i++) await delay(25);
    const blocked = await agent.dotsSubmission(reply.taskId, partialRequest);
    assert.equal(blocked?.status, "blocked");
    assert.match(blocked!.text, /已登记第一卷目录/u);
    assert.match(blocked!.text, /卷号如何填写/u);
    assert.match(blocked!.text, /请提供馆藏编号/u);
    assert.equal(await readFile(blocked!.artifacts[0]!.saved!.snapshotPath, "utf8"), "A1\t卷一");
    const idleWakeups = () => patches.filter(p => p.type === "durable_delta" && p.taskId === reply.taskId
      && p.delta.state.status === "waiting_input").length;
    const beforePoll = idleWakeups();
    for (let i = 0; i < 3; i++) await agent.dotsSubmission(reply.taskId, partialRequest);
    assert(idleWakeups() - beforePoll < 3, "reading a blocked submission must not wake its own status observer repeatedly");
    await agent.abort(reply.taskId);
    await agent.waitForSubmission(working.receipt!);
    const failed = await agent.dotsSubmission(reply.taskId, partialRequest);
    assert.equal(failed?.status, "failed");
    assert.match(failed!.text, /abort|取消|中止/iu);
    assert.equal(failed!.artifacts[0]!.saved!.snapshotPath, blocked!.artifacts[0]!.saved!.snapshotPath);
    console.log("PASS Dots standalone assistant delivery: live delta, durable receipts, recovery, provenance, model history and removed branch");
  } finally {
    release(); unsubscribe(); await fixture.close(); db.close();
  }
}
