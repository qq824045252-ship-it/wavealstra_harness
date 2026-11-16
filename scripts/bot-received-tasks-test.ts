import assert from "node:assert/strict";
import type { BotCollaborationDto, BotIncomingMessage } from "../src/shared/bot-collaboration";
import type { BotMessageDto } from "../src/shared/bot-conversation";
import { botReceivedTasks } from "../src/renderer/src/lib/botReceivedTasks";

const coll = (overrides: Partial<BotCollaborationDto> = {}): BotCollaborationDto => ({
  collaborationId: "c", userId: "u", sourceBotId: "source", sourceDisplayName: "Source",
  sourceConversationId: "source-chat", sourceRequestId: "request", sourceUserMessageId: "user", sourceAssistantMessageId: "assistant",
  targetBotId: "target", targetDisplayName: "Target", workId: "w", createdAt: 10, updatedAt: 20, messageCount: 1,
  status: "accepted", times: { sentAt: 10, deliveredAt: null, acceptedAt: null, startedAt: null, endedAt: null, returningAt: null, returnedAt: null }, originAvailable: true, ...overrides,
});
const row = (c = coll(), id = "journal"): BotIncomingMessage => ({ collaboration: c, cursor: id,
  message: { messageId: id, collaborationId: c.collaborationId, ordinal: 1, senderBotId: c.sourceBotId, senderDisplayName: "Source", kind: "request", text: "Public requirement", createdAt: 10, operationId: id, exchangeId: "exchange" },
});
const msg = (overrides: Partial<BotMessageDto> = {}): BotMessageDto => ({ messageId: "m", conversationId: "target-chat", botId: "target", requestId: "r", ordinal: 1, role: "assistant", text: "Answer", status: "completed", workIds: ["w"], createdAt: 20, updatedAt: 20, ...overrides });
const peer: NonNullable<BotMessageDto["peerOrigin"]> = { kind: "request", collaborationId: "c", exchangeId: "exchange", senderBotId: "source", senderDisplayName: "Source", sourceBotId: "source", sourceConversationId: "later-source-chat", sourceRequestId: "r2", sourceUserMessageId: "u2", sourceAssistantMessageId: "a2" };
let cases = 0;
function check(fn: () => void) { fn(); cases++; }
check(() => { const p = botReceivedTasks([row()], [msg()], "target"); assert.equal(p.boards[0].messages.length, 1); assert.ok(p.absorbed.has("m")); });
check(() => { assert.equal(botReceivedTasks([row()], [], "source").boards.length, 0); });
check(() => { const r = row(); r.message.collaborationId = "other"; assert.equal(botReceivedTasks([r], [], "target").boards.length, 0); });
check(() => { const r = row(); r.message.senderBotId = "stranger"; assert.equal(botReceivedTasks([r], [], "target").boards.length, 0); });
check(() => { const p = botReceivedTasks([row(coll({ workId: null }))], [msg({ peerOrigin: peer, workIds: [] })], "target"); assert.equal(p.boards.length, 0); assert.equal(p.absorbed.size, 0); });
check(() => { const p = botReceivedTasks([row()], [msg({ role: "user", peerOrigin: peer, text: "INTERNAL CONTEXT" })], "target"); assert.ok(p.absorbed.has("m")); assert.deepEqual(p.boards[0].messages, []); assert.ok(!JSON.stringify(p.boards).includes("INTERNAL CONTEXT")); });
check(() => { const p = botReceivedTasks([row()], [msg({ role: "user" })], "target"); assert.equal(p.absorbed.size, 0); });
check(() => { const p = botReceivedTasks([row()], [msg({ role: "user", peerOrigin: { ...peer, exchangeId: "missing" } })], "target"); assert.equal(p.absorbed.size, 0); });
check(() => { assert.equal(botReceivedTasks([row()], [msg({ peerOrigin: { ...peer, kind: "return", replyMessageId: "reply" } })], "target").absorbed.size, 0); });
check(() => { assert.equal(botReceivedTasks([row()], [msg({ peerOrigin: { ...peer, senderBotId: "stranger" } })], "target").absorbed.size, 0); });
check(() => { assert.equal(botReceivedTasks([row()], [msg({ peerOrigin: { ...peer, sourceBotId: "stranger" } })], "target").absorbed.size, 0); });
check(() => { assert.equal(botReceivedTasks([row()], [msg({ botId: "other" }), msg({ messageId: "team", teamId: "team" })], "target").absorbed.size, 0); });
check(() => { assert.equal(botReceivedTasks([row()], [msg({ workIds: ["w", "w2"], peerOrigin: peer })], "target").absorbed.size, 0); });
check(() => { const p = botReceivedTasks([row(), row(coll({ collaborationId: "c2" }))], [msg()], "target"); assert.equal(p.boards.length, 2); assert.equal(p.absorbed.size, 0); });
check(() => { const p = botReceivedTasks([row(), row(coll({ collaborationId: "c2" }))], [msg({ peerOrigin: peer })], "target"); assert.equal(p.boards[0].messages.length, 1); assert.equal(p.boards[1].messages.length, 0); });
check(() => { const r = row(); r.summary = { text: "Independent summary", status: "completed", senderBotId: "source", senderDisplayName: "Source" }; const p = botReceivedTasks([r], [msg({ peerOrigin: peer })], "target"); assert.equal(p.boards[0].rows[0].summary?.text, "Independent summary"); });
check(() => { const before = botReceivedTasks([row(coll({ workId: null }))], [], "target"); const after = botReceivedTasks([row(coll({ workId: "w" }))], [], "target"); assert.equal(before.boards.length, 0); assert.equal(after.boards[0].collaboration.workId, "w"); });
check(() => { const a = row(coll({ collaborationId: "a" })); const b = row(coll({ collaborationId: "b" })); a.message.ordinal = 100; b.message.ordinal = 1; const p = botReceivedTasks([b, a], [], "target"); assert.deepEqual(p.boards.map(b => b.collaboration.collaborationId), ["a", "b"]); });
check(() => { const older = row(coll({ workId: null, updatedAt: 10 }), "old"); const newer = row(); const p = botReceivedTasks([newer, older], [msg()], "target"); assert.equal(p.boards[0].collaboration.workId, "w"); assert.ok(p.absorbed.has("m")); assert.equal(p.boards[0].rows.length, 2); });
check(() => { const m = msg(); const p = botReceivedTasks([row()], [m, m], "target"); assert.equal(p.boards[0].messages.length, 1); });
check(() => { const r = row(); const m = msg(); const input = JSON.stringify([r, m]); botReceivedTasks([r], [m], "target"); assert.equal(JSON.stringify([r, m]), input); });
check(() => { const p = botReceivedTasks([row()], [msg({ workIds: [], text: "same title" })], "target"); assert.equal(p.absorbed.size, 0); });
check(() => { const p = botReceivedTasks([row()], [msg({ workIds: ["different"], peerOrigin: peer })], "target"); assert.equal(p.absorbed.size, 0); });
check(() => {
  const anchor = msg({ messageId: "anchor", peerOrigin: peer });
  const continuation = msg({ messageId: "continuation", ordinal: 2, workIds: [], referenceMessageId: "anchor" });
  const foreign = { ...continuation, messageId: "foreign", conversationId: "other-chat" };
  const p = botReceivedTasks([row()], [anchor, continuation, foreign], "target");
  assert.deepEqual(p.boards[0].messages.map(m => m.messageId), ["anchor", "continuation"]);
  assert.ok(!p.absorbed.has("foreign"));
});
console.log(`bot-received-tasks: ${cases} cases passed`);
