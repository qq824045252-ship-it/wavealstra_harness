import type { ChatMessage, Task, TaskFilterStatus, TaskFilterTime, TaskStatus } from "@/types";

export type TaskDisplayStatus = "running" | "pending" | "idle";

export function hasPendingApproval(task: Task): boolean {
  return task.messages.some((m) =>
    m.blocks.some((b) => b.type === "tool" && b.toolCall.status === "pending_approval"),
  );
}

export function hasPendingConversationInteraction(task: Task): boolean {
  return task.messages.some((message) =>
    (message.interactions ?? []).some((interaction) => interaction.status === "pending"),
  );
}

export function deriveTaskStatus(task: Task): TaskStatus {
  if (task.status) return task.status;
  if (hasPendingApproval(task) || hasPendingConversationInteraction(task)) return "pending";
  if (task.messages.some((m) => m.streaming)) return "in_progress";
  if (task.messages.length === 0) return "planning";
  const failed = task.messages.some((m) =>
    m.blocks.some((b) => b.type === "tool" && b.toolCall.status === "error"),
  );
  if (failed) return "failed";
  if (task.progressSteps?.some((s) => s.status === "running")) return "in_progress";
  return "completed";
}

/** 侧边栏展示用：待确认 > 进行中 > 空闲 */
export function getTaskDisplayStatus(task: Task): TaskDisplayStatus {
  if (hasPendingApproval(task) || hasPendingConversationInteraction(task)) return "pending";
  if (deriveTaskStatus(task) === "in_progress") return "running";
  return "idle";
}

export function matchesTaskFilter(
  task: Task,
  status: TaskFilterStatus,
  time: TaskFilterTime,
): boolean {
  if (status !== "all" && deriveTaskStatus(task) !== status) return false;
  const diff = Date.now() - task.updatedAt;
  const DAY = 24 * 60 * 60 * 1000;
  if (time === "today" && diff > DAY) return false;
  if (time === "7d" && diff > 7 * DAY) return false;
  if (time === "30d" && diff > 30 * DAY) return false;
  return true;
}

export function taskHasActiveExecution(task: Task | null): boolean {
  if (!task) return false;
  if (task.durable) return task.durable.busy;
  if (hasActiveExecutionMessages(task.messages)) return true;
  if (task.status === "in_progress") return true;
  if (task.status === "completed" || task.status === "failed") return false;
  return false;
}

/** task.status 可能因跨进程事件短暂滞后，消息级运行态优先作为 UI 真相。 */
export function hasActiveExecutionMessages(messages: ChatMessage[]): boolean {
  return messages.some(
    (message) =>
      message.streaming ||
      (message.interactions ?? []).some((interaction) => interaction.status === "pending") ||
      message.blocks.some(
        (block) => block.type === "tool" && block.toolCall.status === "pending_approval",
      ),
  );
}

export function activeExecutionLabel(task: Task | null): string | null {
  if (!task) return null;
  for (let index = task.messages.length - 1; index >= 0; index -= 1) {
    const m = task.messages[index];
    const interaction = (m.interactions ?? []).find((item) => item.status === "pending");
    if (interaction) return `等待回答：${interaction.title}`;
    if (m.streaming) {
      const tool = m.blocks.find((b) => b.type === "tool");
      if (tool?.type === "tool") return `正在执行 ${tool.toolCall.summary}`;
    }
    const pending = m.blocks.find(
      (b) => b.type === "tool" && b.toolCall.status === "pending_approval",
    );
    if (pending?.type === "tool") return `等待确认：${pending.toolCall.summary}`;
  }
  return null;
}
