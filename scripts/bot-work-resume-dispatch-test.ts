import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSubmissionReceipt } from "../src/shared/agent-ipc";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkControlResult, type WorkDto } from "../src/shared/bot-work";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { WorkDispatchQueue } from "../src/main/agent/work/WorkDispatchQueue";
import { WorkExecutionAdapter, type WorkExecutionObservation, type WorkExecutionPort } from "../src/main/agent/work/WorkExecutionAdapter";

const unwrap = (result: WorkControlResult) => {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.work;
};
const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS };
const root = await mkdtemp(join(tmpdir(), "bot-work-resume-dispatch-"));

async function fixture(name: string, status: WorkExecutionObservation["status"] = "completed") {
  const databasePath = join(root, `${name}.db`);
  const db = new AppDatabase(databasePath);
  const bots = new BotRegistry(db.connection);
  bots.registerBot({ botId: DEFAULT_BOT_ID, userId: LOCAL_USER_ID, displayName: "fixture", authorization: DESKTOP_USER_GRANTS });
  const works = new WorkService(db.connection, { bots });
  const receipts = new Map<string, AgentSubmissionReceipt>();
  const observations = new Map<string, WorkExecutionObservation>();
  const effectsPath = join(root, `${name}-effects.txt`);
  const errors: unknown[] = [];
  const preparedTasks: string[] = [];
  let prepareWait: Promise<void> = Promise.resolve();
  let stopWait: Promise<void> = Promise.resolve();
  let stopStarted = () => {};
  const observation = (): WorkExecutionObservation => status === "running" ? { status }
    : { status, summary: `${name} retained result`, hasWriteConflicts: false, artifactRefs: [effectsPath], usageTokens: 2 };
  const native: WorkExecutionPort = {
    prepare: async taskId => { preparedTasks.push(taskId); await prepareWait; return { taskId, durableStoreKey: `store:${taskId}`, conversationId: "1", workspaceBinding: root }; },
    find: async binding => receipts.get(binding.bindingId),
    submit: async binding => {
      const blocked = works.checkTaskInput(binding.taskId, binding.operationId);
      if (blocked) throw new Error(blocked);
      const existing = receipts.get(binding.bindingId);
      if (existing) return existing;
      // This deterministic native port records a real append per logical execution.
      // Allocating another task/store would therefore repeat the business effect.
      appendFileSync(effectsPath, `${binding.operationId}\n`);
      const receipt: AgentSubmissionReceipt = { taskId: binding.taskId, operationId: binding.operationId, submissionId: 1, status: "done" };
      receipts.set(binding.bindingId, receipt); observations.set(binding.bindingId, observation());
      return receipt;
    },
    inspect: async binding => observations.get(binding.bindingId)!,
    stop: async binding => {
      stopStarted(); await stopWait;
      observations.set(binding.bindingId, { status: "stopped", summary: "stopped after original effect", hasWriteConflicts: false, artifactRefs: [effectsPath], usageTokens: 2 });
    },
  };
  const adapter = new WorkExecutionAdapter(works, native, LOCAL_USER_ID, () => true, (_id, error) => errors.push(error));
  const queue = new WorkDispatchQueue(db, works, adapter, () => true, () => "fixture");
  const schedule = (work: WorkDto, operationId: string, retryBlocked = false) => works.transaction(() => queue.enqueue(work, operationId, retryBlocked));
  const create = (id: string) => {
    const work = unwrap(works.createWork(user, { operationId: `${name}:${id}:create`, title: id, inputSnapshotId: `${name}:${id}:input`,
      authorization: DESKTOP_USER_GRANTS, criteria: [{ text: "independently verify the saved result" }] }));
    schedule(work, `${name}:${id}:schedule`);
    return work;
  };
  const resume = (work: WorkDto, id: string) => {
    unwrap(works.pauseWork(user, { workId: work.workId, operationId: `${name}:${id}:pause` }));
    const resumed = unwrap(works.resumeWork(user, { workId: work.workId, operationId: `${name}:${id}:resume` }));
    schedule(resumed, `${name}:${id}:resume`, true);
    return resumed;
  };
  const effects = () => existsSync(effectsPath) ? readFileSync(effectsPath, "utf8").trim().split("\n").length : 0;
  return { db, databasePath, native, preparedTasks, works, adapter, queue, create, schedule, resume, effects, errors, observations,
    holdPrepare: (promise: Promise<void>) => { prepareWait = promise; },
    holdStop: (promise: Promise<void>, onStarted: () => void) => { stopWait = promise; stopStarted = onStarted; },
    close: async () => { await queue.close(); await adapter.close(); db.close(); } };
}

