import assert from "node:assert/strict";
import type { AppDatabase } from "../src/main/db/AppDatabase";
import { encodeCronPlan } from "../src/main/db/CronPlanPersistence";
import { DotsActions } from "../src/main/dots/DotsActions";
import type { RuntimeAuditReader } from "../src/main/platform/runtime-audit";
import { DOTS_TASK_ID } from "../src/shared/dots";

export async function verifyDotsProactiveControl(db: AppDatabase, background: RuntimeAuditReader, root: string): Promise<void> {
  const core = db.runtimeAuditReader!;
  assert(core.supervised && !db.fixtureConnection);
  const at = Date.now();
  const spaceA = "proactive-control-a";
  const spaceB = "proactive-control-b";
  const archived = "proactive-control-archived";
  const archivedChild = "proactive-control-archived-child";
  const gateway = "sp-gw-proactive-control";
  for (const id of [spaceA, spaceB, archived]) await db.writeWorkspaceUpsert({ id, name: id, path: root });
  await db.writeWorkspaceUpsert({ id: archivedChild, name: archivedChild, parentId: archived });
  await db.writeSpaceArchive(archived, true);
  assert(await core.batch2Write({ kind: "upsertSpaceRaw", id: gateway, name: "Gateway fixture", path: root,
    parentId: null, hasParent: false, sortOrder: null, hasSortOrder: false, at }));
  assert((await db.readSpaces()).some(space => space.id === gateway));
  const taskId = "proactive-control-task";
  assert.equal((await core.upsertTaskRecord({ id: taskId, title: taskId, at, spaceId: spaceA, cwd: root,
    preserveTitle: false, preserveWorkspace: false }))?.status, "saved");
  assert.deepEqual(await core.batch2Write({ kind: "openDots", at }), { ok: true });

  let allowed: readonly string[] | null = null;
  const actions = new DotsActions(db, {} as ConstructorParameters<typeof DotsActions>[1], {
    preferences: () => ({ followupMode: "continue", spaceIds: allowed }),
    link: () => assert.fail("A proactive control must not delegate"),
  }, { page: async () => assert.fail("A proactive control must not read the task board") });
  const control = (source: string, action: "pause_proactive" | "resume_proactive", spaceId?: string) =>
    actions.execute(DOTS_TASK_ID, source, { action, spaceId });
  const createPlan = async (id: string, spaceId: string, manual = false) => {
    const row = encodeCronPlan({ id, name: id, prompt: "Check progress", scheduleType: "every", scheduleExpr: "1h",
      timezone: "UTC", enabled: !manual, sourceTaskId: DOTS_TASK_ID, target: { kind: "task", taskId: DOTS_TASK_ID },
      createdAt: at, updatedAt: at });
    assert.equal(await core.writeCronPlan({ kind: "save", row, expected: null,
      provenance: { source: `proactive-fixture-${id}`, origin: { conversationId: 1, entryId: 1 }, owner: { spaceId } },
      ...(manual ? { manualHold: "add" } : {}),
    }), true);
  };
  const enabled = async (id: string) => (await db.readCronJobState(id))?.job.enabled;
  const scopeHeld = async () => (await background.readDotsFileWatchData<{ scope: { held: boolean } | null }>({
    kind: "scope", taskId, spaceId: spaceA,
  }))?.scope?.held;

  const status = await core.cronScheduler<{ config: { dotsSpaceIds: string[] | null; dotsFollowupMode: string } }>({ action: "status" });
  assert(status?.config);
  const setScope = async (spaceIds: string[] | null) => {
    assert.equal((await core.cronScheduler({ action: "syncConfig", dotsSpaceIds: spaceIds, dotsFollowupMode: "continue" }))?.status, "ok");
  };
  const planA = "proactive-plan-a";
  const planB = "proactive-plan-b";
  const manual = "proactive-plan-manual";
  const late = "proactive-plan-created-during-pause";
  try {
    await assert.rejects(control("goal-continuation:background", "pause_proactive"), /用户明确交代/);
    await assert.rejects(background.setDotsProactive("cron-background", true), /用户明确交代/);
    await assert.rejects(control("proactive-user-archived", "pause_proactive", archivedChild), /不存在或未授权/);
    await assert.rejects(control("proactive-user-gateway", "pause_proactive", gateway), /不存在或未授权/);
    await setScope([spaceA]);
    allowed = [spaceA];
    await assert.rejects(control("proactive-user-unlisted", "pause_proactive", spaceB), /不存在或未授权/);
    await assert.rejects(background.setDotsProactive("proactive-direct-unlisted", true, spaceB), /不存在或未授权/);
    await setScope(null);
    allowed = null;

    await createPlan(planA, spaceA);
    await createPlan(planB, spaceB);
    await createPlan(manual, spaceA, true);
    const [paused, duplicate] = await Promise.all([
      control("proactive-user-a", "pause_proactive", spaceA),
      background.setDotsProactive("proactive-user-a", true, spaceA),
    ]);
    assert.deepEqual(paused, duplicate);
    assert(paused && "schedules" in paused && Array.isArray(paused.schedules));
    assert.deepEqual({ ...paused, schedules: [...paused.schedules].sort((a, b) => a.id.localeCompare(b.id)) }, { scope: spaceA, proactive: "paused", schedules: [
      { id: planA, state: "paused" }, { id: manual, state: "paused" },
    ] });
    assert.deepEqual(await Promise.all([enabled(planA), enabled(planB), enabled(manual), scopeHeld()]), [false, true, false, true]);

    await control("proactive-user-global", "pause_proactive");
    assert.equal(await enabled(planB), false);
    await createPlan(late, spaceB);
    const hasTimer = async () => Boolean((await core.cronScheduler<{ schedules: unknown[] }>({ action: "status", jobId: late }))?.schedules.length);
    await core.cronScheduler({ action: "tick", nowMs: at + 60_000 });
    assert.equal(await hasTimer(), false);
    await control("proactive-user-global-resume", "resume_proactive");
    assert.deepEqual(await Promise.all([enabled(planA), enabled(planB), enabled(manual), scopeHeld()]), [false, true, false, true]);
    await core.cronScheduler({ action: "tick", nowMs: at + 61_000 });
    assert.equal(await hasTimer(), true);

    await control("proactive-user-a-resume", "resume_proactive", spaceA);
    assert.deepEqual(await control("proactive-user-a", "pause_proactive", spaceA), paused, "Older receipt replay returns the original result");
    assert.deepEqual(await Promise.all([enabled(planA), enabled(planB), enabled(manual), scopeHeld()]), [true, true, false, false]);
    console.log("PASS Dots proactive controls commit once through Core and preserve scoped, global, and manual hold ownership");
  } finally {
    for (const id of [planA, planB, manual, late]) {
      const state = await core.cronData<{ row: Record<string, unknown> } | null>({ kind: "jobState", jobId: id });
      if (state) {
        const { run_count: _runCount, ...expected } = state.row;
        await core.writeCronPlan({ kind: "remove", id, expected });
      }
    }
    await core.cronScheduler({ action: "syncConfig", dotsSpaceIds: status.config.dotsSpaceIds, dotsFollowupMode: status.config.dotsFollowupMode });
    await actions.closeFileWatches();
  }
}
