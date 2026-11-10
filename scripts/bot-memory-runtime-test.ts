import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { BotConversationService } from "../src/main/agent/work/BotConversationService";
import { BotConversationMemory } from "../src/main/agent/work/BotConversationMemory";
import { WorkService } from "../src/main/agent/work/WorkService";
import { MemoryService } from "../src/main/memory/MemoryService";
import { MemoryPipelineManager } from "../src/main/memory/MemoryPipelineManager";
import { LOCAL_USER_ID } from "../src/shared/bot-work";

const root = await mkdtemp(join(tmpdir(), "bot-memory-native-"));
const db = new AppDatabase(join(root, "app.db"));
const bots = new BotRegistry(db.connection);
bots.registerBot({ userId: LOCAL_USER_ID, botId: "memory-native", displayName: "memory native" });
assert(bots.getBot("memory-native")!.foregroundAllowedTools.includes("memory_forget"));
// Old persisted rows must not hide the new user-requested forget action.
db.connection.prepare("UPDATE bots SET foreground_allowed_tools_json=? WHERE bot_id=?").run(JSON.stringify(["memory_search"]), "memory-native");
assert(bots.getBot("memory-native")!.foregroundAllowedTools.includes("memory_forget"));
const works = new WorkService(db.connection, { bots, isAuthority: () => true });
const memory = new MemoryService(db, { semantic: false });
const pipeline = new MemoryPipelineManager(db);
let enabled = true;
let capturedReply = false;
let calls = 0;
let extractionHold: Promise<void> | undefined;
const requests: TranscriptContext[] = [];
const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false });
models.registerProvider("fixture", { api: "openai-completions", apiKey: "fixture-only", baseUrl: "http://127.0.0.1:1",
  models: [{ id: "front", name: "front", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 2048,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  streamSimple: (model, request) => {
    requests.push(request);
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "收到。" }], stopReason: "stop", api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream.push({ type: "done", reason: "stop", message }); stream.end();
    }); return stream;
  },
});
const extractModels = { completeSimple: async () => {
  assert(capturedReply, "reply publishes before extraction waits"); calls++;
  await extractionHold;
  return { content: [{ type: "text", text: JSON.stringify({ candidates: calls === 1 ? [{ kind: "preference", title: "偏好颜色", retention: "stable", sensitivity: "none", content: "用户喜欢青绿色。", scopeType: "global", userEvidence: "我喜欢青绿色", explicit: true, confidence: 1, importance: 2, operationHint: "create" }] : [] }) }], stopReason: "stop" };
} } as unknown as ModelRuntime;
const bridge = new BotConversationMemory({ db, userId: LOCAL_USER_ID, memory, pipeline, enabled: () => enabled,
  changed: () => {}, extract: async taskId => {
    const turns = pipeline.turns.listPending(taskId); pipeline.beginL1(turns);
    const isEnabled = () => enabled && pipeline.turns.allExist(turns.map(turn => turn.id));
    await memory.extractAndStore({ taskId, sourceTurns: turns, userText: turns.at(-1)!.userText, assistantText: "",
      modelRuntime: extractModels, model: models.getModel("fixture", "front")!, isEnabled });
    pipeline.completeL1(taskId, turns);
  } });
const options = { db: db.connection, userId: LOCAL_USER_ID, bots, works, models, directory: join(root, "conversations"),
  defaultModel: () => "fixture/front", isAuthority: () => true, memory: bridge,
  memorySearch: (id: string, query: string) => bridge.search(id, query), schedule: () => {}, wake: () => {},
  onMessage: (event: { message: { role: string; status: string } }) => { if (event.message.role === "assistant" && event.message.status === "completed") capturedReply = true; },
};
let service = new BotConversationService(options);
const until = async (predicate: () => boolean, label: string) => { const end = Date.now() + 15000; while (!predicate()) { if (Date.now() > end) throw Error(label); await delay(10); } };
try {
  const receipt = service.send({ botId: "memory-native", requestId: "native-1", text: "请记住我喜欢青绿色" });
  await until(() => memory.listExactScope("bot", "memory-native").length === 1, "native completed turn must learn");
  assert.equal(calls, 1);
  service.archive("memory-native", receipt.conversationId);
  await service.close();
  service = new BotConversationService(options); service.recover();
  const next = service.send({ botId: "memory-native", requestId: "native-2", text: "帮我挑个杯子颜色" });
  await until(() => service.messages.message(next.assistantMessageId)?.status === "completed", "fresh native conversation reply");
  assert.notEqual(next.conversationId, receipt.conversationId);
  assert(JSON.stringify(requests.at(-1)).includes("用户喜欢青绿色"), "fresh provider request receives private memory despite no previous chat history");
  assert(!db.getTask(next.conversationId));
  await service.close();
  memory.listExactScope("bot", "memory-native").forEach(atom => memory.forget(atom.id));
  service = new BotConversationService(options);
  const deleted = service.send({ botId: "memory-native", requestId: "native-3", text: "现在还记得吗" });
  await until(() => service.messages.message(deleted.assistantMessageId)?.status === "completed", "after deletion reply");
  assert(!JSON.stringify(requests.at(-1)).includes("用户喜欢青绿色"), "memory evidence was not persisted into native transcript");
  await until(() => pipeline.turns.listByTask(deleted.conversationId).every(turn => turn.extractionState === "completed"), "previous learning settled");
  let release!: () => void;
  extractionHold = new Promise(resolve => { release = resolve; });
  const beforeHeld = calls;
  const held = service.send({ botId: "memory-native", requestId: "native-4", text: "请记住我喜欢靛蓝色" });
  await until(() => calls > beforeHeld, "held extraction started");
  const following = service.send({ botId: "memory-native", requestId: "native-5", text: "继续正常回复" });
  await until(() => service.messages.message(following.assistantMessageId)?.status === "completed", "following foreground request is not blocked by extraction");
  await Promise.race([service.close(), delay(2000).then(() => { throw Error("close blocked by background memory"); })]);
  enabled = false; release(); extractionHold = undefined;
  await delay(30);
  assert.equal(service.messages.message(held.assistantMessageId)?.status, "completed");
  console.log("PASS Bot native runtime: completed reply capture, asynchronous learning, restart/new chat recall, deletion withdraws ephemeral context, hung extraction cannot block next message or shutdown");
} finally { await service.close(); db.close(); await rm(root, { recursive: true, force: true }); }
