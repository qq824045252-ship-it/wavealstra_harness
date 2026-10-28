import type { RemoteArtifactReader } from './RemoteImageService';
import type { NotificationChangedEvent } from "../../shared/notification";
import type { ExternalAgentUiEvent } from "../../shared/external-agent";
import type { AppDatabase } from "../db/AppDatabase";
import type { AgentService } from "../agent/AgentService";
import type { ExternalAgentRuntime } from "../external-agent/ExternalAgentRuntime";
import type { NotificationService } from "../notification/NotificationService";
import type { ProjectService } from "../project/ProjectService";
import { join } from "node:path";
import { getMyBuddyDir } from "../paths";
import { AppSettingsStore } from "../AppSettingsStore";
import type { RemoteConfigureRequest, RemoteStatus } from "../../../shared/src/remote-contract";
import { RemoteAccessPairing } from "./RemoteAccessPairing";
import { RemotePairWindow } from "./RemotePairWindow";
import { RemoteAccessServer } from "./RemoteAccessServer";
import { RemoteAccessService } from "./RemoteAccessService";
import { RemoteDeviceStore } from "./RemoteDeviceStore";
import { RemoteEventBus, mapAgentPatchToRemoteEvent } from "./RemoteEventBus";
import { RemoteTaskCommandService, type RemoteTrashLifecycle, type RemoteWorkGraphCleanup } from "./RemoteTaskCommandService";
import { remoteConfigureSchema } from "./remoteSchemas";
import { isAllowedRemoteBaseUrl } from "./RemoteNetwork";

export class RemoteAccessController {
  private readonly settings = new AppSettingsStore();
  private readonly devices = new RemoteDeviceStore();
  private readonly pairing = new RemoteAccessPairing(this.devices);
  private readonly pairWindow = new RemotePairWindow();
  private readonly events = new RemoteEventBus();
  private readonly service: RemoteAccessService;
  private readonly commands: RemoteTaskCommandService;
  private server: RemoteAccessServer | null = null;
  private runningPort: number | null = null;
  private lastError: string | undefined;
  private lifecycle: Promise<unknown> = Promise.resolve();
  private readonly unsubscribePatch: () => void;

  constructor(
    db: AppDatabase,
    private readonly agent: AgentService,
    notifications: NotificationService,
    projects: ProjectService,
    private readonly staticRoot: string,
    private readonly externalAgent?: ExternalAgentRuntime,
    artifactSource?: () => RemoteArtifactReader | null | undefined,
    /** 桌面端同一条安全回收 + 工作图清理链路，供手机端删除复用 */
    lifecycle?: RemoteTrashLifecycle,
    workGraph?: RemoteWorkGraphCleanup,
  ) {
    this.service = new RemoteAccessService(db, agent, notifications, projects, this.settings, externalAgent, artifactSource);
    // ACP 委托：手机端发起的一轮外部 Agent 执行走同一个 ExternalAgentRuntime（进程留在电脑端）
    this.commands = new RemoteTaskCommandService(db, agent, this.settings, projects,
      join(getMyBuddyDir(), "remote-uploads"), lifecycle, workGraph, externalAgent);
    this.unsubscribePatch = agent.onPatch((patch) => {
      this.events.publish("agent.patch", mapAgentPatchToRemoteEvent(patch));
      if (patch.type === "tool_start" || patch.type === "tool_update") {
        queueMicrotask(() => this.events.publish("pending_action.changed", {
          taskId: patch.taskId,
          pendingActions: this.service.pendingActions(patch.taskId),
        }));
      }
      if (patch.type === "user_message" || patch.type === "assistant_start" || patch.type === "assistant_end") {
        this.events.publish("task.changed", { taskId: patch.taskId });
      }
    });
  }

  status(): RemoteStatus {
    const settings = this.settings.read();
    return {
      configuredEnabled: settings.remoteAccessEnabled,
      running: this.server !== null,
      port: this.runningPort ?? settings.remoteAccessPort,
      baseUrl: settings.remoteAccessBaseUrl,
      error: this.lastError,
    };
  }

  start(): Promise<RemoteStatus> { return this.enqueue(() => this.startNow()); }
  stop(): Promise<void> { return this.enqueue(() => this.stopNow()); }

