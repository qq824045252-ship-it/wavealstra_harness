import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { BotConversationRepository } from "../src/main/agent/work/BotConversationRepository";
import { BotConversationMemory } from "../src/main/agent/work/BotConversationMemory";
import { MemoryService } from "../src/main/memory/MemoryService";
import { MemoryPipelineManager } from "../src/main/memory/MemoryPipelineManager";
import { LOCAL_USER_ID } from "../src/shared/bot-work";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { MemoryScopeType } from "../src/shared/memory-kernel";
const root = mkdtempSync(join(tmpdir(), "memory-forget-watermark-"));
const file = join(root, "app.db");
let db = new AppDatabase(file);
let sequence = 0;
const pause = () => new Promise(resolve => setTimeout(resolve, 3));
function services() {
  const memory = new MemoryService(db, { semantic: false });
  const pipeline = new MemoryPipelineManager(db);
  const messages = new BotConversationRepository(db.connection);
  const bridge = new BotConversationMemory({ db, userId: LOCAL_USER_ID, memory, pipeline, enabled: () => true,
    extract: async () => {}, changed: () => {} });
  return { memory, pipeline, messages, bridge };
}
async function extract(s: ReturnType<typeof services>, conversationId: string, text: string, kind: MemoryScopeType) {
  const sourceTurns = s.pipeline.turns.listPending(conversationId, 50);
  const modelRuntime = { completeSimple: async () => ({ content: [{ type: "text", text: JSON.stringify({ candidates: [{
    kind: "preference", title: text, content: text, userEvidence: text, retention: kind === "conversation" ? "temporary" : "stable",
    sensitivity: "none", confidence: 1, importance: 1, explicit: true, operationHint: "create", scopeType: kind,
  }] }) }], stopReason: "stop" }) } as unknown as ModelRuntime;
  return s.memory.extractAndStore({ taskId: conversationId, userText: "", assistantText: "", sourceTurns,
    modelRuntime, model: { maxTokens: 4096 } as never, isEnabled: () => true });
}
try {
  const bots = new BotRegistry(db.connection);
  bots.registerBot({ userId: LOCAL_USER_ID, botId: "owner", displayName: "owner" });
  db.connection.exec(`CREATE TABLE IF NOT EXISTS work_team_templates(template_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,deleted_at INTEGER);
    INSERT INTO work_team_templates(template_id,user_id) VALUES ('team-watermark','${LOCAL_USER_ID}');`);
  for (const kind of ["bot", "team", "conversation", "global"] as const) {
    let s = services();
    const text = `待遗忘旧偏好${kind}`;
    const wording = kind === "global" ? `所有 Bot 记住${text}` : kind === "conversation" ? `仅本次对话记住${text}` : `记住${text}`;
    const receipt = s.messages.accept(LOCAL_USER_ID, { botId: "owner", teamId: kind === "team" ? "team-watermark" : undefined, requestId: `r-${++sequence}`, text: wording });
    const scopeId = kind === "bot" ? "owner" : kind === "team" ? "team-watermark" : kind === "conversation" ? receipt.conversationId : undefined;
    const atom = s.memory.create({ scopeType: kind, scopeId, kind: "preference", title: text, content: text, sourceType: "user",
      metadata: kind === "global" ? { publicShared: true } : undefined });
    // Already queued source, plus an older in-flight source captured only after forget.
    s.messages.update(receipt.assistantMessageId, "completed", "收到");
    s.bridge.capture("owner", receipt.requestId);
    const late = s.messages.accept(LOCAL_USER_ID, { botId: "owner", teamId: kind === "team" ? "team-watermark" : undefined, requestId: `r-${++sequence}`, text: wording });
    await pause();
    s.memory.detachScope(atom.id, kind, scopeId);
    const untouched = s.memory.create({ scopeType: "bot", scopeId: "owner", kind: "fact", title: `无关${kind}`, content: "无关已存事实", sourceType: "user" });
    db.close(); db = new AppDatabase(file); s = services();
    assert.equal(s.memory.get(atom.id), undefined);
    assert(s.memory.get(untouched.id), "unrelated existing facts survive");
    let result = await extract(s, receipt.conversationId, text, kind);
    assert.equal(result.committedCount, 0, `${kind}: queued source cannot revive after normal DB reopen`);
    s.messages.update(late.assistantMessageId, "completed", "迟到完成"); s.bridge.capture("owner", late.requestId);
    result = await extract(s, receipt.conversationId, text, kind);
    assert.equal(result.committedCount, 0, `${kind}: late capture uses original user time, not completion time`);
    assert(s.messages.message(receipt.userMessageId)?.text.includes(text), "original user history is preserved");
    await pause();
    const fresh = s.messages.accept(LOCAL_USER_ID, { botId: "owner", teamId: kind === "team" ? "team-watermark" : undefined, requestId: `r-${++sequence}`, text: wording });
    s.messages.update(fresh.assistantMessageId, "completed", "重新记住"); s.bridge.capture("owner", fresh.requestId);
    result = await extract(s, fresh.conversationId, text, kind);
    assert.equal(result.committedCount, 1, `${kind}: a new user statement can relearn after forgetting`);
  }
  let s = services();
  const old = s.messages.accept(LOCAL_USER_ID, { botId: "owner", requestId: `r-${++sequence}`, text: "记住无记录旧偏好" });
  await pause();
  const forget = s.messages.accept(LOCAL_USER_ID, { botId: "owner", requestId: `r-${++sequence}`, text: "忘记并删除我的旧偏好记忆。" });
  s.messages.update(forget.assistantMessageId, "completed", "没有已存记录"); s.bridge.capture("owner", forget.requestId);
  db.close(); db = new AppDatabase(file); s = services();
  s.messages.update(old.assistantMessageId, "completed", "迟到记住"); s.bridge.capture("owner", old.requestId);
  assert.equal((await extract(s, old.conversationId, "无记录旧偏好", "bot")).committedCount, 0, "no-record pure forget still defeats late old extraction after restart");
  await pause();
  const oldAtom = s.memory.create({ scopeType: "bot", scopeId: "owner", kind: "preference", title: "旧偏好", content: "旧偏好", sourceType: "user" });
  const mixed = s.messages.accept(LOCAL_USER_ID, { botId: "owner", requestId: `r-${++sequence}`, text: "忘记旧偏好、记住新的称呼是晴川。" });
  const mixedUser = s.messages.message(mixed.userMessageId)!;
  s.bridge.forget("owner", [oldAtom.id], mixedUser.text, "忘记旧偏好", mixed.conversationId,
    { createdAt: mixedUser.createdAt, messageId: mixedUser.messageId });
  s.messages.update(mixed.assistantMessageId, "completed", "已更新"); s.bridge.capture("owner", mixed.requestId);
  db.close(); db = new AppDatabase(file); s = services();
  assert.equal((await extract(s, mixed.conversationId, "新的称呼是晴川", "bot")).committedCount, 1,
    "the exact forget source can also explicitly remember B after restart; older sources stay excluded");
  const multi = s.memory.create({ scopeType: "bot", scopeId: "owner", kind: "fact", title: "共享绑定事实", content: "无关团队事实", sourceType: "user" });
  s.memory.promote(multi.id, "team", "team-watermark");
  const teamCutoff = db.connection.prepare("SELECT cutoff_at FROM memory_forget_watermarks WHERE scope_type='team'").get();
  s.memory.detachScope(multi.id, "bot", "owner");
  assert(s.memory.get(multi.id)?.scopes.some(scope => scope.scopeType === "team"));
  assert.deepEqual(db.connection.prepare("SELECT cutoff_at FROM memory_forget_watermarks WHERE scope_type='team'").get(), teamCutoff,
    "detaching Bot scope never advances another owner's scope watermark");
  const rows = db.connection.prepare("SELECT * FROM memory_forget_watermarks").all();
  assert(rows.length >= 4);
  assert(!JSON.stringify(rows).includes("偏好"), "watermarks contain scope identity and time only, never forgotten plaintext");
  assert.deepEqual(db.connection.pragma("foreign_key_check"), []);
  console.log("PASS persistent forget watermarks: four exact scopes, queued and delayed L0, normal DB reopen, original history intact, fresh relearning, no-record forget");
} finally { db.close(); rmSync(root, { recursive: true, force: true }); }
