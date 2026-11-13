import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkHostAuthority } from "../src/main/agent/work/WorkHostAuthority";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { WorkExecutionAdapter } from "../src/main/agent/work/WorkExecutionAdapter";
import { WorkDispatchQueue } from "../src/main/agent/work/WorkDispatchQueue";
import { WorkProjectionJournal } from "../src/main/agent/work/WorkProjectionJournal";
import { BotConversationService } from "../src/main/agent/work/BotConversationService";
import { BotConversationRepository } from "../src/main/agent/work/BotConversationRepository";
import type { BotConversation } from "../src/main/agent/work/BotConversationRepository";
import type { DurableBotSnapshot } from "../src/shared/durable-bot";
import { DurableBotService } from "../src/main/agent/durable/DurableBotService";
import { botAttachmentSchema } from "../src/shared/bot-conversation";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkControlResult } from "../src/shared/bot-work";

const root = await mkdtemp(join(tmpdir(), "bot-work-phase2-"));
const text = (value: string) => [{ type: "text" as const, text: value }];
let toolSequence = 0;
let effectSequence = 0;
const effectPaths: string[] = [];
const foregroundRequests: TranscriptContext[] = [];
let holdForeground = false;
let foregroundHeld = false;
let releaseSearch!: () => void;
const searchHeld = new Promise<void>(resolve => { releaseSearch = resolve; });
const tool = (name: string, args: Extract<AssistantMessage["content"][number], { type: "toolCall" }>["arguments"]): AssistantMessage["content"] => [{ type: "toolCall", id: `fixture-${++toolSequence}`, name, arguments: args }];
const contentText = (content: TranscriptContext["messages"][number]["content"]) => typeof content === "string" ? content : content.filter(block => block.type === "text").map(block => block.text).join("\n");
const wait = async (predicate: () => boolean | Promise<boolean>, description: string) => {
  const until = Date.now() + 15000;
  while (!await predicate()) { if (Date.now() > until) throw new Error(`timeout: ${description}`); await delay(20); }
};
const unwrap = (result: WorkControlResult) => { if (!result.ok) throw new Error(`${result.code}: ${result.message}`); return result.work; };
const cwd = join(root, "workspace"); await mkdir(cwd);
const db = new AppDatabase(join(root, "business.db"));
const bots = new BotRegistry(db.connection);
bots.registerBot({ userId: LOCAL_USER_ID, botId: DEFAULT_BOT_ID, displayName: "fixture", authorization: DESKTOP_USER_GRANTS });
const lease = new WorkHostAuthority(db.connection, "phase2-host"); assert(lease.acquire().ok);
const works = new WorkService(db.connection, { bots, isAuthority: () => lease.isAuthority() });
const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false });
const reply = (modelId: string, request: TranscriptContext): AssistantMessage["content"] => {
  const last = request.messages.at(-1);
  if (modelId === "backend") {
    if (last?.role === "toolResult") {
      if (last.toolName !== "write") return text("后台实际成果");
      const write = request.messages.flatMap(message => message.role === "assistant" ? message.content : [])
        .findLast(block => block.type === "toolCall" && block.name === "write");
      assert(write?.type === "toolCall");
      return tool("web_search", { path: write.arguments.path });
    }
    const sequence = ++effectSequence;
    return tool("write", { path: join(cwd, `effect-${sequence}.txt`), content: `effect-${sequence}\n` });
  }
  const user = [...request.messages].reverse().find(message => message.role === "user");
  const input = user ? (typeof user.content === "string" ? user.content : user.content.find(part => part.type === "text")?.text ?? "") : "";
  if (last?.role === "toolResult") {
    if (last.toolName === "fetch_content" && input === "前台抓取失败") assert.equal(last.isError, true, "failed fetch remains a failed native tool result");
    if (last.toolName === "work_query_status" && /暂停|修订|取消/.test(input)) {
      const targets = JSON.parse(contentText(last.content));
      const selected = targets.find((item: { workId: string }) => input.includes(item.workId)) ?? targets[0];
      const name = input.includes("暂停") ? "work_pause" : input.includes("修订") ? "work_amend" : "work_cancel";
      return tool(name, { workId: selected.workId, versionGuard: selected.versionGuard, ...(name === "work_amend" ? { goalDescription: "新的业务要求", sourceMessageIds: [] } : {}) });
    }
    return text(contentText(last.content));
  }
  if (input === "前台天气" || input === "前台天气迟到流") return [...text("我来查杭州天气。"), ...tool("web_search", {})];
  if (input === "前台抓取失败") return tool("fetch_content", {});
  if (input === "扩展写入越权") return tool("unrelated_extension_write", {});
  if (input.startsWith("委托")) return tool("work_create", { requestedOutcome: "one_time", mode: "once", title: input, sourceMessageIds: [], criteria: [{ text: "核验实际成果" }] });
  if (/查询|暂停|修订|取消/.test(input)) return tool("work_query_status", {});
  if (input === "越权写文件") return tool("write", { path: join(cwd, "forbidden.txt"), content: "forbidden" });
  return text("前台普通答复");
};
models.registerProvider("fixture", { api: "openai-completions", apiKey: "fixture-only", baseUrl: "http://127.0.0.1:1",
  models: ["front", "backend"].map(id => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 2048,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
  streamSimple: (model, request, options) => {
    if (model.id === "front") foregroundRequests.push(structuredClone(request));
    const stream = createAssistantMessageEventStream();
    const currentInput = [...request.messages].reverse().find(message => message.role === 'user');
    const isHeldRequest = currentInput && contentText(currentInput.content).startsWith('并发慢请求');
    if (model.id === "front" && (holdForeground || isHeldRequest)) {
      foregroundHeld = true;
      const abort = () => {
        stream.push({ type: "error", reason: "aborted", error: { role: "assistant", content: [], stopReason: "aborted",
          api: model.api, model: model.id, provider: model.provider, timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
        stream.end();
      };
      options?.signal?.addEventListener("abort", abort, { once: true });
      if (options?.signal?.aborted) abort();
      return stream;
    }
    queueMicrotask(async () => {
      try {
        const content = reply(model.id, request);
        const stopReason = content.some(block => block.type === "toolCall") ? "toolUse" : "stop";
        const message: AssistantMessage = { role: "assistant", content, stopReason, api: model.api, provider: model.provider, model: model.id,
          timestamp: Date.now(), usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        if (model.id === "front" && contentText(content) === "我来查杭州天气。") {
          stream.push({ type: "start", partial: { ...message, content: text("") } });
          stream.push({ type: "text_delta", contentIndex: 0, delta: "我来查杭州天气。", partial: { ...message, content: text("我来查杭州天气。") } });
          await delay(180);
        }
        if (model.id === "front" && contentText(content) === "前台普通答复") {
          stream.push({ type: "start", partial: { ...message, content: text("") } });
          for (const part of ["前台", "前台普通", "前台普通答复"]) {
            stream.push({ type: "text_delta", contentIndex: 0, delta: part, partial: { ...message, content: text(part) } });
            await delay(180);
          }
        }
        stream.push({ type: "done", reason: stopReason, message }); stream.end();
      } catch (error) { stream.end(); throw error; }
    }); return stream;
  },
});
let releaseEffect!: () => void;
let held = new Promise<void>(resolve => { releaseEffect = resolve; });
let effects = 0;
let adapter: WorkExecutionAdapter;
const native = new DurableBotService({ db, models, agentDir: join(root, "native"), mcpDir: join(root, "mcp"), resolveCwd: () => cwd,
  instructions: () => "后台实际执行", defaultModel: () => "fixture/backend", toolMode: () => "native", toolAllowed: (_task, name) => ["write", "web_search"].includes(name),
  mcpSelection: () => [], beforeSubmit: request => { const error = works.checkTaskInput(request.taskId, request.userMessageId); if (error) throw new Error(error); },
  tools: async () => ({ contextHooks: [], tools: [defineTool({ name: "web_search", description: "写入完成后等待独立只读查询", parameters: Type.Object({ path: Type.String() }), replay: "safe",
    execute: async args => { assert(existsSync(args.path)); effects++; effectPaths.push(args.path); await held; return { output: text("执行完成") }; } })] }),
  onSettled: () => { void adapter?.flush(); }, emit: () => {} });
const errors: unknown[] = [];
adapter = new WorkExecutionAdapter(works, native.workExecutionPort(), LOCAL_USER_ID, () => lease.isAuthority(), (_id, error) => errors.push(error));
const queue = new WorkDispatchQueue(db, works, adapter, () => lease.isAuthority(), () => "fixture/backend");
const streamEvents: import("../src/shared/bot-conversation").BotMessageEvent[] = [];
let foreground = new BotConversationService({ db: db.connection, userId: LOCAL_USER_ID, bots, works, models, directory: join(root, "foreground"),
  defaultModel: () => "fixture/front", isAuthority: () => lease.isAuthority(), memorySearch: () => [], schedule: (work, operationId) => queue.enqueue(work, operationId),
  webTools: async () => ({ contextHooks: [], tools: [
    defineTool({ name: "web_search", description: "search fixture", parameters: Type.Object({}), replay: "safe", execute: async () => { await searchHeld; return {output:text("dated source fixture")}; } }),
    defineTool({ name: "fetch_content", description: "failure fixture", parameters: Type.Object({}), replay: "safe", execute: async () => ({output:text("Blocked internal address: fixture"), isError:true}) }),
    defineTool({ name: "unrelated_extension_write", description: "never exposed", parameters: Type.Object({}), replay: "unsafe", execute: async () => { assert.fail("frontend must only mount the two web read tools"); } }),
  ] }),
  wake: () => { void queue.drain(); }, onMessage: event => streamEvents.push(event) });
const send = async (requestId: string, value: string, selectedWorkId?: string, attachments?: { name: string; path: string }[]) => {
  const request = { botId: DEFAULT_BOT_ID, requestId, text: value, selectedWorkId, attachments };
  const receipt = foreground.send(request);
  await wait(() => ["completed", "failed"].includes(foreground.messages.message(receipt.assistantMessageId)?.status ?? ""), value);
  assert.equal(foreground.messages.message(receipt.assistantMessageId)?.status, "completed", foreground.messages.message(receipt.assistantMessageId)?.error);
  return receipt;
};
try {
  const ordinary = await send("ordinary", "你好");
  assert.equal(foreground.messages.message(ordinary.assistantMessageId)?.text, "前台普通答复");
  assert(!foreground.messages.message(ordinary.assistantMessageId)?.segments?.some(segment => segment.kind === "receipt"), "early streamed direct answer suppresses delayed host receipt");
  const firstRequest = foregroundRequests.at(-1)!;
  await send("ordinary-cache-followup", "缓存连续第二轮");
  const secondRequest = foregroundRequests.at(-1)!;
  assert(firstRequest.messages.some(message => message.role === "system"));
  // Pi stamps each session's initial system entry at construction. Providers do
  // not serialize that metadata; sections, tool declarations and user clocks must stay stable.
  const prefixMessage = (message: TranscriptContext["messages"][number]) => {
    if (message.role !== "system") return message;
    const { timestamp: _timestamp, ...prompt } = message;
    return prompt;
  };
  assert.deepEqual(secondRequest.messages.filter(message => message.role === "system").map(prefixMessage), firstRequest.messages.filter(message => message.role === "system").map(prefixMessage), "new user time must not rewrite system sections or tool declarations");
  assert.deepEqual(secondRequest.messages.slice(0, firstRequest.messages.length).map(prefixMessage), firstRequest.messages.map(prefixMessage), "earlier user clock and text stay byte-for-byte stable");
  const firstUser = firstRequest.messages.find(message => message.role === "user")!;
  const secondUser = [...secondRequest.messages].reverse().find(message => message.role === "user")!;
  assert.match(contentText(firstUser.content), /宿主提供的本次请求时间上下文/);
  assert(contentText(firstUser.content).includes(new Date(foreground.messages.message(ordinary.userMessageId)!.createdAt).toISOString()), "native input uses the persisted user receipt time");
  assert.match(contentText(secondUser.content), /宿主提供的本次请求时间上下文/);
  assert.notEqual(contentText(firstUser.content), contentText(secondUser.content));
  const liveFrames = streamEvents.filter(event => event.message.requestId === "ordinary" && event.message.status === "running");
  assert(liveFrames.length >= 2, "foreground persists and emits partial text before final response");
  assert(liveFrames.some(event => event.message.text.length < "前台普通答复".length));
  assert(liveFrames.every((event, index) => !index || event.revision > liveFrames[index - 1].revision));
  assert.equal(streamEvents.at(-1)?.message.status, "completed");
  assert.equal(streamEvents.at(-1)?.message.text, "前台普通答复");
  console.log("PASS native Bot incremental text transport, persistent monotonic revisions and final reconciliation");

  assert.equal(db.listTasks().length, 0, "ordinary Bot conversation must not create Task");
  assert.equal(works.listWorks(LOCAL_USER_ID).length, 0);
  const weatherDone = send("frontend-weather", "前台天气");
  await wait(() => streamEvents.some(event => event.message.requestId === "frontend-weather" && event.message.activity?.tool === "web_search" && event.message.activity.status === "running"), "search activity before tool completion");
  const weatherActivity = foreground.history({ botId: DEFAULT_BOT_ID }).messages.find(message => message.requestId === "frontend-weather" && message.role === "assistant")!;
  assert.deepEqual(weatherActivity.activity, { tool: "web_search", status: "running" }, "reconnected readers see the same bounded tool status");
  assert.equal(weatherActivity.text, "我来查杭州天气。", "public model prelude survives while actual tool activity is separate");
  assert.deepEqual(weatherActivity.segments?.map(segment => [segment.kind, segment.text]), [["commentary", "我来查杭州天气。"]]);
  const weatherFrames = streamEvents.filter(event => event.message.requestId === "frontend-weather");
  const firstPrelude = weatherFrames.findIndex(event => event.message.segments?.some(segment => segment.text === "我来查杭州天气。"));
  const firstTool = weatherFrames.findIndex(event => event.message.activity?.status === "running");
  assert(firstPrelude >= 0 && firstPrelude < firstTool, "first visible model sentence publishes before tool execution without an extra generation");
  const preludeId = weatherActivity.segments![0].id;
  assert.equal(new BotConversationRepository(db.connection).message(weatherActivity.messageId)?.segments?.[0].id, preludeId, "reconnect retains the same prelude identity");
  assert.equal(new BotConversationRepository(db.connection).message(weatherActivity.messageId)?.activity?.tool, "web_search", "activity does not rely on service memory");
  const nativeSnapshot: DurableBotSnapshot = { backend: "pi-durable", historyId: "history-fixture", epoch: "fixture", revision: 1, conversationId: "native",
    toolMode: "native", busy: true, queued: 0, pendingInputs: [], compacting: false, messages: [
      { id: "user", role: "user", text: "前台天气", botRequestId: "older-request", createdAt: 1 },
      { id: "assistant", role: "assistant", text: "foreign answer", createdAt: 2,
        tools: [{ id: "foreign-tool", tool: "fetch_content", summary: "private arguments", output: "private output", status: "running" }] },
    ] };
  const conversation = foreground.messages.conversation(LOCAL_USER_ID, DEFAULT_BOT_ID, weatherActivity.conversationId)!;
  const applySnapshot = () => (foreground as unknown as { stream(conversation: BotConversation, snapshot: DurableBotSnapshot): void }).stream(conversation, nativeSnapshot);
  applySnapshot();
  assert.deepEqual(foreground.messages.message(weatherActivity.messageId), weatherActivity, "same user text with another native request cannot change answer or activity");
  const activityFrames = () => streamEvents.filter(event => event.message.requestId === "frontend-weather" && event.message.activity?.status === "running").length;
  const frameCount = activityFrames();
  await delay(250);
  assert.equal(activityFrames(), frameCount, "waiting for a tool must not spam status messages");
  const overlapping = await send("frontend-overlap", "搜索等待期间的独立问题");
  assert.equal(foreground.messages.message(overlapping.assistantMessageId)?.text, "前台普通答复");
  assert.equal(foreground.messages.message(weatherActivity.messageId)?.status, "running", "independent foreground answer finishes while original search is still running");
  const runtimeKeys = db.connection.prepare("SELECT runtime_key FROM bot_request_runs WHERE message_id IN (?,?)").all(weatherActivity.messageId, overlapping.assistantMessageId) as { runtime_key: string }[];
  assert.equal(new Set(runtimeKeys.map(row => row.runtime_key)).size, 2, "overlapping requests own independent native runtimes");
  releaseSearch();
  const weather = await weatherDone;
  assert.equal(foreground.messages.message(weather.assistantMessageId)?.text, "dated source fixture");
  assert.equal(foreground.messages.message(weather.assistantMessageId)?.activity, undefined, "final reconciliation removes transient activity");
  assert.deepEqual(foreground.messages.message(weather.assistantMessageId)?.segments?.map(segment => [segment.kind, segment.text]),
    [["commentary", "我来查杭州天气。"], ["answer", "dated source fixture"]], "final answer neither replaces nor duplicates the prelude");
  assert.equal(foreground.messages.message(weather.assistantMessageId)?.segments?.[0].id, preludeId);
  assert.equal(foregroundRequests.filter(request => {
    const user = [...request.messages].reverse().find(message => message.role === "user");
    return user && contentText(user.content).startsWith("前台天气");
  }).length, 2, "prelude uses the existing tool-call generation, not another model request");
  const afterOutOfOrder = await send("after-out-of-order", "乱序完成后的后续问题");
  const contextRow = db.connection.prepare('SELECT context_json FROM bot_request_runs WHERE message_id=?').get(afterOutOfOrder.assistantMessageId) as { context_json: string };
  const frozen = JSON.parse(contextRow.context_json);
  assert(frozen.history.some((message: { messageId: string; text: string }) => message.messageId === weather.assistantMessageId && message.text === 'dated source fixture'), 'late completed earlier result must supplement the newer native prefix');
  // Deliberately drop every final-answer presentation frame for one native request.
  // Completion must rebuild from durable entries, not overwrite the visible prelude.
  const streamPort = foreground as unknown as { stream(conversation: BotConversation, snapshot: DurableBotSnapshot, requestId?: string): void };
  const originalStream = streamPort.stream.bind(foreground);
  let droppedFinalFrames = 0;
  streamPort.stream = (conversation, snapshot, requestId) => {
    if (requestId === "late-final" && snapshot.messages.at(-1)?.text === "dated source fixture") { droppedFinalFrames++; return; }
    originalStream(conversation, snapshot, requestId);
  };
  const lateFinal = await send("late-final", "前台天气迟到流");
  streamPort.stream = originalStream;
  assert(droppedFinalFrames > 0, "fixture really suppressed the final stream frames");
  assert.deepEqual(foreground.messages.message(lateFinal.assistantMessageId)?.segments?.filter(segment => segment.kind !== "receipt").map(segment => [segment.kind, segment.text]),
    [["commentary", "我来查杭州天气。"], ["answer", "dated source fixture"]], "authoritative final transcript repairs missing presentation frames without replacing or duplicating the prelude");
  nativeSnapshot.messages[0].botRequestId = "frontend-weather";
  const completedWeather = foreground.messages.message(weather.assistantMessageId);
  applySnapshot();
  assert.deepEqual(foreground.messages.message(weather.assistantMessageId), completedWeather, "late snapshot cannot revive activity on a completed request");
  const fetchFailure = await send("frontend-fetch-error", "前台抓取失败");
  assert.match(foreground.messages.message(fetchFailure.assistantMessageId)?.text ?? "", /Blocked internal address/);
  assert(streamEvents.some(event => event.message.requestId === "frontend-fetch-error" && event.message.activity?.tool === "fetch_content" && event.message.activity.status === "error"), "failed tool remains a failure, not success progress");
  await send("frontend-filter", "扩展写入越权");
  assert.equal(db.listTasks().length, 0);
  assert.equal(works.listWorks(LOCAL_USER_ID).length, 0);
  console.log("PASS frontend default web search/fetch executes for existing Bot without Task/Work; errors retained; non-web extension is not exposed");
  const attachmentPath = join(root, "background-material.txt");
  writeFileSync(attachmentPath, "background material evidence");
  const accepted = await send("delegate-a", "委托 A");
  await wait(() => effects === 1, "backend starts independently");
  const a = works.listWorks(LOCAL_USER_ID)[0]!;
  const aBinding = works.repo.listBindings(a.workId)[0]!;
  assert(aBinding.taskId.startsWith("work-execution-"));
  assert.notEqual(accepted.conversationId, aBinding.conversationId);
  assert.deepEqual(foreground.messages.message(accepted.assistantMessageId)?.workIds, [a.workId]);
  assert.equal(foreground.send({ botId: DEFAULT_BOT_ID, requestId: "delegate-a", text: "委托 A" }).replayed, true);
  assert.throws(() => foreground.send({ botId: DEFAULT_BOT_ID, requestId: "delegate-a", text: "different" }));
  assert.equal(works.listWorks(LOCAL_USER_ID).length, 1);
  await send("query-running", "查询");
  await send("delegate-b", "委托 B", undefined, [{ name: "background-material.txt", path: attachmentPath }]);
  await queue.drain();
  await wait(() => effects === 2, "independent root file effects start while the first root is held");
  const b = works.listWorks(LOCAL_USER_ID).find(work => work.workId !== a.workId)!;
  const bBinding = works.repo.listBindings(b.workId)[0]!;
  const backgroundAttachment = foreground.messages.history(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID }).messages.find(message => message.requestId === "delegate-b" && message.role === "user")?.attachments?.[0];
  assert(backgroundAttachment, "user attachment is persisted");
  // The snapshot contains JSON lines: Windows path separators are escaped on the wire.
  const forwardedAttachments = (binding: typeof bBinding) => works.repo.attachmentInput(binding).trim().split("\n").slice(1)
    .map(line => botAttachmentSchema.parse(JSON.parse(line)));
  assert.deepEqual(forwardedAttachments(bBinding), [backgroundAttachment], "host forwards exact durable attachment path into background input snapshot");
  const pathFixtures = [
    { name: "drive.txt", path: String.raw`C:\Users\vivion\文档\background-material.txt` },
    { name: "unc.txt", path: String.raw`\\server\share\background-material.txt` },
    { name: "posix.txt", path: '/tmp/文档/background-"material".txt' },
  ];
  const pathFixtureBinding = { ...bBinding, inputSnapshotId: `${bBinding.inputSnapshotId}:path-roundtrip` };
  db.connection.prepare("INSERT INTO bot_work_attachments (work_id,input_snapshot_id,attachments_json) VALUES (?,?,?)")
    .run(b.workId, pathFixtureBinding.inputSnapshotId, JSON.stringify(pathFixtures));
  try {
    assert.deepEqual(forwardedAttachments(pathFixtureBinding), pathFixtures, "drive, UNC and quoted POSIX paths survive the actual snapshot serializer unchanged on every platform");
  } finally {
    db.connection.prepare("DELETE FROM bot_work_attachments WHERE work_id=? AND input_snapshot_id=?").run(b.workId, pathFixtureBinding.inputSnapshotId);
  }
  assert.equal(await readFile(backgroundAttachment.path, "utf8"), "background material evidence");
  assert.equal(bBinding.conversationId, aBinding.conversationId, "real native roots independently start with the same numeric conversation ID");
  assert.notEqual(bBinding.durableStoreKey, aBinding.durableStoreKey);
  foreground.archive(DEFAULT_BOT_ID, accepted.conversationId);
  assert.equal(foreground.history({ botId: DEFAULT_BOT_ID }).messages.length, 0);
  assert.equal(works.getWork(a.workId)?.lifecycle, "active");
  assert(["submitted", "running"].includes(works.repo.getBinding(aBinding.bindingId)?.status ?? ""), "archiving a real Bot conversation does not cancel its still-running native root");
  await send("ambiguous", "暂停");
  assert.equal(works.getWork(a.workId)?.lifecycle, "active");
  assert.equal(works.getWork(b.workId)?.lifecycle, "active", "ambiguous control cannot pause all or select a random Work");
  await send("pause-b", `暂停 ${b.workId}`, b.workId);
  assert.equal(works.getWork(b.workId)?.lifecycle, "paused");
  const snapshot = new WorkProjectionJournal(db.connection, works).sync(LOCAL_USER_ID, { includeClosed: false });
  assert.equal(snapshot.kind, "snapshot");
  await send("cancel-b", `取消 ${b.workId}`, b.workId);
  // 两个独立 root 并发运行：取消 b 之后仍在途的派发要等 b 的模拟工具返回，
  // 因此先发起 flush，再释放工具，避免把 flush 与 held 互相等待成死锁。
  const cancelFlush = queue.drain();
  releaseEffect(); held = Promise.resolve();
  await cancelFlush;
  await wait(async () => { await adapter.flush(); return works.repo.getBinding(aBinding.bindingId)?.status === "completed"; }, "native result independent of usage telemetry");
  assert.equal(errors.length, 0, errors.map(String).join("\n"));
  assert.equal(effects, 2);
  assert.equal(new Set(effectPaths).size, 2, "the two real writes target independent files");
  assert.deepEqual((await Promise.all(effectPaths.map(path => readFile(path, "utf8")))).map(text => text.trim()).sort(),
    ["effect-1", "effect-2"], "each native root wrote its own file once");
  assert.equal(works.repo.listDeliverables(a.workId).length, 1);
  assert.equal(works.getWork(a.workId)?.lifecycle, "active", "native completion is not acceptance");
  const version = works.getWork(a.workId)!.stateVersion;
  works.nativeResults.consume(); await adapter.flush();
  unwrap(works.reconcileExecution({ kind: "system", reason: "late-running" }, { bindingId: aBinding.bindingId, outcome: "running" }));
  assert.equal(works.getWork(a.workId)!.stateVersion, version);
  assert.equal(works.repo.getBinding(aBinding.bindingId)?.status, "completed");
  await send("amend-a", `修订 ${a.workId}`, a.workId);
  await wait(async () => { await queue.drain(); return effects === 3 && works.repo.listBindings(a.workId).filter(binding => binding.status === "completed").length === 2; }, "new input gets its own root");
  const amendedBindings = works.repo.listBindings(a.workId);
  assert.equal(amendedBindings.length, 2);
  assert.equal(amendedBindings[0].conversationId, amendedBindings[1].conversationId);
  assert.notEqual(amendedBindings[0].durableStoreKey, amendedBindings[1].durableStoreKey);
  assert.notEqual(amendedBindings[0].inputSnapshotId, amendedBindings[1].inputSnapshotId);
  assert.equal(works.repo.listDeliverables(a.workId).find(deliverable => deliverable.executionId === aBinding.bindingId)?.status, "superseded");
  assert.equal(works.repo.listDeliverables(a.workId).filter(deliverable => deliverable.status === "proposed").length, 1);
  assert.equal(works.getWork(a.workId)?.acceptedDeliverableIds.length, 0);
  await send("no-escape", "越权写文件");
  assert(!existsSync(join(cwd, "forbidden.txt")), "foreground cannot execute coding tools");
  await foreground.close();
  foreground = new BotConversationService({ db: db.connection, userId: LOCAL_USER_ID, bots, works, models, directory: join(root, "foreground"),
    defaultModel: () => "fixture/front", isAuthority: () => lease.isAuthority(), memorySearch: () => [], schedule: (work, operationId) => queue.enqueue(work, operationId), wake: () => {} });
  const history = foreground.history({ botId: DEFAULT_BOT_ID }); assert(history.messages.length >= 10);
  assert.notEqual(history.conversationId, accepted.conversationId);
  assert(foreground.history({ botId: DEFAULT_BOT_ID, conversationId: accepted.conversationId }).messages.some(message => message.messageId === accepted.assistantMessageId), "archived message references remain addressable");
  foreground.archive(DEFAULT_BOT_ID, history.conversationId);
  assert.equal(foreground.history({ botId: DEFAULT_BOT_ID }).messages.length, 0);
  assert(works.getWork(a.workId));
  assert.equal(works.getWork(a.workId)?.lifecycle, "active");
  if (snapshot.kind === "snapshot") {
    const delta = new WorkProjectionJournal(db.connection, works).sync(LOCAL_USER_ID, { includeClosed: false, cursor: snapshot.cursor });
    assert.equal(delta.kind, "delta");
    assert(["closing", "closed"].includes(works.getWork(b.workId)?.lifecycle ?? ""),
      "cancelled Work settles through its real in-flight execution instead of disappearing as an unstarted binding");
  }
  const slowRequests = [1,2,3].map(index => foreground.send({ botId: DEFAULT_BOT_ID, requestId: `slow-${index}`, text: `并发慢请求${index}` }));
  await wait(() => slowRequests.every(receipt => foreground.messages.message(receipt.assistantMessageId)?.status === 'running'), 'three independent slow requests admitted');
  const overflow = foreground.send({ botId: DEFAULT_BOT_ID, requestId: 'overflow', text: '普通容量队列' });
  await wait(() => slowRequests.every(receipt => foreground.messages.message(receipt.assistantMessageId)?.segments?.some(segment => segment.kind === "receipt")), "slow requests receive truthful acknowledgment while model is silent");
  await wait(() => foreground.messages.message(overflow.assistantMessageId)?.segments?.some(segment => segment.kind === "receipt") ?? false, "queued request receives truthful acknowledgment without waiting for a runtime slot");
  assert.equal(foreground.messages.message(overflow.assistantMessageId)?.status, 'queued');
  assert.match(foreground.messages.message(overflow.assistantMessageId)?.segments?.[0].text ?? "", /已排队/);
  for (const receipt of slowRequests) {
    const message = foreground.messages.message(receipt.assistantMessageId)!;
    assert.equal(message.text, "", "host receipt cannot become model answer text");
    assert.equal(message.segments?.length, 1);
    assert.match(message.segments![0].text, /正在处理/);
  }
  const silentSegments = structuredClone(foreground.messages.message(slowRequests[0].assistantMessageId)!.segments);
  await delay(600);
  assert.deepEqual(foreground.messages.message(slowRequests[0].assistantMessageId)!.segments, silentSegments, "one quiet receipt, not repeated polling prose");
  assert.equal(foreground.messages.message(slowRequests[0].assistantMessageId)!.text, "", "silent model produces no answer prose");
  const urgent = await send('priority-status', '当前进度状态');
  assert.equal(foreground.messages.message(urgent.assistantMessageId)?.status, 'completed', 'reserved capacity handles progress while normal slots are occupied');
  await foreground.cancel(DEFAULT_BOT_ID, 'slow-2');
  assert.equal(foreground.messages.message(slowRequests[1].assistantMessageId)?.status, 'cancelled');
  assert.equal(foreground.messages.message(slowRequests[1].assistantMessageId)?.segments?.filter(segment => segment.kind === 'receipt').length, 1, 'cancellation preserves one receipt and never invents a model final');
  assert.equal(foreground.messages.message(slowRequests[0].assistantMessageId)?.status, 'running', 'cancel one must not abort sibling runtime');
  await wait(() => foreground.messages.message(overflow.assistantMessageId)?.status === 'completed', 'free slot drains ordinary queued request');
  await Promise.all([foreground.cancel(DEFAULT_BOT_ID, 'slow-1'), foreground.cancel(DEFAULT_BOT_ID, 'slow-3')]);
  console.log('PASS bounded foreground overlap, reserved control capacity, request-specific cancellation and queue progress');
  holdForeground = true;
  const beforeClose = foreground.send({ botId: DEFAULT_BOT_ID, requestId: "normal-close", text: "关闭前的普通消息" });
  await wait(() => foregroundHeld, "foreground model starts before normal close");
  await foreground.close();
  holdForeground = false;
  foreground = new BotConversationService({ db: db.connection, userId: LOCAL_USER_ID, bots, works, models, directory: join(root, "foreground"),
    defaultModel: () => "fixture/front", isAuthority: () => lease.isAuthority(), memorySearch: () => [], schedule: (work, operationId) => queue.enqueue(work, operationId), wake: () => {} });
  foreground.recover();
  await wait(() => foreground.messages.message(beforeClose.assistantMessageId)?.status === "completed", "normal close preserves the original native request");
  await send("after-normal-close", "重新打开后的下一条消息");
  await foreground.close();
  foreground = new BotConversationService({ db: db.connection, userId: LOCAL_USER_ID, bots, works, models, directory: join(root, "foreground"),
    defaultModel: () => "fixture/front", isAuthority: () => lease.isAuthority(), memorySearch: () => [], schedule: (work, operationId) => queue.enqueue(work, operationId), wake: () => {} });
  const cancelCloseRace = works.transaction(() => foreground.messages.accept(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, requestId: "cancel-close-race", text: "queued before closing" }));
  foreground.messages.update(cancelCloseRace.assistantMessageId, "running", "", undefined, { tool: "web_search", status: "running" });
  await Promise.all([foreground.cancel(DEFAULT_BOT_ID, "cancel-close-race"), foreground.close()]);
  assert.equal(foreground.messages.message(cancelCloseRace.assistantMessageId)?.activity, undefined, "cancellation clears persisted tool activity atomically");
  assert(!existsSync(join(root, "foreground", cancelCloseRace.conversationId, ".mybuddy-owner.json")), "cancel and close in the same tick cannot leak a native runtime lease");
  foreground = new BotConversationService({ db: db.connection, userId: LOCAL_USER_ID, bots, works, models, directory: join(root, "foreground"),
    defaultModel: () => "fixture/front", isAuthority: () => lease.isAuthority(), memorySearch: () => [], schedule: (work, operationId) => queue.enqueue(work, operationId), wake: () => {} });
  foreground.recover(); await send("after-cancel-close-race", "正常回复");
  assert.equal(foreground.messages.message(cancelCloseRace.assistantMessageId)?.status, "cancelled");
  assert.throws(() => foreground.send({ botId: DEFAULT_BOT_ID, requestId: "actor-injection", text: "hello", actor: { kind: "user" } }));
  bots.registerBot({ botId: "foreign-bot", userId: "another-user", displayName: "foreign" });
  assert.throws(() => foreground.send({ botId: "foreign-bot", requestId: "cross-user", text: "hello" }));
  bots.registerBot({ botId: "expired-bot", userId: LOCAL_USER_ID, displayName: "expired", authorization: { ...DESKTOP_USER_GRANTS, expiresAt: Date.now() - 1000 } });
  const beforeExpired = works.listWorks(LOCAL_USER_ID, { includeClosed: true }).length;
  const expired = foreground.send({ botId: "expired-bot", requestId: "expired-create", text: "委托 expired" });
  await wait(() => foreground.messages.message(expired.assistantMessageId)?.status === "completed", "legacy authorization expiry does not block delegation");
  assert.equal(works.listWorks(LOCAL_USER_ID, { includeClosed: true }).length, beforeExpired + 1);
  assert.doesNotMatch(foreground.messages.message(expired.assistantMessageId)?.text ?? "", /授权已过期/);
  db.connection.prepare("UPDATE bots SET status='disabled' WHERE bot_id=?").run(DEFAULT_BOT_ID);
  assert.throws(() => foreground.send({ botId: DEFAULT_BOT_ID, requestId: "disabled-new", text: "委托 disabled" }));
  assert.equal(foreground.send({ botId: DEFAULT_BOT_ID, requestId: "after-normal-close", text: "重新打开后的下一条消息" }).replayed, true, "disabled Bot may still return an already accepted receipt");
  console.log("PASS Phase 2 real foreground/native root/control/inbox/projection chain; ordinary chat Task count=0; original+independent+amended effects=3, one per input/root, numeric native IDs equal and namespaces isolated");
} finally {
  releaseEffect(); await foreground.close(); await queue.close(); await adapter.close(); await native.close(); lease.stop(); db.close(); await rm(root, { recursive: true, force: true });
}
