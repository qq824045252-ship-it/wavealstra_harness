import { DEFAULT_WELCOME_MODE } from "../../shared/mode-profile";
import type { AgentUiPatch, AssembleModePreviewRequest, AssemblyTraceDto, BtwPromptRequest, BtwStartRequest, TaskHistoryDto } from "../../shared/agent-ipc";
import { BTW_MAX_SESSIONS, canStartBtwSession } from "../../shared/btw-policy";
import { normalizeSingleExpertId } from "../../shared/expert-id";
import type { AppDatabase } from "../db/AppDatabase";
import type { AppSettingsStore } from "../AppSettingsStore";
import type { TaskExecutionWorkspace } from "../task/TaskExecutionWorkspace";
import type { LibraryWorkspaceContextService } from "./LibraryWorkspaceContextService";
import type { DurableBotRuntime } from "./durable/DurableBotRuntime";
import type { DurableBotSnapshot } from "../../shared/durable-bot";
import { durableDelta } from "../../../shared/src/durable-sync";

const BTW_SYSTEM_ROLE = `## BTW 临时只读对话
你正处于 MyBuddy 的 BTW 临时对话中（By The Way，临时岔题）。
1. 基于发起时主对话的冻结快照讨论；结论不会自动写回主对话，用户可选择「带回主线」。
2. 只读会话：只读取、检索、分析，绝不修改项目文件或执行写操作。
3. 支持多轮追问；回答直接、可执行。
4. 要求「带回主线」时给出清晰、可直接作为主线继续使用的结论。`;

export interface BtwSessionServiceDependencies {
  db: AppDatabase;
  settings: AppSettingsStore;
  taskWorkspace: TaskExecutionWorkspace;
  libraryWorkspace: LibraryWorkspaceContextService;
  resolveTaskExecutionWorkspaceCwd: (taskId: string) => string;
  assembleModePreview: (request: AssembleModePreviewRequest) => AssemblyTraceDto;
  history: (taskId: string, beforeEntryId?: number) => Promise<TaskHistoryDto>;
  openRuntime: (input: BtwStartRequest & { cwd: string; segments: string[]; snapshot: string; onSnapshot: (snapshot: DurableBotSnapshot) => void }) => Promise<DurableBotRuntime>;
  emitPatch: (btwId: string, patch: AgentUiPatch) => void;
}
interface BtwSessionEntry { parentTaskId: string; runtime: DurableBotRuntime; lastSeenAt: number }

function formatBtwSnapshot(messages: TaskHistoryDto["messages"]): string {
  const parts: string[] = [];
  let size = 0;
  for (const message of messages.slice(-60).reverse()) {
    const block = `${message.role === "user" ? "用户" : "助手"}: ${message.text}`;
    if (size + block.length > 24_000) break;
    parts.unshift(block); size += block.length;
  }
  return "## 主对话上下文快照（BTW 发起时刻冻结）\n快照之后主对话的变化与本次讨论无关。\n\n" + (parts.join("\n\n") || "（暂无可用消息）");
}

