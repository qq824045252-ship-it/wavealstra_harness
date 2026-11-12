import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { BotConversationRepository } from "../src/main/agent/work/BotConversationRepository";
import { CronService, type CronAgent } from "../src/main/cron/CronService";
import { CronReminderDelivery, type ReminderDelivery } from "../src/main/cron/CronReminderDelivery";
import { DEFAULT_BOT_ID, LOCAL_USER_ID } from "../src/shared/bot-work";
import { DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import type { CronJobDto } from "../src/shared/agent-ipc";

const advance = async (ms: number) => {
  mock.timers.tick(ms);
  await new Promise<void>(resolve => setImmediate(resolve));
};
let failureStage: "message" | "cursor" | "outbox" = "outbox";
const identity = (id: string, due: number) => `reminder-${createHash("sha256").update(`${id}:${due}`).digest("hex")}`;

async function fixture(test: (f: ReturnType<typeof setup>) => Promise<void>) {
  const f = setup();
  try { await test(f); }
  finally { f.close(); }
}

function setup(execution?: CronAgent) {
  const root = mkdtempSync(join(tmpdir(), "cron-reminder-recovery-"));
  const path = join(root, "app.db");
  let db = new AppDatabase(path);
  const bots = new BotRegistry(db.connection);
  bots.registerBot({ userId: LOCAL_USER_ID, botId: DEFAULT_BOT_ID, displayName: "恢复测试", authorization: DESKTOP_USER_GRANTS });
  const { conversationId } = new BotConversationRepository(db.connection).accept(LOCAL_USER_ID,
    { botId: DEFAULT_BOT_ID, requestId: "seed", text: "提醒" });
  mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.UTC(2035, 0, 1) });
  const agent: CronAgent = execution ?? {
    prompt: async () => { throw new Error("reminders cannot call the model"); },
    waitForSubmission: async () => { throw new Error("reminders cannot create a Task"); },
    loadTaskHistory: async () => ({ messages: [] }), isTaskBusy: () => false,
    getAppSettings: () => ({}), resolveAvailableModelId: async () => undefined,
    listSkills: () => [], listConnectors: () => [],
  };
  const delivered: ReminderDelivery[] = [];
  const attempts: string[] = [];
  let fail = true;
  let notificationFailures = 0;
  const notify = (value: ReminderDelivery) => {
    if (notificationFailures-- > 0) throw new Error("notification unavailable");
    delivered.push(value);
  };
  const installFault = () => db.connection.function("fail_reminder_commit", (id: unknown, cursorDue: unknown) => {
    assert.equal(typeof id, "string");
    attempts.push(failureStage === "cursor" ? identity(String(id), Number(cursorDue)) : String(id));
    return fail ? 1 : 0;
  });
  installFault();
  let cron = new CronService(db, agent, undefined, undefined, notify);
  const faultTarget = failureStage === "cursor" ? "UPDATE OF next_due_at ON cron_reminder_state" : `INSERT ON ${failureStage === "message" ? "bot_messages" : "cron_reminder_delivery"}`;
  const faultId = failureStage === "cursor" ? "job_id" : failureStage === "message" ? "request_id" : "delivery_id";
  db.connection.exec(`CREATE TRIGGER fail_reminder_commit BEFORE ${faultTarget}
    WHEN ${failureStage === "cursor" ? "EXISTS (SELECT 1 FROM cron_runs WHERE job_id=NEW.job_id AND status='success') AND " : ""}fail_reminder_commit(NEW.${faultId}, ${failureStage === "cursor" ? "OLD.next_due_at" : "NULL"}) = 1 BEGIN SELECT RAISE(ABORT, 'reminder commit unavailable'); END;`);
  const create = (extra: Partial<CronJobDto> = {}) => cron.upsert({
    id: "reminder", name: "恢复提醒", prompt: "喝水", enabled: true,
    scheduleType: "at", scheduleExpr: new Date(Date.now() + 1000).toISOString(), timezone: "UTC",
    createdAt: Date.now(), updatedAt: Date.now(),
    reminder: { kind: "bot-reminder", userId: LOCAL_USER_ID, botId: DEFAULT_BOT_ID, conversationId, state: "scheduled" },
    ...extra,
  });
  return {
    get db() { return db; }, get cron() { return cron; }, delivered, attempts, create,
    recover() { fail = false; }, failNotification() { notificationFailures = 1; },
    messages: () => new BotConversationRepository(db.connection).history(LOCAL_USER_ID,
      { botId: DEFAULT_BOT_ID, conversationId }).messages.filter(m => m.text.startsWith("⏰")),
    restart() {
      cron.stop(); db.close(); db = new AppDatabase(path); installFault();
      cron = new CronService(db, agent, undefined, undefined, notify); cron.start();
    },
    close() { cron.stop(); db.close(); mock.timers.reset(); rmSync(root, { recursive: true, force: true }); },
  };
}

