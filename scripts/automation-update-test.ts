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
import type { AgentPromptRequest } from "../src/shared/agent-ipc";

const drain = () => new Promise<void>(resolve => setImmediate(resolve));
export async function testAutomationUpdate() {
  const root = mkdtempSync(join(tmpdir(), "automation-update-"));
  const db = new AppDatabase(join(root, "app.db"));
  mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.UTC(2035, 0, 1) });
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const prompts: AgentPromptRequest[] = [];
  const agent: CronAgent = {
    prompt: async request => { prompts.push(request); await gate; return { queued: true, receipt: { taskId: request.taskId, operationId: request.userMessageId!, submissionId: prompts.length, status: "queued" } }; },
    waitForSubmission: async receipt => ({ queued: false, receipt: { ...receipt, status: "done" } }),
    loadTaskHistory: async () => ({ messages: [] }), isTaskBusy: () => false,
    getAppSettings: () => ({}), resolveAvailableModelId: async () => undefined,
    listSkills: () => [], listConnectors: () => [],
  };
  const cron = new CronService(db, agent);
  const tools = new Map<string, Parameters<ExtensionAPI["registerTool"]>[0]>();
  registerLocalWorkflowTools({ registerTool: tool => { tools.set(tool.name, tool); } }, {
    taskId: "source", taskRoot: root, terminalEnabled: false,
    services: { cron, terminal: {} as TaskTerminalService, getPermissionMode: () => "auto" },
  });
  const tool = tools.get("automation_exec")!;
  const invoke = (args: Record<string, unknown>) => tool.execute("test", args, new AbortController().signal, undefined, {} as never);
  try {
    db.upsertTask({ id: "source", title: "Source", cwd: root, permissionMode: "readonly", updatedAt: Date.now() });
    const job = cron.createForTask("source", root, { name: "Original", prompt: "old", scheduleType: "every", scheduleExpr: "1h", timezone: "UTC", target: "current-task" });
    const detail = await invoke({ action: "get", id: job.id });
    assert(!detail.isError);
    const snapshot = detail.details as { job: { id: string }; status: string; activeRun: unknown; latestRun: unknown };
    assert.deepEqual([snapshot.job.id, snapshot.status, snapshot.activeRun, snapshot.latestRun], [job.id, "scheduled", null, null]);
    const internals = cron as unknown as { timers: Map<string, unknown>; revisions: Map<string, number> };
    const timer = internals.timers.get(job.id);
    const revision = internals.revisions.get(job.id);
    assert(JSON.stringify(tool.parameters).includes('"update"'));
    mock.timers.tick(60000);
    const edited = await invoke({ action: "update", id: job.id, prompt: "new" });
    assert(!edited.isError);
    assert.equal(internals.timers.get(job.id), timer, "content edit keeps the exact pending timer, including a due tick");
    assert.equal(internals.revisions.get(job.id), revision);
    assert.equal(cron.listForTask("source")[0].nextRunAt, job.nextRunAt, "prompt edits preserve cadence");
    const updatedAt = db.getCronJob(job.id)!.updatedAt;
    mock.timers.tick(1);
    await invoke({ action: "update", id: job.id, prompt: "new" });
    assert.equal(db.getCronJob(job.id)!.updatedAt, updatedAt, "no-op retry does not write");
    assert.equal(internals.timers.get(job.id), timer);
    assert.equal(cron.listForTask("source")[0].nextRunAt, job.nextRunAt, "retry does not postpone");
    assert.equal(cron.listForTask("source").length, 1);
    assert.deepEqual(db.getCronJob(job.id)?.target, job.target);
    assert.equal(db.getCronJob(job.id)?.permissionMode, "readonly");
    assert.equal(db.getCronJob(job.id)?.createdAt, job.createdAt);
    const before = db.getCronJob(job.id);
    assert.throws(() => cron.updateForTask("other", job.id, { prompt: "intrusion" }), /不属于/);
    for (const patch of [{ schedule_expr: "0s" }, { timezone: "bad/timezone" }, { prompt: " " }, { target: "new-task" }, { deadline: "bad" }]) {
      assert((await invoke({ action: "update", id: job.id, ...patch })).isError);
      assert.deepEqual(db.getCronJob(job.id), before, "invalid update is atomic");
    }
    assert((await invoke({ action: "update", prompt: "missing" })).isError);
    mock.timers.tick(3539999); await drain();
    assert.equal(prompts.length, 1); assert.equal(prompts[0].text, "new");
    await invoke({ action: "update", id: job.id, prompt: "later", schedule_expr: "60s" });
    mock.timers.tick(60000); await drain();
    assert.equal(prompts.length, 1, "update does not duplicate active execution");
    assert.equal(prompts[0].text, "new", "active input is immutable");
    release(); await drain();
    mock.timers.tick(60000); await drain();
    assert.equal(prompts.length, 2); assert.equal(prompts[1].text, "later");
    assert.equal(db.getCronJob(job.id)?.runCount, 2);
    assert.equal((await cron.runsForTask("source")).length, 2, "history remains under original ID");
    cron.changeForTask("source", job.id, "pause");
    const paused = db.getCronJob(job.id)!;
    await invoke({ action: "update", id: job.id, name: "Paused edit", max_runs: 3 });
    assert.equal(db.getCronJob(job.id)?.enabled, false);
    assert.equal(db.getCronJob(job.id)?.lastRunAt, paused.lastRunAt);
    assert.equal(db.getCronJob(job.id)?.runCount, 2);
    mock.timers.tick(60000); await drain(); assert.equal(prompts.length, 2);

    const captured = Promise.withResolvers<void>();
    const unblock = Promise.withResolvers<void>();
    const readState = db.readCronJobState.bind(db);
    db.readCronJobState = async id => {
      const state = await readState(id);
      if (id === job.id) {
        captured.resolve();
        await unblock.promise;
      }
      return state;
    };
    const staleEdit = cron.updateTaskPlan("source", job.id, { prompt: "Concurrent edit" });
    const refused = assert.rejects(staleEdit, /已变化/);
    try {
      await captured.promise;
      db.upsertCronJob({ ...db.getCronJob(job.id)!, name: "Saved elsewhere" });
    } finally {
      unblock.resolve();
      await refused;
      db.readCronJobState = readState;
    }
    assert.equal(db.getCronJob(job.id)?.name, "Saved elsewhere");
    assert.equal(db.getCronJob(job.id)?.prompt, "later");
    const retried = await cron.updateTaskPlan("source", job.id, { prompt: "Concurrent edit" });
    assert.deepEqual([retried.name, retried.prompt], ["Saved elsewhere", "Concurrent edit"]);
    console.log("PASS automation update: tool schema, scope, identity/history, partial patch, cadence/retry, validation, active race, pause");
  } finally {
    release(); await drain(); cron.stop(); db.close(); mock.timers.reset(); rmSync(root, { recursive: true, force: true });
  }
}
