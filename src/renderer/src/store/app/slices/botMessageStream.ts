import type { BotHistoryDto, BotMessageEvent } from "../../../../../shared/bot-conversation";

/** Full-text replacement frames tolerate missing frames; persistent revisions reject old polls/events. */
export function mergeBotMessageEvent(history: BotHistoryDto | undefined, event: BotMessageEvent): BotHistoryDto | undefined {
  if (!history || history.botId !== event.botId || history.conversationId !== event.conversationId || history.archived
    || history.revision >= event.revision || event.message.botId !== event.botId
    || event.message.conversationId !== event.conversationId || event.message.role !== "assistant") return history;
  const existing = history.messages.find(message => message.messageId === event.message.messageId);
  if (!existing || existing.requestId !== event.message.requestId || existing.ordinal !== event.message.ordinal) return history;
  if (["completed", "cancelled", "failed"].includes(existing.status) && event.message.status === "running") return history;
  return { ...history, revision: event.revision,
    messages: history.messages.map(message => message.messageId === event.message.messageId ? event.message : message) };
}
