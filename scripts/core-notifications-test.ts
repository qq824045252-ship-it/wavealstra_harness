import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { ConversationGoalActivity } from "../src/main/agent/ConversationGoalActivity";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { NotificationService, type PublishNotificationInput } from "../src/main/notification/NotificationService";
import { createCoreTaskNotificationListeners } from "../src/main/notification/TaskLifecycleNotifications";
import { shutdownCoreWorker } from "../src/main/platform/core-client";
import { locateRuntimeAudit, RuntimeAuditReader } from "../src/main/platform/runtime-audit";
import type { AgentUiPatch } from "../src/shared/agent-ipc";
import { DEFAULT_BOT_ID, LOCAL_USER_ID } from "../src/shared/bot-work";
import { DEFAULT_NOTIFICATION_PREFERENCES, type NotificationDto } from "../src/shared/notification";

const executable = process.env.RUNTIME_AUDIT_BINARY ?? locateRuntimeAudit(process.cwd());
assert(executable && existsSync(executable), "This test requires the supervised Core worker");
const root = realpathSync(mkdtempSync(join(tmpdir(), "mybuddy-core-notifications-")));
const database = join(root, "app.duckdb");
const open = (coreRole?: "background-service") => new RuntimeAuditReader(executable, database, { coreDataDirectory: root, coreRole });
let ui = open();
const background = open("background-service");
const service = (core: RuntimeAuditReader, inAppEnabled: boolean) => new NotificationService({ core }, {
  read: () => ({ notificationPreferences: { ...DEFAULT_NOTIFICATION_PREFERENCES, inAppEnabled, desktopBackgroundOnly: false } }),
});
const notice: PublishNotificationInput = {
  type: "task.completed", level: "success", sourceType: "task", taskId: "task",
  title: "Task finished", target: { kind: "task", taskId: "task", messageId: "assistant-message" },
};

