import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { mkdirSync, writeFileSync } from "node:fs";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { botHistoryContext } from "../src/main/agent/work/BotHistoryContext";
import { LOCAL_USER_ID } from "../src/shared/bot-work";

/**
 * Issue #28 recall benchmark: a large synthetic store proves that relevance-first
 * retrieval still finds a buried pair, and records the per-turn cost of the bounded
 * candidate query. Method-level only; it makes no model call and proves nothing about
 * a live assistant turn.
 */
const pairs = Number(process.argv.find(arg => arg.startsWith("--pairs="))?.split("=")[1] ?? 30000);
const conversations = 200;
const app = new AppDatabase(":memory:");
const db = app.connection;
try {
  new BotRegistry(db).registerBot({ botId: "bench", userId: LOCAL_USER_ID, displayName: "bench" });
  const now = Date.now();
  const insertConversation = db.prepare("INSERT INTO bot_conversations(conversation_id,bot_id,user_id,created_at,updated_at,archived_at) VALUES (?,?,?,?,?,?)");
  const insertMessage = db.prepare(`INSERT INTO bot_messages(message_id,conversation_id,bot_id,request_id,role,text,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'completed',?,?)`);
  const insertReceipt = db.prepare(`INSERT INTO bot_send_receipts(user_id,bot_id,request_id,payload_hash,conversation_id,user_message_id,assistant_message_id)
    VALUES (?,?,?,?,?,?,?)`);
  const insertTurn = db.prepare("INSERT INTO memory_turns(id,task_id,user_message_id,assistant_message_id,user_text,assistant_text,content_hash,captured_at) VALUES (?,?,?,?,?,?,?,?)");
  const filler = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ";
  let buried = { userMessageId: "", conversationId: "" };
  db.transaction(() => {
    for (let c = 0; c < conversations; c++) insertConversation.run(`bench-c${c}`, "bench", LOCAL_USER_ID, now, now, now);
    for (let i = 0; i < pairs; i++) {
      const conversation = `bench-c${i % conversations}`;
      const userMessageId = `bench-u${i}`, assistantMessageId = `bench-a${i}`, requestId = `bench-r${i}`;
      // One old, specific decision sits below every later pair in the same scope.
      const userText = i === 3 ? "历史方案：NSH 的 MTLS 灰度回滚演练按第 812 号记录执行"
        : `日常讨论 ${i}：${filler}${i % 17 === 0 ? "预算 评审" : ""}`;
      const assistantText = i === 3 ? "历史结论：第 812 号记录的 MTLS 灰度回滚演练采用 NSH 方案" : `回答 ${i}：${filler}`;
      const at = now - (pairs - i) * 60_000;
      insertMessage.run(userMessageId, conversation, "bench", requestId, "user", userText, at, at);
      insertMessage.run(assistantMessageId, conversation, "bench", requestId, "assistant", assistantText, at + 1, at + 1);
      insertReceipt.run(LOCAL_USER_ID, "bench", requestId, "hash", conversation, userMessageId, assistantMessageId);
      insertTurn.run(`bench-t${i}`, conversation, userMessageId, assistantMessageId, "", "", `hash${i}`, at);
      if (i === 3) buried = { userMessageId, conversationId: conversation };
    }
  })();
  const recall = (query: string, mode?: "related" | "recent") => botHistoryContext(db, {
    userId: LOCAL_USER_ID, botId: "bench", query, before: now, ...(mode ? { mode, after: now - 86_400_000 } : {}),
  });
  const found = recall("历史方案 NSH 的 MTLS 灰度回滚演练第 812 号记录");
  assert(found.includes(buried.userMessageId) && found.includes(buried.conversationId), "buried pair must be retrievable by relevance");
  const noisy = recall("日常讨论 预算 评审");
  assert(noisy.includes("historical_conversation"));
  const recent = recall("今天学到什么", "recent");
  assert(recent.includes("有界近期问答样本"));
  const unrelated = recall("量子化学 分子轨道");
  assert.equal(unrelated, "", "unrelated query returns no history");

  const measure = (fn: () => unknown) => {
    for (let i = 0; i < 3; i++) fn();
    const samples: number[] = [];
    for (let i = 0; i < 15; i++) {
      const start = performance.now(); fn(); samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    return { medianMs: Number(samples[7].toFixed(2)), p95Ms: Number(samples[14].toFixed(2)) };
  };
  const results = {
    pairs, conversations, relevance: measure(() => recall("历史方案 NSH 的 MTLS 灰度回滚演练第 812 号记录")),
    noisy: measure(() => recall("日常讨论 预算 评审")), recent: measure(() => recall("今天学到什么", "recent")),
    missed: measure(() => recall("量子化学 分子轨道")),
    buriedPairFound: found.includes(buried.userMessageId), outputChars: found.length,
  };
  console.log(JSON.stringify(results, null, 2));
  mkdirSync("out/diagnostics", { recursive: true });
  writeFileSync("out/diagnostics/perf-bot-history-recall.json", JSON.stringify({ generatedAt: new Date().toISOString(), ...results }, null, 2));
} finally { app.close(); }
