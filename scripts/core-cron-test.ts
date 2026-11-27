import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type EntryId, type SubmissionId } from "@earendil-works/pi-durable";
import { DuckDbStorage, resolveStoreId } from "../src/main/agent/durable/DuckDbStorage";
import type { CronJobDto } from "../src/shared/agent-ipc";
import { DOTS_TASK_ID } from "../src/shared/dots";
import { encodeCronPlan, type CronPlanGuard } from "../src/main/db/CronPlanPersistence";
import { shutdownCoreWorker } from "../src/main/platform/core-client";
import { CoreBusinessClient } from "../src/main/platform/core-business-client";
import { locateRuntimeAudit, RuntimeAuditReader } from "../src/main/platform/runtime-audit";

type Row = Record<string, unknown>;
type JobState = {
  row: Row;
  activeRun: Row | null;
  latestRun: Row | null;
  owner: { taskId: string | null; spaceId: string | null } | null;
  unavailableReason: string | null;
};

const executable = process.env.RUNTIME_AUDIT_BINARY ?? locateRuntimeAudit(process.cwd());
assert(executable && existsSync(executable), "This test requires the supervised Core worker");
const root = realpathSync(mkdtempSync(join(tmpdir(), "mybuddy-core-cron-")));
const database = join(root, "app.duckdb");
const ui = new RuntimeAuditReader(executable, database, { coreDataDirectory: root });
const background = new RuntimeAuditReader(executable, database, { coreDataDirectory: root, coreRole: "background-service" });
const at = Date.UTC(2035, 0, 1, 12);

const snapshot = (reader: RuntimeAuditReader, jobId: string) => reader.cronData<JobState | null>({ kind: "jobState", jobId });
const expected = (state: JobState) => {
  const { run_count: _count, ...row } = state.row;
  return row;
};
const plan = (id: string, taskId: string): CronJobDto => ({
  id, name: "Scheduled review", prompt: "Review the current result", scheduleType: "every", scheduleExpr: "1h", timezone: "UTC",
  enabled: true, sourceTaskId: taskId, target: { kind: "task", taskId }, createdAt: at, updatedAt: at,
});
const openTask = (id: string, spaceId?: string) => ui.upsertTaskRecord({
  id, title: id, at, spaceId, preserveTitle: false, preserveWorkspace: false,
});

