import { createHash } from "node:crypto";
import { existsSync, statSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, extname, resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { loadQuickJSWasm } from "@earendil-works/pi-codemode";
import { McpOAuthCredentialStore, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentPromptRequest, AgentPromptResult, AgentUiPatch, SessionHistoryRecoveryDto, TaskDto, TaskHistoryDto } from "../../../shared/agent-ipc";
import type { BotToolMode, DurableBotSnapshot } from "../../../shared/durable-bot";
import { isGatewayBotTaskId } from "../../../shared/gateway-task";
import type { AppDatabase } from "../../db/AppDatabase";
import { McpConfigService } from "../../mcp/McpConfigService";
import { emptyMcpFilterResult } from "../../mcp/McpModeFilter";
import { toNativeMcpConfig } from "../../mcp/NativeMcpConfig";
import { McpCredentialBackend } from "../../mcp/McpCredentialBackend";
import { DurableBotRuntime } from "./DurableBotRuntime";
import { modelKey, resolveBotModel, type BotModelResolution } from "./BotModelCatalog";
import type { DurableDomainTools } from "./DurableDomainTools";
import { DurableMcp } from "./DurableMcp";
import type { DurableLogRepairReport } from "./DurableLogRepair";
import { DurableStorageOwnedError } from "./DurableStorageLease";
import { snapshotWorkspace } from "../../workspace/WorkspaceService";
import { SessionFailed, type EntryRecord } from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-ai";
import type { durableCompletedTurns } from "./DurableTurnProjection";
import type { TaskExpertBindingService } from "../../experts/TaskExpertBindingService";

interface BotBinding { task_id: string; directory: string; cwd: string; backend: "pi-durable" }
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
  instructions: (task: TaskDto) => string;
  evidence?: (task: TaskDto, messages: readonly Message[]) => string;
  tools?: (task: TaskDto, cwd: string) => Promise<DurableDomainTools>;
  onTurns?: (taskId: string, turns: ReturnType<typeof durableCompletedTurns>) => void;
  onEntries?: (taskId: string, entries: readonly EntryRecord[]) => void;
  onSettled?: (taskId: string, snapshot: DurableBotSnapshot) => void;
  toolMode: (task: TaskDto) => BotToolMode;
  defaultModel: () => string | undefined;
  emit: (patch: AgentUiPatch) => void;
  projectArtifacts?: (taskId: string, snapshot: DurableBotSnapshot, before: Map<string, string>, cwd: string) => Promise<void>;
  thinking?: (task: TaskDto, request: AgentPromptRequest) => ModelThinkingLevel | undefined;
  prepareInput?: (request: AgentPromptRequest) => Promise<string>;
  prepareImages?: (request: AgentPromptRequest) => Promise<{ images: Array<{ type: "image"; mimeType: string; data: string }>; text?: string }>;
  expertBindings?: TaskExpertBindingService;
}

/** One process owns each store. SQLite only binds product IDs; all execution state is in Durable. */
export class DurableBotService {
  private readonly opening = new Map<string, Promise<OpenBot>>();
  private readonly opened = new Map<string, OpenBot>();
  private readonly config: McpConfigService;
  private readonly credentials: McpOAuthCredentialStore;
  private closing = false;
  private readonly invalidations = new Map<string, Promise<void>>();
  private readonly admissions = new Map<string, Set<Promise<unknown>>>();
  private readonly admissionTails = new Map<string, Promise<unknown>>();
  private readonly projections = new Map<string, Promise<void>>();
  constructor(private readonly options: DurableBotServiceOptions) {
    options.db.connection.exec(`CREATE TABLE IF NOT EXISTS durable_bot_bindings (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      backend TEXT NOT NULL CHECK(backend = 'pi-durable'), directory TEXT NOT NULL UNIQUE, cwd TEXT NOT NULL)`);
    options.db.connection.exec(`CREATE TABLE IF NOT EXISTS durable_bot_memory_projection (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, entry_id INTEGER NOT NULL)`);
    this.config = new McpConfigService();
    this.credentials = new McpOAuthCredentialStore(
      new McpCredentialBackend(join(options.mcpDir, "mcp-native-auth.encrypted.json")), join(options.mcpDir, "mcp-native-refresh-locks"));
  }

