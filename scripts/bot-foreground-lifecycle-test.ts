import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { BotConversationService } from "../src/main/agent/work/BotConversationService";
import { DurableBotRuntime } from "../src/main/agent/durable/DurableBotRuntime";
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
    return { tools: [], instructions: "", close: async () => { if (!closed) { closed = true; composers--; } } };
  } });
let composers = 0;
const live = new Set<DurableBotRuntime>();
const originalOpen = DurableBotRuntime.open;
const originalClose = DurableBotRuntime.prototype.close;
mock.method(DurableBotRuntime, "open", async (...args: Parameters<typeof DurableBotRuntime.open>) => {
  const runtime = await originalOpen(...args); live.add(runtime); return runtime;
});
mock.method(DurableBotRuntime.prototype, "close", async function(this: DurableBotRuntime) {
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
  assert.equal(calls, 1);
  await service.cancel(DEFAULT_BOT_ID, receipt.requestId);
  assert.equal(service.messages.message(receipt.assistantMessageId)?.status, "cancelled");
  assert.equal(live.size, 0, "cancel-only recovery must release the reopened native runtime");
  assert.equal(composers, 0, "cancel-only recovery must release its composer");
  assert.equal(calls, 1, "cancel recovery never resubmits the original input");
  await service.close();
  console.log("PASS #35 real service unknown → drained → cancel: native runtime and composer released, no resubmit");
  }

  // Exercise the real persistent admission queue with an external request runner
  // held open. Advancing only time must admit the fourth/ninth ordinary request.
  for (const crossConversation of process.argv.includes("--cancel-only") ? [] : [false, true]) {
    service = makeService(`aging-${crossConversation}`);
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
      const count = crossConversation ? 9 : 4;
      let conversationId: string | undefined;
      for (let i = 0; i < count; i++) {
        const botId = crossConversation ? `global-aging-${i}` : DEFAULT_BOT_ID;
        if (crossConversation) bots.registerBot({ botId, userId: LOCAL_USER_ID, displayName: botId, authorization: DESKTOP_USER_GRANTS });
        const accepted = service.send({ botId, requestId: `aging-${crossConversation}-${i}`,
          conversationId: crossConversation ? undefined : conversationId, text: "执行多步骤任务并核验成果" });
        conversationId = accepted.conversationId;
      }
      for (let i = 0; i < 10; i++) await Promise.resolve();
      assert.equal(launched.length, count - 1);
      mock.timers.tick(29_999);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      assert.equal(launched.length, count - 1, "no early admission before aging threshold");
      mock.timers.tick(1);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      assert.equal(launched.length, count, "time alone admits an aged request into available reserved capacity");
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
  console.log("PASS #36 real service fake clock: conversation and global aging wake without an external kick");
} finally {
  await service.close();
  mock.restoreAll();
  db.close();
  rmSync(root, { recursive: true, force: true });
}
