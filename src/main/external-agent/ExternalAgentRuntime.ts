import { randomUUID } from "node:crypto";
import { commandCodeAcpEnv, devinDesktopBundledCli, spawnExternalCliCommand, whereFirst } from "../platform/apps";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AppDatabase } from "../db/AppDatabase";
import { snapshotWorkspace } from "../workspace/WorkspaceService";
import type { AgentUiPatch, ChatToolCallDto } from "../../shared/agent-ipc";
import type {
  ExternalAgentConfigOptionDto,
  ExternalAgentConfigOptionValueDto,
  ExternalAgentConfigSelections,
  ExternalAgentDescriptorDto,
  ExternalAgentHistoryDto,
  ExternalAgentId,
  ExternalAgentContinuationMode,
  ExternalAgentPermissionOptionDto,
  ExternalAgentPermissionPolicy,
  ExternalAgentPromptRequest,
  ExternalAgentPromptResult,
  ExternalAgentResolvePermissionRequest,
  ExternalAgentRunDto,
  ExternalAgentRunStatus,
  ExternalAgentTestResultDto,
  ExternalAgentTestStepDto,
  ExternalAgentUiEvent,
} from "../../shared/external-agent";
import {
  normalizeExternalAgentPermissionPolicy,
  resolvePolicyPermissionOptionId,
} from "../../shared/external-agent";

interface Manifest {
  id: ExternalAgentId;
  name: string;
  nativeCommand?: string;
  nativeArgs?: string[];
  requiredCli?: string;
  adapterPackage?: string;
  adapterKind?: "official" | "community";
  commandLabel: string;
  /** 未检测到 nativeCommand 时给用户的安装提示（仅用于 detail 文案）。 */
  installHint?: string;
}

const MANIFESTS: Manifest[] = [
  { id: "codex", name: "Codex", requiredCli: "codex", adapterPackage: "@agentclientprotocol/codex-acp", commandLabel: "codex-acp" },
  { id: "claude", name: "Claude", adapterPackage: "@agentclientprotocol/claude-agent-acp", commandLabel: "claude-agent-acp" },
  { id: "grok", name: "Grok", nativeCommand: "grok", nativeArgs: ["agent", "stdio"], commandLabel: "grok agent stdio" },
  { id: "cline", name: "Cline", nativeCommand: "cline", nativeArgs: ["--acp"], commandLabel: "cline --acp" },
  { id: "opencode", name: "OpenCode", nativeCommand: "opencode", nativeArgs: ["acp"], commandLabel: "opencode acp" },
  { id: "devin", name: "Devin", nativeCommand: "devin", nativeArgs: ["acp"], commandLabel: "devin acp" },
  { id: "agy", name: "Antigravity", requiredCli: "agy", adapterPackage: "@ovftank/agy-acp", adapterKind: "community", commandLabel: "agy-acp" },
  { id: "dim", name: "DIM", nativeCommand: "dim", nativeArgs: ["acp"], commandLabel: "dim acp" },
  { id: "command", name: "Command Code", requiredCli: "cmdc", adapterPackage: "command-code-acp", adapterKind: "community", commandLabel: "command-code-acp" },
  // DeepSeek Harness 的 ACP 服务是 profile，不是独立 bin：`dsh --profile acp`
  // 在 stdio 上提供 ACP v1（initialize / session new|resume|list|close / prompt）。
  { id: "dsh", name: "DeepSeek Harness", nativeCommand: "dsh", nativeArgs: ["--profile", "acp"], commandLabel: "dsh --profile acp", installHint: "npm install -g @deepseek-ai/dsh" },
];

const DEFAULT_DEVIN_WINDSURF_VERSION = "1.110.1";
const TEST_TIMEOUT_MS = 60_000;

function isTerminalAuthMethod(method: acp.AuthMethod): boolean {
  return "type" in method && method.type === "terminal";
}

function parseExtensionParams(params: unknown): Record<string, unknown> {
  return params && typeof params === "object" && !Array.isArray(params)
    ? params as Record<string, unknown>
    : {};
}

interface StoredTool {
  id: string;
  tool: string;
  summary: string;
  detail?: string;
  output?: string;
  status: "pending_approval" | "running" | "success" | "error" | "denied";
}

interface ActiveRun {
  dto: ExternalAgentRunDto;
  process?: ChildProcessWithoutNullStreams;
  context?: acp.ClientContext;
  sessionId?: string;
  replayingHistory?: boolean;
  continuation?: { sourceRunId: string; sessionId: string };
  cancelled: boolean;
}

interface PendingPermission {
  runId: string;
  toolCallId: string;
  options: ExternalAgentPermissionOptionDto[];
  resolve: (response: acp.RequestPermissionResponse) => void;
}

/**
 * ACP 会话级配置（configOptions）的读取/持久化门面：用户偏好（selections）
 * 与最近探测到的选项快照（options）都落在 AppSettings，由 main/index.ts 注入。
 */
export interface ExternalAgentSessionConfigStore {
  readSelections: (agentId: ExternalAgentId) => ExternalAgentConfigSelections;
  readOptions: (agentId: ExternalAgentId) => ExternalAgentConfigOptionDto[];
  writeOptions: (agentId: ExternalAgentId, options: ExternalAgentConfigOptionDto[]) => void;
}

/** acp.SessionConfigOption → DTO：select 的 group 结构展平为带 group 名的扁平列表。 */
function toConfigOptionDto(option: acp.SessionConfigOption): ExternalAgentConfigOptionDto | null {
  const id = typeof option.id === "string" ? option.id.trim() : "";
  const name = typeof option.name === "string" ? option.name.trim() : "";
  if (!id || !name) return null;
  const dto: ExternalAgentConfigOptionDto = {
    id,
    name,
    type: option.type === "boolean" ? "boolean" : "select",
    currentValue: "",
  };
  if (typeof option.description === "string" && option.description.trim()) dto.description = option.description;
  if (typeof option.category === "string" && option.category.trim()) dto.category = option.category;
  if (dto.type === "boolean") {
    dto.currentValue = (option as { currentValue?: unknown }).currentValue === true;
    return dto;
  }
  const select = option as { currentValue?: unknown; options?: unknown };
  dto.currentValue = typeof select.currentValue === "string" ? select.currentValue : "";
  const values: ExternalAgentConfigOptionValueDto[] = [];
  const pushValue = (item: unknown, group?: string): void => {
    if (!item || typeof item !== "object") return;
    const entry = item as { value?: unknown; name?: unknown; description?: unknown };
    if (typeof entry.value !== "string" || !entry.value || typeof entry.name !== "string" || !entry.name.trim()) return;
    const value: ExternalAgentConfigOptionValueDto = { value: entry.value, name: entry.name.trim() };
    if (typeof entry.description === "string" && entry.description.trim()) value.description = entry.description;
    if (group) value.group = group;
    values.push(value);
  };
  for (const item of Array.isArray(select.options) ? select.options : []) {
    if (item && typeof item === "object" && Array.isArray((item as { options?: unknown }).options)) {
      const group = item as { name?: unknown; options: unknown[] };
      const groupName = typeof group.name === "string" && group.name.trim() ? group.name.trim() : undefined;
      for (const child of group.options) pushValue(child, groupName);
    } else {
      pushValue(item);
    }
  }
  dto.options = values;
  return dto;
}

function toConfigOptionDtos(options: acp.SessionConfigOption[] | null | undefined): ExternalAgentConfigOptionDto[] {
  if (!Array.isArray(options)) return [];
  return options
    .map(toConfigOptionDto)
    .filter((item): item is ExternalAgentConfigOptionDto => item !== null);
}

