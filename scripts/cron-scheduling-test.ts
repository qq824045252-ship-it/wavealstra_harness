import assert from "node:assert/strict";
import { testSchedulingContinuity } from "./cron-scheduling-continuity";
import { testAutomationLifecycle } from "./automation-lifecycle-test";
import { testAutomationUpdate } from "./automation-update-test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { CronService, type CronAgent } from "../src/main/cron/CronService";
import { computeNextRunAt, parseEveryExpr } from "../src/main/cron/CronSchedule";
import { locateRuntimeAudit } from "../src/main/platform/runtime-audit";
import type { AgentPromptRequest, ChatMessageDto, CronJobDto } from "../src/shared/agent-ipc";
import { DOTS_TASK_ID } from "../src/shared/dots";

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
  const useNative = process.argv.includes("--native");
  const runtimeAuditExecutable = useNative ? locateRuntimeAudit(process.cwd()) : undefined;
  if (useNative) assert(runtimeAuditExecutable && existsSync(runtimeAuditExecutable), "Rust worker executable is required in native mode");
  const dbOptions = { runtimeAuditExecutable };
  await testAutomationLifecycle(dbOptions);
  await testAutomationUpdate();
  await testSchedulingContinuity();
  const root = mkdtempSync(join(tmpdir(), "mybuddy-cron-native-"));
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  const dbPath = join(root, "app.db");
  let db = new AppDatabase(dbPath, dbOptions);
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
      const id = req.userMessageId?.slice("cron-".length, -"-input".length);
      const stored = db.connection.prepare(`SELECT r.task_id, i.request_json FROM cron_runs r
        JOIN cron_run_inputs i ON i.run_id = r.id WHERE r.id = ? AND r.status = 'running'`).get(id) as
        { task_id: string; request_json: string } | undefined;
      assert.deepEqual([stored?.task_id, JSON.parse(stored?.request_json ?? "{}").request?.text, db.getTask(req.taskId)?.id],
        [req.taskId, req.text, req.taskId], "the runnable task and exact recovery input must exist before dispatch");
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
    const scoped = await cron.createTaskPlan("source", root, { name: "continue", prompt: "check", scheduleType: "every", scheduleExpr: "1h", timezone: "UTC", target: "current-task", maxRuns: 1 });
    await assert.rejects(cron.changeTaskPlan("other", scoped.id, "cancel"), /不属于/);
    await cron.runNow(scoped.id);
    await waitRun(scoped.id, "success");
    assert.equal(prompts[0].taskId, "source");
    assert.equal(prompts[0].modelId, "native/source");
    assert.equal(prompts[0].permissionMode, "readonly");
    assert.deepEqual(db.getTask("source"), sourceBefore);
    assert.equal(db.getCronJob(scoped.id)?.runCount, 1);
    assert.equal(db.getCronJob(scoped.id)?.enabled, false);
    await cron.saveUserPlan({ ...scoped, enabled: true, runCount: 0 });
    assert.equal(db.getCronJob(scoped.id)?.enabled, false);
    assert.deepEqual(await cron.runsForTask("other"), []);
    assert.deepEqual((await cron.runsForTask("source")).map(run => [run.jobId, run.status, run.taskId]), [[scoped.id, "success", "source"]]);

    promptBarrier = barrier();
    await cron.saveUserPlan(job("timer", { scheduleType: "at", scheduleExpr: new Date(Date.now() + 180).toISOString(), cwd: root }));
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
      if (action === "cancel") assert.equal(cron.getForTask("source", scheduled.id).status, "cancelled");
    }
    empty = true;
    cron.upsert(job("empty", { target: { kind: "task", taskId: "source" } }));
    await cron.runNow("empty"); await waitRun("empty", "error");
    assert.equal(db.getCronJob("empty")?.runCount, 1, "ordinary execution errors retain their existing attempt quota semantics");
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
    cron.stop(); await cron.flushWrites(); await db.runtimeAuditReader?.close(); db.close();
    db = new AppDatabase(dbPath, dbOptions);
    cron = new CronService(db, agent); cron.start();
    assert.equal(db.getCronJob("pause")?.enabled, false);
    assert.equal(db.getCronJob("resume")?.enabled, true);
    await until(() => db.listCronRuns().find(run => run.id === "interrupted")?.status === "error", "incomplete legacy run is marked failed");
    await until(() => db.listCronRuns().find(run => run.id === "saved")?.status === "success", "saved receipt resumed");
    assert.deepEqual(prompts.at(-1), { ...savedRequest, welcomeMode: "general" }, "restart resubmits the persisted operation identity and input with canonical mode");
    const recoveredCronInput = JSON.parse((db.connection.prepare("SELECT request_json FROM cron_run_inputs WHERE run_id = ?").get("saved") as { request_json: string }).request_json);
    assert.equal(recoveredCronInput.request.welcomeMode, "general", "cron_run_inputs legacy welcomeMode migrated");
    assert.equal(db.getTask("source")?.title, "Keep title", "editing the plan target cannot rename its original task on recovery");
    assert.ok(((await cron.readJobs()).find(item => item.id === "resume")?.nextRunAt ?? 0) > Date.now());
    assert.equal(db.getTask("source")?.cwd, root);

    if (db.runtimeAuditReader) {
      const reader = db.runtimeAuditReader;
      const write = reader.writeCronRun.bind(reader);
      let delayed = barrier();
      let reached = false;
      let cancelledWrite: boolean | undefined;
      const beforeRace = prompts.length;
      try {
        reader.writeCronRun = async mutation => {
          if (mutation.kind === "start" && mutation.run.jobId === "cancel-while-saving") {
            reached = true;
            await delayed.promise;
            cancelledWrite = await write(mutation);
            return cancelledWrite;
          }
          return write(mutation);
        };
        cron.upsert(job("cancel-while-saving", { sourceTaskId: "source", target: { kind: "new-task" } }));
        await cron.runNow("cancel-while-saving");
        await until(() => reached, "writer has the previously admitted request");
        cron.changeForTask("source", "cancel-while-saving", "cancel");
        delayed.release();
        await until(() => cancelledWrite !== undefined, "cancel and stale write settled");
        assert.equal(cancelledWrite, false);
        assert.deepEqual(await db.readCronRuns(10, ["cancel-while-saving"]), []);
        assert.equal(db.listNonTrashedTasks().some(task => task.id.startsWith("cron-cancel-while-saving-")), false);
        assert.deepEqual(prompts.slice(beforeRace), []);

        delayed = barrier();
        reached = false;
        reader.writeCronRun = async mutation => {
          const persisted = await write(mutation);
          if (persisted && mutation.kind === "start" && mutation.run.jobId === "busy-while-saving") {
            reached = true;
            await delayed.promise;
          }
          return persisted;
        };
        cron.upsert(job("busy-while-saving", { sourceTaskId: "source", target: { kind: "task", taskId: "source" } }));
        await cron.runNow("busy-while-saving");
        await until(() => reached, "checkpoint waits to dispatch to the target");
        busy = true;
        delayed.release();
        await waitRun("busy-while-saving", "skipped");
        await cron.flushWrites();
        const skipped = (await db.readCronRuns(10, ["busy-while-saving"]))[0];
        assert.deepEqual([skipped.status, skipped.error, skipped.taskId, db.getCronJob("busy-while-saving")?.runCount,
          db.getCronJob("busy-while-saving")?.lastRunAt, await db.readCronRunInput(skipped.id)],
        ["skipped", "目标任务正忙，已跳过，未排队", undefined, 0, undefined, undefined]);
        assert.deepEqual(prompts.slice(beforeRace), []);
        busy = false;

        delayed = barrier();
        reached = false;
        let retried = false;
        let acknowledged: string | undefined;
        reader.writeCronRun = async mutation => {
          if (mutation.kind === "start" && mutation.run.jobId === "edit-while-saving") {
            if (!retried) { reached = true; retried = true; await delayed.promise; }
            const persisted = await write(mutation);
            if (persisted) {
              acknowledged = mutation.run.id;
              return undefined; // Simulate a committed checkpoint whose reply was lost.
            }
            return persisted;
          }
          if (mutation.kind === "finish" && mutation.runId === acknowledged) {
            const persisted = await write(mutation);
            if (persisted) {
              db.connection.prepare("UPDATE tasks SET title = '完成后手动改名' WHERE id = ?").run(mutation.taskId);
              return undefined;
            }
            return persisted;
          }
          return write(mutation);
        };
        cron.upsert(job("edit-while-saving", { sourceTaskId: "source", target: { kind: "new-task" } }));
        await cron.runNow("edit-while-saving");
        await until(() => reached, "writer received the previous prompt");
        await cron.updateTaskPlan("source", "edit-while-saving", { prompt: "updated before checkpoint" });
        delayed.release();
        await waitRun("edit-while-saving", "success");
        await cron.flushWrites();
        const completed = (await db.readCronRuns(10, ["edit-while-saving"]))[0];
        assert.deepEqual(prompts.slice(beforeRace).map(prompt => [prompt.text, prompt.userMessageId]), [
          ["updated before checkpoint", `cron-${acknowledged}-input`],
        ]);
        assert.equal(completed.id, acknowledged);
        assert.equal(db.getCronJob("edit-while-saving")?.runCount, 1);
        assert.deepEqual(db.listNonTrashedTasks().filter(task => task.id.startsWith("cron-edit-while-saving-")).map(task => [task.status, task.title]), [
          ["completed", "完成后手动改名"],
        ]);

        delayed = barrier();
        let preDispatchId: string | undefined;
        reader.writeCronRun = async mutation => {
          const persisted = await write(mutation);
          if (persisted && mutation.kind === "start" && mutation.run.jobId === "restart-during-checkpoint") {
            preDispatchId = mutation.run.id;
            await delayed.promise;
          }
          return persisted;
        };
        cron.upsert(job("restart-during-checkpoint", { prompt: "resume committed request" }));
        await cron.runNow("restart-during-checkpoint");
        await until(() => preDispatchId !== undefined, "checkpoint stored before dispatch");
        const beforeRestart = prompts.length;
        cron.stop();
        delayed.release();
        await cron.flushWrites();
        assert.deepEqual(prompts.slice(beforeRestart), []);
        await reader.close();
        db.close();
        db = new AppDatabase(dbPath, dbOptions);
        cron = new CronService(db, agent);
        cron.start();
        await waitRun("restart-during-checkpoint", "success");
        assert.deepEqual(prompts.slice(beforeRestart).map(prompt => [prompt.text, prompt.userMessageId]), [
          ["resume committed request", `cron-${preDispatchId}-input`],
        ]);
        assert.deepEqual((await db.readCronRuns(10, ["restart-during-checkpoint"])).map(run => [run.id, run.status]), [[preDispatchId, "success"]]);
        db.openDots();
        const owner = db.createSpace({ name: "Dots 归属", path: root });
        db.upsertTask({ id: "dots-owner", title: "原事项", spaceId: owner.id, updatedAt: Date.now() });
        const planReader = db.runtimeAuditReader!;
        const writePlan = planReader.writeCronPlan.bind(planReader);
        let lostPlanReply = false;
        planReader.writeCronPlan = async mutation => {
          const saved = await writePlan(mutation);
          if (saved && mutation.kind === "save" && mutation.provenance && !lostPlanReply) {
            lostPlanReply = true;
            return undefined;
          }
          return saved;
        };
        const dotsInput = {
          name: "定时跟进", scheduleType: "every", scheduleExpr: "1h", timezone: "UTC", target: "current-task",
          prompt: "跟进原任务", missedRuns: "coalesce",
        } as const;
        const provenance = { source: "schedule-fixture", origin: { conversationId: 90, entryId: 91 }, owner: { taskId: "dots-owner", spaceId: owner.id } };
        const dotsJob = await cron.createTaskPlan(DOTS_TASK_ID, root, dotsInput, "native-provenance", provenance);
        const replay = await cron.createTaskPlan(DOTS_TASK_ID, root, { ...dotsInput, prompt: "重复请求" }, "native-provenance", provenance);
        assert.deepEqual([lostPlanReply, replay.id, replay.prompt, cron.dotsScheduleOwnerTask(replay.id), cron.inDotsScope(replay.id, { spaceId: owner.id })],
          [true, dotsJob.id, "跟进原任务", "dots-owner", true]);

        await cron.setUserPlanEnabled(dotsJob.id, false);
        assert.equal(cron.getForTask(DOTS_TASK_ID, dotsJob.id).status, "paused");
        const resumeGate = barrier();
        let resumeWaiting = false;
        planReader.writeCronPlan = async mutation => {
          if (mutation.kind === "save" && mutation.row.id === dotsJob.id && mutation.manualHold === "remove") {
            resumeWaiting = true;
            await resumeGate.promise;
          }
          return writePlan(mutation);
        };
        try {
          const resumed = assert.rejects(cron.setUserPlanEnabled(dotsJob.id, true), /已变化/);
          await until(() => resumeWaiting, "resume waits for its commit");
          cron.holdDotsSchedule(dotsJob.id, "task:dots-owner", true);
          resumeGate.release();
          await resumed;
          assert.equal(cron.getForTask(DOTS_TASK_ID, dotsJob.id).status, "paused");
          cron.holdDotsSchedule(dotsJob.id, "task:dots-owner", false);
          assert.equal(cron.getForTask(DOTS_TASK_ID, dotsJob.id).status, "paused", "the original manual hold still applies");
        } finally {
          resumeGate.release();
          planReader.writeCronPlan = writePlan;
        }
        await cron.setUserPlanEnabled(dotsJob.id, true);
        await cron.runNow(dotsJob.id);
        await waitRun(dotsJob.id, "success");
        assert.deepEqual([prompts.at(-1)?.taskId, prompts.at(-1)?.displayText, prompts.at(-1)?.streamingBehavior],
          [DOTS_TASK_ID, "跟进原任务", "followUp"]);
        await cron.deleteUserPlan(dotsJob.id);
        assert.equal((await cron.readJobs()).some(item => item.id === dotsJob.id), false);
        assert.deepEqual(await db.readCronRuns(10, [dotsJob.id]), []);
        console.log("PASS Rust plan edits, provenance, replay, concurrent pause, resume, and history deletion");
        console.log("PASS Rust automation atomic start, stale cancellation, edit retry, lost replies, and restart before dispatch");
      } finally {
        busy = false;
        delayed.release();
        reader.writeCronRun = write;
      }
    }
    console.log("PASS cron: real SQLite/reopen, timers, 90s, busy, cancellation during await, quota, deadline, restart, task scope/context");
  } finally {
    promptBarrier?.release(); historyBarrier?.release();
    cron.stop(); await cron.flushWrites(); await db.runtimeAuditReader?.close(); db.close(); rmSync(root, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