  configure(request: RemoteConfigureRequest): Promise<RemoteStatus> {
    return this.enqueue(async () => {
      const validated = remoteConfigureSchema.parse(request);
      if (validated.baseUrl?.trim() && !isAllowedRemoteBaseUrl(validated.baseUrl)) {
        throw new Error("Remote Access 地址必须是 HTTPS，或受信任局域网/本机 HTTP 地址");
      }
      const previous = this.settings.read();
      const next = this.settings.write({
        remoteAccessEnabled: validated.enabled ?? previous.remoteAccessEnabled,
        remoteAccessPort: validated.port ?? previous.remoteAccessPort,
        remoteAccessBaseUrl: validated.baseUrl ?? previous.remoteAccessBaseUrl,
      });
      try {
        await this.stopNow();
        if (next.remoteAccessEnabled) await this.startNow();
        this.events.publish("server.status", this.status());
        return this.status();
      } catch (error) {
        this.settings.write({
          remoteAccessEnabled: previous.remoteAccessEnabled,
          remoteAccessPort: previous.remoteAccessPort,
          remoteAccessBaseUrl: previous.remoteAccessBaseUrl,
        });
        await this.stopNow();
        if (previous.remoteAccessEnabled) await this.startNow().catch(() => undefined);
        throw error;
      }
    });
  }

  listDevices() { return this.devices.list(); }
  revokeDevice(id: string): boolean { return this.devices.revoke(id); }
  createPairingSession() {
    const settings = this.settings.read();
    if (!settings.remoteAccessEnabled || !this.server) {
      throw new Error("Remote Access 服务未运行，请先启用并确认服务状态正常");
    }
    const baseUrl = settings.remoteAccessBaseUrl.trim();
    if (!baseUrl) {
      throw new Error("当前没有手机可访问的配对地址：请先填写 Tailscale / Cloudflare 连接地址");
    }
    return this.pairing.create(baseUrl);
  }
  /** 桌面端点击“允许新设备接入”：开 60 秒窗口并返回一次性 6 位配对码 */
  openPairWindow() {
    if (!this.server) throw new Error("Remote Access 服务未运行，请先启用服务");
    return this.pairWindow.open();
  }
  closePairWindow() { this.pairWindow.close(); }
  pairWindowState() { return this.pairWindow.state(); }
  cancelPairingSession(id: string): void { this.pairing.cancel(id); }
  publishArtifactChanged(taskId: string): void { this.events.publish('task.changed', { taskId }); }
  publishNotificationChanged(event: NotificationChangedEvent): void { this.events.publish("notification.changed", event); }

  /**
   * ACP 外部 Agent 的 UI 事件走的不是 AgentService.onPatch，必须在这里
   * 单独桥进事件总线，否则手机端看不到外部 Agent 的流式输出。
   */
  publishExternalAgentEvent(event: ExternalAgentUiEvent): void {
    const patch = event.patch;
    this.events.publish("agent.patch", mapAgentPatchToRemoteEvent(patch));
    if (patch.type === "assistant_start" || patch.type === "assistant_end") {
      this.events.publish("task.changed", { taskId: patch.taskId });
    }
    // ACP 权限请求由 ExternalAgentRuntime 的 Promise 承担，不会走内置 PendingActionRegistry；
    // 手机端的审批卡片数据来自 runtime()，这里必须主动推一次让它刷新。
    if (patch.type === "tool_start" || patch.type === "tool_update") {
      const taskId = patch.taskId;
      queueMicrotask(() => this.events.publish("pending_action.changed", {
        taskId,
        pendingActions: this.service.pendingActions(taskId),
        acpRun: this.service.liveAcpRun(taskId) ?? null,
      }));
    }
  }

  async dispose(): Promise<void> {
    this.unsubscribePatch();
    await this.stop();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.lifecycle.then(operation, operation);
    this.lifecycle = next.catch(() => undefined);
    return next;
  }

  private async startNow(): Promise<RemoteStatus> {
    const settings = this.settings.read();
    if (!settings.remoteAccessEnabled) return this.status();
    if (this.server) return this.status();
    const server = new RemoteAccessServer({
      port: settings.remoteAccessPort,
      baseUrl: settings.remoteAccessBaseUrl,
      staticRoot: this.staticRoot,
      devices: this.devices,
      pairing: this.pairing,
      pairWindow: this.pairWindow,
      service: this.service,
      commands: this.commands,
      events: this.events,
    });
    try {
      const address = await server.start();
      this.server = server;
      this.runningPort = address.port;
      this.lastError = undefined;
      return this.status();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      await server.stop().catch(() => undefined);
      throw error;
    }
  }

  private async stopNow(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.runningPort = null;
    if (server) await server.stop();
  }
}
