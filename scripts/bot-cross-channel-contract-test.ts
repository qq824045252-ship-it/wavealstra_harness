import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { BotConversationRepository } from "../src/main/agent/work/BotConversationRepository";
import { BotCollaborationService } from "../src/main/agent/work/BotCollaborationService";
import { BotPeerCallService } from "../src/main/agent/work/BotPeerCallService";
import { BotWorkContextService } from "../src/main/agent/work/BotWorkContextService";
import { BotWorkQuery } from "../src/main/agent/work/BotWorkQuery";
import { BotWorkMethodFeedback } from "../src/main/agent/work/BotWorkMethodFeedback";
import { BotConversationMemory } from "../src/main/agent/work/BotConversationMemory";
import { ensureBotTurnOriginSchema } from "../src/main/agent/work/BotTurnOriginSchema";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { GatewayWorkTargets } from "../src/main/gateway/GatewayWorkTargets";
import type { GatewayBotOrigin } from "../src/main/agent/work/BotTurnOrigins";
import { MemoryService } from "../src/main/memory/MemoryService";
import { MemoryPipelineManager } from "../src/main/memory/MemoryPipelineManager";
import { MemorySkillEffectivenessService } from "../src/main/memory/MemorySkillEffectivenessService";
import { MemorySkillRevisionService } from "../src/main/memory/MemorySkillRevisionService";
import { SkillsService } from "../src/main/skills/SkillsService";
import { LOCAL_USER_ID } from "../src/shared/bot-work";
import { gatewayWorkTargetSchema } from "../src/main/gateway/work-outbound";
import { botCollaborationSchema } from "../src/shared/bot-collaboration";
import { botWorkVersionGuardSchema } from "../src/main/agent/work/BotForegroundTools";

const root = mkdtempSync(join(tmpdir(), "bot-cross-channel-contract-"));
process.env.HOME = root; process.env.USERPROFILE = root; process.env.PI_CODING_AGENT_DIR = join(root, ".mybuddy");
const app = new AppDatabase(join(root, "app.db")), db = app.connection;
const bots = new BotRegistry(db), works = new WorkService(db, { bots }), messages = new BotConversationRepository(db);
const memory = new MemoryService(app, { semantic: false }), skills = new SkillsService();
const effectiveness = new MemorySkillEffectivenessService(app), revisions = new MemorySkillRevisionService(app);
const feedback = new BotWorkMethodFeedback({ db: app, works, userId: LOCAL_USER_ID, memory, skills, effectiveness, revisions });
const options = { db, userId: LOCAL_USER_ID, bots, works, models: {} as ModelRuntime, directory: root,
  defaultModel: () => undefined, isAuthority: () => true, memorySearch: () => [], schedule: () => {}, wake: () => {},
  recordWorkFeedback: (source: Parameters<BotWorkMethodFeedback["record"]>[0], work: Parameters<BotWorkMethodFeedback["record"]>[1]) => feedback.record(source, work) };
const peer = new BotPeerCallService(options, messages, () => {}), collaboration = new BotCollaborationService(options, messages, () => {});
const bridge = new BotConversationMemory({ db: app, userId: LOCAL_USER_ID, memory, pipeline: new MemoryPipelineManager(app),
  enabled: () => true, changed: () => {}, extract: async () => {} });
const actor = { kind: "user", userId: LOCAL_USER_ID, entry: "desktop", grants: DESKTOP_USER_GRANTS } as const;
let ordinal = 0;
const origin = (audience: "private" | "shared" = "private", channelId = "qq-default"): GatewayBotOrigin => ({
  channelId, connectionKey: "a".repeat(64), chatId: audience === "private" ? "c2c:owner" : "group:room", senderId: "owner", messageId: `m-${++ordinal}`, audience });
const gateway = (input: GatewayBotOrigin, text: string, botId = "a") => db.transaction(() => {
  const conversationId = messages.origins.gatewayConversation(LOCAL_USER_ID, botId, input);
  const receipt = messages.accept(LOCAL_USER_ID, { botId, conversationId, requestId: `gateway-${input.messageId}`, text });
  messages.origins.recordGateway(LOCAL_USER_ID, receipt, input);
  return receipt;
})();
const page = (input: unknown) => z.object({ collaboration: botCollaborationSchema, versionGuard: botWorkVersionGuardSchema.optional(), methodFeedback: z.unknown().optional() }).parse(input);
const guard = (workId: string) => { const work = works.getWork(workId)!; return { expectedStateVersion: work.stateVersion,
  expectedOwnerEpoch: work.ownerEpoch, expectedIntentRevision: work.intentRevision }; };

