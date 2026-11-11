import type { BotHistoryDto, BotMessageEvent } from "../../../../../shared/bot-conversation";

/** Full-text replacement frames tolerate missing frames; persistent revisions reject old polls/events. */
export function mergeBotMessageEvent(history: BotHistoryDto | undefined, event: BotMessageEvent): BotHistoryDto | undefined {
  if (!history || (history.teamId ? history.teamId !== event.teamId : history.botId !== event.botId || Boolean(event.teamId)) || history.conversationId !== event.conversationId || history.archived
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

/** Merge bounded pages by identity, retaining loaded history and newer stream frames. */
export function mergeBotHistoryPage(current: BotHistoryDto, page: BotHistoryDto, older = false): BotHistoryDto {
  const messages = new Map(current.messages.map(message => [message.messageId, message]));
  for (const message of page.messages) {
    const existing = messages.get(message.messageId);
    if (existing && (existing.requestId !== message.requestId || existing.ordinal !== message.ordinal)) continue;
    if (existing) {
      const stale = existing.messageRevision !== undefined && message.messageRevision !== undefined
        ? existing.messageRevision > message.messageRevision
        : current.revision > page.revision;
      if (stale || (["completed", "cancelled", "failed"].includes(existing.status) && message.status === "running")) continue;
    }
    messages.set(message.messageId, message);
  }
  return { ...page, revision: Math.max(current.revision, page.revision),
    before: older || !current.messages.length ? page.before : current.before,
    messages: [...messages.values()].sort((a, b) => a.ordinal - b.ordinal) };
}