  owns(taskId: string): boolean {
    return this.options.db.getTask(taskId)?.welcomeMode === "bot" || Boolean(this.binding(taskId));
  }
  busy(taskId: string): boolean {
    const snapshot = this.opened.get(taskId)?.runtime.snapshot;
    return Boolean(snapshot?.busy || snapshot?.queued || this.opening.has(taskId) || this.admissions.get(taskId)?.size);
  }
  cwd(taskId: string): string | undefined { return this.binding(taskId)?.cwd; }
  lastAssistantId(taskId: string): string | undefined { return this.opened.get(taskId)?.runtime.snapshot.messages.filter(message => message.role === "assistant").at(-1)?.id; }
  contextUsage(taskId: string) {
    const value = this.opened.get(taskId)?.runtime.snapshot.contextUsage;
    return value ? { taskId, ...value } : null;
  }
  private binding(taskId: string): BotBinding | undefined {
    return this.options.db.connection.prepare("SELECT * FROM durable_bot_bindings WHERE task_id = ?").get(taskId) as BotBinding | undefined;
  }

  private toolMode(task: TaskDto): BotToolMode {
    return isGatewayBotTaskId(task.id) ? "native" : this.options.toolMode(task);
  }

  async resumePersisted(): Promise<void> {
    const bindings = this.options.db.connection.prepare("SELECT * FROM durable_bot_bindings").all() as BotBinding[];
    await Promise.all(bindings.map(async binding => {
      if (this.options.db.getTaskExecutionWorkspaceState(binding.task_id)?.state === "trashed") return;
      try { (await this.open(binding.task_id)).runtime.resume(); }
      catch (error) { console.error(`[Durable] Cannot resume ${binding.task_id}:`, error); }
    }));
  }

