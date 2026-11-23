import type {
  ChatMessage,
  MessageBlock,
  Task,
  TaskFilterStatus,
  TaskFilterTime,
  TaskStatus,
} from "@/types";
import type { BotWorkspaceRequestDto } from "../../../shared/bot-workspace-navigation";

/**
 * 消息列表读取口：真实 Task 一定有 messages（mapTaskRowToTask 固定给 []），
 * 但侧栏/状态判定会被 store 中途构造的部分任务对象命中（例如测试夹具、只带 id/title 的骨架任务）。
 * 缺 messages 时按空列表处理，绝不让「状态点判定」把整棵侧栏带崩。
 */
function messagesOf(task: Task): ChatMessage[] {
  return Array.isArray(task.messages) ? task.messages : [];
}

/** 消息块读取口：同上，缺 blocks 的部分消息按空块列表处理（渲染/判定都不该因此抛异常）。 */
function blocksOf(message: ChatMessage): MessageBlock[] {
  return Array.isArray(message.blocks) ? message.blocks : [];
}

export function hasPendingApproval(task: Task): boolean {
  return messagesOf(task).some((m) =>
    blocksOf(m).some((b) => b.type === "tool" && b.toolCall.status === "pending_approval"),
  );
}

export function hasPendingConversationInteraction(task: Task): boolean {
  return messagesOf(task).some((message) =>
    (message.interactions ?? []).some((interaction) => interaction.status === "pending"),
  );
}

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  in_progress: "进行中",
  completed: "已完成",
  failed: "失败",
  pending: "待处理",
  planning: "规划中",
  stopped: "已停止",
};

export const FOREGROUND_TASK_STATUS: Record<BotWorkspaceRequestDto["status"], TaskStatus | "unknown"> = {
  queued: "pending",
  running: "in_progress",
  completed: "completed",
  failed: "failed",
  cancelled: "stopped",
  unknown: "unknown",
};

const pendingActions = {
  reply: { kind: "reply", label: "等待你回答" },
  approve: { kind: "approve", label: "等待你确认操作" },
} as const;

export function taskPendingAction(task: Task) {
  if (hasPendingConversationInteraction(task)) return pendingActions.reply;
  if (hasPendingApproval(task)) return pendingActions.approve;
  if (task.durable?.status === "waiting_input") return pendingActions.reply;
  return null;
}

export function taskActionLabel(task: Task): string | null {
  return taskPendingAction(task)?.label ?? null;
}

export function deriveTaskStatus(task: Task, action = taskActionLabel(task)): TaskStatus {
  if (action) return "pending";
  const messages = messagesOf(task);
  if (task.durable?.busy || messages.some((m) => m.streaming)) return "in_progress";
  if (task.botPendingSubmissions?.some(input => input.submitting)) return "pending";
  if (task.status) return task.status;
  if (messages.length === 0) return "planning";
  const failed = messages.some((m) =>
    blocksOf(m).some((b) => b.type === "tool" && b.toolCall.status === "error"),
  );
  if (failed) return "failed";
  if (task.progressSteps?.some((s) => s.status === "running")) return "in_progress";
  return "completed";
}

/**
 * 完成标记 = 本任务「最后一次产出结果」的时间。
 * 首选最后一条消息的 createdAt（新消息 = 新结果）；无消息时退回 updatedAt。
 * 刻意不用 updatedAt 作为首选：重命名/置顶/归档/绑专家都会推进 updatedAt，
 * 那会让已确认过的绿点靠噪声复活（这正是「绿点一直存在」的成因之一）。
 */
export function taskCompletionMark(task: Task): number {
  let mark = 0;
  for (const message of messagesOf(task)) {
    if (message.createdAt > mark) mark = message.createdAt;
  }
  return mark || task.updatedAt;
}

/**
 * 侧栏未读强调随查看确认消失。再次运行产生新消息后，按完成标记恢复未读。
 */
export function isTaskDoneUnread(task: Task, status = deriveTaskStatus(task)): boolean {
  return (status === "completed" || status === "failed") && (task.doneAckedAt ?? 0) < taskCompletionMark(task);
}

export function matchesTaskFilter(
  task: Task,
  status: TaskFilterStatus,
  time: TaskFilterTime,
): boolean {
  if (status !== "all" && deriveTaskStatus(task) !== status) return false;
  return matchesTaskTimeFilter(task.updatedAt, time);
}

export function matchesTaskTimeFilter(updatedAt: number, time: TaskFilterTime): boolean {
  const diff = Date.now() - updatedAt;
  const DAY = 24 * 60 * 60 * 1000;
  if (time === "today" && diff > DAY) return false;
  if (time === "7d" && diff > 7 * DAY) return false;
  if (time === "30d" && diff > 30 * DAY) return false;
  return true;
}

export function taskHasActiveExecution(task: Task | null): boolean {
  if (!task) return false;
  if (task.botPendingSubmissions?.some(input => input.submitting)) return true;
  if (messagesOf(task).some(message => message.externalAgent && message.streaming)) return true;
  if (task.durable) return task.durable.busy;
  if (hasActiveExecutionMessages(messagesOf(task))) return true;
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
      blocksOf(message).some(
        (block) => block.type === "tool" && block.toolCall.status === "pending_approval",
      ),
  );
}

export function activeExecutionLabel(task: Task | null): string | null {
  if (!task) return null;
  const messages = messagesOf(task);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const m = messages[index];
    const interaction = (m.interactions ?? []).find((item) => item.status === "pending");
    if (interaction) return `等待回答：${interaction.title}`;
    if (m.streaming) {
      const tool = blocksOf(m).find((b) => b.type === "tool");
      if (tool?.type === "tool") return `正在执行 ${tool.toolCall.summary}`;
    }
    const pending = blocksOf(m).find(
      (b) => b.type === "tool" && b.toolCall.status === "pending_approval",
    );
    if (pending?.type === "tool") return `等待确认：${pending.toolCall.summary}`;
  }
  return null;
}
