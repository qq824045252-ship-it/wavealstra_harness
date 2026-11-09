import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { AgentSubmissionReceipt } from "../src/shared/agent-ipc";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { WorkHostAuthority } from "../src/main/agent/work/WorkHostAuthority";
import { WorkExecutionAdapter, type WorkExecutionPort } from "../src/main/agent/work/WorkExecutionAdapter";
import { WorkDispatchQueue } from "../src/main/agent/work/WorkDispatchQueue";
import { WorkProjectionJournal } from "../src/main/agent/work/WorkProjectionJournal";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkControlResult, type WorkDto } from "../src/shared/bot-work";

const rowCount = (value: unknown) => z.object({ count: z.number() }).parse(value).count;
const unwrap = (result: WorkControlResult) => { if (!result.ok) throw new Error(`${result.code}: ${result.message}`); return result.work; };
const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS };
const guard = (work: WorkDto) => ({ expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch });
const root = await mkdtemp(join(tmpdir(), "bot-work-invariants-"));
const path = join(root, "business.db");
let db = new AppDatabase(path);
let bots = new BotRegistry(db.connection); bots.registerBot({ userId: LOCAL_USER_ID, botId: DEFAULT_BOT_ID, displayName: "fixture", authorization: DESKTOP_USER_GRANTS });
let works = new WorkService(db.connection, { bots });
const create = (id: string) => unwrap(works.createWork(user, { operationId: id, title: id, inputSnapshotId: `source:${id}`, authorization: DESKTOP_USER_GRANTS }));
const bind = (work: WorkDto, id: string) => {
  const result = unwrap(works.dispatchExecution(user, { workId: work.workId, operationId: id, botId: DEFAULT_BOT_ID, taskId: id,
    durableStoreKey: `store:${id}`, conversationId: "1", workspaceBinding: root }));
  return works.repo.getBinding(result.activeExecutionIds.at(-1)!)!;
};
try {
  // Each namespace may legitimately use numeric conversationId=1.
  const first = create("namespace-a"); const a = bind(first, "root-a");
  const second = create("namespace-b"); const b = bind(second, "root-b");
  assert.equal(a.conversationId, b.conversationId);
  const receipt = (binding: typeof a): AgentSubmissionReceipt => ({ taskId: binding.taskId, operationId: binding.operationId, submissionId: 1, status: "done" });
  const done = { status: "completed" as const, summary: "first result", artifactRefs: ["artifact.txt"], hasWriteConflicts: false, sourceEntryId: 3 };
  assert.deepEqual(works.nativeResults.receive(a, receipt(a), done), []);
  assert.deepEqual(works.nativeResults.receive(b, receipt(b), { ...done, summary: "second result", usageTokens: 9 }), []);
  assert.equal(works.repo.listDeliverables(first.workId)[0].summary, "first result");
  assert.equal(works.repo.listDeliverables(second.workId)[0].summary, "second result");
  // Late usage is an additional settlement fact, not a rewritten deliverable operation.
  assert.deepEqual(works.nativeResults.receive(a, receipt(a), { ...done, usageTokens: 7 }), []);
  assert.equal(works.repo.listDeliverables(first.workId).length, 1);
  assert.deepEqual(works.nativeResults.receive(a, receipt(a), { ...done, usageTokens: 7 }), []);
  assert.throws(() => works.nativeResults.receive(a, receipt(b), done));

  // A failed result transaction cannot starve an unrelated root's durable inbox.
  const cWork = create("poison"); const c = bind(cWork, "root-c");
  const dWork = create("healthy"); const d = bind(dWork, "root-d");
  db.connection.exec(`CREATE TEMP TRIGGER inject_poison BEFORE INSERT ON work_operation_receipts
    WHEN NEW.work_id='${cWork.workId}' AND NEW.operation_type='submitDeliverable'
    BEGIN SELECT RAISE(ABORT,'poison transaction'); END;`);
  assert.equal(works.nativeResults.receive(c, receipt(c), done).length, 1);
  const healthy = works.nativeResults.receive(d, receipt(d), { ...done, summary: "healthy output" });
  assert.equal(healthy.length, 1, "only the original poison fact still fails");
  assert.equal(works.repo.listDeliverables(dWork.workId).length, 1);
  assert.equal(works.repo.listDeliverables(cWork.workId).length, 0);
  db.connection.exec("DROP TRIGGER inject_poison"); works.nativeResults.consume();
  assert.equal(works.repo.listDeliverables(cWork.workId).length, 1);
  assert.equal(works.repo.listOpenBlockers(cWork.workId).length, 0);

  const unknownWork = create("unreadable"); const unknown = bind(unknownWork, "root-unknown");
  let reads = 0;
  const unavailable: WorkExecutionPort = { prepare: async () => { throw new Error("not preparation"); }, find: async binding => { if (binding.bindingId === unknown.bindingId) reads++; throw new Error("read unavailable"); },
    submit: async () => { throw new Error("must never replay business"); }, inspect: async () => { throw new Error("not reached"); }, stop: async () => {} };
  const broken = new WorkExecutionAdapter(works, unavailable, LOCAL_USER_ID, () => true, () => {});
  for (let index = 0; index < 9; index++) await broken.flush(); await broken.close();
  assert.equal(reads, 5, "readback is bounded durably, not an infinite polling loop");
  assert.equal(works.repo.getBinding(unknown.bindingId)?.status, unknown.status, "unavailable readback must not manufacture terminal state");
  assert.equal(works.repo.listOpenBlockers(unknownWork.workId).length, 0);
  assert(works.repo.listBlockers(unknownWork.workId).some(item => item.unknownExternalEffectRef && item.details?.effectDisposition === "continue_without_replay"), "unknown readback remains diagnostic evidence");
  db.close(); db = new AppDatabase(path); bots = new BotRegistry(db.connection); works = new WorkService(db.connection, { bots });
  assert.equal(works.nativeResults.shouldInspect(unknown.bindingId), false);
  works.nativeResults.readFailed(unknown, new Error("still unavailable"));
  const unknownVersion = works.getWork(unknownWork.workId)!.stateVersion;
  works.nativeResults.readFailed(unknown, new Error("still unavailable"));
  assert.equal(works.getWork(unknownWork.workId)?.stateVersion, unknownVersion, "repeated identical read failure is idempotent within the host");
  assert.equal(works.repo.listBlockers(unknownWork.workId).filter(item => item.unknownExternalEffectRef === `native-read:${unknown.bindingId}`).length, 1);
  const recoveredPort: WorkExecutionPort = { ...unavailable, find: async () => receipt(unknown), inspect: async () => ({ ...done, usageTokens: 8 }) };
  const recovered = new WorkExecutionAdapter(works, recoveredPort, LOCAL_USER_ID, () => true, (_id, error) => { throw error; });
  recovered.wake(unknown.taskId); await recovered.flush(); await recovered.close();
  assert.equal(works.repo.getBinding(unknown.bindingId)?.status, "completed", "trusted native terminal wake can start bounded readback after exhaustion");
  assert.equal(works.repo.listOpenBlockers(unknownWork.workId).length, 0);
  const stoppedWork = create("stopped-usage"); const stopped = bind(stoppedWork, "root-stopped");
  unwrap(works.reconcileExecution({ kind: "system", reason: "stopped-usage-missing" }, { bindingId: stopped.bindingId, outcome: "stopped" }));
  assert.equal(works.repo.listOpenBlockers(stoppedWork.workId).length, 0, "missing telemetry never blocks known terminal results");
  const stoppedPort: WorkExecutionPort = { ...unavailable, find: async () => receipt(stopped), inspect: async () => ({ ...done, status: "stopped", usageTokens: 6 }) };
  const stoppedAdapter = new WorkExecutionAdapter(works, stoppedPort, LOCAL_USER_ID, () => true, (_id, error) => { throw error; });
  await stoppedAdapter.flush(); await stoppedAdapter.close();
  assert.equal(works.repo.getBinding(stopped.bindingId)?.status, "stopped");
  assert.equal(works.repo.listOpenBlockers(stoppedWork.workId).length, 0);
  const lostWork = create("lost-terminal-receipt"); const lostBinding = bind(lostWork, "lost-terminal-root");
  unwrap(works.reconcileExecution({ kind: "system", reason: "terminal-unbilled" }, { bindingId: lostBinding.bindingId, outcome: "stopped" }));
  let terminalSubmissions = 0;
  const lostPort: WorkExecutionPort = { ...unavailable, find: async () => undefined,
    submit: async () => { terminalSubmissions++; throw new Error("terminal billing must never submit"); } };
  const lostAdapter = new WorkExecutionAdapter(works, lostPort, LOCAL_USER_ID, () => true, () => {});
  await lostAdapter.flush();
  unwrap(works.pauseWork(user, { workId: lostWork.workId, operationId: "pause-unbilled" }));
  await lostAdapter.flush(); await lostAdapter.close();
  assert.equal(terminalSubmissions, 0);
  const intermittentWork = create("intermittent-native-read"); const intermittent = bind(intermittentWork, "intermittent-root");
  let failRead = true, alternating = true, nativeReads = 0;
  const intermittentPort: WorkExecutionPort = { ...unavailable, find: async binding => {
    if (binding.bindingId !== intermittent.bindingId) return undefined;
    nativeReads++;
    if (alternating && failRead) { failRead = false; throw new Error("temporary native read failure"); }
    failRead = true; return { ...receipt(intermittent), status: "placed" };
  }, inspect: async () => ({ status: "running" }) };
  const intermittentAdapter = new WorkExecutionAdapter(works, intermittentPort, LOCAL_USER_ID, () => true, () => {});
  for (let index = 0; index < 6; index++) await intermittentAdapter.flush();
  assert.equal(nativeReads, 6);
  assert.equal(works.repo.getBinding(intermittent.bindingId)?.status, "running", "fresh successful native read must recover each distinct outage");
  assert.equal(works.repo.listOpenBlockers(intermittentWork.workId).length, 0);
  assert(works.nativeResults.shouldInspect(intermittent.bindingId));
  const stableVersion = works.getWork(intermittentWork.workId)!.stateVersion;
  alternating = false; await intermittentAdapter.flush(); await intermittentAdapter.flush();
  assert.equal(works.getWork(intermittentWork.workId)?.stateVersion, stableVersion, "unchanged known running facts do not churn Work versions");
  works.nativeResults.readFailed(intermittent, new Error("outage before explicit wake"));
  intermittentAdapter.wakeWork(intermittentWork.workId); await intermittentAdapter.flush();
  assert.equal(works.repo.getBinding(intermittent.bindingId)?.status, "running", "explicit wake preserves the new recovery identity rather than reusing an old consumed null-cycle fact");
  assert(works.getWork(intermittentWork.workId)?.activeExecutionIds.includes(intermittent.bindingId));
  await intermittentAdapter.close();
  unwrap(works.reconcileExecution({ kind: "system", reason: "fixture-ended" }, { bindingId: intermittent.bindingId, outcome: "completed" }));
  const pendingUsageWork = create("unknown-then-terminal-usage"); const pendingUsage = bind(pendingUsageWork, "unknown-then-terminal-root");
  works.nativeResults.receive(pendingUsage, receipt(pendingUsage), { status: "running" });
  works.nativeResults.readFailed(pendingUsage, new Error("temporary outage before result"));
  unwrap(works.cancelWork(user, { workId: pendingUsageWork.workId, operationId: "cancel-pending-usage" }));
  works.nativeResults.receive(pendingUsage, receipt(pendingUsage), done);
  assert.equal(works.repo.listOpenBlockers(pendingUsageWork.workId).length, 0);
  assert.equal(works.getWork(pendingUsageWork.workId)?.lifecycle, "closed", "known terminal outcome can close without token telemetry");
  works.nativeResults.receive(pendingUsage, receipt(pendingUsage), { ...done, usageTokens: 4 });
  assert.equal(works.getWork(pendingUsageWork.workId)?.closureConclusion, "cancelled");

  // Stopping still waits for live executions, but not unknown historical effects.
  for (const conclusion of ["ended_unsuccessfully", "cancelled"] as const) {
    const live = create(`live-${conclusion}`), running = bind(live, `live-root-${conclusion}`);
    assert.equal(unwrap(works.closeWork(user, { workId: live.workId, operationId: `live-stop-${conclusion}`, conclusion,
      closureSummary: "Wait for actual execution settlement" })).lifecycle, "closing");
    unwrap(works.reconcileExecution({ kind: "system", reason: "fixture-settled" }, { bindingId: running.bindingId, outcome: "stopped" }));
    assert.equal(works.getWork(live.workId)?.closureConclusion, conclusion);
  }
  for (const kind of ["external_effect", "operational"] as const) {
    const target = create(`preserve-${kind}`), blockerId = `fixture:${kind}`;
    works.repo.insertBlocker({ blockerId, workId: target.workId, kind, reason: "unresolved effect",
      unknownExternalEffectRef: "unverified-receipt", waitingForUserInput: false, status: "open", createdAt: Date.now() });
    assert.equal(unwrap(works.closeWork(user, { workId: target.workId, operationId: `stop-${kind}`, conclusion: "ended_unsuccessfully",
      closureSummary: "Retain unknown evidence without blocking closure" })).lifecycle, "closed");
    assert.equal(works.repo.getBlocker(blockerId)?.status, "cleared");
    assert.equal(works.repo.getBlocker(blockerId)?.unknownExternalEffectRef, "unverified-receipt");
    assert.equal(works.repo.getBlocker(blockerId)?.details?.effectDisposition, "continue_without_replay");
  }

  // Unknown native liveness retains admitted tools; only terminal observations
  // may release orphaned admissions, and exact late receipts can refine them.
  const orphanWork = create("orphan-admission"), orphan = bind(orphanWork, "orphan-root");
  assert.equal(works.admitTaskAction(orphan.taskId, { operationId: "orphan-tool", actionKind: "workspace:write" }), undefined);
  unwrap(works.reconcileExecution({ kind: "system", reason: "lost-native-read" }, { bindingId: orphan.bindingId, outcome: "unknown" }));
  assert.equal(works.repo.listAdmissions(orphanWork.workId)[0]?.state, "admitted");
  assert.equal(unwrap(works.cancelWork(user, { workId: orphanWork.workId, operationId: "cancel-orphan" })).lifecycle, "closing");
  unwrap(works.reconcileExecution({ kind: "system", reason: "native-confirmed-stopped" }, { bindingId: orphan.bindingId, outcome: "stopped" }));
  assert.equal(works.repo.listAdmissions(orphanWork.workId)[0]?.state, "unknown", "confirmed terminal invocation retires a lost tool callback as uncertainty");
  assert.equal(works.repo.listOpenBlockers(orphanWork.workId).length, 0);
  works.settleTaskAction(orphan.taskId, "orphan-tool", "consumed");
  assert.equal(works.repo.listAdmissions(orphanWork.workId)[0]?.state, "consumed");
  assert.equal(works.repo.getBinding(orphan.bindingId)?.status, "stopped", "a late tool receipt does not manufacture whole-execution success");
  // Model the previously persisted closing state from the old hard gate. The
  // adapter's settlement seam finishes the existing cancellation with no submit.
  const oldClosing = works.getWork(orphanWork.workId)!;
  works.repo.updateWork({ ...oldClosing, lifecycle: "closing", pendingConclusion: "cancelled",
    stateVersion: oldClosing.stateVersion + 1 });
  works.settlePendingClosure(orphanWork.workId);
  assert.equal(works.getWork(orphanWork.workId)?.closureConclusion, "cancelled");
  const closedVersion = works.getWork(orphanWork.workId)!.stateVersion;
  works.settlePendingClosure(orphanWork.workId);
  assert.equal(works.getWork(orphanWork.workId)!.stateVersion, closedVersion, "historical close re-evaluation is idempotent");

  // A live process survives a failed inspection. Cancellation cannot infer that
  // it stopped, settle its admitted write, or start a second writable execution.
  {
    const liveDb = new AppDatabase(join(root, "live-inspection.db"));
    const liveBots = new BotRegistry(liveDb.connection);
    liveBots.registerBot({ userId: LOCAL_USER_ID, botId: DEFAULT_BOT_ID, displayName: "live fixture", authorization: DESKTOP_USER_GRANTS });
    const liveWorks = new WorkService(liveDb.connection, { bots: liveBots });
    const liveWork = unwrap(liveWorks.createWork(user, { operationId: "live-inspect", title: "Live inspection", inputSnapshotId: "live-input", authorization: DESKTOP_USER_GRANTS }));
    const dispatched = unwrap(liveWorks.dispatchExecution(user, { workId: liveWork.workId, operationId: "live-root", botId: DEFAULT_BOT_ID,
      taskId: "live-root", durableStoreKey: "live-store", conversationId: "1", workspaceBinding: root }));
    const liveBinding = liveWorks.repo.getBinding(dispatched.activeExecutionIds[0])!;
    assert.equal(liveWorks.admitTaskAction(liveBinding.taskId, { operationId: "live-write", actionKind: "workspace:write" }), undefined);
    const child = spawn(process.execPath, ["-e", "require('node:fs').appendFileSync('live-write.txt','once'); console.log('ready'); setInterval(()=>{},1000)"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    const exited = once(child, "exit");
    let inspectionFails = true, confirmedStopped = false, submits = 0, stops = 0;
    const livePort: WorkExecutionPort = {
      prepare: async () => { throw new Error("must not prepare a competing task"); },
      find: async () => receipt(liveBinding),
      submit: async () => { submits++; throw new Error("must not replay the running task"); },
      inspect: async () => {
        if (inspectionFails) throw new Error("transient native inspection failure");
        return confirmedStopped ? { ...done, status: "stopped" } : { status: "running" };
      },
      stop: async () => { stops++; }, // Request acknowledgement alone is not process-exit evidence.
    };
    const liveAdapter = new WorkExecutionAdapter(liveWorks, livePort, LOCAL_USER_ID, () => true, () => {});
    try {
      await once(child.stdout!, "data");
      liveWorks.nativeResults.receive(liveBinding, receipt(liveBinding), { status: "running" });
      await liveAdapter.flush();
      assert.equal(child.exitCode, null);
      assert.equal(liveWorks.repo.getBinding(liveBinding.bindingId)?.status, "running");
      assert.equal(liveWorks.repo.listAdmissions(liveWork.workId)[0]?.state, "admitted");
      assert.equal(unwrap(liveWorks.cancelWork(user, { workId: liveWork.workId, operationId: "cancel-live" })).lifecycle, "closing");
      inspectionFails = false;
      liveAdapter.wake(liveBinding.taskId); await liveAdapter.flush();
      assert(stops > 0);
      assert.equal(liveWorks.getWork(liveWork.workId)?.lifecycle, "closing", "stop request without terminal receipt cannot close Work");
      assert.equal(liveWorks.repo.listBindings(liveWork.workId).length, 1);
      assert.equal(liveWorks.repo.listAdmissions(liveWork.workId)[0]?.state, "admitted");
      assert.equal(rowCount(liveDb.connection.prepare("SELECT count(*) count FROM work_automatic_recovery").get()), 0, "transient read failure cannot create competing recovery");
      assert.equal(submits, 0);
      assert.equal(await readFile(join(root, "live-write.txt"), "utf8"), "once");
      child.kill(); await exited; confirmedStopped = true;
      liveAdapter.wake(liveBinding.taskId); await liveAdapter.flush();
      assert.equal(liveWorks.repo.getBinding(liveBinding.bindingId)?.status, "stopped");
      assert.equal(liveWorks.getWork(liveWork.workId)?.closureConclusion, "cancelled");
      assert.equal(await readFile(join(root, "live-write.txt"), "utf8"), "once", "the live writer was never replayed");
      assert.equal(liveWorks.repo.listAdmissions(liveWork.workId)[0]?.state, "unknown", "lost afterTool callback stays uncertain after actual stop");
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
      await liveAdapter.close(); liveDb.close();
    }
  }

  // Snapshot epochs and per-user sequences persist across reopen and list scopes stay distinct.
  const journal = new WorkProjectionJournal(db.connection, works);
  const snapshot = journal.sync(LOCAL_USER_ID, { includeClosed: false }); assert.equal(snapshot.kind, "snapshot");
  if (snapshot.kind !== "snapshot") throw new Error("snapshot expected");
  assert.equal(journal.sync(LOCAL_USER_ID, { includeClosed: true, cursor: snapshot.cursor }).kind, "resync_required");
  assert.equal(journal.sync(LOCAL_USER_ID, { includeClosed: false, cursor: { ...snapshot.cursor, epoch: "stale" } }).kind, "resync_required");
  assert.equal(journal.sync("another-user", { includeClosed: false, cursor: snapshot.cursor }).kind, "resync_required");
  assert.equal(journal.sync(LOCAL_USER_ID, { includeClosed: false, cursor: snapshot.cursor }).kind, "delta");
  create("event-after-snapshot"); create("event-after-gap");
  db.connection.prepare("DELETE FROM work_projection_events WHERE user_id=? AND sequence=?").run(LOCAL_USER_ID, snapshot.cursor.sequence + 1);
  assert.equal(journal.sync(LOCAL_USER_ID, { includeClosed: false, cursor: snapshot.cursor }).kind, "resync_required", "lost journal member requires full refresh");

  // Multiple real SQLite connections observe the same host lease and CAS receipt order.
  const other = new AppDatabase(path);
  try {
    const leaseA = new WorkHostAuthority(db.connection, "authority-a"); const leaseB = new WorkHostAuthority(other.connection, "authority-b");
    assert(leaseA.acquire().ok); assert(!leaseB.acquire().ok);
    const controlled = new WorkService(db.connection, { bots, isAuthority: () => leaseA.isAuthority() });
    const foreign = new WorkService(other.connection, { bots: new BotRegistry(other.connection), isAuthority: () => leaseB.isAuthority() });
    assert.equal(foreign.createWork(user, { operationId: "denied-host", title: "denied" }).ok, false);
    const target = unwrap(controlled.createWork(user, { operationId: "cas-create", title: "CAS" }));
    const bot: WorkActor = { kind: "bot", botId: DEFAULT_BOT_ID, userId: LOCAL_USER_ID, host: "foreground", grants: DESKTOP_USER_GRANTS };
    unwrap(controlled.pauseWork(bot, { operationId: "cas-pause", workId: target.workId, versionGuard: guard(target) }));
    assert.equal(controlled.cancelWork(bot, { operationId: "stale-cancel", workId: target.workId, versionGuard: guard(target) }).ok, false);
    leaseA.stop(); assert(leaseB.acquire().ok); assert(!leaseA.isAuthority()); leaseB.stop();
  } finally { other.close(); }

  // prepare is asynchronous; pause/resume while it waits reuses the persistent request.
  const queued = create("queued");
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  let submissions = 0;
  const queuePort: WorkExecutionPort = { prepare: async taskId => { await held; return { taskId, durableStoreKey: `store:${taskId}`, conversationId: "1", workspaceBinding: root }; },
    find: async binding => binding.operationId.startsWith("dispatch:") && submissions ? receipt(binding) : undefined,
    submit: async binding => { submissions++; return receipt(binding); },
    inspect: async () => ({ ...done, usageTokens: 2 }), stop: async () => {} };
  const queueAdapter = new WorkExecutionAdapter(works, queuePort, LOCAL_USER_ID, () => true, () => {});
  const queue = new WorkDispatchQueue(db, works, queueAdapter, () => true, () => "fixture");
  works.transaction(() => queue.enqueue(queued, "queue-original"));
  const starting = queue.flush();
  unwrap(works.pauseWork(user, { operationId: "pause-preparing", workId: queued.workId }));
  const resumed = unwrap(works.resumeWork(user, { operationId: "resume-preparing", workId: queued.workId }));
  works.transaction(() => queue.enqueue(resumed, "queue-resume"));
  assert.equal(rowCount(db.connection.prepare("SELECT COUNT(*) count FROM work_dispatch_requests WHERE work_id=?").get(queued.workId)), 1);
  release(); await starting; await queue.flush();
  // Simulate losing only the business acknowledgement after the binding transaction.
  db.connection.prepare("UPDATE work_dispatch_requests SET state='pending' WHERE work_id=?").run(queued.workId);
  await queue.flush(); await queue.close(); await queueAdapter.close();
  assert.equal(submissions, 1, "prepare races and lost dispatch acknowledgement cannot start a second business execution");
  assert.equal(works.repo.listBindings(queued.workId).length, 1);
  assert.equal(rowCount(db.connection.prepare("SELECT COUNT(*) count FROM work_dispatch_requests WHERE work_id=? AND state='dispatched'").get(queued.workId)), 1);
  console.log("PASS Phase 2 namespace isolation, late telemetry without quota blocking, poison isolation, bounded unknown recovery, persistent scopes, multi-connection lease/CAS, queued prepare and lost dispatch receipt");
} finally { db.close(); await rm(root, { recursive: true, force: true }); }
