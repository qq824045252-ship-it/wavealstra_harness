import type { RemoteArtifactReader } from './RemoteImageService';
import type { NotificationChangedEvent } from "../../shared/notification";
import type { ExternalAgentUiEvent } from "../../shared/external-agent";
import type { AppDatabase } from "../db/AppDatabase";
import type { AgentService } from "../agent/AgentService";
import type { ExternalAgentRuntime } from "../external-agent/ExternalAgentRuntime";
import type { NotificationService } from "../notification/NotificationService";
import type { ProjectService } from "../project/ProjectService";
import { AppSettingsStore } from "../AppSettingsStore";
import type { RemoteConfigureRequest, RemoteStatus } from "../../../shared/src/remote-contract";
import { RemoteAccessPairing } from "./RemoteAccessPairing";
import { RemoteAccessServer } from "./RemoteAccessServer";
import { RemoteAccessService } from "./RemoteAccessService";
import { RemoteDeviceStore } from "./RemoteDeviceStore";
import { RemoteEventBus, mapAgentPatchToRemoteEvent } from "./RemoteEventBus";
import { RemoteTaskCommandService } from "./RemoteTaskCommandService";
import { RemoteUsbBridge } from "./RemoteUsbBridge";
import { remoteConfigureSchema } from "./remoteSchemas";
import { isAllowedRemoteBaseUrl, listLanIpv4Addresses, resolveRemotePairingBaseUrl } from "./RemoteNetwork";
import { RemoteDiscoveryService } from "./RemoteDiscoveryService";

export class RemoteAccessController {
  private readonly settings = new AppSettingsStore();
  private readonly devices = new RemoteDeviceStore();
  private readonly pairing = new RemoteAccessPairing(this.devices);
  private readonly events = new RemoteEventBus();
  private readonly usb = new RemoteUsbBridge();
  private readonly discovery = new RemoteDiscoveryService();
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
  ) {
    this.service = new RemoteAccessService(db, agent, notifications, projects, this.settings, externalAgent, artifactSource);
    this.commands = new RemoteTaskCommandService(db, agent, this.settings, projects);
    this.unsubscribePatch = agent.onPatch((patch) => {
      this.events.publish("agent.patch", mapAgentPatchToRemoteEvent(patch));
      if (patch.type === "tool_start" || patch.type === "tool_update") {
        queueMicrotask(() => this.events.publish("pending_action.changed", {
          taskId: patch.taskId,
          pendingActions: agent.listPendingActions(patch.taskId),
        }));
      }
      if (patch.type === "user_message" || patch.type === "assistant_start" || patch.type === "assistant_end") {
        this.events.publish("task.changed", { taskId: patch.taskId });
      }
    });
  }

  status(): RemoteStatus {
    const settings = this.settings.read();
    const port = this.runningPort ?? settings.remoteAccessPort;
    const bindMode = settings.remoteAccessBindMode === "lan" ? "lan" : "loopback";
    return {
      configuredEnabled: settings.remoteAccessEnabled,
      running: this.server !== null,
      bindMode,
      host: bindMode === "lan" ? "0.0.0.0" : "127.0.0.1",
      port,
      baseUrl: settings.remoteAccessBaseUrl,
      lanUrls: bindMode === "lan" ? listLanIpv4Addresses().map((address) => `http://${address}:${port}`) : [],
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
        remoteAccessBindMode: validated.bindMode ?? previous.remoteAccessBindMode,
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
          remoteAccessBindMode: previous.remoteAccessBindMode,
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
    const baseUrl = resolveRemotePairingBaseUrl({
      baseUrl: settings.remoteAccessBaseUrl,
      bindMode: settings.remoteAccessBindMode === "lan" ? "lan" : "loopback",
      port: this.runningPort ?? settings.remoteAccessPort,
    });
    if (!baseUrl) {
      throw new Error("当前没有手机可访问的配对地址：请先配置 Tailscale HTTPS 地址，或切换到局域网模式");
    }
    return this.pairing.create(baseUrl);
  }
  usbStatus() { return this.usb.status(); }
  pairUsb(serial: string) {
    return this.enqueue(async () => {
      const settings = this.settings.read();
      if (!settings.remoteAccessEnabled) throw new Error("请先启用 Remote Access");
      if (!this.server) await this.startNow();
      const port = this.runningPort ?? settings.remoteAccessPort;
      const session = this.pairing.create(`http://127.0.0.1:${port}`);
      try {
        const device = await this.usb.prepare(serial, port, session.pairingUrl);
        return { device, session, port };
      } catch (error) {
        this.pairing.cancel(session.pairingId);
        throw error;
      }
    });
  }
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
      host: settings.remoteAccessBindMode === "lan" ? "0.0.0.0" : "127.0.0.1",
      port: settings.remoteAccessPort,
      baseUrl: settings.remoteAccessBaseUrl,
      staticRoot: this.staticRoot,
      devices: this.devices,
      pairing: this.pairing,
      service: this.service,
      commands: this.commands,
      events: this.events,
    });
    try {
      const address = await server.start();
      this.server = server;
      this.runningPort = address.port;
      this.lastError = undefined;
      if (settings.remoteAccessBindMode === "lan") {
        await this.discovery.start(address.port);
      } else {
        await this.discovery.stop();
      }
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
    await this.discovery.stop();
    if (server) await server.stop();
  }
}
