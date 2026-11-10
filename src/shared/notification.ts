export const NotificationIpc = {
  list: "notification:list",
  unreadCount: "notification:unreadCount",
  markRead: "notification:markRead",
  markAllRead: "notification:markAllRead",
  dismiss: "notification:dismiss",
  dismissAll: "notification:dismissAll",
  changed: "notification:changed",
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

export interface NotificationDto {
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
