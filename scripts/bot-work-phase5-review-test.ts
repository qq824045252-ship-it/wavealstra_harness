import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { DESKTOP_USER_GRANTS, WorkService } from "../src/main/agent/work/WorkService";
import { randomUUID } from "node:crypto";
import { legacyUserInputSource } from "../src/main/agent/work/WorkLegacyUserInput";
import { userInputBlockerSnapshot } from "../src/shared/bot-work-review";
import { reviewWork } from "../src/main/agent/work/WorkReviewControl";
import { publishTaskLifecycleNotification } from "../src/main/notification/TaskLifecycleNotifications";
import type { NotificationService } from "../src/main/notification/NotificationService";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkControlResult } from "../src/shared/bot-work";

const directory = mkdtempSync(join(tmpdir(), "bot-work-review-"));
const db = new AppDatabase(join(directory, "app.db"));
const bots = new BotRegistry(db.connection);
bots.registerBot({ botId: DEFAULT_BOT_ID, userId: LOCAL_USER_ID, displayName: "Owner", authorization: DESKTOP_USER_GRANTS });
const works = new WorkService(db.connection, { bots });
const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, entry: "desktop", grants: DESKTOP_USER_GRANTS };
const unwrap = (result: WorkControlResult) => { if (!result.ok) throw Error(result.message); return result.work; };
let count = 0;
const check = (title: string, run: () => void) => { run(); console.log(`PASS ${++count}: ${title}`); };
const guard = (workId: string) => {
  const work = works.getWork(workId)!;
  return { expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch };
};
function proposed(suffix: string, ordinary = false) {
  const work = unwrap(works.createWork(user, { operationId: `create:${suffix}`, title: suffix, authorization: DESKTOP_USER_GRANTS,
    inputSnapshotId: `input:${suffix}`, criteria: [{ text: "User verifies this output", requiredEnvironment: ordinary ? undefined : "Fixture OS" }] }));
  const taskId = `task:${suffix}`;
  db.upsertTask({ id: taskId, title: suffix, updatedAt: Date.now() });
  unwrap(works.dispatchExecution(user, { operationId: `dispatch:${suffix}`, workId: work.workId,
    botId: DEFAULT_BOT_ID, taskId, durableStoreKey: `store:${suffix}`, conversationId: "1", workspaceBinding: directory,
    delegatedScope: ["workspace:read", "workspace:write"] }));
  const binding = works.repo.listBindings(work.workId)[0];
  const worker: WorkActor = { kind: "worker", botId: binding.botId, bindingId: binding.bindingId };
  const deliverableId = `deliverable:${suffix}`;
  unwrap(works.submitDeliverable(worker, { operationId: `deliver:${suffix}`, workId: work.workId,
    bindingId: binding.bindingId, deliverableId, summary: `Output ${suffix}`, artifactRefs: [], evidence: [] }));
  works.reconcileExecution(user, { bindingId: binding.bindingId, outcome: "completed" });
  return { workId: work.workId, deliverableId, taskId, worker };
}
try {
  check("batch feedback applies all selected conditions atomically and rejects stale retries", () => {
    const batch = unwrap(works.createWork(user, { operationId: "batch:create", title: "Batch", inputSnapshotId: "batch:input",
      authorization: DESKTOP_USER_GRANTS, criteria: [{ id: "one", text: "bytes", requiredEnvironment: "Linux" },
        { id: "two", text: "contents", requiredEnvironment: "Linux" }, { id: "three", text: "unverified", requiredEnvironment: "Windows" }] }));
    const request = { kind: "feedback" as const, request: { operationId: "batch:feedback", workId: batch.workId,
      criterionIds: ["one", "two"], failed: false, environment: "Linux", sourceRef: "real-shell-record", inputSnapshotId: batch.inputSnapshotId,
      versionGuard: guard(batch.workId) } };
    const result = reviewWork(works, user, request); const next = unwrap(result);
    assert.equal(next.stateVersion, batch.stateVersion + 1);
    assert.deepEqual(next.criteria.map(item => item.status), ["satisfied", "satisfied", "pending"]);
    assert.equal(unwrap(reviewWork(works, user, request)).stateVersion, next.stateVersion);
    assert.equal(reviewWork(works, user, { ...request, request: { ...request.request, operationId: "batch:stale" } }).ok, false);
    const mismatch = reviewWork(works, user, { ...request, request: { ...request.request, operationId: "batch:mismatch",
      criterionIds: ["one", "three"], failed: true, versionGuard: guard(batch.workId) } });
    assert.equal(mismatch.ok, false);
    assert.deepEqual(works.getWork(batch.workId)!.criteria.map(item => item.status), ["satisfied", "satisfied", "pending"]);
  });
  const fixture = proposed("desktop-review");
  const input = { kind: "accept_deliverable" as const, request: { operationId: "ui:accept", workId: fixture.workId,
    deliverableId: fixture.deliverableId, versionGuard: guard(fixture.workId) } };
  check("missing complete review guard is refused without accepting output", () => {
    const result = reviewWork(works, user, { ...input, request: { ...input.request, versionGuard: {} } });
    assert.equal(result.ok, false); assert.equal(works.repo.getDeliverable(fixture.deliverableId)?.status, "proposed");
  });
  check("worker cannot impersonate the trusted review entry", () => {
    const result = reviewWork(works, fixture.worker, input);
    assert.equal(result.ok, false); if (!result.ok) assert.equal(result.code, "unauthorized_actor");
  });
  check("unknown payload identity and cross-user access are rejected", () => {
    assert.equal(reviewWork(works, user, { ...input, actor: user }).ok, false);
    const result = reviewWork(works, { ...user, userId: "another-user" }, input);
    assert.equal(result.ok, false); if (!result.ok) assert.equal(result.code, "not_found");
  });
  check("explicit acceptance retains output but never fabricates criterion evidence", () => {
    const result = reviewWork(works, user, input); const work = unwrap(result);
    assert.equal(works.repo.getDeliverable(fixture.deliverableId)?.status, "accepted");
    assert.equal(work.criteria[0].status, "pending"); assert.equal(work.criteria[0].evidenceRefs.length, 0);
    assert.equal(works.cards.list(work).filter(card => card.kind === "accepted_result").length, 1);
    assert.equal(works.cards.list(work).find(card => card.kind === "accepted_result")?.title, `成果已采纳：${work.title}`);
    assert.equal(works.repo.listNotifications(work.workId).find(item => item.kind === "result")?.title, `成果已采纳：${work.title}`);
    assert.equal(work.lifecycle, "active", "accepting an output is not successful Work closure");
  });
  check("response-loss retry reuses the operation and creates no duplicate card or intent", () => {
    const before = works.getWork(fixture.workId)!;
    const result = reviewWork(works, user, input); assert(result.ok && result.replayed);
    assert.equal(works.getWork(fixture.workId)?.stateVersion, before.stateVersion);
    assert.equal(works.repo.listNotifications(fixture.workId).filter(item => item.kind === "result").length, 1);
    assert.equal(works.cards.list(before).length, 1);
  });
  const close = (operationId: string) => ({ kind: "close" as const, request: {
    operationId, workId: fixture.workId, conclusion: "succeeded" as const,
    closureSummary: "User checked current fixture output", confirmed: true as const, versionGuard: guard(fixture.workId),
  } });
  check("close requires explicit confirmation and current acceptance evidence", () => {
    const request = close("ui:close-unverified");
    assert.equal(reviewWork(works, user, { ...request, request: { ...request.request, confirmed: false } }).ok, false);
    const result = reviewWork(works, user, request);
    assert.equal(result.ok, false); if (!result.ok) assert.equal(result.code, "unmet_acceptance_criteria");
    assert.equal(works.getWork(fixture.workId)?.lifecycle, "active");
  });
  const feedback = (operationId: string, failed: boolean, environment = "Fixture OS") => {
    const current = works.getWork(fixture.workId)!;
    return { kind: "feedback" as const, request: { operationId, workId: fixture.workId,
      criterionIds: [current.criteria[0].id], environment, sourceRef: "fixture:review-record",
      inputSnapshotId: current.inputSnapshotId, failed, versionGuard: guard(fixture.workId) } };
  };
  check("wrong environment and old review versions cannot satisfy current criteria", () => {
    assert.equal(reviewWork(works, user, feedback("ui:wrong-environment", false, "Other OS")).ok, false);
    const current = feedback("ui:stale-feedback", false);
    current.request.versionGuard.expectedStateVersion -= 1;
    const result = reviewWork(works, user, current);
    assert.equal(result.ok, false); if (!result.ok) assert.equal(result.code, "version_conflict");
  });
  check("failed user feedback remains failed and cannot close successfully", () => {
    unwrap(reviewWork(works, user, feedback("ui:failed", true)));
    assert.equal(works.getWork(fixture.workId)?.criteria[0].status, "failed");
    assert.equal(reviewWork(works, user, close("ui:close-failed")).ok, false);
  });
  check("current user feedback and trusted closure complete the original accepted card", () => {
    unwrap(reviewWork(works, user, feedback("ui:passed", false)));
    assert.equal(works.cards.unverifiedScope(works.getWork(fixture.workId)!)[0].reason, "user_verified",
      "a current user verification is never presented as an automatic check");
    const before = works.cards.list(works.getWork(fixture.workId)!).filter(card => card.kind === "accepted_result")[0];
    const request = close("ui:close-passed"); const closed = unwrap(reviewWork(works, user, request));
    assert.equal(closed.lifecycle, "closed"); assert.equal(closed.closureConclusion, "succeeded");
    assert.equal(works.cards.list(closed).length, 1); assert.equal(works.cards.list(closed)[0].cardKey, before.cardKey);
    const replay = reviewWork(works, user, request); assert(replay.ok && replay.replayed);
  });
  check("explicit rejection keeps its reason and has no result acceptance notification", () => {
    const rejected = proposed("reject");
    unwrap(reviewWork(works, user, { kind: "reject_deliverable", request: { operationId: "ui:reject",
      workId: rejected.workId, deliverableId: rejected.deliverableId, reason: "Output is incomplete", versionGuard: guard(rejected.workId) } }));
    assert.equal(works.repo.getDeliverable(rejected.deliverableId)?.status, "rejected");
    assert.equal(works.repo.listNotifications(rejected.workId).filter(item => item.kind === "result").length, 0);
  });
  check("Work task completion is quiet while ordinary Task completion and necessary prompts remain", () => {
    const published: Array<Parameters<NotificationService["publish"]>[0]> = [];
    const notifications = { publish: ((value: Parameters<NotificationService["publish"]>[0]) => {
      published.push(value); return null;
    }) as NotificationService["publish"] };
    const publish = (event: Parameters<typeof publishTaskLifecycleNotification>[0]["event"]) =>
      publishTaskLifecycleNotification({ event, task: db.getTask(event.taskId), workRepo: works.repo, notifications });
    publish({ kind: "completed", taskId: fixture.taskId, assistantMessageId: "native-result" });
    assert.equal(published.length, 0);
    publish({ kind: "completed", taskId: "ordinary-task", assistantMessageId: "ordinary-result" });
    assert.equal(published.length, 1); assert.equal(published[0].type, "task.completed");
    publish({ kind: "action_required", taskId: fixture.taskId, assistantMessageId: "permission",
      toolCallId: "tool", summary: "Permission required" });
    assert.equal(published.length, 2); assert.equal(published[1].type, "task.action_required");
    publish({ kind: "completed", taskId: "cron-owned", assistantMessageId: "cron-result" });
    assert.equal(published.length, 2);
  });
  check("ordinary output is adopted, explicitly verified and closed without inventing a test environment", () => {
    const fixture = proposed("ordinary-review", true);
    const current = works.getWork(fixture.workId)!;
    assert.equal(current.criteria[0].status, "pending");
    unwrap(reviewWork(works, user, { kind: "accept_deliverable", request: { operationId: "ordinary:accept",
      workId: fixture.workId, deliverableId: fixture.deliverableId, versionGuard: guard(fixture.workId) } }));
    const request = { kind: "attest_criteria", request: { operationId: "ordinary:verify", workId: fixture.workId,
      inputSnapshotId: current.inputSnapshotId, criterionUpdates: [{ criterionId: current.criteria[0].id,
        status: "met", evidence: "Read the full result and checked every requested entry" }], versionGuard: guard(fixture.workId) } };
    assert.equal(reviewWork(works, user, { ...request, request: { ...request.request, inputSnapshotId: "wrong-input" } }).ok, false);
    assert.equal(reviewWork(works, user, { ...request, request: { ...request.request,
      criterionUpdates: [{ criterionId: current.criteria[0].id, status: "met", evidence: " " }] } }).ok, false);
    const verified = unwrap(reviewWork(works, user, request));
    assert.equal(verified.criteria[0].status, "satisfied");
    const evidence = works.repo.getEvidence(verified.criteria[0].evidenceRefs[0])!;
    assert.equal(evidence.kind, "user_attestation"); assert.equal(evidence.inputSnapshotId, current.inputSnapshotId);
    const retry = reviewWork(works, user, request); assert(retry.ok && retry.replayed);
    const closed = unwrap(reviewWork(works, user, { kind: "close", request: { operationId: "ordinary:close",
      workId: fixture.workId, conclusion: "succeeded", closureSummary: "Reviewed and verified current result",
      confirmed: true, versionGuard: guard(fixture.workId) } }));
    assert.equal(closed.lifecycle, "closed");
  });
  check("ordinary verification never substitutes for required real-environment feedback", () => {
    const fixture = proposed("real-review");
    const current = works.getWork(fixture.workId)!;
    const result = reviewWork(works, user, { kind: "attest_criteria", request: { operationId: "real:verify", workId: fixture.workId,
      inputSnapshotId: current.inputSnapshotId, criterionUpdates: [{ criterionId: current.criteria[0].id,
        status: "met", evidence: "The executor said it completed" }], versionGuard: guard(fixture.workId) } });
    assert.equal(result.ok, false); if (!result.ok) assert.equal(result.code, "unmet_acceptance_criteria");
    assert.equal(works.getWork(fixture.workId)?.criteria[0].status, "pending");
  });
  check("typed question reply retains its source, answer and evidence, without dispatch or accepting results", () => {
    const fixture = proposed("question-reply", true);
    unwrap(works.reportBlocker(user, { operationId: "question:report", workId: fixture.workId,
      reason: "Which report date should the summary cover?", userInput: { kind: "reply" }, waitingForUserInput: true }));
    const blocker = works.repo.listOpenBlockers(fixture.workId)[0];
    const request = { kind: "reply_user_input", request: { operationId: "question:reply", workId: fixture.workId,
      blockerId: blocker.blockerId, blockerSnapshot: userInputBlockerSnapshot(blocker),
      inputSnapshotId: works.getWork(fixture.workId)!.inputSnapshotId, reply: "Use November 8", evidenceRef: "User's reporting plan",
      versionGuard: guard(fixture.workId) } };
    const before = works.getWork(fixture.workId)!;
    assert.equal(reviewWork(works, fixture.worker, request).ok, false);
    assert.equal(reviewWork(works, { ...user, userId: "other" }, request).ok, false);
    assert.equal(reviewWork(works, user, { ...request, request: { ...request.request, reply: " " } }).ok, false);
    assert.equal(reviewWork(works, user, { ...request, request: { ...request.request, blockerSnapshot: "changed" } }).ok, false);
    assert.equal(reviewWork(works, user, { ...request, request: { ...request.request,
      versionGuard: { ...request.request.versionGuard, expectedStateVersion: before.stateVersion - 1 } } }).ok, false);
    const after = unwrap(reviewWork(works, user, request));
    assert.deepEqual(after.activeExecutionIds, before.activeExecutionIds);
    assert.deepEqual(after.criteria, before.criteria); assert.deepEqual(after.authorization, before.authorization);
    assert.equal(works.repo.getDeliverable(fixture.deliverableId)?.status, "proposed");
    const saved = works.repo.getBlocker(blocker.blockerId)!;
    assert.equal(saved.status, "cleared");
    assert.deepEqual(saved.details!.userInput, blocker.details!.userInput);
    assert.equal((saved.details!.response as { sourceSnapshot: string }).sourceSnapshot, request.request.blockerSnapshot);
    const evidenceCount = works.repo.listEvidence(fixture.workId).length;
    const retry = reviewWork(works, user, request); assert(retry.ok && retry.replayed);
    assert.equal(works.repo.listEvidence(fixture.workId).length, evidenceCount);
    const reopened = new WorkService(db.connection, { bots });
    assert.equal((reopened.getProjection(fixture.workId)!.blockers[0].details!.response as { reply: string }).reply, "Use November 8");
    assert.equal(reviewWork(works, user, { ...request, request: { ...request.request, reply: "Use another date" } }).ok, false);
  });
  check("unknown effects and untyped operational blockers cannot be force-cleared by a reply", () => {
    for (const kind of ["operational", "external_effect", "backpressure", "write_conflict"] as const) {
      const fixture = proposed(`blocked-${kind}`, true);
      unwrap(works.reportBlocker(user, { operationId: `report:${kind}`, workId: fixture.workId,
        reason: "Needs specialist reconciliation", kind, waitingForUserInput: true,
        unknownExternalEffectRef: kind === "external_effect" ? "effect" : undefined }));
      const blocker = works.repo.listBlockers(fixture.workId)[0];
      assert.equal(userInputBlockerSnapshot(blocker), undefined);
      assert.equal(reviewWork(works, user, { kind: "reply_user_input", request: { operationId: `reply:${kind}`, workId: fixture.workId,
        blockerId: blocker.blockerId, blockerSnapshot: "forged", inputSnapshotId: works.getWork(fixture.workId)!.inputSnapshotId,
        reply: "Force clear", evidenceRef: "none", versionGuard: guard(fixture.workId) } }).ok, false);
      assert.equal(works.repo.getBlocker(blocker.blockerId)?.status, kind === "external_effect" ? "cleared" : "open");
      if (kind === "external_effect") {
        assert.equal(blocker.unknownExternalEffectRef, "effect");
        assert.equal(blocker.details?.effectDisposition, "continue_without_replay");
      }
    }
  });
  check("a question from an old input cannot be answered using a fresh guard", () => {
    const fixture = proposed("stale-question", true);
    unwrap(works.reportBlocker(user, { operationId: "stale:report", workId: fixture.workId,
      reason: "Question about A", userInput: { kind: "reply" }, waitingForUserInput: true }));
    const blocker = works.repo.listOpenBlockers(fixture.workId)[0];
    unwrap(works.amendWork(user, { operationId: "stale:amend", workId: fixture.workId, inputSnapshotId: "input:B" }));
    const result = reviewWork(works, user, { kind: "reply_user_input", request: { operationId: "stale:reply", workId: fixture.workId,
      blockerId: blocker.blockerId, blockerSnapshot: userInputBlockerSnapshot(blocker), inputSnapshotId: "input:B",
      reply: "Old answer", evidenceRef: "Old record", versionGuard: guard(fixture.workId) } });
    assert.equal(result.ok, false); if (!result.ok) assert.equal(result.code, "version_conflict");
    assert.equal(works.repo.getBlocker(blocker.blockerId)?.status, "open");
  });
  const legacyQuestion = (suffix: string) => {
    const fixture = proposed(`legacy-${suffix}`, true);
    const current = works.getWork(fixture.workId)!;
    const owner: WorkActor = { kind: "bot", userId: LOCAL_USER_ID, botId: current.ownerBotId, host: "foreground", grants: DESKTOP_USER_GRANTS };
    unwrap(works.reportBlocker(owner, { operationId: `legacy:report:${suffix}`, workId: fixture.workId,
      reason: "Which reporting date should the summary use?", waitingForUserInput: true, versionGuard: guard(fixture.workId) }));
    const blocker = works.getProjection(fixture.workId)!.blockers[0];
    assert.ok(blocker.legacyUserInput, "an authentic uniquely identifiable report has host provenance");
    const request = { kind: "reply_legacy_user_input" as const, request: { operationId: `legacy:reply:${suffix}`, workId: fixture.workId,
      blockerId: blocker.blockerId, ...blocker.legacyUserInput, reply: "November 8", evidenceRef: "Reporting plan dated November 8",
      confirmedInformationOnly: true, versionGuard: guard(fixture.workId) } };
    // Projection-only identity metadata is not part of the decision wire schema.
    const { intentRevision: _intent, ownerEpoch: _owner, ...body } = request.request;
    return { fixture, blocker, owner, request: { ...request, request: body } };
  };
  check("legacy owner information report can be explicitly classified/replied and then successfully closed", () => {
    const { fixture, blocker, request } = legacyQuestion("close");
    const before = works.getWork(fixture.workId)!;
    assert.equal(reviewWork(works, fixture.worker, request).ok, false);
    assert.equal(reviewWork(works, { ...user, userId: "other" }, request).ok, false);
    assert.equal(reviewWork(works, user, { ...request, request: { ...request.request, confirmedInformationOnly: false } }).ok, false);
    assert.equal(reviewWork(works, user, { ...request, request: { ...request.request, evidenceRef: " " } }).ok, false);
    assert.equal(reviewWork(works, user, { ...request, request: { ...request.request, blockerSnapshot: "forged" } }).ok, false);
    assert.equal(reviewWork(works, user, { ...request, request: { ...request.request,
      versionGuard: { ...request.request.versionGuard, expectedStateVersion: before.stateVersion - 1 } } }).ok, false);
    const answered = unwrap(reviewWork(works, user, request));
    assert.deepEqual(answered.criteria, before.criteria); assert.deepEqual(answered.authorization, before.authorization);
    assert.deepEqual(answered.activeExecutionIds, before.activeExecutionIds);
    const saved = works.repo.getBlocker(blocker.blockerId)!;
    assert.equal(saved.status, "cleared");
    assert.equal((saved.details!.response as { reportOperationId: string }).reportOperationId, request.request.reportOperationId);
    assert.equal((saved.details!.response as { classification: string }).classification, "information_only");
    const evidenceCount = works.repo.listEvidence(fixture.workId).length;
    const reopened = new WorkService(db.connection, { bots });
    const replay = reviewWork(reopened, user, request); assert(replay.ok && replay.replayed);
    assert.equal(works.repo.listEvidence(fixture.workId).length, evidenceCount);
    assert.equal(reviewWork(works, user, { ...request, request: { ...request.request, reply: "Different" } }).ok, false);
    unwrap(reviewWork(works, user, { kind: "accept_deliverable", request: { operationId: "legacy:accept", workId: fixture.workId,
      deliverableId: fixture.deliverableId, versionGuard: guard(fixture.workId) } }));
    unwrap(reviewWork(works, user, { kind: "attest_criteria", request: { operationId: "legacy:attest", workId: fixture.workId,
      inputSnapshotId: before.inputSnapshotId, criterionUpdates: [{ criterionId: before.criteria[0].id, status: "met", evidence: "Checked original output" }],
      versionGuard: guard(fixture.workId) } }));
    const closed = unwrap(reviewWork(works, user, { kind: "close", request: { operationId: "legacy:close", workId: fixture.workId,
      conclusion: "succeeded", closureSummary: "Question answered and original result verified", confirmed: true, versionGuard: guard(fixture.workId) } }));
    assert.equal(closed.lifecycle, "closed");
  });
  check("legacy classification rejects forged/system metadata, machine references and unknown effects", () => {
    const { fixture, blocker, request } = legacyQuestion("excluded");
    const current = works.getWork(fixture.workId)!;
    for (const mutation of [ { reportedByBotId: undefined }, { reportedByBotId: "different-owner" },
      { blockerId: "approval:system" }, { reasonCode: "resource-recovery-exhausted" as const }, { unknownExternalEffectRef: "effect" },
      { details: { resource: "desktop" } }, { sourceRef: "source" }, { subscriptionId: "subscription" },
      { causalChainId: "chain" }, { reason: "Forged question" }, { createdAt: blocker.createdAt + 1 } ]) {
      assert.equal(legacyUserInputSource(db.connection, current, { ...blocker, ...mutation }), undefined);
    }
    db.connection.prepare("INSERT INTO work_action_admissions(admission_id,work_id,binding_id,operation_id,action_kind,state,intent_revision,owner_epoch,admitted_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(`machine-${randomUUID()}`, fixture.workId, works.repo.listBindings(fixture.workId)[0].bindingId,
        request.request.reportOperationId, "workspace:write", "released", current.intentRevision, current.ownerEpoch, blocker.createdAt);
    assert.equal(legacyUserInputSource(db.connection, current, blocker), undefined, "a real admission operation id is still a machine reference");
    assert.equal(reviewWork(works, user, request).ok, false);
    assert.equal(works.repo.getBlocker(blocker.blockerId)?.status, "open");
    const forged = { ...blocker, blockerId: `blocker-${randomUUID()}`, createdAt: blocker.createdAt + 5, legacyUserInput: undefined };
    works.repo.insertBlocker(forged);
    assert.equal(legacyUserInputSource(db.connection, current, forged), undefined, "owner-looking metadata alone never proves a report");
  });
  check("legacy report ambiguity is rejected for both duplicate rows and duplicate receipt candidates", () => {
    const first = legacyQuestion("duplicate-row");
    works.repo.insertBlocker({ ...first.blocker, blockerId: `blocker-${randomUUID()}`, legacyUserInput: undefined });
    assert.equal(legacyUserInputSource(db.connection, works.getWork(first.fixture.workId)!, first.blocker), undefined);
    assert.equal(reviewWork(works, user, first.request).ok, false);
    const second = legacyQuestion("duplicate-receipt");
    const timed = new WorkService(db.connection, { bots, now: () => second.blocker.createdAt });
    unwrap(timed.reportBlocker(second.owner, { operationId: "legacy:ambiguous", workId: second.fixture.workId,
      reason: second.blocker.reason, waitingForUserInput: true, versionGuard: guard(second.fixture.workId) }));
    // Even if only the original blocker remains, two valid hashes cannot uniquely
    // attribute it. Exercise receipt ambiguity independently of sibling checking.
    const duplicate = works.repo.listBlockers(second.fixture.workId).find(item => item.blockerId !== second.blocker.blockerId)!;
    db.connection.prepare("DELETE FROM work_blockers WHERE blocker_id=?").run(duplicate.blockerId);
    assert.equal(legacyUserInputSource(db.connection, works.getWork(second.fixture.workId)!, second.blocker), undefined);
    assert.equal(reviewWork(works, user, { ...second.request, request: { ...second.request.request, versionGuard: guard(second.fixture.workId) } }).ok, false);
  });
  check("legacy reports cannot be rebound after input, intent or owner changes even using a fresh guard", () => {
    for (const change of ["input", "intent", "owner"] as const) {
      const { fixture, blocker, request } = legacyQuestion(`changed-${change}`);
      if (change === "owner") {
        const botId = "legacy-new-owner";
        if (!bots.getBot(botId)) bots.registerBot({ botId, userId: LOCAL_USER_ID, displayName: "New owner", authorization: DESKTOP_USER_GRANTS });
        // Persist a later owner snapshot directly: this case tests provenance
        // identity, not the separately covered handoff authorization workflow.
        const current = works.getWork(fixture.workId)!;
        works.repo.updateWork({ ...current, ownerBotId: botId, ownerEpoch: current.ownerEpoch + 1, stateVersion: current.stateVersion + 1 });
      } else unwrap(works.amendWork(user, { operationId: `legacy:change:${change}`, workId: fixture.workId,
        ...(change === "input" ? { inputSnapshotId: "input:changed" } : { title: "Changed requirement" }) }));
      assert.equal(works.getProjection(fixture.workId)!.blockers[0].legacyUserInput, undefined);
      assert.equal(reviewWork(works, user, { ...request, request: { ...request.request, versionGuard: guard(fixture.workId) } }).ok, false);
      assert.equal(works.repo.getBlocker(blocker.blockerId)?.status, "open");
    }
  });
  console.log(`Bot Work review controls: ${count} passed`);
} finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