try {
  // A duplicate intent persisted before a crash must pass dedupe again during recovery.
  {
    const f = await fixture("persisted-duplicate");
    try {
      const work = f.create("original"); await f.queue.flush();
      const original = f.works.repo.listBindings(work.workId)[0]!;
      f.works.transaction(() => {
        f.db.upsertTask({ id: "persisted-duplicate-root", title: "redundant pending intent", updatedAt: Date.now() });
        f.db.connection.prepare(`INSERT INTO work_dispatch_requests(operation_id,work_id,task_id,bot_id,intent_revision,input_snapshot_id,state,created_at)
          VALUES (?,?,?,?,?,?,'pending',?)`).run("persisted-duplicate-request", work.workId, "persisted-duplicate-root", DEFAULT_BOT_ID, work.intentRevision, work.inputSnapshotId, Date.now());
      });
      await f.queue.close(); await f.adapter.close();
      const reopened = new AppDatabase(f.databasePath);
      const works = new WorkService(reopened.connection, { bots: new BotRegistry(reopened.connection) });
      const adapter = new WorkExecutionAdapter(works, f.native, LOCAL_USER_ID, () => true, (_id, error) => f.errors.push(error));
      const queue = new WorkDispatchQueue(reopened, works, adapter, () => true, () => "fixture");
      try {
        await queue.flush();
        assert.equal(f.effects(), 1, "recovered duplicate pending request must not repeat completed effects");
        assert.equal(f.preparedTasks.length, 1, "duplicate recovery must not even prepare another native root");
        assert.equal(works.repo.listBindings(work.workId).length, 1);
        assert.deepEqual(reopened.connection.prepare("SELECT state FROM work_dispatch_requests WHERE operation_id=?").get("persisted-duplicate-request"), { state: "cancelled" });
        // Losing the acknowledgement for the original request still recovers that exact binding.
        reopened.connection.prepare("UPDATE work_dispatch_requests SET state='pending' WHERE task_id=?").run(original.taskId);
        await queue.flush();
        assert.deepEqual(reopened.connection.prepare("SELECT state FROM work_dispatch_requests WHERE task_id=?").get(original.taskId), { state: "dispatched" });
        assert.equal(f.effects(), 1); assert.equal(works.repo.listBindings(work.workId)[0]!.bindingId, original.bindingId);
        assert.deepEqual(f.errors, []);
      } finally { await queue.close(); await adapter.close(); reopened.close(); }
    } finally { await f.close(); }
  }

  // Invalidating a finished result is not permission to repeat its already executed input.
  {
    const f = await fixture("invalidated-result");
    try {
      const work = f.create("original"); await f.queue.flush();
      const original = f.works.repo.listBindings(work.workId)[0]!;
      const invalidated = unwrap(f.works.amendWork(user, { workId: work.workId, operationId: "invalidated-result:amend", invalidateExecutionIds: [original.bindingId] }));
      assert.equal(invalidated.intentRevision, work.intentRevision); assert.equal(invalidated.inputSnapshotId, work.inputSnapshotId);
      assert.notEqual(f.works.repo.getBinding(original.bindingId)?.invalidatedAt, undefined);
      f.schedule(invalidated, "invalidated-result:reschedule"); f.resume(invalidated, "resume"); await f.queue.flush();
      assert.equal(f.effects(), 1, "invalidating prior results must not erase execution dedupe");
      assert.equal(f.works.repo.listBindings(work.workId).length, 1); assert.equal(f.db.listTasks().length, 1);
      assert.equal(f.works.repo.getBlocker(`continuation:${original.bindingId}`)?.status, "open");
      const cancelled = unwrap(f.works.cancelWork(user, { workId: work.workId, operationId: "invalidated-result:cancel" }));
      assert.equal(cancelled.lifecycle, "closed"); assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }

  for (const status of ["completed", "failed", "stopped"] as const) {
    const f = await fixture(status, status);
    try {
      const work = f.create("original"); await f.queue.flush();
      const original = f.works.repo.listBindings(work.workId)[0]!;
      assert.equal(original.status, status); assert.equal(f.effects(), 1);
      const originalResults = f.works.repo.listDeliverables(work.workId);
      for (const id of ["first", "again"]) {
        f.resume(work, id); await f.queue.flush();
        assert.equal(f.effects(), 1, `${status}: pause/resume must not rerun the same input in another root`);
        assert.equal(f.works.repo.listBindings(work.workId).length, 1);
        assert.equal(f.db.listTasks().length, 1);
        assert.equal(f.works.getWork(work.workId)?.budget.usedTokens, 2);
        assert.deepEqual(f.works.repo.listDeliverables(work.workId), originalResults);
        assert.equal(f.works.getWork(work.workId)?.lifecycle, "active");
        assert.equal(f.works.getWork(work.workId)?.acceptedDeliverableIds.length, 0);
      }
      const continuation = f.works.repo.listOpenBlockers(work.workId).filter(blocker => blocker.blockerId.startsWith("continuation:"));
      assert.equal(continuation.length, status === "completed" ? 0 : 1, "incomplete original execution needs one visible follow-up decision");
      if (continuation[0]) {
        assert.equal(continuation[0].kind, "operational"); assert.equal(continuation[0].waitingForUserInput, true);
      }
      // A real requirement revision is new work, even when its source snapshot is unchanged.
      const amended = unwrap(f.works.amendWork(user, { workId: work.workId, operationId: `${status}:amend`, constraints: ["only perform the explicitly remaining step"] }));
      assert.equal(amended.inputSnapshotId, work.inputSnapshotId);
      assert.equal(amended.intentRevision, work.intentRevision + 1);
      f.schedule(amended, `${status}:new-revision`); await f.queue.flush();
      assert.equal(f.effects(), 2); assert.equal(f.works.repo.listBindings(work.workId).length, 2);
      assert(!f.works.repo.listOpenBlockers(work.workId).some(blocker => blocker.blockerId === `continuation:${original.bindingId}`), "new requirements clear only the superseded continuation blocker");
      const currentBlockers = f.works.repo.listOpenBlockers(work.workId);
      const currentVersion = f.works.getWork(work.workId)!.stateVersion;
      f.schedule(work, `${status}:stale-replayed-receipt`, true); await f.queue.flush();
      assert.equal(f.effects(), 2); assert.equal(f.works.getWork(work.workId)?.stateVersion, currentVersion);
      assert.deepEqual(f.works.repo.listOpenBlockers(work.workId), currentBlockers, "a replayed old receipt cannot clear the new input's planning blockers");
      const cancelled = unwrap(f.works.cancelWork(user, { workId: work.workId, operationId: `${status}:cancel` }));
      assert.equal(cancelled.lifecycle, "closed", "a planning decision must not prevent cancelling fully settled execution");
      assert.equal(cancelled.closureConclusion, "cancelled");
      f.schedule(amended, `${status}:stale-after-cancel`, true); await f.queue.flush(); assert.equal(f.effects(), 2);
      assert.equal(f.works.repo.listOpenBlockers(work.workId).length, 0);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }

  // A resume racing a stop receipt retains the original effect and still exposes the gap.
  {
    const f = await fixture("stop-race", "running");
    try {
      const work = f.create("original"); await f.queue.flush();
      let release!: () => void, started!: () => void;
      const stopStarted = new Promise<void>(resolve => { started = resolve; });
      f.holdStop(new Promise<void>(resolve => { release = resolve; }), started);
      unwrap(f.works.pauseWork(user, { workId: work.workId, operationId: "stop-race:pause" }));
      const stopping = f.adapter.flush(); await stopStarted;
      const resumed = unwrap(f.works.resumeWork(user, { workId: work.workId, operationId: "stop-race:resume" }));
      f.schedule(resumed, "stop-race:resume", true); release(); await stopping; await f.queue.flush();
      assert.equal(f.effects(), 1); assert.equal(f.works.repo.listBindings(work.workId).length, 1);
      const blocker = f.works.repo.listOpenBlockers(work.workId).find(item => item.blockerId.startsWith("continuation:"));
      assert(blocker, "a late stop receipt cannot silently lose the continuation decision");
      unwrap(f.works.clearBlocker(user, { workId: work.workId, operationId: "stop-race:resolved", blockerId: blocker.blockerId }));
      await f.queue.flush(); assert.equal(f.works.repo.getBlocker(blocker.blockerId)?.status, "cleared", "explicitly resolved planning blockers must not be reopened by polling");
      assert.equal(f.effects(), 1); assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }

  // Giving up a continuation clears only planning gaps, never unsettled side effects or usage.
  {
    const f = await fixture("cancel-blockers", "failed");
    try {
      const work = f.create("original"); await f.queue.flush();
      const binding = f.works.repo.listBindings(work.workId)[0]!;
      f.works.transaction(() => {
        f.works.repo.insertBlocker({ blockerId: "external-pending", workId: work.workId, kind: "external_effect", reason: "external receipt remains unknown",
          unknownExternalEffectRef: "original-effect", waitingForUserInput: false, status: "open", createdAt: Date.now() });
        f.works.repo.insertBlocker({ blockerId: `usage:${binding.bindingId}`, workId: work.workId, kind: "operational", reason: "original usage remains unverified",
          waitingForUserInput: false, status: "open", createdAt: Date.now() });
      });
      const nextInput = unwrap(f.works.amendWork(user, { workId: work.workId, operationId: "cancel-blockers:amend", inputSnapshotId: "new-source" }));
      f.schedule(nextInput, "cancel-blockers:new-input"); await f.queue.flush();
      assert.equal(f.works.repo.getBlocker(`continuation:${binding.bindingId}`)?.status, "cleared");
      assert.equal(f.effects(), 2, "a real unknown effect on the old execution no longer blocks the amended input");
      const cancelled = unwrap(f.works.cancelWork(user, { workId: work.workId, operationId: "cancel-blockers:cancel" }));
      await f.queue.flush();
      assert.equal(cancelled.lifecycle, "closing");
      assert.equal(f.works.repo.getBlocker("external-pending")?.status, "open");
      assert.equal(f.works.repo.getBlocker(`usage:${binding.bindingId}`)?.status, "open");
      assert.equal(f.effects(), 2); assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }

  {
    const f = await fixture("ended", "stopped");
    try {
      const work = f.create("original"); await f.queue.flush();
      assert(f.works.repo.listOpenBlockers(work.workId).some(blocker => blocker.blockerId.startsWith("continuation:")));
      const closed = unwrap(f.works.closeWork(user, { workId: work.workId, operationId: "ended:close", conclusion: "ended_unsuccessfully", closureSummary: "stop after recording the remaining gap" }));
      assert.equal(closed.lifecycle, "closed"); assert.equal(closed.closureConclusion, "ended_unsuccessfully");
      assert.equal(f.works.repo.listOpenBlockers(work.workId).length, 0); assert.equal(f.effects(), 1);
    } finally { await f.close(); }
  }

  // Pausing asynchronous preparation must preserve the original pending request.
  {
    const f = await fixture("preparing");
    try {
      let release!: () => void; f.holdPrepare(new Promise(resolve => { release = resolve; }));
      const work = f.create("original"); const preparing = f.queue.flush();
      unwrap(f.works.pauseWork(user, { workId: work.workId, operationId: "preparing:pause" }));
      f.schedule(work, "preparing:stale-active-receipt", true);
      release(); await preparing;
      assert.equal(f.effects(), 0);
      const resumed = unwrap(f.works.resumeWork(user, { workId: work.workId, operationId: "preparing:resume" }));
      f.schedule(resumed, "preparing:resume", true); await f.queue.flush();
      assert.equal(f.effects(), 1); assert.equal(f.db.listTasks().length, 1);
      assert.equal(f.works.repo.listBindings(work.workId).length, 1); assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }

  // A prepared root waiting on the mutable-resource gate resumes its same binding.
  {
    const f = await fixture("pending", "running");
    try {
      const first = f.create("busy"); await f.queue.flush();
      const second = f.create("waiting"); await f.queue.flush();
      // 退役共享资源隔离后，两个独立 Work 同时运行；没有跨 Work 的等待屏障。
      assert.equal(f.effects(), 2);
      assert.equal(f.works.repo.listBindings(first.workId)[0]!.status, "running");
      assert.equal(f.works.repo.listBindings(second.workId)[0]!.status, "running");
      const busy = f.works.repo.listBindings(first.workId)[0]!;
      f.observations.set(busy.bindingId, { status: "completed", summary: "busy root completed", hasWriteConflicts: false, artifactRefs: [], usageTokens: 2 });
      await f.queue.flush(); await f.queue.flush();
      assert.equal(f.effects(), 2, "settling one root never re-submits the other");
      assert.equal(f.db.listTasks().length, 2); assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }

  // 退役共享资源隔离：另一个 Work 的未知效果不再阻塞无关派发，也不再生成隔离 blocker。
  {
    const f = await fixture("unrelated-unknown-effect");
    try {
      const source = f.create("source"); await f.queue.flush();
      f.works.repo.insertBlocker({ blockerId: "effect:source", workId: source.workId, kind: "external_effect",
        reason: "unknown original effect", unknownExternalEffectRef: "effect:original", waitingForUserInput: true, status: "open", createdAt: Date.now() });
      const target = f.create("independent"); await f.queue.flush();
      assert.equal(f.effects(), 2, "an unrelated unknown effect never blocks a new independent execution");
      const blockers = f.works.repo.listOpenBlockers(target.workId);
      assert.equal(blockers.filter(item => item.reasonCode === "resource-dispatch-wait").length, 0);
      assert.equal(blockers.length, 0);
      assert(!f.works.getProjection(target.workId)!.nextSteps.some(item => item.includes("共享资源")));
      f.works.repo.clearBlocker("effect:source", source.workId, Date.now());
      await f.queue.flush(); await f.queue.flush();
      assert.equal(f.effects(), 2, "clearing the source blocker never re-submits the independent execution");
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }

  // An explicitly invalidated pending binding with proof of no submission can be replaced.
  {
    const f = await fixture("parallel-roots", "running");
    try {
      const busyWork = f.create("busy"); await f.queue.flush();
      const work = f.create("second"); await f.queue.flush();
      assert.equal(f.works.repo.listBindings(work.workId)[0]!.status, "running",
        "independent Works start without a cross-Work barrier");
      assert.equal(f.effects(), 2);
      const busy = f.works.repo.listBindings(busyWork.workId)[0]!;
      f.observations.set(busy.bindingId, { status: "completed", summary: "parallel root completed", hasWriteConflicts: false, artifactRefs: [], usageTokens: 2 });
      await f.queue.flush(); await f.queue.flush();
      assert.equal(f.effects(), 2, "settling one root never re-submits itself or the other root");
      assert.equal(f.works.repo.listBindings(work.workId).length, 1);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }
  console.log("PASS resume/recovery/invalidated-result input dedupe; persistent duplicate requests cancelled; incomplete continuation visible; new requirements and unsubmitted work still dispatch safely");
} finally { await rm(root, { recursive: true, force: true }); }
