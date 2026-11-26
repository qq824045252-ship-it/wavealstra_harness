import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { CronService, type CronAgent } from "../src/main/cron/CronService";
import { encodeCronPlan } from "../src/main/db/CronPlanPersistence";
import { DotsDiscovery } from "../src/main/dots/DotsDiscovery";
import { DotsGoogleAccounts } from "../src/main/dots/DotsGoogleAccounts";
import { DotsGoogleMonitor } from "../src/main/dots/DotsGoogleMonitor";
import { DotsProactiveDelivery } from "../src/main/dots/DotsProactiveDelivery";
import { ExecutionHostBridge, createDurableBotExecutionRunner } from "../src/main/host/ExecutionHostBridge";
import { NotificationService } from "../src/main/notification/NotificationService";
import { CoreBusinessClient } from "../src/main/platform/core-business-client";
import { shutdownCoreWorker } from "../src/main/platform/core-client";
import { locateRuntimeAudit } from "../src/main/platform/runtime-audit";
import type { AgentPromptRequest, CronJobDto } from "../src/shared/agent-ipc";
import { DOTS_TASK_ID } from "../src/shared/dots";

async function waitUntil(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`Timeout waiting for: ${label}`);
    await delay(30);
  }
}

async function main(): Promise<void> {
  const executable = locateRuntimeAudit(process.cwd());
  assert(executable && existsSync(executable), "Rust runtime-audit executable is required");

  const root = mkdtempSync(join(tmpdir(), "mybuddy-rust-bg-services-"));
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.MYBUDDY_WORK_AUTO_TICK_MS = "200";

  const dataDir = join(root, ".mybuddy");
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, "app.db");

  let db: AppDatabase | undefined;
  let bridge: ExecutionHostBridge | undefined;
  let cron: CronService | undefined;
  let googleMonitor: DotsGoogleMonitor | undefined;
  let discovery: DotsDiscovery | undefined;
  let proactive: DotsProactiveDelivery | undefined;

  try {
    db = await AppDatabase.open(dbPath, {
      runtimeAuditExecutable: executable,
      runtimeAuditSupervised: true,
      readonly: true,
    });
    const reader = db.runtimeAuditReader!;
    assert.equal(reader.supervised, true, "supervised Core reader must be active");

    // Seed tasks before Cron/Dots execution.
    await db.writeTaskRecord({
      id: DOTS_TASK_ID,
      title: "Dots",
      updatedAt: Date.now(),
    });
    await db.writeTaskRecord({
      id: "source-task",
      title: "Automation Source",
      cwd: root,
      updatedAt: Date.now(),
    });

    const cronPrompts: AgentPromptRequest[] = [];
    const notifications = new NotificationService(db);
    let notificationEvents = 0;
    notifications.setChangedListener(() => { notificationEvents += 1; });

    bridge = new ExecutionHostBridge(
      executable,
      dbPath,
      dataDir,
      createDurableBotExecutionRunner({
        submit: async () => ({ queued: true }),
        submitCron: async (req) => {
          cronPrompts.push(req);
          return {
            queued: true,
            receipt: {
              taskId: req.taskId,
              operationId: req.userMessageId!,
              submissionId: cronPrompts.length,
              status: "queued",
            },
          };
        },
        waitForSubmission: async (receipt) => ({
          queued: false,
          receipt: { ...receipt, status: "done" },
        }),
        abort: async () => undefined,
        findSubmission: async () => undefined,
        isTaskBusy: () => false,
        resolveAvailableModelId: async (id) => ({ modelId: id }),
        dotsSubmission: async () => ({ text: "Dots periodic follow-up complete" }),
      }),
    );
    await bridge.connect();

    // -------------------------------------------------------------------------
    // RC-14: Cron & Dots trigger without UI; sleep/missed/clock-jump/causal dedup
    // -------------------------------------------------------------------------
    const cronAgent: CronAgent = {
      prompt: async () => ({ queued: true }),
      waitForSubmission: async (r) => ({ queued: false, receipt: { ...r, status: "done" } }),
      loadTaskHistory: async () => ({ messages: [] }),
      isTaskBusy: () => false,
      getAppSettings: () => ({ defaultModelId: "fixture/model", dotsSettings: { followupMode: "continue" } }),
      resolveAvailableModelId: async (id) => ({ modelId: id }),
      listSkills: () => [],
      listConnectors: () => [],
    };
    cron = new CronService(db, cronAgent);
    cron.start();
    // Prove Electron Main holds 0 local Cron timers when Core owns scheduling.
    const cronTimers = (cron as unknown as { timers: Map<string, unknown> }).timers;
    assert.equal(cronTimers.size, 0, "Main CronService must not arm local Node timers in supervised mode");

    // Prove coreControlled Dots loops hold 0 local Main intervals.
    proactive = new DotsProactiveDelivery(db.connection, () => false, async () => ({ status: "pending" }), reader);
    proactive.start();
    assert.equal((proactive as unknown as { timer?: unknown }).timer, undefined, "Main DotsProactiveDelivery must not arm setInterval in supervised mode");

    googleMonitor = new DotsGoogleMonitor(
      new DotsGoogleAccounts(join(root, "google"), async () => undefined, async () => undefined, []),
      () => ({ gmail: { accounts: [], mode: "interval", intervalMinutes: 5, dailyTime: "08:00" }, calendar: { accounts: [], mode: "interval", intervalMinutes: 5, dailyTime: "08:00" } }),
      () => false,
      () => undefined,
      undefined,
      undefined,
      { coreControlled: true },
    );
    googleMonitor.start();
    assert.equal((googleMonitor as unknown as { timer?: unknown }).timer, undefined, "Main DotsGoogleMonitor must not arm setInterval in supervised mode");

    discovery = new DotsDiscovery(
      join(root, "discovery"),
      () => ({ rss: [], dream: { enabled: false, useMemory: false, schedule: { mode: "daily", minutes: 60, time: "09:00", windowStart: "09:00", windowEnd: "21:00" }, tags: [] }, paused: false }),
      () => undefined,
      async () => [],
      async () => [],
      () => 0,
      undefined,
      undefined,
      undefined,
      { coreControlled: true },
    );
    discovery.start();
    assert.equal((discovery as unknown as { timer?: unknown }).timer, undefined, "Main DotsDiscovery must not arm setInterval in supervised mode");

    const t0 = Date.UTC(2035, 2, 10, 12, 0, 0);
    const skipJob: CronJobDto = {
      id: "rc14-cron-skip",
      name: "Hourly Skip Job",
      prompt: "run check",
      scheduleType: "every",
      scheduleExpr: "1h",
      timezone: "UTC",
      cwd: root,
      enabled: true,
      sourceTaskId: "source-task",
      target: { kind: "new-task" },
      missedRuns: "skip",
      createdAt: t0,
      updatedAt: t0,
    };
    const coalesceJob: CronJobDto = {
      id: "rc14-dots-coalesce",
      name: "Dots Coalesce Job",
      prompt: "check dots progress",
      scheduleType: "every",
      scheduleExpr: "1h",
      timezone: "UTC",
      cwd: root,
      enabled: true,
      sourceTaskId: DOTS_TASK_ID,
      target: { kind: "task", taskId: DOTS_TASK_ID },
      missedRuns: "coalesce",
      createdAt: t0,
      updatedAt: t0,
    };
    assert.equal(await db.writeCronPlan({ kind: "save", row: encodeCronPlan(skipJob), expected: null }), true);
    assert.equal(await db.writeCronPlan({ kind: "save", row: encodeCronPlan(coalesceJob), expected: null }), true);

    // Connect UI, observe initial state, then CLOSE UI before scheduled trigger.
    const uiClient = await CoreBusinessClient.connect(executable, dbPath, {
      dataDirectory: dataDir,
      role: "ui",
      clientId: "rc14-ui",
    });
    await uiClient.cronScheduler({ action: "start", nowMs: t0 });
    await uiClient.close(); // UI offline!

    // Simulate 3h20m sleep/offline jump while UI is closed.
    const jumpNow = t0 + 3 * 3_600_000 + 1_200_000;
    const svcClient = await CoreBusinessClient.connect(executable, dbPath, {
      dataDirectory: dataDir,
      role: "background-service",
      clientId: "rc14-svc",
    });
    const sleepTick = await svcClient.cronScheduler<{ fired?: number; skippedMissed?: number }>({
      action: "tick",
      nowMs: jumpNow,
      simulateSleepJump: true,
    });
    assert.equal(sleepTick.skippedMissed, 1, "Cron skip policy skips missed backlog on sleep jump");
    assert.equal(sleepTick.fired, 1, "Dots coalesce policy runs once (no backlog storm)");

    await waitUntil(async () => {
      const runs = await db!.readCronRuns(10, ["rc14-dots-coalesce"]);
      return runs.length === 1 && runs[0]?.status === "success";
    }, "rc14-dots-coalesce settles without UI");
    assert.deepEqual(await db.readCronRuns(10, ["rc14-cron-skip"]), [], "skipped Cron job never fired stale missed runs");

    // Advance cleanly to next hour -> rc14-cron-skip fires once; then clock jumps backward -> deduplicated!
    const nextHour = t0 + 4 * 3_600_000;
    await svcClient.cronScheduler({ action: "tick", nowMs: nextHour });
    await waitUntil(async () => {
      const runs = await db!.readCronRuns(10, ["rc14-cron-skip"]);
      return runs.length === 1 && runs[0]?.status === "success";
    }, "rc14-cron-skip settles at 4th hour");

    await svcClient.cronScheduler({ action: "tick", nowMs: nextHour - 120_000 });
    await svcClient.cronScheduler({ action: "tick", nowMs: nextHour });
    assert.equal((await db.readCronRuns(10, ["rc14-cron-skip"])).length, 1, "clock backward jump does not double-fire occurrence");

    // Dots causal deduplication & sleep-jump coalescing without self-excitation loop
    const c1 = await svcClient.dotsScheduler<{ accepted?: boolean }>({
      action: "recordCausalEvent",
      dedupKey: "dots:file_watch:w1:rev-1",
      kind: "file_watch",
      sourceId: "w1",
      nowMs: nextHour,
    });
    const c2 = await svcClient.dotsScheduler<{ accepted?: boolean; deduplicated?: boolean }>({
      action: "recordCausalEvent",
      dedupKey: "dots:file_watch:w1:rev-1",
      kind: "file_watch",
      sourceId: "w1",
      nowMs: nextHour + 10,
    });
    assert.equal(c1.accepted, true);
    assert.equal(c2.accepted, false);
    assert.equal(c2.deduplicated, true);
    console.log("PASS RC-14: Cron skip vs Dots coalesce, UI-offline trigger via ExecutionHostBridge, 0 Main timers, backward-clock & causal dedup");

    // -------------------------------------------------------------------------
    // RC-15: Gateway reconnect duplicate inbound + queryable vs unqueryable unknown
    // -------------------------------------------------------------------------
    const accountKey = "b".repeat(64);
    const msgPayload = JSON.stringify({
      version: 1,
      channelId: "slack-default",
      chatId: "C999",
      messageId: "msg-rc15-1",
      text: "check deployment",
    });
    const payloadHash = createHash("sha256").update(msgPayload).digest("hex");

    const in1 = await svcClient.gatewayScheduler<{ duplicate?: boolean; accepted?: boolean }>({
      action: "admitInbound",
      deliveryId: "gw-del-1",
      platform: "slack",
      channelId: "slack-default",
      accountKey,
      sessionKey: JSON.stringify(["slack-default", accountKey, "C999"]),
      messageId: "msg-rc15-1",
      payloadJson: msgPayload,
      payloadHash,
      nowMs: nextHour,
    });
    const in2 = await svcClient.gatewayScheduler<{ duplicate?: boolean }>({
      action: "admitInbound",
      deliveryId: "gw-del-1",
      platform: "slack",
      channelId: "slack-default",
      accountKey,
      sessionKey: JSON.stringify(["slack-default", accountKey, "C999"]),
      messageId: "msg-rc15-1",
      payloadJson: msgPayload,
      payloadHash,
      nowMs: nextHour + 50,
    });
    assert.equal(in1.duplicate, false);
    assert.equal(in2.duplicate, true, "replayed inbound on reconnect deduplicates without duplicate logical task");
    const inboxRows = db.connection.prepare("SELECT COUNT(*) AS c FROM gateway_inbox WHERE delivery_id = 'gw-del-1'").get() as { c: number };
    assert.equal(inboxRows.c, 1);

    // Seed outbox entries for queryable (slack) vs non-queryable (wecom) unknown receipt reconciliation
    await db.runtimeAuditReader!.batch4aWrite({
      kind: "gatewayDeliveryOp",
      op: "enqueue",
      deliveryId: "gw-del-unq",
      platform: "wecom",
      channelId: "wecom-default",
      accountKey,
      chatId: "chat-unq",
      sessionKey: JSON.stringify(["wecom-default", accountKey, "chat-unq"]),
      messageId: "msg-unq",
      payloadJson: JSON.stringify({ version: 1, channelId: "wecom-default", chatId: "chat-unq", messageId: "msg-unq", text: "hi" }),
      payloadHash: createHash("sha256").update("unq").digest("hex"),
      receiptMode: "none",
      now: nextHour,
      retentionMs: 86_400_000,
      maxReceipts: 1000,
    });
    await db.runtimeAuditReader!.batch4aWrite({
      kind: "gatewayDeliveryOp",
      op: "queueReply",
      deliveryId: "gw-del-1",
      replyText: "sent slack reply",
      replyHash: createHash("sha256").update("sent slack reply").digest("hex"),
      now: nextHour,
    });
    await db.runtimeAuditReader!.batch4aWrite({
      kind: "gatewayDeliveryOp",
      op: "queueReply",
      deliveryId: "gw-del-unq",
      replyText: "sent wecom reply",
      replyHash: createHash("sha256").update("sent wecom reply").digest("hex"),
      now: nextHour,
    });

    await svcClient.gatewayScheduler({ action: "channelConnected", channelId: "slack-default", channelType: "slack", accountKey, nowMs: nextHour });
    await svcClient.gatewayScheduler({ action: "channelConnected", channelId: "wecom-default", channelType: "wecom", accountKey, nowMs: nextHour });

    const trQ = await svcClient.gatewayScheduler<{ state?: string }>({
      action: "trackOutbound",
      deliveryId: "gw-del-1",
      channelId: "slack-default",
      channelType: "slack",
      providerMessageId: "slack-ts-1",
      queryable: true,
      state: "unknown",
      detail: "socket_dropped_before_ack",
      nowMs: nextHour + 100,
    });
    const trUq = await svcClient.gatewayScheduler<{ state?: string }>({
      action: "trackOutbound",
      deliveryId: "gw-del-unq",
      channelId: "wecom-default",
      channelType: "wecom",
      queryable: false,
      state: "unknown",
      detail: "unqueryable_webhook",
      nowMs: nextHour + 100,
    });
    assert.equal(trQ.state, "pending_reconcile");
    assert.equal(trUq.state, "unknown_unqueryable");

    await svcClient.gatewayScheduler({
      action: "settleUnknown",
      deliveryId: "gw-del-1",
      outcome: "confirmed_sent",
      providerMessageId: "slack-ts-1",
      nowMs: nextHour + 200,
    });
    const unqTick = await svcClient.gatewayScheduler<{ dispatched?: string[] }>({
      action: "tick",
      nowMs: nextHour + 300,
    });
    assert.equal((unqTick.dispatched ?? []).some(d => d.includes("gw-del-unq")), false, "unqueryable unknown never auto-resends");

    const qRow = db.connection.prepare("SELECT status FROM gateway_outbox WHERE delivery_id = 'gw-del-1'").get() as { status: string };
    const uqRow = db.connection.prepare("SELECT status FROM gateway_outbox WHERE delivery_id = 'gw-del-unq'").get() as { status: string };
    assert.equal(qRow.status, "sent");
    assert.equal(uqRow.status, "unknown");
    console.log("PASS RC-15: Gateway duplicate inbound fenced; queryable unknown recovered, non-queryable unknown preserved");

    // -------------------------------------------------------------------------
    // RC-16: Remote command replay dedup & offline notification catch-up on UI reconnect
    // -------------------------------------------------------------------------
    const rc1 = await svcClient.remoteControl<{ duplicate?: boolean }>({
      action: "admitCommand",
      operationId: "remote-op-1",
      commandType: "prompt",
      taskId: "source-task",
      requestPayload: { text: "continue analysis" },
      nowMs: nextHour,
    });
    assert.equal(rc1.duplicate, false);
    await svcClient.remoteControl({
      action: "completeCommand",
      operationId: "remote-op-1",
      commandType: "prompt",
      status: "completed",
      response: { taskId: "source-task", submissionId: 101 },
      nowMs: nextHour + 50,
    });
    const rcReplay = await svcClient.remoteControl<{ duplicate?: boolean; commandStatus?: string; response?: { submissionId?: number } }>({
      action: "admitCommand",
      operationId: "remote-op-1",
      commandType: "prompt",
      taskId: "source-task",
      requestPayload: { text: "continue analysis" },
      nowMs: nextHour + 100,
    });
    assert.equal(rcReplay.duplicate, true);
    assert.equal(rcReplay.commandStatus, "completed");
    assert.equal(rcReplay.response?.submissionId, 101);

    const offlineNotif = await svcClient.remoteControl<{ inserted?: boolean; unreadCount?: number }>({
      action: "publishNotification",
      type: "automation.completed",
      level: "success",
      title: "Background job finished while UI closed",
      body: "Result ready",
      sourceType: "automation",
      sourceId: "rc14-cron-skip",
      taskId: "source-task",
      dedupeKey: "rc16-offline-notice-1",
      createdAt: nextHour + 150,
    });
    assert.equal(offlineNotif.inserted, true);
    const dupNotif = await svcClient.remoteControl<{ inserted?: boolean; unreadCount?: number }>({
      action: "publishNotification",
      type: "automation.completed",
      level: "success",
      title: "Background job finished while UI closed",
      body: "Result ready",
      sourceType: "automation",
      sourceId: "rc14-cron-skip",
      taskId: "source-task",
      dedupeKey: "rc16-offline-notice-1",
      createdAt: nextHour + 160,
    });
    assert.equal(dupNotif.inserted, false, "offline notification dedupe prevents duplicates");

    const uiCatchup = await notifications.catchupFromCore(nextHour);
    assert(uiCatchup && uiCatchup.unreadCount === 1, "UI catch-up sees unread notification generated offline");
    assert(uiCatchup.notifications.some(n => n.dedupeKey === "rc16-offline-notice-1"));
    assert(notificationEvents >= 1);

    await svcClient.cronScheduler({ action: "stop" });
    await svcClient.dotsScheduler({ action: "stop" });
    await svcClient.gatewayScheduler({ action: "stop" });
    await svcClient.close();
    console.log("PASS RC-16: Remote command idempotency replay & offline notification catch-up verified");
    console.log("PASS RC-14..RC-16 rust-background-services complete");
  } finally {
    cron?.stop();
    await googleMonitor?.close();
    await discovery?.close();
    await proactive?.close();
    await bridge?.close();
    await db?.runtimeAuditReader?.close();
    db?.close();
    await shutdownCoreWorker(dataDir, dbPath).catch(() => undefined);
    try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* ignore */ }
  }
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
