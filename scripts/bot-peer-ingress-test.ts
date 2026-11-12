import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { BotConversationService, type BotConversationServiceOptions } from "../src/main/agent/work/BotConversationService";
import { botCollaborationToolSchema } from "../src/main/agent/work/BotCollaborationService";
import { botMemorySource, botPeerMemoryInput } from "../src/main/memory/BotMemorySource";
import { botExtractionPolicy } from "../src/main/memory/BotMemoryExtractionPolicy";
import { botForegroundHistory } from "../src/main/agent/work/BotPeerContext";
import { botDelegationInput } from "../src/main/agent/work/BotDelegationInput";
import { LOCAL_USER_ID } from "../src/shared/bot-work";

const root = mkdtempSync(join(tmpdir(), "bot-peer-43-"));
const app = new AppDatabase(join(root, "app.db")), db = app.connection;
const bots = new BotRegistry(db);
for (const id of ["a", "b", "c", "ordinary"]) bots.registerBot({ botId: id, userId: LOCAL_USER_ID, displayName: id.toUpperCase(), authorization: DESKTOP_USER_GRANTS });
bots.registerBot({ botId: "foreign", userId: "other-user", displayName: "foreign", authorization: DESKTOP_USER_GRANTS });
const works = new WorkService(db, { bots });
const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null,
  modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
const textOf = (content: Context["messages"][number]["content"]) => typeof content === "string" ? content
  : content.filter(part => part.type === "text").map(part => part.text).join("\n");
const gates = new Map<string, { entered: boolean; release: () => void; wait: Promise<void> }>();
function gate(tag: string) {
  let release = () => {};
  const wait = new Promise<void>(resolve => { release = resolve; });
  const value = { entered: false, release, wait }; gates.set(tag, value); return value;
}
const requests: Array<{ tag: string; model: string; context: Context }> = [];
let sequence = 0, throwFreeze = false, freezeGate: ReturnType<typeof gate> | undefined;
models.registerProvider("peer43", { api: "openai-completions", apiKey: "fixture-only", baseUrl: "http://127.0.0.1:1",
  models: ["a", "b", "c", "ordinary"].map(id => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 128000,
    maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
  streamSimple: (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const user = [...context.messages].reverse().find(message => message.role === "user");
    const input = user ? textOf(user.content) : "";
    const tag = [...input.matchAll(/CASE:([\w-]+)/g)].at(-1)?.[1] ?? "plain";
    requests.push({ tag, model: model.id, context: structuredClone(context) });
    queueMicrotask(async () => {
      const barrier = gates.get(tag);
      if (model.id !== "a" && barrier) { barrier.entered = true; await barrier.wait; }
      if (options?.signal?.aborted) {
        const error: AssistantMessage = { role: "assistant", content: [], stopReason: "aborted", api: model.api,
          provider: model.provider, model: model.id, timestamp: Date.now(), usage: usage() };
        stream.push({ type: "error", reason: "aborted", error }); stream.end(); return;
      }
      const afterTool = context.messages.at(-1)?.role === "toolResult";
      const content: AssistantMessage["content"] = model.id !== "a" && tag.startsWith("work") && !afterTool
        ? [{ type: "toolCall", id: `create-${++sequence}`, name: "work_create", arguments: {
          title: `B plan CASE:${tag}`, goalDescription: "B 自己决定的执行计划", requestedOutcome: "one_time", mode: "once" } }]
        : [{ type: "text", text: model.id === "a" ? `A 整理收到的结果 CASE:${tag}` : `B 实际答复 CASE:${tag}` }];
      const message: AssistantMessage = { role: "assistant", content, stopReason: content.some(part => part.type === "toolCall") ? "toolUse" : "stop",
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage: usage() };
      stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message }); stream.end();
    });
    return stream;
  } });
function usage() { return { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }; }
for (const id of ["a", "b", "c", "ordinary"]) mkdirSync(join(root, id));
const frozen = (botId: string) => ({ profile: bots.activeSnapshot(botId)!, settings: {
  botId, modelId: `peer43/${botId}`, workspacePath: join(root, botId), effectiveWorkspacePath: join(root, botId),
  expertId: "", skillIds: ["own-skill"], mcpIds: ["own-mcp"], connectorIds: ["own-connector"], revision: 1, spaceId: "fixture" } });
