import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import Sqlite from "better-sqlite3";
import { z } from "zod";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { WorkHostAuthority } from "../src/main/agent/work/WorkHostAuthority";
import { WorkExecutionAdapter } from "../src/main/agent/work/WorkExecutionAdapter";
import { WorkProjectionJournal } from "../src/main/agent/work/WorkProjectionJournal";
import { BotConversationService } from "../src/main/agent/work/BotConversationService";
import { DurableBotService } from "../src/main/agent/durable/DurableBotService";
import { createDurableToolPolicy } from "../src/main/agent/durable/DurableToolPolicy";
import { ConversationInteractionService } from "../src/main/agent/ConversationInteractionService";
import { ConversationInteractionRepository } from "../src/main/agent/ConversationInteractionRepository";
import { ExecutionAttemptRepository } from "../src/main/agent/ExecutionAttemptRepository";
import { ExecutionFailureRepository } from "../src/main/agent/ExecutionFailureRepository";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkControlResult } from "../src/shared/bot-work";
import type { ExternalEffectRecovery } from "../src/main/agent/durable/DurableEffectRecovery";

const unwrap = (result: WorkControlResult) => { if (!result.ok) throw new Error(`${result.code}: ${result.message}`); return result.work; };
const rowCount = (value: unknown) => z.object({ count: z.number() }).parse(value).count;
const text = (value: string) => [{ type: "text" as const, text: value }];
const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS };
const scenarios = ["outbox", "accepted-cancel", "before-result", "received", "cursor-transaction", "consume-transaction", "effect-receipt", "effect-unknown"];
const HOST_LEASE_TTL_MS = 1000;
const wait = async (predicate: () => boolean | Promise<boolean>, description: string) => {
  const until = Date.now() + 25000;
  while (!await predicate()) { if (Date.now() > until) throw new Error(`timeout: ${description}`); await delay(20); }
};
function checkpoint(root: string, label: string): never {
  // Publish a complete marker: under concurrent fsync load the parent may observe a
  // newly created file before writeFileSync has finished writing its JSON bytes.
  const temporary = join(root, `checkpoint-${process.pid}.json`);
  writeFileSync(temporary, JSON.stringify({ label, pid: process.pid }));
  renameSync(temporary, join(root, "checkpoint.json"));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error("unreachable checkpoint");
}