async function assertDotsTimerAuthorization(dots: ReturnType<typeof encodeCronPlan>, guard: CronPlanGuard): Promise<void> {
  const realTime = Date.now();
  assert.equal((await ui.cronScheduler({ action: "syncConfig", dotsFollowupMode: "continue", dotsSpaceIds: ["scope"] }))?.status, "ok");
  const started = await ui.cronScheduler<{ status: string; runId: string | null }>({ action: "runNow", jobId: dots.id, nowMs: realTime });
  assert(started?.status === "ok" && started.runId);
  const runId = started.runId;
  const source = `cron-${runId}-input`;
  const stored = await ui.cronData<string>({ kind: "runInput", runId });
  assert(stored);
  const { request } = JSON.parse(stored) as { request: { text: string; assistantMessageId: string } };
  const admission = { kind: "dotsRunAuthorization", source, purpose: "admission", assistantMessageId: request.assistantMessageId,
    textHash: createHash("sha256").update(request.text).digest("hex") } as const;
  const continuation = { kind: "dotsRunAuthorization", source, purpose: "continuation" } as const;
  const notification = { kind: "dotsRunAuthorization", source, purpose: "notification" } as const;
  const readAuthorization = (query: Parameters<RuntimeAuditReader["cronData"]>[0]) => background.cronData(query);
  const allowed = { allowed: true, ownerSpaceId: "scope" };
  const denied = { allowed: false, ownerSpaceId: null };
  assert.deepEqual(await readAuthorization(admission), allowed);
  assert.deepEqual(await readAuthorization({ ...admission, textHash: "bad" }), denied);
  assert.deepEqual(await readAuthorization({ ...admission, assistantMessageId: "foreign-reply" }), denied);
  assert.deepEqual(await readAuthorization({ ...continuation, source: "cron-00000000-0000-0000-0000-000000000000-input" }), denied);
  assert.deepEqual(await readAuthorization(notification), denied);

  const directory = join(root, "dots-store");
  mkdirSync(directory);
  assert.equal((await ui.writeDurableTaskProjection({ kind: "bindBot", taskId: DOTS_TASK_ID, directory, cwd: directory }))?.status, "applied");
  const store = await DuckDbStorage.openWriter(ui, await resolveStoreId(ui, directory));
  try {
    const context = BACKGROUND_CONTEXT;
    const conversationId = ROOT_CONVERSATION_ID;
    const inputId = await store.mintId<SubmissionId>();
    const entryId = await store.mintId<EntryId>();
    const ordinaryInputId = await store.mintId<SubmissionId>();
    assert.equal((await store.commit([[{ type: "conversation", value: { id: conversationId } }]], () => undefined, context)).stored, 1);
    const receipt = (id: SubmissionId, requestId: string) => ({ type: "submission" as const,
      value: { id, conversationId, requestId, type: "input" as const, status: "queued" as const } });
    const queued = await store.commit([[receipt(inputId, source)]], () => undefined, context);
    assert.equal(queued.stored, 1, String(queued.refused ?? ""));
    const placement = (text: string) => [{ type: "entry" as const,
      value: { id: entryId, conversationId, kind: "mybuddy.user", data: { mybuddyInput: { inputRequestId: source, text } } } },
      { type: "submission" as const, value: { ...receipt(inputId, source).value, status: "placed" as const, entry: entryId } }];

    const operationId = "dots-input-while-timer-held";
    const link = { kind: "dotsDelegationLink", operationId, taskId: "owner-b", sourceMessageId: source, now: realTime,
      supersedes: false, requestJson: JSON.stringify({ taskId: "owner-b", userMessageId: operationId }) };
    const activeDots = await snapshot(ui, dots.id);
    assert(activeDots);
    assert.equal(await ui.writeCronPlan({ kind: "save", row: { ...dots, ...expected(activeDots), enabled: 0 }, expected: expected(activeDots),
      manualHold: "add", guard }), true);
    assert.deepEqual(await readAuthorization(admission), denied);
    assert.deepEqual(await readAuthorization(continuation), denied);
    const revokedPlacement = await store.commit([placement(request.text)], () => undefined, context);
    assert.equal(revokedPlacement.stored, 0);
    assert.match(String(revokedPlacement.refused ?? ""), /定时输入的授权已撤销/);
    assert.equal(await store.entry(entryId, context), undefined);
    const ordinaryQueued = await store.commit([[receipt(ordinaryInputId, "normal-user-input")]], () => undefined, context);
    assert.equal(ordinaryQueued.stored, 1, String(ordinaryQueued.refused ?? ""));
    await background.batch4aWrite(link).catch(() => undefined);
    assert.deepEqual(await ui.readDotsDelegations([source]), []);
    const held = await snapshot(ui, dots.id);
    assert(held);
    assert(guard.dots);
    const resumeGuard = { ...guard, dots: { ...guard.dots, ignoreManualHold: true } };
    assert.equal(await ui.writeCronPlan({ kind: "save", row: { ...dots, ...expected(held), enabled: 1 }, expected: expected(held),
      manualHold: "remove", guard: resumeGuard }), true);
    assert.deepEqual(await background.batch4aWrite(link), { inserted: true });
    assert.deepEqual((await ui.readDotsDelegations([source])).map(row => row.id), [operationId]);
    assert.equal((await store.commit([placement("Different content")], () => undefined, context)).stored, 0);
    const acceptedPlacement = await store.commit([placement(request.text)], () => undefined, context);
    assert.equal(acceptedPlacement.stored, 1, String(acceptedPlacement.refused ?? ""));
    assert.equal((await store.entry(entryId, context))?.entry.kind, "mybuddy.user");
    assert.equal((await store.commit([[receipt(await store.mintId<SubmissionId>(), source)]], () => undefined, context)).stored, 0);

    assert.equal(await ui.writeCronRun({ kind: "finish", runId, status: "success", taskId: DOTS_TASK_ID, finishedAt: Date.now() }), true);
    assert.deepEqual(await readAuthorization(admission), denied, "A settled occurrence cannot admit another Dots input");
    assert.deepEqual(await readAuthorization(continuation), allowed, "A settled occurrence still identifies its original delegation");
    assert.deepEqual(await readAuthorization(notification), allowed);
    assert.equal((await ui.cronScheduler({ action: "syncConfig", dotsFollowupMode: "continue", dotsSpaceIds: ["another-space"] }))?.status, "ok");
    assert.deepEqual(await readAuthorization(notification), denied);
    console.log("PASS a Dots timer validates its persisted input, rejects replay at admission, and rechecks hold and scope before linking or notifying");
  } finally {
    await store.close(BACKGROUND_CONTEXT);
  }
}

