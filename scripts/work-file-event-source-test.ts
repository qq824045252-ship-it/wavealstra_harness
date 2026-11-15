// Real OS file events and real frontend/ingress/observer/queue; native model execution
// is replaced only by a deterministic adapter. The JSON is a simulated PR, not GitHub.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { BotConversationRepository } from "../src/main/agent/work/BotConversationRepository";
import { botForegroundTools } from "../src/main/agent/work/BotForegroundTools";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { WorkDispatchQueue } from "../src/main/agent/work/WorkDispatchQueue";
import { WorkFileEventSource, readWorkFileSource, withWorkSourceRead, MAX_WORK_FILE_BYTES } from "../src/main/agent/work/WorkFileEventSource";
import { WorkSourceObserver, MAX_WORK_GIT_BYTES } from "../src/main/agent/work/WorkSourceObserver";
import { WorkHostAuthority, workHostLeaseIdentity } from "../src/main/agent/work/WorkHostAuthority";
import type { WorkExecutionAdapter } from "../src/main/agent/work/WorkExecutionAdapter";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkControlResult, type WorkDto } from "../src/shared/bot-work";

const root = await mkdtemp(join(tmpdir(), "work-file-events-"));
const path = join(root, "simulated-pr.json");
const dbPath = join(root, "fixture.db");
const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const state = (version: number) => JSON.stringify({ simulated: true, provider: "local PR fixture, not GitHub", version, merged: version > 0 });
let db!: AppDatabase, bots!: BotRegistry, works!: WorkService, messages!: BotConversationRepository, queue!: WorkDispatchQueue;
let authority = true;
let calls = 0;
const submitted: Array<{ workId: string; snapshot: string; text: string; input: any }> = [];
const actor: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS };
const unwrap = (result: WorkControlResult): WorkDto => { assert(result.ok, JSON.stringify(result)); return result.work; };
const guard = (id: string) => { const work = works.getWork(id)!; return { expectedStateVersion: work.stateVersion,
  expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch }; };
