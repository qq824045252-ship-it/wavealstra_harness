import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { WorkDispatchQueue, type WorkSourceDispatchOptions } from "../src/main/agent/work/WorkDispatchQueue";
import { WorkHostAuthority } from "../src/main/agent/work/WorkHostAuthority";
import { WorkExecutionAdapter, type WorkExecutionPort } from "../src/main/agent/work/WorkExecutionAdapter";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkControlResult, type WorkDto, type WorkSubscriptionDto } from "../src/shared/bot-work";
import type { AgentSubmissionReceipt } from "../src/shared/agent-ipc";

const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS };
const unwrap = (result: WorkControlResult) => {
  assert(result.ok, JSON.stringify(result)); return result.work;
};
function deferred() {
  let release = () => {};
  let fail: (error: Error) => void = () => {};
  const promise = new Promise<void>((resolve, reject) => { release = resolve; fail = reject; });
  return { promise, release, fail };
}
async function until(predicate: () => boolean, message: string) {
  for (let i = 0; i < 100 && !predicate(); i++) await delay(10);
  assert(predicate(), message);
}
const root = await mkdtemp(join(tmpdir(), "work-dispatch-concurrency-"));
async function fixture(name: string, sourceOptions: WorkSourceDispatchOptions = {}) {
  const db = new AppDatabase(join(root, `${name}.db`));
  const bots = new BotRegistry(db.connection); bots.ensureDefaultBot(LOCAL_USER_ID);
  const authority = { current: true };
  const works = new WorkService(db.connection, { bots, isAuthority: () => authority.current });
  const receipts = new Map<string, AgentSubmissionReceipt>();
  const submitted: string[] = [], inspected: string[] = [], stopped = new Set<string>();
  const completed = new Set<string>();
  const gates = new Map<string, ReturnType<typeof deferred>>();
  const heldGates = new Set<ReturnType<typeof deferred>>();
  const entered = new Set<string>();
  const calls = new Map<string, number>();
  const errors: unknown[] = [];
  const wait = async (stage: string, id: string) => {
    const key = `${stage}:${id}`; entered.add(key); calls.set(key, (calls.get(key) ?? 0) + 1); await gates.get(key)?.promise;
  };
  const native: WorkExecutionPort = {
    prepare: async taskId => {
      const row = db.connection.prepare("SELECT work_id FROM work_dispatch_requests WHERE task_id=?").get(taskId);
      const workId = row && typeof row === "object" && "work_id" in row ? String(row.work_id) : taskId;
      await wait("prepare", workId);
      return { taskId, durableStoreKey: `store:${taskId}`, conversationId: "1", workspaceBinding: root };
    },
    find: async binding => { await wait("find", binding.workId); return receipts.get(binding.bindingId); },
    submit: async binding => {
      submitted.push(binding.bindingId);
      const receipt: AgentSubmissionReceipt = { taskId: binding.taskId, operationId: binding.operationId, submissionId: 1, status: "placed" };
      receipts.set(binding.bindingId, receipt); await wait("submit", binding.workId); return receipt;
    },
    inspect: async binding => {
      inspected.push(binding.bindingId); await wait("inspect", binding.workId);
      return completed.has(binding.bindingId)
        ? { status: "completed", summary: `result:${binding.bindingId}`, hasWriteConflicts: false, artifactRefs: [], usageTokens: 2 }
        : stopped.has(binding.bindingId)
        ? { status: "stopped", summary: "original stopped result", hasWriteConflicts: false, artifactRefs: [], usageTokens: 0 }
        : { status: "running" };
    },
    stop: async binding => { await wait("stop", binding.workId); stopped.add(binding.bindingId); },
  };
  const adapter = new WorkExecutionAdapter(works, native, LOCAL_USER_ID, () => authority.current, (_id, error) => errors.push(error));
  const queue = new WorkDispatchQueue(db, works, adapter, () => authority.current, () => "fixture", undefined, undefined, undefined, sourceOptions);
  queue.start();
  const create = (id: string) => unwrap(works.createWork(user, { operationId: `${name}:${id}`, title: id,
    inputSnapshotId: `${name}:${id}`, authorization: DESKTOP_USER_GRANTS }));
  const enqueue = (work: ReturnType<typeof create>, id: string) => { works.transaction(() => queue.enqueue(work, id)); queue.wake(); };
  const binding = (id: string) => works.repo.listBindings(id)[0];
  return { db, works, adapter, queue, native, submitted, inspected, completed, gates, entered, calls, errors, create, enqueue, binding, authority,
    hold(stage: string, workId: string) { const gate = deferred(); heldGates.add(gate); gates.set(`${stage}:${workId}`, gate); return gate; },
    async close() {
      for (const gate of heldGates) gate.release();
      await queue.close(); await adapter.close();
      // Let any port fixture finish before closing SQLite, including the old implementation.
      await delay(20); if (db.connection.open) db.close();
    } };
}
function sourceSnapshot(work: WorkDto) {
  const inputSnapshotId = `sha256:observed-${work.workId}`;
  return { inputSnapshotId, sources: [{ sourceType: "file" as const,
    sourceRef: join(root, `${work.workId}.txt`), inputSnapshotId, observedAt: Date.now() }] };
}
function sourceEvent(f: Awaited<ReturnType<typeof fixture>>, work: WorkDto, policy: WorkSubscriptionDto["catchUpPolicy"] = "latest") {
  const subscribed = f.works.addSubscription(user, work.workId, { source: "hook", catchUpPolicy: policy,
    maxQueueDepth: 32, maxMergeWaitMs: 1 });
  assert(subscribed.ok && subscribed.subscription);
  const sub = subscribed.subscription;
  f.works.ingestSourceEvent({ workId: work.workId, subscriptionId: sub.subscriptionId, source: "hook",
    sourceEventId: `first:${work.workId}`, eventType: "changed", sourceVersion: "1", payload: { authoritativeReadbackRequired: policy === "latest" } });
  return sub;
}
try {
  {
    const held = deferred();
    const reads = new Map<string, number>();
    const timeline: string[] = [];
    const f = await fixture("source-independent", { sourceConcurrency: 2, readSource: async work => {
      reads.set(work.workId, (reads.get(work.workId) ?? 0) + 1);
      timeline.push(`source-start:${work.title}`);
      if (work.title === "A") await held.promise;
      timeline.push(`source-finish:${work.title}`);
      return sourceSnapshot(work);
    } });
    try {
      const submit = f.native.submit;
      f.native.submit = async (binding, options) => {
        timeline.push(`dispatch:${f.works.getWork(binding.workId)!.title}`);
        return submit(binding, options);
      };
      const a = f.create("A"), b = f.create("B");
      timeline.push("receive:A-source", "receive:B-dispatch");
      sourceEvent(f, a); f.enqueue(b, "source-independent:B");
      await delay(2); await f.queue.flush();
      await until(() => reads.has(a.workId), "A source read is held");
      await until(() => f.binding(b.workId)?.status === "running", "B pending dispatch runs before A source returns");
      const c = f.create("C"), d = f.create("D");
      timeline.push("receive:C-dispatch", "receive:D-source");
      f.enqueue(c, "source-independent:C"); sourceEvent(f, d);
      await delay(2); await f.queue.flush();
      await until(() => f.binding(c.workId)?.status === "running" && f.binding(d.workId)?.status === "running",
        "new C and independent D source advance while A remains held");
      for (let i = 0; i < 10; i++) await f.queue.flush();
      assert.equal(reads.get(a.workId), 1, "repeated wakes do not duplicate one source read");
      assert(!timeline.includes("source-finish:A"));
      assert(["dispatch:B", "dispatch:C", "dispatch:D"].every(event => timeline.includes(event)));
      console.log(`PASS source independence timeline (controlled I/O, real SQLite; ordered events before A release): ${JSON.stringify(timeline.map((event, ordinal) => ({ ordinal, event })))}`);
      held.release(); await f.queue.drain();
      assert.equal(f.works.repo.listInbox(a.workId, ["processed"]).length, 1);
    } finally { held.release(); await f.close(); }
  }
  {
    const reads: string[] = [], gates = new Map<string, ReturnType<typeof deferred>>();
    let active = 0, peak = 0;
    const f = await fixture("source-capacity", { sourceConcurrency: 2, readSource: async work => {
      reads.push(work.workId); active++; peak = Math.max(peak, active);
      try { await gates.get(work.workId)!.promise; return sourceSnapshot(work); } finally { active--; }
    } });
    try {
      const inputs = Array.from({ length: 10 }, (_, index) => f.create(`source-${index}`));
      for (const work of inputs) { gates.set(work.workId, deferred()); sourceEvent(f, work); }
      await delay(2); await f.queue.flush();
      await until(() => reads.length === 2, "exactly two sources enter the bounded pool");
      for (let i = 0; i < 10; i++) await f.queue.flush();
      assert.equal(reads.length, 2);
      const each = f.create("immutable-each"); sourceEvent(f, each, "each");
      await f.queue.flush();
      await until(() => f.binding(each.workId)?.status === "running", "each event without source I/O advances through a full source pool");
      assert.equal(reads.length, 2, "each uses its immutable event, never a readback slot");
      const heldWork = reads[0];
      // Keep one slot hung throughout; each completed second slot serves another durable obligation.
      for (let count = 2; count < inputs.length; count++) {
        gates.get(reads[count - 1])!.release();
        await until(() => reads.length === count + 1, `pending source ${count + 1} is fairly admitted`);
      }
      assert.equal(peak, 2); assert.equal(new Set(reads).size, inputs.length);
      assert.equal(f.works.repo.listInbox(heldWork, ["processed"]).length, 0);
      for (const gate of gates.values()) gate.release();
      await f.queue.drain();
      assert(inputs.every(work => f.works.repo.listInbox(work.workId, ["processed"]).length === 1));
      console.log("PASS bounded source I/O, repeated wakes and fair durable Inbox continuation");
    } finally { for (const gate of gates.values()) gate.release(); await f.close(); }
  }
  for (const change of ["amend", "pause", "cancel", "owner", "authority", "lease"] as const) for (const rejects of [false, true]) {
    const held = deferred(), next = deferred();
    let reads = 0;
    const f = await fixture(`source-stale-${change}-${rejects}`, { readSource: async work => {
      await (++reads === 1 ? held.promise : next.promise); return sourceSnapshot(work);
    } });
    try {
      const lease = new WorkHostAuthority(f.db.connection, "source-fixture-lease");
      if (change === "lease") assert(lease.acquire().ok);
      const a = f.create("A"); sourceEvent(f, a);
      await delay(2); await f.queue.flush();
      await until(() => reads === 1, "original source read entered");
      if (change === "amend") unwrap(f.works.amendWork(user, { operationId: "source:amend", workId: a.workId, inputSnapshotId: "amended-input" }));
      if (change === "pause") unwrap(f.works.pauseWork(user, { operationId: "source:pause", workId: a.workId }));
      if (change === "cancel") unwrap(f.works.cancelWork(user, { operationId: "source:cancel", workId: a.workId }));
      if (change === "owner") {
        new BotRegistry(f.db.connection).registerBot({ botId: "source-next-owner", userId: LOCAL_USER_ID,
          displayName: "next owner", authorization: DESKTOP_USER_GRANTS });
        unwrap(f.works.handoffOwner(user, { operationId: "source:owner", workId: a.workId, targetBotId: "source-next-owner" }));
      }
      if (change === "authority") f.authority.current = false;
      if (change === "lease") { lease.release(); assert(lease.acquire().ok); }
      const revised = f.works.getWork(a.workId)!;
      // Abort-ignoring reads still occupy their actual I/O slot and Work identity.
      for (let i = 0; i < 5; i++) await f.queue.flush();
      assert.equal(reads, 1);
      if (rejects) held.fail(Error("obsolete source failure")); else held.release();
      await delay(20);
      assert.equal(f.works.getWork(a.workId)?.inputSnapshotId, revised.inputSnapshotId);
      assert.equal(f.works.repo.listInbox(a.workId, ["processed"]).length, 0);
      assert(!f.works.repo.listOpenBlockers(a.workId).some(blocker => blocker.blockerId.startsWith("source-readback:")),
        "stale success/failure cannot create a blocker for newer input or owner");
      console.log(`PASS stale source ${rejects ? "failure" : "reply"} fenced after ${change}`);
    } finally { await f.queue.close(); held.release(); next.release(); await f.close(); }
  }
  for (const rejects of [false, true]) {
    const held = deferred(); let reads = 0;
    const f = await fixture(`source-stop-subscription-${rejects}`, { readSource: async work => {
      if (++reads === 1) await held.promise; return sourceSnapshot(work);
    } });
    try {
      const a = f.create("A"), first = sourceEvent(f, a);
      const added = f.works.addSubscription(user, a.workId, { subscriptionId: "active-sibling", source: "hook", catchUpPolicy: "latest",
        maxQueueDepth: 32, maxMergeWaitMs: 1 });
      assert(added.ok && added.subscription);
      const sibling = added.subscription;
      assert.notEqual(sibling.subscriptionId, first.subscriptionId);
      await delay(2); await f.queue.flush(); await until(() => reads === 1, "first subscription source read entered");
      const original = f.works.repo.listInbox(a.workId)[0];
      const before = f.works.getWork(a.workId)!;
      assert(f.works.stopSubscription(user, a.workId, first.subscriptionId).ok);
      assert.equal(f.works.getWork(a.workId)?.stateVersion, before.stateVersion,
        "stopping one same-source subscription does not necessarily change the Work version");
      // No flush between stop and resolution: the late-result guard must discover the stopped subscription itself.
      if (rejects) held.fail(Error("stopped subscription reader failed")); else held.release();
      await delay(20);
      assert.equal(reads, 1, "a stopped subscription is not read again");
      assert.equal(f.works.getWork(a.workId)?.inputSnapshotId, before.inputSnapshotId);
      assert.equal(f.works.repo.getInbox(original.eventId)?.status, original.status);
      assert(!f.works.repo.getBlocker(`source-readback:${original.eventId}`), "late stopped-subscription result cannot add a stale blocker");
      f.works.ingestSourceEvent({ workId: a.workId, subscriptionId: sibling.subscriptionId, source: "hook",
        sourceEventId: "active-sibling-event", eventType: "changed", sourceVersion: "1", payload: { authoritativeReadbackRequired: true } });
      await delay(2); await f.queue.drain();
      assert.equal(reads, 2, "active sibling advances past the stopped subscription's original Inbox row");
      assert.equal(f.works.repo.listInbox(a.workId, ["processed"]).filter(event => event.subscriptionId === sibling.subscriptionId).length, 1);
      assert.equal(f.binding(a.workId)?.status, "running");
      assert.equal(f.works.repo.getInbox(original.eventId)?.status, original.status);
      console.log(`PASS stopped subscription ${rejects ? "failure" : "reply"} fenced without Work version change; active sibling dispatches`);
    } finally { held.release(); await f.close(); }
  }
  {
    let reads = 0;
    const f = await fixture("source-failure", { readSource: async work => {
      if (++reads === 1) throw Error("controlled source unavailable"); return sourceSnapshot(work);
    } });
    try {
      const a = f.create("A"); sourceEvent(f, a);
      await delay(2); await f.queue.flush();
      const eventId = f.works.repo.listInbox(a.workId, ["pending", "merged", "blocked"])[0].eventId;
      await until(() => f.works.repo.getInbox(eventId)?.status === "blocked", "failed read remains an original blocked obligation");
      for (let i = 0; i < 20; i++) await f.queue.flush();
      assert.equal(reads, 1, "overflow refill cannot restart failed source reads");
      const b = f.create("B"); f.enqueue(b, "source-failure:B");
      await until(() => f.binding(b.workId)?.status === "running", "source failure does not block independent dispatch");
      unwrap(f.works.pauseWork(user, { operationId: "source-failure:pause", workId: a.workId }));
      unwrap(f.works.resumeWork(user, { operationId: "source-failure:resume", workId: a.workId }));
      await f.queue.drain();
      assert.equal(f.works.repo.getInbox(eventId)?.status, "processed"); assert.equal(reads, 2);
      console.log("PASS source rejection, no retry storm and same-event resume");
    } finally { await f.close(); }
  }
  {
    const held = deferred(); let reads = 0;
    const f = await fixture("source-timeout", { sourceReadTimeoutMs: 30, readSource: async work => {
      reads++; if (reads === 1) await held.promise; return sourceSnapshot(work);
    } });
    try {
      const a = f.create("A"); sourceEvent(f, a);
      await delay(2); await f.queue.flush();
      await until(() => reads === 1, "timed source read entered");
      const eventId = f.works.repo.listInbox(a.workId)[0].eventId;
      await until(() => f.works.repo.getInbox(eventId)?.status === "blocked", "deadline records controlled failure on original event");
      for (let i = 0; i < 10; i++) await f.queue.flush();
      assert.equal(reads, 1, "timeouts do not loop or lose the physical I/O slot");
      const b = f.create("B"); f.enqueue(b, "source-timeout:B");
      await until(() => f.binding(b.workId)?.status === "running", "unrelated Work dispatches while timed-out physical read remains pending");
      held.release(); await delay(5);
      assert.equal(f.works.repo.getInbox(eventId)?.status, "blocked");
      unwrap(f.works.pauseWork(user, { operationId: "source-timeout:pause", workId: a.workId }));
      unwrap(f.works.resumeWork(user, { operationId: "source-timeout:resume", workId: a.workId }));
      await f.queue.drain();
      assert.equal(f.works.repo.getInbox(eventId)?.status, "processed");
      assert.equal(f.works.repo.listInbox(a.workId, ["pending", "merged", "blocked", "processed", "skipped"]).length, 1,
        "recovery uses original event identity");
      assert.equal(reads, 2);
      console.log("PASS source deadline, unrelated dispatch and same-event recovery without retry storm");
    } finally { held.release(); await f.close(); }
  }
  for (const rejects of [false, true]) {
    const held = deferred(); let entered = false;
    const f = await fixture(`source-close-${rejects}`, { readSource: async work => {
      entered = true; await held.promise; return sourceSnapshot(work);
    } });
    try {
      const a = f.create("A"); sourceEvent(f, a);
      await delay(2); await f.queue.flush(); await until(() => entered, "source held before close");
      let closed = false; void f.queue.close().then(() => { closed = true; });
      await until(() => closed, "queue close does not wait for an abort-ignoring source reader");
      await f.adapter.close(); f.db.close();
      if (rejects) held.fail(Error("late source rejection after SQLite close")); else held.release();
      await delay(20); await f.queue.flush();
      console.log(`PASS late source ${rejects ? "failure" : "reply"} cannot access closed SQLite`);
    } finally { held.release(); await f.close(); }
  }
  for (const stage of ["find", "inspect", "stop", "prepare", "submit"] as const) {
    const f = await fixture(stage);
    try {
      const a = f.create("A"), b = f.create("B");
      f.enqueue(a, "dispatch:A"); f.enqueue(b, "dispatch:B");
      await until(() => f.binding(a.workId)?.status === "running" && f.binding(b.workId)?.status === "running", "A and B start");
      const original = f.binding(a.workId)!;
      const gate = f.hold(stage, a.workId);
      if (stage === "stop") unwrap(f.works.cancelWork(user, { operationId: "cancel:A", workId: a.workId }));
      if (stage === "prepare" || stage === "submit") {
        const revised = unwrap(f.works.amendWork(user, { operationId: "revise:A", workId: a.workId, inputSnapshotId: "new-input" }));
        f.enqueue(revised, "dispatch:A:new");
      }
      f.entered.delete(`${stage}:${a.workId}`);
      f.adapter.wake(); f.queue.wake();
      await until(() => f.entered.has(`${stage}:${a.workId}`), `A enters held ${stage}`);
      const before = f.inspected.filter(id => id === f.binding(b.workId)?.bindingId).length;
      f.adapter.wake();
      await until(() => f.inspected.filter(id => id === f.binding(b.workId)?.bindingId).length > before, `B advances while A ${stage} hangs`);
      const c = f.create("C"); f.enqueue(c, "dispatch:C");
      await until(() => f.binding(c.workId)?.status === "running", `C starts while A ${stage} hangs`);
      let flushed = false; void f.queue.flush().then(() => { flushed = true; });
      await until(() => flushed, "dispatch pass returns without waiting for native calls");
      // Repeated wakes cannot duplicate the same in-flight request or submission.
      const count = f.calls.get(`${stage}:${a.workId}`);
      for (let i = 0; i < 5; i++) { f.adapter.wake(); f.queue.wake(); }
      await f.queue.flush();
      assert.equal(f.calls.get(`${stage}:${a.workId}`), count, "one native operation stays in flight across wakeups");
      unwrap(f.works.cancelWork(user, { operationId: "final-cancel:A", workId: a.workId }));
      gate.release(); f.adapter.wake(); f.queue.wake();
      await until(() => f.works.getWork(a.workId)?.lifecycle === "closed", "late native receipt settles the cancelled work");
      assert.equal(f.works.repo.getBinding(original.bindingId)?.taskId, original.taskId);
      assert(!f.works.getWork(a.workId)?.activeExecutionIds.length, "late receipt cannot reactivate cancelled executions");
      assert.equal(new Set(f.submitted).size, f.submitted.length, "one submit per binding");
      assert.deepEqual(f.errors, []);
      console.log(`PASS independent dispatch and late cancellation: ${stage}`);
    } finally { await f.close(); }
  }
  {
    const f = await fixture("team-prepare");
    try {
      const team = (name: string) => {
        for (const suffix of ["owner", "member"]) new BotRegistry(f.db.connection).registerBot({
          botId: `${name}:${suffix}`, userId: LOCAL_USER_ID, displayName: `${name} ${suffix}`, authorization: DESKTOP_USER_GRANTS });
        const request = { operationId: name,
          title: name, goalDescription: "verify independent team dispatch", ownerBotId: `${name}:owner`,
          ownerResponsibility: "summarize original receipts", workspacePath: root, criteria: ["verify source evidence"],
          members: [{ botId: `${name}:member`, responsibility: "read source", delegatedScope: ["workspace:read"] }] };
        const saved = f.works.teams.handle(user, { kind: "save_template", request: { operationId: `saved:${name}`, name,
          plan: { ownerBotId: request.ownerBotId, ownerResponsibility: request.ownerResponsibility, members: request.members } } });
        assert(saved.ok && saved.template);
        const result = f.works.teams.handle(user, { kind: "create", request: { ...request, templateId: saved.template.templateId } });
        assert(result.ok && result.work && result.team, JSON.stringify(result)); return { work: result.work, team: result.team };
      };
      const a = team("A"), firstTask = a.team.executions[0].taskId;
      const gate = f.hold("prepare", firstTask); f.queue.wake();
      await until(() => f.entered.has(`prepare:${firstTask}`), "team A preparation hangs");
      const b = team("B"), c = f.create("C"); f.enqueue(c, "dispatch:C");
      await until(() => f.binding(b.work.workId)?.status === "running" && f.binding(c.workId)?.status === "running", "another team and normal Work start during team A preparation");
      unwrap(f.works.cancelWork(user, { operationId: "cancel:team-A", workId: a.work.workId })); gate.release();
      await delay(20);
      assert.equal(f.works.repo.listBindings(a.work.workId).length, 0, "cancelled team's late preparation cannot create a binding");
      assert.deepEqual(f.errors, []);
      console.log("PASS hung team prepare cannot block another team or ordinary Work");
    } finally { await f.close(); }
  }
  {
    const f = await fixture("same-team-prepare");
    try {
      for (const suffix of ["owner", "one", "two", "three"]) new BotRegistry(f.db.connection).registerBot({
        botId: `parallel:${suffix}`, userId: LOCAL_USER_ID, displayName: suffix, authorization: DESKTOP_USER_GRANTS });
      const request = { operationId: "parallel-team",
        title: "parallel preparation", goalDescription: "read independent evidence", ownerBotId: "parallel:owner",
        ownerResponsibility: "summarize", workspacePath: root, criteria: ["verify source"], executionPolicy: "parallel", maxConcurrency: 2,
        members: ["one", "two", "three"].map(id => ({ botId: `parallel:${id}`, responsibility: "read source", delegatedScope: ["workspace:read"] })) };
      const saved = f.works.teams.handle(user, { kind: "save_template", request: { operationId: "saved:parallel", name: "Parallel team",
        plan: { ownerBotId: request.ownerBotId, ownerResponsibility: request.ownerResponsibility, members: request.members,
          executionPolicy: "parallel", maxConcurrency: 2 } } });
      assert(saved.ok && saved.template);
      const result = f.works.teams.handle(user, { kind: "create", request: { ...request, templateId: saved.template.templateId } });
      assert(result.ok && result.work && result.team, JSON.stringify(result));
      const [a, b, c] = result.team.executions;
      const gateA = f.hold("prepare", a.taskId), gateB = f.hold("prepare", b.taskId), gateC = f.hold("prepare", c.taskId);
      f.queue.wake();
      await until(() => f.entered.has(`prepare:${a.taskId}`) && f.entered.has(`prepare:${b.taskId}`), "two independent members prepare concurrently");
      for (let i = 0; i < 20; i++) await f.queue.flush();
      assert(!f.entered.has(`prepare:${c.taskId}`), "pending preparation occupies a concurrency slot");
      assert.equal(f.calls.get(`prepare:${a.taskId}`), 1);
      assert.equal(f.calls.get(`prepare:${b.taskId}`), 1);
      gateA.release();
      await until(() => f.works.repo.bindingForTask(a.taskId)?.status === "running", "first preparation becomes a running binding");
      for (let i = 0; i < 20; i++) await f.queue.flush();
      assert(!f.entered.has(`prepare:${c.taskId}`), "running plus preparing still occupies exactly two slots");
      f.completed.add(f.works.repo.bindingForTask(a.taskId)!.bindingId); f.adapter.wake(); f.queue.wake();
      await until(() => f.entered.has(`prepare:${c.taskId}`), "settlement releases one slot for the third member");
      unwrap(f.works.cancelWork(user, { operationId: "cancel:parallel-team", workId: result.work.workId }));
      gateB.release(); gateC.release();
      await delay(30);
      assert.equal(f.works.repo.bindingForTask(b.taskId), undefined);
      assert.equal(f.works.repo.bindingForTask(c.taskId), undefined);
      assert.deepEqual(f.errors, []);
      console.log("PASS parallel same-team preparation, exact slot accounting, duplicate wakes and late cancellation");
    } finally { await f.close(); }
  }
  // A late completed result belongs to the old input; it must not stop or replace the new root.
  {
    const f = await fixture("amended-input");
    try {
      const a = f.create("A"); f.enqueue(a, "dispatch:A");
      await until(() => f.binding(a.workId)?.status === "running", "original root starts");
      const original = f.binding(a.workId)!;
      const gate = f.hold("inspect", a.workId); f.entered.delete(`inspect:${a.workId}`); f.adapter.wake();
      await until(() => f.entered.has(`inspect:${a.workId}`), "old result read is in flight");
      // Only the original inspect keeps this promise; the new input can be read independently.
      f.gates.delete(`inspect:${a.workId}`);
      const amended = unwrap(f.works.amendWork(user, { operationId: "amend:A", workId: a.workId, inputSnapshotId: "revised-source" }));
      f.enqueue(amended, "dispatch:A:new");
      const current = () => f.works.repo.listBindings(a.workId).find(binding => binding.inputSnapshotId === "revised-source");
      await until(() => current()?.status === "running", "new input starts while old observation hangs");
      f.completed.add(original.bindingId); gate.release();
      await until(() => f.works.repo.listDeliverables(a.workId).some(result => result.executionId === original.bindingId), "old result is retained");
      assert.equal(current()?.status, "running");
      assert.equal(f.works.getWork(a.workId)?.inputSnapshotId, "revised-source");
      assert(f.works.repo.listDeliverables(a.workId).filter(result => result.executionId === original.bindingId).every(result => result.status === "superseded"));
      assert.equal(f.submitted.length, 2); assert.deepEqual(f.errors, []);
      console.log("PASS late result retains original identity after amendment");
    } finally { await f.close(); }
  }
  for (const stage of ["find", "inspect", "stop", "prepare", "submit"] as const) for (const rejects of [false, true]) {
    const f = await fixture(`close-${stage}-${rejects}`);
    try {
      const a = f.create("A");
      let gate: ReturnType<typeof deferred>;
      if (stage === "stop") {
        f.enqueue(a, "dispatch:A"); await until(() => f.binding(a.workId)?.status === "running", "root starts before stop");
        gate = f.hold(stage, a.workId);
        unwrap(f.works.cancelWork(user, { operationId: "cancel:A", workId: a.workId })); f.adapter.wake();
      } else { gate = f.hold(stage, a.workId); f.enqueue(a, "dispatch:A"); }
      await until(() => f.entered.has(`${stage}:${a.workId}`), `native ${stage} remains pending at close`);
      let closed = false;
      void (async () => { await f.queue.close(); await f.adapter.close(); closed = true; })();
      await until(() => closed, "shutdown completes without a native receipt");
      const state = f.works.getWork(a.workId), bindings = f.works.repo.listBindings(a.workId);
      const count = f.submitted.length;
      if (rejects) gate.fail(new Error("late native failure")); else gate.release();
      await delay(20);
      assert.deepEqual(f.works.getWork(a.workId), state, "late reply cannot write after close");
      assert.deepEqual(f.works.repo.listBindings(a.workId), bindings);
      assert.equal(f.submitted.length, count); assert.deepEqual(f.errors, []);
      // A subsequent wake is inert, including after the database has closed.
      f.db.close(); f.adapter.wake(); f.queue.wake();
      console.log(`PASS shutdown ignores late ${rejects ? "failure" : "reply"}: ${stage}`);
    } finally { await f.close(); }
  }
} finally { await rm(root, { recursive: true, force: true }); }
