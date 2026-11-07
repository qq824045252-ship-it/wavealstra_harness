import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { appendFileSync, existsSync } from "node:fs";
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
import { DurableBotService } from "../src/main/agent/durable/DurableBotService";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkControlResult } from "../src/shared/bot-work";

const root = await mkdtemp(join(tmpdir(), "bot-work-phase2-"));
const text = (value: string) => [{ type: "text" as const, text: value }];
let toolSequence = 0;
let holdForeground = false;
let foregroundHeld = false;
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
  if (modelId === "backend") return last?.role === "toolResult" ? text("后台实际成果") : tool("fixture_effect", {});
  const user = [...request.messages].reverse().find(message => message.role === "user");
  const input = user ? contentText(user.content) : "";
  if (last?.role === "toolResult") {
    if (last.toolName === "work_query_status" && /暂停|修订|取消/.test(input)) {
      const targets = JSON.parse(contentText(last.content));
      const selected = targets.find((item: { workId: string }) => input.includes(item.workId)) ?? targets[0];
      const name = input.includes("暂停") ? "work_pause" : input.includes("修订") ? "work_amend" : "work_cancel";
      return tool(name, { workId: selected.workId, versionGuard: selected.versionGuard, ...(name === "work_amend" ? { goalDescription: "新的业务要求" } : {}) });
    }
    return text(contentText(last.content));
  }
  if (input.startsWith("委托")) return tool("work_create", { title: input, criteria: [{ text: "核验实际成果" }] });
  if (/查询|暂停|修订|取消/.test(input)) return tool("work_query_status", {});
  if (input === "越权写文件") return tool("write", { path: join(cwd, "forbidden.txt"), content: "forbidden" });
  return text("前台普通答复");
};
models.registerProvider("fixture", { api: "openai-completions", apiKey: "fixture-only", baseUrl: "http://127.0.0.1:1",
  models: ["front", "backend"].map(id => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 2048,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
  streamSimple: (model, request, options) => {
    const stream = createAssistantMessageEventStream();
    if (model.id === "front" && holdForeground) {
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
    queueMicrotask(() => {
      try {
        const content = reply(model.id, request);
        const stopReason = content.some(block => block.type === "toolCall") ? "toolUse" : "stop";
        const message: AssistantMessage = { role: "assistant", content, stopReason, api: model.api, provider: model.provider, model: model.id,
          timestamp: Date.now(), usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
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
  instructions: () => "后台实际执行", defaultModel: () => "fixture/backend", toolMode: () => "native", toolAllowed: (_task, name) => name === "fixture_effect",
  mcpSelection: () => [], beforeSubmit: request => { const error = works.checkTaskInput(request.taskId, request.userMessageId); if (error) throw new Error(error); },
  tools: async task => ({ contextHooks: [], tools: [defineTool({ name: "fixture_effect", description: "实际计数文件", parameters: Type.Object({}), replay: "unsafe",
    execute: async () => { effects++; appendFileSync(join(cwd, "effects.txt"), `${task.id}\n`); await held; return { output: text("执行完成") }; } })] }),
  onSettled: () => { void adapter?.flush(); }, emit: () => {} });
const errors: unknown[] = [];
adapter = new WorkExecutionAdapter(works, native.workExecutionPort(), LOCAL_USER_ID, () => lease.isAuthority(), (_id, error) => errors.push(error));
const queue = new WorkDispatchQueue(db, works, adapter, () => lease.isAuthority(), () => "fixture/backend");
let foreground = new BotConversationService({ db: db.connection, userId: LOCAL_USER_ID, bots, works, models, directory: join(root, "foreground"),
  defaultModel: () => "fixture/front", isAuthority: () => lease.isAuthority(), memorySearch: () => [], schedule: (work, operationId) => queue.enqueue(work, operationId),
  wake: () => { void queue.flush(); } });
const send = async (requestId: string, value: string, selectedWorkId?: string) => {
  const request = { botId: DEFAULT_BOT_ID, requestId, text: value, selectedWorkId };
  const receipt = foreground.send(request);
  await wait(() => ["completed", "failed"].includes(foreground.messages.message(receipt.assistantMessageId)?.status ?? ""), value);
  assert.equal(foreground.messages.message(receipt.assistantMessageId)?.status, "completed", foreground.messages.message(receipt.assistantMessageId)?.error);
  return receipt;
};
try {
  const ordinary = await send("ordinary", "你好");
  assert.equal(foreground.messages.message(ordinary.assistantMessageId)?.text, "前台普通答复");
  assert.equal(db.listTasks().length, 0, "ordinary Bot conversation must not create Task");
  assert.equal(works.listWorks(LOCAL_USER_ID).length, 0);
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
  await send("delegate-b", "委托 B");
  await queue.flush();
  assert.equal(effects, 1, "shared mutable roots are serialized");
  const b = works.listWorks(LOCAL_USER_ID).find(work => work.workId !== a.workId)!;
  const bBinding = works.repo.listBindings(b.workId)[0]!;
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
  await queue.flush();
  releaseEffect(); held = Promise.resolve();
  await wait(async () => { await adapter.flush(); return works.repo.getBinding(aBinding.bindingId)?.status === "completed"
    && works.repo.getReservation(aBinding.reservationId!)?.state === "committed"; }, "native result and exact usage consumption");
  assert.equal(errors.length, 0, errors.map(String).join("\n"));
  assert.equal(effects, 1);
  assert.equal((await readFile(join(cwd, "effects.txt"), "utf8")).trim().split("\n").length, 1);
  assert.equal(works.repo.listDeliverables(a.workId).length, 1);
  assert.equal(works.getWork(a.workId)?.lifecycle, "active", "native completion is not acceptance");
  const version = works.getWork(a.workId)!.stateVersion;
  works.nativeResults.consume(); await adapter.flush();
  unwrap(works.reconcileExecution({ kind: "system", reason: "late-running" }, { bindingId: aBinding.bindingId, outcome: "running" }));
  assert.equal(works.getWork(a.workId)!.stateVersion, version);
  assert.equal(works.repo.getBinding(aBinding.bindingId)?.status, "completed");
  await send("amend-a", `修订 ${a.workId}`, a.workId);
  await wait(async () => { await queue.flush(); return effects === 2 && works.repo.listBindings(a.workId).filter(binding => binding.status === "completed").length === 2; }, "new input gets its own root");
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
    assert(delta.kind === "delta" && delta.events.some(event => event.kind === "remove" && event.workId === b.workId));
  }
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
  await Promise.all([foreground.cancel(DEFAULT_BOT_ID, "cancel-close-race"), foreground.close()]);
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
  await wait(() => foreground.messages.message(expired.assistantMessageId)?.status === "completed", "expired authorization remains queryable but cannot delegate");
  assert.equal(works.listWorks(LOCAL_USER_ID, { includeClosed: true }).length, beforeExpired);
  assert.match(foreground.messages.message(expired.assistantMessageId)?.text ?? "", /过期/);
  db.connection.prepare("UPDATE bots SET status='disabled' WHERE bot_id=?").run(DEFAULT_BOT_ID);
  assert.throws(() => foreground.send({ botId: DEFAULT_BOT_ID, requestId: "disabled-new", text: "委托 disabled" }));
  assert.equal(foreground.send({ botId: DEFAULT_BOT_ID, requestId: "after-normal-close", text: "重新打开后的下一条消息" }).replayed, true, "disabled Bot may still return an already accepted receipt");
  console.log("PASS Phase 2 real foreground/native root/control/inbox/projection chain; ordinary chat Task count=0; original+amended effects=2, one per input/root, numeric native IDs equal and namespaces isolated");
} finally {
  releaseEffect(); await foreground.close(); await queue.close(); await adapter.close(); await native.close(); lease.stop(); db.close(); await rm(root, { recursive: true, force: true });
}
