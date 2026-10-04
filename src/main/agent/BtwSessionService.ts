import { DEFAULT_WELCOME_MODE } from "../../shared/mode-profile";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type {
  AgentUiPatch,
  AssembleModePreviewRequest,
  AssemblyTraceDto,
  BtwPromptRequest,
  BtwStartRequest,
} from "../../shared/agent-ipc";
import { BTW_MAX_SESSIONS, canStartBtwSession } from "../../shared/btw-policy";
import { normalizeSingleExpertId } from "../../shared/expert-id";
import { mapPiEventToPatches, type MapperContext } from "../../shared/pi-event-mapper";
import type { RecordLiveInput, UsageStatsService } from "../usage/UsageStatsService";
import { PerformanceTracker } from "../usage/PerformanceTracker";
import { GenerationSpeedTracker } from "../usage/GenerationSpeedTracker";
import type { AppDatabase } from "../db/AppDatabase";
import type { AppSettingsStore } from "../AppSettingsStore";
import type { TaskExecutionWorkspace } from "../task/TaskExecutionWorkspace";
import type { LibraryWorkspaceContextService } from "./LibraryWorkspaceContextService";
import type { SessionRegistry } from "./SessionRegistry";
import { loadTaskHistoryFromSession } from "./session-history";

const BTW_SYSTEM_ROLE = `## BTW 临时只读对话
你正处于 MyBuddy 的 BTW 临时对话中（By The Way，临时岔题）。规则：
1. 本次讨论基于主对话的冻结快照，结论不会自动写回主对话；用户可自行选择「带回主线」。
2. 这是只读会话：只能读取/检索/分析（工具仅 read/grep/find/ls），绝不修改项目文件、不执行任何写操作。
3. 支持多轮追问：基于快照与前面讨论继续，回答直接、可执行。
4. 若用户要求「带回主线」，只需给出清晰、可直接作为主线继续使用的结论。`;

interface BtwSessionEntry {
  btwId: string;
  parentTaskId: string;
  session: AgentSession;
  unsubscribe: () => void;
  cwd: string;
  createdAt: number;
  lastSeenAt: number;
  assistantMessageId: string | null;
  turnStartedAt: number;
  turnEnded: boolean;
  usageTracker: PerformanceTracker;
  usageModelId?: string;
}

export interface BtwSessionServiceDependencies {
  db: AppDatabase;
  registry: SessionRegistry;
  settings: AppSettingsStore;
  taskWorkspace: TaskExecutionWorkspace;
  libraryWorkspace: LibraryWorkspaceContextService;
  usageStats: UsageStatsService;
  resolveTaskExecutionWorkspaceCwd: (taskId: string) => string;
  assembleModePreview: (request: AssembleModePreviewRequest) => AssemblyTraceDto;
  createTransientSession: (input: {
    cwd: string;
    segments: string[];
    parentTaskId: string;
    snapshot: string;
  }) => Promise<AgentSession>;
  setSessionModel: (session: AgentSession, modelId: string) => Promise<void>;
  applySessionReasoningPreference: (
    session: AgentSession,
    preference: NonNullable<BtwStartRequest["reasoningPreference"]>,
  ) => void;
  emitPatch: (btwId: string, patch: AgentUiPatch) => void;
  usageMessageFromEvent: (
    message: RecordLiveInput["message"] | { provider?: string | null; model?: string | null; responseModel?: string | null },
    session: AgentSession,
    myBuddyModelId?: string | null,
  ) => RecordLiveInput["message"];
}

function formatBtwSnapshot(pairs: Array<{ role: "user" | "assistant"; text: string }>): string {
  const MAX_CHARS = 24_000;
  const MAX_TURNS = 60;
  const trimmed = pairs.slice(-MAX_TURNS);
  const parts: string[] = [];
  let total = 0;
  let truncated = false;
  for (let i = trimmed.length - 1; i >= 0; i -= 1) {
    const pair = trimmed[i]!;
    const label = pair.role === "user" ? "用户" : "助手";
    const block = `${label}: ${pair.text}`;
    if (total + block.length > MAX_CHARS) {
      truncated = true;
      continue;
    }
    parts.unshift(block);
    total += block.length;
  }
  if (parts.length === 0) {
    return "## 主对话上下文快照（BTW 发起时刻冻结）\n（主对话暂无可用消息）";
  }
  const head = `## 主对话上下文快照（BTW 发起时刻冻结）\n以下是你本次临时讨论所基于的主对话内容；快照后主对话的任何变化与本次讨论无关。${truncated ? "（快照过长，已截断，仅保留最近部分）" : ""}`;
  return `${head}\n\n${parts.join("\n\n")}`;
}

