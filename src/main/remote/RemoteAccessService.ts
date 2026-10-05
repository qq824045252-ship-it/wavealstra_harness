import { RemoteImageService, type RemoteArtifactReader } from './RemoteImageService';
import { REMOTE_API_VERSION, type RemoteBootstrap, type RemoteModelSummary, type RemoteRuntimeSnapshot } from "../../../shared/src/remote-contract";
import type { AppDatabase } from "../db/AppDatabase";
import type { AgentService } from "../agent/AgentService";
import type { ExternalAgentRuntime } from "../external-agent/ExternalAgentRuntime";
import type { NotificationService } from "../notification/NotificationService";
import type { ProjectService } from "../project/ProjectService";
import type { AppSettingsStore } from "../AppSettingsStore";
import type { RemoteDeviceSummary } from "../../../shared/src/remote-contract";
import { mapRemoteHistory, mapRemoteModel, mapRemoteNotification, mapRemoteProject, mapRemoteSpace, mapRemoteTask } from "./RemoteDtoMapper";
import { WELCOME_MODES } from "../../shared/mode-profile";

/** 模型目录缓存窗口：bootstrap 在每次 SSE/refresh 都会被调用，避免反复 await provider 目录 */
const MODEL_CACHE_TTL_MS = 30_000;

export class RemoteAccessService {
  private readonly images: RemoteImageService;
  private modelsCache: { at: number; models: RemoteModelSummary[] } | null = null;

  constructor(
    private readonly db: AppDatabase,
    private readonly agent: AgentService,
    private readonly notifications: NotificationService,
    private readonly projects: ProjectService,
    private readonly settings: AppSettingsStore,
    private readonly externalAgent?: ExternalAgentRuntime,
    artifactSource: () => RemoteArtifactReader | null | undefined = () => null,
  ) { this.images = new RemoteImageService(db, artifactSource); }

  image(taskId: string, artifactId: string, version?: number) { return this.images.read(taskId, artifactId, version); }

  serverInfo() {
    return { apiVersion: REMOTE_API_VERSION, service: "mybuddy-remote" as const, name: "MyBuddy", now: Date.now() };
  }

  listTasks() {
    return this.db.listNonTrashedTasks().map((task) => mapRemoteTask(task, {
      busy: this.agent.isTaskBusy(task.id),
      pendingActionCount: this.agent.listPendingActions(task.id).length,
    }));
  }

  /** 白名单投影后的聊天模型目录（只含启用中、Provider 已认证的可执行 chat 模型） */
  async listModels(): Promise<RemoteModelSummary[]> {
    const now = Date.now();
    if (this.modelsCache && now - this.modelsCache.at < MODEL_CACHE_TTL_MS) return this.modelsCache.models;
    const models = (await this.agent.listModels())
      .filter((model) => model.enabled !== false && model.kind !== "image-generation" && model.available !== false)
      .map(mapRemoteModel);
    this.modelsCache = { at: now, models };
    return models;
  }

  async bootstrap(device: RemoteDeviceSummary): Promise<RemoteBootstrap> {
    const settings = this.settings.read();
    return {
      apiVersion: REMOTE_API_VERSION,
      server: this.serverInfo(),
      spaces: this.db.listSpaces().map(mapRemoteSpace),
      projects: this.projects.list(true).map(mapRemoteProject),
      tasks: this.listTasks(),
      unreadNotificationCount: this.notifications.unreadCount(),
      device,
      models: await this.listModels(),
      defaultModelId: settings.defaultModelId?.trim() || null,
      defaultPermissionMode: settings.permissionMode,
      taskModes: WELCOME_MODES.map(id => {
        const profile = this.agent.getModeProfile(id);
        return { id, label: profile.labelZh, tags: (profile.policy.presets ?? []).map(({ id, label, description }) => ({ id, label, description })) };
      }),
    };
  }

  async history(taskId: string) {
    if (!this.db.getTask(taskId)) return null;
    // 与桌面端 loadTaskHistory IPC 一致：ACP 外部 Agent 的轮次存在
    // external_agent_runs 而非 builtin session 文件，必须合入否则手机端看不到
    const [nativeHistory, externalHistory] = await Promise.all([
      this.agent.loadTaskHistory(taskId),
      Promise.resolve(this.externalAgent?.history(taskId) ?? { messages: [], runs: [] }),
    ]);
    if (!externalHistory.messages.length) return this.images.enrichHistory(taskId, mapRemoteHistory(taskId, nativeHistory));
    return this.images.enrichHistory(taskId, mapRemoteHistory(taskId, {
      ...nativeHistory,
      messages: [...nativeHistory.messages, ...externalHistory.messages]
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    }));
  }

  runtime(taskId: string): RemoteRuntimeSnapshot | null {
    if (!this.db.getTask(taskId)) return null;
    const snapshot = this.agent.getConversationRuntimeSnapshot(taskId);
    return {
      taskId,
      busy: this.agent.isTaskBusy(taskId),
      interactions: snapshot.interactions,
      activeGoal: snapshot.activeGoal ?? null,
      pendingActions: this.agent.listPendingActions(taskId),
    };
  }

  listNotifications(unreadOnly = false, limit = 100) {
    return this.notifications.list({ unreadOnly, limit }).map(mapRemoteNotification);
  }

  markNotificationRead(id: string): void { this.notifications.markRead(id); }
  markAllNotificationsRead(): void { this.notifications.markAllRead(); }
  clearAllNotifications(): void { this.notifications.dismissAll(); }
}
