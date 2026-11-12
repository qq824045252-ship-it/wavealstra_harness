import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, toNamespacedPath } from "node:path";
import { mock } from "node:test";
import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { BotConversationService } from "../src/main/agent/work/BotConversationService";
import { DurableBotRuntime } from "../src/main/agent/durable/DurableBotRuntime";
import Database from "better-sqlite3";
import { DEFAULT_BOT_ID, LOCAL_USER_ID } from "../src/shared/bot-work";

const root = mkdtempSync(join(tmpdir(), "bot-foreground-lifecycle-"));
const db = new AppDatabase(join(root, "business.db"));
const bots = new BotRegistry(db.connection);
bots.ensureDefaultBot(LOCAL_USER_ID);
const works = new WorkService(db.connection, { bots });
const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null,
  modelsStorePath: join(root, "models.json"), refreshOnCreate: false });
let calls = 0;
models.registerProvider("fixture", { api: "openai-completions", apiKey: "fixture-only", baseUrl: "http://127.0.0.1:1",
  models: [{ id: "front", name: "front", reasoning: false, input: ["text"], contextWindow: 128000,
    maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  streamSimple: model => {
    calls++;
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "实际原生答复" }],
        stopReason: "stop", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream.push({ type: "done", reason: "stop", message }); stream.end();
    });
    return stream;
  } });
let authority = true;
const makeService = (directory: string) => new BotConversationService({ db: db.connection, bots, works, models,
  directory: join(root, directory), userId: LOCAL_USER_ID, defaultModel: () => "fixture/front",
  isAuthority: () => authority, memorySearch: () => [], schedule: () => {}, wake: () => {},
  messageSettings: () => ({ profile: bots.activeSnapshot(DEFAULT_BOT_ID)!, settings: {
    botId: DEFAULT_BOT_ID, workspacePath: root, effectiveWorkspacePath: root, modelId: "fixture/front",
    expertId: "", skillIds: [], mcpIds: [], connectorIds: [], revision: 0, spaceId: "fixture" } }),
  composerTools: async () => {
    composers++;
    let closed = false;
    return { tools: [], instructions: "", close: async () => {
      composerCloses++;
      if (failComposerClose) throw Error("fixture: composer close failed");
      if (!closed) { closed = true; composers--; }
    } };
  } });