const settings = new Map<string, ReturnType<typeof frozen>>(), schedules: string[] = [], composerOwners: string[] = [];
const options: BotConversationServiceOptions = { db, bots, works, models, userId: LOCAL_USER_ID, directory: join(root, "native"),
  defaultModel: () => "peer43/a", botModel: botId => `peer43/${botId}`, botWorkspace: botId => join(root, botId),
  isAuthority: () => true, memorySearch: () => [], schedule: work => { schedules.push(work.workId); }, wake: () => {},
  prepareMessage: async botId => { if (throwFreeze) throw Error("fixture freeze failure");
    if (freezeGate) { freezeGate.entered = true; await freezeGate.wait; } return frozen(botId); },
  captureSettings: (messageId, _botId, value) => { settings.set(messageId, value); },
  messageSettings: (messageId, botId) => settings.get(messageId) ?? frozen(botId),
};
// Profile has no public botId field; assert the actual frozen cwd against the fixture directories instead.
options.composerTools = async (_profile, cwd) => { assert(["a", "b", "c", "ordinary"].some(id => cwd === join(root, id)));
  composerOwners.push(cwd); return { tools: [], instructions: "fixture composer", close: async () => {} }; };
let service = new BotConversationService(options);
const wait = async (predicate: () => boolean, description: string) => {
  for (let i = 0; i < 750; i++) { if (predicate()) return; await delay(20); }
  throw Error(`timeout: ${description}`);
};
const count = (sql: string, ...args: string[]) => z.object({ n: z.number() }).parse(db.prepare(sql).get(...args)).n;
const rowSchema = z.object({ collaboration: z.object({ collaborationId: z.string(), workId: z.string().nullable() }) });
const source = (text: string, botId = "a") => service.messages.accept(LOCAL_USER_ID,
  { botId, requestId: `source-${++sequence}`, text, ...(text.includes("work-barrier") ? { attachments: [{ name: "input.txt", path: join(root, "input.txt") }] } : {}) });
const command = async (tag: string, targetBotId = "b", action = "delegate") => {
  const receipt = source(`原用户目标 CASE:${tag}`);
  const result = rowSchema.parse(await service.collaborations.command(receipt.assistantMessageId, "send", {
    action, targetBotId, text: `A 转述 CASE:${tag}` }));
  return { receipt, id: result.collaboration.collaborationId };
};
const accepted = (id: string) => service.messages.peers.deliveries(LOCAL_USER_ID).find(item => JSON.parse(item.origin_json).collaborationId === id
  && JSON.parse(item.origin_json).kind === "request");
