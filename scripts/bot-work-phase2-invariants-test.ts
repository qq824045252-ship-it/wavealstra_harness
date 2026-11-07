import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
const bind = (work: WorkDto, id: string, reserveTokens?: number) => {
  const result = unwrap(works.dispatchExecution(user, { workId: work.workId, operationId: id, botId: DEFAULT_BOT_ID, taskId: id,
    durableStoreKey: `store:${id}`, conversationId: "1", workspaceBinding: root, reserveTokens }));
  return works.repo.getBinding(result.activeExecutionIds.at(-1)!)!;
};
try {
  // Each namespace may legitimately use numeric conversationId=1.
  const first = create("namespace-a"); const a = bind(first, "root-a", 20);
  const second = create("namespace-b"); const b = bind(second, "root-b", 30);
  assert.equal(a.conversationId, b.conversationId);
  const receipt = (binding: typeof a): AgentSubmissionReceipt => ({ taskId: binding.taskId, operationId: binding.operationId, submissionId: 1, status: "done" });
  const done = { status: "completed" as const, summary: "first result", artifactRefs: ["artifact.txt"], hasWriteConflicts: false, sourceEntryId: 3 };
  assert.deepEqual(works.nativeResults.receive(a, receipt(a), done), []);
  assert.deepEqual(works.nativeResults.receive(b, receipt(b), { ...done, summary: "second result", usageTokens: 9 }), []);
  assert.equal(works.repo.listDeliverables(first.workId)[0].summary, "first result");
  assert.equal(works.repo.listDeliverables(second.workId)[0].summary, "second result");
  // Late usage is an additional settlement fact, not a rewritten deliverable operation.
  assert.deepEqual(works.nativeResults.receive(a, receipt(a), { ...done, usageTokens: 7 }), []);
  assert.equal(works.getWork(first.workId)?.budget.usedTokens, 7);
  assert.equal(works.getWork(second.workId)?.budget.usedTokens, 9);
  assert.equal(works.repo.listDeliverables(first.workId).length, 1);
  assert.deepEqual(works.nativeResults.receive(a, receipt(a), { ...done, usageTokens: 7 }), []);
  assert.equal(works.getWork(first.workId)?.budget.usedTokens, 7);
  const wrong = works.reconcileExecution({ kind: "system", reason: "wrong-reservation" }, { bindingId: a.bindingId, outcome: "completed", usageTokens: 500, reservationId: b.reservationId });
  assert.equal(wrong.ok, false);
  assert.equal(works.getWork(second.workId)?.budget.usedTokens, 9);
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

  const unknownWork = create("unreadable"); const unknown = bind(unknownWork, "root-unknown", 15);
  let reads = 0;
  const unavailable: WorkExecutionPort = { prepare: async () => { throw new Error("not preparation"); }, find: async () => { reads++; throw new Error("read unavailable"); },
    submit: async () => { throw new Error("must never replay business"); }, inspect: async () => { throw new Error("not reached"); }, stop: async () => {} };
  const broken = new WorkExecutionAdapter(works, unavailable, LOCAL_USER_ID, () => true, () => {});
  for (let index = 0; index < 9; index++) await broken.flush(); await broken.close();
  assert.equal(reads, 5, "readback is bounded durably, not an infinite polling loop");
  assert.equal(works.repo.getBinding(unknown.bindingId)?.status, "unknown");
  assert.equal(works.repo.listOpenBlockers(unknownWork.workId).length, 1);
  assert.equal(works.repo.getReservation(unknown.reservationId!)?.state, "unknown");
  assert.equal(works.getWork(unknownWork.workId)?.budget.reservedTokens, 15);
  const unknownVersion = works.getWork(unknownWork.workId)!.stateVersion;
  db.close(); db = new AppDatabase(path); bots = new BotRegistry(db.connection); works = new WorkService(db.connection, { bots });
  assert.equal(works.nativeResults.shouldInspect(unknown.bindingId), false);
  unwrap(works.reconcileExecution({ kind: "system", reason: "repeat-unknown" }, { bindingId: unknown.bindingId, outcome: "unknown", unknownExternalEffectRef: `native-read:${unknown.bindingId}` }));
  assert.equal(works.getWork(unknownWork.workId)?.stateVersion, unknownVersion);
  const recoveredPort: WorkExecutionPort = { ...unavailable, find: async () => receipt(unknown), inspect: async () => ({ ...done, usageTokens: 8 }) };
  const recovered = new WorkExecutionAdapter(works, recoveredPort, LOCAL_USER_ID, () => true, (_id, error) => { throw error; });
  recovered.wake(unknown.taskId); await recovered.flush(); await recovered.close();
  assert.equal(works.repo.getBinding(unknown.bindingId)?.status, "completed", "trusted native terminal wake can start bounded readback after exhaustion");
  assert.equal(works.getWork(unknownWork.workId)?.budget.usedTokens, 8);
  assert.equal(works.repo.listOpenBlockers(unknownWork.workId).length, 0);
  const stoppedWork = create("stopped-usage"); const stopped = bind(stoppedWork, "root-stopped", 12);
  unwrap(works.reconcileExecution({ kind: "system", reason: "stopped-usage-missing" }, { bindingId: stopped.bindingId, outcome: "stopped" }));
  assert.equal(works.repo.getReservation(stopped.reservationId!)?.state, "unknown");
  assert(works.repo.listOpenBlockers(stoppedWork.workId).some(blocker => blocker.blockerId === `usage:${stopped.bindingId}`));
  const stoppedPort: WorkExecutionPort = { ...unavailable, find: async () => receipt(stopped), inspect: async () => ({ ...done, status: "stopped", usageTokens: 6 }) };
  const stoppedAdapter = new WorkExecutionAdapter(works, stoppedPort, LOCAL_USER_ID, () => true, (_id, error) => { throw error; });
  await stoppedAdapter.flush(); await stoppedAdapter.close();
  assert.equal(works.repo.getBinding(stopped.bindingId)?.status, "stopped");
  assert.equal(works.repo.getReservation(stopped.reservationId!)?.state, "committed");
  assert.equal(works.getWork(stoppedWork.workId)?.budget.usedTokens, 6);
  assert.equal(works.repo.listOpenBlockers(stoppedWork.workId).length, 0);
  const lostWork = create("lost-terminal-receipt"); const lostBinding = bind(lostWork, "lost-terminal-root", 10);
  unwrap(works.reconcileExecution({ kind: "system", reason: "terminal-unbilled" }, { bindingId: lostBinding.bindingId, outcome: "stopped" }));
  let terminalSubmissions = 0;
  const lostPort: WorkExecutionPort = { ...unavailable, find: async () => undefined,
    submit: async () => { terminalSubmissions++; throw new Error("terminal billing must never submit"); } };
  const lostAdapter = new WorkExecutionAdapter(works, lostPort, LOCAL_USER_ID, () => true, () => {});
  await lostAdapter.flush();
  unwrap(works.pauseWork(user, { workId: lostWork.workId, operationId: "pause-unbilled" }));
  await lostAdapter.flush(); await lostAdapter.close();
  assert.equal(terminalSubmissions, 0);
  assert.equal(works.repo.getReservation(lostBinding.reservationId!)?.state, "unknown", "missing receipt does not prove zero cost");
  assert.equal(works.getWork(lostWork.workId)?.budget.usedTokens, 0);
  assert.equal(works.getWork(lostWork.workId)?.budget.reservedTokens, 10);
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
  const pendingUsageWork = create("unknown-then-terminal-usage"); const pendingUsage = bind(pendingUsageWork, "unknown-then-terminal-root", 11);
  works.nativeResults.receive(pendingUsage, receipt(pendingUsage), { status: "running" });
  works.nativeResults.readFailed(pendingUsage, new Error("temporary outage before result"));
  unwrap(works.cancelWork(user, { workId: pendingUsageWork.workId, operationId: "cancel-pending-usage" }));
  works.nativeResults.receive(pendingUsage, receipt(pendingUsage), done);
  assert.equal(works.repo.getReservation(pendingUsage.reservationId!)?.state, "unknown");
  assert(works.repo.listOpenBlockers(pendingUsageWork.workId).some(blocker => blocker.blockerId === `usage:${pendingUsage.bindingId}`));
  assert.equal(works.getWork(pendingUsageWork.workId)?.lifecycle, "closing", "unknown usage cannot silently close the responsibility");
  works.nativeResults.receive(pendingUsage, receipt(pendingUsage), { ...done, usageTokens: 4 });
  assert.equal(works.getWork(pendingUsageWork.workId)?.closureConclusion, "cancelled");
  assert.equal(works.getWork(pendingUsageWork.workId)?.budget.usedTokens, 4);

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
  assert.equal(works.repo.getReservation(works.repo.listBindings(queued.workId)[0].reservationId!)?.state, "committed");
  console.log("PASS Phase 2 namespace isolation, exact/late billing, poison isolation, bounded unknown recovery, persistent scopes, multi-connection lease/CAS, queued prepare and lost dispatch receipt");
} finally { db.close(); await rm(root, { recursive: true, force: true }); }