function open() {
  db = new AppDatabase(dbPath); bots = new BotRegistry(db.connection); bots.ensureDefaultBot(LOCAL_USER_ID);
  works = new WorkService(db.connection, { bots, isAuthority: () => authority });
  messages = new BotConversationRepository(db.connection);
  const adapter = { dispatch: async (asActor, params) => {
    const result = works.dispatchExecution(asActor, { ...params, durableStoreKey: `fixture:${params.taskId}`,
      conversationId: "1", workspaceBinding: root });
    if (result.ok) {
      const binding=works.repo.bindingForTask(params.taskId)!;assert(binding.inboxEventId,'real source event survives dispatch binding');
      const native=JSON.parse(works.repo.executionInput(binding));
      assert.equal(native.watchExecutionStage.stage,'triggered_execution');assert.equal(native.watchExecutionStage.inboxEventId,binding.inboxEventId);
      assert.equal(native.watchExecutionStage.currentInputSnapshotId,result.work.inputSnapshotId);assert.equal(native.sourceEvent.source,'file');
      assert.equal(native.sourceEvent.eventType,'file.changed');assert.match(native.watchExecutionStage.instructions,/先实际读取/);
      submitted.push({ input:native,workId: result.work.workId, snapshot: result.work.inputSnapshotId,
      text: await readFile(result.work.goalSources[0].sourceRef, "utf8") });
    }
    return result;
  }, flush: async () => {
    for (const row of submitted) for (const binding of works.repo.listBindings(row.workId)) if (binding.status === "pending")
      unwrap(works.reconcileExecution({ kind: "system", reason: "deterministic native fixture" }, { bindingId: binding.bindingId, outcome: "completed" }));
  }, onProgress: () => () => {}, wake: () => { void adapter.flush(); } } as Pick<WorkExecutionAdapter, "dispatch" | "flush" | "wake" | "onProgress">;
  queue = new WorkDispatchQueue(db, works, adapter as WorkExecutionAdapter, () => authority, () => undefined);
  queue.start();
}
async function close() { await queue.close(); db.close(); }
async function until(predicate: () => boolean, message: string, timeout = 7000) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) { await delay(50); await queue.drain(); }
  assert(predicate(), message);
}
const count = (id: string) => submitted.filter(item => item.workId === id).length;
const inboxCount = (id: string) => works.repo.listInbox(id, ["pending", "merged", "blocked", "processed", "skipped"]).length;
async function createWatch(target: string, policy: "latest" | "skip" = "latest") {
  const requestId = `file-request-${++calls}`;
  const request = messages.accept(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, requestId,
    text: `这是本地模拟PR，不是真实GitHub。持续等文件 ${target} 的下一次变化，仅变化时执行基准。` });
  const tools = botForegroundTools({ db: db.connection, userId: LOCAL_USER_ID, botId: DEFAULT_BOT_ID,
    conversationId: request.conversationId, bots, messages, works, isAuthority: () => authority,
    schedule: () => { throw Error("next_event must never schedule current state"); }, wake: () => queue.wake(), memorySearch: () => [] });
  const api = { callId: `call-${calls}`, taskId: `tool-${calls}`, memo: async () => requestId } as unknown as ToolExecutionApi;
  const args = { title: `Local simulated PR ${calls}`, requestedOutcome: "ongoing", mode: "watch", startImmediately: false,
    watchRule: { eventSource: "file", eventTarget: target, triggerMode: "next_event", executionMode: "continuous",
      catchUpPolicy: policy, scheduleBasis: "user_specified", notificationMode: "changes_only" } };
  const tool = tools.find(item => item.name === "work_create")!;
  const result = await tool.execute(args as never, api, BACKGROUND_CONTEXT);
  const text = result.output?.find(item => item.type === "text"); assert(text?.type === "text");
  const work = unwrap(JSON.parse(text.text));
  return { work, amendBaseline: async () => {
    const requestId = `file-amend-${++calls}`;
    messages.accept(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, requestId, conversationId: request.conversationId,
      selectedWorkId: work.workId, text: `将原事项 ${work.workId} 重新建立当前基线，只等下一次变化` });
    const readApi = { callId: `read-${calls}`, taskId: `read-${calls}`, memo: async () => requestId } as unknown as ToolExecutionApi;
    const detail = await tools.find(item => item.name === "work_query_status")!.execute({ workId: work.workId } as never, readApi, BACKGROUND_CONTEXT);
    const detailText = detail.output?.find(item => item.type === "text"); assert(detailText?.type === "text");
    const versionGuard = JSON.parse(detailText.text)[0].versionGuard;
    const amendApi = { callId: `amend-${calls}`, taskId: `amend-${calls}`, memo: async () => requestId } as unknown as ToolExecutionApi;
    const args = { workId: work.workId, versionGuard, watchRule: { eventSource: "file", eventTarget: target, triggerMode: "next_event" } };
    const amend = async () => {
      const result = await tools.find(item => item.name === "work_amend")!.execute(args as never, amendApi, BACKGROUND_CONTEXT);
      const text = result.output?.find(item => item.type === "text"); assert(text?.type === "text"); return JSON.parse(text.text);
    };
    unwrap(await amend()); assert.equal((await amend()).replayed, true, "amend replay retains original baseline and guard");
  }, replay: async () => {
    const replay = await tool.execute(args as never, api, BACKGROUND_CONTEXT);
    const text = replay.output?.find(item => item.type === "text"); assert(text?.type === "text"); return JSON.parse(text.text);
  } };
}
try {
  await writeFile(path, state(0)); open();
  assert.deepEqual(works.ingress.availableEventSources().map(item => item.source), ["file"], "only wired receiver is public");
  assert(works.ingress.adapter("hook"), "internal hook tests retain direct ingress support");
  const created = await createWatch(path), id = created.work.workId;
  const subscription = works.repo.listSubscriptions(id)[0];
  await queue.drain();
  assert.equal(created.work.goalSources[0].inputSnapshotId, hash(state(0)));
  assert.equal(created.work.inputSnapshotId, hash(state(0)));
  assert.equal(works.ingress.cursor(subscription.subscriptionId, "file", path)?.enumerationWatermark, hash(state(0)));
  // Receiver reconciliation must not hydrate thousands of unrelated scheduler rows.
  // These are explicitly synthetic scale-test subscriptions, never source events.
  db.connection.transaction(() => {
    for (let index = 0; index < 4096; index++) works.repo.insertSubscription({ ...subscription,
      subscriptionId: `perf-cron-${index}`, source: "cron", filter: { performanceFixture: "unrelated-cron" },
      sourceTarget: undefined, createdAt: index, updatedAt: index });
    works.repo.insertSubscription({ ...subscription, subscriptionId: "perf-stopped-file", stoppedAt: Date.now() });
  })();
  const plan = db.connection.prepare("EXPLAIN QUERY PLAN SELECT * FROM work_subscriptions WHERE source=? AND stopped_at IS NULL ORDER BY created_at ASC")
    .all("file") as Array<{ detail: string }>;
  assert(plan.some(row => row.detail.includes("SEARCH") && row.detail.includes("idx_work_subscriptions_source_active")), JSON.stringify(plan));
  assert(!plan.some(row => row.detail.includes("TEMP B-TREE")), "source index also supplies creation order");
  const originalParse = JSON.parse;
  let unrelatedHydrations = 0;
  JSON.parse = (value, reviver) => {
    if (value.includes('"performanceFixture":"unrelated-cron"')) unrelatedHydrations++;
    return originalParse(value, reviver);
  };
  try {
    assert.deepEqual(works.repo.listActiveSubscriptions("file").map(row => row.subscriptionId), [subscription.subscriptionId]);
    assert.deepEqual(works.repo.listActiveSubscriptions("absent-source"), []);
    await queue.drain();
    assert.equal(unrelatedHydrations, 0, "actual receiver flush never parses unrelated cron subscriptions");
    assert.equal(works.repo.listActiveSubscriptions().length, 4097, "omitted source retains original all-source behavior");
    assert(unrelatedHydrations >= 4096, "fixture instrumentation observes legacy all-source hydration");
  } finally {
    JSON.parse = originalParse;
    db.connection.prepare("DELETE FROM work_subscriptions WHERE subscription_id LIKE 'perf-%'").run();
  }
  console.log("PASS file receiver query: indexed source lookup, zero unrelated cron hydration, legacy all-source compatibility");
  await delay(1200); await queue.drain();
  assert.equal(count(id), 0, "next_event reads baseline without model dispatch");
  assert.equal(inboxCount(id), 0);
  await writeFile(path, state(1));
  await until(() => count(id) === 1, "real fs.watch reaches existing dispatch");
  assert.equal(submitted.at(-1)!.snapshot, hash(state(1)));
  assert.equal(JSON.parse(submitted.at(-1)!.text).simulated, true);
  const firstEvent = works.repo.listInbox(id, ["pending", "merged", "blocked", "processed", "skipped"]).find(event => event.eventType === "file.changed")!;
  assert.equal(firstEvent.payload.observation, "fs-watch");
  assert.equal(firstEvent.status, "processed");
  assert.equal(submitted.at(-1)!.input.sourceEvent.sourceVersion,hash(state(1)));
  const rootBinding=works.repo.listBindings(id).find(binding=>binding.inboxEventId===firstEvent.eventId)!;
  const continuationId='stage-continuation',stagePlan='stage-continuation-plan';
  works.repo.insertBinding({...rootBinding,bindingId:continuationId,operationId:continuationId,taskId:continuationId,inboxEventId:undefined,status:'completed'});
  db.connection.prepare("INSERT INTO work_continuation_plans(plan_id,work_id,source_binding_id,operation_id,intent_revision,input_snapshot_id,owner_epoch,owner_bot_id,gap_items_json,reason,state,created_at) VALUES (?,?,?,?,?,?,?,?,'[]','阶段续办','settled',?)").run(stagePlan,id,rootBinding.bindingId,stagePlan,rootBinding.intentRevision,rootBinding.inputSnapshotId,rootBinding.ownerEpoch,DEFAULT_BOT_ID,Date.now());
  db.connection.prepare("INSERT INTO work_dispatch_requests(operation_id,work_id,task_id,bot_id,intent_revision,input_snapshot_id,state,created_at,continuation_plan_id) VALUES (?,?,?,?,?,?,'dispatched',?,?)").run(stagePlan,id,continuationId,DEFAULT_BOT_ID,rootBinding.intentRevision,rootBinding.inputSnapshotId,Date.now(),stagePlan);
  const continuation=works.repo.getBinding(continuationId)!;
  const inherited=JSON.parse(works.repo.executionInput(continuation));assert.equal(inherited.watchExecutionStage.inboxEventId,firstEvent.eventId);assert.equal(inherited.watchExecutionStage.continuation,true);
  const mismatched={...continuation,inputSnapshotId:hash(state(0))};assert.equal(JSON.parse(works.repo.executionInput(mismatched)).watchExecutionStage,undefined,'old trigger cannot cross input version');

  assert.equal(works.getWork(id)!.goalSources[0].inputSnapshotId, hash(state(1)));
  const replay = await created.replay(); assert.equal(replay.replayed, true, "tool replay uses its original baseline identity");
  await writeFile(path, state(1)); await delay(1300); await queue.drain();
  assert.equal(count(id), 1); assert.equal(inboxCount(id), 1, "same bytes never enqueue duplicate writes");
  await writeFile(`${path}.replacement`, state(2)); await rename(`${path}.replacement`, path);
  await until(() => count(id) === 2, "atomic rename still watched");
  await writeFile(path, state(3)); await until(() => count(id) === 3, "replacement inode remains watched");
  // Source errors are visible, and restore is not falsely reported as unchanged success.
  const beforeMissing=count(id);await rm(path);
  await until(() => works.repo.listOpenBlockers(id).some(item => item.blockerId === `file-receiver:${subscription.subscriptionId}`), "missing source exposes blocker");assert.equal(count(id),beforeMissing,"failed source read never dispatches a fake trigger");
  assert.equal(count(id), 3);
  await assert.rejects(new WorkSourceObserver(works).readCurrent(works.getWork(id)!));
  await writeFile(path, state(4)); await until(() => count(id) === 4, "read error recovers on a real file event");
  assert(!works.repo.listOpenBlockers(id).some(item => item.blockerId.startsWith("file-receiver:")));
  // Pause releases listener. Resume reconciles only current latest state, explicitly marked catch-up.
  unwrap(works.pauseWork(actor, { operationId: "pause-file", workId: id, versionGuard: guard(id) })); await queue.drain();
  const beforePauseEvents = inboxCount(id);
  await writeFile(path, state(5)); await delay(300); assert.equal(inboxCount(id), beforePauseEvents);
  unwrap(works.resumeWork(actor, { operationId: "resume-file", workId: id, versionGuard: guard(id) }));
  await until(() => count(id) === 5, "resume latest catch-up");
  assert(works.repo.listInbox(id, ["pending", "merged", "blocked", "processed", "skipped"]).some(event => event.payload.observation === "current-state-catch-up"));
  // Host authority loss releases listener before any file read or ingress mutation.
  authority = false; await queue.drain(); const beforeLoss = inboxCount(id);
  await writeFile(path, state(6)); await delay(300); assert.equal(inboxCount(id), beforeLoss);
  authority = true; await until(() => count(id) === 6, "authority restoration latest catch-up");
  // Durable cursor survives a real DB close/reopen. Unchanged restart never replays old source.
  await close(); open(); await queue.drain(); await delay(1200); await queue.drain(); assert.equal(count(id), 6);
  await close(); await writeFile(path, state(7)); open(); await until(() => count(id) === 7, "offline change catches latest once");
  const skipPath = join(root, "skip.json"); await writeFile(skipPath, "skip-0");
  const skipId = (await createWatch(skipPath, "skip")).work.workId; await queue.drain();
  await close(); await writeFile(skipPath, "skip-1"); open(); await queue.drain(); await delay(300);
  assert.equal(count(skipId), 0, "skip policy never dispatches offline change");
  assert(works.repo.listInbox(skipId, ["pending", "merged", "blocked", "processed", "skipped"]).some(event => event.status === "skipped" && event.processReason === "offline-skip"));
  await writeFile(skipPath, "skip-2"); await until(() => count(skipId) === 1, "skip still handles online real change");
  // A frontend next_event reconfiguration uses a new true baseline, not stale cursor catch-up.
  const amendPath = join(root, "rebaseline.json"); await writeFile(amendPath, "baseline-0");
  const amended = await createWatch(amendPath); await queue.drain();
  const amendId = amended.work.workId;
  unwrap(works.pauseWork(actor, { operationId: "pause-rebaseline", workId: amendId, versionGuard: guard(amendId) })); await queue.drain();
  await writeFile(amendPath, "baseline-1"); await amended.amendBaseline();
  assert.equal(works.getWork(amendId)!.inputSnapshotId, hash("baseline-1"));
  unwrap(works.resumeWork(actor, { operationId: "resume-rebaseline", workId: amendId, versionGuard: guard(amendId) }));
  await queue.drain(); await delay(1200); await queue.drain(); assert.equal(count(amendId), 0);
  await writeFile(amendPath, "baseline-2"); await until(() => count(amendId) === 1, "new change after rebaseline executes once");
  const victim=works.getWork(skipId)!;
  const rejected=works.applyObservedSources(skipId,'wrong-work-trigger',victim,{inputSnapshotId:hash('fake'),sources:victim.goalSources},firstEvent.eventId);
  assert.equal(rejected.ok,false,'foreign Work event cannot be attached to a source update');
  const original=works.getWork(id)!;
  db.connection.prepare('UPDATE work_events_inbox SET intent_revision=intent_revision+1 WHERE event_id=?').run(firstEvent.eventId);
  const stale=works.applyObservedSources(id,'wrong-revision-trigger',original,{inputSnapshotId:hash('fake'),sources:original.goalSources},firstEvent.eventId);
  assert.equal(stale.ok,false,'mismatched event revision cannot supply execution stage');
  db.connection.prepare('UPDATE work_events_inbox SET intent_revision=intent_revision-1 WHERE event_id=?').run(firstEvent.eventId);
  // Events cannot redirect a configured source or supply a fake target hash.
  const bad = works.ingestSourceEvent({ source: "file", sourceEventId: "untrusted-target", eventType: "file.changed", timestamp: Date.now(),
    workId: id, subscriptionId: subscription.subscriptionId, payload: { target: skipPath, inputSnapshotId: "forged" } });
  assert.equal(bad.outcomes[0].reasonCode, "target-mismatch");
  unwrap(works.cancelWork(actor, { operationId: "cancel-file", workId: id, versionGuard: guard(id) })); await queue.drain();
  const beforeCancel = inboxCount(id); await writeFile(path, state(8)); await delay(300); assert.equal(inboxCount(id), beforeCancel);
  // Bounded reader rejects files beyond its cap, directories, and nonregular targets.
  const large = join(root, "too-large"); await writeFile(large, Buffer.alloc(MAX_WORK_FILE_BYTES + 1));
  await assert.rejects(readWorkFileSource(large), /上限/);
  await assert.rejects(readWorkFileSource(root), /常规文件/);
  await assert.rejects(readWorkFileSource("relative.txt"), /绝对/);
  if (process.platform !== "win32") {
    const link = join(root, "link"); await symlink(path, link); await assert.rejects(readWorkFileSource(link));
    const fifo = join(root, "fifo"); execFileSync("mkfifo", [fifo]);
    await Promise.race([assert.rejects(readWorkFileSource(fifo), /常规文件/), delay(1000).then(() => { throw Error("FIFO reader hung"); })]);
  }
  // Explicit cap refuses extra subscriptions visibly and never scans unconfigured paths.
  await queue.close();
  const capped = new WorkFileEventSource(works, () => authority, () => {}, 0);
  await capped.reconcile();
  assert(works.repo.listOpenBlockers(skipId).some(item => item.reason.includes("最多同时监听 0")));
  await capped.close();
  assert.equal(works.ingress.availableEventSources().length, 0, "closed receiver is not advertised");
  await writeFile(skipPath, "skip-after-close"); await delay(200); assert.equal(count(skipId), 1);
  db.close();
  console.log("PASS real file receiver: frontend baseline, fs.watch, atomic rename, hash dedupe, error/recovery, pause, authority, restart, skip, cancel, close, bounded IO");
} finally { await queue?.close(); try { db?.close(); } catch {} await rm(root, { recursive: true, force: true }); }

