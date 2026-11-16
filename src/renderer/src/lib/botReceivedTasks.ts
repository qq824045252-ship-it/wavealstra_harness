import type { BotCollaborationDto, BotIncomingMessage } from "@shared/bot-collaboration";
import type { BotMessageDto } from "@shared/bot-conversation";
import { botTaskReplyAssociations, botTaskReplyMessageFeedback } from "./botTaskReplyPresentation";

export interface BotReceivedTask {
  key: string;
  collaboration: BotCollaborationDto;
  rows: BotIncomingMessage[];
  messages: BotMessageDto[];
  createdAt: number;
}

/** Display-only association. Never infers ownership from titles, proximity or prose. */
export function botReceivedTasks(
  items: readonly BotIncomingMessage[], messages: readonly BotMessageDto[], botId: string,
): { boards: BotReceivedTask[]; absorbed: Set<string> } {
  const byId = new Map<string, BotReceivedTask>();
  for (const row of items) {
    const c = row.collaboration;
    if (c.targetBotId !== botId || c.sourceBotId === botId || row.message.collaborationId !== c.collaborationId) continue;
    if (row.message.senderBotId !== c.sourceBotId && row.message.senderBotId !== c.targetBotId) continue;
    let board = byId.get(c.collaborationId);
    if (!board) {
      board = { key: JSON.stringify([botId, c.collaborationId]), collaboration: c, rows: [], messages: [], createdAt: c.createdAt };
      byId.set(c.collaborationId, board);
    }
    // Do not let inconsistent participants poison an already established identity.
    if (board.collaboration.sourceBotId !== c.sourceBotId || board.collaboration.userId !== c.userId) continue;
    if (c.updatedAt > board.collaboration.updatedAt ||
      (c.updatedAt === board.collaboration.updatedAt && c.messageCount > board.collaboration.messageCount)) board.collaboration = c;
    board.rows.push(row);
  }
  // Classify using the latest relation, retaining earlier requests after a
  // real Work binds. An unbound peer call is still ordinary conversation.
  for (const [id, board] of byId) if (!board.collaboration.workId) byId.delete(id);
  const boards = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key));
  const byWork = new Map<string, BotReceivedTask[]>();
  for (const board of boards) {
    board.rows.sort((a, b) => a.message.ordinal - b.message.ordinal || a.message.messageId.localeCompare(b.message.messageId));
    const workId = board.collaboration.workId;
    if (workId) byWork.set(workId, [...(byWork.get(workId) ?? []), board]);
  }
  const absorbed = new Set<string>();
  const owned = boards.length ? botTaskReplyAssociations(messages).owned : new Map<BotMessageDto, string>();
  for (const message of messages) {
    const explicit = new Set(message.workIds);
    const feedback = botTaskReplyMessageFeedback(message);
    if (feedback) explicit.add(feedback.workId);
    if (message.botId !== botId || message.teamId || explicit.size > 1) continue;
    const explicitWork = explicit.values().next().value;
    const peer = message.peerOrigin;
    let board: BotReceivedTask | undefined;
    if (peer) {
      if (peer.kind !== "request") continue;
      const candidate = byId.get(peer.collaborationId);
      if (!candidate || peer.sourceBotId !== candidate.collaboration.sourceBotId || peer.senderBotId !== peer.sourceBotId) continue;
      if (explicitWork && candidate.collaboration.workId && explicitWork !== candidate.collaboration.workId) continue;
      board = candidate;
      if (message.role === "user") {
        // The journal contains the public requirement. Never render internal peer context.
        if (board.rows.some(row => row.message.kind === "request" && row.message.senderBotId === peer.senderBotId && row.message.exchangeId === peer.exchangeId)) absorbed.add(message.messageId);
        continue;
      }
    } else {
      if (message.role !== "assistant") continue;
      const workId = explicitWork ?? (message.referenceMessageId ? owned.get(message) : undefined);
      if (!workId) continue;
      const candidates = byWork.get(workId);
      if (candidates?.length === 1) board = candidates[0];
    }
    if (!board || absorbed.has(message.messageId)) continue;
    board.messages.push(message);
    absorbed.add(message.messageId);
  }
  for (const board of boards) board.messages.sort((a, b) => a.createdAt - b.createdAt || a.ordinal - b.ordinal || a.messageId.localeCompare(b.messageId));
  return { boards, absorbed };
}
