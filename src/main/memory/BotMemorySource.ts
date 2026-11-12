import type { AppDatabase } from "../db/AppDatabase";
import { LOCAL_USER_ID } from "../../shared/bot-work";
import { hasSensitiveMemoryContent } from "./MemoryTextSafety";
import { MemoryInstructionDocument, memoryRememberClause } from "./MemoryIntent";

export function botWorkHasSharedOrigin(db: AppDatabase, workId: string): boolean {
  if (!db.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bot_turn_origins'").get()) return false;
  const origin = db.connection.prepare(`SELECT json_extract(o.origin_json,'$.audience') audience FROM works w
    JOIN bot_turn_origins o ON o.user_message_id=w.source_message_id AND o.user_id=w.user_id WHERE w.work_id=?`)
    .get(workId) as { audience: string } | undefined;
  if (origin) return origin.audience !== "private";
  // An old/deleted Gateway source has no proof of a private audience. Do not
  // introduce personal Bot memory into an execution whose origin is unknown.
  return Boolean(db.connection.prepare(`SELECT 1 FROM works w JOIN gateway_work_targets t
    ON t.user_id=w.user_id AND t.source_message_id=w.source_message_id WHERE w.work_id=?`).get(workId));
}

/** A foreground conversation is a real memory source, never a fabricated Task row. */
export function botMemorySource(db: AppDatabase, conversationId: string, userId = LOCAL_USER_ID) {
  const source = db.connection.prepare(`SELECT c.conversation_id,c.bot_id,c.team_id,c.user_id,b.status
    FROM bot_conversations c JOIN bots b ON b.bot_id=c.bot_id AND b.user_id=c.user_id
    WHERE c.conversation_id=? AND c.user_id=?`).get(conversationId, userId) as {
      conversation_id: string; bot_id: string; team_id: string | null; user_id: string; status: string;
    } | undefined;
  if (!source) return;
  const origins = db.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bot_gateway_conversations'").get();
  const shared = Boolean(origins && db.connection.prepare("SELECT 1 FROM bot_gateway_conversations WHERE conversation_id=? AND audience='shared'").get(conversationId));
  return { ...source, shared };
}

/** One conservative scope boundary for direct writes, extraction, forgetting and
 * historical references. A wording variant must never promote a temporary fact. */
export function botMemoryConversationOnly(text: string): boolean {
  const wording = text.replace(/\bnot\s+only\b/gi, "notexclusive");
  const conversation = "(?:本(?:次|轮)?|这(?:次|轮|个)?|当前|此(?:次|轮)?)(?:对话|会话|聊天)";
  return new RegExp(`(?<!不)(?:仅|只)(?:限)?(?:于|在|对|用于)?${conversation}|${conversation}(?:中|内|里)?(?:有效|适用)(?:而已|即可|就好)|(?:有效期|适用范围)(?:仅限|为|是)?${conversation}`).test(wording)
    || /\b(?:only\s+(?:for\s+|in\s+|within\s+)?(?:this|the current)\s+(?:conversation|chat|session)|(?:for\s+|in\s+)?(?:this|the current)\s+(?:conversation|chat|session)\s+only)\b/i.test(wording)
    || /(?:不要|不得|不能|不许|别)(?:再|继续)?(?:在|带到|用于|延续到|应用于)?(?:新的?|其他|下次|后续)(?:对话|会话|聊天)|不跨(?:对话|会话|聊天)|(?:新的?|下次|后续)(?:对话|会话|聊天)(?:中|内|里)?(?:不要|不得|不能|不再|不应)(?:再|继续)?(?:使用|保留|记住|应用)/.test(wording)
    || /\b(?:do not|don't|never)\s+(?:carry|share|reuse|retain|remember)\b.{0,48}\b(?:other|future|new)\s+(?:chats?|conversations?|sessions?)\b/i.test(wording);
}

/** Explicit "do not keep this" wording. Kept separate from secret syntax so a
 * technical discussion can be captured while a real opt-out still wins. */
const BOT_MEMORY_OPT_OUT = /不要(?:记住|记录|保存|存储)|(?<!分)别(?:记住|保存)|do not (?:remember|store|save)|don.t (?:remember|store|save)/i;

/** Shared opt-out wording: the adverb "分别" is not the prohibition "别". */
export function botMemoryOptedOut(text: string): boolean { return BOT_MEMORY_OPT_OUT.test(text); }

/** Conservative capture boundary: never copy secrets or one-off private details into memory evidence. */
export function botMemoryTextEligible(text: string): boolean {
  if (!text.trim() || botMemoryOptedOut(text)) return false;
  return !hasSensitiveMemoryContent(text);
}

/** Forget is a deletion request, not a new negative preference. Mixed requests may
 * write only the independently quoted, explicitly new remember clause. */
export function botMemoryWriteEvidenceAllowed(userText: string, evidence: string): boolean {
  const document = MemoryInstructionDocument.parse(userText);
  if (!document.allowsEvidence(evidence)) return false;
  const removals = document.removalIntents();
  if (!removals.some(intent => intent.kind === "forget")) return true;
  return document.clauses.some(clause => clause.kind === "user" && clause.text.includes(evidence.trim())
    && !removals.some(intent => intent.clause === clause.text) && memoryRememberClause(clause.text));
}

/** Resolve a single real input to its Work, never from candidate text or a model-selected ID. */
export function botMemoryWorkForSource(db: AppDatabase, conversationId: string, userMessageId: string, userId = LOCAL_USER_ID): string | undefined {
  const source = db.connection.prepare(`SELECT 1 FROM bot_send_receipts r JOIN bot_messages m ON m.message_id=r.user_message_id
    JOIN bot_conversations c ON c.conversation_id=r.conversation_id AND c.user_id=r.user_id
    WHERE r.user_id=? AND r.conversation_id=? AND r.user_message_id=? AND m.role='user'
      AND m.conversation_id=r.conversation_id AND m.bot_id=r.bot_id AND m.request_id=r.request_id`)
    .get(userId, conversationId, userMessageId);
  if (!source) return;
  const tables = new Set((db.connection.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{name:string}>).map(row=>row.name));
  if (!tables.has('works')) return;
  const ids = new Set<string>();
  const collect = (sql: string) => {
    for (const row of db.connection.prepare(sql).all(userId,userMessageId) as Array<{work_id:string}>) ids.add(row.work_id);
  };
  collect('SELECT work_id FROM works WHERE user_id=? AND source_message_id=?');
  if (tables.has('work_intent_snapshots')) collect(`SELECT w.work_id FROM works w JOIN work_intent_snapshots s ON s.work_id=w.work_id
    WHERE w.user_id=? AND s.source_message_id=?`);
  if (tables.has('bot_work_user_inputs')) collect(`SELECT w.work_id FROM works w JOIN bot_work_user_inputs s ON s.work_id=w.work_id
    WHERE w.user_id=? AND s.source_message_id=?`);
  if (tables.has('bot_collaboration_requests')) collect(`SELECT w.work_id FROM works w JOIN bot_collaborations c ON c.work_id=w.work_id AND c.user_id=w.user_id
    JOIN bot_collaboration_requests r ON r.collaboration_id=c.collaboration_id WHERE w.user_id=? AND r.user_message_id=?`);
  return ids.size === 1 ? [...ids][0] : undefined;
}

/** An explicit durable write must apply to this candidate's own quoted clause. */
export function botMemoryDurableEvidence(userText: string, evidence: string): boolean {
  const document = MemoryInstructionDocument.parse(userText);
  return document.allowsEvidence(evidence) && userText.split(/[。；;！!？?\n]/).some(sentence => sentence.includes(evidence)
    && document.allowsEvidence(sentence.trim()) && memoryRememberClause(sentence));
}

/** Narrow legacy automatic atoms at read time; preserve stored records and their evidence for audit. */
export function botMemoryAutomaticBoundary(db: AppDatabase, memory: import("../../shared/memory-kernel").MemoryRecordDto):
  { scopeType: "work" | "conversation"; scopeId: string } | undefined {
  if (memory.explicit || memory.sourceType !== "agent" || !memory.sourceId
    || !["fact", "constraint", "decision"].includes(memory.kind)
    || !memory.scopes.some(scope => ["bot", "team", "global"].includes(scope.scopeType))) return;
  const source = botMemorySource(db, memory.sourceId);
  if (!source && !/^(?:bot-conversation-|bot-gateway-)/.test(memory.sourceId)) return;
  if (!source) return { scopeType: "conversation", scopeId: memory.sourceId };
  const rows = db.connection.prepare(`SELECT t.user_message_id,m.text,e.excerpt FROM memory_evidence e
    JOIN memory_turns t ON t.id=e.ref_id AND t.task_id=?
    JOIN bot_send_receipts r ON r.user_message_id=t.user_message_id AND r.conversation_id=t.task_id AND r.user_id=?
    JOIN bot_messages m ON m.message_id=r.user_message_id AND m.role='user' AND m.bot_id=r.bot_id
      AND m.conversation_id=r.conversation_id AND m.request_id=r.request_id
    WHERE e.memory_id=?`).all(memory.sourceId,source.user_id,memory.id) as Array<{user_message_id:string;text:string;excerpt:string|null}>;
  // Do not narrow a real user-authorized durable write merely because its old extractor marked it automatic.
  if (rows.some(row => {
    const quote = /^用户：([\s\S]*?)(?:\n助手：|$)/.exec(row.excerpt ?? "")?.[1]?.trim();
    return quote && row.text.includes(quote) && botMemoryDurableEvidence(row.text,quote);
  })) return;
  const works = new Set(rows.map(row => botMemoryWorkForSource(db,memory.sourceId!,row.user_message_id,source.user_id)).filter(id=>id!==undefined));
  return works.size === 1 ? {scopeType:"work",scopeId:[...works][0]} : {scopeType:"conversation",scopeId:memory.sourceId};
}