async function verifyCoreTaskNotices() {
  const db = await AppDatabase.open(database, { runtimeAuditExecutable: executable, runtimeAuditSupervised: true });
  const core = db.runtimeAuditReader!;
  const activityReader = open("background-service");
  const notifications = service(core, true);
  const sink = {
    publish: notifications.post.bind(notifications),
    markReadByDedupeKey: notifications.postMarkReadByDedupeKey.bind(notifications),
  };
  try {
    assert.equal(db.fixtureConnection, undefined);
    const taskId = "notification-ordinary-task", boundTaskId = "notification-work-execution";
    const now = Date.now();
    await db.writeTaskRecord({ id: taskId, title: "Core notification task", updatedAt: now });
    await db.writeTaskRecord({ id: boundTaskId, title: "Prior Work execution", updatedAt: now });
    await new BotRegistry(undefined, core).ensureDefaultBotSaved(LOCAL_USER_ID);
    const created = await core.createConversationGoal("notification-goal-create", {
      taskId, userId: LOCAL_USER_ID, defaultBotId: DEFAULT_BOT_ID, title: "Notification Goal", criteria: [],
    });
    assert(created?.ok);
    const binding = await core.batch4bWrite<{ ok: boolean }>({ op: "batch", ops: [
      { op: "workBindingInsert", bindingId: "notification-work-binding", workId: created.goal.work_id,
        operationId: "notification-execution", botId: DEFAULT_BOT_ID, taskId: boundTaskId,
        durableStoreKey: "notification-work-store", conversationId: "notification-work-conversation", intentRevision: 1,
        ownerEpoch: 1, inputSnapshotId: "notification-work-input", expertSnapshotJson: "{}", delegatedScopeJson: "[]",
        workspaceBinding: root, admittedAt: now, status: "invalidated", invalidatedAt: now + 1 },
    ] });
    assert.equal(binding?.ok, true);

    const listeners = createCoreTaskNotificationListeners(db, sink);
    const conversationId = "notification-source-conversation";
    const activity = new ConversationGoalActivity(undefined, activityReader);
    const generation = { taskId, conversationId, generationTaskId: 19 };
    activity.admit(taskId, { ...generation, inputs: [{ assistantMessageId: "actually-finished",
      owner: { goalId: created.goal.work_id, intentRevision: created.goal.intent_revision, ownerEpoch: created.goal.owner_epoch } }] });
    activity.settle(generation, "completed", "match-only-within-conversation");
    await activity.flush(taskId);
    assert.equal((await core.readConversationGoalActivityOwner(taskId, LOCAL_USER_ID, conversationId, "actually-finished"))?.goalId, created.goal.work_id);
    const complete = { kind: "completed", taskId, assistantMessageId: "actually-finished", conversationId } as const;
    await Promise.all([
      listeners.lifecycle(complete), listeners.lifecycle(complete),
      listeners.lifecycle({ ...complete, taskId: boundTaskId }),
      listeners.lifecycle({ ...complete, taskId: "deleted-task" }),
      listeners.lifecycle({ kind: "failed", taskId: boundTaskId, assistantMessageId: "failed-work", error: "Process failed" }),
      listeners.lifecycle({ ...complete, assistantMessageId: "match-only-within-conversation", conversationId: "other-conversation" }),
    ]);
    await notifications.flushWrites();
    const lifecycle = (await notifications.readList()).filter(row => row.taskId === taskId || row.taskId === boundTaskId);
    assert.equal(lifecycle.length, 3);
    const targets = lifecycle.filter(row => row.taskId === taskId).map(row => row.target);
    assert(targets.some(target => target?.kind === "task" && target.messageId === "actually-finished" && target.workId === created.goal.work_id));
    assert(targets.some(target => target?.kind === "task" && target.messageId === "match-only-within-conversation" && target.workId === undefined));
    assert.equal(lifecycle.find(row => row.taskId === boundTaskId)?.body, "Prior Work execution · Process failed");
    assert.equal((await notifications.readList()).some(row => row.taskId === "deleted-task"), false);

    const patch = { type: "conversation_interaction_snapshot", taskId, executionId: "actual-execution", messageId: "asking",
      interaction: { id: "pending-question", taskId, executionId: "actual-execution", assistantMessageId: "asking", kind: "confirm",
        title: "Continue?", status: "pending", options: [], createdAt: now, version: 1 } } satisfies AgentUiPatch;
    const terminal = { ...patch, interaction: { ...patch.interaction, status: "resolved", answer: true, version: 2 } } satisfies AgentUiPatch;
    await listeners.patch(patch);
    await notifications.flushWrites();
    assert.deepEqual((await notifications.readList({ query: "Continue?", unreadOnly: true }))[0]?.target,
      { kind: "task", taskId, messageId: "asking", interactionId: "pending-question" });
    await listeners.patch(terminal);
    await notifications.flushWrites();
    assert.deepEqual(await notifications.readList({ query: "Continue?", unreadOnly: true }), []);

    const reading = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const slowReaders = createCoreTaskNotificationListeners({ runtimeAuditReader: core,
      async readTask(...args) {
        reading.resolve();
        await release.promise;
        return db.readTask(...args);
      },
    }, sink);
    const stalled = { ...patch, interaction: { ...patch.interaction, id: "answered-during-read", title: "Already answered" } };
    const inflight = slowReaders.patch(stalled);
    await reading.promise;
    await slowReaders.patch({ ...terminal, interaction: { ...terminal.interaction, id: "answered-during-read" } });
    release.resolve();
    await inflight;
    await notifications.flushWrites();
    assert.deepEqual(await notifications.readList({ query: "Already answered" }), []);
    console.log("PASS Core task notifications link only the exact Goal conversation, deduplicate completion, and discard questions resolved during a read");
  } finally {
    await Promise.all([core.close(), activityReader.close()]);
    db.close();
  }
}