async function waitForKilledHost(root: string, pid: number | undefined): Promise<void> {
  assert(pid !== undefined, "the checkpoint owner must be the spawned worker");
  const db = new Sqlite(join(root, "business.db"), { readonly: true, fileMustExist: true });
  let heartbeatAt: number;
  try {
    const row = z.object({ authority_id: z.string(), heartbeat_at: z.number(), released_at: z.number().nullable() })
      .parse(db.prepare("SELECT authority_id,heartbeat_at,released_at FROM work_host_lease WHERE lease_id='singleton'").get());
    assert.equal(row.authority_id, `host-${pid}`, "reopen the exact persisted host killed at the checkpoint");
    assert.equal(row.released_at, null, "strong kill must leave an unreleased lease, not simulate graceful shutdown");
    heartbeatAt = row.heartbeat_at;
  } finally { db.close(); }
  // Durable's JSONL owner is fenced by OS process liveness, not by the Work lease
  // TTL. Require both real conditions; a nominal 1100ms delay proves neither.
  await wait(() => {
    try { process.kill(pid, 0); return false; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return false;
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    return Date.now() - heartbeatAt > HOST_LEASE_TTL_MS;
  }, `killed host ${pid} absent and persisted lease expired (heartbeat=${heartbeatAt})`);
}

async function open(root: string, scenario: string, worker: boolean) {
  const cwd = join(root, "workspace"); mkdirSync(cwd, { recursive: true });
  const db = new AppDatabase(join(root, "business.db"));
  const external = new Sqlite(join(root, "external.db")); external.pragma("journal_mode = WAL"); external.pragma("synchronous = FULL");
  external.exec("CREATE TABLE IF NOT EXISTS effects(operation_id TEXT PRIMARY KEY,status TEXT NOT NULL)");
  const bots = new BotRegistry(db.connection);
  bots.registerBot({ botId: DEFAULT_BOT_ID, userId: LOCAL_USER_ID, displayName: "crash fixture", authorization: DESKTOP_USER_GRANTS });
  const lease = new WorkHostAuthority(db.connection, `host-${process.pid}`, HOST_LEASE_TTL_MS); assert(lease.start().ok);
  const works = new WorkService(db.connection, { bots, isAuthority: () => lease.isAuthority() });
  const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false });
  models.registerProvider("fixture", { api: "openai-completions", apiKey: "fixture-only", baseUrl: "http://127.0.0.1:1",
    models: ["fixture", "front"].map(id => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
    streamSimple: (model, request) => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        if (model.id === "front" && worker && scenario === "foreground-initial") checkpoint(root, scenario);
        const last = request.messages.at(-1);
        const latestUser = [...request.messages].reverse().find(message => message.role === "user");
        const original = latestUser && JSON.stringify(latestUser.content).includes("original delegate");
        const content: AssistantMessage["content"] = model.id === "front"
          ? original && last?.role !== "toolResult" ? [{ type: "toolCall", id: "cancelled-control", name: "work_create", arguments: { title: "must not be created" } }] : text("front reply")
          : last?.role === "toolResult" ? text("可核对的原始执行结果")
          : [{ type: "toolCall", id: "external-effect", name: "ui_exec", arguments: { action: "click" } }];
        const stopReason = content.some(block => block.type === "toolCall") ? "toolUse" : "stop";
        const message: AssistantMessage = { role: "assistant", content, stopReason, api: model.api, model: model.id, provider: model.provider,
          timestamp: Date.now(), usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "done", reason: stopReason, message }); stream.end();
      }); return stream;
    },
  });
  const recovery: ExternalEffectRecovery = {
    prepare: async (name, args, operationId) => scenario !== "effect-unknown" && name === "ui_exec" ? {
      arguments: { ...args, operationId }, intent: { kind: "receipt", server: "fixture", serverIdentity: "external-sqlite-fixture",
        tool: name, operationId, contract: { version: 1, idempotencyArgument: "operationId", receiptTool: "receipt", receiptArgument: "operationId",
          operationIdField: "operationId", statusField: "status", completedValues: ["completed"], failedValues: [] } },
    } : undefined,
    verify: async intent => {
      const found = external.prepare("SELECT 1 FROM effects WHERE operation_id=? AND status='completed'").get(intent.operationId);
      return { status: found ? "passed" : "inconclusive", verifierId: "durable-business-receipt", canonicalTarget: intent.operationId,
        expected: { operationId: intent.operationId }, observed: { found: Boolean(found) }, checkedAt: Date.now() };
    },
  };
  const native = new DurableBotService({ db, models, agentDir: join(root, "native"), mcpDir: join(root, "mcp"), resolveCwd: () => cwd,
    instructions: () => "exactly one fixture effect", defaultModel: () => "fixture/fixture", toolMode: () => "native", mcpSelection: () => [],
    toolAllowed: (_task, name) => ["ui_exec", "mcp_fixture_receipt"].includes(name),
    beforeSubmit: request => { const error = works.checkTaskInput(request.taskId, request.userMessageId); if (error) throw new Error(error); },
    tools: async task => {
      const policy = createDurableToolPolicy({ taskId: task.id, taskRoot: cwd, getPermissionMode: () => "auto", effectRecovery: recovery,
        toolAllowed: () => true, interactions: new ConversationInteractionService(new ConversationInteractionRepository(db.connection), () => {}),
        attempts: new ExecutionAttemptRepository(db.connection), failures: new ExecutionFailureRepository(db.connection),
        admitWorkAction: input => works.admitTaskAction(task.id, input), settleWorkAction: (operationId, outcome) => works.settleTaskAction(task.id, operationId, outcome) });
      return { contextHooks: [], toolHooks: policy.hooks, tools: [defineTool({ name: "ui_exec", description: "isolated external effect fixture",
        parameters: Type.Object({ action: Type.Literal("click"), operationId: Type.Optional(Type.String()) }), replay: "unsafe",
        execute: async (args, api) => {
          const operation = args.operationId ?? `unreadable:${task.id}:${api.taskId}`;
          const inserted = external.prepare("INSERT OR IGNORE INTO effects(operation_id,status) VALUES (?,'completed')").run(operation);
          if (inserted.changes) appendFileSync(join(root, "effects.txt"), `${operation}\n`);
          if (worker && scenario.startsWith("effect-")) checkpoint(root, scenario);
          return { output: text("completed") };
        } })] };
    }, emit: () => {} });
  const errors: unknown[] = [];
  const adapter = new WorkExecutionAdapter(works, native.workExecutionPort(), LOCAL_USER_ID, () => lease.isAuthority(), (_id, error) => errors.push(error));
  const close = async () => { await adapter.close(); await native.close(); lease.stop(); db.close(); external.close(); };
  return { db, bots, works, models, lease, native, adapter, errors, external, close };
}

