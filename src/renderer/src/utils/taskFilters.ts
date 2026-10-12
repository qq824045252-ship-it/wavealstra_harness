import type {
  ChatMessage,
  MessageBlock,
  Task,
  TaskFilterStatus,
  TaskFilterTime,
  TaskStatus,
} from "@/types";

export type TaskDisplayStatus = "running" | "pending" | "done" | "idle";

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

export function deriveTaskStatus(task: Task): TaskStatus {
  if (task.status) return task.status;
  if (hasPendingApproval(task) || hasPendingConversationInteraction(task)) return "pending";
  const messages = messagesOf(task);
  if (messages.some((m) => m.streaming)) return "in_progress";
  if (messages.length === 0) return "planning";
  const failed = messages.some((m) =>
    blocksOf(m).some((b) => b.type === "tool" && b.toolCall.status === "error"),
  );
  if (failed) return "failed";
  if (task.progressSteps?.some((s) => s.status === "running")) return "in_progress";
  return "completed";
}

/** 侧边栏展示用：待确认 > 进行中 > 已结束 > 空闲。planning（尚无消息）视为空闲，completed/failed 视为已结束。 */
export function getTaskDisplayStatus(task: Task): TaskDisplayStatus {
  if (hasPendingApproval(task) || hasPendingConversationInteraction(task)) return "pending";
  const status = deriveTaskStatus(task);
  if (status === "in_progress") return "running";
  if (status === "completed" || status === "failed") return "done";
  return "idle";
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
 * 侧栏绿点（已结束且未查看）：doneAckedAt 早于完成标记 = 结束后还没有人看过结果。
 * 只有「已结束」才有绿点；点击任务 → ackTaskDone 把 doneAckedAt 推到现在 → 绿点消失并持久化。
 * 再次运行并结束后，新消息的 createdAt 超过该水位 → 绿点自然回来。
 */
export function isTaskDoneUnread(task: Task): boolean {
  return getTaskDisplayStatus(task) === "done" && (task.doneAckedAt ?? 0) < taskCompletionMark(task);
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
