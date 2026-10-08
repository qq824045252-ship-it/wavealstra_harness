import { createHash } from "node:crypto";
import { existsSync, statSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, extname, resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { loadQuickJSWasm } from "@earendil-works/pi-codemode";
import { McpOAuthCredentialStore, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentPromptRequest, AgentPromptResult, AgentUiPatch, TaskDto, TaskHistoryDto } from "../../../shared/agent-ipc";
import type { BotToolMode, DurableBotSnapshot } from "../../../shared/durable-bot";
import { isGatewayBotTaskId } from "../../../shared/gateway-task";
import type { AppDatabase } from "../../db/AppDatabase";
import { McpConfigService } from "../../mcp/McpConfigService";
import { emptyMcpFilterResult } from "../../mcp/McpModeFilter";
import { toNativeMcpConfig } from "../../mcp/NativeMcpConfig";
import { McpCredentialBackend } from "../../mcp/McpCredentialBackend";
import { DurableBotRuntime } from "./DurableBotRuntime";
import { DurableMcp } from "./DurableMcp";
import { snapshotWorkspace } from "../../workspace/WorkspaceService";
import type { ToolRegistration, EntryRecord } from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-ai";
import type { durableCompletedTurns } from "./DurableTurnProjection";

interface BotBinding { task_id: string; directory: string; cwd: string; backend: "pi-durable" }
interface OpenBot {
  runtime: DurableBotRuntime; mcp: DurableMcp; mcpConfigKey: string;
  retiredMcp: Set<DurableMcp>;
  refreshingMcp?: { key: string; promise: Promise<DurableMcp> };
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
  tools?: (task: TaskDto, cwd: string) => Promise<ToolRegistration[]>;
  onTurns?: (taskId: string, turns: ReturnType<typeof durableCompletedTurns>) => void;
  onEntries?: (taskId: string, entries: readonly EntryRecord[]) => void;
  onSettled?: (taskId: string, snapshot: DurableBotSnapshot) => void;
  toolMode: (task: TaskDto) => BotToolMode;
  defaultModel: () => string | undefined;
  emit: (patch: AgentUiPatch) => void;
  projectArtifacts?: (taskId: string, snapshot: DurableBotSnapshot, before: Map<string, string>) => Promise<void>;
  thinking?: (task: TaskDto, request: AgentPromptRequest) => ModelThinkingLevel | undefined;
  prepareInput?: (request: AgentPromptRequest) => Promise<string>;
  prepareImages?: (request: AgentPromptRequest) => Promise<{ images: Array<{ type: "image"; mimeType: string; data: string }>; text?: string }>;
}

/** One process owns each store. SQLite only binds product IDs; all execution state is in Durable. */
export class DurableBotService {
  private readonly opening = new Map<string, Promise<OpenBot>>();
  private readonly opened = new Map<string, OpenBot>();
  private readonly config: McpConfigService;
  private readonly credentials: McpOAuthCredentialStore;
  private closing = false;
  private readonly admissions = new Map<string, Set<Promise<unknown>>>();
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
  busy(taskId: string): boolean { return this.opened.get(taskId)?.runtime.snapshot.busy ?? this.opening.has(taskId); }
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
    const existing = this.opened.get(taskId);
    if (existing) return Promise.resolve(existing);
    const opening = this.opening.get(taskId);
    if (opening) return opening;
    const pending = this.openInternal(taskId).then(open => { this.opened.set(taskId, open); return open; })
      .finally(() => this.opening.delete(taskId));
    this.opening.set(taskId, pending);
    return pending;
  }

  private async openInternal(taskId: string): Promise<OpenBot> {
    const { db, agentDir, models } = this.options;
    const task = db.getTask(taskId);
    if (!task || task.welcomeMode !== "bot") throw new Error("任务不是 Bot，不能切换其执行后端");
    if (task.sessionFile) throw new Error("旧 Pi 会话不能作为 Durable 检查点，请创建 Bot 任务");
    const prior = this.binding(taskId);
    const cwd = prior?.cwd ?? this.options.resolveCwd(taskId);
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`Bot 工作目录不存在：${cwd}`);
    if (prior && task.cwd && resolve(task.cwd) !== resolve(cwd)) throw new Error("Bot 工作目录已变化，请恢复原绑定目录");
    const directory = prior?.directory ?? join(agentDir, "durable", createHash("sha256").update(taskId).digest("hex"));
    db.connection.prepare("INSERT OR IGNORE INTO durable_bot_bindings(task_id, backend, directory, cwd) VALUES (?, 'pi-durable', ?, ?)").run(taskId, directory, cwd);
    const config = toNativeMcpConfig(emptyMcpFilterResult(this.config.loadRuntimeConfig()), this.config.getAppGlobalConfigPath(), false);
    const mcp = await DurableMcp.open(config, this.credentials, models, cwd);
    try {
      // Existing project files are not newly produced artifacts on reconnect. Persisted native
      // write/edit records restore their cards independently of this workspace diff baseline.
      let workspaceBefore = await snapshotWorkspace(cwd, { unfiltered: true });
      let projected = "";
      let wasBusy = false;
      const selected = await this.model(task.modelId);
      const base = this.options.assetsDir?.replace(/([\\/])app\.asar(?=[\\/])/, "$1app.asar.unpacked");
      const wasm = base && join(base, "quickjs.wasm");
      const worker = base && join(base, "codemode-worker.cjs");
      const runtime = await DurableBotRuntime.open({ directory, cwd, models,
        taskId, model: selected, toolMode: this.toolMode(task), tools: [...mcp.tools, ...await this.options.tools?.(task, cwd) ?? []],
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
              await this.options.projectArtifacts!(taskId, snapshot, workspaceBefore);
              workspaceBefore = await snapshotWorkspace(cwd, { unfiltered: true });
            }).catch(error => console.warn("[Durable] Artifact projection failed", taskId, error));
            this.projections.set(taskId, projection);
          }
        },
      });
      return { runtime, mcp, mcpConfigKey: JSON.stringify(config), retiredMcp: new Set() };
    } catch (error) { await mcp.close(); throw error; }
  }

  private async configuredMcp(open: OpenBot, cwd: string): Promise<DurableMcp> {
    const config = toNativeMcpConfig(emptyMcpFilterResult(this.config.loadRuntimeConfig()), this.config.getAppGlobalConfigPath(), false);
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

  private async model(preferred?: string) {
    const id = preferred || this.options.defaultModel();
    if (id) {
      const slash = id.indexOf("/");
      const model = this.options.models.getModel(id.slice(0, slash), id.slice(slash + 1));
      if (!model) throw new Error(`Bot 模型不存在：${id}`);
      return { provider: model.provider, modelId: model.id };
    }
    const model = (await this.options.models.getAvailable())[0];
    if (!model) throw new Error("请先配置可用模型");
    return { provider: model.provider, modelId: model.id };
  }

  private async admit(request: AgentPromptRequest) {
    await this.options.models.refresh({ allowNetwork: false });
    const task = this.options.db.getTask(request.taskId);
    if (!task) throw new Error("Bot 任务不存在");
    // Product selections are durable task configuration, never global scene state.
    this.options.db.upsertTask({ ...task, modelId: request.modelId ?? task.modelId, expertId: request.expertId ?? task.expertId,
      modePresetId: request.modePresetId !== undefined ? request.modePresetId : task.modePresetId, updatedAt: Date.now() });
    const current = this.options.db.getTask(request.taskId)!;
    const open = await this.open(request.taskId);
    const mcp = await this.configuredMcp(open, this.binding(request.taskId)!.cwd);
    await open.runtime.configure(await this.model(current.modelId), this.toolMode(current), this.options.thinking?.(current, request),
      [...mcp.tools, ...await this.options.tools?.(current, this.binding(request.taskId)!.cwd) ?? []]);
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
  }

  private async admitTracked(request: AgentPromptRequest) {
    const pending = this.admit(request);
    const admissions = this.admissions.get(request.taskId) ?? new Set();
    admissions.add(pending); this.admissions.set(request.taskId, admissions);
    return pending.finally(() => { admissions.delete(pending); if (!admissions.size) this.admissions.delete(request.taskId); });
  }

  async runGatewayTurn(request: AgentPromptRequest): Promise<string> {
    if (!isGatewayBotTaskId(request.taskId)) throw new Error("Gateway Bot 任务身份无效");
    const existing = this.options.db.getTask(request.taskId);
    this.options.db.upsertTask({ ...(existing ?? { id: request.taskId,
      title: (request.displayText ?? request.text).trim().slice(0, 60) || "助理" }),
      welcomeMode: "bot", modePresetId: "native", updatedAt: Date.now() });
    const { submission, open } = await this.admitTracked({ ...request, modePresetId: "native" });
    return open.runtime.reply(submission);
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
    const { runtime } = await this.open(taskId);
    const durable = await runtime.refresh();
    await this.projections.get(taskId);
    return { messages: durable.messages, durable, cwd: this.binding(taskId)?.cwd };
  }
  async abort(taskId: string): Promise<void> {
    // Stop orders after any already-started input admission, then native abort owns cancellation.
    await Promise.allSettled([...(this.admissions.get(taskId) ?? [])]);
    if (this.binding(taskId)) await (await this.open(taskId)).runtime.abort();
  }
  async compact(taskId: string): Promise<void> { await (await this.open(taskId)).runtime.compact(); }
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
    if (!open) return;
    await open.runtime.close();
    await this.projections.get(taskId);
    await open.refreshingMcp?.promise.catch(() => {});
    await Promise.allSettled([open.mcp, ...open.retiredMcp].map(mcp => mcp.close()));
    this.opened.delete(taskId);
  }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...new Set([...this.opened.keys(), ...this.opening.keys()])].map(id => this.release(id)));
  }
}
