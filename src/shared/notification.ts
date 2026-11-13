export const NotificationIpc = {
  list: "notification:list",
  unreadCount: "notification:unreadCount",
  markRead: "notification:markRead",
  markAllRead: "notification:markAllRead",
  dismiss: "notification:dismiss",
  dismissAll: "notification:dismissAll",
  changed: "notification:changed",
  activate: "notification:activate",
  consumeActivation: "notification:consumeActivation",
  acknowledgeActivation: "notification:acknowledgeActivation",
  activated: "notification:activated",
} as const;

export type NotificationType =
  | "task.completed"
  | "task.failed"
  | "task.action_required"
  | "reminder.due"
  | "automation.completed"
  | "automation.failed"
  | "project.attention"
  | "runtime.failed";

export type NotificationLevel = "info" | "success" | "warning" | "error";
export type NotificationSourceType = "task" | "project" | "automation" | "runtime" | "system";

export type NotificationActivationTarget =
  | { kind: "task"; taskId: string }
  | { kind: "project"; projectId: string }
  | { kind: "work"; workId: string }
  | { kind: "botConversation"; botId: string; teamId?: string; conversationId: string; messageId?: string }
  | { kind: "automation" }
  | { kind: "runtime" };

export interface NotificationActivation { notificationId: string; target: NotificationActivationTarget | null }

/** Reject malformed persisted targets rather than interpreting arbitrary navigation input. */
export function parseNotificationTarget(value: unknown): NotificationActivationTarget | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const id = (key: string) => typeof v[key] === "string" && (v[key] as string).length > 0 && (v[key] as string).length <= 256;
  switch (v.kind) {
    case "task": return id("taskId") ? { kind: v.kind, taskId: v.taskId as string } : null;
    case "project": return id("projectId") ? { kind: v.kind, projectId: v.projectId as string } : null;
    case "work": return id("workId") ? { kind: v.kind, workId: v.workId as string } : null;
    case "botConversation": return id("botId") && id("conversationId") && (v.teamId === undefined || id("teamId")) && (v.messageId === undefined || id("messageId"))
      ? { kind: v.kind, botId: v.botId as string, conversationId: v.conversationId as string, teamId: v.teamId as string | undefined, messageId: v.messageId as string | undefined } : null;
    case "automation": case "runtime": return { kind: v.kind };
    default: return null;
  }
}

export function notificationTarget(record: Pick<NotificationDto, "target" | "taskId" | "projectId" | "sourceType">): NotificationActivationTarget | null {
  if (record.target) return parseNotificationTarget(record.target);
  if (record.taskId) return { kind: "task", taskId: record.taskId };
  if (record.projectId) return { kind: "project", projectId: record.projectId };
  if (record.sourceType === "automation" || record.sourceType === "runtime") return { kind: record.sourceType };
  return null;
}

export interface NotificationDto {
  target?: NotificationActivationTarget;
  id: string;
  type: NotificationType;
  level: NotificationLevel;
  title: string;
  body?: string;
  sourceType: NotificationSourceType;
  sourceId?: string;
  taskId?: string;
  projectId?: string;
  workspaceId?: string;
  createdAt: number;
  readAt?: number;
  dismissedAt?: number;
  dedupeKey?: string;
}

export interface NotificationListRequest {
  unreadOnly?: boolean;
  limit?: number;
}

export interface NotificationChangedEvent {
  unreadCount: number;
  latest?: NotificationDto;
}

export interface NotificationPreferencesDto {
  /** Bell / 通知中心持久化展示。 */
  inAppEnabled: boolean;
  /** Windows/macOS 原生桌面通知。 */
  desktopEnabled: boolean;
  /** success/info 仅后台时弹；warning/error 仍可前台弹。 */
  desktopBackgroundOnly: boolean;
  taskCompleted: boolean;
  taskFailed: boolean;
  actionRequired: boolean;
  automationCompleted: boolean;
  automationFailed: boolean;
  projectAttention: boolean;
  runtimeFailed: boolean;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferencesDto = {
  inAppEnabled: true,
  desktopEnabled: true,
  desktopBackgroundOnly: true,
  taskCompleted: true,
  taskFailed: true,
  actionRequired: true,
  automationCompleted: true,
  automationFailed: true,
  projectAttention: true,
  runtimeFailed: true,
};

export function normalizeNotificationPreferences(value: unknown): NotificationPreferencesDto {
  const raw = value && typeof value === "object" ? (value as Partial<NotificationPreferencesDto>) : {};
  const result = { ...DEFAULT_NOTIFICATION_PREFERENCES };
  for (const key of Object.keys(result) as Array<keyof NotificationPreferencesDto>) {
    const candidate = raw[key];
    if (typeof candidate === "boolean") result[key] = candidate;
  }
  return result;
}

export function notificationPreferenceEnabled(
  type: NotificationType,
  preferences: NotificationPreferencesDto,
): boolean {
  switch (type) {
    case "task.completed": return preferences.taskCompleted;
    case "task.failed": return preferences.taskFailed;
    case "task.action_required": return preferences.actionRequired;
    case "reminder.due": return preferences.automationCompleted;
    case "automation.completed": return preferences.automationCompleted;
    case "automation.failed": return preferences.automationFailed;
    case "project.attention": return preferences.projectAttention;
    case "runtime.failed": return preferences.runtimeFailed;
  }
}