function foreground(fixture: Awaited<ReturnType<typeof open>>, root: string) {
  return new BotConversationService({ db: fixture.db.connection, userId: LOCAL_USER_ID, bots: fixture.bots, works: fixture.works,
    models: fixture.models, directory: join(root, "foreground"), defaultModel: () => "fixture/front", isAuthority: () => fixture.lease.isAuthority(),
    memorySearch: () => [], schedule: () => assert.fail("cancelled foreground must never delegate"), wake: () => {} });
}

async function seed(root: string, scenario: string) {
  const fixture = await open(root, scenario, true);
  if (scenario.startsWith("foreground-")) {
    const service = foreground(fixture, root);
    if (scenario === "foreground-initial") service.send({ botId: DEFAULT_BOT_ID, requestId: "cancel-original", text: "original delegate" });
    else {
      fixture.models.getAvailable = async () => checkpoint(root, "foreground-marked");
      await service.cancel(DEFAULT_BOT_ID, "cancel-original");
    }
    await new Promise(() => {});
    throw new Error("unreached foreground checkpoint");
  }
  const { db, works, native, adapter } = fixture;
  const work = unwrap(works.createWork(user, { operationId: "create", title: scenario, authorization: DESKTOP_USER_GRANTS,
    inputSnapshotId: "source-v1", budget: { maxTokens: 200, windowExpiresAt: Date.now() + 60000 } }));
  db.upsertTask({ id: "original-root", title: scenario, cwd: join(root, "workspace"), modelId: "fixture/fixture", permissionMode: "auto", updatedAt: Date.now() });
  const namespace = await native.workExecutionPort().prepare("original-root");
  const bound = unwrap(works.dispatchExecution(user, { operationId: "original-operation", workId: work.workId, botId: DEFAULT_BOT_ID, ...namespace, reserveTokens: 20 }));
  const binding = works.repo.getBinding(bound.activeExecutionIds[0])!;
  writeFileSync(join(root, "projection.json"), JSON.stringify(new WorkProjectionJournal(db.connection, works).sync(LOCAL_USER_ID, { includeClosed: true })));
  if (scenario === "outbox") checkpoint(root, scenario);
  works.markDispatchAttempt(binding.bindingId, "original-attempt");
  const receipt = await native.workExecutionPort().submit(binding, works.repo.executionInput(binding));
  await native.submissionStatus(receipt, true);
  if (["accepted-cancel", "before-result"].includes(scenario)) checkpoint(root, scenario);
  if (scenario === "received") {
    const consume = works.nativeResults.consume.bind(works.nativeResults);
    works.nativeResults.consume = () => rowCount(db.connection.prepare("SELECT COUNT(*) count FROM work_native_inbox").get()) > 0 ? checkpoint(root, scenario) : consume();
  }
  if (scenario === "cursor-transaction") {
    db.connection.function("crashpoint", () => checkpoint(root, scenario));
    db.connection.exec("CREATE TEMP TRIGGER crash_cursor BEFORE INSERT ON work_native_cursors BEGIN SELECT crashpoint(); END;");
  }
  if (scenario === "consume-transaction") {
    db.connection.function("crashpoint", () => checkpoint(root, scenario));
    db.connection.exec("CREATE TEMP TRIGGER crash_consume BEFORE UPDATE OF consumed_at ON work_native_inbox BEGIN SELECT crashpoint(); END;");
  }
  await adapter.flush();
  throw new Error(`unreached crash checkpoint ${scenario}`);
}

