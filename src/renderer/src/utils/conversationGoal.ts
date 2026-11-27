import type { ConversationGoalDto } from "@shared/conversation-goal";

export function latestConversationGoal(current: ConversationGoalDto | undefined, incoming: ConversationGoalDto): ConversationGoalDto {
  if (!current) return incoming;
  if (current.taskId !== incoming.taskId) return current;
  if (current.id !== incoming.id) {
    if (incoming.createdAt !== current.createdAt) return incoming.createdAt > current.createdAt ? incoming : current;
    return current.closedAt !== undefined && incoming.closedAt === undefined ? incoming : current;
  }
  if (incoming.version !== current.version) return incoming.version > current.version ? incoming : current;
  const previousRevision = current.continuation?.revision;
  const incomingRevision = incoming.continuation?.revision;
  if (previousRevision !== incomingRevision && (previousRevision !== undefined || incomingRevision !== undefined)) {
    return (incomingRevision ?? -1) > (previousRevision ?? -1) ? incoming : current;
  }
  if (current.closedAt !== undefined && incoming.closedAt === undefined) return current;
  return incoming.updatedAt >= current.updatedAt ? incoming : current;
}
