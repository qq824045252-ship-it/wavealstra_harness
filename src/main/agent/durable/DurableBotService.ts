import { createHash } from "node:crypto";
import { existsSync, statSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, extname, resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@earendil-works/chord/context";
import { loadQuickJSWasm } from "@earendil-works/pi-codemode";
import { McpOAuthCredentialStore, SessionManager, convertToLlm, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentDeleteUserMessageRequest, AgentRegenerateRequest, AgentRegenerateResult, AgentPromptRequest, AgentPromptResult, AgentSubmissionReceipt, AgentUiPatch, SessionHistoryRecoveryDto, TaskDto, TaskHistoryDto } from "../../../shared/agent-ipc";
import { normalizedEditorTextHash } from "../../../shared/regenerate-hash";
import type { BotToolMode, DurableBotSnapshot } from "../../../shared/durable-bot";
import { durableDelta } from "../../../../shared/src/durable-sync";
import { isGatewayBotTaskId } from "../../../shared/gateway-task";
import type { AppDatabase } from "../../db/AppDatabase";
import { McpConfigService } from "../../mcp/McpConfigService";
import { emptyMcpFilterResult } from "../../mcp/McpModeFilter";
import { toNativeMcpConfig } from "../../mcp/NativeMcpConfig";
import { McpCredentialBackend } from "../../mcp/McpCredentialBackend";
import { DurableBotRuntime } from "./DurableBotRuntime";
import { DurableTaskProjection } from "./DurableTaskProjection";
import { ToolGate } from "./ToolGate";
import { DEFAULT_DURABLE_RESUME_CONCURRENCY, ResumeAdmission, type ResumeAdmissionReport } from "./ResumeAdmission";
import { WorkspaceMigrationBusyError } from "./DurableWorkspaceMigration";
import { readDurableReadOnlyHistory } from "./DurableReadOnlyHistory";
import { modelKey, resolveBotModel, type BotModelResolution } from "./BotModelCatalog";
import type { DurableDomainTools } from "./DurableDomainTools";
import type { DurableEvidenceOptions } from "./DurableEvidenceProjection";
import { DurableUserEntryNotFoundError, findDurableUserEntry } from "./DurableConversationBranch";
import { durableContentText } from "./DurableHistoryProjection";
import { readDurableWorkExecution } from "./DurableWorkExecutionProjection";
import { DurableMcp } from "./DurableMcp";
import type { ExternalEffectRecovery } from "./DurableEffectRecovery";
import type { DurableLogRepairReport } from "./DurableLogRepair";
import { DurableStorageOwnedError } from "./DurableStorageLease";
import type { WorkExecutionBindingDto } from "../../../shared/bot-work";
import type { WorkExecutionPort } from "../work/WorkExecutionAdapter";
import { snapshotWorkspace } from "../../workspace/WorkspaceService";
import { AgentDoc, SessionFailed, type Cursor, type EntryRecord, type SubmissionId, type SubmissionRecord } from "@earendil-works/pi-durable";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { durableCompletedTurns } from "./DurableTurnProjection";
import type { TaskExpertBindingService } from "../../experts/TaskExpertBindingService";
import type { ToolDiagnosticEvent } from "../../../shared/task-diagnostics";
import type { CreateConversationBranchRequest } from "../../../shared/conversation-branch";
import { captureDurableBranch, resolveDurableBranch, type DurableBranchAnchor, type MaterializedDurableBranch } from "./DurableTaskBranch";

interface BotBinding { task_id: string; directory: string; cwd: string; backend: "pi-durable" }
class DurableToolAssemblyError extends Error {
  constructor(cause: unknown) { super(cause instanceof Error ? cause.message : String(cause), { cause }); }
}
interface BotModelRepair { from: string; to: string }
interface OpenBot {
  runtime: DurableBotRuntime; mcp: DurableMcp; mcpConfigKey: string;
  retiredMcp: Set<DurableMcp>;
  refreshingMcp?: { key: string; promise: Promise<DurableMcp> };
  /** 打开任务时持久化模型已失效，本次执行实际使用的替换模型。必须展示给用户。 */
  modelRepair?: BotModelRepair;
  /** Set while this runtime and its MCP clients are being torn down after a Session failure. */
  closing?: Promise<void>;
}
export interface DurableBotServiceOptions {
  db: AppDatabase;
  models: ModelRuntime;
  agentDir: string;
  mcpDir: string;
  assetsDir?: string;
  resolveCwd: (taskId: string) => string;
  /** Desired organization root; undefined pins an execution-owned workspace. No projection writes. */
  resolveNextCwd?: (taskId: string) => string | undefined;
  instructions: (task: TaskDto) => string;
  evidence?: (task: TaskDto, messages: readonly Message[]) => string;
  evidenceProjection?: (task: TaskDto) => DurableEvidenceOptions;
  tools?: (task: TaskDto, cwd: string, recovery: ExternalEffectRecovery) => Promise<DurableDomainTools>;
  mcpSelection?: (task: TaskDto) => readonly string[];
  toolAllowed?: (task: TaskDto, name: string) => boolean;
  onTurns?: (taskId: string, turns: ReturnType<typeof durableCompletedTurns>) => void;
  onEntries?: (taskId: string, entries: readonly EntryRecord[], info: { conversationId: string; sourceKind: "main" | "subagent" }) => void;
  onResponse?: (taskId: string, message: AssistantMessage, info: { conversationId: string; generationTaskId: number; sourceKind: "main" | "subagent" }) => void;
  onRequest?: (taskId: string, info: { conversationId: string; generationTaskId: number; sourceKind: "main" | "subagent" }) => void;
  onTool?: (event: ToolDiagnosticEvent) => void;
  observedUsage?: (taskId: string, conversationId: string) => { inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheHitRate: number | null };
  waitingForInput?: (taskId: string) => boolean;
  /** Startup resumption width; interactive access bypasses the queue and is never throttled here. */
  resumeConcurrency?: number;
  onSettled?: (taskId: string, snapshot: DurableBotSnapshot) => void;
  onRelease?: (taskId: string) => void;
  toolMode: (task: TaskDto) => BotToolMode;
  defaultModel: () => string | undefined;
  emit: (patch: AgentUiPatch) => void;
  projectArtifacts?: (taskId: string, snapshot: DurableBotSnapshot, before: Map<string, string>, cwd: string, messageWorkspaces?: ReadonlyMap<string, string>) => Promise<void>;
  thinking?: (task: TaskDto, request: AgentPromptRequest) => ModelThinkingLevel | undefined;
  prepareInput?: (request: AgentPromptRequest) => Promise<string> | string;
  auditInput?: (request: AgentPromptRequest) => import("./DurableSkillProjection").DurableInputAudit;
  prepareImages?: (request: AgentPromptRequest) => Promise<{ images: Array<{ type: "image"; mimeType: string; data: string }>; text?: string }>;
  prepareTask?: (request: AgentPromptRequest) => Promise<AgentPromptRequest>;
  beforeSubmit?: (request: AgentPromptRequest) => void;
  beforeModelRequest?: (taskId: string) => void;
  providerAuthorityGuarded?: (taskId: string) => boolean;
  onProviderUsage?: (taskId: string, input: { conversationId: string; generationTaskId: number;
    reported: boolean; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }) => void;
  resumeAllowed?: (taskId: string) => boolean;
  expertBindings?: TaskExpertBindingService;
}

/** One process owns each store. SQLite only binds product IDs; all execution state is in Durable. */
export class DurableBotService {
  private readonly rebinding = new Map<string, Promise<OpenBot>>();
  private readonly opening = new Map<string, Promise<OpenBot>>();
  private readonly opened = new Map<string, OpenBot>();
  private readonly config: McpConfigService;
  private readonly credentials: McpOAuthCredentialStore;
  private closing = false;
  private readonly invalidations = new Map<string, Promise<void>>();
  private readonly admissions = new Map<string, Set<Promise<unknown>>>();
  private readonly admissionTails = new Map<string, Promise<unknown>>();
  private readonly projections = new Map<string, Promise<void>>();
  private readonly passiveReads = new Map<string, Promise<void>>();
  private resumeAdmission?: ResumeAdmission;
  /** Last startup drain outcome: delivered means open+resume was handed over, not that native work finished. */
  lastResumeReport?: ResumeAdmissionReport;
  constructor(private readonly options: DurableBotServiceOptions) {
    options.db.connection.exec(`CREATE TABLE IF NOT EXISTS durable_bot_bindings (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      backend TEXT NOT NULL CHECK(backend = 'pi-durable'), directory TEXT NOT NULL UNIQUE, cwd TEXT NOT NULL)`);
    options.db.connection.exec(`CREATE TABLE IF NOT EXISTS durable_bot_memory_projection (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, entry_id INTEGER NOT NULL)`);
    options.db.connection.exec(`CREATE TABLE IF NOT EXISTS durable_bot_workspace_moves (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      from_cwd TEXT NOT NULL, to_cwd TEXT NOT NULL)`);
    options.db.connection.exec(`CREATE TABLE IF NOT EXISTS durable_bot_message_workspaces (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL, cwd TEXT NOT NULL, PRIMARY KEY(task_id, message_id))`);
    this.config = new McpConfigService();
    this.credentials = new McpOAuthCredentialStore(
      new McpCredentialBackend(join(options.mcpDir, "mcp-native-auth.encrypted.json")), join(options.mcpDir, "mcp-native-refresh-locks"));
  }

  owns(taskId: string): boolean {
    return Boolean(this.options.db.getTask(taskId) || this.binding(taskId));
  }
  busy(taskId: string): boolean {
    const snapshot = this.opened.get(taskId)?.runtime.snapshot;
    return Boolean(snapshot?.busy || snapshot?.queued || this.opening.has(taskId) || this.admissions.get(taskId)?.size);
  }
  cwd(taskId: string): string | undefined { return this.workspaceMove(taskId)?.to_cwd ?? this.binding(taskId)?.cwd; }
  lastAssistantId(taskId: string): string | undefined { return this.opened.get(taskId)?.runtime.snapshot.messages.filter(message => message.role === "assistant").at(-1)?.id; }
  contextUsage(taskId: string) {
    const value = this.opened.get(taskId)?.runtime.snapshot.contextUsage;
    return value ? { taskId, ...value } : null;
  }
  /**
   * MCP 元工具定义的字符口径（只读投影）：当前已打开 bot 的元工具字符数 / 元工具个数 / 已配置服务数。
   * 没有已打开的 bot（未启动或已释放）返回 null；不 open()、不建 host、不连接任何服务器、无副作用。
   */
  mcpContext(taskId: string): { chars: number; tools: number; servers: number } | null {
    const open = this.opened.get(taskId);
    if (!open || open.closing) return null;
    return open.mcp.contextFacts();
  }
  private binding(taskId: string): BotBinding | undefined {
    return this.options.db.connection.prepare("SELECT * FROM durable_bot_bindings WHERE task_id = ?").get(taskId) as BotBinding | undefined;
  }

  private toolMode(task: TaskDto): BotToolMode {
    return isGatewayBotTaskId(task.id) ? "native" : this.options.toolMode(task);
  }

  async resumePersisted(): Promise<void> {
    const bindings = this.options.db.connection.prepare("SELECT task_id FROM durable_bot_bindings").all() as Array<Pick<BotBinding, "task_id">>;
    const admission = new ResumeAdmission({
      concurrency: this.options.resumeConcurrency ?? DEFAULT_DURABLE_RESUME_CONCURRENCY,
      shouldSkip: taskId => this.resumeSkipReason(taskId),
      // `open()` deduplicates by taskId, so a session the user opened first is only a no-op open
      // plus the same resume hand-over. Skipping it here would drop that recovery obligation.
      run: async taskId => { (await this.open(taskId)).runtime.resume(); },
    });
    this.resumeAdmission = admission;
    admission.enqueue(bindings.map(binding => binding.task_id));
    const report = await admission.drain();
    this.lastResumeReport = report;
    if (report.failed.length) {
      console.warn(`[Durable] 启动恢复交付 ${report.delivered.length} 个会话，${report.failed.length} 个失败`, report.failed.slice(0, 5));
    }
  }

  /** Queue-time conditions can change while an item waits; re-check before spending a slot. */
  private resumeSkipReason(taskId: string): string | undefined {
    if (!this.binding(taskId)) return "binding-removed";
    if (this.options.resumeAllowed?.(taskId) === false) return "not-resumable";
    if (this.options.db.getTaskExecutionWorkspaceState(taskId)?.state === "trashed") return "trashed";
    return undefined;
  }

  private workspaceMove(taskId: string): { from_cwd: string; to_cwd: string } | undefined {
    return this.options.db.connection.prepare("SELECT from_cwd, to_cwd FROM durable_bot_workspace_moves WHERE task_id = ?").get(taskId) as { from_cwd: string; to_cwd: string } | undefined;
  }

  private open(taskId: string, admissionBoundary = false): Promise<OpenBot> {
    // Interactive access takes over a queued startup item: the drain must not open it again.
    this.resumeAdmission?.claim(taskId);
    const pending = this.rebinding.get(taskId);
    if (pending) return pending;
    const operation = (async () => {
      let open: OpenBot;
      try { open = await this.openBound(taskId); }
      catch (error) {
        if (!(error instanceof WorkspaceMigrationBusyError) || !this.workspaceMove(taskId)) throw error;
        this.options.db.connection.prepare("DELETE FROM durable_bot_workspace_moves WHERE task_id = ?").run(taskId);
        open = await this.openBound(taskId);
      }
      if (!admissionBoundary && this.admissions.get(taskId)?.size) return open;
      if (!this.options.resolveNextCwd || this.options.waitingForInput?.(taskId)) return open;
      let desired: string | undefined;
      try { desired = this.options.resolveNextCwd(taskId); }
      catch (error) {
        // A broken destination must not prevent cancellation or recovery of the old namespace.
        if (!await open.runtime.canRebindWorkspace()) return open;
        throw error;
      }
      const current = this.binding(taskId);
      if (!desired || !current || resolve(desired) === resolve(current.cwd)) return open;
      // Scan the native graph only when the directory actually changes, not on every UI read.
      if (!await open.runtime.canRebindWorkspace()) return open;
      if (!existsSync(desired) || !statSync(desired).isDirectory()) throw new Error(`Bot 工作目录不存在：${desired}`);
      await this.rememberWorkspaceHistory(taskId, open);
      await this.invalidate(taskId, open);
      await this.projections.get(taskId);
      // Persist intent before mutating the native store. A restart resumes this exact migration,
      // including the crash window after native commit and before the SQLite projection commits.
      this.options.db.connection.prepare("INSERT INTO durable_bot_workspace_moves VALUES (?, ?, ?)")
        .run(taskId, current.cwd, desired);
      try { return await this.openBound(taskId); }
      catch (error) {
        if (!(error instanceof WorkspaceMigrationBusyError)) throw error;
        // Native transaction refused before changing any cwd. Restore the original namespace
        // so pending recovery/approval remains reachable; retry the desired move after it settles.
        this.options.db.connection.prepare("DELETE FROM durable_bot_workspace_moves WHERE task_id = ?").run(taskId);
        return this.openBound(taskId);
      }
    })();
    this.rebinding.set(taskId, operation);
    void operation.finally(() => { if (this.rebinding.get(taskId) === operation) this.rebinding.delete(taskId); }).catch(() => {});
    return operation;
  }

  private async rememberWorkspaceHistory(taskId: string, open: OpenBot): Promise<void> {
    // UI snapshots are windowed. Record all historical branches before the first directory
    // change so a later fork/history page cannot reinterpret an older relative file path.
    const rows = await open.runtime.harness.commit(async tx => {
      const result: Array<[string, string]> = [];
      let conversations: Cursor | undefined;
      do {
        const page = await tx.scanConversations({}, 100, conversations);
        for (const conversation of page.items) {
          const cwd = (await tx.doc(AgentDoc, conversation.id)).cwd ?? this.binding(taskId)!.cwd;
          let entries: Cursor | undefined;
          do {
            const history = await tx.scanEntries({ conversationId: conversation.id, order: "ascending" }, 500, entries);
            for (const entry of history.items) result.push([`durable-${entry.id}`, cwd]);
            entries = history.next;
          } while (entries);
        }
        conversations = page.next;
      } while (conversations);
      return result;
    }, context);
    this.options.db.connection.transaction(() => {
      const insert = this.options.db.connection.prepare("INSERT OR IGNORE INTO durable_bot_message_workspaces VALUES (?, ?, ?)");
      for (const [id, cwd] of rows) insert.run(taskId, id, cwd);
    }).immediate();
  }

  private openBound(taskId: string): Promise<OpenBot> {
    if (this.closing) return Promise.reject(new Error("Bot runtime is closing"));
    const passive = this.passiveReads.get(taskId);
    if (passive) return passive.then(() => this.openBound(taskId));
    // A failed Session is being torn down; reopen only after its lease/MCP are released.
    const invalidating = this.invalidations.get(taskId);
    if (invalidating) return invalidating.then(() => this.openBound(taskId));
    const existing = this.opened.get(taskId);
    if (existing) {
      if (!existing.runtime.isSessionFailed()) return Promise.resolve(existing);
      this.opened.delete(taskId);
      return this.invalidate(taskId, existing).then(() => this.openBound(taskId));
    }
    const opening = this.opening.get(taskId);
    if (opening) return opening;
    const pending = this.openInternal(taskId).then(open => {
      this.opened.set(taskId, open);
      this.observeFailure(taskId, open);
      return open;
    }).finally(() => this.opening.delete(taskId));
    this.opening.set(taskId, pending);
    return pending;
  }

  /** A failed Session must leave routing so the next open() constructs a fresh Harness over committed content. */
  private observeFailure(taskId: string, open: OpenBot): void {
    open.runtime.onSessionFailed(error => {
      if (this.opened.get(taskId) !== open) return;
      console.warn(`[Durable] Session failed for ${taskId}; reopening on next access`, error);
      void this.invalidate(taskId, open).catch(closeError => console.warn(`[Durable] Failed runtime cleanup failed for ${taskId}`, closeError));
    });
  }

  /** Idempotently evict one OpenBot and release its runtime lease plus MCP clients. */
  private invalidate(taskId: string, open: OpenBot): Promise<void> {
    if (open.closing) return open.closing;
    if (this.opened.get(taskId) === open) this.opened.delete(taskId);
    const closing = (async () => {
      this.options.onRelease?.(taskId);
      await open.runtime.close();
      await open.refreshingMcp?.promise.catch(() => {});
      await Promise.allSettled([open.mcp, ...open.retiredMcp].map(mcp => mcp.close()));
    })().catch(error => { console.warn(`[Durable] Failed to close failed session ${taskId}`, error); });
    open.closing = closing;
    this.invalidations.set(taskId, closing);
    void closing.finally(() => { if (this.invalidations.get(taskId) === closing) this.invalidations.delete(taskId); });
    return closing;
  }

  /** Reopen exactly once on SessionFailed; StorageRequestError and ordinary errors propagate unchanged. */
  private async withRecovery<T>(taskId: string, operation: (open: OpenBot) => Promise<T>): Promise<T> {
    const open = await this.open(taskId);
    try {
      return await operation(open);
    } catch (error) {
      if (!(error instanceof SessionFailed)) throw error;
      await this.invalidate(taskId, open);
      const reopened = await this.open(taskId);
      return operation(reopened);
    }
  }

  private async openInternal(taskId: string): Promise<OpenBot> {
    const { db, agentDir, models } = this.options;
    this.options.expertBindings?.ensureLegacy(taskId);
    const task = db.getTask(taskId);
    if (!task) throw new Error("任务不存在");
    const prior = this.binding(taskId);
    const move = this.workspaceMove(taskId);
    const cwd = move?.to_cwd ?? prior?.cwd ?? this.options.resolveCwd(taskId);
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`Bot 工作目录不存在：${cwd}`);
    // Pending native operations retain their root; idle moves are committed below.
    if (!move && task.cwd !== cwd) db.bindTaskExecutionWorkspaceCwd(taskId, cwd);
    task.cwd = cwd;
    const directory = prior?.directory ?? join(agentDir, "durable", createHash("sha256").update(taskId).digest("hex"));
    db.connection.prepare("INSERT OR IGNORE INTO durable_bot_bindings(task_id, backend, directory, cwd) VALUES (?, 'pi-durable', ?, ?)").run(taskId, directory, cwd);
    const config = this.mcpConfiguration(taskId);
    const mcp = await DurableMcp.open(config, this.credentials, models, cwd);
    let openedRuntime: DurableBotRuntime | undefined;
    try {
      // Existing project files are not newly produced artifacts on reconnect. Persisted native
      // write/edit records restore their cards independently of this workspace diff baseline.
      // Baseline and the end-of-turn snapshot MUST use the same snapshotWorkspace filter: an
      // unfiltered baseline used to collide with a filtered after snapshot and made every
      // pre-existing project file look like a newly produced artifact of the current turn.
      let workspaceBefore = await snapshotWorkspace(cwd);
      let projected = "";
      const messageWorkspaces = new Map((db.connection.prepare("SELECT message_id, cwd FROM durable_bot_message_workspaces WHERE task_id = ?").all(taskId) as Array<{ message_id: string; cwd: string }>).map(row => [row.message_id, row.cwd]));
      // 打开会话/读历史不是「发请求」：模型目录暂时解析不到也不能阻断，先沿用任务记录的坐标。
      const resolvedModel = await this.resolveTaskModelForOpen(task);
      const selected = resolvedModel?.target;
      const modelRepair = resolvedModel?.repairedFrom
        ? { from: resolvedModel.repairedFrom, to: modelKey(resolvedModel.target) }
        : undefined;
      let domain: DurableDomainTools | undefined;
      try { domain = await this.options.tools?.(task, cwd, mcp); }
      catch (error) { throw new DurableToolAssemblyError(error); }
      const base = this.options.assetsDir?.replace(/([\\/])app\.asar(?=[\\/])/, "$1app.asar.unpacked");
      const wasm = base && join(base, "quickjs.wasm");
      const worker = base && join(base, "codemode-worker.cjs");
      const initialHistory = async () => {
        const legacy = task.sessionFile ? SessionManager.open(task.sessionFile, undefined, cwd) : undefined;
        return legacy ? {
          messages: convertToLlm(legacy.getBranch().flatMap(entry => entry.type === "message" ? [entry.message] : [])),
          context: convertToLlm(legacy.buildSessionContext().messages),
        } : undefined;
      };
      const projectionCheckpoint = db.connection.prepare("SELECT entry_id FROM durable_bot_memory_projection WHERE task_id = ?").get(taskId) as { entry_id: number } | undefined;
      let previousSnapshot: DurableBotSnapshot | undefined;
      let settledKey: string | undefined;
      // One task + binding read per synchronous permission phase. Approval/resource re-checks
      // land after a microtask, so the gate has already expired and they read fresh state.
      // Prepared once per opened Bot; SQL compares the stored value so unchanged projections and
      // external edits both behave correctly without an in-memory last-value cache.
      const taskProjection = new DurableTaskProjection(db.connection);
      const toolGate = new ToolGate(
        () => db.getTask(taskId) ?? task,
        (candidate, name) => this.options.toolAllowed?.(candidate, name) ?? true,
      );
      const runtime = await DurableBotRuntime.open({ directory, cwd, models, initialHistory,
        workspaceMigrationFrom: move?.from_cwd,
        projectionAfterEntryId: projectionCheckpoint?.entry_id ?? 0,
        toolAllowed: name => toolGate.allowed(name),
        taskId, model: selected, toolMode: this.toolMode(task), tools: [...mcp.tools, ...domain?.tools ?? []],
        contextHooks: domain?.contextHooks ?? [],
        toolHooks: domain?.toolHooks,
        restoreTools: names => mcp.restoreTools(names),
        prepareCodeMode: (code, context) => (this.opened.get(taskId)?.mcp ?? mcp).codeModeTools(code, context),
        onEntries: (entries, info) => this.options.onEntries?.(taskId, entries, info),
        onResponse: (message, info) => this.options.onResponse?.(taskId, message, info),
        onRequest: info => this.options.onRequest?.(taskId, info),
        beforeProviderRequest: () => this.options.beforeModelRequest?.(taskId),
        providerAuthorityGuarded: () => this.options.providerAuthorityGuarded?.(taskId) ?? false,
        onProviderUsage: input => this.options.onProviderUsage?.(taskId, input),
        onTool: this.options.onTool,
        observedUsage: conversationId => this.options.observedUsage?.(taskId, conversationId) ?? { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheHitRate: null },
        waitingForInput: () => this.options.waitingForInput?.(taskId) ?? false,
        evidence: messages => this.options.evidence?.(db.getTask(taskId) ?? task, messages) ?? "",
        evidenceProjection: this.options.evidenceProjection?.(task),
        onTurns: turns => {
          if (!this.options.onTurns || !turns.length) return;
          db.connection.transaction(() => {
            const prior = db.connection.prepare("SELECT entry_id FROM durable_bot_memory_projection WHERE task_id=?").get(taskId) as { entry_id: number } | undefined;
            const fresh = turns.filter(turn => turn.entryId > (prior?.entry_id ?? 0));
            if (!fresh.length) return;
            this.options.onTurns!(taskId, fresh);
            db.connection.prepare("INSERT INTO durable_bot_memory_projection VALUES (?,?) ON CONFLICT(task_id) DO UPDATE SET entry_id=excluded.entry_id")
              .run(taskId, fresh.at(-1)!.entryId);
          })();
        },
        ...(wasm && worker && existsSync(wasm) && existsSync(worker) ? { assets: { wasm: loadQuickJSWasm(wasm), workerUrl: pathToFileURL(worker) } } : {}),
        instructions: () => this.options.instructions(db.getTask(taskId) ?? task),
        onSnapshot: snapshot => {
          // Projection only; this status is never consulted to resume or finish durable work.
          taskProjection.writeStatus(taskId, snapshot.busy ? "in_progress" : snapshot.error || snapshot.outcome === "failed" ? "failed" : snapshot.outcome === "completed" ? "completed" : "pending");
          const messageTime = snapshot.messages.at(-1)?.createdAt;
          if (messageTime !== undefined) taskProjection.touch(taskId, messageTime);
          const { messages: _messages, epoch: _epoch, revision: _revision, ...state } = snapshot;
          this.options.emit(previousSnapshot?.epoch === snapshot.epoch
            ? { type: "durable_delta", taskId, delta: durableDelta(previousSnapshot, snapshot, state) }
            : { type: "durable_snapshot", taskId, snapshot });
          previousSnapshot = snapshot;
          if (snapshot.contextUsage) this.options.emit({ type: "context_usage", taskId, ...snapshot.contextUsage });
          // Relative historical write paths belong to the directory where their message was
          // observed, not the current space. Prime old history before committing a move.
          for (const message of snapshot.messages) if (!messageWorkspaces.has(message.id)) {
            taskProjection.rememberWorkspace(taskId, message.id, cwd);
            messageWorkspaces.set(message.id, cwd);
          }
          const signature = snapshot.messages.at(-1)?.id ?? "";
          if (!snapshot.busy && signature && signature !== projected && this.options.projectArtifacts) {
            projected = signature;
            const projection = (this.projections.get(taskId) ?? Promise.resolve()).then(async () => {
              await this.options.projectArtifacts!(taskId, snapshot, workspaceBefore, cwd, messageWorkspaces);
              workspaceBefore = await snapshotWorkspace(cwd);
            }).catch(error => console.warn("[Durable] Artifact projection failed", taskId, error));
            this.projections.set(taskId, projection);
          }
        },
        onProjected: snapshot => {
          const key = `${snapshot.conversationId}:${snapshot.messages.at(-1)?.id ?? ""}:${snapshot.outcome ?? ""}`;
          if (!snapshot.busy && !snapshot.queued && snapshot.outcome && key !== settledKey) {
            settledKey = key;
            this.options.onSettled?.(taskId, snapshot);
          }
        },
      });
      openedRuntime = runtime;
      if (move) db.connection.transaction(() => {
        db.connection.prepare("UPDATE durable_bot_bindings SET cwd = ? WHERE task_id = ?").run(cwd, taskId);
        db.bindTaskExecutionWorkspaceCwd(taskId, cwd);
        db.connection.prepare("DELETE FROM durable_bot_workspace_moves WHERE task_id = ?").run(taskId);
      }).immediate();
      return { runtime, mcp, mcpConfigKey: JSON.stringify(config), retiredMcp: new Set(), ...(modelRepair ? { modelRepair } : {}) };
    } catch (error) { await openedRuntime?.close(); await mcp.close(); throw error; }
  }

  private mcpConfiguration(taskId: string) {
    const config = this.config.loadRuntimeConfig();
    const task = this.options.db.getTask(taskId);
    const selected = task && this.options.mcpSelection ? this.options.mcpSelection(task) : this.options.expertBindings?.active(taskId)?.mcpIds;
    const selectedConfig = selected === undefined ? config : {
      ...config, mcpServers: Object.fromEntries(Object.entries(config.mcpServers ?? {}).filter(([id]) => selected.includes(id))),
    };
    // Project the existing entries unchanged: a selected disabled service stays disabled.
    return toNativeMcpConfig(emptyMcpFilterResult(selectedConfig), this.config.getAppGlobalConfigPath(), false);
  }

  private async configuredMcp(open: OpenBot, cwd: string, taskId: string): Promise<DurableMcp> {
    const config = this.mcpConfiguration(taskId);
    const key = JSON.stringify(config);
    if (key === open.mcpConfigKey) return open.mcp;
    if (open.refreshingMcp?.key === key) return open.refreshingMcp.promise;
    const promise = DurableMcp.open(config, this.credentials, this.options.models, cwd).then(mcp => {
      // In-flight native ToolTasks may still own the previous client. Keep it alive until release.
      open.retiredMcp.add(open.mcp);
      open.mcp = mcp; open.mcpConfigKey = key;
      return mcp;
    });
    open.refreshingMcp = { key, promise };
    try { return await promise; }
    finally { if (open.refreshingMcp?.promise === promise) open.refreshingMcp = undefined; }
  }

  /**
   * 任务持久化的模型坐标可能已被模型目录淘汰（网关路由重组、厂商目录收缩）。
   * 这里按 BotModelCatalog 的确定规则替换并**立即写回任务**，让输入框后续显示与实际执行一致；
   * 替换事实存进 OpenBot.modelRepair，历史打开时作为 modelRecovery 展示，不静默换模型。
   */
  private async resolveTaskModel(task: TaskDto): Promise<BotModelResolution> {
    const resolution = await resolveBotModel(this.options.models, task.modelId, this.options.defaultModel());
    const target = resolution.target;
    if (!resolution.repairedFrom) return resolution;
    const repair: BotModelRepair = { from: resolution.repairedFrom, to: modelKey(target) };
    const current = this.options.db.getTask(task.id) ?? task;
    if (current.modelId !== repair.to) {
      // updatedAt 保持不变：修复模型归属不应把任务顶到列表最前。
      this.options.db.upsertTask({ ...current, modelId: repair.to });
      console.warn(`[Durable] 任务 ${task.id} 的模型 ${repair.from} 已不在模型目录中，改用 ${repair.to}（${resolution.reason}）`);
    }
    return resolution;
  }

  /**
   * 打开会话（含只读历史）时的模型解析：尽力而为，绝不抛错。
   * 模型目录 = 为「发请求」准备的运行时配置；历史能否打开只取决于 Durable 存储本身。
   */
  private async resolveTaskModelForOpen(task: TaskDto): Promise<BotModelResolution | undefined> {
    try { return await this.resolveTaskModel(task); }
    catch (error) {
      console.warn(`[Durable] 任务 ${task.id} 暂时解析不到可用模型，打开会话先沿用 ${task.modelId ?? "(未记录)"}：${failureText(error)}`);
      return undefined;
    }
  }

  private async prepareRequest(request: AgentPromptRequest): Promise<AgentPromptRequest> {
    request = await this.options.prepareTask?.(request) ?? request;
    await this.options.models.refresh({ allowNetwork: false });
    this.options.expertBindings?.ensureLegacy(request.taskId);
    const task = this.options.db.getTask(request.taskId);
    if (!task) throw new Error("任务不存在");
    // Product selections are durable task configuration, never global scene state.
    this.options.db.upsertTask({ ...task, modelId: request.modelId ?? task.modelId,
      permissionMode: request.permissionMode ?? task.permissionMode,
      welcomeMode: request.welcomeMode ?? task.welcomeMode,
      expertId: this.options.expertBindings?.get(task.id) ? task.expertId : request.expertId ?? task.expertId,
      modePresetId: request.modePresetId !== undefined ? request.modePresetId : task.modePresetId, updatedAt: Date.now() });
    return request;
  }

  private async configureRequest(open: OpenBot, request: AgentPromptRequest): Promise<BotModelResolution["target"]> {
      // Admission is serialized. Queued inputs and resumed work finish with the old active identity;
      // only a newly admitted input after native idle can adopt a saved desired revision.
      if (await open.runtime.isIdle()) {
        const before = this.options.expertBindings?.get(request.taskId);
        const binding = this.options.expertBindings?.promote(request.taskId);
        if (before?.pending && binding) this.options.emit({ type: "expert_binding", taskId: request.taskId, binding });
      }
      const current = this.options.db.getTask(request.taskId)!;
      const mcp = await this.configuredMcp(open, this.binding(request.taskId)!.cwd, request.taskId);
      // 只有真正要发请求时才要求模型可用：这里解析失败会明确报错，而不是把会话标成损坏。
      const resolvedModel = await this.resolveTaskModel(current);
      // 替换提示是一次性的开卷告知：一旦本轮能按任务模型正常执行（用户也可能已手动改选模型），就收起。
      open.modelRepair = resolvedModel.repairedFrom
        ? { from: resolvedModel.repairedFrom, to: modelKey(resolvedModel.target) }
        : undefined;
      const domain = await this.options.tools?.(current, this.binding(request.taskId)!.cwd, mcp);
      await open.runtime.configure(resolvedModel.target, this.toolMode(current), this.options.thinking?.(current, request),
        [...mcp.tools, ...domain?.tools ?? []], domain?.contextHooks ?? [], domain?.toolHooks);
      return resolvedModel.target;
  }

  private async admit(request: AgentPromptRequest) {
    // Committed retries retain their original configuration and input preparation.
    if (this.binding(request.taskId)) {
      const existing = await this.withRecovery(request.taskId, async open => {
        const record = await this.findSubmissionRecord(open, request.userMessageId);
        const submission = record && await open.runtime.harness.submission(record.id, context);
        return submission ? { submission, open } : undefined;
      });
      if (existing) return existing;
    }
    request = await this.prepareRequest(request);
    return this.withRecovery(request.taskId, async open => {
      const model = await this.configureRequest(open, request);
      let text = await this.options.prepareInput?.(request) ?? request.text;
      if (!this.options.prepareInput && request.terminalContext) text += `\n\nTerminal context supplied by the user:\n${JSON.stringify(request.terminalContext)}`;
      const content: Exclude<import("@earendil-works/pi-durable").UserInput, string> = [{ type: "text", text }];
      if (this.options.prepareImages) {
        const images = await this.options.prepareImages({ ...request, modelId: modelKey(model) });
        content.push(...images.images);
        if (images.text) content.push({ type: "text", text: images.text });
      }
      for (const attachment of request.attachments ?? []) {
        const mime = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" } as Record<string,string>)[extname(attachment.path).toLowerCase()];
        if (mime && !this.options.prepareImages) content.push({ type: "image", mimeType: mime, data: readFileSync(attachment.path).toString("base64") });
        content.push({ type: "text", text: `\nAttached file: ${attachment.name}\n${attachment.path}` });
      }
      const audit = this.options.auditInput?.(request);
      this.options.beforeSubmit?.(request);
      const submission = await open.runtime.submit(content, request.userMessageId, request.streamingBehavior,
        { text: request.text, displayText: request.displayText ?? request.text, attachments: request.attachments ?? [], ...(audit ? { audit } : {}) });
      return { submission, open };
    });
  }

  private async admitTracked(request: AgentPromptRequest) {
    return this.trackAdmission(request.taskId, () => this.admit(request));
  }

  private trackAdmission<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.admissionTails.get(taskId) ?? Promise.resolve();
    const pending = prior.catch(() => {}).then(async () => {
      if (this.options.db.getTask(taskId)) await this.open(taskId, true);
      return operation();
    });
    this.admissionTails.set(taskId, pending);
    const admissions = this.admissions.get(taskId) ?? new Set();
    admissions.add(pending); this.admissions.set(taskId, admissions);
    return pending.finally(() => {
      admissions.delete(pending);
      if (!admissions.size) this.admissions.delete(taskId);
      if (this.admissionTails.get(taskId) === pending) this.admissionTails.delete(taskId);
    });
  }

  async deleteUserMessage(request: AgentDeleteUserMessageRequest): Promise<number> {
    return this.trackAdmission(request.taskId, async () => {
      const open = await this.open(request.taskId);
      const selected = await findDurableUserEntry(open.runtime.conversation, request, context);
      const timestamp = selected.entry.model?.find(message => message.role === "user")?.timestamp ?? 0;
      await open.runtime.forkAt(selected.previous?.id);
      await this.release(request.taskId);
      await this.open(request.taskId);
      return timestamp;
    });
  }

  async regenerate(request: AgentRegenerateRequest): Promise<AgentRegenerateResult> {
    return this.trackAdmission(request.taskId, async () => {
      const fail = (code: Extract<AgentRegenerateResult, { ok: false }>["code"], message: string): AgentRegenerateResult => ({ ok: false, requestId: request.requestId, code, message });
      try {
        if (!this.options.db.getTask(request.taskId)) return fail("SESSION_NOT_FOUND", "任务不存在");
        const open = await this.open(request.taskId);
        const operationId = `regenerate:${request.requestId}`;
        const existing = await open.runtime.conversation.commit(tx => tx.submissionByRequest(open.runtime.conversation.id, operationId), context);
        if (existing?.type === "input") return { ok: true, requestId: request.requestId, assistantMessageId: request.assistantMessageId, userEntryId: existing.entry && String(existing.entry) };
        if (!await open.runtime.isIdle()) return fail("SESSION_BUSY", "任务仍在执行，请先停止生成");
        const selected = await findDurableUserEntry(open.runtime.conversation, { entryId: request.sourceUserEntryId, userMessageIndex: request.userMessageIndex }, context);
        const user = selected.entry.model?.find(message => message.role === "user");
        if (!user) return fail("TARGET_NOT_FOUND", "找不到所选用户输入");
        const metadata = open.runtime.inputMetadata(selected.entry.id);
        if (request.sourceUserMessageId !== `durable-${selected.entry.id}` && request.sourceUserMessageId !== metadata?.audit?.userMessageId) {
          return fail("TARGET_DRIFTED", "所选用户消息身份已变化，请刷新对话");
        }
        const displayText = metadata?.displayText ?? durableContentText(user.content);
        if (request.expectedUserTextHash && normalizedEditorTextHash(displayText) !== request.expectedUserTextHash) return fail("TARGET_DRIFTED", "所选输入已发生变化，请刷新对话");
        const prepared = await this.prepareRequest({ ...request, text: displayText, displayText, userMessageId: operationId });
        await this.configureRequest(open, prepared);
        const audit = this.options.auditInput?.(prepared);
        await open.runtime.forkForRegeneration(selected.previous?.id, { operationId, content: user.content,
          metadata: { ...(metadata ?? { text: displayText, displayText, attachments: [] }), ...(audit ? { audit } : {}) } });
        await this.release(request.taskId);
        const submission = await (await this.open(request.taskId)).runtime.resumeRegeneration();
        if (!submission) throw new Error("重新生成回执不存在");
        const state = await submission.status(context);
        return { ok: true, requestId: request.requestId, assistantMessageId: request.assistantMessageId, userEntryId: state.entry && String(state.entry) };
      } catch (error) { return fail(error instanceof DurableUserEntryNotFoundError ? "TARGET_NOT_FOUND" : "PROMPT_FAILED", failureText(error)); }
    });
  }

  async runGatewayTurn(request: AgentPromptRequest): Promise<string> {
    if (!isGatewayBotTaskId(request.taskId)) throw new Error("Gateway Bot 任务身份无效");
    const existing = this.options.db.getTask(request.taskId);
    this.options.db.upsertTask({ ...(existing ?? { id: request.taskId,
      title: (request.displayText ?? request.text).trim().slice(0, 60) || "助理" }),
      ...(!existing?.spaceId && request.spaceId ? { spaceId: request.spaceId } : {}),
      welcomeMode: "general", modePresetId: "native", updatedAt: Date.now() });
    const { submission, open } = await this.admitTracked({ ...request, modePresetId: "native" });
    try {
      return await open.runtime.reply(submission);
    } catch (error) {
      if (!(error instanceof SessionFailed)) throw error;
      await this.invalidate(request.taskId, open);
      const reopened = await this.open(request.taskId);
      const recovered = await reopened.runtime.harness.submission(submission.id, context);
      if (!recovered) throw error;
      return reopened.runtime.reply(recovered);
    }
  }

  async submit(request: AgentPromptRequest): Promise<AgentPromptResult> {
    const { submission } = await this.admitTracked(request);
    const state = await submission.status(context);
    return submissionResult(request.taskId, state);
  }

  workExecutionPort(): WorkExecutionPort {
    return {
      prepare: async taskId => {
        const open = await this.open(taskId);
        const binding = this.binding(taskId);
        if (!binding) throw new Error("原生执行缺少持久化存储绑定");
        return { taskId, durableStoreKey: binding.directory, conversationId: String(open.runtime.conversation.id), workspaceBinding: binding.cwd };
      },
      find: async binding => {
        const { record } = await this.workSubmission(binding);
        return record ? submissionResult(binding.taskId, record).receipt : undefined;
      },
      submit: async (binding, text) => {
        const { open } = await this.workSubmission(binding);
        if (String(open.runtime.conversation.id) !== binding.conversationId) throw new Error("原接收会话已变化，拒绝改用另一会话派发");
        const accepted = await this.submit({ taskId: binding.taskId, userMessageId: binding.operationId,
          assistantMessageId: `work:${binding.bindingId}`, text });
        if (!accepted.receipt) throw new Error(accepted.error?.message ?? "原生执行未返回受理回执");
        return accepted.receipt;
      },
      stop: async binding => {
        const { open } = await this.workSubmission(binding);
        if (String(open.runtime.conversation.id) !== binding.conversationId) throw new Error("停止目标与原执行会话不一致");
        await this.abort(binding.taskId);
      },
      inspect: async (binding, receipt) => {
        const { open, record } = await this.workSubmission(binding);
        if (!record || record.id !== receipt.submissionId || record.requestId !== receipt.operationId) throw new Error("执行回执与原命名空间不一致");
        const observation = await open.runtime.conversation.commit(tx => readDurableWorkExecution(tx, record, binding.workspaceBinding), context);
        if (observation.status === "running") return observation;
        const dedicated = this.options.db.connection.prepare("SELECT 1 FROM work_dispatch_requests WHERE task_id=? AND work_id=?")
          .get(binding.taskId, binding.workId);
        if (dedicated) {
          // The host creates one fresh store per input. Session totals therefore
          // include exactly its root, owned children and compaction, without
          // attributing a shared answer or another Work's history to this binding.
          const inspection = await open.runtime.harness.inspect(context);
          if (inspection.tasks.length) return { status: "running" };
          const interruptedUsage = await open.runtime.conversation.commit(async tx => {
            let cursor: Cursor | undefined;
            do {
              const page = await tx.scanTasks({}, 200, cursor);
              if (page.items.some(task => ["pi.generation", "pi.compaction"].includes(task.kind) && task.state.status === "terminal"
                && ["aborted", "faulted", "orphaned"].includes(task.state.outcome.status))) return true;
              cursor = page.next;
            } while (cursor);
            return false;
          }, context);
          const usage = await open.runtime.harness.usage(context);
          const usageTokens = [...Object.values(usage.models), ...Object.values(usage.tools)].reduce((sum, item) => sum + item.totalTokens, 0);
          return { ...observation, usageTokens: observation.status === "stopped" || interruptedUsage ? undefined : usageTokens };
        }
        return observation;
      },
    };
  }

  private async workSubmission(binding: WorkExecutionBindingDto): Promise<{ open: OpenBot; record: SubmissionRecord | undefined }> {
    const stored = this.binding(binding.taskId);
    if (!stored || stored.directory !== binding.durableStoreKey || stored.cwd !== binding.workspaceBinding) {
      throw new Error("Work 执行与原生 task/store/workspace 绑定不一致，拒绝重新分配");
    }
    return this.withRecovery(binding.taskId, async open => {
      const record = await open.runtime.conversation.commit(async tx => {
        let cursor: Cursor | undefined;
        do {
          const page = await tx.scanConversations({}, 200, cursor);
          const original = page.items.find(conversation => String(conversation.id) === binding.conversationId && !conversation.owner);
          if (original) return tx.submissionByRequest(original.id, binding.operationId);
          cursor = page.next;
        } while (cursor);
        throw new Error("原接收会话不存在，不能换会话重新提交");
      }, context);
      return { open, record };
    });
  }

  /** Inspect an accepted input before an adapter validates or changes mutable task configuration. */
  async findSubmission(taskId: string, operationId: string): Promise<AgentPromptResult | undefined> {
    if (!operationId) throw new Error("无效执行身份");
    await this.admissionTails.get(taskId)?.catch(() => {});
    if (!this.binding(taskId)) return undefined;
    return this.withRecovery(taskId, async open => {
      const record = await this.findSubmissionRecord(open, operationId);
      return record?.type === "input" ? submissionResult(taskId, record) : undefined;
    });
  }

  private findSubmissionRecord(open: OpenBot, operationId: string): Promise<SubmissionRecord | undefined> {
    return open.runtime.conversation.commit(async tx => {
      const current = await tx.submissionByRequest(open.runtime.conversation.id, operationId);
      if (current) return current;
      let cursor: Cursor | undefined;
      do {
        const page = await tx.scanConversations({}, 200, cursor);
        for (const conversation of page.items) {
          if (conversation.owner || conversation.id === open.runtime.conversation.id) continue;
          const prior = await tx.submissionByRequest(conversation.id, operationId);
          if (prior) return prior;
        }
        cursor = page.next;
      } while (cursor);
      return undefined;
    }, context);
  }

  async submissionStatus(receipt: AgentSubmissionReceipt, wait = false): Promise<AgentPromptResult> {
    if (!Number.isSafeInteger(receipt.submissionId) || receipt.submissionId <= 0 || !receipt.operationId) throw new Error("无效执行回执");
    return this.withRecovery(receipt.taskId, async open => {
      const submission = await open.runtime.harness.submission(receipt.submissionId as SubmissionId, context);
      if (!submission) throw new Error("执行回执不存在");
      const state = await submission.status(context);
      if (state.requestId !== receipt.operationId || state.type !== "input") throw new Error("执行回执不属于该任务或操作");
      const result = wait ? await submission.wait(context) : state;
      if (wait) await open.runtime.refresh();
      const response = submissionResult(receipt.taskId, result);
      if (result.status === "done" && result.type === "input") {
        const entry = await open.runtime.conversation.commit(tx => tx.entry(result.answer), context);
        const answer = entry?.model?.find(message => message.role === "assistant");
        if (!answer || answer.stopReason === "error" || answer.stopReason === "aborted" || answer.stopReason === "length" || !answer.content.some(block => block.type === "text" && block.text.trim())) {
          return { ...response, cancelled: answer?.stopReason === "aborted", error: { code: "DURABLE_FAILED", message: answer?.errorMessage ?? "该次输入未产生完整回复" } };
        }
      }
      return response;
    });
  }

  async prompt(request: AgentPromptRequest, admissionOnly = true): Promise<AgentPromptResult> {
    const accepted = await this.submit(request);
    return admissionOnly || !accepted.receipt ? accepted : this.submissionStatus(accepted.receipt, true);
  }

  async history(taskId: string, beforeEntryId?: number): Promise<TaskHistoryDto> {
    if (!this.binding(taskId) && !this.options.db.getTask(taskId)?.sessionFile) return { messages: [] };
    try {
      const recovered = await this.withRecovery(taskId, async open => {
        const block = beforeEntryId === undefined ? undefined : await open.runtime.loadHistoryBlock(beforeEntryId);
        const snapshot = block ? open.runtime.snapshot : await open.runtime.refresh();
        return { runtime: open.runtime, snapshot, block, modelRepair: open.modelRepair };
      });
      await this.projections.get(taskId);
      const recovery = durableHistoryRecovery(recovered.runtime.repairReport);
      // 复述任务当前模型（可能刚刚被目录漂移修复过），渲染层据此校正输入框的模型选择。
      const modelId = this.options.db.getTask(taskId)?.modelId;
      return { messages: recovered.block?.messages ?? recovered.snapshot.messages, durable: recovered.snapshot,
        ...(recovered.block ? { page: { epoch: recovered.block.epoch, before: recovered.block.before } } : {}), cwd: this.binding(taskId)?.cwd,
        ...(modelId ? { modelId } : {}), ...(recovered.modelRepair ? { modelRecovery: recovered.modelRepair } : {}),
        ...(recovery ? { sessionRecovery: recovery } : {}) };
    } catch (error) {
      if (error instanceof DurableToolAssemblyError) {
        try { return await this.passiveHistory(taskId, beforeEntryId); }
        catch (readError) { error = readError; }
      }
      // A Bot conversation that cannot be opened must say so: an empty projection renders as the
      // product's "waiting for the first message" state, which hides real damage from the user.
      console.warn("[Durable] Cannot open history", taskId, error);
      return { messages: [], cwd: this.binding(taskId)?.cwd, historyError: describeDurableHistoryFailure(error) };
    }
  }
  async refresh(taskId: string): Promise<void> {
    const open = this.opened.get(taskId);
    if (open) await open.runtime.refresh();
  }

  private async passiveHistory(taskId: string, beforeEntryId?: number): Promise<TaskHistoryDto> {
    for (;;) {
      const prior = this.passiveReads.get(taskId);
      if (!prior) break;
      await prior;
    }
    if (this.closing) throw new Error("Bot runtime is closing");
    // Another request may already have rebuilt a healthy writer. Use it instead of claiming its lease.
    if (this.opened.has(taskId) || this.opening.has(taskId)) return this.history(taskId, beforeEntryId);
    const binding = this.binding(taskId);
    if (!binding) return { messages: [] };
    const reading = readDurableReadOnlyHistory({ directory: binding.directory, cwd: binding.cwd,
      models: this.options.models, beforeEntryId });
    const barrier = reading.then(() => {}, () => {}).finally(() => {
      if (this.passiveReads.get(taskId) === barrier) this.passiveReads.delete(taskId);
    });
    this.passiveReads.set(taskId, barrier);
    return reading;
  }

  async previewBranch(request: CreateConversationBranchRequest): Promise<DurableBranchAnchor> {
    return this.trackAdmission(request.sourceTaskId, async () => resolveDurableBranch((await this.open(request.sourceTaskId)).runtime, request));
  }

  async materializeBranch(sourceTaskId: string, childTaskId: string, cwd: string, anchor: DurableBranchAnchor): Promise<MaterializedDurableBranch> {
    const initialBranch = await this.trackAdmission(sourceTaskId, async () => captureDurableBranch((await this.open(sourceTaskId)).runtime, anchor));
    const directory = join(this.options.agentDir, "durable", createHash("sha256").update(childTaskId).digest("hex"));
    const runtime = await DurableBotRuntime.open({ directory, cwd, models: this.options.models, initialBranch,
      toolMode: "native", toolAllowed: () => false, instructions: () => "", onSnapshot: () => {} });
    try {
      const entries = await runtime.conversation.entries({ order: "descending" }, 1, undefined, context);
      const inheritedLastEntryId = entries.items[0]?.id;
      if (inheritedLastEntryId === undefined) throw new Error("分支历史未写入持久存储");
      return { directory, inheritedLastEntryId };
    } finally { await runtime.close(); }
  }

  commitBranch(taskId: string, cwd: string, branch: MaterializedDurableBranch): void {
    this.options.db.connection.prepare("INSERT INTO durable_bot_bindings(task_id, backend, directory, cwd) VALUES (?, 'pi-durable', ?, ?)").run(taskId, branch.directory, cwd);
    this.options.db.connection.prepare("INSERT INTO durable_bot_memory_projection(task_id, entry_id) VALUES (?, ?)").run(taskId, branch.inheritedLastEntryId);
  }

  async inheritedBranchMessages(taskId: string): Promise<Map<string, string>> {
    const { runtime } = await this.open(taskId);
    const messages = new Map<string, string>();
    let cursor: Cursor | undefined;
    do {
      const page = await runtime.conversation.entries({ order: "ascending" }, 500, cursor, context);
      for (const entry of page.items) {
        const data = entry.data;
        if (entry.model?.some(message => message.role === "assistant") && data && typeof data === "object" && !Array.isArray(data)
          && data.inherited === true && typeof data.sourceEntryId === "string") messages.set(data.sourceEntryId, `durable-${entry.id}`);
      }
      cursor = page.next;
    } while (cursor);
    return messages;
  }
  async abort(taskId: string): Promise<void> {
    // Stop orders after any already-started input admission, then native abort owns cancellation.
    await Promise.allSettled([...(this.admissions.get(taskId) ?? [])]);
    try { if (this.binding(taskId)) await this.withRecovery(taskId, open => open.runtime.abort()); }
    finally { this.options.onRelease?.(taskId); }
  }
  async compact(taskId: string): Promise<void> { await this.trackAdmission(taskId, () => this.withRecovery(taskId, open => open.runtime.compact())); }
  async abortCompaction(taskId: string): Promise<boolean> { return await this.opened.get(taskId)?.runtime.abortCompaction() ?? false; }
  async purge(taskId: string): Promise<void> {
    if (this.options.db.getTask(taskId)) throw new Error("Only a permanently deleted task can purge Durable storage");
    await this.release(taskId);
    const root = resolve(this.options.agentDir, "durable");
    const directory = resolve(root, createHash("sha256").update(taskId).digest("hex"));
    if (dirname(directory) !== root) throw new Error("Invalid Durable storage path");
    await rm(directory, { recursive: true, force: true });
    this.projections.delete(taskId);
  }
  async release(taskId: string): Promise<void> {
    await this.passiveReads.get(taskId);
    const open = this.opened.get(taskId) ?? await this.opening.get(taskId);
    const invalidating = this.invalidations.get(taskId);
    if (!open) { await invalidating; return; }
    await this.invalidate(taskId, open);
    await this.projections.get(taskId);
  }
  async close(): Promise<void> {
    this.closing = true;
    this.resumeAdmission?.cancel();
    await Promise.allSettled(this.passiveReads.values());
    await Promise.allSettled([...new Set([...this.opened.keys(), ...this.opening.keys()])].map(id => this.release(id)));
  }
}

