import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { DESKTOP_USER_GRANTS, WorkService } from "../src/main/agent/work/WorkService";
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
function proposed(suffix: string) {
  const work = unwrap(works.createWork(user, { operationId: `create:${suffix}`, title: suffix, authorization: DESKTOP_USER_GRANTS,
    inputSnapshotId: `input:${suffix}`, criteria: [{ text: "User verifies this output", requiredEnvironment: "Fixture OS" }] }));
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
  console.log(`Bot Work review controls: ${count} passed`);
} finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
