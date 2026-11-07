import type { TaskDto } from "../../shared/agent-ipc";
import type { AgentTaskLifecycleEvent } from "../agent/AgentService";
import type { WorkRepository } from "../agent/work/WorkRepository";
import type { NotificationService } from "./NotificationService";

/** Work completion is announced by its owner; ordinary Tasks keep their existing path. */
export function publishTaskLifecycleNotification(input: {
  event: AgentTaskLifecycleEvent; task?: TaskDto;
  workRepo: Pick<WorkRepository, "bindingForTask">;
  notifications: Pick<NotificationService, "publish">;
}): void {
  const { event, task, workRepo, notifications } = input;
  if (event.taskId.startsWith("cron-")) return;
  if (event.kind === "completed" && workRepo.bindingForTask(event.taskId)) return;
  const taskTitle = task?.title?.trim() || "任务";
  const common = { sourceType: "task" as const, sourceId: event.taskId, taskId: event.taskId,
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