export async function testReminderRecovery(stage: "message" | "cursor" | "outbox" = "outbox") {
  failureStage = stage;
  console.log(`Reminder failure stage: ${stage}`);
  for (const [scheduleType, maxRuns] of [["at", undefined], ["every", undefined], ["every", 1], ["every", 2]] as const) {
    await fixture(async f => {
      const job = f.create({ scheduleType, scheduleExpr: scheduleType === "at" ? new Date(Date.now() + 1000).toISOString() : "60s", maxRuns });
      const due = f.cron.list()[0].nextRunAt!;
      await advance(due - Date.now());
      assert.equal(f.attempts.length, 1);
      assert.equal(f.db.getCronJob(job.id)?.enabled, true, "#45 an uncommitted reminder must remain enabled");
      assert.equal(f.db.getCronJob(job.id)?.reminder?.state, "scheduled");
      assert.equal(f.db.getCronJob(job.id)?.runCount, 0, "internal failures do not consume the delivery quota");
      assert.equal(f.db.getCronJob(job.id)?.lastRunAt, undefined);
      assert.equal(f.messages().length, 0);
      assert.deepEqual(f.db.connection.prepare("SELECT delivery_id FROM cron_reminder_delivery").all(), []);
      await advance(9999); assert.equal(f.attempts.length, 1, "no 1ms retry loop");
      await advance(1); assert.equal(f.attempts.length, 2);
      f.recover();
      await advance(19999); assert.equal(f.delivered.length, 0);
      await advance(1);
      assert.deepEqual(f.attempts, Array(3).fill(identity(job.id, due)), "retries retain the original occurrence identity");
      assert.equal(f.messages().length, 1); assert.equal(f.delivered.length, 1);
      assert.equal(f.db.getCronJob(job.id)?.runCount, 1);
      const saved = f.db.getCronJob(job.id)!;
      new CronReminderDelivery(f.db).deliver(saved, due);
      assert.equal(f.messages().length, 1, "transaction deduplication still applies");
      if (scheduleType === "at" || maxRuns === 1) {
        await advance(120000);
        assert.equal(f.messages().length, 1);
        assert.equal(f.db.getCronJob(job.id)?.enabled, false);
        assert.equal(f.db.getCronJob(job.id)?.reminder?.state, "delivered");
      } else {
        await advance(f.cron.list()[0].nextRunAt! - Date.now());
        assert.equal(f.messages().length, 2, "advance to the next occurrence and observe delivery");
        if (maxRuns === 2) {
          await advance(120000); assert.equal(f.messages().length, 2);
          assert.equal(f.db.getCronJob(job.id)?.enabled, false);
        }
      }
    });
    console.log(`PASS #45 commit recovery and success quota: ${scheduleType}, maxRuns=${maxRuns ?? "none"}`);
  }
  await fixture(async f => {
    f.create(); await advance(1000);
    for (const [index, wait] of [10000, 20000, 40000, 80000, 160000, 300000, 300000].entries()) {
      await advance(wait - 1); assert.equal(f.attempts.length, index + 1);
      await advance(1); assert.equal(f.attempts.length, index + 2);
    }
    f.recover(); await advance(300000); assert.equal(f.messages().length, 1);
  });
  console.log("PASS #45 exponential backoff capped at five minutes, then recovery");
  await fixture(async f => {
    f.db.connection.exec(`CREATE TRIGGER fail_retry_journal BEFORE INSERT ON cron_reminder_retries
      BEGIN SELECT RAISE(ABORT, 'retry journal unavailable'); END;`);
    f.create(); await advance(1000);
    await advance(9999); assert.equal(f.attempts.length, 1);
    await advance(1); assert.equal(f.attempts.length, 2);
    f.recover(); await advance(19999); assert.equal(f.messages().length, 0);
    await advance(1); assert.equal(f.messages().length, 1);
    assert.equal(f.db.getCronJob("reminder")?.runCount, 1);
  });
  console.log("PASS #45 backoff survives failure to persist the retry journal itself");
  await fixture(async f => {
    const job = f.create({ scheduleType: "every", scheduleExpr: "60s", maxRuns: 1 });
    f.db.insertCronRun({ id: "failed-attempt", jobId: job.id, status: "error", startedAt: Date.now(), finishedAt: Date.now(), error: "prior uncommitted attempt" });
    assert.equal(f.db.getCronJob(job.id)?.runCount, 0, "#45 failed reminder records never count as successful deliveries");
    assert.equal(f.cron.list()[0].runCount, 0);
    f.recover(); await advance(60000); assert.equal(f.messages().length, 1);
    await advance(120000); assert.equal(f.messages().length, 1);
    assert.equal(f.db.getCronJob(job.id)?.runCount, 1);
  });
  console.log("PASS #45 existing failure records cannot exhaust a success quota");
  await fixture(async f => {
    const job = f.create(); const due = f.cron.list()[0].nextRunAt!;
    await advance(1000); await advance(5000); f.restart(); f.recover();
    await advance(4999); assert.equal(f.attempts.length, 1, "restart retains the backoff deadline");
    await advance(1); assert.equal(f.messages().length, 1);
    assert.equal(f.delivered[0].deliveryId, identity(job.id, due));
    f.restart(); await advance(60000); assert.equal(f.messages().length, 1);
  });
  console.log("PASS #45 database reopen preserves occurrence/backoff and does not duplicate delivery");
  for (const action of ["cancel", "delete", "reschedule", "snooze", "pause-resume"] as const) {
    await fixture(async f => {
      const job = f.create(); const due = f.cron.list()[0].nextRunAt!;
      await advance(1000);
      const newDue = Date.now() + 60000;
      if (action === "delete") f.cron.remove(job.id);
      else if (action === "cancel") f.cron.setEnabled(job.id, false, "cancelled");
      else if (action === "pause-resume") f.cron.setEnabled(job.id, false);
      else if (action === "snooze") f.cron.snoozeReminder(job.id, newDue);
      else f.cron.upsert({ ...f.db.getCronJob(job.id)!, scheduleExpr: new Date(newDue).toISOString() });
      f.recover(); await advance(20000);
      assert.equal(f.messages().length, 0, "the old retry cannot deliver after a user change");
      if (action === "pause-resume") {
        f.cron.setEnabled(job.id, true); await advance(1);
        assert.equal(f.delivered[0]?.deliveryId, identity(job.id, due));
      } else if (action === "snooze" || action === "reschedule") {
        await advance(newDue - Date.now());
        assert.equal(f.delivered[0]?.deliveryId, identity(job.id, newDue));
      } else { f.restart(); await advance(120000); assert.equal(f.messages().length, 0); }
    });
    console.log(`PASS #45 retry invalidation: ${action}`);
  }
  // Preview deliberately does not update the scheduled cursor. Its failure cases are covered at message/outbox writes.
  if (stage !== "cursor") await fixture(async f => {
    f.create({ scheduleExpr: new Date(Date.now() + 60000).toISOString() });
    await f.cron.runNow("reminder"); await advance(0);
    assert.equal(f.db.getCronJob("reminder")?.runCount, 0);
    f.recover(); await advance(30000); assert.equal(f.messages().length, 0, "failed preview has no scheduled retry");
    await advance(30000); assert.equal(f.messages().length, 1);
  });
  await fixture(async f => {
    f.recover(); f.failNotification(); f.create(); f.cron.start();
    await advance(1000);
    assert.equal(f.messages().length, 1); assert.equal(f.delivered.length, 0);
    assert.equal(f.db.getCronJob("reminder")?.runCount, 1);
    await advance(9000); assert.equal(f.delivered.length, 1);
    f.restart(); await advance(60000); assert.equal(f.messages().length, 1); assert.equal(f.delivered.length, 1);
  });
  console.log("PASS #45 preview failure and post-commit notification recovery remain separate");

  for (const invalidation of ["expiry", "target"] as const) {
    await fixture(async f => {
      const job = f.create(invalidation === "expiry" ? { effectiveTo: Date.now() + 5000 } : {});
      await advance(1000);
      assert.equal(f.attempts.length, 1);
      if (invalidation === "target") f.db.connection.prepare("UPDATE bot_conversations SET user_id=? WHERE conversation_id=?")
        .run("unavailable-user", job.reminder!.conversationId);
      f.recover(); await advance(10000);
      assert.equal(f.delivered.length, 0);
      assert.equal(f.db.getCronJob(job.id)?.enabled, false);
      assert.equal(f.db.getCronJob(job.id)?.runCount, 0);
      if (invalidation === "target") f.db.connection.prepare("UPDATE bot_conversations SET user_id=? WHERE conversation_id=?")
        .run(LOCAL_USER_ID, job.reminder!.conversationId);
      f.create({ id: "unrelated" }); await advance(1000);
      assert.equal(f.delivered.length, 1);
      assert.equal(f.delivered[0].jobId, "unrelated");
      f.restart(); await advance(60000);
      assert.equal(f.delivered.length, 1, "invalid reminder cannot revive after recovery/restart");
    });
    console.log(`PASS #45 retry invalidation and unrelated reminder independence: ${invalidation}`);
  }

  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let executions = 0;
  const mixed = setup({
    prompt: async request => {
      executions++; await gate;
      return { queued: true, receipt: { taskId: request.taskId, operationId: request.userMessageId!, submissionId: executions, status: "queued" } };
    },
    waitForSubmission: async receipt => ({ queued: false, receipt: { ...receipt, status: "done" } }),
    loadTaskHistory: async () => ({ messages: [] }), isTaskBusy: () => false,
    getAppSettings: () => ({}), resolveAvailableModelId: async () => undefined,
    listSkills: () => [], listConnectors: () => [],
  });
  try {
    mixed.create();
    const plan = mixed.cron.upsert({ id: "ordinary", name: "ordinary", prompt: "check", scheduleType: "every", scheduleExpr: "1s",
      timezone: "UTC", enabled: true, createdAt: Date.now(), updatedAt: Date.now() });
    await advance(1000); assert.equal(executions, 1); assert.equal(mixed.messages().length, 0);
    mixed.cron.upsert({ ...plan, scheduleExpr: "2s" });
    await advance(1000); assert.equal(executions, 1);
    release(); await advance(0);
    await advance(2000); assert.equal(executions, 2, "#44 recovers while #45 is waiting to retry");
    mixed.recover(); await advance(6999); assert.equal(mixed.messages().length, 0);
    await advance(1); assert.equal(mixed.messages().length, 1); assert.equal(mixed.attempts.length, 2);
    await advance(1000); assert(executions >= 3); assert.equal(mixed.messages().length, 1);
    console.log("PASS #44 + #45 same-service rescheduling and reminder recovery both execute subsequent occurrences");
  } finally { release(); await advance(0); mixed.close(); }
}
