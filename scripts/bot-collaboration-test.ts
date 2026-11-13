import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
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
import { BotCollaborationService } from "../src/main/agent/work/BotCollaborationService";
import { botForegroundTools, botWorkCreateSchema, botWorkVersionGuardSchema } from "../src/main/agent/work/BotForegroundTools";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { WorkConversationFeedback } from "../src/main/agent/work/WorkConversationFeedback";
import { WorkFileEventSource, readWorkFileSource } from "../src/main/agent/work/WorkFileEventSource";
import type { BotConversationServiceOptions } from "../src/main/agent/work/BotConversationService";
import { botCollaborationSchema } from "../src/shared/bot-collaboration";
import { mergeBotMessageEvent } from "../src/renderer/src/store/app/slices/botMessageStream";

// Existing direct-Work records keep their real provenance and control/recovery
// guarantees. New routing is exercised through the real native foreground in
// test:bot-peer-ingress; these historical fixtures never claim B received a turn.
const root = mkdtempSync(join(tmpdir(), "bot-collaboration-integration-"));
const app = new AppDatabase(join(root, "app.db")), db = app.connection;
const bots = new BotRegistry(db), works = new WorkService(db, { bots });
const messages = new BotConversationRepository(db), scheduled: string[] = [];
const replyByOperation = new Map<string, unknown>();
const options = { db, bots, works, userId: "u", directory: root, models: {}, defaultModel: () => undefined,
  isAuthority: () => true, memorySearch: () => [], schedule: (work: { workId: string }) => scheduled.push(work.workId), wake: () => {} } as unknown as BotConversationServiceOptions;
