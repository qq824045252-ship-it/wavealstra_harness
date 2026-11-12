import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { join, resolve, relative } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { BotDeletionService } from "../src/main/agent/work/BotDeletionService";
import { BotConversationRepository } from "../src/main/agent/work/BotConversationRepository";
import { BotCollaborationService, botCollaborationToolSchema } from "../src/main/agent/work/BotCollaborationService";
import { BotPeerCallService } from "../src/main/agent/work/BotPeerCallService";
import { BotWorkQuery } from "../src/main/agent/work/BotWorkQuery";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { WorkConversationFeedback } from "../src/main/agent/work/WorkConversationFeedback";
import { WorkFileEventSource } from "../src/main/agent/work/WorkFileEventSource";
import type { BotConversationServiceOptions } from "../src/main/agent/work/BotConversationService";
import { botCollaborationSchema } from "../src/shared/bot-collaboration";
import { botWorkVersionGuardSchema } from "../src/main/agent/work/BotForegroundTools";
import type { WorkFeedbackDto } from "../src/shared/bot-conversation";
import { mergeBotMessageEvent } from "../src/renderer/src/store/app/slices/botMessageStream";

// The real provider rejected the discriminated union at the function-schema
// root with HTTP 400. Exercise the serialized wire shape, not Zod internals.
const wireSchema = z.object({ type: z.literal("object"), properties: z.object({ action: z.object({ enum: z.array(z.string()) }) }),
  required: z.array(z.string()), additionalProperties: z.literal(false),
  oneOf: z.unknown().optional(), anyOf: z.unknown().optional(),
}).parse(JSON.parse(JSON.stringify(z.toJSONSchema(botCollaborationToolSchema, { target: "draft-7", io: "input" }))));
assert.deepEqual(wireSchema.properties.action.enum, ["ask", "follow_up", "delegate", "query", "amend", "pause", "resume", "cancel"]);
assert(wireSchema.required.includes("action"));
assert.equal(wireSchema.oneOf, undefined, "provider tool root must not be a oneOf union");
assert.equal(wireSchema.anyOf, undefined, "provider tool root must not be an anyOf union");
console.log("PASS collaboration provider wire schema is an object with the complete action enum");

const root = mkdtempSync(join(tmpdir(), "bot-collaboration-integration-"));
let app = new AppDatabase(join(root, "app.db"));
let db = app.connection;
let bots = new BotRegistry(db);
let works = new WorkService(db, { bots });
let messages = new BotConversationRepository(db);
let authority = true;
let failSchedule = false;
const scheduled: string[] = [], workspaceOwners: string[] = [], peerContexts: string[] = [];
const replyByOperation = new Map<string, Awaited<ReturnType<BotPeerCallService["call"]>>>();
const originalPeerCall = BotPeerCallService.prototype.call;
// Only the external recipient turn is replaced. Authentication, transactions,
// Work policy, query projections and durable delivery use production code.
BotPeerCallService.prototype.call = async function (parentId, operationId, targetBotId, question, context) {
  const previous = replyByOperation.get(operationId);
  if (previous) return previous;
  assert(context?.collaborationId);
  peerContexts.push(context.context);
  context.onReceipt("delivered");
  context.onReceipt("accepted");
  for (let i = 0; i < 12; i++) context.onPreview(`stream ${i}`);
  const result: Awaited<ReturnType<BotPeerCallService["call"]>> = {
    callId: `fixture-${operationId}`, sourceBotId: messages.message(parentId)!.botId,
    sourceDisplayName: "Source", targetBotId, targetDisplayName: targetBotId,
    requestText: question, replyText: `Actual ${targetBotId} reply to ${question}`,
    status: "completed", createdAt: Date.now(), updatedAt: Date.now(),
  };
  replyByOperation.set(operationId, result);
  return result;
};
function makeService() {
  const options = { db, bots, works, userId: "u", directory: root,
    // The peer boundary above prevents provider access; this intentionally has no credentials.
    models: {}, defaultModel: () => undefined, isAuthority: () => authority,
    memorySearch: () => [], botWorkspace: (botId: string) => { workspaceOwners.push(botId); return join(root, botId); },
    schedule: (work: { workId: string }) => { if (failSchedule) throw new Error("schedule transaction failure"); scheduled.push(work.workId); },
    wake: () => {},
  } as unknown as BotConversationServiceOptions;
  return new BotCollaborationService(options, messages, new BotPeerCallService(options, messages, () => {}), () => {});
}
let service = makeService();
const pageSchema = z.object({ collaboration: botCollaborationSchema, versionGuard: botWorkVersionGuardSchema.optional() });
const page = (value: unknown) => pageSchema.parse(value);
const count = (sql: string, ...args: string[]) => z.object({ n: z.number() }).parse(db.prepare(sql).get(...args)).n;
let sequence = 0;
const request = (botId = "source", extra: Partial<Parameters<BotConversationRepository["accept"]>[1]> = {}) => messages.accept("u",
  { botId, requestId: `request-${++sequence}`, text: `Original user request ${sequence}`, ...extra });
