import { randomUUID } from "node:crypto";
import type { AppDatabase } from "../db/AppDatabase";
import { AppSettingsStore } from "../AppSettingsStore";
import {
  normalizeNotificationPreferences,
  notificationPreferenceEnabled,
  notificationTarget,
  type NotificationChangedEvent,
  type NotificationActivationTarget,
  type NotificationDto,
  type NotificationLevel,
  type NotificationListRequest,
  type NotificationSourceType,
  type NotificationType,
} from "../../shared/notification";
import { clipNotificationText, NotificationRepository, type RuntimeNotificationMutation } from "./NotificationRepository";

export interface PublishNotificationInput {
  target?: NotificationActivationTarget;
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
  private writeTail = Promise.resolve();
  /** in-app 关闭时没有 DB dedupe，仍需挡住同一 lifecycle event 的重复 desktop delivery。 */
  private readonly transientDedupe = new Map<string, number>();

  constructor(private readonly db: AppDatabase, settingsStore = new AppSettingsStore()) {
    this.repository = new NotificationRepository(db.connection, db.runtimeAuditReader);
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

  resolveActivation(id: string): NotificationActivationTarget | null {
    const target = this.repository.resolveActivation(id);
    if (!target) return null;
    // Existence is rechecked at click time; Bot history/getWork enforce user scope
    // again at the renderer-facing API boundary before displaying any data.
    const db = this.db.connection;
    try {
      switch (target.kind) {
        case "task": return db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(target.taskId) ? target : null;
        case "project": return db.prepare("SELECT 1 FROM projects WHERE id = ?").get(target.projectId) ? target : null;
        case "work": return db.prepare("SELECT 1 FROM works w JOIN bots b ON b.bot_id = w.owner_bot_id WHERE w.work_id = ?").get(target.workId) ? target : null;
        case "botConversation": return db.prepare(`SELECT 1 FROM bot_conversations c JOIN bots b ON b.bot_id = c.bot_id
          WHERE c.conversation_id = ? AND c.bot_id = ? AND c.team_id IS ?`)
          .get(target.conversationId, target.botId, target.teamId ?? null) ? target : null;
        default: return target;
      }
    } catch { return null; }
  }

  list(request: NotificationListRequest = {}): NotificationDto[] {
    return this.repository.list(request);
  }

  unreadCount(): number {
    return this.repository.unreadCount();
  }

  async readList(request: NotificationListRequest = {}): Promise<NotificationDto[]> {
    await this.writeTail;
    return this.repository.readList(request);
  }

  async readUnreadCount(): Promise<number> {
    await this.writeTail;
    return this.repository.readUnreadCount();
  }

  flushWrites(): Promise<void> {
    return this.writeTail;
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

  writeMarkRead(id: string): Promise<void> {
    return this.writeMark({ kind: "markRead", id, at: Date.now() }, () => this.markRead(id));
  }

  writeMarkReadByDedupeKey(dedupeKey: string): Promise<void> {
    return this.writeMark({ kind: "markReadByDedupeKey", dedupeKey, at: Date.now() }, () => this.markReadByDedupeKey(dedupeKey));
  }

  postMarkReadByDedupeKey(dedupeKey: string): void {
    void this.writeMarkReadByDedupeKey(dedupeKey).catch(error => console.warn("[NotificationService] mark read failed", error));
  }

  writeMarkAllRead(): Promise<void> {
    return this.writeMark({ kind: "markAllRead", at: Date.now() }, () => this.markAllRead());
  }

  writeDismiss(id: string): Promise<void> {
    return this.writeMark({ kind: "dismiss", id, at: Date.now() }, () => this.dismiss(id));
  }

  writeDismissAll(): Promise<void> {
    return this.writeMark({ kind: "dismissAll", at: Date.now() }, () => this.dismissAll());
  }

  private enqueue<T>(write: () => Promise<T>): Promise<T> {
    const operation = this.writeTail.then(write);
    this.writeTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private writeMark(mutation: RuntimeNotificationMutation, onHost: () => void): Promise<void> {
    return this.enqueue(async () => {
      const native = this.db.runtimeAuditReader;
      if (!native) return onHost();
      const result = await native.writeNotification(mutation);
      if (result?.status === "needsHost") return onHost();
      if (result?.status === "rejected") throw new Error(result.message);
      if (!result) throw new Error("未收到通知状态保存确认");
      if (result.changed) this.emitChanged(undefined, result.unreadCount);
    });
  }

  publish(input: PublishNotificationInput): NotificationDto | null {
    const prepared = this.preparePublish(input);
    if (!prepared) return null;
    const { preferences, record } = prepared;
    if (preferences.inAppEnabled) {
      const result = this.repository.insert(record);
      if (!result.inserted) return null;
      this.emitChanged(record);
    } else if (record.dedupeKey) {
      this.transientDedupe.set(record.dedupeKey, record.createdAt);
    }

    if (preferences.desktopEnabled && this.shouldDeliverDesktop(record, preferences.desktopBackgroundOnly)) {
      if (!preferences.inAppEnabled) this.repository.saveActivation(record);
      this.deliverDesktop(record);
    }
    return record;
  }

  post(input: PublishNotificationInput): void {
    void this.publishPersisted(input).catch(error => console.warn("[NotificationService] notification write failed", error));
  }

  publishPersisted(input: PublishNotificationInput): Promise<NotificationDto | null> {
    const notice = { ...input, createdAt: input.createdAt ?? Date.now() };
    return this.enqueue(async () => {
      const native = this.db.runtimeAuditReader;
      if (!native) return this.publish(notice);
      const prepared = this.preparePublish(notice);
      if (!prepared) return null;
      const { preferences, record } = prepared;
      const inApp = preferences.inAppEnabled;
      const desktop = !inApp && preferences.desktopEnabled && this.shouldDeliverDesktop(record, preferences.desktopBackgroundOnly);
      if (inApp || desktop) {
        const target = notificationTarget(record);
        const { target: _target, group: _group, ...stored } = record;
        const result = await native.writeNotification({
          kind: "publish", record: stored, targetJson: target ? JSON.stringify(target) : undefined, inApp, desktop,
        });
        if (result?.status === "needsHost") return this.publish(notice);
        if (result?.status === "rejected") throw new Error(result.message);
        if (!result) throw new Error("未收到通知保存确认");
        if (inApp) {
          if (!result.changed) return null;
          this.emitChanged(record, result.unreadCount);
        }
      }
      if (!inApp && record.dedupeKey) this.transientDedupe.set(record.dedupeKey, record.createdAt);
      if ((inApp || desktop) && preferences.desktopEnabled && this.shouldDeliverDesktop(record, preferences.desktopBackgroundOnly)) {
        this.deliverDesktop(record);
      }
      return record;
    });
  }

  private preparePublish(input: PublishNotificationInput) {
    const preferences = normalizeNotificationPreferences(this.settingsStore.read().notificationPreferences);
    if (!notificationPreferenceEnabled(input.type, preferences)) return null;

    const now = input.createdAt ?? Date.now();
    this.pruneTransientDedupe(now);
    if (input.dedupeKey && this.transientDedupe.has(input.dedupeKey)) return null;

    const normalizedTitle = clipNotificationText(input.title, 160) || "MyBuddy 通知";
    const normalizedBody = input.body ? clipNotificationText(input.body, 1200) || undefined : undefined;
    const record: NotificationDto = {
      id: randomUUID(),
      target: input.target,
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

    return { preferences, record };
  }

  private deliverDesktop(record: NotificationDto): void {
    try {
      this.desktopPresenter?.(record);
    } catch (error) {
      console.warn("[NotificationService] desktop delivery failed", error);
    }
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

  private emitChanged(latest?: NotificationDto, unreadCount?: number): void {
    try {
      this.changedListener?.({ unreadCount: unreadCount ?? this.repository.unreadCount(), latest });
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