try {
  assert.equal(await snapshot(ui, "missing"), null);
  assert.equal((await openTask("ordinary"))?.status, "saved");
  const ordinary = encodeCronPlan(plan("ordinary-plan", "ordinary"));
  const guard: CronPlanGuard = { tasks: ["ordinary"], projects: [], targetTaskId: "ordinary" };
  assert.equal(await ui.writeCronPlan({ kind: "save", row: ordinary, expected: null, guard }), true);
  const [left, right] = await Promise.all([snapshot(ui, ordinary.id), snapshot(background, ordinary.id)]);
  assert(left && right && left.unavailableReason === null);
  const [renamed, rewritten] = await Promise.all([
    ui.writeCronPlan({ kind: "save", row: { ...ordinary, name: "UI title", updated_at: at + 1 }, expected: expected(left), guard }),
    background.writeCronPlan({ kind: "save", row: { ...ordinary, prompt: "Background prompt", updated_at: at + 2 }, expected: expected(right), guard }),
  ]);
  assert.equal(Number(renamed) + Number(rewritten), 1, "Two writes cannot both commit against the same plan snapshot");
  const current = await snapshot(background, ordinary.id);
  assert(current);
  assert.equal(current.row.name, renamed ? "UI title" : ordinary.name);
  assert.equal(current.row.prompt, rewritten ? "Background prompt" : ordinary.prompt);

  const inputJson = JSON.stringify({ request: { taskId: "ordinary", text: "Test persisted input" } });
  assert.equal(await background.writeCronRun({ kind: "start", inputJson, expectedJob: expected(current), requiredTasks: ["ordinary"],
    requiredProjects: [], run: { id: "active-run", jobId: ordinary.id, status: "running", startedAt: at + 3, taskId: "ordinary" } }), true);
  assert.equal(await ui.writeCronRun({ kind: "record", run: { id: "latest-run", jobId: ordinary.id,
    status: "success", startedAt: at + 4, finishedAt: at + 5, taskId: "ordinary" } }), true);
  const running = await snapshot(ui, ordinary.id);
  assert(running);
  assert.deepEqual([running.activeRun?.id, running.latestRun?.id, running.row.run_count], ["active-run", "latest-run", 2]);
  assert.equal(await background.cronData({ kind: "runInput", runId: "active-run" }), inputJson);
  assert.equal(await ui.writeCronPlan({ kind: "remove", id: ordinary.id, expected: expected(running) }), true);
  assert.equal(await snapshot(background, ordinary.id), null);
  assert.equal(await background.cronData({ kind: "runInput", runId: "active-run" }), null);
  console.log("PASS stale plan updates are rejected, job and runs share a snapshot, and removal clears run input");

  assert.equal((await ui.upsertWorkspace({ id: "scope", name: "Scope", at }))?.status, "saved");
  assert.equal((await openTask("owner-a", "scope"))?.status, "saved");
  assert.equal((await openTask("owner-b", "scope"))?.status, "saved");
  assert.deepEqual(await ui.batch2Write({ kind: "openDots", at }), { ok: true });
  const dots = { ...encodeCronPlan(plan("dots-plan", DOTS_TASK_ID)), enabled: 0 };
  const ownerA = { taskId: "owner-a", spaceId: "scope" };
  const ownerB = { taskId: "owner-b", spaceId: "scope" };
  const origin = { source: "source", origin: { conversationId: 1, entryId: 1 }, owner: ownerA };
  const dotsGuard = (owner: typeof ownerA): CronPlanGuard => ({ tasks: [DOTS_TASK_ID], projects: [],
    targetTaskId: DOTS_TASK_ID, dots: { ...owner, ignoreManualHold: false } });
  assert.equal(await ui.writeCronPlan({ kind: "save", row: dots, expected: null, provenance: origin,
    manualHold: "add", guard: dotsGuard(ownerA) }), true);
  const original = await snapshot(ui, dots.id);
  assert(original);
  assert.deepEqual(original.owner, ownerA);
  assert.equal(await background.writeCronPlan({ kind: "remove", id: dots.id, expected: expected(original) }), true);
  assert.equal(await background.writeCronPlan({ kind: "save", row: dots, expected: null, guard: dotsGuard(ownerB),
    provenance: { ...origin, owner: ownerB } }), true);
  const replacement = await snapshot(ui, dots.id);
  assert(replacement);
  assert.deepEqual(expected(replacement), expected(original), "Ownership changed while the plan row remained byte-for-byte equivalent");
  assert.deepEqual(replacement.owner, ownerB);
  const enabled = { ...dots, enabled: 1, updated_at: at + 6 };
  assert.equal(await ui.writeCronPlan({ kind: "save", row: enabled, expected: expected(original), guard: dotsGuard(ownerA) }), false);
  assert.equal(await ui.writeCronPlan({ kind: "save", row: enabled, expected: expected(replacement), guard: dotsGuard(ownerB) }), true);
  assert.equal((await snapshot(background, dots.id))?.row.enabled, 1);
  console.log("PASS removal cleans old holds and scopes, and a replaced plan rejects the previous owner's write");

  await assertDotsTimerAuthorization(dots, dotsGuard(ownerB));

  const quota = { ...guard, enabledLimitForTask: "ordinary" };
  for (let index = 0; index < 19; index++) {
    const row = encodeCronPlan(plan(`quota-${index}`, "ordinary"));
    assert.equal(await ui.writeCronPlan({ kind: "save", row, expected: null, guard: quota }), true);
  }
  const lastSlot = await Promise.all([ui, background].map((reader, index) => reader.writeCronPlan({
    kind: "save", row: encodeCronPlan(plan(`competing-${index}`, "ordinary")), expected: null, guard: quota,
  })));
  assert.deepEqual([...lastSlot].sort(), [false, true]);
  console.log("PASS an automation quota cannot be oversold by competing Core clients");

  const recoveryJobId = lastSlot[0] ? "competing-0" : "competing-1";
  const started = await ui.cronScheduler<{ status: string; runId: string }>({ action: "runNow", jobId: recoveryJobId });
  assert(started?.status === "ok" && started.runId);
  const savedInput = await ui.cronData<string>({ kind: "runInput", runId: started.runId });
  assert(savedInput);

  const orphanPlan = encodeCronPlan({ ...plan("orphan-job", "ordinary"), enabled: false });
  assert.equal(await ui.writeCronPlan({ kind: "save", row: orphanPlan, expected: null, guard }), true);
  const orphan = await snapshot(ui, orphanPlan.id);
  assert(orphan);
  const orphanId = "no-execution-receipt";
  const orphanInput = JSON.stringify({ request: { taskId: "ordinary", userMessageId: `cron-${orphanId}-input`, welcomeMode: "bot" } });
  assert.equal(await ui.writeCronRun({ kind: "start", inputJson: orphanInput, expectedJob: expected(orphan),
    requiredTasks: ["ordinary"], requiredProjects: [],
    run: { id: orphanId, jobId: orphanPlan.id, taskId: "ordinary", startedAt: Date.now(), status: "running" } }), true);

  await ui.close();
  await background.close();
  await shutdownCoreWorker(root, database);

  const reopened = new RuntimeAuditReader(executable, database, { coreDataDirectory: root });
  let executor: CoreBusinessClient | undefined;
  try {
    assert.equal((await reopened.cronScheduler({ action: "start" }))?.status, "ok");
    assert.equal((await snapshot(reopened, recoveryJobId))?.activeRun?.id, started.runId);
    assert.equal(await reopened.cronData({ kind: "runInput", runId: started.runId }), savedInput);
    const orphanState = await snapshot(reopened, orphanPlan.id);
    assert.equal(orphanState?.activeRun, null);
    assert.equal(orphanState?.latestRun?.status, "error");
    assert.equal(await reopened.cronData({ kind: "runInput", runId: orphanId }), orphanInput, "Startup leaves unsupported historical inputs alone");

    executor = await CoreBusinessClient.connect(executable, database, { dataDirectory: root, role: "execution-host", clientId: "cron-recovery" });
    assert.equal((await reopened.cronScheduler({ action: "scanRecovery" }))?.status, "ok");
    const executionId = `cron-exec-${started.runId}`;
    const execution = (await executor.executionStatus(executionId)).execution;
    assert.equal(execution?.status, "dispatching");
    assert.equal(execution.idempotencyKey, `cron-${started.runId}-input`);
    assert.equal((await executor.executionStatus(`cron-exec-${orphanId}`)).execution, null);
    assert.equal((await executor.executorAck(executionId, execution.attempt)).status, "ok");
    assert.equal((await executor.executorSettled({ executionId, attempt: execution.attempt, status: "completed" })).status, "ok");
    assert.equal((await snapshot(reopened, recoveryJobId))?.latestRun?.status, "success");
    console.log("PASS reopening Core preserves and settles current Cron receipts without reconstructing orphan runs");
  } finally {
    await executor?.close();
    await reopened.close();
  }
} finally {
  await ui.close();
  await background.close();
  await shutdownCoreWorker(root, database);
  rmSync(root, { recursive: true, force: true });
}