const plan = { title: "Target research", goalDescription: "Research the requested topic", mode: "once", requestedOutcome: "one_time" };
const feedback = (workId: string, eventId: string): WorkFeedbackDto => ({ workId, eventId, kind: "result", category: "result",
  report: { title: "Verified partial", summary: "Partial output", artifactRefs: [], milestone: true,
    reviewStatus: "accepted", current: true, notices: [] } });

try {
  for (const botId of ["source", "target", "other", "unrelated"]) bots.registerBot({ botId, userId: "u", displayName: botId, authorization: DESKTOP_USER_GRANTS });
  bots.registerBot({ botId: "foreign", userId: "foreign-user", displayName: "foreign", authorization: DESKTOP_USER_GRANTS });
  bots.registerBot({ botId: "paused", userId: "u", displayName: "paused", status: "paused", authorization: DESKTOP_USER_GRANTS });
  const first = request("source", { text: "USER ORIGINAL: exact request, not the Bot's rewritten plan",
    attachments: [{ name: "source-input.txt", path: join(root, "source-input.txt") }] });
  for (const targetBotId of ["source", "foreign", "paused"]) await assert.rejects(service.command(first.assistantMessageId,
    `bad-${targetBotId}`, { action: "ask", targetBotId, text: "question" }), /目标|自己|当前用户/);
  const team = request("source", { teamId: "team-fixture" });
  await assert.rejects(service.command(team.assistantMessageId, "team", { action: "ask", targetBotId: "target", text: "question" }), /个人请求/);
  authority = false;
  await assert.rejects(service.command(first.assistantMessageId, "authority", { action: "ask", targetBotId: "target", text: "question" }), /宿主/);
  authority = true;
  await assert.rejects(service.command(first.assistantMessageId, "mixed-action", {
    action: "ask", targetBotId: "target", text: "question", plan,
  }), z.ZodError, "runtime parser still rejects fields belonging to another action");
  await assert.rejects(service.command(first.assistantMessageId, "missing-plan", {
    action: "delegate", targetBotId: "target",
  }), z.ZodError, "runtime parser still requires action-specific fields");
  const consult = page(await service.command(first.assistantMessageId, "ask", { action: "ask", targetBotId: "target", text: "Remember this exact consultation" }));
  const relationId = consult.collaboration.collaborationId;
  assert.equal(works.listWorks("u", { includeClosed: true }).length, 0, "consultation creates no Work");
  assert.equal(consult.collaboration.messageCount, 2, "streaming previews do not become logical messages");
  assert.equal(consult.collaboration.times.startedAt, null, "missing actual start receipt stays unrecorded");
  assert.equal(service.history({ botId: "target", collaborationId: relationId }).messages.length, 2);
  assert.equal(messages.history("u", { botId: "target" }).messages.length, 0, "no synthetic target user request");
  await service.command(first.assistantMessageId, "ask", { action: "ask", targetBotId: "target", text: "Remember this exact consultation" });
  assert.equal(service.repo.get("u", relationId)?.messageCount, 2);
  assert.equal(replyByOperation.size, 1);
  await assert.rejects(service.command(first.assistantMessageId, "ask", { action: "ask", collaborationId: relationId, text: "Changed replay text" }), /conflict|冲突|不同|更改|不能/);
  await assert.rejects(service.command(first.assistantMessageId, "wrong-target", { action: "ask", collaborationId: relationId, targetBotId: "other", text: "question" }), /更换目标/);
  const delegated = page(await service.command(first.assistantMessageId, "delegate", { action: "delegate", collaborationId: relationId, plan }));
  const workId = delegated.collaboration.workId;
  assert(workId); assert(delegated.versionGuard);
  let work = works.getWork(workId)!;
  assert.equal(work.ownerBotId, "target"); assert.equal(works.teams.get(workId), undefined);
  assert.equal(work.sourceMessageId, first.userMessageId);
  assert.deepEqual(workspaceOwners, ["target"]);
  assert.equal(new BotWorkQuery(db, "u", "source").page({}).total, 0, "source personal count does not gain delegated Work");
  assert.equal(new BotWorkQuery(db, "u", "target").page({}).total, 1);
  assert.equal(count("SELECT COUNT(*) n FROM work_participants WHERE work_id=? AND bot_id='source'", workId), 0);
  const preserved = z.object({ messages_json: z.string() }).parse(db.prepare("SELECT messages_json FROM bot_work_user_inputs WHERE work_id=?").get(workId));
  assert(preserved.messages_json.includes("USER ORIGINAL: exact request"));
  const attachment = z.object({ attachments_json: z.string() }).parse(db.prepare("SELECT attachments_json FROM bot_work_attachments WHERE work_id=?").get(workId));
  assert(attachment.attachments_json.includes("source-input.txt"));
  const exchangeInput = z.object({ context_json: z.string() }).parse(db.prepare("SELECT context_json FROM bot_collaboration_work_context WHERE work_id=?").get(workId));
  assert(exchangeInput.context_json.includes("Remember this exact consultation"));
  assert.equal(delegated.collaboration.times.startedAt, null);
  assert.equal(delegated.collaboration.times.endedAt, null);
  assert.equal(delegated.collaboration.times.returnedAt, null, "old consultation returned time is not Work return time");
  await Promise.all(["delegate", "delegate-again"].map(operation => service.command(first.assistantMessageId, operation,
    { action: "delegate", collaborationId: relationId, plan })));
  await assert.rejects(service.command(first.assistantMessageId, "delegate", { action: "delegate", collaborationId: relationId,
    plan: { ...plan, title: "Changed duplicate acceptance" } }), /idempotency_conflict/);
  assert.equal(works.listWorks("u", { includeClosed: true }).length, 1);
  assert.deepEqual(scheduled, [workId]);
  console.log("PASS collaboration consultation, target ownership/count, immutable input/attachments and duplicate acceptance");

  const second = page(await service.command(first.assistantMessageId, "other-target", { action: "delegate", targetBotId: "other", plan: { ...plan, title: "Independent other target" } }));
  assert.notEqual(second.collaboration.collaborationId, relationId);
  assert.equal(new BotWorkQuery(db, "u", "other").page({}).total, 1);
  assert.equal(new BotWorkQuery(db, "u", "source").page({}).total, 0);
  assert.equal(service.list({ botId: "source", otherBotId: "target" }).total, 1);
  const attacker = request("unrelated");
  await assert.rejects(service.command(attacker.assistantMessageId, "attack", { action: "query", collaborationId: relationId }), /当前用户与 Bot|来源会话/);
  assert.throws(() => service.history({ botId: "foreign", collaborationId: relationId }), /当前用户|Bot/);
  await assert.rejects(service.command(first.assistantMessageId, "inject-owner", { action: "delegate", targetBotId: "target", plan: { ...plan, ownerBotId: "source" } }), z.ZodError);

  const later = request("source", { conversationId: first.conversationId, text: "Revise same delegated Work without losing original attachment" });
  const receipt = messages.receipt("u", "source", later.requestId)!;
  service.bindSend({ botId: "source", requestId: later.requestId, text: "Continue", selectedCollaborationId: relationId }, receipt);
  const selectedRequest = { botId: "source", requestId: "selected-replay", text: "Selected source request", conversationId: first.conversationId, selectedCollaborationId: relationId };
  messages.accept("u", selectedRequest);
  assert.throws(() => messages.accept("u", { ...selectedRequest, selectedCollaborationId: second.collaboration.collaborationId }), /conflict|冲突|不同|不能/);
  await assert.rejects(service.command(later.assistantMessageId, "unread-pause", { action: "pause", collaborationId: relationId, versionGuard: delegated.versionGuard }), /先查询/);
  let queried = page(await service.command(later.assistantMessageId, "query", { action: "query", collaborationId: relationId }));
  const oldGuard = queried.versionGuard!;
  const pauseCommand = { action: "pause", collaborationId: relationId, versionGuard: oldGuard };
  await service.command(later.assistantMessageId, "pause", pauseCommand);
  assert.equal(works.getWork(workId)?.lifecycle, "paused");
  await service.command(later.assistantMessageId, "pause", pauseCommand);
  assert.equal(works.getWork(workId)?.lifecycle, "paused", "same control operation replays after automatic guard refresh");
  await assert.rejects(service.command(later.assistantMessageId, "pause", { ...pauseCommand, reason: "Changed replay reason" }), /idempotency_conflict/);
  await assert.rejects(service.command(later.assistantMessageId, "stale-resume", { action: "resume", collaborationId: relationId, versionGuard: oldGuard }), /先查询|版本|stale/);
  queried = page(await service.command(later.assistantMessageId, "query-resume", { action: "query", collaborationId: relationId }));
  await service.command(later.assistantMessageId, "resume", { action: "resume", collaborationId: relationId, versionGuard: queried.versionGuard });
  queried = page(await service.command(later.assistantMessageId, "query-amend", { action: "query", collaborationId: relationId }));
  const amended = page(await service.command(later.assistantMessageId, "amend", { action: "amend", collaborationId: relationId,
    versionGuard: queried.versionGuard, changes: { goalDescription: "Revised precise goal" } }));
  assert.equal(works.getWork(workId)?.intentRevision, work.intentRevision + 1);
  assert.equal(amended.collaboration.workId, workId);
  const inherited = z.object({ attachments_json: z.string() }).parse(db.prepare("SELECT attachments_json FROM bot_work_attachments WHERE work_id=? AND input_snapshot_id=?").get(workId, works.getWork(workId)!.inputSnapshotId));
  assert(inherited.attachments_json.includes("source-input.txt"));
  await service.command(later.assistantMessageId, "follow", { action: "follow_up", collaborationId: relationId, text: "Explain your earlier answer" });
  assert(peerContexts.at(-1)?.includes("Remember this exact consultation"));
  assert.equal(works.listWorks("u", { includeClosed: true }).length, 2);
  console.log("PASS collaboration scope, two-target separation, guarded controls/replay, revisions and bounded peer context");

  messages.archive("u", "source", first.conversationId);
  const newChat = request();
  assert.notEqual(newChat.conversationId, first.conversationId);
  const continued = page(await service.command(newChat.assistantMessageId, "cross-entry-query", { action: "query", collaborationId: relationId }));
  assert.equal(continued.collaboration.workId, workId, "same user and initiating Bot may continue through a new private conversation");
  assert.equal(continued.collaboration.sourceConversationId, first.conversationId, "cross-entry control never rewrites original delivery provenance");
  const delivery = messages.appendWorkDelivery("u", workId, "partial-one", "v1", "Original exact partial report", feedback(workId, "partial-one"));
  assert.equal(delivery.conversationId, first.conversationId, "archived source remains exact destination");
  assert.equal(delivery.delivered, true);
  assert.equal(works.getWork(workId)?.lifecycle, "active", "returned milestone is not Work completion");
  const beforeDeleteCount = service.repo.get("u", relationId)!.messageCount;
  messages.appendWorkDelivery("u", workId, "partial-one", "v1", "Original exact partial report", feedback(workId, "partial-one"));
  assert.equal(service.repo.get("u", relationId)!.messageCount, beforeDeleteCount);
  // Match production BotDeletionService's dependency order, narrowed to this
  // source conversation so another live chat remains available to catch fallback.
  db.transaction(() => {
    for (const table of ["bot_cancel_intents", "bot_work_reads", "work_conversations", "work_message_refs", "bot_send_receipts", "bot_messages"])
      db.prepare(`DELETE FROM ${table} WHERE conversation_id=?`).run(first.conversationId);
    db.prepare("DELETE FROM bot_conversations WHERE conversation_id=?").run(first.conversationId);
  })();
  const conversationCount = count("SELECT COUNT(*) n FROM bot_conversations");
  const missing = messages.appendWorkDelivery("u", workId, "partial-two", "v2", "Result after source deletion", feedback(workId, "partial-two"));
  assert.equal(missing.delivered, false);
  assert.equal(count("SELECT COUNT(*) n FROM bot_conversations"), conversationCount, "deleted origin never creates fallback conversation");
  assert.equal(service.repo.get("u", relationId)?.originAvailable, false);
  const targetHistory = service.history({ botId: "target", collaborationId: relationId });
  assert(targetHistory.messages.some(message => message.text === "Result after source deletion"));
  assert.equal(messages.history("u", { botId: "source", conversationId: newChat.conversationId }).messages.length, 2);
  messages.appendWorkDelivery("u", workId, "partial-two", "v2", "Result after source deletion", feedback(workId, "partial-two"));
  assert.equal(service.repo.get("u", relationId)?.messageCount, targetHistory.totalMessages);
  assert(count("SELECT COUNT(*) n FROM bot_work_user_inputs WHERE work_id=?", workId) > 0);
  console.log("PASS exact archived-source delivery, deletion tombstone, durable bilateral reports and delivery dedupe");

  const rollback = request("unrelated");
  failSchedule = true;
  const worksBeforeRollback = works.listWorks("u", { includeClosed: true }).length;
  await assert.rejects(service.command(rollback.assistantMessageId, "rollback", { action: "delegate", targetBotId: "target", plan }), /schedule transaction failure/);
  failSchedule = false;
  assert.equal(works.listWorks("u", { includeClosed: true }).length, worksBeforeRollback);
  const failedRelation = service.list({ botId: "unrelated" }).items.find(row => row.sourceRequestId === rollback.requestId)!;
  assert(failedRelation); assert.equal(failedRelation.workId, null);
  const recovered = page(await service.command(rollback.assistantMessageId, "rollback", { action: "delegate", targetBotId: "target", plan }));
  assert(recovered.collaboration.workId);
  const stableRelation = recovered.collaboration.collaborationId, stableWork = recovered.collaboration.workId;
  const acceptedTime = recovered.collaboration.times.acceptedAt;
  const scheduledBeforeRestart = scheduled.length;
  app.close();
  app = new AppDatabase(join(root, "app.db")); db = app.connection;
  bots = new BotRegistry(db); works = new WorkService(db, { bots }); messages = new BotConversationRepository(db); service = makeService();
  const afterRestart = page(await service.command(rollback.assistantMessageId, "rollback", { action: "delegate", targetBotId: "target", plan }));
  assert.equal(afterRestart.collaboration.workId, stableWork);
  assert.equal(afterRestart.collaboration.times.acceptedAt, acceptedTime);
  assert.equal(scheduled.length, scheduledBeforeRestart);
  assert.equal(service.history({ botId: "target", collaborationId: relationId }).totalMessages, targetHistory.totalMessages);
  console.log("PASS rollback, retry, database reopen, immutable acceptance time and no duplicate scheduling");

  const deliveryWork = works.getWork(stableWork)!;
  const bindingId = "collaboration-delivery-failure-binding";
  const reportText = "Original completed execution result survives delivery rollback";
  works.repo.insertBinding({ bindingId, workId: deliveryWork.workId, operationId: "delivery-failure-binding-op", botId: "target",
    taskId: "delivery-failure-task", durableStoreKey: "delivery-failure-store", conversationId: "delivery-native-conversation",
    intentRevision: deliveryWork.intentRevision, ownerEpoch: deliveryWork.ownerEpoch, inputSnapshotId: deliveryWork.inputSnapshotId,
    expertSnapshot: bots.activeSnapshot("target")!, delegatedScope: [], workspaceBinding: root,
    status: "completed", admittedAt: 100, settledAt: 200, settlementNote: reportText });
  const submission = works.submitDeliverable({ kind: "worker", botId: "target", bindingId }, {
    operationId: `result:${bindingId}`, deliverableId: `result:${bindingId}`, workId: stableWork, bindingId,
    summary: reportText, artifactRefs: [], uncoveredScope: [], uncoveredCriterionIds: [], isSpeculation: false, hasWriteConflicts: false });
  assert(submission.ok);
  const deliveredMessages = () => messages.history("u", { botId: "unrelated", conversationId: rollback.conversationId }).messages;
  const messagesBeforeFailure = deliveredMessages().map(message => message.messageId);
  const executionBeforeFailure = works.repo.getBinding(bindingId);
  const logicalCountBeforeFailure = service.repo.get("u", stableRelation)!.messageCount;
  const attemptsBeforeFailure = replyByOperation.size;
  const callbacksBeforeFailure = scheduled.length;
  const productionFeedback = new WorkConversationFeedback({ db, userId: "u", works, isAuthority: () => true });
  db.exec(`CREATE TEMP TRIGGER collaboration_result_delivery_failure BEFORE INSERT ON bot_work_feedback
    WHEN json_extract(NEW.metadata_json,'$.category')='result'
    BEGIN SELECT RAISE(ABORT,'injected collaboration result feedback write failure'); END`);
  assert.equal(productionFeedback.drain(stableWork), 0);
  assert.deepEqual(deliveredMessages().map(message => message.messageId), messagesBeforeFailure, "partial progress and source delivery writes roll back together");
  const failedDelivery = service.history({ botId: "target", collaborationId: stableRelation });
  assert(failedDelivery.events.some(event => event.kind === "failed" && event.detail?.includes("成果回传失败")
    && event.detail.includes("injected collaboration result feedback write failure")), "failure fact is persisted outside rolled-back delivery transaction");
  assert.equal(failedDelivery.collaboration.status, "failed");
  assert.equal(failedDelivery.collaboration.times.returnedAt, null, "failed result insertion is not a source return receipt");
  assert.equal(failedDelivery.totalMessages, logicalCountBeforeFailure, "rolled-back result does not inflate bilateral message count");
  assert.equal(works.repo.getDeliverable(`result:${bindingId}`)?.summary, reportText);
  assert.deepEqual(works.repo.getBinding(bindingId), executionBeforeFailure, "delivery failure never changes execution outcome");
  db.exec("DROP TRIGGER collaboration_result_delivery_failure");
  assert.equal(productionFeedback.drain(stableWork), 2, "retry delivers one progress receipt and one logical result");
  assert.equal(productionFeedback.drain(stableWork), 0);
  const retriedHistory = service.history({ botId: "target", collaborationId: stableRelation });
  assert.equal(retriedHistory.messages.filter(message => message.kind === "result" && message.text.includes(reportText)).length, 1);
  assert.equal(deliveredMessages().filter(message => message.workFeedback?.category === "result" && message.text.includes(reportText)).length, 1);
  assert(retriedHistory.collaboration.times.returnedAt !== null);
  assert.equal(works.repo.listBindings(stableWork).length, 1, "feedback retry does not create another execution");
  assert.deepEqual(works.repo.getBinding(bindingId), executionBeforeFailure);
  assert.equal(replyByOperation.size, attemptsBeforeFailure);
  assert.equal(scheduled.length, callbacksBeforeFailure);
  productionFeedback.close();
  console.log("PASS real feedback insert failure persists after rollback; retry sends one result without execution rerun");
  bots.registerBot({ botId: "recovery-source", userId: "u", displayName: "Recovery source", authorization: DESKTOP_USER_GRANTS });
  const interruptedSource = request("recovery-source");
  const interrupted = service.repo.ensure({ userId: "u", sourceBotId: "recovery-source", sourceDisplayName: "Recovery source",
    sourceConversationId: interruptedSource.conversationId, sourceRequestId: interruptedSource.requestId,
    sourceUserMessageId: interruptedSource.userMessageId, sourceAssistantMessageId: interruptedSource.assistantMessageId,
    targetBotId: "target", targetDisplayName: "target", operationId: "interrupted-consultation" });
  service.repo.event("u", interrupted.collaborationId, { operationId: "admitted-before-interruption", kind: "accepted" });
  service.repo.setPreview("u", interrupted.collaborationId,
    { exchangeId: "interrupted-exchange", senderBotId: "target", senderDisplayName: "target", text: "incomplete preview" });
  bots.ensureDefaultBot("u");
  messages.update(interruptedSource.assistantMessageId, "unknown", "");
  const deletedSource = new BotDeletionService(db, bots, works, { userId: "u", isAuthority: () => true }).delete({
    botId: "recovery-source", expectedUpdatedAt: bots.getBot("recovery-source")!.updatedAt });
  assert(deletedSource.ok, JSON.stringify(deletedSource));
  assert.doesNotThrow(() => service.recover(), "deleted source must not prevent host recovery of independent durable relations");
  const interruptedHistory = service.history({ botId: "target", collaborationId: interrupted.collaborationId });
  assert.equal(interruptedHistory.collaboration.status, "unknown");
  assert.equal(interruptedHistory.collaboration.times.returnedAt, null);
  assert.equal(interruptedHistory.previews.length, 0);
  console.log("PASS deleted-source consultation recovery preserves history without phantom streaming or returned receipts");
  const repeatSource = request("unrelated");
  const repeatRelation = service.repo.ensure({ userId: "u", sourceBotId: "unrelated", sourceDisplayName: "unrelated",
    sourceConversationId: repeatSource.conversationId, sourceRequestId: repeatSource.requestId,
    sourceUserMessageId: repeatSource.userMessageId, sourceAssistantMessageId: repeatSource.assistantMessageId,
    targetBotId: "other", targetDisplayName: "other", operationId: "repeated-interruption" });
  const repeatHistory = () => service.history({ botId: "other", collaborationId: repeatRelation.collaborationId, limit: 100 });
  for (const exchangeId of ["interrupted-exchange-one", "interrupted-exchange-two"]) {
    service.repo.appendMessage("u", repeatRelation.collaborationId, { operationId: exchangeId, exchangeId,
      senderBotId: "unrelated", senderDisplayName: "unrelated", kind: "request", text: `Question ${exchangeId}` });
    service.repo.event("u", repeatRelation.collaborationId, { operationId: exchangeId, exchangeId, kind: "started" });
    service.recover();
    assert.equal(repeatHistory().collaboration.status, "unknown", "every distinct interrupted exchange loses its stale running label");
    const receipts = repeatHistory().events;
    service.recover();
    assert.deepEqual(repeatHistory().events, receipts, "repeated recovery of the same interruption is idempotent");
  }
  const recoveries = repeatHistory().events.filter(event => event.kind === "unknown");
  assert.equal(recoveries.length, 2, "a second interrupted exchange requires a distinct durable recovery receipt");
  assert.notEqual(recoveries[0].eventId, recoveries[1].eventId);
  console.log("PASS repeated exchange interruptions get distinct unknown receipts; same interruption recovery is idempotent");
  const watchedPath = join(root, "collaboration-watched.txt");
  const contentHash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
  await writeFile(watchedPath, "baseline-one");
  const receiver = new WorkFileEventSource(works, () => true, () => {});
  try {
    const watchSource = request("unrelated");
    const watchPlan = { title: "Target watches real file", requestedOutcome: "ongoing", mode: "watch", startImmediately: false,
      watchRule: { eventSource: "file", eventTarget: watchedPath, triggerMode: "next_event", executionMode: "continuous",
        catchUpPolicy: "latest", scheduleBasis: "user_specified", notificationMode: "changes_only" } };
    const watchResult = page(await service.command(watchSource.assistantMessageId, "watch-delegate", { action: "delegate", targetBotId: "target", plan: watchPlan }));
    const watchedWorkId = watchResult.collaboration.workId!;
    const watchedRelationId = watchResult.collaboration.collaborationId;
    const watchedWork = works.getWork(watchedWorkId)!;
    assert.equal(watchedWork.inputSnapshotId, contentHash("baseline-one"));
    assert.deepEqual(watchedWork.goalSources.map(source => [source.sourceType, source.sourceRef, source.inputSnapshotId]),
      [["file", watchedPath, contentHash("baseline-one")]]);
    const watchInbox = () => works.repo.listInbox(watchedWorkId, ["pending", "merged", "blocked", "processed", "skipped"]);
    await receiver.reconcile();
    assert.equal(watchInbox().length, 0, "next_event captures current file without inventing an initial event");
    assert.equal(works.repo.listBindings(watchedWorkId).length, 0);
    assert(!scheduled.includes(watchedWorkId));
    assert.equal(works.repo.listBlockers(watchedWorkId).length, 0, "real receiver accepts the stored baseline");
    let watchRead = page(await service.command(watchSource.assistantMessageId, "watch-query-pause", { action: "query", collaborationId: watchedRelationId }));
    await service.command(watchSource.assistantMessageId, "watch-pause", { action: "pause", collaborationId: watchedRelationId, versionGuard: watchRead.versionGuard });
    await receiver.reconcile();
    await writeFile(watchedPath, "baseline-two");
    watchRead = page(await service.command(watchSource.assistantMessageId, "watch-query-amend", { action: "query", collaborationId: watchedRelationId }));
    const amendWatchCommand = { action: "amend", collaborationId: watchedRelationId, versionGuard: watchRead.versionGuard,
      changes: { watchRule: { eventSource: "file", eventTarget: watchedPath, triggerMode: "next_event" } } };
    await service.command(watchSource.assistantMessageId, "watch-amend", amendWatchCommand);
    await service.command(watchSource.assistantMessageId, "watch-amend", amendWatchCommand);
    assert.equal(works.getWork(watchedWorkId)?.inputSnapshotId, contentHash("baseline-two"));
    const subscription = works.repo.listSubscriptions(watchedWorkId).find(item => !item.stoppedAt)!;
    assert.equal(works.ingress.cursor(subscription.subscriptionId, "file", watchedPath)?.enumerationWatermark, contentHash("baseline-two"));
    watchRead = page(await service.command(watchSource.assistantMessageId, "watch-query-resume", { action: "query", collaborationId: watchedRelationId }));
    await service.command(watchSource.assistantMessageId, "watch-resume", { action: "resume", collaborationId: watchedRelationId, versionGuard: watchRead.versionGuard });
    await receiver.reconcile();
    await delay(150);
    assert.equal(watchInbox().length, 0, "amended next_event baseline is not treated as offline change on resume");
    await writeFile(watchedPath, "actual-first-change");
    const eventDeadline = Date.now() + 5000;
    while (!watchInbox().length && Date.now() < eventDeadline) await delay(50);
    const firstFileEvent = watchInbox().find(event => event.eventType === "file.changed");
    assert(firstFileEvent, "actual fs.watch change must reach real Work ingress");
    assert.equal(firstFileEvent.payload.observation, "fs-watch");
    assert.equal(firstFileEvent.sourceVersion, contentHash("actual-first-change"));
    assert.equal(service.repo.get("u", watchedRelationId)?.workId, watchedWorkId);
    console.log("PASS real collaboration file watch: target baseline, guarded amendment/replay, next_event and actual OS change");
  } finally { await receiver.close(); }
  const beforeCloseHistory = messages.history("u", { botId: "unrelated", conversationId: rollback.conversationId });
  const beforeCloseMessage = messages.message(rollback.assistantMessageId)!;
  const closeTarget = works.getWork(stableWork)!;
  assert.equal(beforeCloseMessage.collaborations?.find(row => row.collaborationId === stableRelation)?.work?.lifecycle, "active");
  const closure = works.closeWork({ kind: "user", userId: "u", grants: DESKTOP_USER_GRANTS }, {
    operationId: "review-stream-closure", workId: stableWork, conclusion: "ended_unsuccessfully", closureSummary: "Fixture lifecycle transition",
    versionGuard: { expectedStateVersion: closeTarget.stateVersion, expectedIntentRevision: closeTarget.intentRevision, expectedOwnerEpoch: closeTarget.ownerEpoch } });
  assert(closure.ok, JSON.stringify(closure));
  const afterCloseMessage = messages.message(rollback.assistantMessageId)!;
  assert.equal(afterCloseMessage.collaborations?.find(row => row.collaborationId === stableRelation)?.work?.lifecycle, "closed");
  const afterCloseConversation = messages.conversation("u", "unrelated", rollback.conversationId)!;
  const mergedClosure = mergeBotMessageEvent(beforeCloseHistory, { botId: "unrelated", conversationId: rollback.conversationId,
    revision: afterCloseConversation.revision, message: afterCloseMessage });
  assert.equal(mergedClosure?.messages.find(message => message.messageId === rollback.assistantMessageId)?.collaborations
    ?.find(row => row.collaborationId === stableRelation)?.work?.lifecycle, "closed", "a real Work closure must pass source message stream revision fencing");
  console.log("PASS Work closure refreshes the source collaboration summary through the real stream reducer");
} finally {
  BotPeerCallService.prototype.call = originalPeerCall;
  app.close();
  const cleanup = resolve(root);
  assert(relative(resolve(tmpdir()), cleanup) && !relative(resolve(tmpdir()), cleanup).startsWith(".."));
  rmSync(cleanup, { recursive: true, force: true });
}
