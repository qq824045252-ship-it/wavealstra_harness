import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { BotConversationRepository } from "../src/main/agent/work/BotConversationRepository";
import { projectBotReplySegments, completeBotReplySegments } from "../src/main/agent/work/BotReplySegments";
import type { ChatMessageDto } from "../src/shared/agent-ipc";

const row = (key: string, text: string, tools = false): ChatMessageDto => ({ id: `live-${key}`, presentationKey: key,
  role: "assistant", text, createdAt: 1, thinking: "private thought", ...(tools ? { tools: [{ id: `tool-${key}`, tool: "web_search",
    summary: "private arguments", output: "private output", status: "running" as const }] } : {}) });
let segments = projectBotReplySegments([row("first", "我来查")], [], 10);
assert.equal(segments.length, 1); assert.equal(segments[0].kind, "answer");
assert.deepEqual(segments[0], { id: "first", kind: "answer", text: "我来查", createdAt: 10, updatedAt: 10 });
segments = projectBotReplySegments([row("first", "我来查一下。", true)], segments, 20);
assert.equal(segments[0].kind, "commentary"); assert.equal(segments[0].createdAt, 10);
const unchanged = projectBotReplySegments([{ ...row("first", "我来查一下。", true), id: "committed-5" }], segments, 30);
assert.equal(unchanged[0], segments[0], "same generation across partial and committed replay keeps identity and timestamps");
assert(!JSON.stringify(segments).includes("private"), "only public text is projected");
segments = projectBotReplySegments([row("first", "我来查一下。", true), row("second", "结果是")], segments, 40);
segments = projectBotReplySegments([row("first", "我来查一下。", true), row("second", "结果是 42。")], segments, 50);
const complete = completeBotReplySegments(segments, "结果是 42。", "request", 60);
const receipt = { id: "receipt", kind: "receipt" as const, text: "收到，正在处理这条消息。", createdAt: 2, updatedAt: 2 };
assert.deepEqual(projectBotReplySegments([row("first", "我来查一下。", true)], [receipt], 20).map(segment => segment.kind), ["receipt", "commentary"]);
assert.equal(completeBotReplySegments([receipt], "直接答案。", "r".repeat(200)).at(-1)?.id, "final", "final ID is local to the message and valid for the longest accepted request ID");
assert.equal(complete.length, 2); assert.deepEqual(complete.map(part => part.text), ["我来查一下。", "结果是 42。"]);
assert.equal(complete[1].id, "second"); assert.equal(complete[1].createdAt, 40);
assert.deepEqual(completeBotReplySegments(complete, "结果是 42。", "request", 70), complete, "final receipt replay is idempotent");
const waiting = projectBotReplySegments([row("a", "我来核对。"), row("b", "")], [], 80);
assert.equal(waiting[0].kind, "commentary", "a silent next generation cannot hide the earlier prelude");
assert.equal(completeBotReplySegments(waiting, "核对完毕。", "request").length, 2, "final receipt before a text frame preserves prelude");
assert.equal(completeBotReplySegments(undefined, "直接答案。", "direct").length, 1, "quick direct answer does not manufacture a prelude");

const root = mkdtempSync(join(tmpdir(), "bot-segments-"));
let db = new AppDatabase(join(root, "app.db"));
try {
  new BotRegistry(db.connection).registerBot({ botId: "a", userId: "owner", displayName: "A" });
  let repo = new BotConversationRepository(db.connection);
  const a = repo.accept("owner", { botId: "a", requestId: "a", text: "查天气" });
  const b = repo.accept("owner", { botId: "a", requestId: "b", text: "直接回答" });
  assert.equal(repo.message(a.assistantMessageId)?.segments, undefined, "receipt is not a fabricated model acknowledgment");
  repo.update(a.assistantMessageId, "running", "我来查一下。", undefined, { tool: "web_search", status: "running" }, segments);
  const revision = repo.message(a.assistantMessageId)!.messageRevision!;
  repo.update(b.assistantMessageId, "completed", "直接答案。", undefined, undefined, completeBotReplySegments(undefined, "直接答案。", "b"));
  repo.update(a.assistantMessageId, "completed", "结果是 42。", undefined, undefined, complete);
  assert(repo.message(a.assistantMessageId)!.messageRevision! > revision);
  assert.deepEqual(repo.message(a.assistantMessageId)?.segments, complete);
  assert.equal(repo.message(b.assistantMessageId)?.segments?.length, 1, "concurrent requests remain isolated");
  db.close(); db = new AppDatabase(join(root, "app.db")); repo = new BotConversationRepository(db.connection);
  assert.deepEqual(repo.message(a.assistantMessageId)?.segments, complete, "process restart rehydrates durable public segments");
  assert.equal(repo.message(a.assistantMessageId)?.activity, undefined, "terminal completion clears running tool activity");
  const stopped = repo.accept("owner", { botId: "a", requestId: "stop", text: "停止测试" });
  repo.update(stopped.assistantMessageId, "running", "我来查一下。", undefined, undefined, [complete[0]]);
  repo.update(stopped.assistantMessageId, "cancelled", "我来查一下。");
  assert.deepEqual(repo.message(stopped.assistantMessageId)?.segments, [complete[0]], "cancel retains already visible text without inventing a final answer");
  db.connection.prepare("DELETE FROM bot_messages WHERE message_id=?").run(stopped.assistantMessageId);
  assert.equal((db.connection.prepare("SELECT COUNT(*) n FROM bot_message_segments WHERE message_id=?").get(stopped.assistantMessageId) as { n: number }).n, 0);
  console.log("PASS Bot reply segments: partial/commit identity, phase changes, final replay, public text only, persistence, concurrency, cancellation and deletion");
} finally { db.close(); rmSync(root, { recursive: true, force: true }); }
