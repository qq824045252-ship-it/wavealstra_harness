import type { AppDatabase } from "../db/AppDatabase";
import { AppSettingsStore } from "../AppSettingsStore";
import type { MemoryService } from "./MemoryService";
import { MemoryGatewayService } from "./MemoryGatewayService";
import { MemoryGatewayServer, MEMORY_GATEWAY_HOST } from "./MemoryGatewayServer";
import { MemoryGatewayAccessControl } from "./MemoryGatewayAccessControl";
import type {
  MemoryGatewayConfigureRequest,
  MemoryGatewayCreateGrantRequest,
  MemoryGatewayIssuedGrantDto,
  MemoryGatewayStatusDto,
  MemoryGatewayUpdateGrantRequest,
  MemoryGatewayAccessGrantDto,
} from "../../shared/memory-gateway";

function parseEnvBool(value: string | undefined): boolean | undefined {
  if (value == null || value.trim() === "") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(normalized)) return true;
  if (["0", "false", "off", "no"].includes(normalized)) return false;
  return undefined;
}

function parseEnvPort(value: string | undefined): number | undefined {
  if (value == null || value.trim() === "" || !/^\d+$/.test(value.trim())) return undefined;
  const port = Number.parseInt(value.trim(), 10);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : undefined;
}

export class MemoryGatewayController {
  readonly accessControl: MemoryGatewayAccessControl;
  private readonly settings = new AppSettingsStore();
  private server: MemoryGatewayServer | null = null;
  private activePort: number | null = null;
  private lifecycleQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: AppDatabase,
    private readonly memory: MemoryService,
    private readonly env: NodeJS.ProcessEnv = process.env,
    accessControl = new MemoryGatewayAccessControl(),
  ) {
    this.accessControl = accessControl;
  }

  async start(): Promise<MemoryGatewayStatusDto> {
    return this.runLifecycle(async () => {
      await this.syncNow();
      return this.status();
    });
  }

  async stop(): Promise<void> {
    return this.runLifecycle(() => this.stopNow());
  }

  status(): MemoryGatewayStatusDto {
    const cfg = this.effectiveConfig();
    const current = this.server?.status();
    const port = current?.port ?? this.activePort ?? cfg.port;
    let grantCount = 0;
    let grantStoreError: string | undefined;
    try {
      grantCount = this.accessControl.count();
    } catch (error) {
      grantStoreError = error instanceof Error ? error.message : String(error);
    }
    return {
      configuredEnabled: cfg.enabled,
      running: current?.running === true,
      memoryEnabled: this.settings.read().memoryEnabled !== false,
      host: MEMORY_GATEWAY_HOST,
      port,
      writeEnabled: cfg.writeEnabled,
      mcpUrl: `http://${MEMORY_GATEWAY_HOST}:${port}/mcp`,
      httpBaseUrl: `http://${MEMORY_GATEWAY_HOST}:${port}/v1/memory`,
      grantCount,
      grantStoreError,
      environmentOverrides: cfg.overrides,
    };
  }

  async configure(request: MemoryGatewayConfigureRequest): Promise<MemoryGatewayStatusDto> {
    return this.runLifecycle(async () => {
      const before = this.settings.read();
      const partial: Parameters<AppSettingsStore["write"]>[0] = {};
      if (request.enabled !== undefined) partial.memoryGatewayEnabled = request.enabled === true;
      if (request.writeEnabled !== undefined) partial.memoryGatewayWriteEnabled = request.writeEnabled === true;
      if (request.port !== undefined) {
        if (!Number.isInteger(request.port) || request.port < 1024 || request.port > 65535) {
          throw new Error("Memory Gateway 端口必须在 1024–65535 之间");
        }
        partial.memoryGatewayPort = request.port;
      }
      this.settings.write(partial);
      try {
        await this.syncNow();
        return this.status();
      } catch (error) {
        this.settings.write({
          memoryGatewayEnabled: before.memoryGatewayEnabled,
          memoryGatewayWriteEnabled: before.memoryGatewayWriteEnabled,
          memoryGatewayPort: before.memoryGatewayPort,
        });
        await this.syncNow().catch(() => undefined);
        throw error;
      }
    });
  }

  listGrants(): MemoryGatewayAccessGrantDto[] {
    return this.accessControl.list();
  }

  createGrant(request: MemoryGatewayCreateGrantRequest): MemoryGatewayIssuedGrantDto {
    this.validateScopeExists(request.scopeType, request.scopeId);
    return this.accessControl.create(request);
  }

  updateGrant(request: MemoryGatewayUpdateGrantRequest): MemoryGatewayAccessGrantDto {
    const current = this.accessControl.list().find((item) => item.id === request.id);
    if (!current) throw new Error(`授权不存在：${request.id}`);
    this.validateScopeExists(request.scopeType ?? current.scopeType, request.scopeId === undefined ? current.scopeId : request.scopeId ?? undefined);
    return this.accessControl.update(request);
  }

  rotateGrant(id: string): MemoryGatewayIssuedGrantDto {
    return this.accessControl.rotate(id);
  }

  deleteGrant(id: string): void {
    this.accessControl.delete(id);
  }

  private async syncNow(): Promise<void> {
    const cfg = this.effectiveConfig();
    if (!cfg.enabled) {
      await this.stopNow();
      return;
    }
    // Corrupt delegated-grant state must fail closed before a loopback listener is opened.
    this.accessControl.validate();
    if (this.server && this.activePort === cfg.port) return;

    const gateway = new MemoryGatewayService(this.db, this.memory, {
      isWriteEnabled: () => this.effectiveConfig().writeEnabled,
      isMemoryEnabled: () => this.settings.read().memoryEnabled !== false,
    });
    const candidate = new MemoryGatewayServer(gateway, {
      port: cfg.port,
      accessControl: this.accessControl,
    });
    await candidate.start();
    const previous = this.server;
    this.server = candidate;
    this.activePort = cfg.port;
    await previous?.stop();
  }

  private async stopNow(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.activePort = null;
    await server?.stop();
  }

  private runLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.lifecycleQueue.then(operation, operation);
    this.lifecycleQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private effectiveConfig(): {
    enabled: boolean;
    writeEnabled: boolean;
    port: number;
    overrides: MemoryGatewayStatusDto["environmentOverrides"];
  } {
    const app = this.settings.read();
    const envEnabled = parseEnvBool(this.env.MYBUDDY_MEMORY_GATEWAY_ENABLED);
    const envWrite = parseEnvBool(this.env.MYBUDDY_MEMORY_GATEWAY_WRITE);
    const envPort = parseEnvPort(this.env.MYBUDDY_MEMORY_GATEWAY_PORT);
    const overrideEnabled = envEnabled !== undefined;
    const overrideWrite = envWrite !== undefined;
    const overridePort = envPort !== undefined;
    return {
      enabled: envEnabled ?? app.memoryGatewayEnabled,
      writeEnabled: envWrite ?? app.memoryGatewayWriteEnabled,
      port: envPort ?? app.memoryGatewayPort,
      overrides: { enabled: overrideEnabled, writeEnabled: overrideWrite, port: overridePort },
    };
  }

  private validateScopeExists(scopeType: MemoryGatewayCreateGrantRequest["scopeType"], scopeId?: string): void {
    const id = scopeId?.trim();
    if (scopeType === "all" || scopeType === "global") return;
    if (!id) throw new Error(`${scopeType} 授权必须选择具体范围`);
    if (scopeType === "task" && !this.db.getTask(id)) throw new Error(`任务不存在：${id}`);
    if (scopeType === "workspace" && !this.db.getSpace(id)) throw new Error(`工作空间不存在：${id}`);
    if (scopeType === "project") {
      const row = this.db.connection.prepare("SELECT 1 FROM projects WHERE id=?").get(id);
      if (!row) throw new Error(`项目不存在：${id}`);
    }
  }
}