try {
  assert.equal((await ui.upsertTaskRecord({ id: "task", title: "Task", at: Date.now(),
    preserveTitle: false, preserveWorkspace: false }))?.status, "saved");
  const app = service(ui, true);
  const backgroundApp = service(background, true);
  const bell = { ...notice, dedupeKey: "bell" };
  const published = (await Promise.all([app.publishPersisted(bell), backgroundApp.publishPersisted(bell)])).filter(Boolean);
  assert.equal(published.length, 1);
  const [stored] = await app.readList({ grouped: true });
  assert.equal(stored.id, published[0]?.id);
  assert.equal(stored.group?.activationId, stored.id);
  assert.deepEqual(stored.group?.target, notice.target);
  assert.equal(await app.readUnreadCount(), 1);
  await backgroundApp.writeDismiss(stored.id);
  const badge: number[] = [];
  app.setChangedListener(event => badge.push(event.unreadCount));
  assert.deepEqual(await app.catchupFromCore(), { unreadCount: 0, notifications: [] });
  assert.deepEqual(badge, [0]);
  assert.deepEqual(await app.readActivation(stored.id), notice.target);
  console.log("PASS concurrent bell publish, grouped target, dismissal, and empty catchup");

  const shared = { ...notice, dedupeKey: "local-and-remote" };
  const [local, remote] = await Promise.all([
    app.publishPersisted(shared),
    background.remoteControl<{ inserted: boolean }>({ action: "publishNotification", ...shared }),
  ]);
  assert(remote);
  assert.equal(Number(local !== null) + Number(remote.inserted), 1);
  assert.equal((await app.readList()).length, 1);
  await app.writeDismissAll();
  console.log("PASS desktop and remote publishers contend for the same dedupe key");

  const desktop = service(ui, false);
  const backgroundDesktop = service(background, false);
  const delivered: NotificationDto[] = [];
  for (const client of [desktop, backgroundDesktop]) client.setDesktopDelivery(record => delivered.push(record));
  const desktopNotice = { ...notice, dedupeKey: "desktop" };
  await Promise.all([desktop.publishPersisted(desktopNotice), backgroundDesktop.publishPersisted(desktopNotice)]);
  assert.equal(delivered.length, 1);
  assert.deepEqual(await app.readList(), []);
  assert.equal(await app.publishPersisted(desktopNotice), null);
  assert.equal(await desktop.publishPersisted(bell), null);
  const [toast] = delivered;
  assert.deepEqual(await backgroundDesktop.readActivation(toast.id), notice.target);

  await Promise.all([ui.close(), background.close()]);
  await shutdownCoreWorker(root, database);
  ui = open();
  const reopened = service(ui, false);
  reopened.setDesktopDelivery(record => delivered.push(record));
  assert.equal(await reopened.publishPersisted(desktopNotice), null);
  assert.equal(delivered.length, 1);
  assert.deepEqual(await reopened.readActivation(toast.id), notice.target);
  assert.deepEqual(await ui.batch2Write({ kind: "deleteTask", id: "task" }), { ok: true });
  assert.equal(await reopened.readActivation(toast.id), null);
  assert.equal(await reopened.readActivation("missing"), null);
  console.log("PASS desktop claim survives concurrent publish and restart; deleted target cannot activate");

  const at = Date.now();
  assert.equal((await ui.upsertTaskRecord({ id: "purged", title: "Purged task", at,
    preserveTitle: false, preserveWorkspace: false }))?.status, "saved");
  const purgeNotice = await reopened.publishPersisted({ ...notice, taskId: "purged", target: { kind: "task", taskId: "purged" } });
  assert(purgeNotice);
  assert.deepEqual(await ui.batch2Write({ kind: "commitTaskWorkspaceTrashed", taskId: "purged", directoryName: "purged",
    createdAt: at, trashedAt: at + 1, purgeAfter: at + 2 }), { ok: true });
  const purge = { taskId: "purged", updatedAt: at + 1, trashedAt: at + 1,
    archiveScope: { direct: "explicit" as const, selectedRoots: [] } };
  assert.equal((await ui.purgeTrashedTask({ ...purge, updatedAt: at }))?.status, "rejected");
  assert.deepEqual(await reopened.readActivation(purgeNotice.id), { kind: "task", taskId: "purged" });
  assert.equal((await ui.purgeTrashedTask(purge))?.status, "saved");
  assert.equal(await reopened.readActivation(purgeNotice.id), null);
  console.log("PASS stale trash purge is rejected and committed purge invalidates the old target");

  const expired = await reopened.publishPersisted({ type: "automation.completed", level: "success",
    sourceType: "automation", title: "Old automation", createdAt: Date.now() - 91 * 24 * 60 * 60 * 1000 });
  assert(expired);
  assert.equal(await reopened.readActivation(expired.id), null);
  const intrinsic = { type: "automation.completed", level: "success", sourceType: "automation", title: "Another run" } as const;
  const [first, second] = await Promise.all([service(ui, true).publishPersisted(intrinsic), service(ui, true).publishPersisted(intrinsic)]);
  assert(first && second);
  assert.notEqual(first.id, second.id);
  await reopened.cleanupStored();
  assert.equal(await reopened.readActivation(expired.id), null);
  assert.equal(await reopened.readUnreadCount(), 2, "independent notices without a dedupe key are both recorded");
  console.log("PASS native cleanup leaves independent notices without a dedupe key intact");
  await verifyCoreTaskNotices();
} finally {
  await Promise.all([ui.close(), background.close()]);
  await shutdownCoreWorker(root, database);
  rmSync(root, { recursive: true, force: true });
}