// Issue #57: actual receiver and SQLite cursor/Inbox with a deliberately held
// filesystem read. These are ordering assertions, not device latency benchmarks.
async function fileReadFlights() {
  const dir = await mkdtemp(join(tmpdir(), "work-file-flights-"));
  const database = new AppDatabase(join(dir, "fixture.db"));
  const registry = new BotRegistry(database.connection); registry.ensureDefaultBot(LOCAL_USER_ID);
  const service = new WorkService(database.connection, { bots: registry });
  const host = new WorkHostAuthority(database.connection, "file-flight-host", 60_000, () => 1000);
  assert(host.acquire().ok);
  const receivers: WorkFileEventSource[] = [];
  const timeline: string[] = [];
  const waitFor = async (check: () => boolean, label: string) => {
    for (let turn = 0; turn < 100 && !check(); turn++) await delay(5);
    assert(check(), label);
  };
  const deferred = <T,>() => {
    let resolve!: (value: T) => void, reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };
  const create = async (name: string) => {
    const target = join(dir, `${name}.txt`); await writeFile(target, `${name}-0`);
    const source = await readWorkFileSource(target);
    const work = unwrap(service.createWork(actor, { operationId: `flight:${name}`, title: name,
      authorization: DESKTOP_USER_GRANTS, mode: "watch", inputSnapshotId: source.inputSnapshotId, goalSources: [source],
      watchRule: { eventSource: "file", eventTarget: target, triggerMode: "next_event", executionMode: "continuous",
        catchUpPolicy: "latest", maxMergeWaitMs: 1, notificationMode: "changes_only" } }));
    return { target, source, work, subscription: service.repo.listSubscriptions(work.workId)[0] };
  };
  const events = (workId: string) => service.repo.listInbox(workId, ["pending", "merged", "blocked", "processed", "skipped"]);
  try {
    const a = await create("slow"), b = await create("fast");
    await writeFile(b.target, "fast-1");
    const gate = deferred<Awaited<ReturnType<typeof readWorkFileSource>>>();
    let slowReads = 0, activeReads = 0, peakReads = 0, slowSignal: AbortSignal | undefined;
    const receiver = new WorkFileEventSource(service, () => true, () => timeline.push("ingress-wake"), 2, {
      authorityIdentity: () => workHostLeaseIdentity(database.connection),
      read: async (target, options) => {
        activeReads++; peakReads = Math.max(peakReads, activeReads);
        try {
          if (target === a.target) { slowReads++; slowSignal = options?.signal; timeline.push("start:slow"); return await gate.promise; }
          timeline.push(`read:${target === b.target ? "fast" : "new"}`); return await readWorkFileSource(target, options);
        } finally { activeReads--; }
      },
    });
    receivers.push(receiver);
    await receiver.reconcile();
    await waitFor(() => slowReads === 1 && events(b.work.workId).length === 1, "independent initial file advances before held read returns");
    timeline.push("fast:ingested-before-slow");
    // Stop B to release its existing watcher slot; C is created after A entered.
    unwrap(service.pauseWork(actor, { operationId: "pause-fast", workId: b.work.workId }));
    await receiver.reconcile();
    const c = await create("new"); await writeFile(c.target, "new-1");
    await receiver.reconcile();
    await waitFor(() => events(c.work.workId).length === 1, "new file source advances during the held read");
    timeline.push("new:ingested-before-slow");
    for (let i = 0; i < 20; i++) await receiver.reconcile();
    assert.equal(slowReads, 1, "frequent reconcile does not duplicate a physical read");
    // Reconfiguration and a release/reacquire are invisible to a boolean that
    // is true at both ends. Lease identity and retained raw slots still fence A.
    host.release(); assert(host.acquire().ok);
    for (let i = 0; i < 20; i++) await receiver.reconcile();
    await delay(10);
    assert(slowSignal?.aborted, "reacquisition cancels the old receiver read");
    assert.equal(slowReads, 1, "an uncooperative old read keeps its per-subscription slot through reconfiguration");
    assert(peakReads <= 2, "actual I/O remains bounded, including detached operations");
    await receiver.close();
    const beforeClose = events(a.work.workId).length;
    gate.resolve({ ...a.source, inputSnapshotId: hash("late-stale") });
    await delay(10);
    assert.equal(events(a.work.workId).length, beforeClose, "late success after close cannot advance the cursor or Inbox");
    assert(!service.repo.listOpenBlockers(a.work.workId).length);
    timeline.push("slow:late-result-ignored");

    // A late failure after an amend must not create a blocker for the new input.
    const failure = deferred<Awaited<ReturnType<typeof readWorkFileSource>>>();
    let failureEntered = false;
    const staleError = new WorkFileEventSource(service, () => true, () => {}, 64, {
      read: async (target, options) => target === a.target ? (failureEntered = true, failure.promise) : readWorkFileSource(target, options),
    });
    receivers.push(staleError); await staleError.reconcile();
    await waitFor(() => failureEntered, "stale failure probe entered");
    unwrap(service.amendWork(actor, { operationId: "amend-during-file-read", workId: a.work.workId, title: "new file intent" }));
    failure.reject(new Error("old input read failed")); await staleError.drain();
    assert(!service.repo.listOpenBlockers(a.work.workId).some(blocker => blocker.blockerId.startsWith("file-receiver:")));
    await staleError.close();

    const deadlineGate = deferred<Awaited<ReturnType<typeof readWorkFileSource>>>();
    let deadlineSignal: AbortSignal | undefined, deadlineReads = 0;
    const deadline = new WorkFileEventSource(service, () => true, () => {}, 64, { timeoutMs: 20,
      read: async (target, options) => {
        if (target !== a.target) return readWorkFileSource(target, options);
        deadlineSignal = options?.signal; deadlineReads++; return deadlineGate.promise;
      },
    });
    receivers.push(deadline); await deadline.reconcile();
    await waitFor(() => service.repo.listOpenBlockers(a.work.workId).some(blocker => /超过 20/.test(blocker.reason)), "deadline exposes controlled failure");
    assert(deadlineSignal?.aborted);
    for (let i = 0; i < 20; i++) await deadline.reconcile();
    assert.equal(deadlineReads, 1, "timeout cannot duplicate unresolved physical I/O");
    await deadline.close();
    // Observe any accidental post-close access, including swallowed failures.
    let lateDatabaseReads = 0;
    const getWork = service.getWork.bind(service);
    service.getWork = workId => { if (!database.connection.open) lateDatabaseReads++; return getWork(workId); };
    database.close();
    deadlineGate.resolve(a.source); await delay(10);
    assert.equal(lateDatabaseReads, 0, "uncooperative result does not touch the closed database");
    console.log("PASS file source flights: independent/new source, single physical flight, bounded detach/reconfigure, lease fencing, stale error, timeout, close");
    console.log(`FILE_SOURCE_TIMELINE ${JSON.stringify(timeline)}`);
  } finally {
    for (const receiver of receivers) await receiver.close();
    if (database.connection.open) database.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function gitReadSafety() {
  const dir = await mkdtemp(join(tmpdir(), "work-git-source-"));
  const database = new AppDatabase(join(dir, "fixture.db"));
  const registry = new BotRegistry(database.connection); registry.ensureDefaultBot(LOCAL_USER_ID);
  const service = new WorkService(database.connection, { bots: registry });
  const observer = new WorkSourceObserver(service);
  const repo = join(dir, "repo"); await mkdir(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  try {
    git("init"); await writeFile(join(repo, "tracked.txt"), "before"); git("add", "tracked.txt");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "source fixture");
    const work = unwrap(service.createWork(actor, { operationId: "git-source", title: "Git source", authorization: DESKTOP_USER_GRANTS,
      goalSources: [{ sourceType: "git_commit", sourceRef: repo, inputSnapshotId: "initial", observedAt: Date.now() }] }));
    const initial = await observer.readCurrent(work);
    await writeFile(join(repo, "tracked.txt"), "after");
    assert.notEqual((await observer.readCurrent(work)).inputSnapshotId, initial.inputSnapshotId);
    await rm(join(repo, "tracked.txt"));
    const deleted = await observer.readCurrent(work);
    assert.notEqual(deleted.inputSnapshotId, initial.inputSnapshotId, "confirmed tracked deletion is observable");
    await mkdir(join(repo, "tracked.txt"));
    await assert.rejects(observer.readCurrent(work), /常规文件/, "unsupported content is a failure, never a fake unchanged snapshot");
    await rm(join(repo, "tracked.txt"), { recursive: true });
    if (process.platform !== "win32") {
      await symlink("missing-target", join(repo, "tracked.txt"));
      const link = await observer.readCurrent(work); assert.notEqual(link.inputSnapshotId, deleted.inputSnapshotId);
      await rm(join(repo, "tracked.txt"));
    }
    // A sparse file exercises the total budget without allocating or reading it.
    const { open } = await import("node:fs/promises");
    const large = await open(join(repo, "large.bin"), "w");
    await large.truncate(MAX_WORK_GIT_BYTES + 1); await large.close();
    await assert.rejects(observer.readCurrent(work), /读取上限/);
    const cancelled = new AbortController(); cancelled.abort(new Error("cancelled source"));
    await assert.rejects(observer.readCurrent(work, { signal: cancelled.signal }), /cancelled source/);
    await assert.rejects(readWorkFileSource(join(repo, "tracked.txt"), { signal: cancelled.signal }), /cancelled source/);
    let signal: AbortSignal | undefined, release!: () => void, settled = false;
    const physical = assert.rejects(withWorkSourceRead(async current => { signal = current; await new Promise<void>(resolve => { release = resolve; }); },
      { timeoutMs: 10, awaitSettlement: true }), /超过 10/).then(() => { settled = true; });
    await delay(25); assert(signal?.aborted); assert.equal(settled, false, "queue option exposes physical rather than raced settlement");
    release(); await physical;
    console.log("PASS authoritative source I/O: real Git content/deletion/link, unreadable rejection, byte budget, abort, physical settlement");
  } finally { database.close(); await rm(dir, { recursive: true, force: true }); }
}

await fileReadFlights();
await gitReadSafety();
