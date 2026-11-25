import type { AgentUiPatch, TaskDto } from "../../shared/agent-ipc";
import type { AgentTaskLifecycleEvent } from "../agent/AgentService";
import type { WorkRepository } from "../agent/work/WorkRepository";
import type { PublishNotificationInput } from "./NotificationService";

/** Work completion is announced by its owner; ordinary Tasks keep their existing path. */
export function publishTaskLifecycleNotification(input: {
  event: AgentTaskLifecycleEvent; task?: TaskDto;
  goalId?: string;
  workRepo: Pick<WorkRepository, "bindingForTask">;
  notifications: { publish(input: PublishNotificationInput): void };
}): void {
  const { event, task, workRepo, notifications } = input;
  if (event.taskId.startsWith("cron-")) return;
  const binding = workRepo.bindingForTask(event.taskId);
  if (event.kind === "completed" && binding) return;
  const taskTitle = task?.title?.trim() || "任务";
  const workId = binding?.workId ?? input.goalId;
  const common = { sourceType: "task" as const, sourceId: event.taskId, taskId: event.taskId,
    target: { kind: "task" as const, taskId: event.taskId, messageId: event.assistantMessageId, ...(workId ? { workId } : {}),
      ...(event.kind === "action_required" ? { toolCallId: event.toolCallId } : {}) },
    workspaceId: task?.spaceId ?? undefined, projectId: task?.projectId ?? undefined };
  if (event.kind === "completed") {
    notifications.publish({ ...common, type: "task.completed", level: "success",
      title: "任务已完成", body: taskTitle,
      dedupeKey: `task:${event.taskId}:${event.assistantMessageId}:terminal` });
  } else if (event.kind === "failed") {
    notifications.publish({ ...common, type: "task.failed", level: "error",
      title: "任务执行失败", body: `${taskTitle} · ${event.error}`,
      dedupeKey: `task:${event.taskId}:${event.assistantMessageId}:terminal` });
  } else {
    notifications.publish({ ...common, type: "task.action_required", level: "warning",
      title: "任务需要你处理", body: `${taskTitle} · ${event.summary}${event.detail ? ` · ${event.detail}` : ""}`,
      dedupeKey: `task:${event.taskId}:tool:${event.toolCallId}:action` });
  }
}

export function createTaskInteractionNotificationListener(
  getTask: (id: string) => TaskDto | undefined,
  notifications: { publish(input: PublishNotificationInput): void; markReadByDedupeKey(dedupeKey: string): void },
  getGoalId?: (taskId: string, messageId: string) => string | undefined,
): (patch: AgentUiPatch) => void {
  return patch => {
    if (patch.type !== "conversation_interaction_snapshot") return;
    const { interaction } = patch;
    const dedupeKey = `task:${interaction.taskId}:interaction:${interaction.id}`;
    if (interaction.status !== "pending") {
      notifications.markReadByDedupeKey(dedupeKey);
      return;
    }
    const task = getTask(interaction.taskId);
    if (!task) return;
    const workId = getGoalId?.(task.id, interaction.assistantMessageId);
    notifications.publish({
      type: "task.action_required",
      level: "warning",
      title: "任务需要你处理",
      body: `${task.title?.trim() || "任务"} · ${interaction.title}`,
      sourceType: "task",
      sourceId: interaction.taskId,
      taskId: interaction.taskId,
      target: { kind: "task", taskId: interaction.taskId, messageId: interaction.assistantMessageId, interactionId: interaction.id,
        ...(workId ? { workId } : {}) },
      workspaceId: task.spaceId ?? undefined,
      projectId: task.projectId ?? undefined,
      dedupeKey,
    });
  };
}
