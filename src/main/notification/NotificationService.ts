import { randomUUID } from "node:crypto";
import type { AppDatabase } from "../db/AppDatabase";
import { AppSettingsStore } from "../AppSettingsStore";
import {
  normalizeNotificationPreferences,
  notificationPreferenceEnabled,
  type NotificationChangedEvent,
  type NotificationDto,
  type NotificationLevel,
  type NotificationListRequest,
  type NotificationSourceType,
  type NotificationType,
} from "../../shared/notification";
import { NotificationRepository } from "./NotificationRepository";

export interface PublishNotificationInput {
  type: NotificationType;
  level: NotificationLevel;
  title: string;
  body?: string;
  sourceType: NotificationSourceType;
  sourceId?: string;
  taskId?: string;
  projectId?: string;
  workspaceId?: string;
  dedupeKey?: string;
  createdAt?: number;
}

type ChangedListener = (event: NotificationChangedEvent) => void;
type DesktopPresenter = (notification: NotificationDto) => void;
type ForegroundProbe = () => boolean;

/**
 * MyBuddy 通知唯一业务入口。
 * - Main Process 为真源；Renderer 只读/标记。
 * - SQLite 持久化 + dedupe；桌面通知是 delivery，不是第二套通知真源。
 * - 通知策略来自 AppSettingsStore，任何 source adapter 都不能绕过这里自行弹窗。
 */
export class NotificationService {
  private readonly repository: NotificationRepository;
  private readonly settingsStore: AppSettingsStore;
  private changedListener: ChangedListener | null = null;
  private desktopPresenter: DesktopPresenter | null = null;
  private foregroundProbe: ForegroundProbe | null = null;
  /** in-app 关闭时没有 DB dedupe，仍需挡住同一 lifecycle event 的重复 desktop delivery。 */
  private readonly transientDedupe = new Map<string, number>();

  constructor(db: AppDatabase, settingsStore = new AppSettingsStore()) {
    this.repository = new NotificationRepository(db.connection);
    this.settingsStore = settingsStore;
    this.repository.cleanup();
  }

  setChangedListener(listener: ChangedListener | null): void {
    this.changedListener = listener;
  }

  setDesktopDelivery(presenter: DesktopPresenter | null, foregroundProbe?: ForegroundProbe | null): void {
    this.desktopPresenter = presenter;
    this.foregroundProbe = foregroundProbe ?? null;
  }

  list(request: NotificationListRequest = {}): NotificationDto[] {
    return this.repository.list(request);
  }

  unreadCount(): number {
    return this.repository.unreadCount();
  }

  markRead(id: string): void {
    if (this.repository.markRead(id)) this.emitChanged();
  }

  /** Read-back for an external channel that must prove its own effect. */
  findByDedupeKey(dedupeKey: string): NotificationDto | undefined {
    return this.repository.findByDedupeKey(dedupeKey);
  }

  markReadByDedupeKey(dedupeKey: string): void {
    if (this.repository.markReadByDedupeKey(dedupeKey)) this.emitChanged();
  }

  markAllRead(): void {
    if (this.repository.markAllRead() > 0) this.emitChanged();
  }

  dismiss(id: string): void {
    if (this.repository.dismiss(id)) this.emitChanged();
  }

  /** 一键清除：等价于对全部未清除通知执行 dismiss。 */
  dismissAll(): void {
    if (this.repository.dismissAll() > 0) this.emitChanged();
  }

  publish(input: PublishNotificationInput): NotificationDto | null {
    const preferences = normalizeNotificationPreferences(this.settingsStore.read().notificationPreferences);
    if (!notificationPreferenceEnabled(input.type, preferences)) return null;

    const now = input.createdAt ?? Date.now();
    this.pruneTransientDedupe(now);
    if (input.dedupeKey && this.transientDedupe.has(input.dedupeKey)) return null;

    const normalizedTitle = input.title.trim().slice(0, 160) || "MyBuddy 通知";
    const normalizedBody = input.body?.trim().slice(0, 1200) || undefined;
    const record: NotificationDto = {
      id: randomUUID(),
      type: input.type,
      level: input.level,
      title: normalizedTitle,
      body: normalizedBody,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      taskId: input.taskId,
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      dedupeKey: input.dedupeKey,
      createdAt: now,
    };

    let inserted = false;
    let effective = record;
    if (preferences.inAppEnabled) {
      const result = this.repository.insert(record);
      inserted = result.inserted;
      effective = result.record;
      if (!inserted) return null;
      this.emitChanged(effective);
    } else if (input.dedupeKey) {
      this.transientDedupe.set(input.dedupeKey, now);
    }

    if (preferences.desktopEnabled && this.shouldDeliverDesktop(effective, preferences.desktopBackgroundOnly)) {
      try {
        this.desktopPresenter?.(effective);
      } catch (error) {
        console.warn("[NotificationService] desktop delivery failed", error);
      }
    }

    return inserted || !preferences.inAppEnabled ? effective : null;
  }

  private shouldDeliverDesktop(notification: NotificationDto, backgroundOnly: boolean): boolean {
    if (!this.desktopPresenter) return false;
    const urgent = notification.type === "reminder.due" || notification.level === "error" || notification.type === "task.action_required";
    if (urgent) return true;
    if (!backgroundOnly) return true;
    try {
      return !(this.foregroundProbe?.() ?? false);
    } catch {
      return true;
    }
  }

  private emitChanged(latest?: NotificationDto): void {
    try {
      this.changedListener?.({ unreadCount: this.repository.unreadCount(), latest });
    } catch (error) {
      console.warn("[NotificationService] changed listener failed", error);
    }
  }

  private pruneTransientDedupe(now: number): void {
    const ttl = 6 * 60 * 60 * 1000;
    for (const [key, at] of this.transientDedupe) {
      if (now - at > ttl) this.transientDedupe.delete(key);
    }
    if (this.transientDedupe.size <= 500) return;
    const sorted = [...this.transientDedupe.entries()].sort((a, b) => a[1] - b[1]);
    for (const [key] of sorted.slice(0, sorted.length - 500)) this.transientDedupe.delete(key);
  }
}