  private open(taskId: string): Promise<OpenBot> {
    if (this.closing) return Promise.reject(new Error("Bot runtime is closing"));
    // A failed Session is being torn down; reopen only after its lease/MCP are released.
    const invalidating = this.invalidations.get(taskId);
    if (invalidating) return invalidating.then(() => this.open(taskId));
    const existing = this.opened.get(taskId);
    if (existing) {
      if (!existing.runtime.isSessionFailed()) return Promise.resolve(existing);
      this.opened.delete(taskId);
      return this.invalidate(taskId, existing).then(() => this.open(taskId));
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
    if (!task || task.welcomeMode !== "bot") throw new Error("任务不是 Bot，不能切换其执行后端");
    if (task.sessionFile) throw new Error("旧 Pi 会话不能作为 Durable 检查点，请创建 Bot 任务");
    const prior = this.binding(taskId);
    const cwd = prior?.cwd ?? this.options.resolveCwd(taskId);
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`Bot 工作目录不存在：${cwd}`);
    // Sidebar moves change task organization; native checkpoints keep their execution directory.
    // Repair old projections which incorrectly overwrote Task.cwd with the new space's path.
    if (task.cwd !== cwd) db.bindTaskExecutionWorkspaceCwd(taskId, cwd);
    const directory = prior?.directory ?? join(agentDir, "durable", createHash("sha256").update(taskId).digest("hex"));
    db.connection.prepare("INSERT OR IGNORE INTO durable_bot_bindings(task_id, backend, directory, cwd) VALUES (?, 'pi-durable', ?, ?)").run(taskId, directory, cwd);
    const config = this.mcpConfiguration(taskId);
    const mcp = await DurableMcp.open(config, this.credentials, models, cwd);
    try {
      // Existing project files are not newly produced artifacts on reconnect. Persisted native
      // write/edit records restore their cards independently of this workspace diff baseline.
      let workspaceBefore = await snapshotWorkspace(cwd, { unfiltered: true });
      let projected = "";
      let wasBusy = false;
      // 打开会话/读历史不是「发请求」：模型目录暂时解析不到也不能阻断，先沿用任务记录的坐标。
      const resolvedModel = await this.resolveTaskModelForOpen(task);
      const selected = resolvedModel?.target;
      const modelRepair = resolvedModel?.repairedFrom
        ? { from: resolvedModel.repairedFrom, to: modelKey(resolvedModel.target) }
        : undefined;
      const domain = await this.domainToolsForOpen(task, cwd);
      const base = this.options.assetsDir?.replace(/([\\/])app\.asar(?=[\\/])/, "$1app.asar.unpacked");
      const wasm = base && join(base, "quickjs.wasm");
      const worker = base && join(base, "codemode-worker.cjs");
      const runtime = await DurableBotRuntime.open({ directory, cwd, models,
        taskId, model: selected, toolMode: this.toolMode(task), tools: [...mcp.tools, ...domain?.tools ?? []],
        contextHooks: domain?.contextHooks ?? [],
        restoreTools: names => mcp.restoreTools(names),
        prepareCodeMode: (code, context) => (this.opened.get(taskId)?.mcp ?? mcp).codeModeTools(code, context),
        onEntries: entries => this.options.onEntries?.(taskId, entries),
        evidence: messages => this.options.evidence?.(db.getTask(taskId) ?? task, messages) ?? "",
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
          db.connection.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(snapshot.busy ? "in_progress" : snapshot.error || snapshot.outcome === "failed" ? "failed" : snapshot.outcome === "completed" ? "completed" : "pending", taskId);
          this.options.emit({ type: "durable_snapshot", taskId, snapshot });
          if (snapshot.contextUsage) this.options.emit({ type: "context_usage", taskId, ...snapshot.contextUsage });
          if (wasBusy && !snapshot.busy && !snapshot.queued) this.options.onSettled?.(taskId, snapshot);
          wasBusy = snapshot.busy;
          const signature = snapshot.messages.at(-1)?.id ?? "";
          if (!snapshot.busy && signature && signature !== projected && this.options.projectArtifacts) {
            projected = signature;
            const projection = (this.projections.get(taskId) ?? Promise.resolve()).then(async () => {
              await this.options.projectArtifacts!(taskId, snapshot, workspaceBefore, cwd);
              workspaceBefore = await snapshotWorkspace(cwd, { unfiltered: true });
            }).catch(error => console.warn("[Durable] Artifact projection failed", taskId, error));
            this.projections.set(taskId, projection);
          }
        },
      });
      return { runtime, mcp, mcpConfigKey: JSON.stringify(config), retiredMcp: new Set(), ...(modelRepair ? { modelRepair } : {}) };
    } catch (error) { await mcp.close(); throw error; }
  }

  private mcpConfiguration(taskId: string) {
    const config = this.config.loadRuntimeConfig();
    const selected = this.options.expertBindings?.active(taskId)?.mcpIds;
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

  /** 打开会话时构建域工具/上下文钩子；单个扩展工厂失败也不能让历史打不开。 */
  private async domainToolsForOpen(task: TaskDto, cwd: string): Promise<DurableDomainTools | undefined> {
    try { return await this.options.tools?.(task, cwd); }
    catch (error) {
      console.warn(`[Durable] 任务 ${task.id} 的扩展工具装配失败，先以 MCP 工具打开会话（发请求时会重新装配）：${failureText(error)}`);
      return undefined;
    }
  }

  private async admit(request: AgentPromptRequest) {
    await this.options.models.refresh({ allowNetwork: false });
    this.options.expertBindings?.ensureLegacy(request.taskId);
    const task = this.options.db.getTask(request.taskId);
    if (!task) throw new Error("Bot 任务不存在");
    // Product selections are durable task configuration, never global scene state.
    this.options.db.upsertTask({ ...task, modelId: request.modelId ?? task.modelId,
      expertId: this.options.expertBindings?.get(task.id) ? task.expertId : request.expertId ?? task.expertId,
      modePresetId: request.modePresetId !== undefined ? request.modePresetId : task.modePresetId, updatedAt: Date.now() });
    return this.withRecovery(request.taskId, async open => {
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
      const domain = await this.options.tools?.(current, this.binding(request.taskId)!.cwd);
      await open.runtime.configure(resolvedModel.target, this.toolMode(current), this.options.thinking?.(current, request),
        [...mcp.tools, ...domain?.tools ?? []], domain?.contextHooks ?? []);
      let text = await this.options.prepareInput?.(request) ?? request.text;
      if (!this.options.prepareInput && request.terminalContext) text += `\n\nTerminal context supplied by the user:\n${JSON.stringify(request.terminalContext)}`;
      const content: Exclude<import("@earendil-works/pi-durable").UserInput, string> = [{ type: "text", text }];
      if (this.options.prepareImages) {
        const images = await this.options.prepareImages(request);
        content.push(...images.images);
        if (images.text) content.push({ type: "text", text: images.text });
      }
      for (const attachment of request.attachments ?? []) {
        const mime = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" } as Record<string,string>)[extname(attachment.path).toLowerCase()];
        if (mime && !this.options.prepareImages) content.push({ type: "image", mimeType: mime, data: readFileSync(attachment.path).toString("base64") });
        content.push({ type: "text", text: `\nAttached file: ${attachment.name}\n${attachment.path}` });
      }
      const submission = await open.runtime.submit(content, request.userMessageId, request.streamingBehavior,
        { text: request.text, displayText: request.displayText ?? request.text, attachments: request.attachments ?? [] });
      return { submission, open };
    });
  }

  private async admitTracked(request: AgentPromptRequest) {
    const prior = this.admissionTails.get(request.taskId) ?? Promise.resolve();
    const pending = prior.catch(() => {}).then(() => this.admit(request));
    this.admissionTails.set(request.taskId, pending);
    const admissions = this.admissions.get(request.taskId) ?? new Set();
    admissions.add(pending); this.admissions.set(request.taskId, admissions);
    return pending.finally(() => {
      admissions.delete(pending);
      if (!admissions.size) this.admissions.delete(request.taskId);
      if (this.admissionTails.get(request.taskId) === pending) this.admissionTails.delete(request.taskId);
    });
  }

  async runGatewayTurn(request: AgentPromptRequest): Promise<string> {
    if (!isGatewayBotTaskId(request.taskId)) throw new Error("Gateway Bot 任务身份无效");
    const existing = this.options.db.getTask(request.taskId);
    this.options.db.upsertTask({ ...(existing ?? { id: request.taskId,
      title: (request.displayText ?? request.text).trim().slice(0, 60) || "助理" }),
      ...(!existing?.spaceId && request.spaceId ? { spaceId: request.spaceId } : {}),
      welcomeMode: "bot", modePresetId: "native", updatedAt: Date.now() });
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

  async prompt(request: AgentPromptRequest, admissionOnly = false): Promise<AgentPromptResult> {
    const { submission, open } = await this.admitTracked(request);
    const state = await submission.status(context);
    if (admissionOnly) return { queued: state.status !== "done" };
    if (state.status === "queued") return { queued: true };
    const settled = await submission.wait(context);
    await open.runtime.refresh();
    if (settled.status === "unanswered" && settled.reason !== "aborted") return { queued: false, error: { code: "DURABLE_UNANSWERED", message: settled.reason } };
    if (open.runtime.snapshot.outcome === "failed") return { queued: false, error: { code: "DURABLE_FAILED", message: open.runtime.snapshot.error ?? "Durable 执行未完成" } };
    return { queued: false };
  }

  async history(taskId: string): Promise<TaskHistoryDto> {
    if (!this.binding(taskId)) return { messages: [] };
    try {
      const recovered = await this.withRecovery(taskId, async open => {
        const snapshot = await open.runtime.refresh();
        return { runtime: open.runtime, snapshot, modelRepair: open.modelRepair };
      });
      await this.projections.get(taskId);
      const recovery = durableHistoryRecovery(recovered.runtime.repairReport);
      // 复述任务当前模型（可能刚刚被目录漂移修复过），渲染层据此校正输入框的模型选择。
      const modelId = this.options.db.getTask(taskId)?.modelId;
      return { messages: recovered.snapshot.messages, durable: recovered.snapshot, cwd: this.binding(taskId)?.cwd,
        ...(modelId ? { modelId } : {}), ...(recovered.modelRepair ? { modelRecovery: recovered.modelRepair } : {}),
        ...(recovery ? { sessionRecovery: recovery } : {}) };
    } catch (error) {
      // A Bot conversation that cannot be opened must say so: an empty projection renders as the
      // product's "waiting for the first message" state, which hides real damage from the user.
      console.warn("[Durable] Cannot open history", taskId, error);
      return { messages: [], cwd: this.binding(taskId)?.cwd, historyError: describeDurableHistoryFailure(error) };
    }
  }
  async abort(taskId: string): Promise<void> {
    // Stop orders after any already-started input admission, then native abort owns cancellation.
    await Promise.allSettled([...(this.admissions.get(taskId) ?? [])]);
    if (this.binding(taskId)) await this.withRecovery(taskId, open => open.runtime.abort());
  }
  async compact(taskId: string): Promise<void> { await this.withRecovery(taskId, open => open.runtime.compact()); }
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
    const open = this.opened.get(taskId) ?? await this.opening.get(taskId);
    const invalidating = this.invalidations.get(taskId);
    if (!open) { await invalidating; return; }
    await this.invalidate(taskId, open);
    await this.projections.get(taskId);
  }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...new Set([...this.opened.keys(), ...this.opening.keys()])].map(id => this.release(id)));
  }
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
