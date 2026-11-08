/**
 * Startup resume admission — Issue #17 A4/A5.
 *
 * The queue only ever bounds background startup work. Interactive opens bypass it, so these
 * cases pin the queue's own contract: width, FIFO order, dequeue re-check, failure isolation,
 * foreground claim and shutdown.
 */
import assert from "node:assert/strict";
import { DEFAULT_DURABLE_RESUME_CONCURRENCY, ResumeAdmission } from "../src/main/agent/durable/ResumeAdmission";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const tasks = (count: number) => Array.from({ length: count }, (_, index) => `t${index}`);

async function boundedWidthAndFifoOrder(): Promise<void> {
  let active = 0;
  let peak = 0;
  const started: string[] = [];
  const admission = new ResumeAdmission({
    concurrency: 3,
    shouldSkip: () => undefined,
    run: async (taskId) => {
      active += 1;
      peak = Math.max(peak, active);
      started.push(taskId);
      await sleep(4);
      active -= 1;
    },
  });
  const ids = tasks(9);
  admission.enqueue(ids);
  const report = await admission.drain();
  assert.equal(peak, 3, "background drain must not exceed the configured width");
  assert.equal(report.maxConcurrent, 3);
  assert.equal(report.concurrency, 3);
  assert.deepEqual(started, ids, "queued sessions start in enqueue order");
  assert.deepEqual(report.delivered, ids);
  assert.equal(report.pending, 0);
  assert.equal(report.enumerated, ids.length, "the report counts every enumerated binding");
  assert.equal(report.skipped.length + report.failed.length, 0);
}

async function failureReleasesItsSlot(): Promise<void> {
  const admission = new ResumeAdmission({
    concurrency: 2,
    shouldSkip: () => undefined,
    run: async (taskId) => {
      if (taskId === "t1") throw new Error("boom");
    },
  });
  admission.enqueue(tasks(4));
  const report = await admission.drain();
  assert.deepEqual(report.failed, [{ taskId: "t1", reason: "boom" }]);
  assert.deepEqual(report.delivered, ["t0", "t2", "t3"], "one failure must not strand the rest");
  assert.equal(report.pending, 0);
}

async function dequeueRechecksConditions(): Promise<void> {
  const ran: string[] = [];
  const admission = new ResumeAdmission({
    concurrency: 2,
    shouldSkip: (taskId) =>
      taskId === "t1" ? "trashed" : taskId === "t3" ? "binding-removed" : undefined,
    run: async (taskId) => { ran.push(taskId); },
  });
  admission.enqueue(tasks(4));
  const report = await admission.drain();
  assert.deepEqual(ran, ["t0", "t2"]);
  assert.deepEqual(report.skipped, [
    { taskId: "t1", reason: "trashed" },
    { taskId: "t3", reason: "binding-removed" },
  ]);
}

async function foregroundClaimTakesOwnership(): Promise<void> {
  const ran: string[] = [];
  const admission = new ResumeAdmission({
    concurrency: 1,
    shouldSkip: () => undefined,
    run: async (taskId) => {
      ran.push(taskId);
      await sleep(3);
    },
  });
  admission.enqueue(["a", "b", "c", "d"]);
  const draining = admission.drain();
  assert.equal(admission.claim("c"), true, "a queued session is claimed by interactive access");
  assert.equal(admission.claim("c"), false, "claiming twice changes nothing");
  assert.equal(admission.claim("a"), false, "a running session is not claimable");
  const report = await draining;
  assert.deepEqual(ran, ["a", "b", "d"], "the claimed session is not opened again by the drain");
  assert.deepEqual(report.claimed, ["c"]);
  assert.equal(report.enumerated, 4);
  assert.equal(report.pending, 0);
}

async function shutdownStopsScheduling(): Promise<void> {
  const admission = new ResumeAdmission({
    concurrency: 2,
    shouldSkip: () => undefined,
    run: async () => { await sleep(5); },
  });
  admission.enqueue(tasks(8));
  const draining = admission.drain();
  admission.cancel();
  const report = await draining;
  assert.equal(report.pending, 0);
  assert.ok(report.delivered.length <= 2, "only what already started before cancel is delivered");
  assert.equal(
    report.skipped.filter((item) => item.reason === "cancelled").length,
    8 - report.delivered.length,
    "queued sessions report a cancel reason instead of disappearing",
  );
}

async function drainIsSharedAndWidthIsClamped(): Promise<void> {
  const admission = new ResumeAdmission({
    concurrency: 0,
    shouldSkip: () => undefined,
    run: async () => { await sleep(2); },
  });
  admission.enqueue(tasks(3));
  const first = admission.drain();
  const second = admission.drain();
  assert.equal(first, second, "concurrent drains share one run");
  const report = await first;
  assert.equal(report.concurrency, 1, "a non-positive width is clamped to one");
  assert.equal(report.maxConcurrent, 1);
  assert.equal(DEFAULT_DURABLE_RESUME_CONCURRENCY, 4);
}

async function duplicateEnqueueIsIgnored(): Promise<void> {
  const ran: string[] = [];
  const admission = new ResumeAdmission({
    concurrency: 2,
    shouldSkip: () => undefined,
    run: async (taskId) => { ran.push(taskId); },
  });
  admission.enqueue(["a", "b", "a"]);
  const report = await admission.drain();
  assert.deepEqual(ran, ["a", "b"]);
  assert.equal(report.delivered.length, 2);
}

async function main(): Promise<void> {
  const tests = [
    boundedWidthAndFifoOrder,
    failureReleasesItsSlot,
    dequeueRechecksConditions,
    foregroundClaimTakesOwnership,
    shutdownStopsScheduling,
    drainIsSharedAndWidthIsClamped,
    duplicateEnqueueIsIgnored,
  ];
  for (const test of tests) {
    await test();
    console.log(`PASS ${test.name}`);
  }
  console.log(`[durable-resume-admission] ${tests.length} behavior groups passed`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
