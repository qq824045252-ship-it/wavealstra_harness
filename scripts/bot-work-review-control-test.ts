import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService } from "../src/main/agent/work/WorkService";
import { WorkHostAuthority } from "../src/main/agent/work/WorkHostAuthority";
import {
  DEFAULT_BOT_ID, LOCAL_USER_ID, type CreateWorkParams, type WorkActor,
  type WorkControlResult, type WorkDto,
} from "../src/shared/bot-work";

const root = mkdtempSync(join(tmpdir(), "bot-work-review-control-"));
const db = new AppDatabase(join(root, "work.db"));
const bots = new BotRegistry(db.connection);
bots.ensureDefaultBot(LOCAL_USER_ID);
const service = new WorkService(db.connection, { bots });
const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants: {
  allowedScopes: ["workspace:read", "workspace:write"], targetWhitelist: [],
  allowGitBranchOrWorktree: false, allowRedelegation: true,
} };
let serial = 0;
const operation = () => `review-control-${++serial}`;
const unwrap = (result: WorkControlResult): WorkDto => {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.work;
};
const create = (extra: Partial<CreateWorkParams> = {}) => unwrap(service.createWork(user, {
  operationId: operation(), title: "检查当前输入", inputSnapshotId: "input-A",
  criteria: [{ id: "check", text: "验证已完成" }], authorization: user.grants, ...extra,
}));
const dispatch = (workId: string, botId = DEFAULT_BOT_ID, delegatedScope?: string[]) => {
  const operationId = operation();
  const work = unwrap(service.dispatchExecution(user, {
    operationId, workId, botId, taskId: operationId, durableStoreKey: operationId,
    conversationId: operationId, workspaceBinding: root, delegatedScope,
  }));
  const bindingId = work.activeExecutionIds.at(-1);
  assert.ok(bindingId);
  return service.repo.getBinding(bindingId)!;
};
const worker = (binding: ReturnType<typeof dispatch>): WorkActor => ({
  kind: "worker", botId: binding.botId, bindingId: binding.bindingId,
});

