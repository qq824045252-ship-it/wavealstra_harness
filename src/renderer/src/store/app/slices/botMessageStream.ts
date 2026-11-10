import type { BotHistoryDto, BotMessageEvent } from "../../../../../shared/bot-conversation";

/** Full-text replacement frames tolerate missing frames; persistent revisions reject old polls/events. */
export function mergeBotMessageEvent(history: BotHistoryDto | undefined, event: BotMessageEvent): BotHistoryDto | undefined {
  if (!history || history.botId !== event.botId || history.conversationId !== event.conversationId || history.archived
    || event.message.botId !== event.botId
    || event.message.conversationId !== event.conversationId || event.message.role !== "assistant") return history;
  const existing = history.messages.find(message => message.messageId === event.message.messageId);
  if (!existing || existing.requestId !== event.message.requestId || existing.ordinal !== event.message.ordinal) return history;
  // A newer frame from B must not discard an independently delayed frame from A.
  // Legacy hosts without message revisions retain their conversation fence.
  if (event.message.messageRevision !== undefined && existing.messageRevision !== undefined) {
    if (event.message.messageRevision <= existing.messageRevision) return history;
  } else if (history.revision >= event.revision) return history;
  if (["completed", "cancelled", "failed"].includes(existing.status) && event.message.status === "running") return history;
  return { ...history, revision: Math.max(history.revision, event.revision),
    messages: history.messages.map(message => message.messageId === event.message.messageId ? event.message : message) };
}
