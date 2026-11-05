import { RemoteImageService, type RemoteArtifactReader } from './RemoteImageService';
import {
  REMOTE_API_VERSION,
  type RemoteAcpAgentSummary,
  type RemoteAcpPermissionPolicy,
  type RemoteAcpRunInfo,
  type RemoteBootstrap,
  type RemoteModelRefreshResult,
  type RemoteModelSummary,
  type RemoteModelSetting,
  type RemotePendingAction,
  type RemoteRuntimeSnapshot,
} from "../../../shared/src/remote-contract";
import type { AppDatabase } from "../db/AppDatabase";
import type { AgentService } from "../agent/AgentService";
import type { ExternalAgentRuntime } from "../external-agent/ExternalAgentRuntime";
import type { ExternalAgentRunDto } from "../../shared/external-agent";
import type { NotificationService } from "../notification/NotificationService";
import type { ProjectService } from "../project/ProjectService";
import type { AppSettingsStore } from "../AppSettingsStore";
import type { RemoteDeviceSummary } from "../../../shared/src/remote-contract";
import { mapRemoteAcpRun, mapRemoteHistory, mapRemoteHistoryMessage, mapRemoteModel, mapRemoteNotification, mapRemoteProject, mapRemoteSpace, mapRemoteTask } from "./RemoteDtoMapper";
import { RemoteValidationError } from "./RemoteTaskCommandService";
import { WELCOME_MODES } from "../../shared/mode-profile";

/** 模型目录缓存窗口：bootstrap 在每次 SSE/refresh 都会被调用，避免反复 await provider 目录 */
const MODEL_CACHE_TTL_MS = 30_000;
/** ACP 进程探测次数有限（which/adapter 解析）；目录只在这一窗口内复用，避免每次 bootstrap 都起子进程探测 */
const ACP_CATALOG_TTL_MS = 30_000;
const ACP_TERMINAL_STATUSES = new Set<ExternalAgentRunDto["status"]>(["completed", "failed", "cancelled"]);

function isAcpRunLive(run: ExternalAgentRunDto): boolean {
  return !ACP_TERMINAL_STATUSES.has(run.status);
}

/** ExternalAgentRunDto → 手机端运行投影（只暴露展示与续聊所需的字段）；re-export 便于测试/调用方复用 */
export { mapRemoteAcpRun };

/**
 * 任务当前真正活着的 ACP run；同任务多轮取最近一次。
 * ExternalAgentRuntime.active() 只返回内存里的 run，重启后靠它判定「不要在还在跑的 ACP 上再起一轮」。
 */
export function liveAcpRunForTask(run: ExternalAgentRunDto[], taskId: string): ExternalAgentRunDto | undefined {
  return run.filter((item) => item.taskId === taskId && isAcpRunLive(item))
    .sort((a, b) => b.startedAt - a.startedAt)[0];
}