const failures: string[] = [];
let passed = 0;
function check(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}`, error); }
}

try {
  for (const change of ["source", "intent"] as const) {
    check(`an accepted ${change === "source" ? "old-input" : "old-requirement"} result stays historical`, () => {
      const work = create();
      const binding = dispatch(work.workId);
      const deliverableId = operation();
      unwrap(service.submitDeliverable(worker(binding), {
        operationId: operation(), workId: work.workId, bindingId: binding.bindingId,
        deliverableId, summary: "旧版本已确认的有效部分", uncoveredScope: ["旧版本尚未核验的细节"],
      }));
      unwrap(service.acceptDeliverable(user, { operationId: operation(), workId: work.workId, deliverableId }));
      unwrap(service.reconcileExecution(user, { bindingId: binding.bindingId, outcome: "completed" }));
      const accepted = service.repo.getDeliverable(deliverableId)!;
      assert.equal(accepted.status, "accepted");
      const next = unwrap(service.amendWork(user, {
        operationId: operation(), workId: work.workId,
        ...(change === "source" ? { inputSnapshotId: "input-B" } : { constraints: ["按新的限定范围检查"] }),
      }));
      assert.deepEqual(next.acceptedDeliverableIds, [], "current acceptance cannot carry an old target result");
      const historical = service.repo.getDeliverable(deliverableId)!;
      assert.equal(historical.status, "accepted", "historical acceptance is not rewritten");
      assert.equal(historical.reviewedAt, accepted.reviewedAt, "the prior review remains auditable");
      assert.equal(historical.summary, accepted.summary, "the historical result is not deleted");
      const projection = service.getProjection(work.workId)!;
      assert.deepEqual(projection.acceptedDeliverableIds, []);
      assert.deepEqual(projection.uncoveredScope, [], "old result gaps do not become the current target's gaps");
      assert.ok(projection.nextSteps.includes("安排后台执行"), "historical execution does not satisfy current execution needs");
    });
  }

  check("a source-only change supersedes pending results without changing intent", () => {
    const work = create();
    const binding = dispatch(work.workId);
    const deliverableId = operation();
    unwrap(service.submitDeliverable(worker(binding), {
      operationId: operation(), workId: work.workId, bindingId: binding.bindingId,
      deliverableId, summary: "待核验的 A 结果",
    }));
    const next = unwrap(service.amendWork(user, { operationId: operation(), workId: work.workId, inputSnapshotId: "input-B" }));
    assert.equal(next.intentRevision, work.intentRevision);
    assert.equal(service.repo.getDeliverable(deliverableId)?.status, "superseded");
  });

  check("progress and handoff preserve current results; explicit invalidation keeps late results historical", () => {
    const work = create();
    const binding = dispatch(work.workId);
    const deliverableId = operation();
    unwrap(service.submitDeliverable(worker(binding), {
      operationId: operation(), workId: work.workId, bindingId: binding.bindingId,
      deliverableId, summary: "仍符合当前要求的成果",
    }));
    unwrap(service.acceptDeliverable(user, { operationId: operation(), workId: work.workId, deliverableId }));
    unwrap(service.reconcileExecution(user, { bindingId: binding.bindingId, outcome: "completed" }));
    const progress = unwrap(service.amendWork(user, { operationId: operation(), workId: work.workId, progressSummary: "已读进展" }));
    assert.deepEqual(progress.acceptedDeliverableIds, [deliverableId]);
    const targetBotId = "review-handoff-owner";
    bots.registerBot({ botId: targetBotId, userId: LOCAL_USER_ID, displayName: "新负责人", authorization: user.grants });
    const handedOff = unwrap(service.handoffOwner(user, { operationId: operation(), workId: work.workId, targetBotId }));
    assert.deepEqual(handedOff.acceptedDeliverableIds, [deliverableId], "ownerEpoch alone does not discard valid results");
    const invalidated = unwrap(service.amendWork(user, {
      operationId: operation(), workId: work.workId, invalidateExecutionIds: [binding.bindingId],
    }));
    assert.deepEqual(invalidated.acceptedDeliverableIds, []);
    assert.equal(service.repo.getDeliverable(deliverableId)?.status, "accepted");
    const lateId = operation();
    unwrap(service.submitDeliverable(worker(binding), {
      operationId: operation(), workId: work.workId, bindingId: binding.bindingId,
      deliverableId: lateId, summary: "失效执行的迟到结果",
    }));
    assert.equal(service.repo.getDeliverable(lateId)?.status, "superseded");
  });

  check("worker identity always binds action admission to its persisted execution", () => {
    const work = create();
    const binding = dispatch(work.workId, DEFAULT_BOT_ID, ["workspace:read"]);
    // 负责人自己的 Work 不再被退役的 Work 动作 scope 拦住（历史只读授权照常执行）。
    const ownerWrite = service.admitNewAction(worker(binding), {
      admissionId: operation(), operationId: operation(), workId: work.workId, actionKind: "workspace:write",
    });
    assert.equal(ownerWrite.ok, true, "the owner Work is not gated by the retired action scope");
    const allowed = service.admitNewAction(worker(binding), {
      admissionId: operation(), operationId: operation(), workId: work.workId, actionKind: "workspace:read",
    });
    assert.equal(allowed.ok, true);
    if (allowed.ok) assert.equal(allowed.admission.bindingId, binding.bindingId, "omitting payload bindingId uses the persisted binding");
    // 其他 Bot 的只读委派范围仍是真实的团队成员边界。
    bots.registerBot({ botId: "bot-member", userId: LOCAL_USER_ID, displayName: "Member",
      authorization: { allowedScopes: ["workspace:read"], targetWhitelist: [], allowGitBranchOrWorktree: false, allowRedelegation: false } });
    const member = dispatch(work.workId, "bot-member", ["workspace:read"]);
    const memberWrite = service.admitNewAction(worker(member), {
      admissionId: operation(), operationId: operation(), workId: work.workId, actionKind: "workspace:write",
    });
    assert.equal(memberWrite.ok, false, "a read-only member bot stays read-only");
    unwrap(service.amendWork(user, { operationId: operation(), workId: work.workId, inputSnapshotId: "input-B" }));
    const stale = service.admitNewAction(worker(binding), {
      admissionId: operation(), operationId: operation(), workId: work.workId, actionKind: "workspace:read",
    });
    assert.equal(stale.ok, false, "an old execution cannot admit actions against the new input");
  });

  check("a delegated worker cannot create an independent long-lived Work", () => {
    const work = create({ authorization: { ...user.grants!, allowRedelegation: false } });
    const binding = dispatch(work.workId);
    const workCount = service.listWorks(LOCAL_USER_ID).length;
    const receiptCount = service.repo.countReceiptsForUser(LOCAL_USER_ID);
    const denied = service.createWork(worker(binding), {
      operationId: operation(), title: "执行者自行发起的新责任", ownerBotId: DEFAULT_BOT_ID,
      inputSnapshotId: "another-input",
    });
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.code, "unauthorized_actor");
    assert.equal(service.listWorks(LOCAL_USER_ID).length, workCount);
    assert.equal(service.repo.countReceiptsForUser(LOCAL_USER_ID), receiptCount);
    const foreground: WorkActor = { kind: "bot", botId: DEFAULT_BOT_ID, userId: LOCAL_USER_ID, host: "foreground", grants: user.grants };
    assert.equal(unwrap(service.createWork(foreground, {
      operationId: operation(), title: "前台在受理边界创建的责任", inputSnapshotId: "foreground-input",
    })).createdBy, "bot", "a host-authenticated foreground Bot retains creation authority");
  });

  check("same-millisecond task reuse resolves the most recently committed execution", () => {
    const timed = new WorkService(db.connection, { bots, now: () => 5_000 });
    const work = unwrap(timed.createWork(user, {
      operationId: operation(), title: "连续执行的绑定顺序", inputSnapshotId: "input-A", authorization: user.grants,
    }));
    const taskId = operation();
    const namespace = { workId: work.workId, botId: DEFAULT_BOT_ID, taskId,
      durableStoreKey: taskId, conversationId: taskId, workspaceBinding: root };
    const firstId = operation();
    const first = unwrap(timed.dispatchExecution(user, { ...namespace, operationId: firstId }));
    const firstBinding = timed.repo.getBindingByOperation(work.workId, firstId)!;
    unwrap(timed.reconcileExecution(user, { bindingId: firstBinding.bindingId, outcome: "completed" }));
    const secondId = operation();
    unwrap(timed.dispatchExecution(user, { ...namespace, operationId: secondId }));
    const latest = timed.repo.bindingForTask(taskId)!;
    assert.equal(latest.admittedAt, firstBinding.admittedAt, "timestamps deliberately share one clock tick");
    assert.equal(latest.operationId, secondId);
    assert.notEqual(latest.bindingId, first.activeExecutionIds[0]);
    assert.equal(timed.checkTaskInput(taskId, secondId), undefined);
    assert.notEqual(timed.checkTaskInput(taskId, firstId), undefined);
  });

  check("disabling a worker rejects new actions but preserves result settlement", () => {
    const botId = "review-disabled-worker";
    bots.registerBot({ botId, userId: LOCAL_USER_ID, displayName: "执行者" });
    const work = create();
    const binding = dispatch(work.workId, botId);
    service.markDispatchAttempt(binding.bindingId, "attempt");
    bots.disableBot(botId);
    assert.notEqual(service.admitTaskAction(binding.taskId, {
      operationId: operation(), actionKind: "workspace:write",
    }), undefined, "disabling the execution bot blocks further tools as well as fresh dispatch");
    const deliverableId = operation();
    unwrap(service.submitDeliverable(worker(binding), {
      operationId: operation(), workId: work.workId, bindingId: binding.bindingId,
      deliverableId, summary: "停用前已完成的效果",
    }));
    unwrap(service.reconcileExecution(worker(binding), { bindingId: binding.bindingId, outcome: "stopped" }));
    assert.ok(service.repo.getDeliverable(deliverableId), "already-admitted work remains available for settlement");
  });

  check("lease handoff before transaction admission cannot commit old-host controls", () => {
    const otherDb = new AppDatabase(join(root, "work.db"));
    let now = 1_000;
    const primary = new WorkHostAuthority(db.connection, "review-primary", 60, () => now);
    const contender = new WorkHostAuthority(otherDb.connection, "review-contender", 60, () => now);
    let takeOverBeforeWrite = false;
    const guarded = new WorkService(db.connection, { bots, isAuthority: () => {
      const observed = primary.isAuthority();
      if (takeOverBeforeWrite) {
        takeOverBeforeWrite = false;
        now += 100;
        assert.equal(contender.acquire().ok, true, "second connection acquires the expired lease before the old host begins its write");
      }
      return observed;
    } });
    const armTakeover = () => {
      now += 100;
      assert.equal(primary.acquire().ok, true);
      takeOverBeforeWrite = true;
    };
    try {
      const work = create();
      const binding = dispatch(work.workId);
      const workCount = service.listWorks(LOCAL_USER_ID).length;
      armTakeover();
      const created = guarded.createWork(user, { operationId: operation(), title: "不能由旧宿主创建" });
      assert.equal(created.ok, false);
      assert.equal(service.listWorks(LOCAL_USER_ID).length, workCount);
      armTakeover();
      const pauseId = operation();
      assert.equal(guarded.pauseWork(user, { operationId: pauseId, workId: work.workId }).ok, false);
      assert.equal(service.getWork(work.workId)?.lifecycle, "active");
      assert.equal(service.repo.getReceipt(LOCAL_USER_ID, pauseId), undefined);
      armTakeover();
      assert.equal(guarded.admitNewAction(worker(binding), {
        admissionId: operation(), operationId: operation(), workId: work.workId, actionKind: "workspace:read",
      }).ok, false);
      assert.deepEqual(service.repo.listAdmissions(work.workId), []);
    } finally {
      primary.stop();
      contender.stop();
      otherDb.close();
    }
  });

  check("expired authorization can only be renewed by an explicit current user grant", () => {
    let now = 10_000;
    const timed = new WorkService(db.connection, { bots, now: () => now });
    const created = unwrap(timed.createWork(user, {
      operationId: operation(), title: "需要续权的事项", inputSnapshotId: "input-A",
      authorization: { ...user.grants, expiresAt: now + 100 },
    }));
    const dispatchId = operation();
    const dispatched = unwrap(timed.dispatchExecution(user, {
      operationId: dispatchId, workId: created.workId, botId: DEFAULT_BOT_ID, taskId: dispatchId,
      durableStoreKey: dispatchId, conversationId: dispatchId, workspaceBinding: root,
    }));
    const execution = timed.repo.getBinding(dispatched.activeExecutionIds[0])!;
    unwrap(timed.pauseWork(user, { operationId: operation(), workId: created.workId }));
    now += 200;
    const before = timed.getWork(created.workId)!;
    assert.equal(timed.amendWork(user, { operationId: operation(), workId: created.workId, title: "不能隐式续权" }).ok, false);
    const model: WorkActor = { kind: "bot", botId: DEFAULT_BOT_ID, userId: LOCAL_USER_ID, host: "foreground", grants: user.grants };
    assert.equal(timed.amendWork(model, {
      operationId: operation(), workId: created.workId, authorization: { expiresAt: now + 1_000 },
      versionGuard: { expectedStateVersion: before.stateVersion, expectedIntentRevision: before.intentRevision, expectedOwnerEpoch: before.ownerEpoch },
    }).ok, false, "a model cannot prolong its own delegation");
    assert.equal(timed.amendWork(worker(execution), {
      operationId: operation(), workId: created.workId, authorization: { expiresAt: now + 1_000 },
    }).ok, false, "a worker cannot prolong its own execution authorization");
    assert.equal(timed.amendWork(user, {
      operationId: operation(), workId: created.workId, authorization: { allowedScopes: ["workspace:read"] },
    }).ok, false, "changing a scope without renewing the deadline is insufficient");
    const expiredGrant: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants: { ...user.grants!, expiresAt: now - 1 } };
    assert.equal(timed.amendWork(expiredGrant, {
      operationId: operation(), workId: created.workId, authorization: { expiresAt: now + 1_000 },
    }).ok, false, "an expired host grant cannot authorize a fresh Work deadline");
    assert.deepEqual(timed.getWork(created.workId), before, "denied renewal paths leave control facts untouched");
    const currentGrant: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants: {
      ...user.grants!, allowedScopes: ["workspace:read"], expiresAt: now + 500,
    } };
    const operationId = operation();
    const authorization = { expiresAt: now + 1_000, allowedScopes: ["workspace:read", "workspace:write"], allowGitBranchOrWorktree: true };
    const renewed = unwrap(timed.amendWork(currentGrant, { operationId, workId: created.workId, authorization }));
    assert.equal(renewed.authorization.expiresAt, now + 500, "renewal is capped by the current authenticated grant");
    assert.deepEqual(renewed.authorization.allowedScopes, ["workspace:read"]);
    assert.equal(renewed.authorization.allowGitBranchOrWorktree, false);
    assert.equal(renewed.intentRevision, before.intentRevision + 1, "renewal is a recorded intent/authorization revision");
    const replay = timed.amendWork(currentGrant, { operationId, workId: created.workId, authorization });
    assert.equal(replay.ok && replay.replayed, true);
    assert.equal(unwrap(timed.resumeWork(currentGrant, { operationId: operation(), workId: created.workId })).lifecycle, "active");
  });
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}
assert.deepEqual(failures, [], `${failures.length} review regressions failed`);
console.log(`Bot Work review control: ${passed} passed`);