function submissionResult(taskId: string, state: SubmissionRecord): AgentPromptResult {
  const receipt: AgentSubmissionReceipt = { taskId, operationId: state.requestId ?? "", submissionId: state.id, status: state.status };
  if (state.status === "unanswered") {
    return state.reason === "aborted"
      ? { receipt, queued: false, cancelled: true }
      : { receipt, queued: false, error: { code: "DURABLE_UNANSWERED", message: typeof state.detail === "string" ? state.detail : state.reason } };
  }
  return { receipt, queued: state.status !== "done" };
}

/** 修复过损坏日志时，把「已恢复 + 已备份」的事实告诉用户，而不是静默继续。 */
function durableHistoryRecovery(report: DurableLogRepairReport | undefined): SessionHistoryRecoveryDto | undefined {
  if (!report) return undefined;
  const dropped = report.droppedMainCommits + report.droppedSidecarRecords;
  return {
    kind: "corrupt-records",
    invalidRecords: dropped,
    tailOnly: false,
    message: `检测到 ${report.droppedMainCommits} 条重复提交记录（两个 MyBuddy 实例同时写入了同一个 Bot 会话）。已保留 ${report.keptMainCommits} 条有效提交并恢复会话；原始日志备份在 ${report.backupDirectory}。`,
  };
}

function failureText(error: unknown): string {
  if (error instanceof Error) return error.message;
  try { return String(error); }
  catch { return Object.prototype.toString.call(error); }
}

function describeDurableHistoryFailure(error: unknown): string {
  if (error instanceof SessionFailed) {
    return `Bot 会话已失败（storage error）：${failureText(error.cause)}。已尝试自动重开，但恢复未成功。`;
  }
  if (error instanceof DurableStorageOwnedError) {
    return `该 Bot 会话正被另一个 MyBuddy 实例占用（PID ${error.owner.pid}）。请只保留一个 MyBuddy 实例，稍后重新打开本会话。`;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("JsonlCorruptionError")) {
    return `Bot 会话日志损坏，自动修复未成功：${message}。原始日志未被删除，可先复制出来再做诊断。`;
  }
  return message;
}