export class RemoteAccessService {
  private readonly images: RemoteImageService;
  private modelsCache: { at: number; models: RemoteModelSummary[] } | null = null;
  private modelMutation: Promise<void> = Promise.resolve();
  private modelCacheRevision = 0;
  private acpAgentsCache: { at: number; agents: RemoteAcpAgentSummary[] } | null = null;

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
      busy: this.agent.isTaskBusy(task.id) || Boolean(this.liveAcpRun(task.id)),
      // 审批计数同时包含内置工具与 ACP 权限请求，否则手机端任务行不显示「待审批」
      pendingActionCount: this.pendingActions(task.id).length,
    }));
  }

  /**
   * ACP 外部 Agent 目录（只用描述符，不启动子进程）。ACP 管理页停用的 Agent 不投影到手机端；
   * 不可用的（CLI/adapter 缺失）保留并标记，让手机端能给出「电脑端未安装」而不是凭空消失。
   */
  listAcpAgents(refresh = false): RemoteAcpAgentSummary[] {
    const now = Date.now();
    if (!refresh && this.acpAgentsCache && now - this.acpAgentsCache.at < ACP_CATALOG_TTL_MS) {
      return this.acpAgentsCache.agents;
    }
    const agents = (this.externalAgent?.listAgents(refresh) ?? [])
      .filter((descriptor) => descriptor.enabled !== false)
      .map((descriptor): RemoteAcpAgentSummary => ({
        id: descriptor.id,
        name: descriptor.name,
        protocol: "acp",
        available: descriptor.available === true,
        availability: descriptor.availability,
        enabled: descriptor.enabled !== false,
        detail: descriptor.detail,
        commandLabel: descriptor.commandLabel,
        configOptionNames: (descriptor.configOptions ?? []).map((option) => option.name).filter(Boolean),
        // 手机端要能看出「这个 Agent 不会再打断我」：策略由电脑端 ACP 管理页保存
        permissionPolicy: descriptor.permissionPolicy ?? "ask",
      }));
    this.acpAgentsCache = { at: now, agents };
    return agents;
  }

  /** 白名单投影后的聊天模型目录（只含启用中、Provider 已认证的可执行 chat 模型） */
  async listModels(): Promise<RemoteModelSummary[]> {
    const now = Date.now();
    if (this.modelsCache && now - this.modelsCache.at < MODEL_CACHE_TTL_MS) return this.modelsCache.models;
    const revision = this.modelCacheRevision;
    const models = (await this.agent.listModels())
      .filter((model) => model.enabled !== false && model.kind !== "image-generation" && model.available !== false)
      .map(mapRemoteModel);
    if (revision === this.modelCacheRevision) this.modelsCache = { at: now, models };
    return models;
  }

  /** Force Pi's authenticated provider catalogs to reload, then replace the remote-safe projection cache. */
  async refreshModels(): Promise<RemoteModelRefreshResult> {
    const revision = ++this.modelCacheRevision;
    this.modelsCache = null;
    const result = await this.agent.reloadModels();
    const models = result.models
      .filter((model) => model.enabled !== false && model.kind !== "image-generation" && model.available !== false)
      .map(mapRemoteModel);
    if (revision === this.modelCacheRevision) this.modelsCache = { at: Date.now(), models };
    return { models, errors: result.errors };
  }

  async modelSettings(): Promise<RemoteModelSetting[]> {
    return (await this.agent.listModels())
      .filter(model => model.kind !== "image-generation" && model.available !== false)
      .map(model => ({ ...mapRemoteModel(model), enabled: model.enabled !== false, available: true }));
  }

  async setModelEnabled(id: string, enabled: boolean): Promise<RemoteModelSetting[]> {
    const operation = this.modelMutation.then(async () => {
      const catalog = await this.agent.listModels();
      const target = catalog.find(model => model.id === id && model.kind !== "image-generation" && model.available !== false);
      if (!target) throw new RemoteValidationError("模型不存在或不支持此设置");
      const selectable = catalog.filter(model => model.kind !== "image-generation" && model.available !== false && model.enabled !== false);
      if (!enabled && target.available !== false && target.enabled !== false && selectable.length <= 1) {
        throw new RemoteValidationError("至少保留一个可用模型");
      }
      const ids = new Set(catalog.filter(model => model.kind !== "image-generation" && model.enabled !== false).map(model => model.id));
      if (enabled) ids.add(id); else ids.delete(id);
      try {
        await this.agent.updateAppSettings({ enabledModels: [...ids] });
        if (!enabled) {
          const updated = await this.agent.listModels();
          const candidates = updated.filter(model => model.kind !== "image-generation" && model.available !== false && model.enabled !== false);
          const selectableIds = new Set(candidates.map(model => model.id));
          let defaultId = this.agent.getAppSettings().defaultModelId;
          if (defaultId && !selectableIds.has(defaultId) && candidates[0]) {
            defaultId = (await this.agent.updateAppSettings({ defaultModelId: candidates[0].id })).defaultModelId;
          }
          const subagent = this.agent.getSubagentConfig();
          if (subagent.defaultModel && !selectableIds.has(subagent.defaultModel)) {
            this.agent.saveSubagentConfig({ expectedRevision: subagent.revision, defaultModel: undefined, defaultReasoning: undefined });
          }
        }
      } finally {
        this.modelCacheRevision++;
        this.modelsCache = null;
      }
      return this.modelSettings();
    });
    this.modelMutation = operation.then(() => undefined, () => undefined);
    return operation;
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
      acpAgents: this.listAcpAgents(),
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
    // 外部 Agent 消息 → 手机端投影时补上 acp 运行信息（ACP 权限卡片与续聊都依赖它）
    const runsById = new Map(externalHistory.runs.map((run) => [run.runId, run]));
    const projected = externalHistory.messages.map((message) => {
      const projectedMessage = mapRemoteHistoryMessage(message);
      const runId = message.externalAgent?.runId;
      const run = runId ? runsById.get(runId) : undefined;
      if (!run) return projectedMessage;
      return { ...projectedMessage, acp: mapRemoteAcpRun(run) };
    });
    // 先在「手机端投影」这一层合并，再交给图片富化，避免把 Remote 形状塞回 ChatMessageDto
    const nativeProjected = mapRemoteHistory(taskId, nativeHistory);
    if (!projected.length) return this.images.enrichHistory(taskId, nativeProjected);
    return this.images.enrichHistory(taskId, {
      ...nativeProjected,
      messages: [...nativeProjected.messages, ...projected]
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    });
  }

  runtime(taskId: string): RemoteRuntimeSnapshot | null {
    if (!this.db.getTask(taskId)) return null;
    const snapshot = this.agent.getConversationRuntimeSnapshot(taskId);
    const live = this.liveAcpRun(taskId);
    return {
      taskId,
      busy: this.agent.isTaskBusy(taskId) || Boolean(live),
      interactions: snapshot.interactions,
      activeGoal: snapshot.activeGoal ?? null,
      pendingActions: this.pendingActions(taskId),
      acpRun: live ?? null,
    };
  }

  /**
   * 待审批动作 = 内置 Pi 工具的 PendingActionRegistry + ACP 外部 Agent 的权限请求。
   * ACP 权限请求不经过 AgentService 审批注册表（它由 ExternalAgentRuntime 的 Promise 承担），
   * 必须在同一响应里交给手机端，否则手机端永远看不到「需要授权」。
   */
  pendingActions(taskId: string): RemotePendingAction[] {
    const native = this.agent.listPendingActions(taskId);
    return [...native, ...this.acpPendingActions(taskId)];
  }

  /** 任务当前活着的 ACP run（手机端「Agent 正在执行」态与阻断发送判断） */
  liveAcpRun(taskId: string): RemoteAcpRunInfo | undefined {
    const run = this.externalAgent ? liveAcpRunForTask(this.externalAgent.active(taskId), taskId) : undefined;
    return run ? mapRemoteAcpRun(run) : undefined;
  }

  /** 任务最近一次 ACP run（含已结束）：手机端据此决定「续聊」按钮是否可用 */
  latestAcpRun(taskId: string): RemoteAcpRunInfo | undefined {
    const runs = this.externalAgent?.history(taskId).runs ?? [];
    const latest = [...runs].sort((a, b) => b.startedAt - a.startedAt)[0];
    return latest ? mapRemoteAcpRun(latest) : undefined;
  }

  /**
   * 手机端修改某 Agent 的权限策略（ask / auto-allow / auto-deny）。
   * 直接写 AppSettings，Runtime 每次权限请求都实时读设置，因此下一轮即生效（无需重启进程）。
   */
  setAcpPermissionPolicy(agentId: string, policy: RemoteAcpPermissionPolicy): RemoteAcpAgentSummary[] {
    const known = this.externalAgent?.listAgents().some((descriptor) => descriptor.id === agentId);
    if (!known) throw new RemoteValidationError("电脑端没有这个 ACP Agent");
    const current = { ...(this.settings.read().externalAgentPermissionPolicies ?? {}) };
    if (policy === "ask") delete current[agentId];
    else current[agentId] = policy;
    this.settings.write({ externalAgentPermissionPolicies: current });
    // 目录缓存立即失效；listAgents(false) 不会重新探测 CLI，只是把新策略合并进描述符
    this.acpAgentsCache = null;
    return this.listAcpAgents();
  }

  private acpPendingActions(taskId: string): RemotePendingAction[] {
    const run = this.externalAgent ? liveAcpRunForTask(this.externalAgent.active(taskId), taskId) : undefined;
    if (!run || run.status !== "blocked") return [];
    return run.pendingPermissions.map((permission) => ({
      taskId,
      assistantMessageId: run.assistantMessageId,
      toolCallId: permission.toolCallId,
      tool: permission.tool,
      summary: permission.summary,
      detail: permission.detail,
      dangerous: false,
      approvalKind: "acp" as const,
      createdAt: run.startedAt,
      acpRunId: run.runId,
      acpPermissionOptions: permission.options,
    }));
  }

  listNotifications(unreadOnly = false, limit = 100) {
    return this.notifications.list({ unreadOnly, limit }).map(mapRemoteNotification);
  }

  markNotificationRead(id: string): void { this.notifications.markRead(id); }
  markAllNotificationsRead(): void { this.notifications.markAllRead(); }
  clearAllNotifications(): void { this.notifications.dismissAll(); }
}