/** Product identity and observation only; Durable owns execution, queues and recovery. */
export class BtwSessionService {
  private readonly sessions = new Map<string, BtwSessionEntry>();
  private readonly opening = new Map<string, Promise<void>>();
  private readonly closing = new Map<string, Promise<void>>();
  private pruneTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly deps: BtwSessionServiceDependencies) {}

  private async snapshot(parentTaskId: string): Promise<string> {
    let history = await this.deps.history(parentTaskId);
    if (history.historyError) throw new Error(history.historyError);
    let messages = history.messages;
    let before = history.durable?.historyBefore;
    while (messages.length < 60 && before !== undefined) {
      history = await this.deps.history(parentTaskId, before);
      before = history.page?.before;
      if (history.historyError) throw new Error(history.historyError);
      messages = [...history.messages, ...messages].slice(-60);
    }
    return formatBtwSnapshot(messages);
  }

  private baseContext(parentTaskId: string, cwd: string): string[] {
    const task = this.deps.db.getTask(parentTaskId);
    if (!task) throw new Error("BTW 父任务不存在");
    const assembly = this.deps.assembleModePreview({
      welcomeMode: task.welcomeMode ?? DEFAULT_WELCOME_MODE, projectId: task.projectId,
      modePresetId: task.modePresetId, expertId: normalizeSingleExpertId(task.expertId),
      connectorIds: this.deps.settings.read().taskConnectorIds?.[parentTaskId] ?? [],
      permissionMode: "readonly", spaceId: task.spaceId, cwd, libraryToolsAvailable: false,
    });
    return this.deps.libraryWorkspace.renderBtwProjectContextSegments(assembly.segments, parentTaskId);
  }

  async start(request: BtwStartRequest): Promise<void> {
    await this.closing.get(request.btwId);
    const active = this.sessions.get(request.btwId);
    if (active) {
      if (active.parentTaskId !== request.parentTaskId) throw new Error("BTW 会话不属于当前任务");
      active.lastSeenAt = Date.now();
      this.deps.emitPatch(request.btwId, { type: "durable_snapshot", taskId: request.btwId, snapshot: active.runtime.snapshot });
      await active.runtime.refresh(); return;
    }
    const opening = this.opening.get(request.btwId);
    if (opening) { await opening; return this.start(request); }
    const pending = this.open(request);
    this.opening.set(request.btwId, pending);
    try { await pending; } finally { this.opening.delete(request.btwId); }
  }

  private async open(request: BtwStartRequest): Promise<void> {
    if (!canStartBtwSession(this.sessions.size + this.opening.size, false)) throw new Error(`BTW 会话数量已达上限（${BTW_MAX_SESSIONS}）`);
    if (!this.deps.db.getTask(request.parentTaskId)) throw new Error("BTW 父任务不存在");
    const cwd = this.deps.resolveTaskExecutionWorkspaceCwd(request.parentTaskId);
    let previous: DurableBotSnapshot | undefined;
    const runtime = await this.deps.openRuntime({ ...request, cwd,
      segments: [...this.baseContext(request.parentTaskId, cwd), `## 当前任务工作目录\n${cwd}`, BTW_SYSTEM_ROLE],
      snapshot: await this.snapshot(request.parentTaskId),
      onSnapshot: snapshot => {
        const { epoch: _epoch, revision: _revision, messages: _messages, ...state } = snapshot;
        this.deps.emitPatch(request.btwId, previous?.epoch === snapshot.epoch
          ? { type: "durable_delta", taskId: request.btwId, delta: durableDelta(previous, snapshot, state) }
          : { type: "durable_snapshot", taskId: request.btwId, snapshot });
        previous = snapshot;
      },
    });
    this.sessions.set(request.btwId, { runtime, parentTaskId: request.parentTaskId, lastSeenAt: Date.now() });
    runtime.resume();
    this.schedulePrune();
  }

  async prompt(request: BtwPromptRequest): Promise<void> {
    await this.opening.get(request.btwId);
    const entry = this.sessions.get(request.btwId);
    if (!entry) throw new Error("BTW 会话不存在或已销毁");
    entry.lastSeenAt = Date.now();
    const submission = await entry.runtime.submit(request.text, request.userMessageId, "followUp",
      { text: request.text, displayText: request.text, attachments: [] });
    await entry.runtime.reply(submission);
  }

  async abort(btwId: string): Promise<void> {
    await this.opening.get(btwId);
    const entry = this.sessions.get(btwId);
    if (entry) { await entry.runtime.abort(); entry.lastSeenAt = Date.now(); }
  }

  async close(btwId: string): Promise<void> {
    await this.opening.get(btwId);
    const entry = this.sessions.get(btwId);
    if (!entry) return;
    this.sessions.delete(btwId);
    const closing = (async () => { try { await entry.runtime.abort(); } finally { await entry.runtime.close(); } })();
    this.closing.set(btwId, closing);
    try { await closing; } finally { this.closing.delete(btwId); }
  }

  keepalive(ids: string[]): void {
    for (const id of ids) { const entry = this.sessions.get(id); if (entry) entry.lastSeenAt = Date.now(); }
  }

  disposeAll(): void {
    if (this.pruneTimer) clearTimeout(this.pruneTimer);
    this.pruneTimer = null;
    for (const entry of this.sessions.values()) void entry.runtime.close().catch(error => console.warn("[BTW] close failed", error));
    this.sessions.clear();
  }

  private schedulePrune(): void {
    if (this.pruneTimer) return;
    this.pruneTimer = setTimeout(() => {
      this.pruneTimer = null;
      for (const [id, entry] of this.sessions) if (Date.now() - entry.lastSeenAt > 90_000) {
        if (entry.runtime.snapshot.busy || entry.runtime.snapshot.queued > 0) continue;
        this.sessions.delete(id);
        const closing = entry.runtime.close();
        this.closing.set(id, closing);
        void closing.catch(error => console.warn("[BTW] detach failed", error)).finally(() => this.closing.delete(id));
      }
      if (this.sessions.size) this.schedulePrune();
    }, 10_000);
  }
}
