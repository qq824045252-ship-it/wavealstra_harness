import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { CronService, type CronAgent } from "../src/main/cron/CronService";
import { computeNextRunAt, parseEveryExpr } from "../src/main/cron/CronSchedule";
import type { AgentPromptRequest, ChatMessageDto, CronJobDto } from "../src/shared/agent-ipc";

async function until(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timeout: ${label}`);
    await delay(5);
  }
}
function barrier() {
  let release = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), "mybuddy-cron-native-"));
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  const dbPath = join(root, "app.db");
  let db = new AppDatabase(dbPath);
  const prompts: AgentPromptRequest[] = [];
  const history = new Map<string, ChatMessageDto[]>();
  let busy = false;
  let empty = false;
  let cancelled = false;
  let promptBarrier: ReturnType<typeof barrier> | undefined;
  let historyBarrier: ReturnType<typeof barrier> | undefined;
  let preparing = false;
  const agent: CronAgent = {
    getAppSettings: () => ({}),
    resolveAvailableModelId: async id => {
      if (historyBarrier) { preparing = true; await historyBarrier.promise; }
      return { modelId: id };
    },
    isTaskBusy: () => busy,
    listSkills: () => [], listConnectors: () => [],
    loadTaskHistory: async taskId => {
      if (historyBarrier) { preparing = true; await historyBarrier.promise; }
      return { messages: [...(history.get(taskId) ?? [])] };
    },
    prompt: async req => {
      prompts.push(req);
      if (promptBarrier) await promptBarrier.promise;
      if (!empty) history.set(req.taskId, [...(history.get(req.taskId) ?? []), {
        id: `native-${prompts.length}`, entryId: `entry-${prompts.length}`, role: "assistant", text: "done", createdAt: Date.now(),
      }]);
      return { queued: true, cancelled, receipt: { taskId: req.taskId, operationId: req.userMessageId, submissionId: prompts.length, status: "queued" } };
    },
    waitForSubmission: async receipt => ({ queued: false, receipt: { ...receipt, status: "done" },
      ...(empty ? { error: { code: "DURABLE_FAILED", message: "本轮模型未返回有效内容" } } : {}) }),
  };
  let cron = new CronService(db, agent);
  const job = (id: string, extra: Partial<CronJobDto> = {}): CronJobDto => ({
    id, name: id, prompt: "check", scheduleType: "every", scheduleExpr: "1h", timezone: "UTC",
    enabled: true, createdAt: 1, updatedAt: 1, ...extra,
  });
  const waitRun = (id: string, status: string) => until(() => db.listCronRuns().some(run => run.jobId === id && run.status === status), `${id}:${status}`);
  try {
    assert.equal(parseEveryExpr("90s"), 90000);
    assert.equal(computeNextRunAt(job("interval", { createdAt: 100000, scheduleExpr: "90s" }), 110000), 190000);
    assert.equal(computeNextRunAt(job("missed", { createdAt: 100000, scheduleExpr: "90s" }), 400000), 460000);
    assert.throws(() => parseEveryExpr("0s"));
    assert.throws(() => parseEveryExpr("9007199254740991d"));
    const future = Date.UTC(2035, 1, 1);
    assert.equal(computeNextRunAt(job("far", { scheduleType: "cron", scheduleExpr: "* * * * * *", effectiveFrom: future }), future - 86400000), future);
    assert.equal(computeNextRunAt(job("quota", { maxRuns: 1, runCount: 1 })), undefined);
    db.upsertTask({ id: "source", title: "Keep title", cwd: root, modelId: "native/source", permissionMode: "readonly", welcomeMode: "coding", updatedAt: 1 });
    const sourceBefore = db.getTask("source");
    const scoped = cron.createForTask("source", root, { name: "continue", prompt: "check", scheduleType: "every", scheduleExpr: "1h", timezone: "UTC", target: "current-task", maxRuns: 1 });
    assert.throws(() => cron.changeForTask("other", scoped.id, "cancel"), /不属于/);
    await cron.runNow(scoped.id);
    await waitRun(scoped.id, "success");
    assert.equal(prompts[0].taskId, "source");
    assert.equal(prompts[0].modelId, "native/source");
    assert.equal(prompts[0].permissionMode, "readonly");
    assert.deepEqual(db.getTask("source"), sourceBefore);
    assert.equal(db.getCronJob(scoped.id)?.runCount, 1);
    assert.equal(db.getCronJob(scoped.id)?.enabled, false);
    cron.upsert({ ...scoped, enabled: true, runCount: 0 });
    assert.equal(db.getCronJob(scoped.id)?.enabled, false);
    assert.equal(cron.runsForTask("other").length, 0);
    assert.equal(cron.runsForTask("source").length, 1);

    promptBarrier = barrier();
    cron.upsert(job("timer", { scheduleType: "at", scheduleExpr: new Date(Date.now() + 80).toISOString(), cwd: root }));
    await until(() => prompts.length === 2, "real timer");
    await cron.runNow("timer");
    await delay(30);
    assert.equal(prompts.length, 2);
    assert.equal(db.getTask(prompts[1].taskId)?.cwd, root);
    promptBarrier.release(); promptBarrier = undefined;
    await waitRun("timer", "success");
    assert.equal(db.getCronJob("timer")?.enabled, false);

    busy = true;
    cron.upsert(job("busy", { target: { kind: "task", taskId: "source" } }));
    await cron.runNow("busy"); await waitRun("busy", "skipped");
    assert.equal(prompts.length, 2);
    assert.equal(db.getCronJob("busy")?.runCount, 0);
    busy = false;

    for (const action of ["pause", "cancel"] as const) {
      const scheduled = cron.createForTask("source", root, { name: action, prompt: "check", scheduleType: "every", scheduleExpr: "1h", timezone: "UTC", target: "new-task" });
      preparing = false; historyBarrier = barrier();
      await cron.runNow(scheduled.id);
      await until(() => preparing, "preparation");
      cron.changeForTask("source", scheduled.id, action);
      historyBarrier.release(); historyBarrier = undefined;
      await delay(30);
      assert.equal(prompts.length, 2, "取消 await 准备中的计划不得启动");
      if (action === "cancel") assert.equal(db.getCronJob(scheduled.id), undefined);
    }
    empty = true;
    cron.upsert(job("empty", { target: { kind: "task", taskId: "source" } }));
    await cron.runNow("empty"); await waitRun("empty", "error");
    empty = false; cancelled = true;
    cron.upsert(job("cancelled"));
    await cron.runNow("cancelled"); await waitRun("cancelled", "error");
    cancelled = false;
    cron.upsert(job("expired", { effectiveTo: Date.now() - 1 }));
    await cron.runNow("expired");
    assert.equal(db.getCronJob("expired")?.enabled, false);
    assert.equal(db.listCronRuns().filter(run => run.jobId === "expired").length, 0);
    assert.throws(() => cron.upsert(job("invalid", { scheduleExpr: "0s" })));

    cron.upsert(job("resume", { restartPolicy: "resume" }));
    cron.upsert(job("pause", { restartPolicy: "pause" }));
    const savedRequest = { taskId: "source", text: "saved prompt", userMessageId: "cron-saved-input", assistantMessageId: "cron-saved-assistant", permissionMode: "readonly", welcomeMode: "bot" } as unknown as AgentPromptRequest;
    db.insertCronRun({ id: "saved", jobId: "resume", taskId: "source", startedAt: 1, status: "running" });
    db.connection.prepare("INSERT INTO cron_run_inputs VALUES (?, ?)").run("saved", JSON.stringify({ request: savedRequest, newTask: false, job: { id: "resume", name: "Original schedule" } }));
    db.insertCronRun({ id: "interrupted", jobId: "resume", startedAt: 1, status: "running" });
    cron.stop(); db.close();
    db = new AppDatabase(dbPath);
    cron = new CronService(db, agent); cron.start();
    assert.equal(db.getCronJob("pause")?.enabled, false);
    assert.equal(db.getCronJob("resume")?.enabled, true);
    assert.equal(db.listCronRuns().find(run => run.id === "interrupted")?.status, "error");
    await until(() => db.listCronRuns().find(run => run.id === "saved")?.status === "success", "saved receipt resumed");
    assert.deepEqual(prompts.at(-1), { ...savedRequest, welcomeMode: "general" }, "restart resubmits the persisted operation identity and input with canonical mode");
    const recoveredCronInput = JSON.parse((db.connection.prepare("SELECT request_json FROM cron_run_inputs WHERE run_id = ?").get("saved") as { request_json: string }).request_json);
    assert.equal(recoveredCronInput.request.welcomeMode, "general", "cron_run_inputs legacy welcomeMode migrated");
    assert.equal(db.getTask("source")?.title, "Keep title", "editing the plan target cannot rename its original task on recovery");
    assert.ok((cron.list().find(item => item.id === "resume")?.nextRunAt ?? 0) > Date.now());
    assert.equal(db.getTask("source")?.cwd, root);
    console.log("PASS cron: real SQLite/reopen, timers, 90s, busy, cancellation during await, quota, deadline, restart, task scope/context");
  } finally {
    promptBarrier?.release(); historyBarrier?.release();
    cron.stop(); await delay(20); db.close(); rmSync(root, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
