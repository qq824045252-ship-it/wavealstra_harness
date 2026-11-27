import type { AgentUiPatch, TaskDto } from "../../shared/agent-ipc";
import { LOCAL_USER_ID } from "../../shared/bot-work";
import type { ConversationInteractionDto } from "../../shared/conversation-interaction";
import type { AgentTaskLifecycleEvent } from "../agent/AgentService";
import type { AppDatabase } from "../db/AppDatabase";
import type { PublishNotificationInput } from "./NotificationService";

type NotificationSink = { publish(input: PublishNotificationInput): void; markReadByDedupeKey(dedupeKey: string): void };

/** Work completion is announced by its owner; ordinary Tasks keep their existing path. */
export function publishTaskLifecycleNotification(input: {
  event: AgentTaskLifecycleEvent; task?: TaskDto;
  workId?: string;
  hasWorkBinding: boolean;
  notifications: { publish(input: PublishNotificationInput): void };
}): void {
  const { event, task, workId, hasWorkBinding, notifications } = input;
  if (event.taskId.startsWith("cron-")) return;
  if (event.kind === "completed" && hasWorkBinding) return;
  const taskTitle = task?.title?.trim() || "任务";
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
  notifications: NotificationSink,
  getGoalId?: (taskId: string, messageId: string) => string | undefined,
): (patch: AgentUiPatch) => void {
  return patch => {
    if (patch.type !== "conversation_interaction_snapshot") return;
    const { interaction } = patch;
    const dedupeKey = interactionNoticeKey(interaction);
    if (interaction.status !== "pending") {
      notifications.markReadByDedupeKey(dedupeKey);
      return;
    }
    const task = getTask(interaction.taskId);
    if (!task) return;
    publishInteractionNotice(interaction, task, notifications, getGoalId?.(task.id, interaction.assistantMessageId));
  };
}

function interactionNoticeKey(interaction: ConversationInteractionDto): string {
  return `task:${interaction.taskId}:interaction:${interaction.id}`;
}

function publishInteractionNotice(interaction: ConversationInteractionDto, task: TaskDto, notifications: NotificationSink, workId?: string): void {
  notifications.publish({
    type: "task.action_required",
    level: "warning",
    title: "任务需要你处理",
    body: `${task.title?.trim() || "任务"} · ${interaction.title}`,
    sourceType: "task",
    sourceId: task.id,
    taskId: task.id,
    target: { kind: "task", taskId: task.id, messageId: interaction.assistantMessageId, interactionId: interaction.id,
      ...(workId ? { workId } : {}) },
    workspaceId: task.spaceId ?? undefined,
    projectId: task.projectId ?? undefined,
    dedupeKey: interactionNoticeKey(interaction),
  });
}

export function createCoreTaskNotificationListeners(db: Pick<AppDatabase, "readTask" | "runtimeAuditReader">, notifications: NotificationSink) {
  const core = db.runtimeAuditReader;
  if (!core) throw new Error("任务通知需要 Rust Core");
  const pendingReads = new Map<string, symbol>();

  return {
    async lifecycle(event: AgentTaskLifecycleEvent): Promise<void> {
      if (event.taskId.startsWith("cron-")) return;
      const access = await core.readWorkTaskAccess(event.taskId);
      if (!access) throw new Error("Core 未确认通知任务的 Work 归属");
      if (!access.taskExists || (event.kind === "completed" && access.hasWorkBinding)) return;
      const task = await db.readTask(event.taskId, { includeExpertBinding: false });
      if (!task) return;
      const owner = event.kind !== "action_required" && event.conversationId
        ? await core.readConversationGoalActivityOwner(event.taskId, LOCAL_USER_ID, event.conversationId, event.assistantMessageId)
          .catch(error => { console.warn("[NotificationService] Goal notification context unavailable", error); return undefined; })
        : undefined;
      publishTaskLifecycleNotification({ event, task, workId: owner?.goalId, hasWorkBinding: access.hasWorkBinding, notifications });
    },

    async patch(patch: AgentUiPatch): Promise<void> {
      if (patch.type !== "conversation_interaction_snapshot") return;
      const { interaction } = patch;
      if (patch.taskId !== interaction.taskId || patch.messageId !== interaction.assistantMessageId
        || patch.executionId !== interaction.executionId) return;
      const key = interactionNoticeKey(interaction);
      if (interaction.status !== "pending") {
        pendingReads.delete(key);
        notifications.markReadByDedupeKey(key);
        return;
      }
      const token = Symbol();
      pendingReads.set(key, token);
      try {
        const task = await db.readTask(interaction.taskId, { includeExpertBinding: false });
        // An answer or newer snapshot can arrive while the Core read is in flight.
        if (task && pendingReads.get(key) === token) publishInteractionNotice(interaction, task, notifications);
      } finally {
        if (pendingReads.get(key) === token) pendingReads.delete(key);
      }
    },
  };
}