let composers = 0;
let failComposerClose = false;
let composerCloses = 0;
let runtimeCloses = 0;
const live = new Set<DurableBotRuntime>();
const originalOpen = DurableBotRuntime.open;
const originalClose = DurableBotRuntime.prototype.close;
let failOpen = false;
let failClose = false;
let openingGate: Promise<void> | undefined;
let openingStarted = false;
let nativeDirectory = "";
mock.method(DurableBotRuntime, "open", async (...args: Parameters<typeof DurableBotRuntime.open>) => {
  if (failOpen) throw Error("fixture: open failed");
  const runtime = await originalOpen(...args); live.add(runtime);
  nativeDirectory = args[0].directory;
  openingStarted = true;
  await openingGate;
  return runtime;
});
mock.method(DurableBotRuntime.prototype, "close", async function(this: DurableBotRuntime) {
  runtimeCloses++;
  if (failClose) throw Error("fixture: close failed");
  await originalClose.call(this); live.delete(this);
});
const wait = async (predicate: () => boolean, label: string) => {
  const until = Date.now() + 15000;
  while (!predicate()) { if (Date.now() > until) throw Error(`timeout: ${label}`); await delay(10); }
};
let service = makeService("cancel");
try {
  if (!process.argv.includes("--aging-only")) {
  const originalReply = DurableBotRuntime.prototype.reply;
  const failedReply = mock.method(DurableBotRuntime.prototype, "reply", async function(this: DurableBotRuntime,
    ...args: Parameters<DurableBotRuntime["reply"]>) {
    await originalReply.apply(this, args);
    throw Error("fixture: projection lost after durable completion");
  });
  const receipt = service.send({ botId: DEFAULT_BOT_ID, requestId: "unknown-then-cancel", text: "执行原始请求" });
  await wait(() => service.messages.message(receipt.assistantMessageId)?.status === "unknown" && live.size === 0 && composers === 0,
    "unknown request drain releases its original resources");
  failedReply.mock.restore();
  assert.equal(calls, 1, JSON.stringify(service.messages.message(receipt.assistantMessageId)));
  await service.cancel(DEFAULT_BOT_ID, receipt.requestId);
  assert.equal(service.messages.message(receipt.assistantMessageId)?.status, "cancelled");
  assert.equal(live.size, 0, "cancel-only recovery must release the reopened native runtime");
  assert.equal(composers, 0, "cancel-only recovery must release its composer");
  assert.equal(calls, 1, "cancel recovery never resubmits the original input");
  await service.close();
  console.log("PASS #35 real service unknown → drained → cancel: native runtime and composer released, no resubmit");

  const unconfirmed = () => z.object({ count: z.number() }).parse(db.connection.prepare(
    "SELECT COUNT(*) count FROM bot_cancel_intents WHERE confirmed_at IS NULL").get()).count;
  db.connection.prepare("UPDATE bot_cancel_intents SET confirmed_at=NULL WHERE request_id=?").run(receipt.requestId);
  service = makeService("cancel");
  service.recover();
  await wait(() => unconfirmed() === 0 && live.size === 0 && composers === 0, "cold cancellation recovery releases its resources");
  assert.equal(calls, 1, "cold recovery never runs the model again");
  const noRun = service.messages.accept(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, requestId: "no-run", text: "尚未启动" });
  await service.cancel(DEFAULT_BOT_ID, noRun.requestId);
  assert.equal(unconfirmed(), 0); assert.equal(live.size, 0); assert.equal(composers, 0);

  // Reuse the exact persistent native request while injecting failures at its
  // external open/close boundaries. Cancellation facts survive a failed open.
  service.messages.update(receipt.assistantMessageId, "unknown", "等待核对");
  db.connection.prepare("UPDATE bot_cancel_intents SET confirmed_at=NULL WHERE request_id=?").run(receipt.requestId);
  failOpen = true;
  await assert.rejects(() => service.cancel(DEFAULT_BOT_ID, receipt.requestId), /open failed/);
  assert.equal(unconfirmed(), 1); assert.equal(live.size, 0); assert.equal(composers, 0);
  failOpen = false;
  service.recover();
  await wait(() => unconfirmed() === 0 && live.size === 0 && composers === 0, "failed open cancellation is recoverable");
  service.messages.update(receipt.assistantMessageId, "unknown", "关闭故障核对");
  db.connection.prepare("UPDATE bot_cancel_intents SET confirmed_at=NULL WHERE request_id=?").run(receipt.requestId);
  failClose = true;
  await assert.rejects(() => service.cancel(DEFAULT_BOT_ID, receipt.requestId), /close failed/);
  assert.equal(live.size, 1, "failed close retains the resource for diagnostic retry");
  failClose = false;
  await service.cancel(DEFAULT_BOT_ID, receipt.requestId);
  assert.equal(live.size, 0, "repeated cancel retries resource release after the cancellation receipt is already confirmed");
  assert.equal(composers, 0, "composer is released while the service remains running");
  assert.equal(unconfirmed(), 0, "resource retry never rewinds confirmed native cancellation");
  assert.equal(calls, 1, "resource retry never invokes the model");
  for (const fault of ["runtime-auto", "composer-auto", "runtime-recover"]) {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      service.messages.update(receipt.assistantMessageId, "unknown", "运行期间释放故障");
      db.connection.prepare("UPDATE bot_cancel_intents SET confirmed_at=NULL WHERE request_id=?").run(receipt.requestId);
      failClose = fault !== "composer-auto";
      failComposerClose = fault === "composer-auto";
      await assert.rejects(() => service.cancel(DEFAULT_BOT_ID, receipt.requestId), /close failed/);
      assert.equal(unconfirmed(), 0);
      assert.equal(live.size, fault === "composer-auto" ? 0 : 1);
      assert.equal(composers, 1);
      failClose = false; failComposerClose = false;
      if (fault === "runtime-recover") service.recover();
      else mock.timers.tick(10_000);
      await wait(() => live.size === 0 && composers === 0, `${fault} releases while service is running`);
      assert.equal(calls, 1, "confirmed cancellation release retry cannot invoke the model");
      assert.equal(service.messages.message(receipt.assistantMessageId)?.status, "cancelled");
      assert.equal(unconfirmed(), 0);
      const closes = [runtimeCloses, composerCloses];
      mock.timers.tick(10_000);
      for (let turn = 0; turn < 10; turn++) await Promise.resolve();
      assert.deepEqual([runtimeCloses, composerCloses], closes, "successful release removes its retry timer");
    } finally { failClose = false; failComposerClose = false; mock.timers.reset(); }
  }
  console.log("PASS #35 confirmed cancellation: repeated cancel, recover and automatic runtime/composer release retries work without closing the service");
  mock.timers.enable({ apis: ["setTimeout"] });
  const databaseClose = Database.prototype.close;
  let backendCloses = 0;
  let failedBackend: Database.Database | undefined;
  const backendFailure = new Error("fixture real production SQLite backend close failed");
  const backendFault = mock.method(Database.prototype, "close", function(this: Database.Database) {
    if (!this.readonly && live.size > 0 && this.name.startsWith(toNamespacedPath(nativeDirectory)) && (!failedBackend || failedBackend === this)) {
      failedBackend = this;
      backendCloses++;
      if (backendCloses === 1) throw backendFailure;
    }
    return databaseClose.call(this);
  });
  try {
    service.messages.update(receipt.assistantMessageId, "unknown", "真实底层关闭故障");
    db.connection.prepare("UPDATE bot_cancel_intents SET confirmed_at=NULL WHERE request_id=?").run(receipt.requestId);
    await assert.rejects(() => service.cancel(DEFAULT_BOT_ID, receipt.requestId), error => error === backendFailure);
    assert.equal(unconfirmed(), 0); assert.equal(backendCloses, 1);
    assert.equal(live.size, 1); assert.equal(composers, 1);
    const lease = join(nativeDirectory, ".mybuddy-owner.json");
    assert.equal(existsSync(lease), true);
    mock.timers.tick(10_000);
    await wait(() => live.size === 0 && composers === 0, "automatic cleanup retries real Session/production SQLite resource release");
    assert.equal(backendCloses, 2); assert.equal(existsSync(lease), false);
    assert.equal(calls, 1); assert.equal(unconfirmed(), 0);
  } finally { backendFault.mock.restore(); mock.timers.reset(); }
  console.log("PASS #35 real service cancellation → Session → production SQLite close failure → automatic release, retained lease and no model replay");
  await service.close();
  assert.equal(live.size, 0); assert.equal(composers, 0);

  service = makeService("opening");
  openingStarted = false;
  let releaseOpening = () => {};
  openingGate = new Promise<void>(resolve => { releaseOpening = resolve; });
  const opening = service.send({ botId: DEFAULT_BOT_ID, requestId: "cancel-during-opening", text: "原生打开中取消" });
  await wait(() => openingStarted, "native opening reaches controlled boundary");
  const cancellation = service.cancel(DEFAULT_BOT_ID, opening.requestId);
  const secondCancellation = service.cancel(DEFAULT_BOT_ID, opening.requestId);
  releaseOpening(); openingGate = undefined;
  await Promise.all([cancellation, secondCancellation]);
  await wait(() => live.size === 0 && composers === 0, "opening/drain/cancel owners release once");
  assert.equal(calls, 1, "opening cancellation never submits the input");
  await service.close();
  console.log("PASS #35 cold recovery, no-run cancel, open/close failures, concurrent cancel during runtime opening");
  }

  // Exercise the real persistent admission queue with an external request runner
  // held open. Advancing only time must admit the fourth/ninth ordinary request.
  const agingCases = ["conversation", "global", "saturated", "cancel", "archive", "authority", "shutdown", "short", "recover"];
  for (const scenario of process.argv.includes("--cancel-only") ? [] : agingCases) {
    const crossConversation = scenario === "global" || scenario === "saturated";
    service = makeService(`aging-${scenario}`);
    const launched: string[] = [];
    const releases: Array<() => void> = [];
    Reflect.set(service, "runRequest", async (_botId: string, _conversationId: string, message: { requestId: string; messageId: string }) => {
      launched.push(message.requestId);
      service.messages.update(message.messageId, "running", "");
      await new Promise<void>(resolve => releases.push(resolve));
      service.messages.update(message.messageId, "completed", "runner completed");
    });
    mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
    try {
      const count = scenario === "saturated" ? 11 : crossConversation ? 9 : 4;
      let conversationId: string | undefined;
      let lastReceipt: ReturnType<BotConversationService["send"]> | undefined;
      for (let i = 0; i < count; i++) {
        const botId = crossConversation ? `${scenario}-aging-${i}` : DEFAULT_BOT_ID;
        if (crossConversation) bots.registerBot({ botId, userId: LOCAL_USER_ID, displayName: botId, authorization: DESKTOP_USER_GRANTS });
        const input = { botId, requestId: `aging-${scenario}-${i}`,
          conversationId: crossConversation ? undefined : conversationId,
          text: scenario === "saturated" && i < 10 ? "这轮只修当前问题" : scenario === "short" && i === 3 ? "天气怎么样？" : "执行多步骤任务并核验成果" };
        const accepted = scenario === "recover" ? service.messages.accept(LOCAL_USER_ID, input) : service.send(input);
        conversationId = accepted.conversationId;
        lastReceipt = accepted;
        if (scenario === "short") for (let turn = 0; turn < 10; turn++) await Promise.resolve();
      }
      if (scenario === "recover") {
        db.connection.prepare("UPDATE bot_messages SET created_at=? WHERE role='assistant' AND request_id LIKE 'aging-recover-%'").run(Date.now() - 30_001);
        service.recover();
      }
      for (let i = 0; i < 10; i++) await Promise.resolve();
      const immediate = scenario === "short" || scenario === "recover";
      assert.equal(launched.length, immediate ? count : count - 1);
      if (scenario === "cancel") await service.cancel(lastReceipt!.botId, lastReceipt!.requestId);
      if (scenario === "archive") service.archive(DEFAULT_BOT_ID, conversationId!);
      if (scenario === "authority") authority = false;
      if (scenario === "shutdown") {
        const closing = service.close();
        releases.forEach(release => release());
        await closing;
      }
      mock.timers.tick(29_999);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      assert.equal(launched.length, immediate ? count : count - 1, "no early admission before aging threshold");
      mock.timers.tick(1);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      const blocked = ["saturated", "cancel", "archive", "authority", "shutdown"].includes(scenario);
      assert.equal(launched.length, blocked ? count - 1 : count, `aging admission in ${scenario}`);
      if (scenario === "saturated") {
        const queries = mock.method(service.messages, "pending");
        mock.timers.tick(60_000);
        for (let i = 0; i < 10; i++) await Promise.resolve();
        assert.equal(queries.mock.callCount(), 0, "fully occupied aged queue has no polling or timer spin");
        releases[0]!();
        for (let i = 0; i < 30; i++) await Promise.resolve();
        assert.equal(launched.length, 11, "capacity release admits the aged request without exceeding ten active requests");
        queries.mock.restore();
      }
    } finally {
      authority = false;
      db.connection.prepare("UPDATE bot_messages SET status='cancelled' WHERE status='queued'").run();
      releases.forEach(release => release());
      for (let i = 0; i < 20; i++) await Promise.resolve();
      await service.close();
      mock.timers.reset();
      authority = true;
    }
  }
  if (!process.argv.includes("--cancel-only")) console.log("PASS #36 real service fake clock: conversation and global aging wake without an external kick");
} finally {
  failOpen = false; failClose = false; failComposerClose = false;
  await service.close();
  mock.restoreAll();
  db.close();
  rmSync(root, { recursive: true, force: true });
}
