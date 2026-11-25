import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { CronService, type CronAgent } from "../src/main/cron/CronService";
import { registerLocalWorkflowTools } from "../src/main/capabilities/local-workflow-extension";
import type { TaskTerminalService } from "../src/main/terminal/TaskTerminalService";
import { isDangerousTool } from "../src/shared/pi-event-mapper";
import type { CronJobDto, CronRunDto } from "../src/shared/agent-ipc";

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = performance.now() + 2500;
  while (!predicate()) {
    assert(performance.now() < deadline, description);
    await flush();
  }
}

export async function testAutomationLifecycle(dbOptions: { runtimeAuditExecutable?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "automation-lifecycle-"));
  const db = new AppDatabase(join(root, "app.db"), dbOptions);
  mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.UTC(2035, 1, 1) });
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let starts = 0;
  const agent: CronAgent = {
    prompt: async request => {
      starts++;
      await gate;
      return { queued: true, receipt: { taskId: request.taskId, operationId: request.userMessageId!, submissionId: starts, status: "queued" } };
    },
    waitForSubmission: async receipt => ({ queued: false, receipt: { ...receipt, status: "done" } }),
    loadTaskHistory: async () => ({ messages: [] }), isTaskBusy: () => false,
    getAppSettings: () => ({}), resolveAvailableModelId: async () => undefined,
    listSkills: () => [], listConnectors: () => [],
  };
  const cron = new CronService(db, agent);
  const tools = new Map<string, Parameters<ExtensionAPI["registerTool"]>[0]>();
  registerLocalWorkflowTools({ registerTool: tool => { tools.set(tool.name, tool); } }, {
    taskId: "source", taskRoot: root, terminalEnabled: false,
    services: { cron, terminal: {} as TaskTerminalService, getPermissionMode: () => "readonly" },
  });
  const tool = tools.get("automation_exec")!;
  const invoke = (args: Record<string, unknown>) => tool.execute("test", args, new AbortController().signal, undefined, {} as never);
  try {
    for (const task of ["source", "other"]) db.upsertTask({ id: task, title: task, cwd: root, updatedAt: Date.now() });
    const create = (task: string, name: string) => cron.createForTask(task, root, {
      name, prompt: "check", scheduleType: "every", scheduleExpr: "1h", timezone: "UTC", target: "current-task",
    });
    const due = create("source", "due");
    const history = create("source", "history");
    const unrelated = create("other", "unrelated");
    const otherOwned = create("source", "second own plan");
    assert.equal(isDangerousTool("automation_exec", { action: "get" }), false);
    assert.equal(isDangerousTool("automation_exec", { action: "cancel" }), true);
    assert.equal(cron.getForTask("source", due.id).status, "scheduled");
    assert((await invoke({ action: "get", id: unrelated.id })).isError);
    assert((await invoke({ action: "runs", id: unrelated.id })).isError);
    assert((await invoke({ action: "runs", cursor: "a" })).isError);
    assert(!(await invoke({ action: "get", id: due.id })).isError);
    const stamp = Date.now() - 300;
    for (const [id, status] of [["a", "success"], ["b", "error"], ["c", "skipped"]] as const) {
      db.insertCronRun({ id, jobId: history.id, startedAt: stamp, status, error: status === "success" ? undefined : status + " reason" });
    }
    db.insertCronRun({ id: "different", jobId: unrelated.id, startedAt: stamp + 1, status: "success" });
    const catalog = (await invoke({ action: "list" })).details as { jobs: CronJobDto[] };
    assert.deepEqual(catalog.jobs.map(job => job.name).sort(), ["due", "history", "second own plan"]);
    assert.equal(catalog.jobs.find(job => job.name === "history")?.runCount, 2, "skipped attempts use no quota");
    const scoped = (await invoke({ action: "runs" })).details as CronRunDto[];
    assert.deepEqual(scoped.map(run => run.id), ["c", "b", "a"]);
    assert.deepEqual((await cron.listRuns(2)).map(run => run.id), ["different", "c"]);
    const overview = await cron.readOverview();
    assert.deepEqual(overview.runs.map(run => [run.id, run.status]), [
      ["different", "success"], ["c", "skipped"], ["b", "error"], ["a", "success"],
    ]);
    assert.deepEqual(overview.jobs.map(job => [job.name, job.runCount]).sort(), [
      ["due", 0], ["history", 2], ["second own plan", 0], ["unrelated", 1],
    ]);
    type RunPage = Awaited<ReturnType<CronService["runPageForTask"]>>;
    const first = (await invoke({ action: "runs", id: history.id, limit: 2 })).details as RunPage;
    assert.deepEqual(first.runs.map(r => r.id), ["c", "b"]);
    assert.equal(first.runs[0].error, "skipped reason");
    assert(first.nextCursor);
    db.insertCronRun({ id: "newer", jobId: history.id, startedAt: stamp + 1, status: "success" });
    const next = (await invoke({ action: "runs", id: history.id, limit: 2, cursor: first.nextCursor })).details as RunPage;
    assert.deepEqual(next.runs.map(r => r.id), ["a"], "stable page boundary even with tied timestamps and a new run");
    assert.equal(next.nextCursor, null);
    assert((await invoke({ action: "runs", id: otherOwned.id, cursor: first.nextCursor })).isError, "cursor bound to its job");
    assert(!(await invoke({ action: "runs", id: history.id, limit: 2 })).isError);
    cron.changeForTask("source", history.id, "pause");
    cron.changeForTask("source", otherOwned.id, "pause");
    assert.equal(cron.getForTask("source", history.id).status, "paused");

    const near = create("source", "near boundary");
    mock.timers.tick(3599999); await flush();
    cron.changeForTask("source", near.id, "cancel");
    mock.timers.tick(1); await flush();
    await waitFor(() => starts >= 2, "both authorized plans started");
    assert.equal(starts, 2, "only the other two scheduled plans start; near-boundary cancellation stays stopped");
    assert.equal(cron.getForTask("source", near.id).activeRun, null);
    const running = cron.getForTask("source", due.id);
    assert.equal(running.activeRun?.status, "running");
    const runningId = running.activeRun!.id;
    assert(!(await invoke({ action: "cancel", id: due.id })).isError);
    const stopped = cron.getForTask("source", due.id);
    assert.equal(stopped.status, "cancelled");
    assert.equal(stopped.job.nextRunAt, undefined);
    assert.equal(stopped.activeRun?.id, runningId, "cancel does not abort the in-flight run");
    mock.timers.tick(1);
    cron.changeForTask("source", due.id, "cancel");
    assert.equal(cron.getForTask("source", due.id).job.cancelledAt, stopped.job.cancelledAt);
    assert.equal(cron.getForTask("source", due.id).job.updatedAt, stopped.job.updatedAt);
    assert.throws(() => cron.changeForTask("source", due.id, "resume"), /cannot be resumed/);
    await assert.rejects(cron.runNow(due.id), /cannot be run/);
    assert.throws(() => cron.upsert({ ...due, enabled: true }), /cannot be enabled/);
    release(); await flush();
    await waitFor(() => cron.getForTask("source", due.id).latestRun?.status === "success", "running plan kept its completion");
    await waitFor(() => cron.getForTask("source", history.id).latestRun?.status === "success", "the other plan also finished before advancing the clock");
    await cron.flushWrites();
    assert.equal(cron.getForTask("source", due.id).latestRun?.id, runningId);
    assert.equal(cron.getForTask("source", due.id).latestRun?.status, "success");
    assert.equal(cron.getForTask("source", due.id).activeRun, null);
    cron.changeForTask("other", unrelated.id, "pause");
    mock.timers.tick(3600000); await flush();
    assert.equal(starts, 2, "no future trigger after cancellation");
    cron.stop();
    const reopened = new AppDatabase(join(root, "app.db"));
    try {
      assert.equal(reopened.getCronJob(due.id)?.cancelledAt, stopped.job.cancelledAt);
      assert.deepEqual(reopened.listCronJobRuns(due.id, 5).map(run => run.id), [runningId]);
    } finally { reopened.close(); }
    console.log("PASS automation detail, scoped tied-timestamp paging, durable soft-cancel, and in-flight completion");
  } finally {
    release(); await flush(); cron.stop(); await cron.flushWrites();
    await db.runtimeAuditReader?.close(); db.close(); mock.timers.reset();
    rmSync(root, { recursive: true, force: true });
  }
}
