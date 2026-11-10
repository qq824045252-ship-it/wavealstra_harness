import assert from "node:assert/strict";
import { ensureBotInbox } from "../src/main/agent/work/WorkDeliveryTargets";
import { projectTeamReport } from "../src/main/agent/work/WorkReportPresentation";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { BotConversationRepository } from "../src/main/agent/work/BotConversationRepository";
import { WorkConversationFeedback } from "../src/main/agent/work/WorkConversationFeedback";
import { DEFAULT_BOT_ID, LOCAL_USER_ID } from "../src/shared/bot-work";

const root = mkdtempSync(join(tmpdir(), "work-conversation-feedback-"));
const path = join(root, "business.db");
let db = new AppDatabase(path);
let authority = true;
const open = () => {
  const bots = new BotRegistry(db.connection);
  bots.ensureDefaultBot(LOCAL_USER_ID);
  const works = new WorkService(db.connection, { bots, isAuthority: () => authority });
  const messages = new BotConversationRepository(db.connection);
  const feedback = new WorkConversationFeedback({ db: db.connection, userId: LOCAL_USER_ID, works, isAuthority: () => authority });
  return { bots, works, messages, feedback };
};
try {
  const reportInput = { userRequest: { messages: [{ messageId: "request-local", role: "user", text: "读取并对比两份文件" }] },
    teamAssignment: { role: "owner_summary", previousResults: [
      { botId: "a", displayName: "甲", responsibility: "读取甲文件", executionStatus: "completed", bindingId: "binding-a", deliverableId: "result-a" },
      { botId: "b", displayName: "乙", responsibility: "读取乙文件", executionStatus: "failed", bindingId: "binding-b", failureReason: "ENOENT" },
      { botId: "c", displayName: "丙", responsibility: "核对乙文件", executionStatus: "not_started", summary: "前置失败，未启动" },
    ] } };
  const draft = { format: "bot-team-report-v1", requestMessageId: "request-local", conclusions: [{ text: "甲已读取；乙失败", evidenceRefs: ["result-a", "binding-b"] }], observations: ["可选建议"] };
  const nativePresentation = projectTeamReport(JSON.stringify(draft), reportInput);
  assert.equal(nativePresentation.structured?.conclusions[0].requestText, "读取并对比两份文件");
  assert.equal(nativePresentation.teamFacts?.[1].failureReason, "ENOENT", "native failure is independent of model prose");
  assert.equal(nativePresentation.teamFacts?.[2].executionStatus, "not_started");
  assert.equal(nativePresentation.teamFacts?.[2].failureReason, "前置失败，未启动");
  const withInternalReason = { ...reportInput, teamAssignment: { ...reportInput.teamAssignment, previousResults: reportInput.teamAssignment.previousResults.map(item => item.botId === "c" ? { ...item, summary: "前置 binding-b 失败，未启动" } : item) } };
  const readable = projectTeamReport("plain fallback", withInternalReason).teamFacts![2];
  assert.equal(readable.failureSummary, "前置 乙 失败，未启动");
  assert.equal(readable.failureReason, "前置 binding-b 失败，未启动", "original diagnostic remains exact");
  const boundaryInput = { ...reportInput, teamAssignment: { ...reportInput.teamAssignment, previousResults: [
    { ...reportInput.teamAssignment.previousResults[0], bindingId: "binding.[x]" },
    { ...reportInput.teamAssignment.previousResults[2], summary: "binding.[x] binding.[x]-unknown" },
  ] } };
  assert.equal(projectTeamReport("plain", boundaryInput).teamFacts![1].failureSummary, "甲 binding.[x]-unknown", "exact escaping and boundaries keep unknown identifiers intact");
  assert.deepEqual(projectTeamReport("```json\n" + JSON.stringify(draft) + "\n```", reportInput), nativePresentation);
  for (const invalid of ["原有普通报告", "{bad-json", JSON.stringify({ ...draft, untrustedHostFacts: [] }),
    JSON.stringify({ ...draft, requestMessageId: "foreign-request" }),
    JSON.stringify({ ...draft, conclusions: [{ ...draft.conclusions[0], evidenceRefs: ["foreign-or-old-binding"] }] })]) {
    const fallback = projectTeamReport(invalid, reportInput);
    assert.equal(fallback.structured, undefined, "unparseable/foreign references fall back, never repair or rerun");
    assert.equal(fallback.teamFacts?.[1].failureReason, "ENOENT", "fallback cannot hide native failure");
  }
  const labeled = { ...draft, conclusions: [{ ...draft.conclusions[0], evidenceRefs: ["deliverableId:result-a", "bindingId:binding-b", "botId:a"] }] };
  assert.deepEqual(projectTeamReport(JSON.stringify(labeled), reportInput).structured?.conclusions[0].sources.map(item => item.ref), ["result-a", "binding-b", "a"], "exact field-value aliases remain readable and retain canonical provenance");
  for (const invalid of ["botId:result-a", "bindingId:foreign", "deliverableId:result-a-extra", "unknown:result-a", "botId:botId:a"]) {
    assert.equal(projectTeamReport(JSON.stringify({ ...draft, conclusions: [{ ...draft.conclusions[0], evidenceRefs: [invalid] }] }), reportInput).structured, undefined, "wrong type, foreign identity and arbitrary prefixes remain invalid");
  }
  assert.deepEqual(projectTeamReport(JSON.stringify(draft), {}), {}, "missing historical context returns raw-only presentation");
  const repeatedBot = { ...reportInput, teamAssignment: { ...reportInput.teamAssignment,
    previousResults: [...reportInput.teamAssignment.previousResults, { ...reportInput.teamAssignment.previousResults[0], responsibility: "另一个分工", bindingId: "binding-a-2", deliverableId: "result-a-2" }] } };
  assert.equal(projectTeamReport(JSON.stringify({ ...draft, conclusions: [{ ...draft.conclusions[0], evidenceRefs: ["botId:a"] }] }), repeatedBot).structured, undefined, "aliases do not resolve ambiguous members");
  assert.equal(projectTeamReport(JSON.stringify({ ...draft, conclusions: [{ ...draft.conclusions[0], evidenceRefs: ["a"] }] }), repeatedBot).structured,
    undefined, "ambiguous bot identity cannot misattribute two different assignments");
  assert(projectTeamReport(JSON.stringify(draft), repeatedBot).structured, "exact binding/result references remain usable");
  const unsupportedClaim = projectTeamReport(JSON.stringify({ ...draft, conclusions: [{ ...draft.conclusions[0], text: "未经证明的比较" }] }), reportInput);
  assert.equal(unsupportedClaim.structured?.conclusions[0].text, "未经证明的比较", "reference validation is not a semantic truth claim or silent rewriting");
  let { bots, works, messages, feedback } = open();
  const source = messages.accept(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, requestId: "source", text: "完成后台任务" });
  messages.update(source.assistantMessageId, "completed", "已开始处理");
  const create = (operationId: string, linked = true) => {
    const result = works.createWork({ kind: "user", userId: LOCAL_USER_ID, entry: "desktop", grants: DESKTOP_USER_GRANTS }, {
      operationId, title: operationId, ownerBotId: DEFAULT_BOT_ID, inputSnapshotId: `input:${operationId}`,
      authorization: DESKTOP_USER_GRANTS, criteria: [{ id: `${operationId}-criterion`, text: "核验完成" }],
      ...(linked ? { conversationId: source.conversationId, sourceMessageId: source.userMessageId } : {}),
    });
    assert(result.ok); return result.work;
  };
  const work = create("feedback-work");
  const fullResult = `产出成果\n${"核实过的报告正文。".repeat(500)}\n末尾限制：发行包尚未验证。\n来源：https://example.com/final-source\n![报告图片](report.png)`;
  messages.linkWork(messages.receipt(LOCAL_USER_ID, DEFAULT_BOT_ID, "source")!, work.workId);
  works.repo.insertBinding({ bindingId: "binding-1", workId: work.workId, operationId: "binding-operation", botId: DEFAULT_BOT_ID,
    taskId: "background-task", durableStoreKey: "store", conversationId: "background-native-conversation", intentRevision: work.intentRevision,
    ownerEpoch: work.ownerEpoch, inputSnapshotId: work.inputSnapshotId, expertSnapshot: bots.activeSnapshot(DEFAULT_BOT_ID)!,
    delegatedScope: [], workspaceBinding: root, status: "completed", admittedAt: 1, settledAt: 2, settlementNote: fullResult });
  const reportBinding = works.repo.getBinding("binding-1")!;
  assert.equal(works.repo.reportContext(reportBinding), undefined, "legacy binding has no fabricated context");
  works.repo.captureReportContext(reportBinding, JSON.stringify(reportInput));
  assert.deepEqual(works.repo.reportContext(reportBinding), reportInput);
  works.repo.captureReportContext(reportBinding, JSON.stringify({ ...reportInput, userRequest: { messages: [] } }));
  assert.deepEqual(works.repo.reportContext(reportBinding), reportInput, "recovery/task-input mutation cannot replace an earlier binding context");
  for (const mismatch of [{ ownerEpoch: reportBinding.ownerEpoch + 1 }, { intentRevision: reportBinding.intentRevision + 1 },
    { taskId: "other-task" }, { workId: "other-work" }, { inputSnapshotId: "other-input" }]) {
    assert.equal(works.repo.reportContext({ ...reportBinding, ...mismatch }), undefined, "context cannot cross binding identity/version");
  }
  db.connection.exec("CREATE TRIGGER fail_report_context BEFORE INSERT ON work_report_contexts BEGIN SELECT RAISE(ABORT,'presentation unavailable'); END");
  assert.doesNotThrow(() => works.repo.captureReportContext({ ...reportBinding, bindingId: "storage-failed" }, JSON.stringify(reportInput)));
  assert.equal(works.repo.reportContext({ ...reportBinding, bindingId: "storage-failed" }), undefined, "optional storage failure only loses presentation, not task execution");
  db.connection.exec("DROP TRIGGER fail_report_context");
  const savedPath = join(root, "artifacts", "0123456789.csv");
  db.connection.transaction(() => works.generatedArtifacts.record(works.repo.getBinding("binding-1")!, [{
    path: join(root, "report.csv"), snapshotPath: savedPath, digest: "saved-digest", sizeBytes: 42, registeredAt: 2, sourceEntryId: 1,
  }]))();
  const submitted = works.submitDeliverable({ kind: "worker", botId: DEFAULT_BOT_ID, bindingId: "binding-1" }, {
    operationId: "result:binding-1", deliverableId: "result:binding-1", workId: work.workId, bindingId: "binding-1",
    summary: fullResult, artifactRefs: ["artifact:report", savedPath], uncoveredScope: ["发行包验证"], uncoveredCriterionIds: [],
    isSpeculation: false, hasWriteConflicts: false });
  assert(submitted.ok);
  assert.equal(works.repo.getDeliverable("result:binding-1")?.summary, fullResult, "authoritative result must not be truncated to a card preview");
  const detailResult = works.getProjection(work.workId)!.deliverables.find(item => item.deliverableId === "result:binding-1")!;
  assert.deepEqual(detailResult.presentation, projectTeamReport(fullResult, reportInput), "details use the same frozen report projection as conversation results");
  const priorBinding = works.repo.getBinding("binding-1")!;
  db.connection.prepare("UPDATE work_execution_bindings SET owner_epoch = owner_epoch + 1 WHERE binding_id = ?").run("binding-1");
  assert.equal(works.getProjection(work.workId)!.deliverables.find(item => item.deliverableId === "result:binding-1")?.presentation, undefined, "details must not attach a foreign execution generation");
  db.connection.prepare("UPDATE work_execution_bindings SET owner_epoch = ? WHERE binding_id = ?").run(priorBinding.ownerEpoch, "binding-1");

  works.repo.insertBlocker({ blockerId: "blocker-1", workId: work.workId, reason: "需要确认范围", kind: "operational",
    status: "open", waitingForUserInput: true, createdAt: 4 });
  const before = works.getWork(work.workId)!;
  authority = false; assert.equal(feedback.drain(), 0); authority = true;
  assert.equal(feedback.drain(), 3);
  assert.equal(feedback.drain(), 0);
  assert.deepEqual(works.getWork(work.workId), before, "feedback cannot accept, close or otherwise mutate Work");
  const history = () => messages.history(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, conversationId: source.conversationId });
  assert.equal(history().messages.length, 5);
  assert.equal(works.repo.getDeliverable("result:binding-1")?.status, "proposed", "natural feedback must not forge acceptance");
  assert(history().messages.some(m => m.text.includes("需要你补充信息")));
  assert(history().messages.slice(2).every(m => m.role === "assistant" && m.status === "completed" && m.workIds[0] === work.workId));
  assert.equal(messages.next(source.conversationId), undefined, "feedback must not queue a model turn");
  assert.equal(history().messages.filter(m => m.text.includes("产出成果")).length, 1, "one native observation is not repeated as binding + deliverable bodies");
  const initialFeedback = history().messages.slice(2);
  assert.deepEqual(initialFeedback.map(m => m.workFeedback?.category), ["progress", "result", "decision"]);
  assert.equal(initialFeedback[0].workFeedback?.executionId, "binding-1");
  assert.equal(initialFeedback[1].workFeedback?.executionId, "binding-1");
  assert(initialFeedback[1].text.includes(fullResult), "Bot feedback retains the complete result, trailing caveat, source and Markdown image");
  const report = initialFeedback[1].workFeedback?.report;
  assert.equal(report?.title, work.title);
  assert.equal(report?.teamFacts?.[1].failureReason, "ENOENT", "plain-text fallback still delivers native facts");
  assert.equal(report?.structured, undefined);
  assert.equal(report?.summary, fullResult);
  assert.deepEqual(report?.artifactRefs, ["artifact:report", savedPath]);
  assert.deepEqual(report?.files?.find(file => file.ref === savedPath), { ref: savedPath, name: "report.csv", openPath: savedPath });
  assert.equal(report?.files?.find(file => file.ref === "artifact:report")?.openPath, undefined);
  assert.deepEqual(report?.notices, ["尚未覆盖：发行包验证"]);
  assert.equal(report?.reviewStatus, "proposed");
  // Previous structured metadata is upgraded only for the unchanged version.
  db.connection.prepare("UPDATE bot_work_feedback SET metadata_json=json_remove(metadata_json,'$.report') WHERE message_id=?")
    .run(initialFeedback[1].messageId);
  const preUpgrade = history();
  assert.equal(feedback.drain(), 0);
  const postUpgrade = history();
  assert.deepEqual(postUpgrade.messages.map(m => [m.messageId, m.text]), preUpgrade.messages.map(m => [m.messageId, m.text]));
  assert.equal(postUpgrade.messages.find(m => m.messageId === initialFeedback[1].messageId)?.workFeedback?.report?.summary, fullResult);
  assert(postUpgrade.revision > preUpgrade.revision, "renderer is notified when display metadata is upgraded");
  const stableRevision = postUpgrade.revision;
  assert.equal(feedback.drain(), 0);
  assert.equal(history().revision, stableRevision, "no repeated revision churn after upgrade");
  // Upgrade an already-delivered legacy history in place: only additive metadata,
  // no reset, no body mutation, no repeated send, and no lifecycle/criteria change.
  db.connection.exec("DELETE FROM bot_work_feedback");
  const legacyBodies = history().messages.map(m => [m.messageId, m.text]);
  assert.equal(feedback.drain(), 0);
  assert.deepEqual(history().messages.map(m => [m.messageId, m.text]), legacyBodies);
  assert(history().messages.slice(2).every(m => m.workFeedback));
  assert.deepEqual(works.getWork(work.workId), before);

  // Re-execution changes the current input, not the identity or availability of saved results.
  works.repo.updateWork({ ...before, intentRevision: before.intentRevision + 1,
    inputSnapshotId: "new-input", stateVersion: before.stateVersion + 1 });
  assert.equal(works.generatedArtifacts.list(work.workId).length, 0, "old files are not current completion evidence");
  assert.equal(works.getProjection(work.workId)?.historicalGeneratedArtifacts?.[0].snapshotPath, savedPath);
  feedback.drain(work.workId);
  const historicalReport = history().messages.filter(m => m.workFeedback?.kind === "result").at(-1)?.workFeedback?.report;
  assert.equal(historicalReport?.current, false);
  assert.deepEqual(historicalReport?.files?.find(file => file.ref === savedPath), { ref: savedPath, name: "report.csv", openPath: savedPath });
  assert.equal(historicalReport?.files?.find(file => file.ref === "artifact:report")?.openPath, undefined);
  // A persisted broken display projection is repaired without duplicating the report.
  const historicalMessage = history().messages.filter(m => m.workFeedback?.kind === "result").at(-1)!;
  db.connection.prepare("UPDATE bot_work_feedback SET metadata_json=json_remove(metadata_json,'$.report.files') WHERE message_id=?").run(historicalMessage.messageId);
  const countBeforeRepair = history().messages.length;
  assert.equal(feedback.drain(work.workId), 0);
  assert.equal(history().messages.length, countBeforeRepair);
  assert.equal(history().messages.find(m => m.messageId === historicalMessage.messageId)?.workFeedback?.report?.files?.[1].openPath, savedPath);
  works.repo.updateWork(before);
  feedback.drain(work.workId);

  const revision = history().revision;
  assert.throws(() => db.connection.transaction(() => { messages.appendWorkFeedback(messages.workOrigin(LOCAL_USER_ID, work.workId)!, work.workId, "crash", "1", "rollback"); throw Error("crash"); })());
  assert.equal(history().revision, revision, "failed delivery rolls back message and revision together");

  messages.archive(LOCAL_USER_ID, DEFAULT_BOT_ID, source.conversationId);
  const unrelated = messages.accept(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, requestId: "unrelated", text: "新对话" });
  messages.update(unrelated.assistantMessageId, "completed", "新对话回复");
  bots.registerBot({ botId: "new-owner", userId: LOCAL_USER_ID, displayName: "New owner", authorization: DESKTOP_USER_GRANTS });
  const other = messages.accept(LOCAL_USER_ID, { botId: "new-owner", requestId: "other", text: "接管" });
  messages.update(other.assistantMessageId, "completed", "收到");
  messages.linkWork(messages.receipt(LOCAL_USER_ID, "new-owner", "other")!, work.workId);
  works.repo.updateWork({ ...before, ownerBotId: "new-owner", ownerEpoch: 2, sourceMessageId: other.userMessageId, stateVersion: before.stateVersion + 1 });
  works.repo.clearBlocker("blocker-1", work.workId, 5);
  assert.equal(feedback.drain(work.workId), 1, "clear goes to original archived chat after handoff");
  works.repo.clearBlocker("blocker-1", work.workId, 6);
  assert.equal(works.repo.getBlocker("blocker-1")?.clearedAt, 5, "repeat settlement retains the original clearance receipt");
  assert.equal(feedback.drain(work.workId), 0, "approval then consumption cannot send duplicate blocker-cleared feedback");
  db.connection.exec("DELETE FROM bot_work_feedback"); // Also upgrade older event versions after a status change.
  works.repo.reopenBlocker("blocker-1", work.workId);
  assert.equal(feedback.drain(work.workId), 1, "reopened blocker gets a new version");
  assert(history().messages.filter(m => m.requestId.startsWith("work-feedback:")).every(m => m.workFeedback));
  const blockerVersions = history().messages.filter(m => m.workFeedback?.eventId === "blocker:blocker-1");
  assert.equal(blockerVersions.at(-1)?.workFeedback?.category, "decision");
  assert(blockerVersions.slice(0, -1).every(m => m.workFeedback?.category === "progress"));
  assert.equal(feedback.drain(work.workId), 0);
  assert.equal(messages.history(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID }).messages.length, 2);
  assert.equal(messages.history(LOCAL_USER_ID, { botId: "new-owner" }).messages.length, 2);
  assert.equal(history().archived, true);

  const orphan = create("unlinked-work", false);
  works.repo.insertBlocker({ blockerId: "orphan-blocker", workId: orphan.workId, reason: "No origin", kind: "operational", status: "open", waitingForUserInput: true, createdAt: 6 });
  assert.equal(feedback.drain(orphan.workId), 1, "UI Work delivers to its owning Bot conversation");
  const inbox = messages.resolveWorkDelivery(LOCAL_USER_ID, orphan.workId)!;
  assert(!inbox.conversation_id.startsWith("bot-inbox-"));
  assert.equal(inbox.conversation_id, messages.history(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID }).conversationId);
  const inboxMeta = { workId: orphan.workId, eventId: "result:inbox", kind: "result" as const, category: "result" as const };
  const delivered = messages.appendWorkDelivery(LOCAL_USER_ID, orphan.workId, "result:inbox", "1", "团队结果已返回", inboxMeta);
  assert(delivered.delivered && delivered.inserted);
  assert.deepEqual(messages.appendWorkDelivery(LOCAL_USER_ID, orphan.workId, "result:inbox", "1", "团队结果已返回", inboxMeta),
    { delivered: true, inserted: false, conversationId: inbox.conversation_id });
  assert.equal(messages.history(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID }).messages.at(-1)?.text, "团队结果已返回");
  assert.equal(messages.history(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID }).messages.length, 4, "result appears naturally in the owner conversation");
  assert.equal(messages.resolveWorkDelivery("another-user", orphan.workId), undefined);
  assert.equal(messages.resolveWorkDelivery(LOCAL_USER_ID, work.workId)?.conversation_id, source.conversationId, "archived original destination survives owner handoff");
  const legacy = create("legacy-inbox", false);
  db.connection.prepare("DELETE FROM work_conversations WHERE work_id=? AND channel_type='bot-delivery'").run(legacy.workId);
  const beforeLegacy = JSON.stringify(works.getWork(legacy.workId));
  assert.equal(messages.resolveWorkDelivery(LOCAL_USER_ID, legacy.workId)?.conversation_id, inbox.conversation_id);
  assert.equal(JSON.stringify(works.getWork(legacy.workId)), beforeLegacy, "legacy projection neither executes nor mutates Work");
  // Upgrade old inbox routing without moving/removing the original message.
  const oldInboxId = ensureBotInbox(db.connection, LOCAL_USER_ID, DEFAULT_BOT_ID)!;
  const oldInbox = messages.conversation(LOCAL_USER_ID, DEFAULT_BOT_ID, oldInboxId)!;
  const oldMeta = { ...inboxMeta, workId: legacy.workId, eventId: "result:legacy" };
  messages.appendWorkFeedback(oldInbox, legacy.workId, "result:legacy", "1", "原有历史结果", oldMeta);
  db.connection.prepare("DELETE FROM work_conversations WHERE work_id=? AND channel_type='bot-delivery'").run(legacy.workId);
  db.connection.prepare("INSERT INTO work_conversations VALUES (?,?,'bot-delivery',1)").run(legacy.workId, oldInboxId);
  const oldMessage = messages.history(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, inbox: true }).messages.at(-1)!;
  assert.equal(messages.resolveWorkDelivery(LOCAL_USER_ID, legacy.workId)?.conversation_id, inbox.conversation_id);
  assert(messages.history(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID }).messages.some(m => m.messageId === oldMessage.messageId));
  assert(messages.messageBelongsToConversation(LOCAL_USER_ID, inbox.conversation_id, oldMessage.messageId), "projected result remains replyable");
  assert(!messages.messageBelongsToConversation("other-user", inbox.conversation_id, oldMessage.messageId));
  assert.equal(messages.message(oldMessage.messageId)?.conversationId, oldInboxId, "raw historical provenance is retained");
  assert.equal(messages.appendWorkDelivery(LOCAL_USER_ID, legacy.workId, "result:legacy", "1", "原有历史结果", oldMeta).inserted, false, "replay must not duplicate projected history");
  assert(!messages.history(LOCAL_USER_ID, { botId: "new-owner" }).messages.some(m => m.messageId === oldMessage.messageId));
  const legacyTeam = create("legacy-team-delivery", false);
  db.connection.exec("CREATE TABLE IF NOT EXISTS work_team_ownership(work_id TEXT PRIMARY KEY,team_id TEXT,team_name TEXT)");
  db.connection.prepare("INSERT INTO work_teams VALUES (?,?,'legacy-team','digest','{}',1,'input',1)").run(legacyTeam.workId, LOCAL_USER_ID);
  db.connection.prepare("INSERT INTO work_team_ownership VALUES (?, 'known-team', '已确认团队')").run(legacyTeam.workId);
  db.connection.prepare("UPDATE work_conversations SET conversation_id=? WHERE work_id=? AND channel_type='bot-delivery'").run(oldInboxId, legacyTeam.workId);
  const teamMeta = { ...oldMeta, workId: legacyTeam.workId, eventId: "result:team" };
  messages.appendWorkFeedback(oldInbox, legacyTeam.workId, "result:team", "1", "团队历史结果", teamMeta);
  const teamDestination = messages.resolveWorkDelivery(LOCAL_USER_ID, legacyTeam.workId)!;
  assert.equal(teamDestination.team_id, "known-team", "known team identity overrides retired owner inbox");
  assert(messages.history(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, teamId: "known-team" }).messages.some(m => m.text === "团队历史结果"));
  assert(!messages.history(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID }).messages.some(m => m.text === "团队历史结果"));
  db.connection.prepare("INSERT INTO work_teams VALUES (?,?,'member-report','digest','{}',1,'input',1)").run(work.workId, LOCAL_USER_ID);
  db.connection.prepare("INSERT INTO work_team_executions(work_id,ordinal,bot_id,task_id,role,responsibility,scopes_json) VALUES (?,0,?,?,'member','核对','[]')")
    .run(work.workId, reportBinding.botId, reportBinding.taskId);
  const originalResultCount = history().messages.filter(m => m.workFeedback?.eventId === "result:result:binding-1").length;
  feedback.drain(work.workId);
  const folded = history().messages.filter(m => m.workFeedback?.eventId === "result:result:binding-1");
  assert.equal(folded.length, originalResultCount, "recategorizing existing member reports does not duplicate messages");
  assert.equal(folded.at(-1)?.workFeedback?.category, "progress", "members fold into execution history, only owner conclusion is main result");
  assert.equal(works.repo.getDeliverable("result:binding-1")?.summary, fullResult, "member report source text is retained");
  works.repo.updateWork({ ...works.getWork(work.workId)!, lifecycle: "closed", closedAt: 8, closureConclusion: "cancelled", closureSummary: "已取消" });
  const finalCount = history().messages.length;
  db.connection.exec("DROP TABLE bot_work_feedback"); // Existing v35 database upgrade, not a schema reset.
  db.close(); db = new AppDatabase(path);
  ({ bots, works, messages, feedback } = open());
  assert.equal(works.repo.getDeliverable("result:binding-1")?.summary, fullResult, "reopening preserves the full result");
  assert.deepEqual(works.repo.reportContext(reportBinding), reportInput, "source snapshot survives normal restart unchanged");
  assert(messages.history(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, conversationId: source.conversationId }).messages
    .some(message => message.messageId === initialFeedback[1].messageId && message.text.includes(fullResult)), "reopened originating history retains the whole report");
  assert.equal(feedback.recover(), 1, "recovery discovers closure after restart");
  assert.equal(feedback.recover(), 0, "persisted result/blocker deliveries dedupe across restart");
  assert.equal(history().messages.length, finalCount + 1);
  assert(history().messages.at(-1)!.text.includes("cancelled"));
  assert.equal(messages.next(source.conversationId), undefined);
  works.repo.insertBlocker({ blockerId: "retry-blocker", workId: work.workId, reason: "等待重试", kind: "operational",
    status: "open", waitingForUserInput: true, createdAt: 9 });
  const countBeforeRetry = history().messages.length;
  db.connection.exec(`CREATE TEMP TRIGGER fail_feedback BEFORE INSERT ON bot_messages
    WHEN NEW.request_id LIKE 'work-feedback:%' BEGIN SELECT RAISE(ABORT, 'injected feedback failure'); END`);
  feedback = new WorkConversationFeedback({ db: db.connection, userId: LOCAL_USER_ID, works, isAuthority: () => authority, pollIntervalMs: 10 });
  try {
    assert.doesNotThrow(() => feedback.start(), "startup delivery failure must not escape");
    assert.equal(history().messages.length, countBeforeRetry, "failed append is not acknowledged");
    db.connection.exec("DROP TRIGGER fail_feedback");
    const until = Date.now() + 2000;
    while (history().messages.length === countBeforeRetry && Date.now() < until) await delay(10);
    assert.equal(history().messages.length, countBeforeRetry + 1, "timer retries without a new Work event");
    feedback.start(); // Idempotent start must not create duplicate loops/deliveries.
    await delay(30);
    assert.equal(history().messages.length, countBeforeRetry + 1);
    feedback.close();
    works.repo.clearBlocker("retry-blocker", work.workId, 10);
    await delay(30);
    assert.equal(history().messages.length, countBeforeRetry + 1, "close cancels background polling");
    assert.equal(feedback.drain(), 1, "synchronous drain remains available");
  } finally { feedback.close(); }
  const independent = create("independent-results");
  for (const id of ["member-a", "member-b"]) {
    works.repo.insertBinding({ bindingId: id, workId: independent.workId, operationId: `operation:${id}`, botId: DEFAULT_BOT_ID,
      taskId: `task:${id}`, durableStoreKey: "store", conversationId: `native:${id}`, intentRevision: independent.intentRevision,
      ownerEpoch: independent.ownerEpoch, inputSnapshotId: independent.inputSnapshotId, expertSnapshot: bots.activeSnapshot(DEFAULT_BOT_ID)!,
      delegatedScope: [], workspaceBinding: root, status: "completed", admittedAt: 1, settledAt: 2, settlementNote: "独立同文成果" });
    works.repo.insertDeliverable({ deliverableId: `result:${id}`, workId: independent.workId, executionId: id, producerBotId: DEFAULT_BOT_ID,
      intentRevision: independent.intentRevision, ownerEpoch: independent.ownerEpoch, inputSnapshotId: independent.inputSnapshotId, status: "proposed",
      summary: "独立同文成果", artifactRefs: [], evidenceRefs: [], uncoveredScope: [], uncoveredCriterionIds: [],
      isSpeculation: false, hasWriteConflicts: false, createdAt: 3 });
  }
  assert.equal(feedback.drain(independent.workId), 4);
  const memberReports = history().messages.filter(m => m.workFeedback?.workId === independent.workId);
  assert.equal(memberReports.filter(m => m.text.includes("独立同文成果")).length, 2, "identical outputs from different bindings both remain visible");
  assert.equal(new Set(memberReports.filter(m => m.workFeedback?.kind === "result").map(m => m.workFeedback?.executionId)).size, 2);
  assert.equal(feedback.drain(independent.workId), 0);
  for (const status of ["unknown", "stopped", "completed"] as const) {
    const id = `partial-${status}`;
    works.repo.insertBinding({ bindingId: id, workId: independent.workId, operationId: `operation:${id}`, botId: DEFAULT_BOT_ID,
      taskId: `task:${id}`, durableStoreKey: "store", conversationId: `native:${id}`, intentRevision: independent.intentRevision,
      ownerEpoch: independent.ownerEpoch, inputSnapshotId: independent.inputSnapshotId, expertSnapshot: bots.activeSnapshot(DEFAULT_BOT_ID)!,
      delegatedScope: [], workspaceBinding: root, status, admittedAt: 1, settledAt: 2, settlementNote: `独立诊断:${status}` });
    works.repo.insertDeliverable({ deliverableId: `partial:${id}`, workId: independent.workId, executionId: id, producerBotId: DEFAULT_BOT_ID,
      intentRevision: independent.intentRevision, ownerEpoch: independent.ownerEpoch, inputSnapshotId: independent.inputSnapshotId, status: "proposed",
      summary: "仅部分步骤成功", artifactRefs: [], evidenceRefs: [], uncoveredScope: [], uncoveredCriterionIds: [],
      isSpeculation: false, hasWriteConflicts: false, createdAt: 3 });
  }
  assert.equal(feedback.drain(independent.workId), 6);
  for (const status of ["unknown", "stopped", "completed"]) {
    const diagnostic = history().messages.find(m => m.workFeedback?.eventId === `binding:partial-${status}`);
    assert(diagnostic);
    assert(diagnostic.text.includes(`独立诊断:${status}`), "a partial deliverable must not erase its parent binding diagnostic");
    assert.equal(diagnostic.workFeedback?.category, "progress", "terminal execution failures are not requests for a user decision");
  }

  const recovery = create("automatic-recovery-feedback");
  for (const [blockerId, waitingForUserInput] of [["continuation:old-failure", true], ["recovery-ended:no-progress", false]] as const) {
    works.repo.insertBlocker({ blockerId, workId: recovery.workId, reason: "自动恢复仍有执行缺口", kind: "operational",
      status: "open", waitingForUserInput, createdAt: 11 });
  }
  assert.equal(feedback.drain(recovery.workId), 2);
  const recoveryMessages = history().messages.filter(message => message.workFeedback?.workId === recovery.workId);
  assert(recoveryMessages.every(message => message.workFeedback?.category === "progress"));
  assert(recoveryMessages.every(message => !message.text.includes("需要你补充信息")));
  for (const blockerId of ["continuation:old-failure", "recovery-ended:no-progress"]) works.repo.clearBlocker(blockerId, recovery.workId, 12);
  assert.equal(feedback.drain(recovery.workId), 0, "clearing internal recovery blockers does not spam the conversation");
  assert.equal(works.repo.listBlockers(recovery.workId).filter(blocker => blocker.status === "cleared").length, 2,
    "feedback suppression never discards durable blocker history");

  const origin = messages.workOrigin(LOCAL_USER_ID, independent.workId)!;
  const oldReport = { workId: independent.workId, eventId: "result:versioned", kind: "result" as const, category: "result" as const,
    report: { title: "版本报告", summary: "旧版", artifactRefs: ["old.csv"], reviewStatus: "proposed" as const, current: true, notices: [] } };
  messages.appendWorkFeedback(origin, independent.workId, "result:versioned", "v1", "旧版原文", oldReport);
  db.connection.prepare("DELETE FROM bot_work_feedback WHERE json_extract(metadata_json,'$.eventId')='result:versioned'").run();
  messages.appendWorkFeedback(origin, independent.workId, "result:versioned", "v2", "新版原文", { ...oldReport,
    report: { ...oldReport.report, summary: "新版", artifactRefs: ["new.csv"] } });
  const versions = history().messages.filter(m => m.workFeedback?.eventId === "result:versioned");
  assert.equal(versions[0].workFeedback?.report, undefined, "older legacy report cannot borrow today's files or summary");
  assert.equal(versions[0].text, "旧版原文");
  assert.equal(versions[1].workFeedback?.report?.summary, "新版");
  const spoofKey = createHash("sha256").update(JSON.stringify([independent.workId, "blocker:spoof"])).digest("hex");
  const spoofVersion = createHash("sha256").update("1").digest("hex");
  const spoofRequest = `work-feedback:${spoofKey}:0000000000000000:${spoofVersion}`;
  // A normal user-chosen request ID can resemble feedback but its message ID
  // was allocated by accept(), not the host's feedback delivery namespace.
  db.connection.prepare(`INSERT INTO bot_messages(message_id,conversation_id,bot_id,request_id,role,text,status,created_at,updated_at)
    VALUES ('bot-message-spoof',?,?,?,'assistant','ordinary reply','completed',1,1)`)
    .run(origin.conversation_id, origin.bot_id, spoofRequest);
  assert.equal(messages.appendWorkFeedback(origin, independent.workId, "blocker:spoof", "1", "real alert", {
    workId: independent.workId, eventId: "blocker:spoof", kind: "blocker", category: "decision",
  }), true, "a user-controlled request ID cannot suppress host feedback");
  assert.equal(messages.message("bot-message-spoof")?.workFeedback, undefined, "ordinary model reply cannot be relabeled by a forged event key");
  console.log("PASS durable Work feedback: origin, archive, handoff, result/blocker versions, restart, rollback, authority, no model turns, retry lifecycle");
} finally { db.close(); rmSync(root, { recursive: true, force: true }); }