const service = new BotCollaborationService(options, messages, () => {});
const page = (value: unknown) => z.object({ collaboration: botCollaborationSchema, versionGuard: botWorkVersionGuardSchema.optional() }).parse(value);
const count = (sql: string, ...args: string[]) => z.object({ n: z.number() }).parse(db.prepare(sql).get(...args)).n;
let sequence = 0;
const request = (botId = "unrelated") => messages.accept("u", { botId, requestId: `legacy-${++sequence}`, text: `Original request ${sequence}` });
async function legacyWork(parentMessageId: string, operationId: string, value: unknown) {
  const source = messages.message(parentMessageId)!;
  const receipt = messages.receipt("u", source.botId, source.requestId)!;
  const { requestedOutcome, startImmediately: _start, ...plan } = botWorkCreateSchema.parse(value);
  const baseline = plan.watchRule?.eventSource === "file" ? await readWorkFileSource(plan.watchRule.eventTarget!) : undefined;
  return works.transaction(() => {
    const relation = service.repo.ensure({ userId: "u", sourceBotId: source.botId, sourceDisplayName: source.botId,
      sourceConversationId: source.conversationId, sourceRequestId: source.requestId, sourceUserMessageId: receipt.user_message_id,
      sourceAssistantMessageId: parentMessageId, targetBotId: "target", targetDisplayName: "target", operationId });
    const result = works.createWork({ kind: "bot", userId: "u", botId: "target", host: "foreground", grants: DESKTOP_USER_GRANTS }, {
      ...plan, operationId, ownerBotId: "target", conversationId: source.conversationId, sourceMessageId: receipt.user_message_id,
      inputSnapshotId: baseline?.inputSnapshotId ?? `input:${receipt.user_message_id}`,
      ...(baseline ? { goalSources: [baseline] } : {}), watchRule: plan.watchRule ? { ...plan.watchRule, requestedOutcome,
        subscriptions: [plan.watchRule.eventSource ?? "cron"], timezone: "Asia/Shanghai" } : undefined });
    assert(result.ok, JSON.stringify(result));
    service.repo.linkWork("u", relation.collaborationId, result.work.workId);
    messages.linkWorkUserInput(receipt, result.work); messages.linkWork(receipt, result.work.workId);
    return page(service.history({ botId: source.botId, collaborationId: relation.collaborationId }));
  });
}
try {
  for (const botId of ["source", "target", "other", "unrelated"]) bots.registerBot({ botId, userId: "u", displayName: botId, authorization: DESKTOP_USER_GRANTS });
  const rollback = request();
  const accepted = await legacyWork(rollback.assistantMessageId, "historical-direct-acceptance", { title: "Historical direct Work", mode: "once", requestedOutcome: "one_time" });
  const stableWork = accepted.collaboration.workId!, stableRelation = accepted.collaboration.collaborationId;
  assert.equal(messages.history("u", { botId: "target" }).messages.length, 0, "historical direct Work is never relabelled as B foreground reception");
  const foreign = request("other");
  await assert.rejects(service.command(foreign.assistantMessageId, "cross-bot", { action: "query", collaborationId: stableRelation }), /属于|发起/);
  await assert.rejects(service.command(rollback.assistantMessageId, "missing-guard", { action: "pause", collaborationId: stableRelation }), /versionGuard/);
  const queried = page(await service.command(rollback.assistantMessageId, "query", { action: "query", collaborationId: stableRelation }));
  assert(queried.versionGuard);
  assert.equal(works.getWork(stableWork)?.ownerBotId, "target");
  assert.equal(works.teams.get(stableWork), undefined);
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
    const watchResult = await legacyWork(watchSource.assistantMessageId, "watch-delegate", watchPlan);
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
  // Real SQLite identities/outbox; no model, network, or real-user data.
  let acceptedCount = 0;
  const redoHost = { accept: async (delivery: import("../src/main/agent/work/BotPeerIngress").BotPeerDelivery, guard?: () => void) => {
    guard?.(); acceptedCount++;
    const accepted = messages.accept("u", {botId:"target", requestId:delivery.request_id, text:delivery.text});
    works.transaction(() => { messages.peers.record(accepted, JSON.parse(delivery.origin_json));
      db.prepare("UPDATE bot_peer_deliveries SET accepted_message_id=? WHERE operation_id=?").run(accepted.assistantMessageId,delivery.operation_id); });
    return accepted;
  }, cancel: async () => {} };
  const redoService = new BotCollaborationService(options,messages,()=>{},redoHost);
  const fresh = messages.accept("u",{botId:"unrelated", requestId:"redo-user-1",text:"重新做一份"});
  const read = page(await redoService.command(fresh.assistantMessageId,"read-redo",{action:"query",collaborationId:stableRelation}));
  const redo = {action:"redo",collaborationId:stableRelation,text:"重新做一份，保留原标准",requestExcerpt:"重新做一份",versionGuard:read.versionGuard};
  const successor = page(await redoService.command(fresh.assistantMessageId,"redo-tool-1",redo));
  assert.notEqual(successor.collaboration.collaborationId,stableRelation);
  assert.equal(successor.collaboration.workId,null);
  assert.equal(successor.collaboration.sourceUserMessageId,fresh.userMessageId);
  const replay = page(await redoService.command(fresh.assistantMessageId,"different-tool-id",redo));
  assert.equal(replay.collaboration.collaborationId,successor.collaboration.collaborationId);
  assert.equal(acceptedCount,1,"same user redo cannot duplicate delivery when model changes tool ID");
  await assert.rejects(redoService.command(fresh.assistantMessageId,"changed",{...redo,text:"changed payload"}),/idempotency_conflict/);
  assert.equal(redoService.repo.get("u",stableRelation)?.workId,stableWork);
  assert.equal(works.getWork(stableWork)?.lifecycle,"closed");
  await redoService.delivery!.cancel(stableRelation);
  const nextDelivery = messages.peers.deliveries("u",successor.collaboration.collaborationId)[0];
  assert.equal(nextDelivery.cancelled_at,null,"old cancel cannot cancel successor");
  const acceptedMessage = messages.message(nextDelivery.accepted_message_id!)!;
  const acceptedReceipt = messages.receipt("u","target",acceptedMessage.requestId)!;
  assert.equal(messages.userSource(acceptedReceipt).user_message_id,fresh.userMessageId,"new user authority survives ingress");
  const restored = new BotCollaborationService(options,messages,()=>{},redoHost);
  assert.equal(page(await restored.command(fresh.assistantMessageId,"after-restart",redo)).collaboration.collaborationId,successor.collaboration.collaborationId);
  assert.equal(acceptedCount,1);
  const originalWork = works.getWork(stableWork)!;
  const tools = botForegroundTools({...options,botId:"target",conversationId:acceptedReceipt.conversation_id,messages,workspacePath:root,memorySearch:()=>[]});
  const createTool = tools.find(tool=>tool.name==="work_create")!;
  const createArgs = {title:"Redo fixture",mode:"once",requestedOutcome:"one_time",sourceMessageIds:[fresh.userMessageId]};
  const invokeCreate = async(taskId:string) => {
    const output = await createTool.execute(createArgs as never,{callId:taskId,taskId,memo:async()=>acceptedReceipt.request_id} as unknown as ToolExecutionApi,BACKGROUND_CONTEXT);
    const block=output.output?.find(item=>item.type==="text"); assert(block?.type==="text");
    return JSON.parse(block.text) as {ok:boolean;work:import("../src/shared/bot-work").WorkDto};
  };
  const nextWork=await invokeCreate("redo-create-1"); assert(nextWork.ok,JSON.stringify(nextWork));
  assert.notEqual(nextWork.work.workId,stableWork);
  assert.equal((await invokeCreate("redo-create-changed-tool")).work.workId,nextWork.work.workId);
  assert.equal(redoService.repo.get("u",successor.collaboration.collaborationId)?.workId,nextWork.work.workId);
  assert.equal(nextWork.work.workspacePath,root);
  assert.deepEqual(nextWork.work.authorization,bots.getBot("target")!.authorization);
  assert.equal(nextWork.work.sourceMessageId,fresh.userMessageId);
  assert.equal(works.getWork(stableWork)?.stateVersion,originalWork.stateVersion);
  const activeRedoRequest=messages.accept("u",{botId:"unrelated",requestId:"redo-active",text:"重新做一份"});
  const activePage=page(await redoService.command(activeRedoRequest.assistantMessageId,"active-read",{action:"query",collaborationId:successor.collaboration.collaborationId}));
  await assert.rejects(redoService.command(activeRedoRequest.assistantMessageId,"active-redo",{...redo,collaborationId:successor.collaboration.collaborationId,versionGuard:activePage.versionGuard}),/已结案/);
  const forged=messages.accept("u",{botId:"unrelated",requestId:"redo-forged",text:"查询进度"});
  const forgedPage=page(await redoService.command(forged.assistantMessageId,"forged-read",{action:"query",collaborationId:stableRelation}));
  await assert.rejects(redoService.command(forged.assistantMessageId,"forged-redo",{...redo,versionGuard:forgedPage.versionGuard}),/逐字/);
  const badSource = messages.accept("u",{botId:"other",requestId:"cross-redo",text:"重新做一份"});
  await assert.rejects(restored.command(badSource.assistantMessageId,"cross-redo",redo),/属于|发起/);
  // A new private conversation must query/link the predecessor before redo.
  db.prepare("UPDATE bot_conversations SET archived_at=? WHERE user_id=? AND bot_id=? AND archived_at IS NULL").run(Date.now(),"u","unrelated");
  db.prepare("INSERT INTO bot_conversations(conversation_id,bot_id,user_id,created_at,updated_at) VALUES(?,?,?,?,?)").run("redo-new-private","unrelated","u",Date.now(),Date.now());
  const privateTurn=messages.accept("u",{botId:"unrelated",conversationId:"redo-new-private",requestId:"redo-private",text:"重新做一份"});
  const privateRead=page(await redoService.command(privateTurn.assistantMessageId,"private-read",{action:"query",collaborationId:stableRelation}));
  const privateRedo={...redo,versionGuard:privateRead.versionGuard};
  await assert.rejects(redoService.command(privateTurn.assistantMessageId,"no-guard",{...privateRedo,versionGuard:undefined}),/versionGuard/);
  await assert.rejects(redoService.command(privateTurn.assistantMessageId,"old-guard",{...privateRedo,versionGuard:{...privateRead.versionGuard,expectedStateVersion:1}}));
  // Simulate process failure after command+successor+outbox commit, before acceptance.
  let failOnce=true;
  const failingHost={...redoHost,accept:async(...args:Parameters<typeof redoHost.accept>)=>{if(failOnce){failOnce=false;throw Error("injected before accept");}return redoHost.accept(...args);}};
  const failingService=new BotCollaborationService(options,messages,()=>{},failingHost);
  await assert.rejects(failingService.command(privateTurn.assistantMessageId,"private-first",privateRedo),/injected/);
  const pending=db.prepare("SELECT successor_id FROM bot_collaboration_successors WHERE source_user_message_id=?").get(privateTurn.userMessageId) as {successor_id:string};
  assert(pending);
  assert.equal(messages.peers.deliveries("u",pending.successor_id).length,1);
  assert.equal(messages.peers.deliveries("u",pending.successor_id)[0].accepted_message_id,null);
  failingService.close();
  const restartedService=new BotCollaborationService(options,messages,()=>{},redoHost);
  const beforeConcurrent=acceptedCount;
  const concurrent=await Promise.all(["private-restart-a","private-restart-b"].map(id=>restartedService.command(privateTurn.assistantMessageId,id,privateRedo)));
  assert(concurrent.every(value=>page(value).collaboration.collaborationId===pending.successor_id));
  assert.equal(acceptedCount,beforeConcurrent+1);
  assert.equal(messages.peers.deliveries("u",pending.successor_id).length,1);
  await assert.rejects(redoService.command(acceptedReceipt.assistant_message_id,"peer-redo",redo));
  console.log("PASS redo real work_create identity/source/workspace/authorization; new private conversation; guards; peer rejection; failed-send restart/concurrency");
  console.log("PASS closed Work redo successor: request identity, retry, restart, provenance, old cancellation isolation");

} finally {
  app.close();
  const cleanup = resolve(root);
  assert(relative(resolve(tmpdir()), cleanup) && !relative(resolve(tmpdir()), cleanup).startsWith(".."));
  rmSync(cleanup, { recursive: true, force: true });
}
