const taskWorktreePrefix = "task-worktree-";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createTaskWorktreeId(): string {
  return taskWorktreePrefix + crypto.randomUUID();
}

export function isTaskWorktreeId(taskId: unknown): boolean {
  return typeof taskId === "string" && taskId.startsWith(taskWorktreePrefix)
    && uuid.test(taskId.slice(taskWorktreePrefix.length));
}