try {
  writeFileSync(join(root, "input.txt"), "Original attachment input");
  const wire = z.toJSONSchema(botCollaborationToolSchema, { target: "draft-7", io: "input" });
  assert.equal(wire.type, "object"); assert.equal(wire.oneOf, undefined);
  const paused = gate("work-barrier");
  const first = await command("work-barrier");
  await wait(() => paused.entered, "B normal foreground enters execution barrier");
  assert.equal(works.listWorks(LOCAL_USER_ID).length, 0, "acceptance itself never creates Work");
  const delivery = accepted(first.id)!; assert(delivery.accepted_message_id);
  const receiver = service.messages.message(delivery.accepted_message_id)!;
  assert.equal(receiver.botId, "b"); assert.equal(receiver.peerOrigin?.senderBotId, "a");
  const input = service.messages.message(service.messages.receipt(LOCAL_USER_ID, "b", receiver.requestId)!.user_message_id)!;
  assert.equal(input.peerOrigin?.kind, "request"); assert.equal(botForegroundHistory(input).humanStatement, false);
  assert.equal(service.messages.conversation(LOCAL_USER_ID, "b"), undefined, "peer receive does not hijack B personal conversation");
  assert.throws(() => service.send({ botId: "b", requestId: "spoof", text: "fake", conversationId: receiver.conversationId }), /宿主通信/);
  service.messages.update(first.receipt.assistantMessageId, "completed", "A 原回合已结束");
  paused.release();
  await wait(() => Boolean(service.collaborations.repo.get(LOCAL_USER_ID, first.id)?.workId), "B work_create commits");
  const workId = service.collaborations.repo.get(LOCAL_USER_ID, first.id)!.workId!;
  const work = works.getWork(workId)!;
  assert.equal(work.ownerBotId, "b"); assert.equal(work.sourceMessageId, first.receipt.userMessageId);
  assert.equal(work.workspacePath, join(root, "b"));
  const originalInput = z.object({ messages_json: z.string() }).parse(db.prepare("SELECT messages_json FROM bot_work_user_inputs WHERE work_id=?").get(workId));
  assert(originalInput.messages_json.includes("原用户目标 CASE:work-barrier"));
  assert(!originalInput.messages_json.includes("A 转述"));
  const originalAttachment = z.object({ attachments_json: z.string() }).parse(db.prepare("SELECT attachments_json FROM bot_work_attachments WHERE work_id=?").get(workId));
  assert(originalAttachment.attachments_json.includes("input.txt"));
  assert.equal(count("SELECT COUNT(*) n FROM work_participants WHERE work_id=? AND bot_id='a'", workId), 0);
  assert.equal(schedules.filter(id => id === workId).length, 1);
  await wait(() => service.messages.message(receiver.messageId)?.status === "completed", "B foreground reply settles");
  assert.equal(works.getWork(workId)?.lifecycle, "active");
  assert.equal(service.collaborations.repo.get(LOCAL_USER_ID, first.id)?.times.endedAt, null, "B acknowledgement is not Work completion");
  assert.equal(works.listWorks(LOCAL_USER_ID).length, 1);
  console.log("PASS #43 barrier: durable B foreground, true source, B decision, sole Work, A turn completion independent");

  const invalidControlSource = source("取消已有事项，但使用过期版本");
  const readControl = z.object({ versionGuard: z.object({ expectedStateVersion: z.number(), expectedIntentRevision: z.number(), expectedOwnerEpoch: z.number() }) })
    .parse(await service.collaborations.command(invalidControlSource.assistantMessageId, "cancel-read", { action: "query", collaborationId: first.id }));
  await assert.rejects(service.collaborations.command(invalidControlSource.assistantMessageId, "cancel-stale", {
    action: "cancel", collaborationId: first.id, versionGuard: { ...readControl.versionGuard, expectedStateVersion: readControl.versionGuard.expectedStateVersion + 1 } }), /先查询|版本/);
  assert.equal(works.getWork(workId)?.lifecycle, "active");
  assert(service.messages.peers.deliveries(LOCAL_USER_ID, first.id).every(delivery => delivery.cancelled_at === null),
    "a rejected Work control cannot cancel the foreground or its returns");
  console.log("PASS #43 invalid Work cancellation leaves the recipient and all return deliveries intact");

  const publicFeedback = { workId, eventId: "public-report", kind: "result" as const, category: "result" as const,
    intentRevision: work.intentRevision, inputSnapshotId: work.inputSnapshotId,
    report: { title: "经过核验的阶段成果", summary: "PUBLIC_REPORT CASE:public-result", artifactRefs: [], milestone: true as const,
      reviewStatus: "accepted" as const, current: true, notices: [] } };
  const returnsBefore = count("SELECT COUNT(*) n FROM bot_peer_deliveries WHERE json_extract(origin_json,'$.kind')='return'");
  service.messages.appendWorkDelivery(LOCAL_USER_ID, workId, "public-report", "v1", "PRIVATE_TOOL_LOG: raw execution record", publicFeedback);
  service.collaborations.publishWork(workId);
  await wait(() => requests.some(item => item.model === "a" && item.tag === "public-result"), "A summarizes the public report");
  const sourceReport = service.history({ botId: "a", conversationId: first.receipt.conversationId });
  assert(!sourceReport.messages.some(message => message.text.includes("PRIVATE_TOOL_LOG")), "raw tools stay in B/Work records");
  service.messages.appendWorkDelivery(LOCAL_USER_ID, workId, "public-report", "v1", "PRIVATE_TOOL_LOG: raw execution record", publicFeedback);
  service.collaborations.publishWork(workId); await delay(80);
  const reportReturns = service.messages.peers.deliveries(LOCAL_USER_ID).filter(item => item.text.includes("PUBLIC_REPORT"));
  assert.equal(reportReturns.length, 1); assert.equal(schedules.filter(id => id === workId).length, 1);
  assert(count("SELECT COUNT(*) n FROM bot_peer_deliveries WHERE json_extract(origin_json,'$.kind')='return'") >= returnsBefore);
  console.log("PASS #43 accepted Work reports reach A once, raw execution records stay out of A chat, business is never rerun");

  const plain = await command("answer", "b", "ask");
  await wait(() => service.collaborations.repo.get(LOCAL_USER_ID, plain.id)?.status === "returned", "direct answer is summarized by A");
  assert.equal(service.collaborations.repo.get(LOCAL_USER_ID, plain.id)?.workId, null);
  assert(service.history({ botId: "a", conversationId: plain.receipt.conversationId }).messages.some(message => message.peerOrigin?.kind === "return" && message.status === "completed"));
  const before = count("SELECT COUNT(*) n FROM bot_send_receipts WHERE bot_id='b'");
  await service.collaborations.command(plain.receipt.assistantMessageId, "send", { action: "ask", targetBotId: "b", text: "A 转述 CASE:answer" }).catch(error => {
    // A's original turn may already have finished; replays must not execute again.
    assert.match(String(error), /有效个人请求/);
  });
  assert.equal(count("SELECT COUNT(*) n FROM bot_send_receipts WHERE bot_id='b'"), before);
  console.log("PASS #43 simple answer returns through A original foreground, no Work or duplicate receive");

  const one = gate("parallel-one"), two = gate("parallel-two");
  const [p1, p2] = await Promise.all([command("parallel-one"), command("parallel-two", "c")]);
  await wait(() => one.entered && two.entered, "independent collaborations execute concurrently");
  const followSource = source("继续原事项 CASE:follow");
  await service.collaborations.command(followSource.assistantMessageId, "follow", { action: "follow_up", collaborationId: p1.id, text: "CASE:follow" });
  await delay(80); assert(!requests.some(request => request.tag === "follow" && request.model === "b"), "same collaboration preserves request order");
  one.release(); two.release();
  await wait(() => requests.some(request => request.tag === "follow" && request.model === "b"), "follow-up uses original receiver conversation");
  assert.notEqual(accepted(p1.id)?.request_id, accepted(p2.id)?.request_id);
  console.log("PASS #43 separate goals concurrent, same collaboration ordered, no target crossover");

  const cancelling = gate("cancel-before-work"); const cancelCase = await command("cancel-before-work");
  await wait(() => cancelling.entered, "B cancellable foreground running");
  const cancelSource = source("取消刚才的协作");
  const cancellingTask = service.collaborations.command(cancelSource.assistantMessageId, "cancel", { action: "cancel", collaborationId: cancelCase.id });
  cancelling.release(); await cancellingTask;
  assert.equal(service.collaborations.repo.get(LOCAL_USER_ID, cancelCase.id)?.workId, null);
  assert.equal(service.messages.message(accepted(cancelCase.id)!.accepted_message_id!)?.status, "cancelled");
  const beforeLateReturn = service.messages.peers.deliveries(LOCAL_USER_ID, cancelCase.id).length;
  // A persisted completion can become visible after cancellation/restart even
  // when its original observer did not run. It must not create a fresh return.
  db.prepare("UPDATE bot_messages SET status='completed',text='late answer' WHERE message_id=?")
    .run(accepted(cancelCase.id)!.accepted_message_id!);
  service.collaborations.delivery!.observe(accepted(cancelCase.id)!.accepted_message_id!);
  service.collaborations.recover(); await delay(80);
  assert.equal(service.messages.peers.deliveries(LOCAL_USER_ID, cancelCase.id).length, beforeLateReturn);
  assert.equal(service.collaborations.repo.get(LOCAL_USER_ID, cancelCase.id)?.status, "cancelled");
  console.log("PASS #43 pre-Work cancel needs no versionGuard and stops only its recipient request");

  const returnBarrier = gate("return-cancel-sink");
  options.deliverPeerReturn = async (_source, _operation, text) => {
    if (text.includes("CASE:cancel-return")) { returnBarrier.entered = true; await returnBarrier.wait; }
  };
  const returning = await command("cancel-return", "c", "ask");
  await wait(() => returnBarrier.entered, "A summary is waiting at its delivery boundary");
  const stopReturnSource = source("取消这条尚未送出的协作回流");
  await service.collaborations.command(stopReturnSource.assistantMessageId, "cancel-return", { action: "cancel", collaborationId: returning.id });
  returnBarrier.release(); await delay(80);
  assert.equal(service.collaborations.repo.get(LOCAL_USER_ID, returning.id)?.status, "cancelled");
  const stoppedReturn = service.messages.peers.deliveries(LOCAL_USER_ID).find(item => JSON.parse(item.origin_json).collaborationId === returning.id
    && JSON.parse(item.origin_json).kind === "return")!;
  assert(stoppedReturn.cancelled_at !== null); assert.equal(stoppedReturn.returned_at, null);
  console.log("PASS #43 whole-collaboration cancel fences pending A returns and late acknowledgments");

  let returnFailure = true;
  options.deliverPeerReturn = async (_source, _operation, text) => {
    if (returnFailure && text.includes("CASE:return-failure")) throw Error("fixture return failure");
  };
  const failedReturn = await command("return-failure", "b", "ask");
  await wait(() => service.collaborations.repo.get(LOCAL_USER_ID, failedReturn.id)?.status === "unknown", "return failure is persisted independently");
  const beforeReturnRecovery = requests.filter(item => item.tag === "return-failure").length;
  returnFailure = false;
  await service.close(); service = new BotConversationService(options); service.recover();
  await wait(() => service.collaborations.repo.get(LOCAL_USER_ID, failedReturn.id)?.status === "returned", "completed A output is delivered after recovery");
  assert.equal(requests.filter(item => item.tag === "return-failure").length, beforeReturnRecovery, "return retry never repeats B execution or A generation");
  options.deliverPeerReturn = undefined;
  console.log("PASS #43 failed return recovers from the original A output without repeating inference or business actions");

  throwFreeze = true;
  const pendingSource = source("冻结失败 CASE:recover");
  await assert.rejects(service.collaborations.command(pendingSource.assistantMessageId, "recover", { action: "ask", targetBotId: "b", text: "CASE:recover" }), /freeze failure/);
  throwFreeze = false;
  await service.close(); service = new BotConversationService(options); service.recover();
  await wait(() => requests.some(request => request.tag === "recover" && request.model === "b"), "durable prepared outbox recovered");
  await wait(() => !service.activeRequests().some(item => item.message.peerOrigin?.kind === "request"), "recovered requests settle");
  const n = count("SELECT COUNT(*) n FROM bot_send_receipts WHERE bot_id='b'"); service.recover(); await delay(100);
  assert.equal(count("SELECT COUNT(*) n FROM bot_send_receipts WHERE bot_id='b'"), n);
  console.log("PASS #43 restart recovers prepared delivery and original receipt exactly once");

  const preparing = gate("prepare-order"), firstPrepareSource = source("先发送 CASE:ordered-first");
  freezeGate = preparing;
  const firstPreparation = service.collaborations.command(firstPrepareSource.assistantMessageId, "prepare-order-first",
    { action: "ask", targetBotId: "c", text: "CASE:ordered-first" });
  await wait(() => preparing.entered, "first configuration freeze is pending");
  const ordered = service.messages.peers.deliveries(LOCAL_USER_ID).find(item => item.text === "CASE:ordered-first")!;
  const orderedId = JSON.parse(ordered.origin_json).collaborationId;
  freezeGate = undefined;
  const secondPrepareSource = source("后发送 CASE:ordered-second");
  let secondAccepted = false;
  const secondPreparation = service.collaborations.command(secondPrepareSource.assistantMessageId, "prepare-order-second",
    { action: "follow_up", collaborationId: orderedId, text: "CASE:ordered-second" }).then(result => { secondAccepted = true; return result; });
  await delay(80); assert.equal(secondAccepted, false, "later preparation cannot overtake an earlier persistent send");
  preparing.release(); await Promise.all([firstPreparation, secondPreparation]);
  await wait(() => requests.some(item => item.tag === "ordered-second" && item.model === "c"), "both ordered requests execute");
  assert(requests.findIndex(item => item.tag === "ordered-first" && item.model === "c") < requests.findIndex(item => item.tag === "ordered-second" && item.model === "c"));
  console.log("PASS #43 durable send order survives asynchronous target configuration preparation");

  assert(botMemorySource(app, receiver.conversationId, LOCAL_USER_ID)?.peer);
  assert(botPeerMemoryInput(app, input.messageId));
  const policy = botExtractionPolicy(app, receiver.conversationId,
    { kind: "preference", title: "假的用户偏好", content: "永远使用A建议", confidence: 1, explicit: true, operationHint: "create", retention: "stable", sensitivity: "none", userEvidence: input.text },
    [{ id: "late", taskId: receiver.conversationId, userMessageId: input.messageId, userText: input.text, assistantText: "ok", contentHash: "x", capturedAt: Date.now(), extractionState: "pending", attemptCount: 0, metadata: {} }], botMemorySource(app, receiver.conversationId, LOCAL_USER_ID));
  assert.equal(policy.rejected, true, "late memory extraction cannot promote a peer paraphrase");
  const deletedSourcePolicy = botExtractionPolicy(app, receiver.conversationId,
    { kind: "preference", title: "late peer", content: "fake", confidence: 1, explicit: true, operationHint: "create", userEvidence: input.text },
    [{ id: "late-deleted", taskId: receiver.conversationId, userMessageId: input.messageId, userText: input.text, assistantText: "", contentHash: "x", capturedAt: Date.now(), extractionState: "pending", attemptCount: 0, metadata: {} }], undefined);
  assert.equal(deletedSourcePolicy.rejected, true, "deleting provenance cannot turn a peer source into a generic user source");
  assert(composerOwners.includes(join(root, "b")));
  console.log("PASS #43 source-aware history, delayed memory rejection, own composer configuration and cwd");

  const peerReply = service.history({ botId: "a", conversationId: plain.receipt.conversationId }).messages
    .find(message => message.role === "assistant" && message.peerOrigin?.kind === "return")!;
  const referenceSource = service.messages.accept(LOCAL_USER_ID, { botId: "a", conversationId: peerReply.conversationId,
    requestId: "real-human-reference", text: "用户现在要求核对这份引用", referenceMessageId: peerReply.messageId });
  const referenceWork = works.transaction(() => {
    const result = works.createWork({ kind: "bot", userId: LOCAL_USER_ID, botId: "a", host: "foreground", grants: DESKTOP_USER_GRANTS },
      { operationId: "reference-work", title: "核对引用", ownerBotId: "a", authorization: DESKTOP_USER_GRANTS,
        conversationId: referenceSource.conversationId, sourceMessageId: referenceSource.userMessageId, inputSnapshotId: `input:${referenceSource.userMessageId}` });
    assert(result.ok); service.messages.linkWorkUserInput(service.messages.receipt(LOCAL_USER_ID, "a", referenceSource.requestId)!, result.work);
    return result.work;
  });
  const evidence = botDelegationInput(db, referenceWork, referenceWork.sourceVersion)!;
  assert.equal(evidence.messages[0]?.text, "用户现在要求核对这份引用");
  assert(evidence.referencedContext.some(message => message.messageId === peerReply.messageId && message.peerOrigin?.kind === "return"));
  console.log("PASS #43 real human references retain peer provenance in frozen Work evidence");

  for (let index = 0; index < 60; index++) {
    const ordinary = source(`普通用户历史 ${index}`); service.messages.update(ordinary.assistantMessageId, "completed", `普通答复 ${index}`);
  }
  const lateHistory = service.send({ botId: "a", requestId: "peer-beyond-history-window", text: "CASE:history-window" });
  await wait(() => service.messages.message(lateHistory.assistantMessageId)?.status === "completed", "ordinary turn beyond the peer history page");
  const frozenHistory = z.object({ context_json: z.string() }).parse(db.prepare("SELECT context_json FROM bot_request_runs WHERE message_id=?").get(lateHistory.assistantMessageId));
  const context = z.object({ native: z.array(z.unknown()), history: z.array(z.object({ peerOrigin: z.unknown().optional() })) }).parse(JSON.parse(frozenHistory.context_json));
  assert(context.history.every(item => item.peerOrigin === undefined), "peer entries have left the current history page");
  assert.equal(context.native.length, 0, "old native peer inputs cannot reappear as raw human turns after paging");
  console.log("PASS #43 peer source separation survives later ordinary turns beyond the bounded history page");

  const committedCancelSource = source("取消已有 Work，模拟提交后宿主中断");
  const cancelRead = z.object({ versionGuard: z.object({ expectedStateVersion: z.number(), expectedIntentRevision: z.number(), expectedOwnerEpoch: z.number() }) })
    .parse(await service.collaborations.command(committedCancelSource.assistantMessageId, "crash-query", { action: "query", collaborationId: first.id }));
  service.collaborations.delivery!.cancel = async () => { throw Error("fixture interruption after Work cancellation"); };
  await assert.rejects(service.collaborations.command(committedCancelSource.assistantMessageId, "crash-cancel", {
    action: "cancel", collaborationId: first.id, versionGuard: cancelRead.versionGuard }), /fixture interruption/);
  assert.equal(works.getWork(workId)?.closureConclusion, "cancelled");
  assert(service.messages.peers.deliveries(LOCAL_USER_ID, first.id).every(delivery => delivery.cancelled_at !== null),
    "the successful Work cancellation and peer fence commit in the same transaction");
  service.messages.update(receiver.messageId, "queued", "persisted B projection before interruption");
  const beforeCancelRecovery = requests.filter(request => request.model === "b" && request.tag === "work-barrier").length;
  await service.close(); service = new BotConversationService(options); service.recover();
  await wait(() => service.messages.message(receiver.messageId)?.status === "cancelled", "cancelled foreground projection recovers");
  assert.equal(requests.filter(request => request.model === "b" && request.tag === "work-barrier").length, beforeCancelRecovery);
  console.log("PASS #43 committed cancellation recovers its foreground stop without inference or delivery replay");
  const beforeLateReport = service.messages.peers.deliveries(LOCAL_USER_ID, first.id).length;
  service.messages.appendWorkDelivery(LOCAL_USER_ID, workId, "late-public-report", "v2", "late Work evidence", {
    ...publicFeedback, eventId: "late-public-report", report: { ...publicFeedback.report, summary: "late cancelled result" } });
  service.collaborations.publishWork(workId); await delay(80);
  assert.equal(service.messages.peers.deliveries(LOCAL_USER_ID, first.id).length, beforeLateReport);
  assert(service.collaborations.history({ botId: "a", collaborationId: first.id, limit: 100 }).messages
    .some(message => message.workFeedback?.eventId === "late-public-report"), "actual Work evidence survives cancellation");
  console.log("PASS #43 cancellation retains late Work evidence without creating another A return");

  const closingGate = gate("close-during-prepare"); freezeGate = closingGate;
  const closingSource = source("关闭时保留未受理发送 CASE:close");
  const closingSend = service.collaborations.command(closingSource.assistantMessageId, "close-pending", { action: "ask", targetBotId: "c", text: "CASE:close" });
  await wait(() => closingGate.entered, "close while preparing configuration");
  await service.close(); closingGate.release();
  await assert.rejects(closingSend, /关闭|恢复/);
  freezeGate = undefined;
  console.log("PASS #43 shutdown prevents late admission or acknowledgments after the host closes");
} finally {
  for (const barrier of gates.values()) barrier.release();
  await service.close(); app.close(); rmSync(root, { recursive: true, force: true });
}