export class BtwSessionService {
  private readonly sessions = new Map<string, BtwSessionEntry>();
  private readonly userTurnCounters = new Map<string, number>();
  private pruneTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly KEEPALIVE_TIMEOUT_MS = 90_000;
  private static readonly PRUNE_INTERVAL_MS = 10_000;

  constructor(private readonly deps: BtwSessionServiceDependencies) {}

  private settleTurn(btwId: string, messageId: string | null, error?: string): void {
    if (!messageId) return;
    this.deps.emitPatch(btwId, {
      type: "text_delta",
      taskId: btwId,
      messageId,
      delta: error ? `（BTW 已中止：${error}）` : "（BTW 已停止生成）",
      final: true,
    });
    this.deps.emitPatch(btwId, {
      type: "assistant_end",
      taskId: btwId,
      messageId,
      error,
    });
  }

  private buildSnapshot(parentTaskId: string): string {
    const live = this.deps.registry.get(parentTaskId);
    const pairs: Array<{ role: "user" | "assistant"; text: string }> = [];
    if (live?.session) {
      for (const message of live.session.messages) {
        if (message.role === "user") {
          const content = (message as { content?: unknown }).content;
          const text = typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content
                  .filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "text")
                  .map((part) => (part as { text?: string }).text ?? "")
                  .join("")
              : "";
          if (text.trim()) pairs.push({ role: "user", text });
        } else if (message.role === "assistant") {
          const content = (message as { content?: unknown }).content;
          const text = Array.isArray(content)
            ? content
                .filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "text")
                .map((part) => (part as { text?: string }).text ?? "")
                .join("")
            : "";
          if (text.trim()) pairs.push({ role: "assistant", text });
        }
      }
    } else {
      const row = this.deps.db.getTask(parentTaskId);
      if (row?.sessionFile) {
        try {
          const history = loadTaskHistoryFromSession(row.sessionFile);
          for (const message of history.messages) {
            if (message.text?.trim()) pairs.push({ role: message.role, text: message.text });
          }
        } catch (err) {
          console.warn("[BtwSessionService] BTW 快照回退 jsonl 失败", err);
        }
      }
    }
    return formatBtwSnapshot(pairs);
  }

  private buildBaseContext(parentTaskId: string): string[] {
    const live = this.deps.registry.get(parentTaskId);
    if (live?.runtimeAssembly?.segments?.length) {
      return this.deps.libraryWorkspace.renderBtwProjectContextSegments(
        live.runtimeAssembly.segments,
        parentTaskId,
      );
    }
    const task = this.deps.db.getTask(parentTaskId);
    if (!task) return [];
    try {
      const connectorIds =
        this.deps.registry.get(parentTaskId)?.connectorIds ??
        this.deps.settings.read().taskConnectorIds?.[parentTaskId] ??
        [];
      const cwd =
        task.cwd ??
        (task.spaceId ? this.deps.db.getSpace(task.spaceId)?.path : undefined) ??
        this.deps.taskWorkspace.resolveTaskExecutionWorkspaceDir(parentTaskId);
      const assembly = this.deps.assembleModePreview({
        welcomeMode: task.welcomeMode ?? DEFAULT_WELCOME_MODE,
        projectId: task.projectId,
        modePresetId: task.modePresetId,
        expertId: normalizeSingleExpertId(task.expertId),
        connectorIds,
        permissionMode: task.permissionMode,
        spaceId: task.spaceId,
        cwd,
        libraryToolsAvailable: false,
      });
      return this.deps.libraryWorkspace.renderBtwProjectContextSegments(assembly.segments, parentTaskId);
    } catch (err) {
      console.warn("[BtwSessionService] BTW 基础上下文重装配失败，回退仅对话快照", err);
      return [];
    }
  }

  private schedulePrune(): void {
    if (this.pruneTimer) return;
    this.pruneTimer = setTimeout(() => {
      this.pruneTimer = null;
      const now = Date.now();
      const stale: string[] = [];
      for (const [btwId, entry] of this.sessions) {
        if (now - entry.lastSeenAt > BtwSessionService.KEEPALIVE_TIMEOUT_MS) stale.push(btwId);
      }
      for (const btwId of stale) {
        console.warn(`[BtwSessionService] BTW 心跳超时，回收孤儿会话：${btwId}`);
        this.disposeSession(btwId);
      }
      if (this.sessions.size > 0) this.schedulePrune();
    }, BtwSessionService.PRUNE_INTERVAL_MS);
  }

  private disposeSession(btwId: string): void {
    const entry = this.sessions.get(btwId);
    if (!entry) return;
    this.sessions.delete(btwId);
    this.userTurnCounters.delete(btwId);
    try {
      const sample = entry.usageTracker.settlePending(Date.now(), "disposed");
      if (sample) {
        this.deps.usageStats.recordLive({
          taskId: btwId,
          sessionFile: null,
          sourceKind: "btw",
          sourceDetail: entry.parentTaskId,
          sample,
          message: {},
        });
      }
    } catch (err) {
      console.warn(`[usage] btw settle 失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    try { entry.unsubscribe(); } catch { /* ignore */ }
    try { entry.session.clearQueue(); } catch { /* ignore */ }
    try { void entry.session.abort(); } catch { /* ignore */ }
    try { void entry.session.dispose(); } catch { /* ignore */ }
    if (this.sessions.size === 0 && this.pruneTimer) {
      clearTimeout(this.pruneTimer);
      this.pruneTimer = null;
    }
  }

  disposeAll(): void {
    for (const btwId of [...this.sessions.keys()]) this.disposeSession(btwId);
  }

  async start(req: BtwStartRequest): Promise<void> {
    if (this.sessions.has(req.btwId)) this.disposeSession(req.btwId);
    if (!canStartBtwSession(this.sessions.size, this.sessions.has(req.btwId))) {
      throw new Error(`BTW 会话数量已达上限（${BTW_MAX_SESSIONS}），请关闭部分 BTW 会话后重试`);
    }
    const row = this.deps.db.getTask(req.parentTaskId);
    if (!row) throw new Error(`BTW 父任务不存在：${req.parentTaskId}`);

    const cwd = this.deps.resolveTaskExecutionWorkspaceCwd(req.parentTaskId);
    const baseContext = this.buildBaseContext(req.parentTaskId);
    const snapshot = this.buildSnapshot(req.parentTaskId);
    const segments = [...baseContext, `## 当前任务工作目录\n${cwd}`, BTW_SYSTEM_ROLE];
    const session = await this.deps.createTransientSession({ cwd, segments, parentTaskId: req.parentTaskId, snapshot });

    if (req.modelId) {
      try {
        await this.deps.setSessionModel(session, req.modelId);
      } catch (err) {
        console.warn("[BtwSessionService] BTW setModel failed", err);
      }
    }
    if (req.reasoningPreference && req.reasoningPreferenceModelId) {
      const actualModelId = session.model?.provider && session.model?.id
        ? `${session.model.provider}/${session.model.id}`
        : undefined;
      if (actualModelId === req.reasoningPreferenceModelId) {
        this.deps.applySessionReasoningPreference(session, req.reasoningPreference);
      }
    }

    const entry: BtwSessionEntry = {
      btwId: req.btwId,
      parentTaskId: req.parentTaskId,
      session,
      cwd,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      assistantMessageId: null,
      turnStartedAt: 0,
      turnEnded: true,
      unsubscribe: () => undefined,
      usageTracker: new PerformanceTracker(),
      usageModelId:
        req.modelId ??
        this.deps.db.getTask(req.parentTaskId)?.modelId ??
        this.deps.settings.read().defaultModelId ??
        undefined,
    };
    const usageTracker = entry.usageTracker;
    const generationSpeed = new GenerationSpeedTracker();
    const mapperCtx: MapperContext = {
      taskId: req.btwId,
      messageId: "",
      startedAt: 0,
    };
    this.userTurnCounters.set(req.btwId, 0);

    entry.unsubscribe = session.subscribe((event) => {
      if (event.type === "turn_start") {
        const turnIndex = (event as { turnIndex?: number }).turnIndex ?? 0;
        const now = (event as { timestamp?: number }).timestamp ?? Date.now();
        usageTracker.onTurnStart(turnIndex, now);
      } else if (event.type === "message_update") {
        usageTracker.onMessageUpdate(event.assistantMessageEvent?.type ?? "", Date.now());
      } else if (event.type === "message_start" && event.message.role === "user") {
        this.userTurnCounters.set(req.btwId, (this.userTurnCounters.get(req.btwId) ?? 0) + 1);
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        const sample = usageTracker.onMessageEnd(Date.now(), event.message);
        if (sample) {
          try {
            this.deps.usageStats.recordLive({
              taskId: req.btwId,
              sessionFile: null,
              sourceKind: "btw",
              sourceDetail: req.parentTaskId,
              sample,
              message: this.deps.usageMessageFromEvent(event.message, session, entry.usageModelId),
              modelId: entry.usageModelId,
              userTurn: this.userTurnCounters.get(req.btwId) ?? null,
            });
          } catch (err) {
            console.warn(`[usage] btw recordLive 失败: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } else if (event.type === "agent_settled") {
        usageTracker.onSettled();
      }

      const live = this.sessions.get(req.btwId);
      if (!live || live.assistantMessageId == null) return;
      mapperCtx.messageId = live.assistantMessageId;
      mapperCtx.modelName = session.model?.name ?? session.model?.id;
      mapperCtx.startedAt = live.turnStartedAt;
      const stats = generationSpeed.onEvent(event, live.assistantMessageId);
      if (stats) {
        this.deps.emitPatch(req.btwId, {
          type: "generation_stats",
          taskId: req.btwId,
          messageId: live.assistantMessageId,
          stats,
        });
      }
      for (const patch of mapPiEventToPatches(event, mapperCtx)) {
        this.deps.emitPatch(req.btwId, patch);
      }
      if (event.type === "agent_settled") live.turnEnded = true;
    });

    this.sessions.set(req.btwId, entry);
    this.schedulePrune();
    console.log(`[BtwSessionService] BTW 会话已创建：btwId=${req.btwId} parent=${req.parentTaskId} turns=${snapshot.length}`);
  }

  async prompt(req: BtwPromptRequest): Promise<void> {
    const entry = this.sessions.get(req.btwId);
    if (!entry) throw new Error("BTW 会话不存在或已销毁");
    if (entry.session.isStreaming) throw new Error("BTW 仍在生成中，请稍候");

    entry.assistantMessageId = req.assistantMessageId;
    entry.turnStartedAt = Date.now();
    entry.turnEnded = false;
    entry.lastSeenAt = Date.now();
    this.deps.emitPatch(req.btwId, {
      type: "assistant_start",
      taskId: req.btwId,
      messageId: req.assistantMessageId,
      modelName: entry.session.model?.name ?? entry.session.model?.id,
    });
    try {
      await entry.session.prompt(req.text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!entry.turnEnded) {
        this.deps.emitPatch(req.btwId, {
          type: "assistant_end",
          taskId: req.btwId,
          messageId: req.assistantMessageId,
          error: message,
        });
      }
    }
  }

  async abort(btwId: string): Promise<void> {
    const entry = this.sessions.get(btwId);
    if (!entry) return;
    try { entry.session.clearQueue(); } catch { /* ignore */ }
    try {
      await entry.session.abort();
    } catch (err) {
      console.warn("[BtwSessionService] BTW abort failed", err);
    }
    if (!entry.turnEnded) {
      this.settleTurn(btwId, entry.assistantMessageId);
      entry.turnEnded = true;
    }
    entry.lastSeenAt = Date.now();
  }

  async close(btwId: string): Promise<void> {
    const entry = this.sessions.get(btwId);
    if (!entry) return;
    if (entry.session.isStreaming && !entry.turnEnded) this.settleTurn(btwId, entry.assistantMessageId);
    this.disposeSession(btwId);
  }

  keepalive(btwIds: string[]): void {
    const ids = new Set(btwIds);
    for (const [btwId, entry] of this.sessions) {
      if (ids.has(btwId)) entry.lastSeenAt = Date.now();
    }
  }
}
