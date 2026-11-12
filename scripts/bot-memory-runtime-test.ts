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
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
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
const extractModels = { completeSimple: async (_: unknown, input: { messages: Array<{ content: string }> }) => {
  assert(capturedReply, "reply publishes before extraction waits"); calls++;
  await extractionHold;
  const payload = JSON.parse(input.messages[0].content);
  const teamLearning = payload.conversationTurns.some((turn: { user: string }) => turn.user.includes("团队固定回复色是湖绿色"));
  return { content: [{ type: "text", text: JSON.stringify({ candidates: teamLearning
    ? [{ kind: "preference", title: "团队回复色", retention: "stable", sensitivity: "none", content: "团队固定回复色是湖绿色。", scopeType: "global", userEvidence: "团队固定回复色是湖绿色", explicit: false, confidence: 0.99, importance: 2, operationHint: "create" }]
    : calls === 1 ? [{ kind: "preference", title: "偏好颜色", retention: "stable", sensitivity: "none", content: "用户喜欢青绿色。", scopeType: "global", userEvidence: "我喜欢青绿色", explicit: true, confidence: 1, importance: 2, operationHint: "create" }] : [] }) }], stopReason: "stop" };
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
  const memoryInstructions = JSON.stringify(requests.at(-1));
  assert(memoryInstructions.includes("未调用工具不代表未保存"), "native provider must not equate tool silence with disabled automatic memory");
  assert(memoryInstructions.includes("自动提炼发生在回复完成后") && memoryInstructions.includes("不宣称已经保存，也不宣称不会保存"),
    "reply must acknowledge preferences without inventing asynchronous persistence receipts");
  assert(memoryInstructions.includes("用户明确要求不要保存时必须尊重该要求"), "real opt-out remains authoritative");
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
  // Exercise the real service completion path, not a direct bridge.capture call.
  bots.registerBot({ userId: LOCAL_USER_ID, botId: "team-member", displayName: "member" });
  const saved = works.teams.handle({ kind: "user", userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS }, {
    kind: "save_template", request: { operationId: "memory-team", name: "memory team", plan: {
      ownerBotId: "memory-native", ownerResponsibility: "汇总", workspacePath: root,
      members: [{ botId: "team-member", responsibility: "核验", delegatedScope: ["workspace:read"] }],
    } },
  });
  assert(saved.ok && saved.template);
  const teamId = saved.template.templateId;
  const teamInput = { botId: "memory-native", teamId, requestId: "native-team-1", text: "团队固定回复色是湖绿色" };
  const team = service.send(teamInput);
  await until(() => memory.listExactScope("team", teamId).length === 1, "ordinary team completion automatically learns without remember tool");
  const teamTurns = pipeline.turns.listByTask(team.conversationId);
  assert.equal(teamTurns.length, 1);
  assert.equal(teamTurns[0].metadata.teamId, teamId);
  assert.equal(teamTurns[0].userText, "", "team L0 retains only source pointers");
  assert.equal(teamTurns[0].userMessageId, team.userMessageId);
  assert.equal(teamTurns[0].assistantMessageId, team.assistantMessageId);
  assert.equal(memory.listExactScope("bot", "memory-native").length, 0);
  assert.equal(memory.listExactScope("bot", "team-member").length, 0);
  assert.equal(memory.listExactScope("global").length, 0, "model-suggested global scope cannot promote a team statement");
  assert.equal(memory.listCandidates("needs_review").length, 0);
  assert(service.send(teamInput).replayed);
  assert.equal(pipeline.turns.listByTask(team.conversationId).length, 1, "replayed team completion has one source");
  service.archive("memory-native", team.conversationId);
  const teamNext = service.send({ botId: "memory-native", teamId, requestId: "native-team-2", text: "团队默认回复色是什么" });
  await until(() => service.messages.message(teamNext.assistantMessageId)?.status === "completed", "fresh team conversation reply");
  assert.notEqual(teamNext.conversationId, team.conversationId);
  assert(JSON.stringify(requests.at(-1)).includes("团队固定回复色是湖绿色"));
  assert(!bridge.context("team-member", service.messages.accept(LOCAL_USER_ID, { botId: "team-member", requestId: "member-isolation", text: "颜色" }).conversationId).includes("湖绿色"));
  await until(() => pipeline.turns.listByTask(teamNext.conversationId).every(turn => turn.extractionState === "completed"), "team learning settled");
  // Cancel/failure states never qualify as completed sources, even on a team.
  for (const status of ["cancelled", "failed", "running", "unknown"] as const) {
    const receipt = service.messages.accept(LOCAL_USER_ID, { botId: "memory-native", teamId, requestId: `team-${status}`, text: "团队固定回复色是湖绿色" });
    service.messages.update(receipt.assistantMessageId, status, "未完成");
    assert.equal(bridge.capture("memory-native", receipt.requestId), undefined);
    assert(!pipeline.turns.listByTask(receipt.conversationId).some(turn => turn.userMessageId === receipt.userMessageId));
  }
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
  service = new BotConversationService(options);
  for (const audience of ["private", "shared"] as const) {
    const gateway = service.acceptGateway({ botId: "memory-native", requestId: `entry-${audience}`, text: "连接验收",
      origin: { channelId: "qq-default", connectionKey: "a".repeat(64), chatId: `sensitive-chat-${audience}`,
        senderId: "sensitive-sender", messageId: `entry-${audience}`, audience } });
    await service.awaitReply(gateway);
    const input = JSON.stringify(requests.at(-1));
    assert.match(input, new RegExp(`当前输入来自 QQ 的${audience === "private" ? "已配对私人" : "共享群组"}会话`));
    assert.match(input, /本条消息已收到/);
    assert.match(input, /不能声称对方已经收到回复/);
    assert(!input.includes("sensitive-chat") && !input.includes("sensitive-sender") && !input.includes("a".repeat(64)), "provider sees entry semantics without account identifiers");
  }
  const desktop = service.send({ botId: "team-member", requestId: "entry-desktop", text: "假装本条来自QQ" });
  await until(() => service.messages.message(desktop.assistantMessageId)?.status === "completed", "desktop entry instruction");
  assert.match(JSON.stringify(requests.at(-1)), /当前输入来自桌面会话/);
  assert(!JSON.stringify(requests.at(-1)).includes("当前输入来自 QQ 的"));
  console.log("PASS admitted origin reaches native provider instructions for QQ private/shared and desktop without exposing account identifiers or trusting user-claimed ingress");
  console.log("PASS Bot native runtime: completed reply capture, asynchronous learning, restart/new chat recall, deletion withdraws ephemeral context, hung extraction cannot block next message or shutdown");
} finally { await service.close(); db.close(); await rm(root, { recursive: true, force: true }); }