function resolveNativeCommand(manifest: Manifest): string | null {
  if (!manifest.nativeCommand) return null;
  const onPath = whereFirst(manifest.nativeCommand);
  if (onPath) return onPath;
  if (manifest.id === "devin") {
    const bundled = devinDesktopBundledCli();
    if (bundled) return bundled;
  }
  return null;
}

function resolveAdapterEntry(packageName: string): string | null {
  try {
    const packageJsonPath = require.resolve(`${packageName}/package.json`);
    const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      bin?: string | Record<string, string>;
    };
    const bin = typeof manifest.bin === "string"
      ? manifest.bin
      : manifest.bin && Object.values(manifest.bin)[0];
    return bin ? resolvePath(dirname(packageJsonPath), bin) : null;
  } catch {
    return null;
  }
}

function spawnBundledAdapter(
  entry: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [entry], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
  });
}

function stringifyBounded(value: unknown, max = 12_000): string | undefined {
  if (value == null) return undefined;
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try { text = JSON.stringify(value, null, 2); }
    catch { text = String(value); }
  }
  return text.length > max ? `${text.slice(0, max)}\n…（已截断）` : text;
}

function mapToolStatus(status: acp.ToolCallStatus | null | undefined): StoredTool["status"] {
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  return "running";
}

export class ExternalAgentRuntime {
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly permissions = new Map<string, PendingPermission>();
  private descriptorsCache: ExternalAgentDescriptorDto[] | null = null;
  private send: ((event: ExternalAgentUiEvent) => void) | null = null;

  constructor(
    private readonly db: AppDatabase,
    private readonly resolveCwd: (taskId: string) => string,
    private readonly emitWorkspaceChanges?: (
      taskId: string,
      messageId: string,
      before: Map<string, string>,
    ) => Promise<string[]>,
    private readonly readDisabledAgentIds: () => string[] = () => [],
    private readonly sessionConfig?: ExternalAgentSessionConfigStore,
    /** ACP 权限策略：agentId → ask | auto-allow | auto-deny（桌面 ACP 管理页保存）。 */
    private readonly readPermissionPolicies: () => Record<string, ExternalAgentPermissionPolicy> = () => ({}),
  ) {
    this.ensureSchema();
    // 上一次 MyBuddy 进程异常退出时，不允许把无主 ACP Run 永久显示为 running/blocked。
    this.db.connection.prepare(`
      UPDATE external_agent_runs
         SET status='failed',
             completed_at=COALESCE(completed_at, ?),
             error=COALESCE(error, 'MyBuddy 已重启，上一轮外部子任务已中断。'),
             recovery_state=CASE
               WHEN session_id IS NOT NULL AND resume_supported=1 THEN 'resume-available'
               ELSE 'new-run-required'
             END,
             cancel_supported=0,
             recovery_message=CASE
               WHEN session_id IS NOT NULL AND resume_supported=1 THEN '应用重启后原进程已不存在；可基于原 session 续聊，续聊前请先核对工作目录与已有产物。'
               ELSE '应用重启后原进程已不存在，且没有可恢复 session；请核对已有输出/产物后新建执行。'
             END
       WHERE status IN ('starting','working','blocked')
    `).run(Date.now());
  }

  setSend(send: (event: ExternalAgentUiEvent) => void): void {
    this.send = send;
  }