try {
  for (const botId of ["a", "b", "other"]) bots.registerBot({ botId, userId: LOCAL_USER_ID, displayName: botId, authorization: DESKTOP_USER_GRANTS });
  bots.registerBot({ botId: "foreign", userId: "foreign", displayName: "foreign", authorization: DESKTOP_USER_GRANTS });
  const desktop = messages.accept(LOCAL_USER_ID, { botId: "a", requestId: "desktop", text: "desktop remains" });
  // Reproduce the previous unique index on an actual current-schema database.
  db.exec("DROP INDEX uq_bot_personal_live; CREATE UNIQUE INDEX uq_bot_personal_live ON bot_conversations(user_id,bot_id) WHERE archived_at IS NULL AND team_id IS NULL");
  ensureBotTurnOriginSchema(db);
  ensureBotTurnOriginSchema(db);
  const qq = origin();
  qq.workTarget = gatewayWorkTargetSchema.parse({ version: 1, channelType: "qq", channelId: qq.channelId,
    connectionKey: qq.connectionKey, chatId: qq.chatId, senderId: qq.senderId,
    address: { recipient: "owner", group: false, messageId: qq.messageId, expiresAt: Date.now() + 3600000 } });
  const source = gateway(qq, "生成一份季度销售报告");
  const ding = gateway(origin("private", "dingtalk-default"), "另一入口");
  assert.notEqual(source.conversationId, ding.conversationId);
  assert.notEqual(source.conversationId, desktop.conversationId);
  assert.equal(messages.history(LOCAL_USER_ID, { botId: "a" }).conversationId, desktop.conversationId);
  assert.throws(() => db.prepare("INSERT INTO bot_conversations(conversation_id,bot_id,user_id,created_at,updated_at) VALUES('duplicate-desktop','a',?,1,1)").run(LOCAL_USER_ID), /UNIQUE/);
  assert.equal(messages.message(desktop.userMessageId)?.text, "desktop remains");
  console.log("PASS current-schema migration preserves desktop uniqueness/history and simultaneous account-scoped Gateway conversations");

  const context = new BotWorkContextService(db, bots, works);
  context.bind(LOCAL_USER_ID, "gateway", "old-implicit-chat", "a");
  const binding = { botId: "a", connectionKey: qq.connectionKey, ownerSenderIds: ["owner"] };
  assert.throws(() => context.resolveGatewayBot(LOCAL_USER_ID, qq), /尚未绑定/);
  assert.throws(() => context.resolveGatewayBot(LOCAL_USER_ID, { ...qq, senderId: "stranger" }, binding), /配对/);
  assert.throws(() => context.resolveGatewayBot(LOCAL_USER_ID, { ...qq, connectionKey: "b".repeat(64) }, binding), /账号已变化/);
  assert.throws(() => context.resolveGatewayBot(LOCAL_USER_ID, qq, { ...binding, botId: "foreign" }), /不属于/);
  db.prepare("UPDATE bots SET status='paused' WHERE bot_id='a'").run();
  assert.throws(() => context.resolveGatewayBot(LOCAL_USER_ID, qq, binding), /失效/);
  assert.equal(context.resolveGatewayBot(LOCAL_USER_ID, qq, { ...binding, botId: "b" }).botId, "b", "explicit change wins over old implicit mappings even when A is disabled");
  const switched = gateway({ ...qq, messageId: "switch-to-b" }, "B private request", "b");
  assert.notEqual(switched.conversationId, source.conversationId);
  assert.equal(messages.history(LOCAL_USER_ID, { botId: "b", conversationId: switched.conversationId }).messages.length, 2);
  db.prepare("UPDATE bots SET status='active' WHERE bot_id='a'").run();
  console.log("PASS owner pairing, account binding, foreign/disabled Bot rejection and explicit A-to-B switch without history adoption");

  // Historical direct-Work fixture. New admissions are covered by the native
  // test:bot-peer-ingress route; this test protects existing cross-channel control.
  const historical = works.transaction(() => {
    const result = works.createWork({ kind: "bot", userId: LOCAL_USER_ID, botId: "b", host: "foreground", grants: DESKTOP_USER_GRANTS }, {
      operationId: "historical-cross-channel", ownerBotId: "b", title: "季度销售报告", mode: "once",
      sourceMessageId: source.userMessageId, conversationId: source.conversationId });
    assert(result.ok);
    const relation = collaboration.repo.ensure({ userId: LOCAL_USER_ID, sourceBotId: "a", sourceDisplayName: "a",
      sourceConversationId: source.conversationId, sourceRequestId: source.requestId, sourceUserMessageId: source.userMessageId,
      sourceAssistantMessageId: source.assistantMessageId, targetBotId: "b", targetDisplayName: "b", operationId: "historical-cross-channel" });
    collaboration.repo.linkWork(LOCAL_USER_ID, relation.collaborationId, result.work.workId);
    messages.linkWork(messages.receipt(LOCAL_USER_ID, "a", source.requestId)!, result.work.workId);
    return relation.collaborationId;
  });
  const delegated = page(await collaboration.command(source.assistantMessageId, "read-historical", { action: "query", collaborationId: historical }));
  const workId = delegated.collaboration.workId!;
  assert.equal(new BotWorkQuery(db, LOCAL_USER_ID, "a").page({}).total, 0);
  assert.equal(new BotWorkQuery(db, LOCAL_USER_ID, "b").page({}).total, 1);
  const update = messages.accept(LOCAL_USER_ID, { botId: "a", conversationId: desktop.conversationId, requestId: "desktop-amend", text: "季度销售报告改成中文版" });
  const selected = page(await collaboration.command(update.assistantMessageId, "query", { action: "query", collaborationId: delegated.collaboration.collaborationId }));
  assert(selected.versionGuard);
  await collaboration.command(update.assistantMessageId, "amend", { action: "amend", collaborationId: delegated.collaboration.collaborationId,
    changes: { title: "季度销售报告中文版" }, versionGuard: selected.versionGuard });
  assert.equal(works.listWorks(LOCAL_USER_ID, { includeClosed: true }).length, 1);
  assert.equal(works.getWork(workId)?.sourceMessageId, source.userMessageId, "Work source already remains immutable across amendments");
  const currentInput = z.object({ source_message_id: z.string() }).parse(db.prepare(
    "SELECT source_message_id FROM work_intent_snapshots WHERE snapshot_id=?").get(works.getWork(workId)!.activeIntentSnapshotId));
  assert.equal(currentInput.source_message_id, update.userMessageId, "the new user input belongs to the current intent revision");
  const route = new GatewayWorkTargets(db).forWork(workId, LOCAL_USER_ID);
  assert.equal(route.length, 1); assert.equal(route[0].sourceMessageId, source.userMessageId);
  assert.equal(route[0].conversationId, source.conversationId);
  assert.equal(collaboration.repo.get(LOCAL_USER_ID, delegated.collaboration.collaborationId)?.sourceConversationId, source.conversationId);
  console.log("PASS same-user initiating Bot controls original delegated Work from desktop while immutable QQ route and B ownership survive revision");

  memory.create({ kind: "preference", title: "私人偏好", content: "只在私人入口使用的偏好", scopeType: "bot", scopeId: "a", explicit: true });
  const group = gateway(origin("shared"), "本群记住先列依据再写结论");
  assert.equal((await bridge.search("a", "私人偏好", group.conversationId)).length, 0);
  assert(!bridge.context("a", group.conversationId).includes("私人偏好"));
  const local = bridge.remember("a", group.conversationId, { scope: "current", kind: "preference", title: "群内格式",
    content: "先列依据再写结论", userEvidence: "先列依据再写结论" }, "本群记住先列依据再写结论");
  assert.equal(local.scopeType, "conversation");
  assert.throws(() => memory.promoteFromTask(group.conversationId, local.memoryId, "bot", "a"), /作用域|提升|范围/);
  await assert.rejects(collaboration.command(group.assistantMessageId, "private-collaboration", { action: "query", collaborationId: delegated.collaboration.collaborationId }), /共享渠道/);
  assert.equal(new BotWorkQuery(db, LOCAL_USER_ID, "a", undefined, group.conversationId).page({ status: "all" }).total, 0);
  console.log("PASS shared audience cannot read private memory/Work/collaboration or promote conversation memory into Bot scope");

  const work = works.getWork(workId)!;
  app.upsertTask({ id: "b-execution", title: "B actual fixture execution", updatedAt: Date.now(), status: "completed" });
  const dispatched = works.dispatchExecution(actor, { operationId: "dispatch", workId, botId: "b", taskId: "b-execution",
    durableStoreKey: "b-store", conversationId: "b-native", workspaceBinding: root, versionGuard: guard(workId) });
  assert(dispatched.ok);
  const execution = works.repo.listBindings(workId).at(-1)!;
  works.repo.updateBinding({ ...execution, status: "completed", settledAt: Date.now(), settlementNote: "fixture tool completed" });
  const file = join(root, "report.json"), snapshot = join(root, "immutable-report.json");
  const bytes = '{"total":166,"language":"zh"}'; writeFileSync(file, bytes); writeFileSync(snapshot, bytes);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const scratch = join(root, "unused-scratch.json"), scratchBytes = '{"privateDraft":"not delivered"}';
  writeFileSync(scratch, scratchBytes);
  const scratchDigest = createHash("sha256").update(scratchBytes).digest("hex");
  works.transaction(() => works.generatedArtifacts.record(execution, [{ path: file, snapshotPath: snapshot, digest,
    sizeBytes: Buffer.byteLength(bytes), registeredAt: Date.now(), sourceEntryId: 1 }, { path: scratch, snapshotPath: scratch,
    digest: scratchDigest, sizeBytes: Buffer.byteLength(scratchBytes), registeredAt: Date.now(), sourceEntryId: 2 }]));
  const delivered = works.submitDeliverable({ kind: "worker", botId: "b", bindingId: execution.bindingId }, { operationId: "submit",
    workId, bindingId: execution.bindingId, deliverableId: "report", summary: "actual JSON generated", artifactRefs: [snapshot] });
  assert(delivered.ok);
  const accepted = works.acceptDeliverable(actor, { operationId: "accept", workId, deliverableId: "report", versionGuard: guard(workId) });
  assert(accepted.ok);
  const closed = works.closeWork(actor, { operationId: "close", workId, conclusion: "succeeded", versionGuard: guard(workId) });
  assert(closed.ok);
  writeFileSync(snapshot, "changed after result card");
  const changedFile = messages.accept(LOCAL_USER_ID, { botId: "a", conversationId: desktop.conversationId,
    requestId: "changed-file-correction", text: "纠正这个方法：下次先检查输入。" });
  const noEvidence = page(await collaboration.command(changedFile.assistantMessageId, "changed-file-method",
    { action: "query", collaborationId: delegated.collaboration.collaborationId }));
  assert.deepEqual(noEvidence.methodFeedback, { status: "no_artifact_evidence", recorded: false });
  assert.equal(memory.listExactScope("work", workId).filter(item => item.kind === "procedure").length, 0,
    "an unselected registered file cannot replace a changed delivered snapshot");
  writeFileSync(snapshot, bytes);
  for (const [index, text] of ["不要纠正这个方法，下次再说。", "如果以后需要纠正这个方法，再讨论。", "不要保存这条方法纠正：下次先检查输入。"].entries()) {
    const ignored = messages.accept(LOCAL_USER_ID, { botId: "a", conversationId: desktop.conversationId, requestId: `no-correction-${index}`, text });
    const unchanged = page(await collaboration.command(ignored.assistantMessageId, `no-method-${index}`,
      { action: "query", collaborationId: delegated.collaboration.collaborationId }));
    assert.equal(unchanged.methodFeedback, undefined, "negated, hypothetical and opt-out text cannot revise a method");
    assert.equal(memory.listExactScope("work", workId).filter(item => item.kind === "procedure").length, 0);
  }
  const historicGoal = '仅在 C:\\old-machine\\old-work 中覆盖 old-output.txt；只改旧 Work，不新建 Work';
  db.prepare("UPDATE works SET goal_description=?,title=? WHERE work_id=?").run(historicGoal, "C:\\old-machine\\old-work old-output.txt 仅续做 Work-old-123", workId);
  const correctionText = "纠正这个方法：下次先核对逐项合计，再生成最终报告。请查询当前协作并保存方法；不要新建Work，也不要改已交付final.txt。";
  const correction = messages.accept(LOCAL_USER_ID, { botId: "a", conversationId: desktop.conversationId,
    requestId: "method-correction", text: correctionText });
  const corrected = page(await collaboration.command(correction.assistantMessageId, "method", { action: "query", collaborationId: delegated.collaboration.collaborationId }));
  const changed = z.object({ status: z.literal("procedure_revised"), executorBotId: z.literal("b"), memoryId: z.string() }).parse(corrected.methodFeedback);
  assert(memory.get(changed.memoryId)?.content.includes("先核对逐项合计"));
  assert(memory.get(changed.memoryId)?.content.includes(digest));
  assert(!memory.get(changed.memoryId)?.content.includes(scratchDigest), "method evidence uses only actual result-card files");
  const candidate = memory.learning.list().find(item => item.sourceMemoryIds.includes(changed.memoryId))!;
  assert(candidate);
  assert(candidate.instructions.includes(correctionText), "keep the complete correction as source evidence");
  assert(candidate.instructions.includes("用户纠正原文（来源语境，不是整段执行指令）"));
  assert(candidate.instructions.includes("仅复用其中面向未来任务的方法规则"));
  assert(candidate.instructions.includes("不得把这些当轮指令提升为适用条件"));
  assert.equal(candidate.scopeType, "bot"); assert.equal(candidate.scopeId, "b");
  assert(!candidate.instructions.includes(historicGoal), "old Work goal must not become reusable executable instructions");
  assert(!candidate.title.includes("Work-old-123"));
  assert(!candidate.title.includes("old-machine"));
  assert.equal((memory.get(changed.memoryId)?.metadata.workMethodSource as any)?.title, "C:\\old-machine\\old-work old-output.txt 仅续做 Work-old-123");
  assert(!candidate.instructions.includes("old-output.txt"), "old result names are evidence, not future applicability");
  assert.equal((memory.get(changed.memoryId)?.metadata.workMethodSource as any)?.goalDescription, historicGoal,
    "the full original goal is retained as structured source evidence");
  assert(candidate.instructions.includes("当前任务"));
  assert.equal(effectiveness.listRecent().length, 0, "a first-time method does not fabricate a Skill invocation");
  const methodCount = memory.listExactScope("work", workId).filter(item => item.kind === "procedure").length;
  await collaboration.command(correction.assistantMessageId, "method-again", { action: "query", collaborationId: delegated.collaboration.collaborationId });
  assert.equal(memory.listExactScope("work", workId).filter(item => item.kind === "procedure").length, methodCount);
  const installed = skills.installLearnedSkill({ ...candidate, candidateId: candidate.id });
  const installedSource = skills.getLearnedSkillRevisionSource(installed.id)!;
  const installedBytes = readFileSync(installedSource.filePath, "utf8");
  assert(!installedBytes.includes(historicGoal));
  assert(!installedBytes.includes("Work-old-123"));
  assert(installedBytes.includes(correctionText));
  assert(installedBytes.includes("不作为未来任务约束"), "materialized Skill must preserve the source/operation boundary");
  assert(installedBytes.includes("先核对逐项合计"), "the actual installed Skill retains the reusable correction");
  memory.learning.markMaterialized(candidate.id, installed.id); skills.setEnabled(installed.id, true, { botId: "b" });
  assert.equal(skills.resolveRuntimeSkills(undefined, [], undefined, { botId: "a" }).dtos.some(item => item.id === installed.id), false);
  assert.equal(skills.resolveRuntimeSkills(undefined, [], undefined, { botId: "b" }).dtos.some(item => item.id === installed.id), true);
  assert.equal(bridge.context("a", desktop.conversationId).includes("先核对逐项合计"), false, "B method never becomes A private memory");
  const installedBeforeCorrection = readFileSync(installedSource.filePath, "utf8");
  const scopedMethod = memory.get(changed.memoryId)!;
  const explicitScope = '仅适用于用户明确指定的 P:\\approved-data 目录，先核验输入再计算。';
  memory.updateFromTask(scopedMethod.sourceTaskId!, { id: scopedMethod.id, content: explicitScope,
    changedBy: 'user', changeReason: '明确的合法方法适用范围' });
  const nextCorrection = messages.accept(LOCAL_USER_ID, { botId: "a", conversationId: desktop.conversationId,
    requestId: "existing-method-scope", text: "纠正这个方法：以后核对合计后再登记结果。" });
  await collaboration.command(nextCorrection.assistantMessageId, "existing-method", { action: "query", collaborationId: delegated.collaboration.collaborationId });
  assert.equal(readFileSync(installedSource.filePath, "utf8"), installedBeforeCorrection,
    "later source corrections do not silently rewrite an already approved installed Skill");
  assert(memory.get(scopedMethod.id)!.content.startsWith(explicitScope), "existing genuine procedure scope is not rewritten or stripped");
  console.log("PASS first successful artifact-grounded Work receives exact user correction, creates B reviewable Procedure/Skill without fabricated invocation, and replays idempotently");
} finally {
  await peer.close(); app.close(); rmSync(root, { recursive: true, force: true });
}
