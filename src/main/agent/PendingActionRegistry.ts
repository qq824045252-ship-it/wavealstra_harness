import type { RemotePendingAction } from "../../../shared/src/remote-contract";

export type PendingActionRecord = RemotePendingAction;

function key(taskId: string, toolCallId: string): string {
  return `${taskId}\u0000${toolCallId}`;
}

/** Read-only presentation snapshot for approvals; resolvers remain in SessionRegistry. */
export class PendingActionRegistry {
  private readonly actions = new Map<string, PendingActionRecord>();

  register(action: PendingActionRecord): void {
    this.actions.set(key(action.taskId, action.toolCallId), structuredClone(action));
  }

  remove(taskId: string, toolCallId: string): void {
    this.actions.delete(key(taskId, toolCallId));
  }

  removeTask(taskId: string): void {
    for (const [id, action] of this.actions) {
      if (action.taskId === taskId) this.actions.delete(id);
    }
  }

  get(taskId: string, toolCallId: string): PendingActionRecord | undefined {
    const action = this.actions.get(key(taskId, toolCallId));
    return action ? structuredClone(action) : undefined;
  }

  list(taskId?: string): PendingActionRecord[] {
    return [...this.actions.values()]
      .filter((action) => taskId === undefined || action.taskId === taskId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((action) => structuredClone(action));
  }
}
