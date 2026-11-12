import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { CronService, type CronAgent } from "../src/main/cron/CronService";
import type { AgentPromptRequest } from "../src/shared/agent-ipc";

const drain = () => new Promise<void>(resolve => setImmediate(resolve));
async function advance(ms: number) { mock.timers.tick(ms); await drain(); }

function setup(failFirst = false) {
  const root = mkdtempSync(join(tmpdir(), "cron-continuity-"));
  const path = join(root, "app.db");
  let db = new AppDatabase(path);
  mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.UTC(2035, 0, 1) });
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const prompts: AgentPromptRequest[] = [];
  let active = 0;
  let maxActive = 0;
  const agent: CronAgent = {
    prompt: async request => {
      prompts.push(request); active++; maxActive = Math.max(active, maxActive);
      await gate; active--;
      if (failFirst && prompts.length === 1) throw new Error("first execution failed");
      return { queued: true, receipt: { taskId: request.taskId, operationId: request.userMessageId!, submissionId: prompts.length, status: "queued" } };
    },
    waitForSubmission: async receipt => ({ queued: false, receipt: { ...receipt, status: "done" } }),
    loadTaskHistory: async () => ({ messages: [] }), isTaskBusy: () => false,
    getAppSettings: () => ({}), resolveAvailableModelId: async () => undefined,
    listSkills: () => [], listConnectors: () => [],
  };
  let cron = new CronService(db, agent);
  const job = cron.upsert({ id: "plan", name: "计划", prompt: "check", enabled: true,
    scheduleType: "every", scheduleExpr: "1h", timezone: "UTC", createdAt: Date.now(), updatedAt: Date.now() });
  return {
    get db() { return db; }, get cron() { return cron; }, job, prompts, release,
    get maxActive() { return maxActive; },
    restart() { cron.stop(); db.close(); db = new AppDatabase(path); cron = new CronService(db, agent); cron.start(); },
    async close() { release(); await drain(); cron.stop(); db.close(); mock.timers.reset(); rmSync(root, { recursive: true, force: true }); },
  };
}

export async function testSchedulingContinuity() {
  for (const action of ["reschedule", "multi-reschedule", "pause-resume", "future-timer", "unchanged", "quota"] as const) {
    const f = setup();
    try {
      await advance(3600000); assert.equal(f.prompts.length, 1);
      if (action === "pause-resume") { f.cron.setEnabled(f.job.id, false); f.cron.setEnabled(f.job.id, true); }
      else if (action !== "unchanged") f.cron.upsert({ ...f.job, scheduleExpr: "60s", ...(action === "quota" ? { maxRuns: 2 } : {}) });
      if (action === "multi-reschedule") { f.cron.upsert({ ...f.job, scheduleExpr: "30s" }); f.cron.upsert({ ...f.job, scheduleExpr: "60s" }); }
      const interval = action === "pause-resume" || action === "unchanged" ? 3600000 : 60000;
      await advance(action === "future-timer" ? interval / 2 : interval);
      assert.equal(f.prompts.length, 1, "a busy plan cannot execute concurrently");
      f.release(); await drain();
      assert.equal(f.db.listCronRuns().filter(r => r.status === "success").length, 1);
      await advance(action === "future-timer" ? interval / 2 : interval);
      assert.equal(f.prompts.length, 2, `#44 ${action}: the next real occurrence must execute after the busy timer was consumed`);
      await advance(interval);
      assert.equal(f.prompts.length, action === "quota" ? 2 : 3);
      assert.equal(f.maxActive, 1);
      if (action !== "quota") {
        f.restart(); await advance(interval); assert.equal(f.prompts.length, 4, "reopened service continues executing");
      } else assert.equal(f.db.getCronJob(f.job.id)?.enabled, false);
      console.log(`PASS #44 subsequent real executions, no overlap, restart: ${action}`);
    } finally { await f.close(); }
  }
  for (const action of ["pause", "delete", "stop", "deadline"] as const) {
    const f = setup();
    try {
      await advance(3600000);
      f.cron.upsert({ ...f.job, scheduleExpr: "60s" });
      await advance(60000); assert.equal(f.prompts.length, 1);
      if (action === "pause") f.cron.setEnabled(f.job.id, false);
      else if (action === "delete") f.cron.remove(f.job.id);
      else if (action === "stop") f.cron.stop();
      else f.cron.upsert({ ...f.job, scheduleExpr: "60s", effectiveTo: Date.now() + 30000 });
      f.release(); await drain();
      for (let i = 0; i < 3; i++) await advance(60000);
      assert.equal(f.prompts.length, 1, `old completion cannot revive a ${action} plan`);
      if (action === "pause" || action === "delete") {
        f.restart(); await advance(3600000); assert.equal(f.prompts.length, 1);
      }
      console.log(`PASS #44 completion respects ${action} after the new timer is consumed`);
    } finally { await f.close(); }
  }
  const failed = setup(true);
  try {
    await advance(3600000); failed.cron.upsert({ ...failed.job, scheduleExpr: "60s" });
    await advance(60000); failed.release(); await drain();
    assert.equal(failed.db.listCronRuns().filter(r => r.status === "error").length, 1);
    await advance(60000); assert.equal(failed.prompts.length, 2);
    await advance(60000); assert.equal(failed.prompts.length, 3);
    assert.equal(failed.maxActive, 1);
    console.log("PASS #44 failed old run still reconciles the latest schedule");
  } finally { await failed.close(); }
  const interrupted = setup();
  try {
    await advance(3600000);
    interrupted.cron.upsert({ ...interrupted.job, scheduleExpr: "60s" });
    await advance(60000);
    interrupted.cron.stop(); interrupted.release(); await drain();
    interrupted.restart(); await drain();
    assert.equal(interrupted.prompts.length, 2);
    assert.equal(interrupted.prompts[1].userMessageId, interrupted.prompts[0].userMessageId, "restart replays the saved operation identity");
    await advance(60000); assert.equal(interrupted.prompts.length, 3);
    await advance(60000); assert.equal(interrupted.prompts.length, 4);
    assert.equal(interrupted.maxActive, 1);
    console.log("PASS #44 interrupted run reopens with its saved identity and continues on the changed schedule");
  } finally { await interrupted.close(); }
  const oneTime = setup();
  try {
    await advance(3600000);
    oneTime.cron.upsert({ ...oneTime.job, scheduleType: "at", scheduleExpr: new Date(Date.now() + 120000).toISOString() });
    await advance(60000); oneTime.release(); await drain();
    assert.equal(oneTime.db.getCronJob(oneTime.job.id)?.enabled, true, "the old revision cannot consume the new one-time schedule");
    await advance(60000); assert.equal(oneTime.prompts.length, 2);
    await advance(120000); assert.equal(oneTime.prompts.length, 2);
    assert.equal(oneTime.db.getCronJob(oneTime.job.id)?.enabled, false);
    console.log("PASS #44 revision check preserves a newly scheduled one-time execution");
  } finally { await oneTime.close(); }
}
