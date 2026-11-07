import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkHostAuthority } from "../src/main/agent/work/WorkHostAuthority";
import { WorkService } from "../src/main/agent/work/WorkService";
import { ConversationGoalService, defaultBotActor } from "../src/main/agent/ConversationGoalService";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type CreateWorkParams, type WorkControlResult, type WorkActor } from "../src/shared/bot-work";

export function runWorkRegressions(): void {
  const root = mkdtempSync(join(tmpdir(), "bot-work-regressions-"));
  const dbPath = join(root, "work.db");
  let db = new AppDatabase(dbPath);
  let bots = new BotRegistry(db.connection);
  bots.ensureDefaultBot(LOCAL_USER_ID);
  const emitted: string[] = [];
  let service = new WorkService(db.connection, { bots, emitProjection: projection => emitted.push(projection.workId) });
  const actor: WorkActor = {
    kind: "user", userId: LOCAL_USER_ID, grants: {
      allowedScopes: ["workspace:read", "workspace:write"], targetWhitelist: [],
      allowGitBranchOrWorktree: false, allowRedelegation: false,
    },
  };
  let serial = 0;
  const op = () => `regression-${++serial}`;
  const unwrap = (result: WorkControlResult) => {
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    return result.work;
  };
  const create = (extra: Partial<CreateWorkParams> = {}) => unwrap(service.createWork(actor, {
    operationId: op(), title: "验收当前输入", inputSnapshotId: "input-A",
    authorization: actor.grants, criteria: [{ id: "check", text: "检查通过" }], ...extra,
  }));
  const dispatch = (workId: string, reserveTokens = 0) => {
    const operationId = op();
    const work = unwrap(service.dispatchExecution(actor, {
      workId, operationId, botId: DEFAULT_BOT_ID, taskId: operationId,
      durableStoreKey: operationId, conversationId: operationId, workspaceBinding: root, reserveTokens,
    }));
    const bindingId = work.activeExecutionIds.at(-1);
    assert.ok(bindingId);
    return bindingId;
  };
  try {
    let now = 1_000;
    const authority = new WorkHostAuthority(db.connection, "primary", 60_000, () => now);
    const contender = new WorkHostAuthority(db.connection, "contender", 60_000, () => now);
    mock.timers.enable({ apis: ["setInterval"] });
    try {
      assert.equal(authority.start().ok, true);
      for (let tick = 0; tick < 6; tick++) {
        now += 20_000;
        mock.timers.tick(20_000);
        assert.equal(authority.isAuthority(), true, "online host renews beyond its initial TTL");
        assert.equal(contender.acquire().ok, false, "another host cannot take a live lease");
      }
      authority.stop();
      assert.equal(authority.isAuthority(), false);
      assert.equal(contender.start().ok, true, "shutdown releases ownership");
      authority.stop();
      assert.equal(contender.isAuthority(), true, "old host cleanup cannot release the new lease");
    } finally {
      authority.stop();
      contender.stop();
      mock.timers.reset();
    }

    const inflight = create();
    const beforeRollback = emitted.length;
    assert.throws(() => service.transaction(() => {
      unwrap(service.amendWork(actor, { operationId: "rolled-back-amend", workId: inflight.workId, title: "未提交的标题" }));
      throw new Error("rollback boundary");
    }), /rollback boundary/);
    assert.equal(service.getWork(inflight.workId)?.title, inflight.title);
    assert.equal(service.repo.getReceipt(LOCAL_USER_ID, "rolled-back-amend"), undefined);
    assert.equal(emitted.length, beforeRollback, "uncommitted result does not escape as a UI fact");

    bots.registerBot({ botId: "unrelated-local-bot", userId: LOCAL_USER_ID, displayName: "另一位 Bot" });
    const paused = unwrap(service.pauseWork(actor, { operationId: "owner-pause", workId: inflight.workId }));
    const unauthorizedReplay = service.pauseWork(defaultBotActor("unrelated-local-bot"), {
      operationId: "owner-pause", workId: inflight.workId,
    });
    assert.equal(unauthorizedReplay.ok, false, "another bot cannot replay an owner's receipt");
    unwrap(service.resumeWork(actor, { operationId: op(), workId: paused.workId }));

    const goals = new ConversationGoalService(service, () => {});
    const goal = goals.create({ taskId: "guarded-conversation", title: "模型控制必须携带版本" });
    assert.equal(goal.ok, true);
    if (goal.ok) {
      assert.equal(goals.update({ goalId: goal.goal.id, progressSummary: "缺少版本" }, { actor: defaultBotActor() }).ok, false,
        "Goal adapter cannot manufacture a current guard for a model");
    }
    const liveBinding = dispatch(inflight.workId);
    assert.equal(service.markDispatchAttempt(liveBinding, "native-attempt").ok, true);
    assert.equal(service.recordSubmissionReceipt(liveBinding, "native-receipt").ok, true);
    unwrap(service.amendWork(actor, { operationId: op(), workId: inflight.workId, constraints: ["仅检查 Linux"] }));
    const invalidated = service.repo.getBinding(liveBinding);
    assert.equal(invalidated?.status, "submitted", "requirement invalidation does not invent a stop receipt");
    assert.equal(invalidated?.settledAt, undefined);
    assert.ok(invalidated?.invalidatedAt);
    const cancelling = unwrap(service.cancelWork(actor, { operationId: op(), workId: inflight.workId }));
    assert.equal(cancelling.lifecycle, "closing");
    const stopped = unwrap(service.reconcileExecution(actor, { bindingId: liveBinding, outcome: "stopped" }));
    assert.equal(stopped.lifecycle, "closed", "only the native stop read-back settles the work");

    const feedback = create({ inputSnapshotId: "input-B", criteria: [{ id: "real", text: "Omarchy 实测", requiresRealEnvironmentCheck: true, requiredEnvironment: "Omarchy" }] });
    const missingSnapshot = service.recordUserFeedback(actor, {
      operationId: op(), workId: feedback.workId, criterionIds: ["real"], environment: "Omarchy",
      sourceRef: "commit-A", sourceSha: "sha-A", inputSnapshotId: "", failed: false,
    });
    assert.equal(missingSnapshot.ok, false, "feedback must identify the tested snapshot");
    assert.equal(service.getWork(feedback.workId)?.criteria[0]?.status, "pending");
    unwrap(service.recordUserFeedback(actor, {
      operationId: op(), workId: feedback.workId, criterionIds: ["real"], environment: "Omarchy",
      sourceRef: "commit-A", inputSnapshotId: "input-A", failed: false,
    }));
    assert.equal(service.getWork(feedback.workId)?.criteria[0]?.status, "pending", "late A evidence cannot verify B");
    unwrap(service.recordUserFeedback(actor, {
      operationId: op(), workId: feedback.workId, criterionIds: ["real"], environment: "Omarchy",
      sourceRef: "commit-B", inputSnapshotId: "input-B", failed: false,
    }));
    assert.equal(service.getWork(feedback.workId)?.criteria[0]?.status, "satisfied");
    const sourceOnly = service.amendWork(actor, {
      operationId: op(), workId: feedback.workId,
      goalSources: [{ sourceType: "git_commit", sourceRef: "commit-C", inputSnapshotId: "input-C", observedAt: Date.now() }],
    });
    assert.equal(sourceOnly.ok, false, "new source cannot silently retain the previous target identity");
    unwrap(service.amendWork(actor, { operationId: op(), workId: feedback.workId, inputSnapshotId: "input-C" }));
    assert.equal(service.getWork(feedback.workId)?.criteria[0]?.status, "pending");

    const budget = create({ budget: { maxTokens: 100 } });
    const budgetBinding = dispatch(budget.workId, 80);
    assert.equal(service.getWork(budget.workId)?.budget.reservedTokens, 80);
    const denied = service.dispatchExecution(actor, {
      operationId: op(), workId: budget.workId, botId: DEFAULT_BOT_ID, taskId: "over-budget",
      durableStoreKey: "over-budget", conversationId: "over-budget", workspaceBinding: root, reserveTokens: 80,
    });
    assert.equal(denied.ok, false, "concurrent executions share one budget");
    assert.equal(service.repo.listReservations(budget.workId).length, 1);
    const reservation = service.repo.listReservations(budget.workId)[0];
    assert.ok(reservation);
    unwrap(service.reconcileExecution(actor, { bindingId: budgetBinding, outcome: "completed", usageTokens: 90, reservationId: reservation.reservationId }));
    assert.equal(service.getWork(budget.workId)?.budget.usedTokens, 90, "actual usage is not clamped to the estimate or overwritten");
    unwrap(service.reconcileExecution(actor, { bindingId: budgetBinding, outcome: "completed", usageTokens: 90, reservationId: reservation.reservationId }));
    assert.equal(service.getWork(budget.workId)?.budget.usedTokens, 90, "repeated settlement does not charge twice");
    assert.equal(service.getWork(budget.workId)?.budget.reservedTokens, 0);

    const unknownBudget = create({ budget: { maxTokens: 100 } });
    assert.equal(service.reserveBudget(unknownBudget.workId, "unknown-reservation", 80).ok, true);
    assert.equal(service.commitBudgetUsage(unknownBudget.workId, "unknown-reservation").ok, true);
    assert.equal(service.commitBudgetUsage(unknownBudget.workId, "unknown-reservation").ok, true);
    assert.equal(service.getWork(unknownBudget.workId)?.budget.unknownUsageCount, 1);
    assert.equal(service.getWork(unknownBudget.workId)?.budget.reservedTokens, 80, "unknown usage retains its allocation");
    assert.equal(service.reserveBudget(unknownBudget.workId, "next-reservation", 80).ok, false);

    const notificationWork = create({ criteria: [] });
    unwrap(service.closeWork(actor, { operationId: op(), workId: notificationWork.workId, conclusion: "succeeded" }));
    let effects = 0;
    const crashChannel = {
      channel: "no-idempotency", idempotent: false,
      send: (): never => { effects++; throw new Error("external send succeeded; response not persisted"); },
    };
    service.deliverPendingNotifications(crashChannel, notificationWork.workId);
    assert.equal(service.repo.listNotifications(notificationWork.workId)[0]?.delivery, "unknown");
    db.close();
    db = new AppDatabase(dbPath);
    bots = new BotRegistry(db.connection);
    service = new WorkService(db.connection, { bots });
    service.deliverPendingNotifications(crashChannel, notificationWork.workId);
    assert.equal(effects, 1, "reopening storage does not blindly resend a possibly delivered notification");
    assert.equal(service.repo.listNotifications(notificationWork.workId)[0]?.delivery, "unknown");
    service.deliverPendingNotifications({ ...crashChannel, idempotent: true, lookup: () => "delivered" }, notificationWork.workId);
    assert.equal(effects, 1, "read-back recovers delivery without another send");
    assert.equal(service.repo.listNotifications(notificationWork.workId)[0]?.delivery, "sent");

    const staleNotice = create();
    const staleBinding = dispatch(staleNotice.workId);
    unwrap(service.submitDeliverable({ kind: "worker", botId: DEFAULT_BOT_ID, bindingId: staleBinding }, {
      operationId: op(), workId: staleNotice.workId, bindingId: staleBinding, deliverableId: "notice-A", summary: "A 的成果",
    }));
    unwrap(service.acceptDeliverable(actor, { operationId: op(), workId: staleNotice.workId, deliverableId: "notice-A" }));
    unwrap(service.amendWork(actor, { operationId: op(), workId: staleNotice.workId, inputSnapshotId: "input-B" }));
    const superseded = service.repo.listNotifications(staleNotice.workId)[0];
    assert.equal(superseded?.delivery, "pending", "semantic invalidation is separate from a failed external send");
    assert.equal(service.notifications.identity(superseded!.notificationId)?.semanticValidity, "superseded", "source-only change invalidates an unsent A notification");
    assert.equal(superseded?.readAt, undefined, "invalidating a notification does not pretend the user read it");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}
