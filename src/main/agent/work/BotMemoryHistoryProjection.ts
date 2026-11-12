import type Database from "better-sqlite3";
import type { BotMessageDto } from "../../../shared/bot-conversation";
import { MemoryForgetWatermarks } from "../../memory/MemoryForgetWatermarks";
import { MemoryRecallLineage, recallSourceHash } from "../../memory/MemoryRecallLineage";

/** Rebuild only revoked native context from the existing host message projection.
 * Never alter the visible transcript or discard unrelated original user evidence. */
export function projectBotMemoryHistory(db: Database.Database, history: BotMessageDto[],
  identity: { botId: string; conversationId: string; teamId?: string }) {
  const scopes = [{ scopeType: identity.teamId ? "team" as const : "bot" as const, scopeId: identity.teamId ?? identity.botId },
    { scopeType: "conversation" as const, scopeId: identity.conversationId }, { scopeType: "global" as const }];
  const filter = new MemoryForgetWatermarks(db).sourceFilter(scopes);
  const lineage = new MemoryRecallLineage(db);
  const revoked = lineage.projection(scopes);
  const users = new Map(history.filter(message => message.role === "user").map(message => [message.requestId, message]));
  let changed = false;
  const messages = history.map(message => {
    const user = message.role === "user" ? message : users.get(message.requestId);
    const projected = filter(user?.text ?? "", message.role === "assistant" ? message.text : "",
      user?.createdAt ?? message.createdAt, user?.messageId);
    const text = message.role === "user" ? projected.userText
      : revoked(message.messageId) ? "" : projected.assistantText;
    if (text === message.text) return message;
    changed = true;
    return { ...message, text: message.role === "assistant" ? "[该历史证据已撤销]" : text || "[该历史证据已撤销]", botCalls: [] };
  });
  const sourceMessageIds = messages.filter(message => message.text !== "[该历史证据已撤销]").map(message => message.messageId);
  const sourceHashes = Object.fromEntries(messages.filter(message => message.role === "user" && message.text !== "[该历史证据已撤销]").map(message => [message.messageId, recallSourceHash(message.text)]));
  return { messages, changed, sourceMessageIds, sourceHashes, assistantRevoked: revoked };
}
