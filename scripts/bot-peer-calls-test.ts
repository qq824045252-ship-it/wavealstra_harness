import { BotConversationMemory } from "../src/main/agent/work/BotConversationMemory";
import { MemoryService } from "../src/main/memory/MemoryService";
import { MemoryPipelineManager } from "../src/main/memory/MemoryPipelineManager";
import { botForegroundHistory, botPeerHistory, botPeerHistoryWindow } from "../src/main/agent/work/BotPeerContext";
import { BotConversationService } from "../src/main/agent/work/BotConversationService";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { BotConversationRepository } from "../src/main/agent/work/BotConversationRepository";
import { BotPeerCallService } from "../src/main/agent/work/BotPeerCallService";
import { DurableBotRuntime } from "../src/main/agent/durable/DurableBotRuntime";
import type { BotConversationServiceOptions } from "../src/main/agent/work/BotConversationService";
import { WorkService } from "../src/main/agent/work/WorkService";

const root = mkdtempSync(join(tmpdir(), "bot-peer-unit-"));
const app = new AppDatabase(join(root, "app.db"));
const db = app.connection, bots = new BotRegistry(db), works = new WorkService(db, { bots });
const messages = new BotConversationRepository(db);
const events: string[] = [];
const originalOpen = DurableBotRuntime.open;
const receivers: Array<{ options: Parameters<typeof DurableBotRuntime.open>[0]; resolve: (text: string) => void; reject: (error: Error) => void }> = [];
let service: BotPeerCallService;
try {
  for (const id of ["source", "target", "other"]) bots.registerBot({ botId: id, userId: "u", displayName: id });
  bots.registerBot({ botId: "paused", userId: "u", displayName: "paused", status: "paused" });
  bots.registerBot({ botId: "foreign", userId: "foreign-user", displayName: "foreign" });
  const make = (id: string) => messages.accept("u", { botId: "source", requestId: id, text: `user input ${id}` });
  const a = make("a"), b = make("b");
  const team = messages.accept("u", { botId: "source", teamId: "team-unit", requestId: "team", text: "team question" });
  let authority = true, memoryEnabled = true, searchValue = "fresh-L1-marker";
  const memoryContexts: unknown[][] = [];
  const recallCalls: Array<[string, string]> = [];
  const fact = (content: string) => ({ id: "m1", kind: "fact", title: "t", content, status: "active", scopes: [] });
  const options = { db, userId: "u", bots, works, directory: root,
    models: { getModel: () => ({ provider: "test", id: "model" }), getModels: () => [{ provider: "test", id: "model" }], getAvailable: async () => [{ provider: "test", id: "model" }] },
    memory: { enabled: () => memoryEnabled, context: (...args: unknown[]) => { memoryContexts.push(args); return "own Bot facts"; },
      recall: async (botId: string, query: string) => { recallCalls.push([botId, query]);
        return searchValue ? [{ memory: fact(searchValue), score: 1, reasons: ["lexical"] }] : []; },
      activeFact: (botId: string, id: string) => id === "m1" && searchValue && botId === "target" ? fact(searchValue) : undefined },
    defaultModel: () => "test/model", isAuthority: () => authority, memorySearch: () => [], schedule: () => {}, wake: () => {},
  } as unknown as BotConversationServiceOptions;
  const emptyRuntime = { assertSessionHealthy: () => {}, conversation: { id: "empty" },
    storage: { entry: async () => ({ entry: { model: [{ role: "assistant", stopReason: "stop", content: [] }] } }) },
    normalizeFailure: async (error: unknown) => { throw error; },
  } as unknown as DurableBotRuntime;
  const emptySubmission = { wait: async () => ({ status: "answered", type: "input", answer: 1 }) } as unknown as Parameters<DurableBotRuntime["reply"]>[0];
  assert.equal(await DurableBotRuntime.prototype.reply.call(emptyRuntime, emptySubmission), "任务已处理，但未产生文本回复。");
  await assert.rejects(DurableBotRuntime.prototype.reply.call(emptyRuntime, emptySubmission, { requireText: true }), /未产生文本回复/);
  service = new BotPeerCallService(options, messages, id => events.push(id));
  DurableBotRuntime.open = async options => {
    let resolve!: (text: string) => void;
    let reject!: (error: Error) => void;
    const reply = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
    receivers.push({ options, resolve, reject });
    return { conversation: { id: "unit", commit: async () => undefined }, configure: async () => {}, resume: () => {},
      submit: async () => ({}), reply: () => reply, abort: async () => resolve(""), close: async () => resolve("") } as unknown as DurableBotRuntime;
  };
  await assert.rejects(service.call(team.assistantMessageId, "privacy", "target", "private memory"), /团队会话/);
  await assert.rejects(service.call(a.assistantMessageId, "self", "source", "question"), /自己/);
  await assert.rejects(service.call(a.assistantMessageId, "foreign", "foreign", "question"), /当前用户/);
  assert.equal(messages.peerCalls.list(a.assistantMessageId).length, 0);
  const failed = await service.call(a.assistantMessageId, "paused", "paused", "question");
  assert.equal(failed.status, "failed"); assert.match(failed.error!, /暂停/); assert.equal(receivers.length, 0);
  const first = service.call(a.assistantMessageId, "op-a", "target", "request A");
  const duplicate = service.call(a.assistantMessageId, "op-a", "target", "request A");
  const second = service.call(b.assistantMessageId, "op-b", "other", "request B");
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(receivers.length, 2, "same tool replay does not create another model runtime");
  assert.notEqual(receivers[0].options.directory, receivers[1].options.directory);
  assert.equal(receivers[0].options.toolAllowed?.("bot_ask"), false, "no recursive loops");
  assert.equal(receivers[0].options.toolAllowed?.("write"), false, "recipient cannot write on forwarded authority");
  receivers[0].options.evidence?.([]);
  assert.deepEqual(memoryContexts.at(-1), ["target", ""], "peer context excludes personal conversation-only memory");
  const searchMessages = [{ role: "assistant", content: [{ type: "toolCall", id: "lookup", name: "memory_search", arguments: { query: "marker" } }] }] as unknown as Parameters<NonNullable<typeof receivers[0]["options"]["evidence"]>>[0];
  await receivers[0].options.toolHooks!.beforeTool!({ name: "memory_search", arguments: { query: "marker" } } as never, {} as never, {} as never);
  assert.deepEqual(recallCalls.at(-1), ["target", "marker"], "peer memory_search runs the hybrid recall for the receiving Bot only");
  assert(receivers[0].options.evidence?.(searchMessages).includes("fresh-L1-marker"));
  searchValue = "";
  assert(!receivers[0].options.evidence?.(searchMessages).includes("fresh-L1-marker"), "deleted L1 is withdrawn on next provider request");
  memoryEnabled = false;
  assert.equal(receivers[0].options.evidence?.(searchMessages), "", "disabled memory withdraws all fresh references");
  memoryEnabled = true;
  const historicalCalls = (period: string) => [{ role: "assistant", content: [{ type: "toolCall", id: "history-lookup", name: "history_read", arguments: { query: "学习记录", period } }] }] as unknown as Parameters<NonNullable<typeof receivers[0]["options"]["evidence"]>>[0];
  const yesterday = botPeerHistoryWindow(messages.peerCalls.list(a.assistantMessageId).at(-1)!.createdAt, "yesterday");
  const samples = [["before-day", yesterday.after - 100], ["yesterday-midnight", yesterday.after], ["today-midnight", yesterday.before]] as const;
  for (const [marker, at] of samples) {
    const sample = messages.accept("u", { botId: "target", requestId: marker, text: `课堂 ${marker}` });
    messages.update(sample.assistantMessageId, "completed", marker);
    db.prepare("UPDATE bot_messages SET created_at=?,updated_at=? WHERE request_id=?").run(at, at + 1, marker);
    db.prepare("INSERT INTO memory_turns(id,task_id,user_message_id,assistant_message_id,user_text,assistant_text,content_hash,captured_at,extraction_state) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(marker, sample.conversationId, sample.userMessageId, sample.assistantMessageId, `课堂 ${marker}`, marker, marker, at, "completed");
  }
  const yesterdayEvidence = receivers[0].options.evidence?.(historicalCalls("yesterday")) ?? "";
  assert(yesterdayEvidence.includes("yesterday-midnight"), "real recipient evidence reads yesterday from inclusive local midnight");
  assert(!yesterdayEvidence.includes("before-day") && !yesterdayEvidence.includes("today-midnight"), "yesterday neither leaks an earlier day nor substitutes today's learning");
  assert(receivers[0].options.evidence?.(historicalCalls("today")).includes("today-midnight"));
  assert(!receivers[0].options.evidence?.(historicalCalls("today")).includes("yesterday-midnight"));
  for (const [marker] of samples) {
    db.prepare("DELETE FROM memory_turns WHERE id=?").run(marker);
    db.prepare("DELETE FROM bot_messages WHERE request_id=?").run(marker);
  }
  assert(!receivers[0].options.evidence?.(historicalCalls("yesterday")).includes("yesterday-midnight"), "later provider reads withdraw deleted history");
  // Execute the real recipient adapter inside the actual peer evidence closure.
  const fixtureMemory = options.memory;
  const kernel = new MemoryService(app, { semantic: false });
  options.memory = new BotConversationMemory({ db: app, userId: "u", memory: kernel,
    pipeline: new MemoryPipelineManager(app), enabled: () => memoryEnabled, changed: () => {}, extract: async () => {} });
  const cached = kernel.create({ kind: "fact", title: "PeerRevocationTopic", content: "PEER_SCOPE_PRIVATE", scopeType: "bot", scopeId: "target", sourceType: "user" });
  kernel.repository.addScope({ memoryId: cached.id, scopeType: "bot", scopeId: "other", binding: "promoted", createdAt: Date.now() });
  await receivers[0].options.toolHooks!.beforeTool!({ name: "memory_search", arguments: { query: "PeerRevocationTopic" } } as never, {} as never, {} as never);
  assert(receivers[0].options.evidence?.(searchMessages).includes("PEER_SCOPE_PRIVATE"));
  kernel.detachScope(cached.id, "bot", "target");
  assert(kernel.get(cached.id), "other scope preserves the active record");
  assert(!receivers[0].options.evidence?.(searchMessages).includes("PEER_SCOPE_PRIVATE"), "scope detach withdraws prefetched peer evidence");
  const expiring = kernel.create({ kind: "fact", title: "PeerExpiryTopic", content: "PEER_EXPIRY_PRIVATE", scopeType: "bot", scopeId: "target", sourceType: "user" });
  await receivers[0].options.toolHooks!.beforeTool!({ name: "memory_search", arguments: { query: "PeerExpiryTopic" } } as never, {} as never, {} as never);
  assert(receivers[0].options.evidence?.(searchMessages).includes("PEER_EXPIRY_PRIVATE"));
  kernel.update({ id: expiring.id, validUntil: Date.now() - 1 });
  assert(!receivers[0].options.evidence?.(searchMessages).includes("PEER_EXPIRY_PRIVATE"), "expiry withdraws prefetched peer evidence");
  kernel.update({ id: expiring.id, validUntil: null, validFrom: Date.now() + 60_000 });
  assert(!receivers[0].options.evidence?.(searchMessages).includes("PEER_EXPIRY_PRIVATE"), "postponed validity withdraws peer evidence");
  options.memory = fixtureMemory;
  assert(receivers[0].options.instructions().includes('"target"'));
  receivers[1].resolve("B original answer");
  assert.equal((await second).replyText, "B original answer");
  assert.equal(messages.message(a.assistantMessageId)!.botCalls!.at(-1)!.status, "running");
  receivers[0].resolve("A original answer");
  assert.equal((await first).replyText, "A original answer");
  assert.deepEqual(await duplicate, await first);
  // A subsequent question must retain host exchange provenance, not just the owner's prose.
  const oldAnswer = messages.message(a.assistantMessageId)!;
  const projection = botForegroundHistory(oldAnswer);
  assert.equal(projection.botCalls?.at(-1)?.replyText, "A original answer");
  assert.equal(projection.botCalls?.[0].status, "failed");
  assert.deepEqual(botForegroundHistory({ ...oldAnswer, text: "我已联系其他 Bot", botCalls: undefined }).botCalls, [],
    "claims do not create communication evidence");
  assert.equal(botForegroundHistory({ ...oldAnswer, role: "user" }).botCalls, undefined,
    "user text cannot project host records");
  const bounded = botForegroundHistory({ ...oldAnswer, botCalls: Array.from({ length: 12 }, (_, i) => ({ ...oldAnswer.botCalls![1], callId: String(i), replyText: "x".repeat(5000) })) });
  assert.equal(bounded.botCalls?.length, 8); assert.equal(bounded.botCallsOmitted, 4);
  assert.equal(bounded.botCalls?.[0].replyText?.length, 4000); assert.equal(bounded.botCalls?.[0].truncated, true);
  const foreground = new BotConversationService(options);
  const ordinary = messages.accept("u", { botId: "other", requestId: "no-peer-ordinary", text: "ordinary question" });
  messages.update(ordinary.assistantMessageId, "completed", "ordinary answer");
  const ordinaryFollow = messages.accept("u", { botId: "other", requestId: "no-peer-followup", text: "ordinary follow-up" });
  const ordinarySnapshot = JSON.parse((foreground as unknown as { requestRun: (conversation: unknown, message: unknown) => { context_json: string } })
    .requestRun(messages.conversation("u", "other", ordinaryFollow.conversationId)!, messages.message(ordinaryFollow.assistantMessageId)!).context_json);
  assert.equal(ordinarySnapshot.peerHistory, undefined, "ordinary history adds no empty peer context or native system-prefix rebuild");
  const follow = make("context-followup");
  const snapshot = (foreground as unknown as { requestRun: (conversation: unknown, message: unknown) => { context_json: string } })
    .requestRun(messages.conversation("u", "source", follow.conversationId)!, messages.message(follow.assistantMessageId)!);
  const frozen = JSON.parse(snapshot.context_json);
  assert.equal(frozen.history.find((item: { messageId: string }) => item.messageId === a.assistantMessageId)?.botCalls.at(-1).replyText,
    "A original answer", "real service snapshot preserves original recipient evidence for follow-up");
  assert.equal(frozen.peerHistory.calls.find((call: { callId: string }) => call.callId === oldAnswer.botCalls![1].callId)?.replyText, "A original answer");
  messages.update(follow.assistantMessageId, "completed", "historical summary");
  db.prepare("UPDATE bot_request_runs SET transcript_json='[]',context_json=? WHERE message_id=?")
    .run(JSON.stringify({ ...frozen, coveredMessageIds: [a.userMessageId,a.assistantMessageId,b.userMessageId,b.assistantMessageId,follow.userMessageId,follow.assistantMessageId] }), follow.assistantMessageId);
  messages.update(a.assistantMessageId, "completed", "旧摘要不能代替对方原文");
  const compactedFollow = make("covered-followup");
  const compacted = JSON.parse((foreground as unknown as { requestRun: (conversation: unknown, message: unknown) => { context_json: string } })
    .requestRun(messages.conversation("u", "source", compactedFollow.conversationId)!, messages.message(compactedFollow.assistantMessageId)!).context_json);
  assert(!compacted.history.some((item: { messageId: string }) => item.messageId === a.assistantMessageId), "native coverage still avoids duplicate transcript text");
  assert(compacted.peerHistory.calls.some((call: { replyText: string }) => call.replyText === "A original answer"), "host peer receipts survive native coverage and compaction");
  const peerBound = botPeerHistory([{ ...oldAnswer, botCalls: Array.from({ length: 20 }, (_, i) => ({ ...oldAnswer.botCalls![1], callId: String(i), replyText: "x".repeat(5000) })) }]);
  assert.equal(peerBound.calls.length,8); assert.equal(peerBound.omittedCalls,12); assert.equal(peerBound.calls[0].replyText?.length,2000);
  // Original replay tests exercise a still-active request, not the completed fixture above.
  messages.update(a.assistantMessageId, "running", "");
  const previousTimezone = process.env.TZ;
  try {
    process.env.TZ = "Asia/Shanghai";
    assert.deepEqual(botPeerHistoryWindow(Date.parse("2026-11-12T01:04:00Z"), "yesterday"),
      { after: Date.parse("2026-11-10T16:00:00Z"), before: Date.parse("2026-11-11T16:00:00Z") });
    assert.equal(botPeerHistoryWindow(Date.parse("2026-11-12T01:04:00Z"), "today").before, Date.parse("2026-11-12T01:04:00Z"));
    process.env.TZ = "America/New_York";
    const autumn = botPeerHistoryWindow(Date.parse("2026-11-02T17:00:00Z"), "yesterday");
    assert.equal(autumn.before - autumn.after, 25 * 3600000, "fall-back day is not silently truncated");
    const spring = botPeerHistoryWindow(Date.parse("2026-03-09T17:00:00Z"), "yesterday");
    assert.equal(spring.before - spring.after, 23 * 3600000, "spring day does not include the previous day");
  } finally { if (previousTimezone === undefined) delete process.env.TZ; else process.env.TZ = previousTimezone; }
  const before = receivers.length;
  assert.equal((await service.call(a.assistantMessageId, "op-a", "target", "request A")).status, "completed");
  assert.equal(receivers.length, before, "terminal replay reads receipt without recontacting");
  await assert.rejects(service.call(a.assistantMessageId, "op-a", "other", "changed"), /不能换/);
  assert.equal(messages.history("u", { botId: "target" }).messages.length, 0, "forwarded questions never impersonate the user in target inbox");
  const c = make("c");
  const cancel = service.call(c.assistantMessageId, "cancel", "target", "cancel me");
  await new Promise(resolve => setTimeout(resolve, 20));
  await service.cancel(c.assistantMessageId);
  assert.equal((await cancel).status, "cancelled");
  const revision = messages.message(c.assistantMessageId)!.messageRevision!;
  assert(revision > 1, "call updates bump message revision for reconnect ordering");
  const paused = make("paused-during-call");
  const pausedCall = service.call(paused.assistantMessageId, "pausing", "target", "in flight pause");
  await new Promise(resolve => setTimeout(resolve, 20));
  db.prepare("UPDATE bots SET status='paused' WHERE bot_id='target'").run();
  receivers.at(-1)!.resolve("late reply must not become completed");
  assert.equal((await pausedCall).status, "failed", "recipient pause settles rather than leaves permanent running");
  db.prepare("UPDATE bots SET status='active' WHERE bot_id='target'").run();
  const lost = make("authority-loss");
  const lostCall = service.call(lost.assistantMessageId, "loss", "target", "authority test");
  await new Promise(resolve => setTimeout(resolve, 20));
  authority = false; receivers.at(-1)!.reject(new Error("host authority lost before provider request"));
  assert.equal((await lostCall).status, "unknown", "authority loss is recoverable even when provider guard rejects");
  authority = true;
  const resumed = service.call(lost.assistantMessageId, "loss", "target", "authority test");
  await new Promise(resolve => setTimeout(resolve, 20));
  receivers.at(-1)!.resolve("recovered answer");
  assert.equal((await resumed).status, "completed");
  const d = make("d");
  const interrupted = service.call(d.assistantMessageId, "close", "target", "in flight");
  await new Promise(resolve => setTimeout(resolve, 20));
  await service.close();
  assert.equal((await interrupted).status, "unknown", "host interruption is not fabricated completion or permanent failure");
  assert.equal(messages.message(a.assistantMessageId)!.botCalls![1].replyText, "A original answer");
  assert.equal(messages.message(b.assistantMessageId)!.botCalls![0].replyText, "B original answer");
  assert(events.includes(a.assistantMessageId) && events.includes(b.assistantMessageId));
  console.log("PASS Bot peer-call scope, actual recipient identity, idempotency, parallel isolation, pause/failure, cancellation, recovery and durable UI projection");
} finally {
  DurableBotRuntime.open = originalOpen;
  app.close(); rmSync(root, { recursive: true, force: true });
}