  private ensureSchema(): void {
    this.db.connection.exec(`
      CREATE TABLE IF NOT EXISTS external_agent_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        protocol TEXT NOT NULL DEFAULT 'acp',
        status TEXT NOT NULL,
        cwd TEXT NOT NULL,
        session_id TEXT,
        user_message_id TEXT NOT NULL,
        assistant_message_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        display_text TEXT,
        attachments_json TEXT,
        final_text TEXT NOT NULL DEFAULT '',
        thinking_text TEXT NOT NULL DEFAULT '',
        tools_json TEXT NOT NULL DEFAULT '[]',
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        error TEXT,
        continued_from_run_id TEXT,
        continuation_mode TEXT,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_external_agent_runs_task_started
        ON external_agent_runs(task_id, started_at);
    `);
    const columns = this.db.connection.prepare(`PRAGMA table_info(external_agent_runs)`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "display_text")) {
      this.db.connection.exec(`ALTER TABLE external_agent_runs ADD COLUMN display_text TEXT`);
    }
    if (!columns.some((column) => column.name === "continued_from_run_id")) {
      this.db.connection.exec(`ALTER TABLE external_agent_runs ADD COLUMN continued_from_run_id TEXT`);
    }
    if (!columns.some((column) => column.name === "continuation_mode")) {
      this.db.connection.exec(`ALTER TABLE external_agent_runs ADD COLUMN continuation_mode TEXT`);
    }
    if (!columns.some((column) => column.name === "output_cursor")) {
      this.db.connection.exec(`ALTER TABLE external_agent_runs ADD COLUMN output_cursor INTEGER NOT NULL DEFAULT 0`);
    }
    if (!columns.some((column) => column.name === "artifact_refs_json")) {
      this.db.connection.exec(`ALTER TABLE external_agent_runs ADD COLUMN artifact_refs_json TEXT NOT NULL DEFAULT '[]'`);
    }
    if (!columns.some((column) => column.name === "resume_supported")) {
      this.db.connection.exec(`ALTER TABLE external_agent_runs ADD COLUMN resume_supported INTEGER NOT NULL DEFAULT 0`);
    }
    if (!columns.some((column) => column.name === "cancel_supported")) {
      this.db.connection.exec(`ALTER TABLE external_agent_runs ADD COLUMN cancel_supported INTEGER NOT NULL DEFAULT 1`);
    }
    if (!columns.some((column) => column.name === "verification_status")) {
      this.db.connection.exec(`ALTER TABLE external_agent_runs ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'not_verified'`);
    }
    if (!columns.some((column) => column.name === "recovery_state")) {
      this.db.connection.exec(`ALTER TABLE external_agent_runs ADD COLUMN recovery_state TEXT NOT NULL DEFAULT 'none'`);
    }
    if (!columns.some((column) => column.name === "recovery_message")) {
      this.db.connection.exec(`ALTER TABLE external_agent_runs ADD COLUMN recovery_message TEXT`);
    }
  }

  /** Runtime detection lasts until explicit refresh; settings are merged on every read. */
  listAgents(refresh = false): ExternalAgentDescriptorDto[] {
    if (refresh || !this.descriptorsCache) {
      this.descriptorsCache = this.probeAgents();
    }
    const disabled = new Set(this.readDisabledAgentIds());
    return this.descriptorsCache.map((descriptor) => {
      const configOptions = this.sessionConfig?.readOptions(descriptor.id);
      const configSelections = this.sessionConfig?.readSelections(descriptor.id);
      return {
        ...descriptor,
        enabled: !disabled.has(descriptor.id),
        permissionPolicy: this.permissionPolicyOf(descriptor.id),
        ...(configOptions?.length ? { configOptions } : {}),
        ...(configSelections && Object.keys(configSelections).length ? { configSelections } : {}),
      };
    });
  }

  /** 读取某 Agent 的权限策略（缺省 ask；配置损坏也按 ask 处理，绝不静默放行）。 */
  permissionPolicyOf(agentId: ExternalAgentId | string): ExternalAgentPermissionPolicy {
    try {
      return normalizeExternalAgentPermissionPolicy(this.readPermissionPolicies()[agentId]);
    } catch {
      return "ask";
    }
  }

  private isAgentEnabled(id: ExternalAgentId): boolean {
    return !this.readDisabledAgentIds().includes(id);
  }

  private probeAgents(): ExternalAgentDescriptorDto[] {
    return MANIFESTS.map((manifest) => {
      if (manifest.adapterPackage) {
        const adapterReady = Boolean(resolveAdapterEntry(manifest.adapterPackage));
        const cliReady = manifest.requiredCli ? Boolean(whereFirst(manifest.requiredCli)) : true;
        const available = adapterReady && cliReady;
        return {
          id: manifest.id,
          name: manifest.name,
          protocol: "acp" as const,
          available,
          availability: available ? "adapter" as const : "missing" as const,
          commandLabel: manifest.commandLabel,
          enabled: true,
          detail: available
            ? manifest.adapterKind === "community"
              ? `MyBuddy \u793e\u533a ACP Bridge + \u672c\u673a ${manifest.requiredCli || "CLI"}`
              : manifest.requiredCli
                ? `MyBuddy \u5b98\u65b9 ACP adapter + \u672c\u673a ${manifest.requiredCli} CLI`
                : "MyBuddy \u81ea\u5e26\u5b98\u65b9 ACP adapter"
            : !adapterReady
              ? `MyBuddy \u672a\u627e\u5230 ${manifest.adapterPackage}`
              : `\u672a\u68c0\u6d4b\u5230 ${manifest.requiredCli} CLI`,
        };
      }
      const resolvedNative = resolveNativeCommand(manifest);
      const available = Boolean(resolvedNative);
      const detail = available
        ? "原生 ACP Runtime"
        : manifest.installHint
          ? `未检测到 ${manifest.nativeCommand}，先运行 ${manifest.installHint}`
          : `未检测到 ${manifest.nativeCommand}`;
      return {
        id: manifest.id,
        name: manifest.name,
        protocol: "acp" as const,
        available,
        availability: available ? "ready" as const : "missing" as const,
        commandLabel: manifest.commandLabel,
        enabled: true,
        detail,
      };
    });
  }

  active(taskId?: string): ExternalAgentRunDto[] {
    return [...this.activeRuns.values()]
      .map((run) => run.dto)
      .filter((run) => ["starting", "working", "blocked"].includes(run.status))
      .filter((run) => !taskId || run.taskId === taskId)
      .map((run) => ({ ...run }));
  }

  /** Cancellation marks the UI finished before its process has actually closed. */
  hasLiveTaskRun(taskId: string): boolean {
    return [...this.activeRuns.values()].some((run) => run.dto.taskId === taskId);
  }

  prompt(request: ExternalAgentPromptRequest): ExternalAgentPromptResult {
    const manifest = MANIFESTS.find((item) => item.id === request.agentId);
    if (!manifest) throw new Error(`不支持的外部 Agent：${request.agentId}`);
    if (!this.isAgentEnabled(request.agentId)) {
      throw new Error(`${manifest.name} 已在「设置 → ACP 管理」中停用`);
    }
    const descriptor = this.listAgents().find((item) => item.id === request.agentId);
    if (!descriptor?.available) throw new Error(descriptor?.detail || `${manifest.name} ACP Runtime 不可用`);

    const cwd = this.resolveCwd(request.taskId);
    let continuation: ActiveRun["continuation"];
    if (request.continueFromRunId?.trim()) {
      const source = this.db.connection.prepare(`
        SELECT id, task_id, agent_id, cwd, session_id FROM external_agent_runs WHERE id=?
      `).get(request.continueFromRunId.trim()) as { id: string; task_id: string; agent_id: string; cwd: string; session_id: string | null } | undefined;
      if (!source) throw new Error("找不到要续聊的 ACP Run");
      if (source.task_id !== request.taskId) throw new Error("ACP 续聊不能跨 Task");
      if (source.agent_id !== request.agentId) throw new Error("ACP 续聊必须使用同一个 Agent");
      if (!source.session_id) throw new Error("上一轮 ACP 没有可恢复的 sessionId");
      if (resolvePath(source.cwd).toLowerCase() !== resolvePath(cwd).toLowerCase()) {
        throw new Error("当前 Task 项目路径已变化，不能恢复原 ACP session；请新建会话");
      }
      continuation = { sourceRunId: source.id, sessionId: source.session_id };
    }
    const runId = randomUUID();
    const startedAt = Date.now();
    const dto: ExternalAgentRunDto = {
      runId,
      taskId: request.taskId,
      parentTaskId: request.taskId,
      agentId: request.agentId,
      agentName: manifest.name,
      agent: { id: request.agentId, name: manifest.name },
      protocol: "acp",
      status: "starting",
      cwd,
      userMessageId: request.userMessageId,
      assistantMessageId: request.assistantMessageId,
      startedAt,
      outputCursor: 0,
      artifactRefs: [],
      pendingPermissions: [],
      capabilities: { cancelSupported: true, resumeSupported: false },
      verification: { status: "not_verified", message: "尚未完成工作目录观察；传输状态不等于业务验证。" },
      recovery: { state: "none" },
      diagnostics: {
        protocol: "acp",
        commandLabel: manifest.commandLabel,
        adapterKind: manifest.adapterPackage ? (manifest.adapterKind ?? "official") : "native",
      },
      continuedFromRunId: continuation?.sourceRunId,
      continuationMode: continuation ? undefined : "new",
    };
    this.db.connection.prepare(`
      INSERT INTO external_agent_runs (
        id, task_id, agent_id, agent_name, protocol, status, cwd,
        user_message_id, assistant_message_id, prompt, display_text, attachments_json, started_at,
        continued_from_run_id, continuation_mode
      ) VALUES (?, ?, ?, ?, 'acp', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      request.taskId,
      request.agentId,
      manifest.name,
      dto.status,
      cwd,
      request.userMessageId,
      request.assistantMessageId,
      request.text,
      request.displayText ?? request.text,
      JSON.stringify(request.attachments ?? []),
      startedAt,
      continuation?.sourceRunId ?? null,
      continuation ? null : "new",
    );

    const active: ActiveRun = { dto, continuation, cancelled: false };
    this.activeRuns.set(runId, active);
    void this.execute(active, manifest, request);
    return { runId, queued: true };
  }

  /**
   * ACP 管理页连通性测试：启动进程 → initialize → session/new（必要时一次 authenticate 重试）。
   * 不产生任务 run、不发送 prompt；仅验证链路可用并把分步结果返回给设置页。
   */
  async testAgent(agentId: ExternalAgentId): Promise<ExternalAgentTestResultDto> {
    const startedAt = Date.now();
    const steps: ExternalAgentTestStepDto[] = [];
    const step = (id: ExternalAgentTestStepDto["id"], label: string, from: number, ok: boolean, detail?: string): void => {
      steps.push({ id, label, ok, durationMs: Date.now() - from, ...(detail ? { detail } : {}) });
    };
    const fail = (error: string, extra?: Partial<ExternalAgentTestResultDto>): ExternalAgentTestResultDto => ({
      agentId,
      ok: false,
      durationMs: Date.now() - startedAt,
      steps,
      error,
      ...extra,
    });
    const manifest = MANIFESTS.find((item) => item.id === agentId);
    if (!manifest) return fail(`不支持的外部 Agent：${agentId}`);

    const cwd = homedir();
    let stderr = "";
    let child: ChildProcessWithoutNullStreams | undefined;
    const phaseRef: { current: { id: ExternalAgentTestStepDto["id"]; label: string; at: number } | null } = { current: null };
    try {
      const launchAt = Date.now();
      try {
        child = this.launch(manifest, cwd);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        step("launch", "启动 ACP 进程", launchAt, false, message);
        return fail(message);
      }
      step("launch", "启动 ACP 进程", launchAt, true, manifest.commandLabel);
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
        if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
      });
      child.on("error", (error) => {
        stderr += `\n${error.message}`;
      });

      const stream = acp.ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      );
      const devinCompatibility = manifest.id === "devin";
      const client = acp.client({ name: devinCompatibility ? "windsurf" : "MyBuddy" })
        .onRequest(acp.methods.client.session.requestPermission, () =>
          Promise.resolve({ outcome: { outcome: "cancelled" } }))
        .onNotification(acp.methods.client.session.update, () => {});
      if (devinCompatibility) {
        client.onRequest(
          "_cognition.ai/request_diagnostics",
          parseExtensionParams,
          () => ({}),
        );
      }

      let sessionId: string | undefined;
      let resumeSupported = false;
      let authMethods: string[] = [];
      let configOptions: ExternalAgentConfigOptionDto[] = [];
      const notes: string[] = [];
      const workflow = client.connectWith(stream, async (ctx) => {
        phaseRef.current = { id: "initialize", label: "ACP 协议握手", at: Date.now() };
        const initialized = await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: devinCompatibility
            ? { _meta: { "cognition.ai/requestDiagnostics": true } }
            : {},
          ...(devinCompatibility ? {
            clientInfo: {
              name: "windsurf",
              version: process.env.MYBUDDY_DEVIN_WINDSURF_VERSION?.trim() || DEFAULT_DEVIN_WINDSURF_VERSION,
            },
          } : {}),
        });
        authMethods = (initialized.authMethods ?? []).map((method) => method.name);
        resumeSupported = initialized.agentCapabilities?.sessionCapabilities?.resume != null
          || initialized.agentCapabilities?.loadSession === true;
        step("initialize", "ACP 协议握手", phaseRef.current.at, true, authMethods.length ? `认证方式：${authMethods.join("、")}` : undefined);
        phaseRef.current = null;

        phaseRef.current = { id: "session", label: "创建 ACP 会话", at: Date.now() };
        const newSession = () =>
          ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
        let reportedOptions: acp.SessionConfigOption[] | null | undefined;
        try {
          const created = await newSession();
          sessionId = created.sessionId;
          reportedOptions = created.configOptions;
        } catch (error) {
          const method = (initialized.authMethods ?? []).filter((item) => !isTerminalAuthMethod(item))[0];
          if (!method) throw error;
          await ctx.request(acp.methods.agent.authenticate, { methodId: method.id });
          const created = await newSession();
          sessionId = created.sessionId;
          reportedOptions = created.configOptions;
        }
        step("session", "创建 ACP 会话", phaseRef.current.at, true, sessionId);
        phaseRef.current = null;
        // 顺带把已保存的会话选项偏好应用到测试会话：验证选项仍被该 Agent 接受，
        // 并把最新 configOptions 快照写回设置缓存供下拉使用。
        configOptions = await this.applySessionConfigSelections(
          ctx,
          agentId,
          sessionId,
          reportedOptions,
          (text) => notes.push(text),
        );
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          workflow,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`测试超时（${Math.round(TEST_TIMEOUT_MS / 1000)} 秒）`)), TEST_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      return {
        agentId,
        ok: true,
        durationMs: Date.now() - startedAt,
        steps,
        sessionId,
        resumeSupported,
        authMethods,
        ...(configOptions.length ? { configOptions } : {}),
        ...(notes.length ? { notes } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const phase = phaseRef.current;
      if (phase && !steps.some((item) => item.id === phase.id)) {
        step(phase.id, phase.label, phase.at, false, message);
      }
      const tail = stderr.trim();
      return fail(tail ? `${message}\n${tail.slice(-3_000)}` : message);
    } finally {
      try { child?.kill(); } catch { /* best effort */ }
    }
  }

  private launch(manifest: Manifest, cwd: string): ChildProcessWithoutNullStreams {
    if (manifest.adapterPackage) {
      const entry = resolveAdapterEntry(manifest.adapterPackage);
      if (!entry) throw new Error(`MyBuddy \u672a\u627e\u5230 ${manifest.adapterPackage}`);
      const env: NodeJS.ProcessEnv = { ...process.env };
      if (manifest.id === "codex") {
        const codexPath = whereFirst("codex");
        if (!codexPath) throw new Error("\u672a\u68c0\u6d4b\u5230 Codex CLI");
        env.CODEX_PATH = codexPath;
      }
      if (manifest.id === "agy") {
        const agyPath = whereFirst("agy");
        if (!agyPath) throw new Error("\u672a\u68c0\u6d4b\u5230 agy CLI");
        env.AGY_BIN = agyPath;
      }
      if (manifest.id === "command") {
        const commandCodePath = whereFirst("cmdc") ?? whereFirst("command-code");
        if (!commandCodePath) throw new Error("\u672a\u68c0\u6d4b\u5230 Command Code CLI");
        Object.assign(env, commandCodeAcpEnv(commandCodePath));
      }
      return spawnBundledAdapter(entry, cwd, env);
    }
    const nativeCommand = resolveNativeCommand(manifest);
    if (!nativeCommand) throw new Error(`${manifest.name} \u7f3a\u5c11\u542f\u52a8\u547d\u4ee4`);
    return spawnExternalCliCommand(nativeCommand, manifest.nativeArgs ?? [], cwd);
  }

  private emit(run: ActiveRun, patch: AgentUiPatch): void {
    this.send?.({
      runId: run.dto.runId,
      taskId: run.dto.taskId,
      agentId: run.dto.agentId,
      agentName: run.dto.agentName,
      protocol: "acp",
      assistantMessageId: run.dto.assistantMessageId,
      sessionId: run.dto.sessionId,
      continuationMode: run.dto.continuationMode,
      resumeSupported: run.dto.capabilities.resumeSupported,
      recoveryState: run.dto.recovery.state,
      verificationStatus: run.dto.verification.status,
      outputCursor: run.dto.outputCursor,
      artifactRefs: [...run.dto.artifactRefs],
      patch,
    });
  }

  private setContinuationMode(run: ActiveRun, mode: ExternalAgentContinuationMode): void {
    run.dto.continuationMode = mode;
    this.db.connection.prepare(`UPDATE external_agent_runs SET continuation_mode=? WHERE id=?`).run(mode, run.dto.runId);
  }

  private setCapabilities(run: ActiveRun, resumeSupported: boolean): void {
    run.dto.capabilities = { cancelSupported: !["completed", "failed", "cancelled"].includes(run.dto.status), resumeSupported };
    this.db.connection.prepare(`UPDATE external_agent_runs SET resume_supported=?, cancel_supported=? WHERE id=?`)
      .run(resumeSupported ? 1 : 0, run.dto.capabilities.cancelSupported ? 1 : 0, run.dto.runId);
  }

  private setRecovery(run: ActiveRun, state: ExternalAgentRunDto["recovery"]["state"], message?: string): void {
    run.dto.recovery = { state, message };
    this.db.connection.prepare(`UPDATE external_agent_runs SET recovery_state=?, recovery_message=? WHERE id=?`)
      .run(state, message ?? null, run.dto.runId);
  }

  private setWorkspaceObservation(run: ActiveRun, artifactRefs: string[]): void {
    const refs = [...new Set(artifactRefs.filter(Boolean))];
    run.dto.artifactRefs = refs;
    run.dto.verification = {
      status: "workspace_observed",
      message: "MyBuddy 已在任务工作目录完成变更观察并登记可识别产物；这不等于业务结果已验证。",
    };
    this.db.connection.prepare(`UPDATE external_agent_runs SET artifact_refs_json=?, verification_status='workspace_observed' WHERE id=?`)
      .run(JSON.stringify(refs), run.dto.runId);
  }

  private updateRun(run: ActiveRun, status: ExternalAgentRunStatus, extra?: { sessionId?: string; error?: string; completedAt?: number }): void {
    const terminal = (value: ExternalAgentRunStatus): boolean => value === "completed" || value === "failed" || value === "cancelled";
    if (terminal(run.dto.status) && run.dto.status !== status) return;
    run.dto.status = status;
    if (extra?.sessionId) { run.dto.sessionId = extra.sessionId; run.sessionId = extra.sessionId; }
    if (extra?.error !== undefined) run.dto.error = extra.error;
    if (extra?.completedAt !== undefined) run.dto.completedAt = extra.completedAt;
    if (terminal(status)) run.dto.capabilities = { ...run.dto.capabilities, cancelSupported: false };
    this.db.connection.prepare(`
      UPDATE external_agent_runs SET status=?, session_id=COALESCE(?, session_id),
        completed_at=COALESCE(?, completed_at), error=?, cancel_supported=? WHERE id=?
    `).run(status, extra?.sessionId ?? null, extra?.completedAt ?? null, extra?.error ?? null, run.dto.capabilities.cancelSupported ? 1 : 0, run.dto.runId);
  }

  private appendText(run: ActiveRun, column: "final_text" | "thinking_text", delta: string): void {
    if (!delta) return;
    run.dto.outputCursor += delta.length;
    this.db.connection.prepare(`UPDATE external_agent_runs SET ${column} = ${column} || ?, output_cursor=? WHERE id = ?`)
      .run(delta, run.dto.outputCursor, run.dto.runId);
  }

  private readTools(runId: string): StoredTool[] {
    const row = this.db.connection.prepare(`SELECT tools_json FROM external_agent_runs WHERE id=?`).get(runId) as { tools_json: string } | undefined;
    if (!row) return [];
    try { return JSON.parse(row.tools_json) as StoredTool[]; }
    catch { return []; }
  }

  private writeTools(run: ActiveRun, tools: StoredTool[]): void {
    run.dto.outputCursor += 1;
    this.db.connection.prepare(`UPDATE external_agent_runs SET tools_json=?, output_cursor=? WHERE id=?`)
      .run(JSON.stringify(tools), run.dto.outputCursor, run.dto.runId);
  }

  private upsertTool(run: ActiveRun, tool: StoredTool): void {
    const tools = this.readTools(run.dto.runId);
    const index = tools.findIndex((item) => item.id === tool.id);
    if (index >= 0) tools[index] = { ...tools[index], ...tool };
    else tools.push(tool);
    this.writeTools(run, tools);
  }

  private updateTool(run: ActiveRun, id: string, patch: Partial<StoredTool>): StoredTool {
    const tools = this.readTools(run.dto.runId);
    const index = tools.findIndex((item) => item.id === id);
    const previous = index >= 0 ? tools[index]! : { id, tool: "tool", summary: id, status: "running" as const };
    const next: StoredTool = { ...previous, ...patch };
    if (index >= 0) tools[index] = next;
    else tools.push(next);
    this.writeTools(run, tools);
    return next;
  }

  private handleSessionUpdate(run: ActiveRun, update: acp.SessionUpdate): void {
    if (update.sessionUpdate === "agent_message_chunk") {
      if (update.content.type === "text" && update.content.text) {
        this.appendText(run, "final_text", update.content.text);
        this.emit(run, { type: "text_delta", taskId: run.dto.taskId, messageId: run.dto.assistantMessageId, delta: update.content.text, final: true });
      }
      return;
    }
    if (update.sessionUpdate === "agent_thought_chunk") {
      if (update.content.type === "text" && update.content.text) {
        this.appendText(run, "thinking_text", update.content.text);
        this.emit(run, { type: "thinking_delta", taskId: run.dto.taskId, messageId: run.dto.assistantMessageId, delta: update.content.text });
      }
      return;
    }
    if (update.sessionUpdate === "tool_call") {
      const status = mapToolStatus(update.status);
      const stored: StoredTool = {
        id: update.toolCallId,
        tool: update.name || update.kind || "tool",
        summary: update.title || update.name || "工具调用",
        detail: stringifyBounded(update.rawInput),
        output: stringifyBounded(update.rawOutput),
        status,
      };
      this.upsertTool(run, stored);
      this.emit(run, {
        type: "tool_start",
        taskId: run.dto.taskId,
        messageId: run.dto.assistantMessageId,
        toolCallId: update.toolCallId,
        tool: stored.tool,
        summary: stored.summary,
        detail: stored.detail,
        status: "running",
      });
      if (status === "success" || status === "error") {
        this.emit(run, { type: "tool_update", taskId: run.dto.taskId, messageId: run.dto.assistantMessageId, toolCallId: update.toolCallId, status, output: stored.output });
      }
      return;
    }
    if (update.sessionUpdate === "tool_call_update") {
      const status = mapToolStatus(update.status);
      const next = this.updateTool(run, update.toolCallId, {
        ...(update.title ? { summary: update.title } : {}),
        ...(update.name ? { tool: update.name } : {}),
        ...(update.rawInput !== undefined ? { detail: stringifyBounded(update.rawInput) } : {}),
        ...(update.rawOutput !== undefined ? { output: stringifyBounded(update.rawOutput) } : {}),
        ...(update.status ? { status } : {}),
      });
      this.emit(run, {
        type: "tool_update",
        taskId: run.dto.taskId,
        messageId: run.dto.assistantMessageId,
        toolCallId: update.toolCallId,
        status: update.status ? status : undefined,
        output: next.output,
        summary: next.summary,
      });
      return;
    }
    if (update.sessionUpdate === "plan") {
      const text = update.entries.map((entry) => `${entry.status === "completed" ? "✓" : entry.status === "in_progress" ? "●" : "○"} ${entry.content}`).join("\n");
      if (text) this.emit(run, { type: "thinking_delta", taskId: run.dto.taskId, messageId: run.dto.assistantMessageId, delta: `\n计划\n${text}\n` });
      return;
    }
    if (update.sessionUpdate === "config_option_update") {
      // Agent 侧主动变更会话选项（如模型切换）：回写快照，保持设置页下拉 fresh。
      const dtos = toConfigOptionDtos(update.configOptions);
      if (dtos.length) {
        try { this.sessionConfig?.writeOptions(run.dto.agentId, dtos); } catch { /* best effort */ }
      }
    }
  }

  private handlePermission(run: ActiveRun, params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const options = params.options.map((option) => ({ optionId: option.optionId, name: option.name, kind: option.kind }));
    // 权限策略（桌面「ACP 管理」按 Agent 保存）：auto-allow / auto-deny 时不阻塞用户，
    // 但仍把这次调用完整写进时间线（谁知道放行了什么），并且只在 Agent 自己声明的
    // allow_* / reject_* 选项里挑；挑不到就退回询问，绝不猜一个更宽的授权。
    const policy = this.permissionPolicyOf(run.dto.agentId);
    const autoOptionId = resolvePolicyPermissionOptionId(policy, options);
    if (autoOptionId) {
      const option = options.find((item) => item.optionId === autoOptionId)!;
      const denied = option.kind.startsWith("reject");
      const recorded = this.updateTool(run, params.toolCall.toolCallId, {
        summary: params.toolCall.title || "需要授权",
        tool: params.toolCall.name || params.toolCall.kind || "tool",
        detail: stringifyBounded(params.toolCall.rawInput),
        status: denied ? "denied" : "running",
        output: denied ? `已按策略自动拒绝（${option.name}）` : `已按策略自动放行（${option.name}）`,
      });
      this.emit(run, {
        type: "tool_start",
        taskId: run.dto.taskId,
        messageId: run.dto.assistantMessageId,
        toolCallId: params.toolCall.toolCallId,
        tool: recorded.tool,
        summary: recorded.summary,
        detail: recorded.detail,
        status: "running",
      });
      // tool_start 的 status 只允许 pending_approval/running，自动判定经 tool_update 落到 UI
      this.emit(run, {
        type: "tool_update",
        taskId: run.dto.taskId,
        messageId: run.dto.assistantMessageId,
        toolCallId: params.toolCall.toolCallId,
        status: denied ? "denied" : "running",
        output: recorded.output,
      });
      return Promise.resolve({ outcome: { outcome: "selected", optionId: option.optionId } });
    }
    this.updateRun(run, "blocked");
    const previous = this.updateTool(run, params.toolCall.toolCallId, {
      summary: params.toolCall.title || "需要授权",
      tool: params.toolCall.name || params.toolCall.kind || "tool",
      detail: stringifyBounded(params.toolCall.rawInput),
      status: "pending_approval",
    });
    this.emit(run, {
      type: "tool_start",
      taskId: run.dto.taskId,
      messageId: run.dto.assistantMessageId,
      toolCallId: params.toolCall.toolCallId,
      tool: previous.tool,
      summary: previous.summary,
      detail: previous.detail,
      status: "pending_approval",
      approvalKind: "acp",
      externalRunId: run.dto.runId,
      acpPermissionOptions: options,
    });
    return new Promise<acp.RequestPermissionResponse>((resolve) => {
      const key = `${run.dto.runId}:${params.toolCall.toolCallId}`;
      // A renewed request for the same toolCallId supersedes the earlier pending
      // one; resolve it so the agent is never left waiting on a superseded promise.
      const previous = this.permissions.get(key);
      if (previous) {
        this.permissions.delete(key);
        previous.resolve({ outcome: { outcome: "cancelled" } });
      }
      this.permissions.set(key, {
        runId: run.dto.runId,
        toolCallId: params.toolCall.toolCallId,
        options,
        resolve,
      });
      // run 快照同步带上等待中的授权选项：Remote（手机端）只读 run 快照，
      // 不进这个 Map，必须靠快照才能渲染「允许一次 / 始终允许 / 拒绝」。
      this.syncPendingPermissions(run);
    });
  }

  /** 把该 run 仍在等待的权限请求投影进 dto（桌面/手机审批 UI 共用同一份快照） */
  private syncPendingPermissions(run: ActiveRun): void {
    const pending = [...this.permissions.values()].filter((item) => item.runId === run.dto.runId);
    run.dto.pendingPermissions = pending.map((item) => {
      const tool = this.readTools(run.dto.runId).find((entry) => entry.id === item.toolCallId);
      return {
        toolCallId: item.toolCallId,
        tool: tool?.tool ?? "tool",
        summary: tool?.summary ?? "需要授权",
        detail: tool?.detail,
        options: item.options,
      };
    });
  }

  resolvePermission(request: ExternalAgentResolvePermissionRequest): { ok: boolean; message: string } {
    const key = `${request.runId}:${request.toolCallId}`;
    const pending = this.permissions.get(key);
    if (!pending) return { ok: false, message: "该 ACP 授权请求已结束或不存在" };
    const option = pending.options.find((item) => item.optionId === request.optionId);
    if (!option) return { ok: false, message: "无效的 ACP 授权选项" };
    this.permissions.delete(key);
    pending.resolve({ outcome: { outcome: "selected", optionId: option.optionId } });
    const run = this.activeRuns.get(request.runId);
    if (run) {
      this.syncPendingPermissions(run);
      const denied = option.kind.startsWith("reject");
      this.updateRun(run, "working");
      this.updateTool(run, request.toolCallId, { status: denied ? "denied" : "running" });
      this.emit(run, {
        type: "tool_update",
        taskId: run.dto.taskId,
        messageId: run.dto.assistantMessageId,
        toolCallId: request.toolCallId,
        status: denied ? "denied" : "running",
        output: denied ? "用户已拒绝" : undefined,
      });
    }
    return { ok: true, message: option.name };
  }

  /**
   * 会话建立后应用用户在 ACP 管理页保存的会话选项（模型/模式等），
   * 并把最新 configOptions 快照回写设置缓存。单项失败仅记录提示，不阻断任务。
   * 返回归一化后的选项 DTO 列表（供 testAgent 结果使用）。
   */
  private async applySessionConfigSelections(
    ctx: acp.ClientContext,
    agentId: ExternalAgentId,
    sessionId: string,
    reported: acp.SessionConfigOption[] | null | undefined,
    note?: (text: string) => void,
  ): Promise<ExternalAgentConfigOptionDto[]> {
    let latest = Array.isArray(reported) ? reported : [];
    const prefs = this.sessionConfig?.readSelections(agentId) ?? {};
    for (const [configId, value] of Object.entries(prefs)) {
      const option = latest.find((item) => item.id === configId);
      const label = option?.name || configId;
      if (!option) {
        note?.(`会话选项「${label}」不在该 Agent 当前声明的选项中，已跳过`);
        continue;
      }
      if (option.currentValue === value) continue;
      try {
        if (option.type === "boolean") {
          if (typeof value !== "boolean") continue;
          const res = await ctx.request(acp.methods.agent.session.setConfigOption, {
            sessionId,
            configId,
            type: "boolean",
            value,
          });
          if (Array.isArray(res.configOptions)) latest = res.configOptions;
        } else {
          if (typeof value !== "string") continue;
          const dto = toConfigOptionDto(option);
          if (dto?.options?.length && !dto.options.some((item) => item.value === value)) {
            note?.(`会话选项「${label}」保存的值「${value}」已不在可选列表中，已跳过`);
            continue;
          }
          const res = await ctx.request(acp.methods.agent.session.setConfigOption, {
            sessionId,
            configId,
            value,
          });
          if (Array.isArray(res.configOptions)) latest = res.configOptions;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        note?.(`会话选项「${label}」设置失败：${message}；沿用 Agent 当前值`);
      }
    }
    const dtos = toConfigOptionDtos(latest);
    if (dtos.length) {
      try { this.sessionConfig?.writeOptions(agentId, dtos); } catch { /* best effort */ }
    }
    return dtos;
  }

  private executionPrompt(request: ExternalAgentPromptRequest): string {
    const files = (request.attachments ?? []).filter((item) => item.path?.trim());
    if (!files.length) return request.text;
    const fileContext = [
      "[MyBuddy selected attachments]",
      ...files.map((item) => `- ${item.name}: ${item.path}`),
      "[/MyBuddy selected attachments]",
    ].join("\n");
    return [request.text, fileContext].filter(Boolean).join("\n\n");
  }

  private async execute(run: ActiveRun, manifest: Manifest, request: ExternalAgentPromptRequest): Promise<void> {
    const startedAt = run.dto.startedAt;
    const workspaceBefore = await snapshotWorkspace(run.dto.cwd);
    let stderr = "";
    let authMethodsSeen: acp.AuthMethod[] = [];
    try {
      const child = this.launch(manifest, run.dto.cwd);
      run.process = child;
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
        if (stderr.length > 16_000) stderr = stderr.slice(-16_000);
      });
      child.on("error", (error) => {
        stderr += `\n${error.message}`;
      });
      const stream = acp.ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      );
      const devinCompatibility = manifest.id === "devin";
      const client = acp.client({ name: devinCompatibility ? "windsurf" : "MyBuddy" })
        .onRequest(acp.methods.client.session.requestPermission, (ctx) => this.handlePermission(run, ctx.params))
        .onNotification(acp.methods.client.session.update, (ctx) => {
          if (!run.sessionId || ctx.params.sessionId !== run.sessionId || run.replayingHistory) return;
          this.handleSessionUpdate(run, ctx.params.update);
        });
      if (devinCompatibility) {
        client.onRequest(
          "_cognition.ai/request_diagnostics",
          parseExtensionParams,
          () => ({}),
        );
      }

      await client.connectWith(stream, async (ctx) => {
        run.context = ctx;
        const initialized = await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: devinCompatibility
            ? { _meta: { "cognition.ai/requestDiagnostics": true } }
            : {},
          ...(devinCompatibility ? {
            clientInfo: {
              name: "windsurf",
              version: process.env.MYBUDDY_DEVIN_WINDSURF_VERSION?.trim() || DEFAULT_DEVIN_WINDSURF_VERSION,
            },
          } : {}),
        });
        const canResume = initialized.agentCapabilities?.sessionCapabilities?.resume != null;
        const canLoad = initialized.agentCapabilities?.loadSession === true;
        this.setCapabilities(run, canResume || canLoad);
        if (run.cancelled) return;

        const additionalDirectories = (request.additionalDirectories ?? [])
          .map((value) => value.trim())
          .filter(Boolean);
        const sessionRequest = {
          cwd: run.dto.cwd,
          mcpServers: [],
          ...(additionalDirectories.length ? { additionalDirectories } : {}),
          _meta: { "mybuddy/taskId": request.taskId, "mybuddy/runId": run.dto.runId },
        };

        const openSession = async (): Promise<{ sessionId: string; configOptions: acp.SessionConfigOption[] | null | undefined }> => {
          if (run.continuation) {
            const continuedSessionId = run.continuation.sessionId;
            run.sessionId = continuedSessionId;
            if (canResume) {
              const resumed = await ctx.request(acp.methods.agent.session.resume, { sessionId: continuedSessionId, ...sessionRequest });
              this.setContinuationMode(run, "resume");
              return { sessionId: continuedSessionId, configOptions: resumed.configOptions };
            } else if (canLoad) {
              // session/load must replay the previous transcript. Suppress that replay here;
              // MyBuddy already owns the visible historical messages and only wants new updates.
              run.replayingHistory = true;
              let loaded: acp.LoadSessionResponse;
              try {
                loaded = await ctx.request(acp.methods.agent.session.load, { sessionId: continuedSessionId, ...sessionRequest });
              } finally {
                run.replayingHistory = false;
              }
              this.setContinuationMode(run, "load");
              return { sessionId: continuedSessionId, configOptions: loaded.configOptions };
            } else {
              const created = await ctx.request(acp.methods.agent.session.new, sessionRequest);
              this.setContinuationMode(run, "fallback_new");
              return { sessionId: created.sessionId, configOptions: created.configOptions };
            }
          }
          const created = await ctx.request(acp.methods.agent.session.new, sessionRequest);
          this.setContinuationMode(run, "new");
          return { sessionId: created.sessionId, configOptions: created.configOptions };
        };

        // Agents that require auth reject session creation until `authenticate`
        // succeeds. Retry once after the first agent-side auth method; terminal
        // methods are excluded because they demand a TUI the user must run.
        const agentAuthMethods = (initialized.authMethods ?? []).filter((method) => !isTerminalAuthMethod(method));
        authMethodsSeen = initialized.authMethods ?? [];
        let openedSession: { sessionId: string; configOptions: acp.SessionConfigOption[] | null | undefined };
        try {
          openedSession = await openSession();
        } catch (error) {
          const method = agentAuthMethods[0];
          if (run.cancelled || !method) throw error;
          this.emit(run, {
            type: "thinking_delta",
            taskId: run.dto.taskId,
            messageId: run.dto.assistantMessageId,
            delta: `\n${manifest.name} 需要认证，正在尝试「${method.name}」…\n`,
          });
          await ctx.request(acp.methods.agent.authenticate, { methodId: method.id });
          openedSession = await openSession();
        }
        const sessionId = openedSession.sessionId;

        // 建会话后、prompt 前应用用户在「设置 → ACP 管理」保存的会话选项（模型/模式等）；
        // 单项失败仅在思考流里提示，不阻断任务。
        await this.applySessionConfigSelections(ctx, manifest.id, sessionId, openedSession.configOptions, (text) => {
          this.emit(run, {
            type: "thinking_delta",
            taskId: run.dto.taskId,
            messageId: run.dto.assistantMessageId,
            delta: `\n${text}\n`,
          });
        });

        this.updateRun(run, "working", { sessionId });
        const suffix = run.dto.continuationMode === "resume" || run.dto.continuationMode === "load"
          ? " · 续聊"
          : run.dto.continuationMode === "fallback_new"
            ? " · 新会话"
            : "";
        this.emit(run, {
          type: "assistant_start",
          taskId: run.dto.taskId,
          messageId: run.dto.assistantMessageId,
          executionId: run.dto.runId,
          modelName: `${run.dto.agentName} · ACP${suffix}`,
        });

        const promptResponse = await ctx.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: this.executionPrompt(request) }],
        });

        // File/artifact reconciliation is part of the execution commit. Do it before
        // assistant_end so completion does not cause a second layout jump.
        try {
          const artifactRefs = await this.emitWorkspaceChanges?.(run.dto.taskId, run.dto.assistantMessageId, workspaceBefore) ?? [];
          this.setWorkspaceObservation(run, artifactRefs);
        } catch (error) {
          console.warn("[ExternalAgentRuntime] workspace change capture failed", error);
        }
        const completedAt = Date.now();
        const cancelled = run.cancelled || promptResponse.stopReason === "cancelled";
        this.setRecovery(run, "none");
        this.updateRun(run, cancelled ? "cancelled" : "completed", { completedAt });
        this.emit(run, {
          type: "assistant_end",
          taskId: run.dto.taskId,
          messageId: run.dto.assistantMessageId,
          durationMs: completedAt - startedAt,
        });
      });
    } catch (error) {
      try {
        const artifactRefs = await this.emitWorkspaceChanges?.(run.dto.taskId, run.dto.assistantMessageId, workspaceBefore) ?? [];
        this.setWorkspaceObservation(run, artifactRefs);
      } catch (captureError) {
        console.warn("[ExternalAgentRuntime] workspace change capture failed", captureError);
      }
      const completedAt = Date.now();
      const message = error instanceof Error ? error.message : String(error);
      const detail = stderr.trim();
      let authHint = "";
      if (!run.cancelled && authMethodsSeen.length) {
        const terminalNames = authMethodsSeen.filter(isTerminalAuthMethod).map((method) => method.name);
        const agentNames = authMethodsSeen.filter((method) => !isTerminalAuthMethod(method)).map((method) => method.name);
        if (terminalNames.length && !agentNames.length) {
          authHint = `\n提示：${manifest.name} 要求先在本机终端完成登录（${terminalNames.join("、")}），请运行对应 CLI 登录后重试。`;
        } else if (agentNames.length) {
          authHint = `\n提示：${manifest.name} 声明了认证方式（${agentNames.join("、")}）；若刚才未完成登录，请重试或先运行对应 CLI 登录。`;
        }
      }
      const full = detail ? `${message}${authHint}\n${detail.slice(-4000)}` : `${message}${authHint}`;
      if (run.cancelled) {
        this.setRecovery(run, "none");
      } else if (run.dto.sessionId && run.dto.capabilities.resumeSupported) {
        this.setRecovery(run, "resume-available", "外部子任务执行失败，但原 session 可恢复；续聊前请先核对已产生的输出和产物。");
      } else {
        this.setRecovery(run, "new-run-required", "外部子任务执行失败且没有可恢复 session；请核对已有输出/产物后新建执行。");
      }
      this.updateRun(run, run.cancelled ? "cancelled" : "failed", {
        completedAt,
        ...(run.cancelled ? {} : { error: full }),
      });
      this.emit(run, {
        type: "assistant_end",
        taskId: run.dto.taskId,
        messageId: run.dto.assistantMessageId,
        durationMs: completedAt - startedAt,
        ...(run.cancelled ? {} : { error: full }),
      });
    } finally {
      for (const [key, pending] of this.permissions) {
        if (pending.runId !== run.dto.runId) continue;
        this.permissions.delete(key);
        pending.resolve({ outcome: { outcome: "cancelled" } });
      }
      run.dto.pendingPermissions = [];
      const child = run.process;
      if (child && child.exitCode === null && child.signalCode === null) {
        // Retain ownership while kill is pending, including cancelled runs hidden by active().
        child.once("close", () => this.activeRuns.delete(run.dto.runId));
        try { child.kill(); } catch { /* keep ownership until the process closes */ }
      } else {
        this.activeRuns.delete(run.dto.runId);
      }
    }
  }

  async cancel(runId?: string, taskId?: string): Promise<{ ok: boolean; message: string }> {
    const runs = [...this.activeRuns.values()].filter((run) => runId ? run.dto.runId === runId : taskId ? run.dto.taskId === taskId : false);
    if (!runs.length) return { ok: false, message: "没有运行中的 ACP Agent" };
    await Promise.all(runs.map(async (run) => {
      run.cancelled = true;
      this.setRecovery(run, "none");
      // Cancellation is a terminal user decision. Persist it immediately so a slow
      // adapter response cannot keep the run visible or overwrite it with completed.
      this.updateRun(run, "cancelled", { completedAt: Date.now() });
      // 取消即终态：等待中的授权请求一并作废，避免手机/桌面仍渲染可点击的审批卡片
      for (const [key, pending] of this.permissions) {
        if (pending.runId !== run.dto.runId) continue;
        this.permissions.delete(key);
        pending.resolve({ outcome: { outcome: "cancelled" } });
      }
      run.dto.pendingPermissions = [];
      try {
        if (run.context && run.dto.sessionId) {
          await run.context.notify(acp.methods.agent.session.cancel, { sessionId: run.dto.sessionId });
        }
      } catch { /* process kill below is final fallback */ }
      setTimeout(() => {
        try { run.process?.kill(); } catch { /* best effort */ }
      }, 1200).unref?.();
    }));
    return { ok: true, message: `已请求停止 ${runs.length} 个 ACP Agent` };
  }

  history(taskId: string): ExternalAgentHistoryDto {
    const rows = this.db.connection.prepare(`
      SELECT id, task_id, agent_id, agent_name, protocol, status, cwd, session_id,
             user_message_id, assistant_message_id, prompt, display_text, attachments_json,
             final_text, thinking_text, tools_json, started_at, completed_at, error,
             continued_from_run_id, continuation_mode, output_cursor, artifact_refs_json,
             resume_supported, cancel_supported, verification_status, recovery_state, recovery_message
        FROM external_agent_runs WHERE task_id=? ORDER BY started_at ASC
    `).all(taskId) as Array<Record<string, unknown>>;
    const runs: ExternalAgentRunDto[] = [];
    const messages: ExternalAgentHistoryDto["messages"] = [];
    for (const row of rows) {
      const agentId = String(row.agent_id) as ExternalAgentId;
      const manifest = MANIFESTS.find((item) => item.id === agentId);
      let artifactRefs: string[] = [];
      try {
        const parsed = JSON.parse(String(row.artifact_refs_json || "[]"));
        if (Array.isArray(parsed)) artifactRefs = parsed.filter((item): item is string => typeof item === "string");
      } catch { /* keep empty */ }
      const recoveryState = String(row.recovery_state || "none") as ExternalAgentRunDto["recovery"]["state"];
      const verificationStatus = String(row.verification_status || "not_verified") as ExternalAgentRunDto["verification"]["status"];
      const run: ExternalAgentRunDto = {
        runId: String(row.id),
        taskId: String(row.task_id),
        parentTaskId: String(row.task_id),
        agentId,
        agentName: String(row.agent_name),
        agent: { id: agentId, name: String(row.agent_name) },
        protocol: "acp",
        status: String(row.status) as ExternalAgentRunStatus,
        cwd: String(row.cwd),
        sessionId: row.session_id ? String(row.session_id) : undefined,
        userMessageId: String(row.user_message_id),
        assistantMessageId: String(row.assistant_message_id),
        startedAt: Number(row.started_at),
        completedAt: row.completed_at == null ? undefined : Number(row.completed_at),
        error: row.error ? String(row.error) : undefined,
        outputCursor: Number(row.output_cursor || 0),
        artifactRefs,
        // 历史 run 的等待中授权请求随进程存在与否失效；只有在内存里仍存活的 run 才可能恢复交互
        pendingPermissions: [],
        capabilities: {
          cancelSupported: Number(row.cancel_supported ?? 1) === 1,
          resumeSupported: Number(row.resume_supported ?? 0) === 1 && Boolean(row.session_id),
        },
        verification: {
          status: verificationStatus,
          message: verificationStatus === "workspace_observed"
            ? "MyBuddy 已在任务工作目录完成变更观察并登记可识别产物；这不等于业务结果已验证。"
            : "尚无工作目录后置观察证据；传输完成不等于业务验证。",
        },
        recovery: {
          state: recoveryState,
          message: row.recovery_message ? String(row.recovery_message) : undefined,
        },
        diagnostics: {
          protocol: "acp",
          commandLabel: manifest?.commandLabel ?? agentId,
          adapterKind: manifest?.adapterPackage ? (manifest.adapterKind ?? "official") : "native",
        },
        continuedFromRunId: row.continued_from_run_id ? String(row.continued_from_run_id) : undefined,
        continuationMode: row.continuation_mode ? String(row.continuation_mode) as ExternalAgentContinuationMode : undefined,
      };
      runs.push(run);
      let attachments: Array<{ name: string; path?: string }> = [];
      try { attachments = JSON.parse(String(row.attachments_json || "[]")); } catch { /* ignore */ }
      messages.push({
        id: run.userMessageId,
        role: "user",
        text: String(row.display_text || row.prompt || ""),
        createdAt: run.startedAt,
        attachments,
      });
      let storedTools: StoredTool[] = [];
      try { storedTools = JSON.parse(String(row.tools_json || "[]")); } catch { /* ignore */ }
      // Chat history only has terminal tool states. Never turn an interrupted
      // pending/running ACP tool into a fake success after reload/recovery.
      const tools: ChatToolCallDto[] = storedTools
        .filter((tool) => tool.status === "success" || tool.status === "error" || tool.status === "denied")
        .map((tool) => ({
          id: tool.id,
          tool: tool.tool,
          summary: tool.summary,
          detail: tool.detail,
          output: tool.output,
          status: tool.status === "success" ? "success" : "error",
        }));
      const finalText = [String(row.final_text || ""), row.error ? `\n\n${String(row.error)}` : ""].join("").trim();
      messages.push({
        id: run.assistantMessageId,
        role: "assistant",
        text: finalText,
        thinking: String(row.thinking_text || "") || undefined,
        modelName: `${run.agentName} · ACP`,
        externalAgent: {
          id: run.agentId,
          name: run.agentName,
          protocol: "acp",
          runId: run.runId,
          continuationMode: run.continuationMode,
          sessionReady: Boolean(run.sessionId),
          resumeSupported: run.capabilities.resumeSupported,
          recoveryState: run.recovery.state,
          verificationStatus: run.verification.status,
          outputCursor: run.outputCursor,
        },
        createdAt: run.startedAt + 1,
        durationMs: run.completedAt ? Math.max(0, run.completedAt - run.startedAt) : undefined,
        artifacts: [],
        artifactIds: run.artifactRefs,
        tools,
      });
    }
    return { messages, runs };
  }

  dispose(): void {
    for (const run of this.activeRuns.values()) {
      run.cancelled = true;
      try { run.process?.kill(); } catch { /* best effort */ }
    }
    for (const pending of this.permissions.values()) pending.resolve({ outcome: { outcome: "cancelled" } });
    this.permissions.clear();
    this.activeRuns.clear();
  }
}