async function run() {
  const root = await mkdtemp(join(tmpdir(), "bot-work-crash-"));
  try {
    for (const scenario of scenarios) {
      const folder = join(root, scenario); mkdirSync(folder);
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--worker", folder, scenario], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = ""; child.stdout.on("data", value => { output += String(value); }); child.stderr.on("data", value => { output += String(value); });
      const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
      try {
        await wait(() => {
          if (child.exitCode !== null || child.signalCode !== null) throw new Error(`worker exited: ${output}`);
          return existsSync(join(folder, "checkpoint.json"));
        }, scenario);
        const point = z.object({ label: z.string(), pid: z.number() }).parse(JSON.parse(readFileSync(join(folder, "checkpoint.json"), "utf8")));
        assert.equal(point.pid, child.pid); assert.equal(point.label, scenario);
        assert(child.kill("SIGKILL")); await exited;
      } finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; } }
      await waitForKilledHost(folder, child.pid);
      const fixture = await open(folder, scenario, false);
      try {
        const { db, works, native, adapter, external } = fixture;
        const work = works.listWorks(LOCAL_USER_ID, { includeClosed: true })[0];
        const binding = works.repo.listBindings(work.workId)[0];
        const originalEpoch = new WorkProjectionJournal(db.connection, works).sync(LOCAL_USER_ID, { includeClosed: true });
        const seedEpoch = z.object({ cursor: z.object({ epoch: z.string() }) }).parse(JSON.parse(readFileSync(join(folder, "projection.json"), "utf8")));
        assert(originalEpoch.kind === "snapshot" && originalEpoch.cursor.epoch === seedEpoch.cursor.epoch, "projection epoch survives the killed process and database reopen");
        assert.equal(binding.operationId, "original-operation");
        if (scenario === "cursor-transaction") assert.equal(rowCount(db.connection.prepare("SELECT COUNT(*) count FROM work_native_inbox").get()), 0, "receive and cursor transaction rolled back together");
        if (scenario === "received" || scenario === "consume-transaction") {
          assert.equal(rowCount(db.connection.prepare("SELECT COUNT(*) count FROM work_native_inbox WHERE consumed_at IS NULL").get()), 1);
          assert.equal(works.repo.listDeliverables(work.workId).length, 0);
          assert.equal(works.getWork(work.workId)?.budget.usedTokens, 0);
        }
        if (scenario === "accepted-cancel") unwrap(works.cancelWork(user, { operationId: "cancel-after-lost-receipt", workId: work.workId }));
        await native.resumePersisted();
        await wait(async () => {
          await adapter.flush();
          return ["completed", "failed", "stopped"].includes(works.repo.getBinding(binding.bindingId)?.status ?? "");
        }, `reconcile ${scenario}`);
        for (let repeat = 0; repeat < 3; repeat++) await adapter.flush();
        assert.equal(rowCount(external.prepare("SELECT COUNT(*) count FROM effects").get()), 1, `actual effect count for ${scenario}`);
        assert.equal(readFileSync(join(folder, "effects.txt"), "utf8").trim().split("\n").length, 1);
        assert.equal(works.repo.listBindings(work.workId).length, 1);
        assert.equal(works.repo.listDeliverables(work.workId).length, 1);
        assert.equal(rowCount(db.connection.prepare("SELECT COUNT(*) count FROM work_native_inbox WHERE consumed_at IS NULL").get()), 0);
        assert.deepEqual(fixture.errors, []);
        if (scenario === "effect-unknown") {
          assert(works.repo.listOpenBlockers(work.workId).some(blocker => blocker.kind === "external_effect"));
          assert(works.repo.listAdmissions(work.workId).some(admission => admission.state === "unknown"));
          assert.notEqual(works.getWork(work.workId)?.closureConclusion, "succeeded");
        } else {
          assert(works.getWork(work.workId)!.budget.usedTokens > 0, "actual usage settles original exact reservation");
          assert.equal(works.repo.getReservation(binding.reservationId!)?.state, "committed");
        }
        if (scenario === "effect-receipt") {
          const history = await native.history(binding.taskId);
          assert(JSON.stringify(history).includes("durable-business-receipt"), "native recovery includes real readback evidence");
          assert(works.repo.listAdmissions(work.workId).every(admission => admission.state === "consumed"));
        }
        const after = new WorkProjectionJournal(db.connection, works).sync(LOCAL_USER_ID, { includeClosed: true });
        assert(originalEpoch.kind === "snapshot" && after.kind === "snapshot" && originalEpoch.cursor.epoch === after.cursor.epoch);
        console.log(`PASS strong-kill ${scenario}: one original binding, actual effect=1, result=1, inbox drained`);
      } finally { await fixture.close(); }
    }
    const foregroundRoot = join(root, "foreground-cancel"); mkdirSync(foregroundRoot);
    for (const stage of ["foreground-initial", "foreground-marked"]) {
      const marker = join(foregroundRoot, "checkpoint.json");
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--worker", foregroundRoot, stage], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = ""; child.stdout.on("data", value => { output += String(value); }); child.stderr.on("data", value => { output += String(value); });
      const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
      try {
        await wait(() => {
          if (child.exitCode !== null || child.signalCode !== null) throw new Error(`foreground worker exited: ${output}`);
          if (!existsSync(marker)) return false;
          return z.object({ label: z.string(), pid: z.number() }).parse(JSON.parse(readFileSync(marker, "utf8"))).pid === child.pid;
        }, stage);
        assert(child.kill("SIGKILL")); await exited;
      } finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; } }
      await waitForKilledHost(foregroundRoot, child.pid);
    }
    const fixture = await open(foregroundRoot, "foreground-recover", false);
    const service = foreground(fixture, foregroundRoot);
    try {
      assert.equal(rowCount(fixture.db.connection.prepare("SELECT COUNT(*) count FROM bot_cancel_intents WHERE confirmed_at IS NULL").get()), 1);
      service.recover();
      const receipt = service.send({ botId: DEFAULT_BOT_ID, requestId: "after-cancel", text: "new ordinary message" });
      await wait(() => service.messages.message(receipt.assistantMessageId)?.status === "completed", "foreground resumes after pending cancellation");
      assert.equal(rowCount(fixture.db.connection.prepare("SELECT COUNT(*) count FROM bot_cancel_intents WHERE confirmed_at IS NULL").get()), 0);
      const original = service.messages.receipt(LOCAL_USER_ID, DEFAULT_BOT_ID, "cancel-original")!;
      assert.equal(service.messages.message(original.assistant_message_id)?.status, "cancelled");
      assert.equal(fixture.works.listWorks(LOCAL_USER_ID, { includeClosed: true }).length, 0);
      assert.equal(fixture.db.listTasks().length, 0);
      console.log("PASS two strong kills during foreground generation and persisted-cancel-before-abort: original input stays cancelled, next input replies, Task/Work/effect=0");
    } finally { await service.close(); await fixture.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
}
if (process.argv[2] === "--worker") await seed(process.argv[3], process.argv[4]); else await run();
