import { DEFAULT_WELCOME_MODE } from "@shared/mode-profile";
import { isGatewayBotTaskId } from "@shared/gateway-task";
import { create } from "zustand";
import { useEffect } from "react";
import type {
  Artifact,
  Attachment,
  ChatMessage,
  ChatSelection,
  Expert,
  MarketExpert,
  MessageBlock,
  ModelConfig,
  Page,
  PermissionMode,
  Skill,
  Soul,
  Space,
  Task,
  TaskReference,
  TaskFilterStatus,
  TaskFilterTime,
  ThinkingLevel,
  ToolStatus,
  WelcomeMode,
} from "@/types";
import type { AgentUiPatch, ChatMessageDto, LocalConnectorDto, ModeProfileDto, SpaceDto, TaskDto } from "../../../shared/agent-ipc";
import type { AgentRegenerateResult } from "../../../shared/agent-ipc";
import type { ArchivedContentDeletionRequest, ArchivedContentDeletionResult, TrashedTaskDto } from "../../../shared/archive-deletion";
import type { ConversationBranchInfoDto, CreateConversationBranchRequest } from "../../../shared/conversation-branch";
import type { ExternalAgentDescriptorDto, ExternalAgentId, ExternalAgentPinDto, ExternalAgentUiEvent } from "../../../shared/external-agent";
import { resolveExternalAgentContinuationRunId } from "../../../shared/external-agent";
import { normalizedEditorTextHash } from "../../../shared/regenerate-hash";
import type { ProjectDto } from "../../../shared/project-domain";
import { normalizeSingleExpertId } from "../../../shared/expert-id";
import { normalizeProjectWorkspaceTab, type ProjectNavDestination, type ProjectWorkspaceTab } from "@/lib/projectWorkspace";
import { computeEffectiveArchived as computeEffectiveArchivedShared } from "../../../shared/workspace-tree";
import {
  TERMINAL_CONTEXT_MAX_CHARS,
  terminalOwnerStoreKey,
  type TerminalContextDto,
  type TerminalExitEvent,
  type TerminalSessionInfo,
} from "../../../shared/terminal-ipc";
import {
  artifactVisibleForDisplay,
  defaultModePresetId,
  resolveEffectiveModePolicy,
  resolveModePreset,
} from "../../../shared/mode-profile";
import { findSpaceToRemount, spacePathKey } from "../../../shared/space-relocate";
import type { ModeArtifactPolicy } from "../../../shared/mode-profile";
import {
  toRequestModelId,
  toRequestPermissionMode,
} from "@/lib/sessionContract";
import {
  normalizeReasoningPreference,
  type ModelPreferencesDto,
  type ModelReasoningPreferenceDto,
} from "../../../shared/model-metadata";
import { stripInjectedUserPromptTail } from "../../../shared/user-prompt-display";
import {
  EMPTY_SELECTION,
  normalizeSelectionComment,
  selectionFingerprintMatches,
  type SelectionState,
} from "../../../shared/selection";
import {
  applyArtifactSnapshot,
  createInitialArtifactProjection,
  reduceArtifactProjection,
  type ArtifactProjection,
} from "../../../shared/artifact-projection";
import type {
  ArtifactCreatedEvent,
  ArtifactRemovedEvent,
  ArtifactSnapshot,
  ArtifactUpdatedEvent,
} from "../../../shared/artifact-types";
import {
  adaptivePanelWidth,
  canvasPanelWidth,
  clampCanvasPanelWidth,
  clampPanelWidth,
  PANEL_RAIL_WIDTH,
} from "@/lib/panelWidth";
import { fileUrlForAbsolutePath, HOME_BROWSER_KEY, normalizeBrowserUrl } from "@/lib/browserLinks";
import {
  buildRegistration,
  toRendererArtifact,
  toRendererKind,
  type ArtifactRenderPayload,
} from "@/lib/artifactIngest";
import { createRenderHydration, type ArtifactRenderLoadState, type RenderHydration } from "@/lib/renderHydration";
import type { ArtifactDescriptor } from "../../../shared/artifact-types";
import { inferArtifactKind, joinWorkspaceAbs, languageFromName, normalizeComparePath, toWorkspaceRelative } from "@/lib/workspace";
import { fileNameFromPath, parentDir } from "@/lib/localFilePath";
import { applyTheme, getInitialTheme, type Theme } from "@/lib/theme";
import {
  applyFontSettings,
  DEFAULT_CODE_FONT_SIZE,
  ensureAllUserFontsLoaded,
  legacyFontScaleToUiFontSize,
  normalizeCodeFontSize,
  normalizeUiFontSize,
} from "@/lib/fontSettings";
import { normalizeCodeTheme } from "@shared/code-theme";
import { getTaskDisplayStatus, hasActiveExecutionMessages, isTaskDoneUnread } from "@/utils/taskFilters";
import {
  buildRelatedTaskPrompt,
  resolveRelatedTaskSpec,
} from "@/lib/relatedTask";
import { collectTaskDomainArtifacts, type RefFileItem } from "@/lib/refTaskArtifacts";
import { loadTaskAsRefItem } from "@/lib/loadRefTask";
import type { RefTaskItem } from "@/lib/taskReference";
import {
  reconcileMessagesArtifactIds,
  setHistoryArtifactHints,
  type HistoryArtifactHint,
} from "@/lib/messageArtifactReconcile";

/** 防止 StrictMode / HMR 重复订阅 agent:event */
let agentEventUnsub: (() => void) | null = null;
/** ACP External Agent 独立事件通道，禁止混入 agent:event。 */
let externalAgentEventUnsub: (() => void) | null = null;
/** 定时任务事件：侧栏同步新任务 */
let cronEventUnsub: (() => void) | null = null;
/** Artifact Domain 事件订阅（onCreated/onUpdated/onRemoved） */
let artifactEventUnsubs: Array<() => void> = [];
/** Wave 4D：Selection 投影订阅（StrictMode 重跑时先卸旧） */
let selectionEventUnsub: (() => void) | null = null;
/** P1-1：per-task pin pending（防快速双击并发 race，仅单任务串行） */
const pendingPinTaskIds = new Set<string>();
/** P2-2：move 串行（同 id 串行，不同对象可并发）；跨 id 并发时采用目标 id 精确函数式回滚 + 全局队列序列化，保证失败不覆盖成功乐观 */
const pendingMoveSpaceIds = new Set<string>();
const pendingMoveTaskIds = new Set<string>();
/**
 * Renderer task tombstones. deleteTask removes the task optimistically before Main finishes abort/trash;
 * any late Pi/ACP patch for that exact id must be ignored instead of synthesizing a ghost “新任务”.
 * IDs are unique for the process lifetime; app restart rebuilds projection from DB and naturally clears this set.
 */
const deletedTaskRuntimeTombstones = new Set<string>();
/** 外部创建任务（Android/Cron/Gateway）首次 patch 到达时，补齐 DB 权威元数据。 */
const pendingTaskMetadataHydrations = new Set<string>();
/**
 * TaskDto → renderer Task 的唯一映射源：初始加载与回收站恢复共用，
 * 避免恢复出来的任务缺字段（messages/默认模型/权限等）。
 */
function mapTaskRowToTask(
  row: TaskDto,
  context: {
    enabledModelIds: ReadonlySet<string>;
    defaultModelId: string;
    permissionModeDefault: PermissionMode;
    taskConnectorIds?: Record<string, string[]>;
  },
): Task {
  return {
    id: row.id,
    title: row.title,
    spaceId: row.spaceId ?? undefined,
    projectId: row.projectId ?? undefined,
    status: row.status as Task["status"],
    updatedAt: row.updatedAt,
    messages: [],
    sessionFile: row.sessionFile,
    cwd: row.cwd,
    modelId: row.modelId && context.enabledModelIds.has(row.modelId) ? row.modelId : context.defaultModelId,
    permissionMode: row.permissionMode ?? context.permissionModeDefault ?? "default",
    welcomeMode: row.welcomeMode ?? DEFAULT_WELCOME_MODE,
    archived: row.archived,
    expertId: normalizeSingleExpertId(row.expertId),
    expertBinding: row.expertBinding,
    modePresetId: row.modePresetId,
    startAt: row.startAt ?? undefined,
    dueAt: row.dueAt ?? undefined,
    // Phase 2：isFavorited / spaceSortOrder 复用已冻结列，重启后持久（单一真相，直接来自 DB）
    isFavorited: Boolean(row.isFavorited),
    spaceSortOrder: row.spaceSortOrder ?? 0,
    // ACP pin：任务级固定，重启后恢复逐轮续链路由
    externalAgentPin: row.externalAgentPin ?? undefined,
    // 侧栏绿点水位：DB 是唯一真相（重启后绿点仍按查看历史显示/隐藏）
    doneAckedAt: row.doneAckedAt ?? null,
    // F3：任务级 Active Connector（settings.json 持久化；无新 DB schema）
    connectorIds: context.taskConnectorIds?.[row.id],
  };
}
// P2-3 统一串行：space/task 共享单一 moveChain，避免跨 kind 并发时 collapsed 乐观/回滚覆盖；与精确函数式回退双保险
let moveChain: Promise<void> = Promise.resolve();

type AgentDeltaPatch = Extract<
  AgentUiPatch,
  { type: "text_delta" | "thinking_delta" }
>;

const EMPTY_SOUL: Soul = {
  name: "MyBuddy",
  alias: "用户",
  persona: "",
};

export type { Theme };
export type PanelMode = "file" | "overview" | "workspace" | "gadgets" | "terminal" | "browser" | "changes";
export type StreamingSendMode = "continue" | "steer" | "interrupt";

export type SettingsTab =
  | "system"
  | "extensions"
  | "modes"
  | "personalize"
  | "memory"
  | "archive"
  | "models"
  | "assistant"
  | "acp"
  | "data"
  | "python"
  | "shortcuts"
  | "notifications"
  | "remote"
  | "security"
  | "help";

/**
 * 新任务草稿：点「新建任务」/召唤专家后、首条消息发出前暂存的最小参数。
 * 任务在 sendMessage 首条消息时才 materialize 并落库，避免产生空白「新任务」行。
 */
export interface TaskDraft {
  /** 发起时绑定的空间（空间内「+ 添加对话」） */
  spaceId?: string;
  /** 与 Space 正交的长期 Project 上下文。 */
  projectId?: string;
  /** 发起该任务的 Project Plan 项；仅在首条消息落库后建立 Work Graph 关系。 */
  planId?: string;
  /** Expert selected for the task. */
  expertId?: string;
  /** 草稿期固定的 ACP 外部 Agent；首条消息 materialize 时随任务落库。 */
  externalAgentPin?: ExternalAgentPinDto;
  /** Project 内创建任务时预填的标题；首条消息 materialize 时写入。 */
  title?: string;
}

/** 重新生成两阶段提交的 pending 记录（方案 Problem Three 5.3）。 */
export interface PendingRegeneration {
  /** 去重/归属 id，随 IPC 贯穿。 */
  requestId: string;
  taskId: string;
  /** 被重新生成的源助手消息 id（commit 时按此重新定位，不依赖跨异步旧 index）。 */
  sourceAssistantMessageId: string;
  /** 被重新生成的源用户消息 id（drift 校验锚点）。 */
  sourceUserMessageId: string;
  userMessageIndex: number;
  /** 新助手消息 id（assistant_start 到达时据此 commit）。 */
  newAssistantMessageId: string;
  startedAt: number;
}

/** 通用关联任务创建参数（见 createRelatedTask） */
export interface CreateRelatedTaskOptions {
  sourceTaskId: string;
  /** 目标 Mode（working/coding/design） */
  welcomeMode: WelcomeMode;
  /** 目标 Tag/Preset；缺省 = 目标模式默认 tag */
  modePresetId?: string;
  /** 目标专家（可选；未安装时尝试市场安装，失败返回 null） */
  expertId?: string | null;
  /** 显式权限；缺省 = Tag 建议 ?? 系统当前 */
  permissionMode?: PermissionMode;
  /** 显式模型；缺省 = Tag 建议（须可用）?? 源任务/当前模型 */
  modelId?: string;
  /** 自定义标题；缺省 = “关联：<源任务标题>” */
  title?: string;
  /** 首条指令；缺省 = 引用源任务继续 */
  instruction?: string;
}

interface AppState {
  page: Page;
  theme: Theme;
  sidebarCollapsed: boolean;
  tasks: Task[];
  spaces: Space[];
  /** Task-scoped Subagent 临时 Chat（仅运行中实例） */
  subagentDrawer?: { instanceId: string };
  openSubagentDrawer: (instanceId: string) => void;
  closeSubagentDrawer: () => void;
  /** 账户「用量统计」面板（大 overlay；入口在 Sidebar 账户 popup） */
  usageStatsOpen: boolean;
  openUsageStats: () => void;
  closeUsageStats: () => void;
  /** 账户「API 聚合」面板（同一 Provider 多密钥自动切换；入口在 Sidebar 账户 popup） */
  apiAggregationOpen: boolean;
  openApiAggregation: () => void;
  closeApiAggregation: () => void;
  /** 账户「扩展软件」弹窗已下线；文件仍保留便于调试台另挂入口。 */
  extensionSoftwareOpen: boolean;
  openExtensionSoftware: () => void;
  closeExtensionSoftware: () => void;
  /** 插件页 MCP 卡片定位（聊天 runtime chip → 对应服务器） */
  hubMcpFocusName: string | null;
  openHubMcp: (serverName?: string) => void;
  projects: ProjectDto[];
  /** Open Project workspace; null = Project List. */
  activeProjectId: string | null;
  activeProjectTab: ProjectWorkspaceTab;
  /** Workspace-owned navigation request; Sidebar only asks, never inspects form dirty. */
  projectNavRequest: ProjectNavDestination | null;
  /** 资料库跨页导航请求（Project 资料页 → 全局资料库定位） */
  libraryNav: { view: "space"; spaceId: string; folderId: string | null } | { view: "item"; itemId: string } | null;
  activeTaskId: string | null;
  /** Workspace Detail 当前进入的 Space（P4/P5：Space 可进入对象） */
  activeWorkspaceId: string | null;
  openWorkspaceDetail: (spaceId: string) => void;
  closeWorkspaceDetail: () => void;
  /** 侧边栏折叠状态 */
  taskSectionCollapsed: boolean;
  /** 用户显式展开的空间 id（默认 = 空 = 全部收起；见 loadSidebarExpanded 的存储语义） */
  expandedSpaceIds: string[];
  skills: Skill[];
  models: ModelConfig[];
  activeModelId: string;
  defaultModelId: string;
  /** 用户是否在本会话内显式选择过模型（boot 默认值 = false；setActiveModel 置 true） */
  modelExplicit: boolean;
  /** modelId → native reasoning preference；Settings 与 Chat 共用。 */
  modelPreferences: ModelPreferencesDto;
  permissionMode: PermissionMode;
  /** 用户是否在本会话内显式选择过权限（boot 继承设置值 = false；setPermissionMode 置 true） */
  permissionExplicit: boolean;
  /** 当前上下文选中的 Active 连接器（任务级：随 setActiveTask 加载/持久到 task.connectorIds） */
  activeConnectorIds: string[];
  /** 各任务扩展栏终端会话（主进程权威，renderer 只读镜像；data 流不经 store） */
  terminalSessions: Record<string, TerminalSessionInfo>;
  /** 用户显式「终端 → 加入对话」的上下文（pending；发送即消费） */
  terminalContext: TerminalContextDto | null;
  /**
   * 产物面板「发送到对话」的挂起引用（ChatInput 消费后清空；
   * 与 InputAddMenu 引用文件同构，作为 refFile 芯片显示）。
   */
  pendingRefFile: RefFileItem | null;
  /**
   * 侧栏「分享任务」挂起引用：切换到目标任务后由 ChatInput 消费为 refTask 芯片。
   */
  pendingRefTask: RefTaskItem | null;
  /** Pending ACP continuation target consumed by ChatInput. */
  pendingExternalAgentContinuation: { taskId: string; runId: string; agentId: ExternalAgentId; agentName: string } | null;
  soul: Soul;
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  /** 预览面板 */
  panelOpen: boolean;
  panelMode: PanelMode;
  /** 扩展面板视图（概览/工作空间/浏览器/变更），与 file 预览模式独立 */
  extensionView: PanelMode;
  /** 打开文件时，扩展视图以悬浮层展示 */
  extensionFlyoutOpen: boolean;
  /** 钉住悬浮层（点击外部不关闭） */
  extensionFlyoutPinned: boolean;
  /** 顶栏「概览/工作空间/浏览器/变更」模式菜单展开（WCV 需随之隐藏） */
  extensionMenuOpen: boolean;
  artifactTabs: string[];
  activeArtifactId: string | null;
  /** 消息多选分享模式 */
  selectMode: boolean;
  selectedMessageIds: string[];
  /** 侧边栏任务筛选 */
  taskFilterStatus: TaskFilterStatus;
  taskFilterTime: TaskFilterTime;
  /** 右侧栏宽度（px） */
  panelWidth: number;
  /** 右侧栏全屏展开（占主区域大部分宽度） */
  panelExpanded: boolean;
  /** 全屏展开前侧栏是否收起，用于还原 */
  sidebarBeforePanelExpand: boolean | null;
  /** 各任务（或首页 __home__）在扩展栏浏览器中打开的 URL */
  browserUrlByTask: Record<string, string>;
  /** 地址栏输入（与当前 session 同步） */
  browserUrlInput: string;
  /** 浏览器刷新计数（触发 WebContentsView 重载） */
  browserFrameKey: number;
  /** 执行中临时允许完全访问 */
  fullAccessDuringRun: boolean;
  /** 继续等待当前执行结束；引导在安全边界介入；只有打断先停止当前轮。 */
  streamingSendMode: StreamingSendMode;
  searchOpen: boolean;
  pinnedTaskIds: string[];
  /** 首页输入区选中的工作空间 */
  homeSpaceId: string | null;
  /**
   * 未落库的新任务草稿。点「新建任务」/召唤专家只登记草稿、不建任务；
   * 首条消息发出时（sendMessage）才 materialize 为真实任务并落库。
   * 切到其它任务 / 离开 chat 页即丢弃，避免产生空白「新任务」行。
   */
  draft: TaskDraft | null;
  /** 欢迎页三模式 → pi prompt 侧重 */
  welcomeMode: WelcomeMode;
  /**
   * 当前选中的 Design Mode 场景预设（全局 selection，影响新建 design 任务）。
   * 与 welcomeMode 同为内存态；任务一旦有消息/session 即锁定，只影响下次新建。
   * 非 design 模式无意义（新建 design 任务时兜底取默认）。
   */
  modePresetId: string | null;
  /** 当前任务上下文用量（真实/估算）；null 表示未知 */
  compactionByTask: Record<string, import("@shared/compaction").TaskCompactionStatusDto>;
  contextUsedTokens: number | null;
  contextEstimated: boolean;
  contextWindowTokens: number;
  /** 当前任务实时缓存命中率 0..1（cacheRead/(input+cacheRead+cacheWrite)）；null 表示未知 */
  contextCacheHitRate: number | null;
  /** 当前任务会话累计输入 token（未命中侧）；null 表示未知 */
  contextInputTokens: number | null;
  /** 当前任务会话累计缓存读取 token；null 表示未知 */
  contextCacheReadTokens: number | null;
  /** 当前任务会话累计输出 token；null 表示未知 */
  contextOutputTokens: number | null;
  /** Wave 4D：Selection 投影（唯一 truth 在 main SelectionStore；只读 mirror，不实现 stale 逻辑） */
  selection: SelectionState;
  /** 已「加入聊天」的抓取元素集合；同一页面可累计多个，发送后一次性消费。 */
  chatSelections: ChatSelection[];
  /** 递增信号：请求 ChatInput 聚焦（抓取元素「加入聊天」后切回输入框） */
  chatFocusTick: number;
  /**
   * 写入输入框的草稿（消息「导入到输入框」等；ChatInput 消费后清空）。
   * 与 externalDraft prop 同语义，跨组件走 store。
   */
  composerDraft: string | null;
  /** 从其它 Surface 追加到输入框的文本；ChatInput 消费后清空，不覆盖现有草稿。 */
  composerInsertion: string | null;
  marketSkills: Skill[];
  /** 已安装专家 */
  experts: Expert[];
  /** 市场专家 */
  marketExperts: MarketExpert[];
  /** 连接器（本地市场） */
  connectors: LocalConnectorDto[];
  /**
   * Artifact Domain projection（V3.5 §20/§25，Wave 3A）：
   * 唯一写入口 = snapshot/created/updated/removed reducer（shared/artifact-projection）；
   * 可丢弃、可重新 hydrate；不可反向覆盖 Repository。
   */
  artifactProjection: ArtifactProjection;
  /**
   * 场景模式产物显示策略缓存（mode → artifactPolicy）。
   * 仅用于产物面板显示过滤（deny 命中/白名单外隐藏），不参与写入拦截（V3.6）。
   */
  artifactPolicies: Partial<Record<WelcomeMode, ModeArtifactPolicy>>;
  /**
   * 渲染内容缓存（3C 桥）：打开的 artifact 的内容快照；非真相，只服务渲染。
   * 3E：projection 派生视图从这里补 content（reader 已直读 projection）。
   */
  artifactRenderCache: Record<string, ArtifactRenderPayload>;
  /**
   * Renderer-only hydration 状态（V3.5 hotfix §9）：不是 Artifact Domain truth；
   * 二进制 Viewer（pdf/docx/xlsx/pptx/image）在 content 未 ready 时禁止挂载。
   */
  artifactRenderLoadState: Record<string, ArtifactRenderLoadState>;
  /** hydration 失败原因（渲染展示用；不打印 base64 内容） */
  artifactRenderErrors: Record<string, string | undefined>;

  /**
   * 重新生成的两阶段 pending 记录（方案 Problem Three 5.3）。
   * 点击后旧消息保留，仅登记此记录；主进程真正发出 assistant_start 时才原子替换。
   * key = newAssistantMessageId；assistant_start 到达时按此定位并 commit。
   */
  pendingRegenerations: Record<string, PendingRegeneration>;

  /** 对话分支（Branch in new task）灰度开关（来自主进程 appSettings） */
  conversationBranchEnabled: boolean;
  /** 分支创建中（防止重复点击；key = source taskId） */
  branchCreatingTaskId: string | null;
  /** 当前活跃任务的来源分支信息（无则 null；加载失败 undefined 区分） */
  branchSource: ConversationBranchInfoDto | null | undefined;
  /** 当前活跃任务的直接子分支列表 */
  branchChildren: ConversationBranchInfoDto[];
  /** 创建/加载失败的用户可见错误 */
  branchError: { taskId: string; message: string } | null;
  /** 从消息创建分支（消息菜单入口；位置语义 §3.2） */
  createBranchFromMessage: (
    messageId: string,
    opts: { role: "user" | "assistant"; entryId?: string; userMessageIndex?: number },
  ) => Promise<boolean>;
  /** 任务切换/创建后刷新血缘展示（getInfo + listChildren） */
  refreshBranchLineage: (taskId: string) => void;
  clearBranchError: () => void;

  /** 统一内容 hydration 入口（hotfix §6）：descriptor → cache(version 匹配) → readContent */
  ensureArtifactRenderPayload: (artifactId: string) => Promise<ArtifactRenderPayload | null>;

  /** 拉取某模式的产物显示策略并缓存（失败静默：无缓存 = 不过滤、显示全部） */
  refreshArtifactPolicy: (mode: WelcomeMode) => Promise<void>;
  /** 拉取 task 快照并写入 projection（loading → ready/error；snapshot 落后自动重拉收敛） */
  hydrateArtifacts: (taskId: string) => Promise<void>;
  /**
   * 历史消息 artifactIds ↔ Domain 对账（刷新后芯片不丢）。
   * hist-art-* 伪 id 按 name/path 映射；孤儿产物挂最后一条助手消息。
   */
  reconcileTaskMessageArtifacts: (taskId: string) => void;
  /** projection 唯一写入口（内部 reducer 包装，其他地方不得直接改 projection） */
  applyArtifactSnapshot: (snapshot: ArtifactSnapshot) => void;
  applyArtifactCreated: (event: ArtifactCreatedEvent) => void;
  applyArtifactUpdated: (event: ArtifactUpdatedEvent) => void;
  applyArtifactRemoved: (event: ArtifactRemovedEvent) => void;
  clearArtifactTask: (taskId: string) => void;
  /** 打开意图命中后的渲染缓存（3C：内容快照，非真相） */
  cacheArtifactRender: (artifactId: string, payload: ArtifactRenderPayload) => void;

  setPage: (page: Page) => void;
  openProjectDetails: (projectId: string, tab?: ProjectWorkspaceTab) => void;
  setTaskStatus: (id: string, status: Task["status"]) => void;
  closeProjectDetails: () => void;
  setActiveProjectTab: (tab: ProjectWorkspaceTab) => void;
  requestProjectsRoot: () => void;
  requestProjectNav: (dest: ProjectNavDestination) => void;
  requestLibraryNav: (dest: { view: "space"; spaceId: string; folderId: string | null } | { view: "item"; itemId: string }) => void;
  applyProjectNavigation: (dest: ProjectNavDestination) => void;
  clearProjectNavRequest: () => void;
  /** Project 内新建任务：同一 draft materialize 路径，projectId 已锁定。 */
  startProjectTask: (opts: {
    projectId: string;
    planId?: string;
    spaceId?: string;
    title?: string;
    welcomeMode: WelcomeMode;
    modePresetId: string | null;
  }) => void;
  setWelcomeMode: (mode: WelcomeMode) => void;
  /** 选中 Design Mode 场景预设（空任务可自由切换；已锁定任务只更新全局 selection） */
  setModePreset: (presetId: string) => void;
  /** D1：用新 welcomeMode 复制为新任务（不复制 session/messages） */
  duplicateTaskWithMode: (mode: WelcomeMode, fromTaskId?: string) => void;
  /**
   * 通用“从当前任务创建关联任务”（同 Space、独立 session，复用 refTask 引用源任务）。
   * 返回新任务 id；专家缺失且市场不可装 / 源任务不存在时返回 null（调用方自行提示）。
   */
  createRelatedTask: (opts: CreateRelatedTaskOptions) => Promise<string | null>;
  /** 把当前 ACTIVE 抓取元素加入聊天（composer chip + 聚焦；无 ACTIVE selection 时无操作） */
  attachSelectionToChat: (comment?: string) => boolean;
  /** 终端会话镜像更新（open/restart 响应） */
  setTerminalSession: (info: TerminalSessionInfo) => void;
  /** 终端会话退出事件（sessionId 不匹配的旧会话事件丢弃） */
  applyTerminalExit: (ev: TerminalExitEvent) => void;
  /** 终端「加入对话」：选中文本或最近输出 → 下一条消息携带（sessionId/cwd/shell 从会话镜像补齐） */
  attachTerminalContext: (
    ctx: Pick<TerminalContextDto, "taskId" | "source" | "text"> & { capturedAt?: number; workspaceId?: string },
  ) => boolean;
  clearTerminalContext: () => void;
  /**
   * 产物面板「发送到对话」：把当前预览文件挂到输入框（refFile 芯片 + 有 path 时作为附件）。
   * ChatInput 监听 pendingRefFile 消费；递增 chatFocusTick 聚焦输入框。
   */
  attachArtifactToChat: (file: RefFileItem) => boolean;
  clearPendingRefFile: () => void;
  /** 把文本填入底部输入框并聚焦（消息操作「导入到输入框」） */
  fillComposer: (text: string) => void;
  clearComposerDraft: () => void;
  appendComposer: (text: string) => void;
  clearComposerInsertion: () => void;
  /**
   * 把源任务上下文分享到目标任务对话：切换到目标任务，并挂起 refTask 供 ChatInput 消费。
   */
  shareTaskToConversation: (sourceTaskId: string, targetTaskId: string) => Promise<boolean>;
  clearPendingRefTask: () => void;
  continueExternalAgent: (target: { runId: string; agentId: ExternalAgentId; agentName: string }) => boolean;
  clearPendingExternalAgentContinuation: () => void;
  /** 移除指定抓取元素；不传参数时清空全部（兼容旧调用）。 */
  clearChatSelection: (selection?: ChatSelection) => void;
  applyAgentPatch: (patch: AgentUiPatch) => void;
  applyAgentDeltaBatch: (patches: AgentDeltaPatch[]) => void;
  initRuntime: () => (() => void) | void;
  refreshSkills: () => Promise<void>;
  refreshModelConfiguration: () => Promise<void>;
  refreshExperts: () => Promise<void>;
  refreshTaskExpertBinding: (taskId: string) => Promise<import("../../../shared/expert-binding").TaskExpertBindingDto>;
  saveTaskExpertBinding: (input: import("../../../shared/expert-binding").TaskExpertBindingSaveRequest) => Promise<import("../../../shared/expert-binding").TaskExpertBindingDto>;
  installExpert: (id: string) => Promise<void>;
  installExpertByPath: (path: string) => Promise<Expert | null>;
  importExpertZip: (zipPath: string) => Promise<Expert | null>;
  uninstallExpert: (id: string) => Promise<void>;
  /** Expert market entry. */
  deleteMarketExpert: (id: string) => Promise<void>;
  setExpertEnabled: (id: string, enabled: boolean) => void;
  /** Expert selected for the task. */
  summonExpert: (expertId: string, spaceId?: string) => void;
  /** 当前会话切换/解除专家 */
  switchExpert: (expertId: string | null) => void;
  /**
   * ACP 外部 Agent 任务级固定：固定后本任务每轮自动路由该 Agent 并续接最近可恢复 run；
   * null = 解除固定。草稿态写入 draft，随首条消息 materialize 落库（tasks.external_agent_pin_json）。
   */
  setExternalAgentPin: (pin: ExternalAgentPinDto | null) => void;
  /** 连接器市场 */
  refreshConnectors: () => Promise<void>;
  refreshProjects: (includeArchived?: boolean) => Promise<void>;
  /** Bind Project context independently of Space; null explicitly unbinds. */
  bindProjectContext: (taskId: string, projectId: string | null) => void;
  /** Select Project for an unmaterialized Task draft. */
  setDraftProject: (projectId: string | null) => void;
  installConnector: (id: string) => Promise<string[]>;
  importConnectorByPath: (path: string) => Promise<LocalConnectorDto>;
  importConnectorZip: (zipPath: string) => Promise<LocalConnectorDto>;
  uninstallConnector: (id: string) => Promise<void>;
  /** 启用/停用已安装连接器（停用 = 私有技能不再进入候选装配；安装 ≠ active） */
  setConnectorEnabled: (id: string, enabled: boolean) => Promise<void>;
  /** 设置当前任务的 Active 连接器集合（草稿态为待命值，随首条消息写入任务） */
  setActiveConnectors: (ids: string[]) => void;
  /** 从市场删除连接器条目 */
  deleteMarketConnector: (id: string) => Promise<void>;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
  toggleSidebar: () => void;
  setActiveTask: (id: string) => void;
  newTask: (spaceId?: string, projectId?: string) => void;
  deleteTask: (id: string) => void;
  purgeArchivedContent: (request: ArchivedContentDeletionRequest) => Promise<ArchivedContentDeletionResult>;
  /** 回收站：删除的任务不在 tasks 里，必须单独拉取，否则既恢复不了也清不掉。 */
  trashedTasks: TrashedTaskDto[];
  refreshTrashedTasks: () => Promise<void>;
  restoreTrashedTask: (id: string) => Promise<void>;
  renameTask: (id: string, title: string) => void;
  toggleTaskSection: () => void;
  toggleSpaceCollapsed: (id: string) => void;
  /** 全部展开/收起空间（不受控于持久化；用于「展开全部」这类显式操作） */
  setAllSpacesExpanded: (expanded: boolean) => void;
  sendMessage: (
    text: string,
    attachments?: Attachment[],
    taskReferences?: TaskReference[],
    streamingBehavior?: "steer" | "followUp",
    /** 当前消息激活的连接器 id（其 Private Skills 进入候选技能集） */
    connectorIds?: string[],
    /** 显式覆盖（createRelatedTask 等已解析场景使用）：直接作为 explicit 传给主进程 */
    explicitOverrides?: { modelId?: string; permissionMode?: PermissionMode },
    /** 显式从「+ → 外部 Agent」选中的 ACP 执行者；单轮生效。 */
    externalAgent?: Pick<ExternalAgentDescriptorDto, "id" | "name" | "protocol"> & { continueFromRunId?: string },
  ) => void | Promise<void>;
  /** 重新生成：回退到某条助手回复前的用户消息，丢弃其后内容并重新生成 */
  regenerateMessage: (messageId: string) => void;
  /** 删除用户消息：同步回退会话分支，确保该消息及后续内容不再进入上下文 */
  deleteUserMessage: (messageId: string) => Promise<void>;
  /** 中止当前任务的流式生成 / Agent 执行 */
  abortActiveTask: () => Promise<void>;
  resolveToolApproval: (
    messageId: string,
    toolCallId: string,
    approved: boolean,
    externalWrite?: import("../../../shared/external-write").ExternalWriteApprovalChoice,
  ) => void;
  setSkillEnabled: (id: string, enabled: boolean) => void;
  installSkill: (id: string) => Promise<void>;
  installSkillByPath: (path: string) => Promise<Skill | null>;
  uninstallSkill: (id: string) => Promise<void>;
  /** 从市场删除技能条目 */
  deleteMarketSkill: (id: string) => Promise<void>;
  setActiveModel: (id: string) => void;
  /** F2：复位为「跟随场景建议」——清除本任务显式模型标记（Tag/Mode 建议可解析时直接应用） */
  followSuggestedModel: () => Promise<void>;
  /** F2：复位为「跟随场景建议」——清除本任务显式权限标记（Tag/Mode 建议可解析时直接应用） */
  followSuggestedPermission: () => Promise<void>;
  setModelReasoningPreference: (modelId: string, preference: ModelReasoningPreferenceDto | undefined) => void;
  setPermissionMode: (mode: PermissionMode) => void;
  setStreamingSendMode: (mode: StreamingSendMode) => void;
  updateSoul: (soul: Partial<Soul>) => void;
  setSettingsOpen: (open: boolean, tab?: SettingsTab) => void;
  openArtifact: (id: string) => void;
  closeArtifactTab: (id: string) => void;
  /** 删除单个产物；workspace-file 默认同时移入回收站 */
  removeArtifact: (id: string, opts?: { trashFile?: boolean }) => Promise<boolean>;
  /** 工作区路径删除后，清掉指向该路径（或文件夹内）的产物登记 */
  removeArtifactsForWorkspacePath: (root: string, relativePath: string) => Promise<void>;
  closePanel: () => void;
  showOverview: () => void;
  /** 聊天区「查看所有产物」：打开右侧概览主视图（非悬浮层） */
  showAllArtifacts: () => void;
  showWorkspace: () => void;
  /** 当前任务 Gadgets：右侧栏快速查看与打开。 */
  showGadgets: () => void;
  showBrowser: () => void;
  /** 扩展栏终端：无消息也可打开（体验参照浏览器）；PTY 生命周期在主进程 */
  showTerminal: () => void;
  showChanges: () => void;
  /** 聊天区「查看所有变更」：打开右侧变更主视图 */
  showAllChanges: () => void;
  /** 在扩展栏浏览器打开 URL（首页无任务时写入 __home__） */
  setBrowserUrl: (url: string | null) => void;
  navigateBrowser: () => void;
  refreshBrowser: () => void;
  openExtensionFlyout: (mode?: PanelMode) => void;
  toggleExtensionFlyout: () => void;
  closeExtensionFlyout: () => void;
  toggleExtensionFlyoutPinned: () => void;
  setExtensionMenuOpen: (open: boolean) => void;
  openLocalFile: () => Promise<void>;
  /** 选择本地文件夹并设为工作空间 */
  openLocalFolder: () => Promise<void>;
  openWorkspaceFile: (relativePath: string, name: string) => Promise<void>;
  /** 对话里的绝对路径（如 ProjectLibre XML）→ 登记并打开 */
  openLocalAbsoluteFile: (absPath: string) => Promise<void>;
  /**
   * 在系统资源管理器中打开任务工作区文件夹。
   * taskId 缺省 = 当前 activeTask；relativePath 可选，打开其下子目录。
   */
  openWorkspaceFolder: (relativePath?: string, taskId?: string) => Promise<void>;
  setPanelMode: (mode: PanelMode) => void;
  setSelectMode: (on: boolean) => void;
  toggleMessageSelected: (id: string) => void;
  selectAllMessages: (ids: string[]) => void;
  setTaskFilterStatus: (s: TaskFilterStatus) => void;
  setTaskFilterTime: (t: TaskFilterTime) => void;
  resetTaskFilters: () => void;
  setPanelWidth: (w: number) => void;
  togglePanelExpanded: () => void;
  setFullAccessDuringRun: (on: boolean) => void;
  setSearchOpen: (open: boolean) => void;
  togglePinTask: (id: string) => Promise<void>;
  /** 归档任务：从侧栏隐藏，数据与会话保留；可在设置「归档管理」页恢复 */
  archiveTask: (id: string) => Promise<void>;
  /**
   * 确认「已结束」绿点：点击/打开任务即视为已查看结果，写 done_acked_at 后绿点消失且重启保持消失。
   * 仅对「已结束且未确认」的任务生效（进行中的任务不需要确认）。
   */
  ackTaskDone: (id: string) => Promise<void>;
  /** 恢复已归档任务 */
  restoreTask: (id: string) => Promise<void>;
  /** 空间：归档空间从空间列表隐藏 */
  archiveSpace: (id: string) => Promise<void>;
  /** 恢复已归档空间 */
  restoreSpace: (id: string) => Promise<void>;
  /** 彻底删除空间（同时解绑其任务、删除其记忆），不可恢复 */
  deleteSpace: (id: string) => Promise<void>;
  setHomeSpaceId: (id: string | null) => void;
  /** 当前任务的外部写授权目录列表（任务级目录写 grant，撤销用） */
  listTaskWriteGrants: () => Promise<import("../../../shared/external-write").TaskWriteGrantRow[]>;
  /** 撤销当前任务的外部写授权目录；返回是否撤销成功 */
  revokeTaskWriteGrant: (path: string) => Promise<boolean>;
  /** 新建空间，返回新空间 id（便于调用方立即切换） */
  addSpace: (parentId?: string | null, name?: string) => Promise<string | undefined>;
  /** 从主进程重新读取工作空间树，用于 Blueprint 实例化后同步 UI */
  refreshSpaces: () => Promise<void>;
  ensureSpaceFromPath: (folderPath: string, name: string, parentId?: string | null, options?: { activate?: boolean }) => Promise<{ id: string; created: boolean }>;
  addSpaceFromPath: (folderPath: string, name: string, parentId?: string | null) => Promise<string>;
  /** 把已有空间指到新的本地文件夹；任务仍挂在同一 space_id 上 */
  relocateSpace: (id: string) => Promise<RelocateSpaceResult>;
  /** 探测空间文件夹是否还在；挪走后侧栏显示警告 */
  refreshSpacePathStatus: (id: string) => Promise<void>;
  renameSpace: (id: string, name: string) => Promise<boolean>;
  bindTaskSpace: (taskId: string, spaceId: string | null) => void;
  /** Phase 2 Tree V2：DnD - 严格走 DB moveSpace / moveTaskInWorkspaceTree targetIndex 契约（不发明第二套排序） */
  moveSpace: (req: { spaceId: string; targetParentId: string | null; targetIndex?: number }) => Promise<{ ok: true } | { ok: false; error: string }>;
  moveTaskInWorkspaceTree: (req: { taskId: string; targetSpaceId: string | null; targetIndex?: number }) => Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * 将消息中渲染出的 SVG/HTML 画布登记为产物（幂等：同 message+name 不重复）。
   * 对齐官方：聊天内展示详情卡 + 消息下方文件 chip + 可在侧栏打开。
   */
  ensureCanvasArtifact: (input: {
    messageId: string;
    content: string;
    kind: Extract<import("@/types").ArtifactKind, "html" | "svg">;
    preferredName?: string;
    /** 为 true 时打开侧栏预览（默认 false，避免打断阅读） */
    open?: boolean;
  }) => Promise<string | null>;
}

let idCounter = 0;
const uid = (): string => `local-${Date.now()}-${idCounter++}`;

/** 归一化路径：去掉尾部斜杠 */
function normalizePath(p: string): string {
  return p.replace(/[\\/]+$/, "");
}

export type RelocateSpaceResult =
  | { ok: true }
  | { ok: false; reason: "cancel" | "occupied" | "missing" | "write"; otherName?: string };

async function applySpacePath(
  space: Space,
  folderPath: string,
): Promise<{ ok: boolean; error?: string }> {
  const result = await window.api?.db?.upsertSpace({
    id: space.id,
    name: space.name,
    path: folderPath,
  });
  if (result && !result.ok) {
    return { ok: false, error: result.error };
  }
  return { ok: true };
}

/** 生成一个与现有空间不撞名（忽略大小写）的名称：base → base 2 → base 3 ...；按 parentId 作用域计算（NOCASE）。 */
function nextAvailableSpaceName(spaces: Array<{ name: string; parentId?: string | null }>, base: string, parentId: string | null = null): string {
  const names = new Set(
    spaces
      .filter((s) => (s.parentId ?? null) === (parentId ?? null))
      .map((s) => s.name.trim().toLowerCase()),
  );
  const trimmed = base.trim();
  if (!trimmed) return "工作空间";
  if (!names.has(trimmed.toLowerCase())) return trimmed;
  for (let n = 2; n < 10000; n += 1) {
    const candidate = `${trimmed} ${n}`;
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
  return `${trimmed} ${Date.now()}`;
}

/** Phase 2：统一 effectiveArchived 计算，复用 shared/workspace-tree 单算法源（带环防御），UI 不各自写一套 */
function recomputeEffectiveArchived(spaces: Space[]): Space[] {
  const m = computeEffectiveArchivedShared(
    spaces.map((s) => ({ id: s.id, parentId: s.parentId ?? null, archived: Boolean(s.archived) })),
  );
  return spaces.map((s) => ({ ...s, effectiveArchived: m.get(s.id) ?? false }));
}

/**
 * Sidebar Tree V2：空间展开状态持久（稳定 id，renderer/store 层 localStorage）。
 *
 * 默认值 = **全部收起**（产品决策：空间树的默认形态是折叠，展开是用户当次的选择）。
 * 存储语义是「用户显式展开过哪些空间」（展开集合），不再存「收起集合」：
 * 旧键存的是收起集合，无法区分「用户主动收起」与「默认未展开」，所以新键首次读取时
 * 忽略旧值并从空集合开始 —— 历史键保留不动，不回写、不删除，避免误清用户数据。
 */
const SIDEBAR_EXPANDED_KEY = "mybuddy:sidebar-expanded";
function loadSidebarExpanded(): string[] {
  try {
    if (typeof window === "undefined" || !window.localStorage) return [];
    const raw = window.localStorage.getItem(SIDEBAR_EXPANDED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function saveSidebarExpanded(ids: string[]): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    window.localStorage.setItem(SIDEBAR_EXPANDED_KEY, JSON.stringify(ids));
  } catch {
    /* ignore storage errors */
  }
}

function formatDuration(ms?: number): string | undefined {
  if (ms == null) return undefined;
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

export function upsertTextBlock(blocks: MessageBlock[], type: "text" | "thinking", delta: string): MessageBlock[] {
  const last = blocks[blocks.length - 1];
  if (last && last.type === type) {
    return [...blocks.slice(0, -1), { type, text: last.text + delta }];
  }
  return [...blocks, { type, text: delta }];
}

/**
 * Chat 正文段冻结（P0 生命周期 invariant）：工具调用打断时不再把已生成的正文
 * 从 finalBlocks 迁走/清空——已显示文本永不消失。冻结 = 在 finalBlocks 末尾
 * 追加一个空 text block 作为下一 prose 段的起点（后续 text_delta 经
 * upsertTextBlock 追加到新段，与工具前正文分开，不拼接混淆）。
 * 无正文时（空/undefined）不制造空段（验收：无正文 cancel 不产生空白块）。
 */
export function freezeFinalTextSegment(finalBlocks: MessageBlock[] | undefined): MessageBlock[] | undefined {
  if (!finalBlocks || finalBlocks.length === 0) return finalBlocks;
  const last = finalBlocks[finalBlocks.length - 1];
  // 已冻结（末尾已是空 text 段）或末尾非 text → 不重复冻结
  if (last.type === "text" && last.text.trim() !== "") {
    return [...finalBlocks, { type: "text", text: "" }];
  }
  return finalBlocks;
}

/**
 * error/abort 终态：在保留全部已生成正文的前提下追加错误提示块。
 * - 无正文：保持既有行为（仅错误块）；
 * - 有正文：追加非重复错误块（末尾已是相同错误文本 → 幂等跳过）。
 */
export function appendErrorBlock(
  finalBlocks: MessageBlock[] | undefined,
  error: string,
): MessageBlock[] {
  const blocks = finalBlocks ?? [];
  const errText = `错误：${error}`;
  const last = blocks[blocks.length - 1];
  if (last?.type === "text" && last.text.trim() === errText) return blocks;
  return [...blocks, { type: "text", text: errText }];
}

/** 正文区渲染过滤：跳过空 text 段（tool_start 冻结产生的空起点；无正文 cancel 不占位）。 */
export function nonEmptyFinalTextBlocks(finalBlocks: MessageBlock[] | undefined): MessageBlock[] {
  if (!finalBlocks) return [];
  return finalBlocks.filter((b) => b.type !== "text" || b.text.trim() !== "");
}

/**
 * ACP 外部 Agent 的「补历史」机制：
 * Pi 有 user_message / assistant_start 等创建型 patch，桌面端能凭空长出消息；
 * ACP Runtime 只发增量 patch，渲染层只能更新「已存在」的消息。当一轮委托由手机
 * （或另一台设备）发起、桌面端从未加载过该任务的 ACP 消息时，这些事件会被静默丢弃 ——
 * 用户看到的就是「手机上已经回复，电脑上什么都没有」。
 * 因此首次遇到未知 assistantMessageId 时按 taskId 补一次 history，把该轮 user/assistant
 * 消息落进 store，之后到达的 patch 就能正常增量渲染。按 taskId 去抖，避免事件风暴里反复拉取。
 */
const externalHistoryHydrations = new Map<string, number>();
const EXTERNAL_HISTORY_HYDRATION_MS = 2000;

/** 导出供测试直接驱动（initRuntime 的事件订阅走同一条路径）。 */
export function hydrateExternalAgentHistory(taskId: string): void {
  const now = Date.now();
  if (now - (externalHistoryHydrations.get(taskId) ?? 0) < EXTERNAL_HISTORY_HYDRATION_MS) return;
  externalHistoryHydrations.set(taskId, now);
  void (async () => {
    try {
      const history = await window.api?.agent?.loadTaskHistory?.(taskId);
      if (!history?.messages?.length) return;
      useAppStore.setState((state) => ({
        tasks: state.tasks.map((task) => {
          if (task.id !== taskId) return task;
          const known = new Set(task.messages.map((message) => message.id));
          const missing = history.messages
            .filter((message) => !known.has(message.id))
            .map((message) => historyMessageToChatMessage(message));
          if (!missing.length) return task;
          return {
            ...task,
            messages: [...task.messages, ...missing]
              .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
          };
        }),
      }));
    } catch {
      /* best effort：补历史失败不影响后续事件（下一次事件会再试） */
    }
  })();
}

/** 与 setActiveTask 的历史恢复保持同一投影：user=正文块；assistant=思考/工具 + 最终正文。 */
export function historyMessageToChatMessage(m: ChatMessageDto): ChatMessage {
  return {
    id: m.id,
    role: m.role,
    createdAt: m.createdAt,
    modelName: m.modelName,
    externalAgent: m.externalAgent,
    durationLabel: formatDuration(m.durationMs),
    entryId: m.entryId,
    attachments: m.attachments,
    blocks: m.role === "user"
      ? [{ type: "text" as const, text: m.text }]
      : [
          ...(m.thinking ? [{ type: "thinking" as const, text: m.thinking }] : []),
          ...(m.tools ?? []).map((tool) => ({ type: "tool" as const, toolCall: { ...tool } })),
          ...(m.text ? [{ type: "text" as const, text: m.text }] : []),
        ],
    finalBlocks: m.role === "assistant" && m.text ? [{ type: "text" as const, text: m.text }] : undefined,
    artifactIds: m.artifactIds,
    streaming: false,
  };
}

function hydrateTaskMetadataFromDb(taskId: string): void {  if (pendingTaskMetadataHydrations.has(taskId)) return;
  pendingTaskMetadataHydrations.add(taskId);
  void (async () => {
    try {
      const rows = await window.api?.db?.listTasks?.();
      const row = rows?.find((candidate) => candidate.id === taskId);
      if (!row) return;
      if (row.spaceId && !useAppStore.getState().spaces.some((space) => space.id === row.spaceId)) {
        void useAppStore.getState().refreshSpaces();
      }
      useAppStore.setState((state) => {
        const current = state.tasks.find((task) => task.id === taskId);
        if (!current) return state;
        const welcomeMode = row.welcomeMode ?? current.welcomeMode ?? DEFAULT_WELCOME_MODE;
        const selectedPresetId = row.modePresetId ?? defaultModePresetId(welcomeMode);
        const permissionMode = row.permissionMode ?? current.permissionMode ?? state.permissionMode;
        return {
          tasks: state.tasks.map((task) => task.id === taskId ? {
            ...task,
            title: row.title || task.title,
            spaceId: row.spaceId ?? undefined,
            projectId: row.projectId ?? undefined,
            status: (row.status as Task["status"]) ?? task.status,
            updatedAt: Math.max(task.updatedAt, row.updatedAt),
            sessionFile: row.sessionFile ?? task.sessionFile,
            cwd: row.cwd ?? task.cwd,
            modelId: row.modelId ?? task.modelId,
            permissionMode,
            welcomeMode,
            archived: row.archived,
            expertId: normalizeSingleExpertId(row.expertId),
            expertBinding: row.expertBinding,
            modePresetId: row.modePresetId,
            startAt: row.startAt ?? undefined,
            dueAt: row.dueAt ?? undefined,
            isFavorited: Boolean(row.isFavorited),
            spaceSortOrder: row.spaceSortOrder ?? task.spaceSortOrder ?? 0,
            externalAgentPin: row.externalAgentPin ?? task.externalAgentPin,
            doneAckedAt: row.doneAckedAt ?? task.doneAckedAt ?? null,
          } : task),
          ...(state.activeTaskId === taskId ? {
            welcomeMode,
            modePresetId: selectedPresetId,
            permissionMode,
            fullAccessDuringRun: permissionMode === "auto",
          } : {}),
        };
      });
    } catch (error) {
      console.warn("[appStore] 外部任务元数据同步失败", error);
    } finally {
      pendingTaskMetadataHydrations.delete(taskId);
    }
  })();
}

export function applyPatchToMessage(msg: ChatMessage, patch: AgentUiPatch): ChatMessage {
  switch (patch.type) {
    case "generation_stats":
      return { ...msg, generationStats: patch.stats };
    case "assistant_message_start":
      return { ...msg, finalBlocks: freezeFinalTextSegment(msg.finalBlocks) };
    case "assistant_start":
      return {
        ...msg,
        streaming: true,
        pendingBehavior: undefined,
        executionId: patch.executionId ?? msg.executionId,
        modelName: patch.modelName ?? msg.modelName,
      };
    case "conversation_interaction_snapshot": {
      const interactions = msg.interactions ?? [];
      const exists = interactions.some((item) => item.id === patch.interaction.id);
      return {
        ...msg,
        executionId: patch.executionId,
        interactions: exists
          ? interactions.map((item) => item.id === patch.interaction.id ? patch.interaction : item)
          : [...interactions, patch.interaction],
      };
    }
    case "text_delta": {
      // 防御：空 delta 不制造空 text block
      if (!patch.delta) return msg;
      if (patch.final) {
        return {
          ...msg,
          finalBlocks: upsertTextBlock(msg.finalBlocks ?? [], "text", patch.delta),
        };
      }
      return {
        ...msg,
        blocks: upsertTextBlock(msg.blocks, "text", patch.delta),
      };
    }
    case "thinking_delta":
      return {
        ...msg,
        blocks: upsertTextBlock(msg.blocks, "thinking", patch.delta),
      };
    case "tool_start": {
      if (["request_user_input",
        "conversation_goal_get", "conversation_goal_create", "conversation_goal_update",
        "conversation_goal_propose_complete"].includes(patch.tool)) return msg;
      const exists = msg.blocks.some(
        (b) => b.type === "tool" && b.toolCall.id === patch.toolCallId,
      );
      if (exists) {
        return {
          ...msg,
          blocks: msg.blocks.map((b) =>
            b.type === "tool" && b.toolCall.id === patch.toolCallId
              ? {
                  ...b,
                  toolCall: {
                    ...b.toolCall,
                    parentToolCallId: patch.parentToolCallId ?? b.toolCall.parentToolCallId,
                    status: patch.status,
                    summary: patch.summary,
                    detail: patch.detail ?? b.toolCall.detail,
                    dangerous: patch.dangerous ?? b.toolCall.dangerous,
                    approvalKind: patch.approvalKind ?? b.toolCall.approvalKind,
                    externalRunId: patch.externalRunId ?? b.toolCall.externalRunId,
                    acpPermissionOptions: patch.acpPermissionOptions ?? b.toolCall.acpPermissionOptions,
                    targetPath: patch.targetPath ?? b.toolCall.targetPath,
                    taskRoot: patch.taskRoot ?? b.toolCall.taskRoot,
                    canonicalDir: patch.canonicalDir ?? b.toolCall.canonicalDir,
                  },
                }
              : b,
          ),
        };
      }
      // P0 invariant：正文区永不因工具调用而清空/迁移。
      // 冻结当前 prose 段（后续 text_delta 开新段），正文保留在用户可见区；
      // ExecutionTimeline（blocks）只负责 thinking/tool/事件，不重复承载正文。
      return {
        ...msg,
        blocks: [
          ...msg.blocks,
          {
            type: "tool",
            toolCall: {
              id: patch.toolCallId,
              parentToolCallId: patch.parentToolCallId,
              tool: patch.tool,
              summary: patch.summary,
              detail: patch.detail,
              status: patch.status,
              dangerous: patch.dangerous,
              approvalKind: patch.approvalKind,
              externalRunId: patch.externalRunId,
              acpPermissionOptions: patch.acpPermissionOptions,
              targetPath: patch.targetPath,
              taskRoot: patch.taskRoot,
              canonicalDir: patch.canonicalDir,
            },
          },
        ],
        finalBlocks: freezeFinalTextSegment(msg.finalBlocks),
      };
    }
    case "tool_update":
      return {
        ...msg,
        blocks: msg.blocks.map((b) =>
          b.type === "tool" && b.toolCall.id === patch.toolCallId
            ? {
                ...b,
                toolCall: {
                  ...b.toolCall,
                  parentToolCallId: patch.parentToolCallId ?? b.toolCall.parentToolCallId,
                  status: patch.status ?? b.toolCall.status,
                  output: patch.output ?? b.toolCall.output,
                  consult: patch.consult ?? b.toolCall.consult,
                  webSearch: patch.webSearch ?? b.toolCall.webSearch,
                  summary: patch.summary ?? b.toolCall.summary,
                },
              }
            : b,
        ),
      };
    case "assistant_end":
      return {
        ...msg,
        streaming: false,
        pendingBehavior: undefined,
        durationLabel: formatDuration(patch.durationMs) ?? msg.durationLabel,
        finalBlocks: patch.error ? appendErrorBlock(msg.finalBlocks, patch.error) : msg.finalBlocks,
      };
    default:
      return msg;
  }
}

function defaultFlyoutViewForArtifact(
  artifact: { kind: string } | undefined,
): "overview" | "workspace" | "changes" {
  return "overview";
}

/**
 * 用户可见正文：去掉 /skill、【使用 MCP：…】、引用任务/文件块。
 * Agent 仍收完整 prompt；气泡与任务名只用这段，避免前缀盖住真实内容。
 * 同时抽出技能/MCP/连接器名，供用户气泡芯片展示（发送后仍可见）。
 */
function userVisiblePromptText(text: string): {
  display: string;
  skillNames: string[];
  mcpNames: string[];
  connectorNames: string[];
} {
  let raw = text.trim();
  if (!raw) return { display: "", skillNames: [], mcpNames: [], connectorNames: [] };

  const mcpNames: string[] = [];
  const mcpRe = /【使用\s*MCP\s*[：:]([^】]*)】/g;
  for (const m of raw.matchAll(mcpRe)) {
    for (const name of m[1]!.split(/[、,，;；]/).map((s) => s.trim()).filter(Boolean)) {
      if (!mcpNames.includes(name)) mcpNames.push(name);
    }
  }

  const connectorNames: string[] = [];
  const connRe = /【使用连接器[：:]([^】]*)】/g;
  for (const m of raw.matchAll(connRe)) {
    // 形如「钉钉（技能：a、b）；飞书」——取每段主名
    for (const part of m[1]!.split(/[;；]/).map((s) => s.trim()).filter(Boolean)) {
      const name = part.replace(/（[^）]*）/g, "").replace(/\([^)]*\)/g, "").trim();
      if (name && !connectorNames.includes(name)) connectorNames.push(name);
    }
  }

  raw = stripInjectedUserPromptTail(raw)
    .replace(/【使用\s*MCP\s*[：:][^】]*】/g, "")
    .replace(/【使用连接器[：:][^】]*】/g, "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const skillNames: string[] = [];
  let rest = raw;
  while (true) {
    const m = rest.match(/^\/([^\s/]+)(?:[ \t]+|\n+|$)/);
    if (!m) break;
    skillNames.push(m[1]!);
    rest = rest.slice(m[0].length).trimStart();
  }

  return { display: rest.trim(), skillNames, mcpNames, connectorNames };
}

/**
 * 首条消息生成侧栏任务名：去掉 /skill、MCP 提示前缀，优先用用户说明文字。
 * 例："/hello-buddy 你好" → "你好"；仅 "/hello-buddy" → "hello-buddy"
 */
function taskTitleFromFirstMessage(text: string, maxLen = 24): string {
  const { display, skillNames } = userVisiblePromptText(text);
  const titleBase = (display || skillNames[skillNames.length - 1] || "新任务")
    .replace(/\s+/g, " ")
    .trim();
  if (titleBase.length <= maxLen) return titleBase;
  return `${titleBase.slice(0, maxLen).trimEnd()}…`;
}

/**
 * Selection 投影落地 + chatSelections 失效判定（mirror 只读；
 * 唯一 truth 在 main SelectionStore）。同一 artifact/version/generation 内换选
 * DOM 元素不会让已加入项失效；页面刷新、跳转、关闭或清除才会标记 stale。
 * 导出供 chat-selection-test 直接驱动（initRuntime 内订阅同走此函数）。
 */
export function applySelectionMirror(state: SelectionState): void {
  useAppStore.setState({ selection: state });
  const current = useAppStore.getState().chatSelections;
  if (!current.length) return;
  let changed = false;
  const next = current.map((item) => {
    if (item.status === "stale") return item;
    const d = state.status === "active" ? state.descriptor : null;
    const sameSurface = Boolean(
      d &&
        d.artifactId === item.artifactId &&
        d.artifactVersion === item.artifactVersion &&
        d.surfaceGeneration === item.surfaceGeneration,
    );
    if (sameSurface) return item;
    changed = true;
    return { ...item, status: "stale" as const };
  });
  if (changed) useAppStore.setState({ chatSelections: next });
}

/**
 * Task 级 UI 收口纯函数（仅计算，不执行 IPC）。
 *
 * 用于删除/切换/新建 Task 时把右侧扩展栏相关状态原子复位，避免散落字段清单漂移
 * （方案 Problem One 3.3）。返回值是可并入 Zustand set() 的 Partial<AppState>。
 *
 * 关键语义：
 * - 删除当前 Task 时恢复「展开面板前的 sidebarCollapsed」，而不是只把
 *   sidebarBeforePanelExpand 置 null 丢掉原值（对齐 closePanel）。
 * - 只移除被删 Task 自己的 browserUrlByTask key，其它任务与首页 __home__ 保留。
 */
function resetTaskScopedUiState(
  state: Pick<
    AppState,
    | "activeTaskId"
    | "sidebarCollapsed"
    | "sidebarBeforePanelExpand"
    | "browserUrlByTask"
    | "browserUrlInput"
    | "panelMode"
    | "extensionView"
    | "extensionFlyoutOpen"
    | "extensionFlyoutPinned"
    | "extensionMenuOpen"
    | "artifactTabs"
    | "activeArtifactId"
    | "selectMode"
    | "selectedMessageIds"
    | "chatSelections"
    | "pendingExternalAgentContinuation"
    | "tasks"
    | "browserFrameKey"
  >,
  options: { nextTaskId: string | null; deletedTaskId?: string; clearBrowserUrl: boolean },
): Partial<AppState> {
  const browserUrlByTask = state.browserUrlByTask ?? {};
  const filtered = options.deletedTaskId
    ? Object.fromEntries(
        Object.entries(browserUrlByTask).filter(([k]) => k !== options.deletedTaskId),
      )
    : browserUrlByTask;
  return {
    activeTaskId: options.nextTaskId,
    panelOpen: false,
    panelMode: "file",
    panelExpanded: false,
    panelWidth: PANEL_RAIL_WIDTH,
    extensionView: "overview",
    extensionFlyoutOpen: false,
    extensionFlyoutPinned: false,
    extensionMenuOpen: false,
    artifactTabs: [],
    activeArtifactId: null,
    browserUrlInput: options.clearBrowserUrl ? "" : state.browserUrlInput ?? "",
    browserUrlByTask: filtered,
    sidebarCollapsed:
      state.sidebarBeforePanelExpand !== null
        ? state.sidebarBeforePanelExpand
        : state.sidebarCollapsed,
    sidebarBeforePanelExpand: null,
    selectMode: false,
    selectedMessageIds: [],
    chatSelections: [],
    pendingExternalAgentContinuation: null,
  };
}

export const useAppStore = create<AppState>((set, get) => ({
  page: "chat",
  theme: getInitialTheme(),
  sidebarCollapsed: false,
  tasks: [],
  trashedTasks: [],
  spaces: [],
  projects: [],
  activeProjectId: null,
  activeProjectTab: "activity",
  projectNavRequest: null,
  libraryNav: null,
  activeTaskId: null,
  draft: null,
  taskSectionCollapsed: false,
  expandedSpaceIds: loadSidebarExpanded(),
  skills: [],
  marketSkills: [],
  experts: [],
  marketExperts: [],
  connectors: [],
  artifactProjection: createInitialArtifactProjection(),
  artifactPolicies: {},
  selection: { ...EMPTY_SELECTION },
  chatSelections: [],
  terminalSessions: {},
  terminalContext: null,
  pendingRefFile: null,
  pendingRefTask: null,
  pendingExternalAgentContinuation: null,
  chatFocusTick: 0,
  composerDraft: null,
  composerInsertion: null,
  artifactRenderCache: {},
  artifactRenderLoadState: {},
  artifactRenderErrors: {},
  pendingRegenerations: {},
  conversationBranchEnabled: false,
  branchCreatingTaskId: null,
  branchSource: undefined,
  branchChildren: [],
  branchError: null,
  models: [],
  activeModelId: "",
  defaultModelId: "",
  // boot 的默认模型/权限都是「继承值」不是显式选择：显式标记只在用户操作时置 true
  modelExplicit: false,
  modelPreferences: {},
  permissionMode: "default",
  permissionExplicit: false,
  activeConnectorIds: [],
  soul: EMPTY_SOUL,
  settingsOpen: false,
  settingsTab: "system",
  panelOpen: false,
  panelMode: "file",
  extensionView: "overview",
  extensionFlyoutOpen: false,
  extensionFlyoutPinned: false,
  extensionMenuOpen: false,
  artifactTabs: [],
  activeArtifactId: null,
  selectMode: false,
  selectedMessageIds: [],
  taskFilterStatus: "all",
  taskFilterTime: "all",
  panelWidth: PANEL_RAIL_WIDTH,
  panelExpanded: false,
  sidebarBeforePanelExpand: null,
  browserUrlByTask: {},
  browserUrlInput: "",
  browserFrameKey: 0,
  fullAccessDuringRun: false,
  streamingSendMode: "steer",
  searchOpen: false,
  pinnedTaskIds: [],
  homeSpaceId: null,
  activeWorkspaceId: null,
  openWorkspaceDetail: (spaceId) => set({ activeWorkspaceId: spaceId, page: "workspace" }),
  closeWorkspaceDetail: () => set({ activeWorkspaceId: null }),
  welcomeMode: "working",
  // 初始 selection 必须对当前模式合法（集中式默认，禁止散落硬编码）
  modePresetId: defaultModePresetId("working"),
  compactionByTask: {},
  contextUsedTokens: null,
  contextEstimated: false,
  contextWindowTokens: 128_000,
  contextCacheHitRate: null,
  contextInputTokens: null,
  contextCacheReadTokens: null,
  contextOutputTokens: null,

  setPage: (page) =>
    set((s) => ({
      page,
      selectMode: false,
      selectedMessageIds: [],
      // 离开 chat 首页即丢弃未落库的草稿；离开 workspace 清导航态
      draft: page === "chat" ? s.draft : null,
      hubMcpFocusName: page === "mcp" ? s.hubMcpFocusName : null,
      ...(page !== "workspace" ? { activeWorkspaceId: null } : {}),
    })),

  // Task-scoped Subagent 临时 Chat（drawer）：仅当前父 Task 运行中的实例
  subagentDrawer: undefined as { instanceId: string } | undefined,
  openSubagentDrawer: (instanceId) => set({ subagentDrawer: { instanceId } }),
  closeSubagentDrawer: () => set({ subagentDrawer: undefined }),
  usageStatsOpen: false,
  openUsageStats: () => set({ usageStatsOpen: true }),
  closeUsageStats: () => set({ usageStatsOpen: false }),
  apiAggregationOpen: false,
  openApiAggregation: () => set({ apiAggregationOpen: true }),
  closeApiAggregation: () => set({ apiAggregationOpen: false }),
  extensionSoftwareOpen: false,
  openExtensionSoftware: () => set({ extensionSoftwareOpen: true }),
  closeExtensionSoftware: () => set({ extensionSoftwareOpen: false }),
  hubMcpFocusName: null,
  openHubMcp: (serverName) =>
    set({
      page: "mcp",
      hubMcpFocusName: serverName ?? null,
      selectMode: false,
      selectedMessageIds: [],
      draft: null,
      activeWorkspaceId: null,
    }),

  openProjectDetails: (projectId, tab = "activity") => {
    const current = get().activeProjectId;
    if (current) {
      set({
        page: "projects",
        projectNavRequest: current === projectId
          ? { type: "tab", tab }
          : { type: "project", projectId, tab },
        draft: null,
        selectMode: false,
        selectedMessageIds: [],
      });
      return;
    }
    set({
      page: "projects",
      activeProjectId: projectId,
      activeProjectTab: normalizeProjectWorkspaceTab(tab),
      projectNavRequest: null,
      draft: null,
      selectMode: false,
      selectedMessageIds: [],
    });
  },

  closeProjectDetails: () => set({
    activeProjectId: null,
    activeProjectTab: "activity",
    projectNavRequest: null,
  }),

  setActiveProjectTab: (tab) => set({ activeProjectTab: normalizeProjectWorkspaceTab(tab) }),

  requestProjectsRoot: () => {
    if (!get().activeProjectId) {
      set({ page: "projects" });
      return;
    }
    set({ page: "projects", projectNavRequest: { type: "project-list" } });
  },

  requestProjectNav: (dest) => set({ page: "projects", projectNavRequest: dest }),

  requestLibraryNav: (dest) => set({ page: "library", libraryNav: dest }),

  applyProjectNavigation: (dest) => {
    if (dest.type === "project-list") {
      set({ activeProjectId: null, activeProjectTab: "activity", projectNavRequest: null });
      return;
    }
    if (dest.type === "tab") {
      set({ activeProjectTab: normalizeProjectWorkspaceTab(dest.tab), projectNavRequest: null });
      return;
    }
    // rail-back / rail-collapse / page 在 ProjectWorkspace.finishGuard / requestNavigate 中处理
    if (dest.type === "rail-back" || dest.type === "rail-collapse") return;
    if (dest.type === "page") {
      set({
        page: dest.page,
        projectNavRequest: null,
        draft: null,
        selectMode: false,
        selectedMessageIds: [],
      });
      return;
    }
    set({
      page: "projects",
      activeProjectId: dest.projectId,
      activeProjectTab: normalizeProjectWorkspaceTab(dest.tab ?? "activity"),
      projectNavRequest: null,
      draft: null,
      selectMode: false,
      selectedMessageIds: [],
    });
  },

  clearProjectNavRequest: () => set({ projectNavRequest: null }),

  startProjectTask: ({ projectId, planId, spaceId, title, welcomeMode, modePresetId }) => {
    const trimmed = title?.trim();
    set({
      draft: {
        projectId,
        planId,
        spaceId,
        title: trimmed || undefined,
      },
      activeTaskId: null,
      chatSelections: [],
      pendingExternalAgentContinuation: null,
      activeConnectorIds: [],
      modelExplicit: false,
      permissionExplicit: false,
      homeSpaceId: spaceId ?? null,
      welcomeMode,
      modePresetId: modePresetId ?? defaultModePresetId(welcomeMode),
      page: "chat",
      panelOpen: false,
      artifactTabs: [],
      activeArtifactId: null,
      selectMode: false,
      selectedMessageIds: [],
    });
  },

  setWelcomeMode: (mode) => {
    const taskId = get().activeTaskId;
    const task = taskId ? get().tasks.find((item) => item.id === taskId) : undefined;
    // A submitted Bot already owns its backend before its first history snapshot arrives.
    const locked = Boolean(task && (task.messages.length > 0 || task.sessionFile || task.botPendingSubmission || task.durable));
    if (locked) {
      // 全局 selection 必须对新模式合法（不能把 design preset 带到 coding）
      set({ welcomeMode: mode, modePresetId: defaultModePresetId(mode) });
      return;
    }
    // 目标模式 preset：重选当前模式保留 selection；跨模式切换用该模式默认（集中式，保证合法）
    const sameMode = mode === get().welcomeMode;
    const preset =
      sameMode && get().modePresetId != null ? get().modePresetId : defaultModePresetId(mode);
    set((s) => ({
      welcomeMode: mode,
      modePresetId: preset,
      tasks: taskId
        ? s.tasks.map((t) =>
            t.id === taskId ? { ...t, welcomeMode: mode, modePresetId: preset } : t,
          )
        : s.tasks,
    }));
    // 产物面板显示过滤用：切换模式后立即拉取新模式的产物黑白名单（失败静默，兜底在消费侧）
    void get().refreshArtifactPolicy(mode);
    if (task) {
      void window.api?.db?.upsertTask({
        id: task.id,
        title: task.title,
        updatedAt: Date.now(),
        welcomeMode: mode,
        modePresetId: preset,
      });
    }
  },

  setModePreset: (presetId) => {
    const taskId = get().activeTaskId;
    if (isGatewayBotTaskId(taskId)) return;
    const task = taskId ? get().tasks.find((item) => item.id === taskId) : undefined;
    // 通知主进程：Tag/preset 被选择 → 立即触发 required-runtime prewarm（不等发送消息）
    void window.api?.agent?.selectModePreset?.({
      welcomeMode: get().welcomeMode,
      modePresetId: presetId,
    }).catch(() => undefined);
    // Bot Tags configure the next Durable input; other modes retain their session lock.
    const locked = task?.welcomeMode !== "bot" && Boolean(task && (task.messages.length > 0 || task.sessionFile));
    if (locked) {
      set({ modePresetId: presetId });
      return;
    }
    set((s) => ({
      modePresetId: presetId,
      tasks: taskId
        ? s.tasks.map((t) => (t.id === taskId ? { ...t, modePresetId: presetId } : t))
        : s.tasks,
    }));
    if (task) {
      void window.api?.db?.upsertTask({
        id: task.id,
        title: task.title,
        updatedAt: Date.now(),
        modePresetId: presetId,
      });
    }
  },

  attachSelectionToChat: (comment) => {
    const { selection } = get();
    if (selection.status !== "active" || !selection.descriptor) return false;
    const d = selection.descriptor;
    const classTail = d.classNames.slice(0, 2).map((c) => `.${c}`).join("");
    const label = `${d.tagName}${d.id ? `#${d.id}` : ""}${classTail}`;
    const nextSelection: ChatSelection = {
      comment: comment === undefined
        ? get().chatSelections.find((item) => selectionFingerprintMatches(d, item))?.comment
        : normalizeSelectionComment(comment),
      artifactId: d.artifactId,
      artifactVersion: d.artifactVersion,
      surfaceGeneration: d.surfaceGeneration,
      backendNodeId: d.backendNodeId,
      label,
      status: "pending",
    };
    set((s) => ({
      chatSelections: [
        ...s.chatSelections.filter((item) => !selectionFingerprintMatches(d, item)),
        nextSelection,
      ],
      chatFocusTick: s.chatFocusTick + 1,
    }));
    return true;
  },

  clearChatSelection: (selection) => {
    if (!selection) {
      if (get().chatSelections.length) set({ chatSelections: [] });
      return;
    }
    set((s) => ({
      chatSelections: s.chatSelections.filter((item) =>
        !(
          item.artifactId === selection.artifactId &&
          item.artifactVersion === selection.artifactVersion &&
          item.surfaceGeneration === selection.surfaceGeneration &&
          item.backendNodeId === selection.backendNodeId
        ),
      ),
    }));
  },

  setTerminalSession: (info) => {
    const ownerKey = terminalOwnerStoreKey(info) ?? "?";
    set((s) => ({ terminalSessions: { ...s.terminalSessions, [ownerKey]: info } }));
  },

  applyTerminalExit: (ev) => {
    set((s) => {
      const ownerKey = terminalOwnerStoreKey(ev) ?? "?";
      const current = s.terminalSessions[ownerKey];
      // 旧会话（已 restart 被替换）的 exit 事件丢弃，避免覆盖新会话状态
      if (!current || current.sessionId !== ev.sessionId) return {};
      return {
        terminalSessions: {
          ...s.terminalSessions,
          [ownerKey]: {
            ...current,
            alive: false,
            exitCode: ev.exitCode,
            exitReason: ev.reason,
          },
        },
      };
    });
  },

  attachTerminalContext: (ctx) => {
    const { terminalSessions } = get();
    // 空间终端会话键是 workspaceId；taskId 仍写入 TerminalContextDto 供对话绑定。
    const ownerKey = ctx.workspaceId?.trim() || ctx.taskId;
    const info = terminalSessions[ownerKey];
    if (!info?.sessionId || !ctx.text?.trim()) return false;
    const text = ctx.text.slice(0, TERMINAL_CONTEXT_MAX_CHARS);
    set((s) => ({
      terminalContext: {
        taskId: ctx.taskId,
        sessionId: info.sessionId,
        cwd: info.cwd,
        shell: info.shell,
        source: ctx.source,
        text,
        capturedAt: ctx.capturedAt ?? Date.now(),
      },
      chatFocusTick: s.chatFocusTick + 1,
    }));
    return true;
  },

  clearTerminalContext: () => {
    if (get().terminalContext) set({ terminalContext: null });
  },

  attachArtifactToChat: (file) => {
    if (!file?.id || !file.name?.trim()) return false;
    set((s) => ({
      pendingRefFile: {
        id: file.id,
        name: file.name.trim(),
        path: file.path?.trim() || undefined,
        content: file.path?.trim() ? undefined : file.content,
        source: file.source ?? "artifact",
      },
      chatFocusTick: s.chatFocusTick + 1,
    }));
    return true;
  },

  clearPendingRefFile: () => {
    if (get().pendingRefFile) set({ pendingRefFile: null });
  },

  clearPendingRefTask: () => {
    if (get().pendingRefTask) set({ pendingRefTask: null });
  },

  continueExternalAgent: (target) => {
    const taskId = get().activeTaskId;
    if (!taskId || !target.runId?.trim()) return false;
    set((state) => ({
      pendingExternalAgentContinuation: {
        taskId,
        runId: target.runId.trim(),
        agentId: target.agentId,
        agentName: target.agentName,
      },
      chatFocusTick: state.chatFocusTick + 1,
      page: "chat",
    }));
    return true;
  },

  clearPendingExternalAgentContinuation: () => {
    if (get().pendingExternalAgentContinuation) set({ pendingExternalAgentContinuation: null });
  },

  fillComposer: (text) => {
    const next = text?.trim() ? text : null;
    if (!next) return;
    set((s) => ({
      composerDraft: next,
      chatFocusTick: s.chatFocusTick + 1,
      page: "chat",
    }));
  },

  clearComposerDraft: () => {
    if (get().composerDraft != null) set({ composerDraft: null });
  },

  appendComposer: (text) => {
    const insertion = text?.trim();
    if (!insertion) return;
    set((state) => ({
      composerInsertion: state.composerInsertion
        ? `${state.composerInsertion}\n\n${insertion}`
        : insertion,
      chatFocusTick: state.chatFocusTick + 1,
      page: "chat",
    }));
  },

  clearComposerInsertion: () => {
    if (get().composerInsertion != null) set({ composerInsertion: null });
  },

  shareTaskToConversation: async (sourceTaskId, targetTaskId) => {
    if (!sourceTaskId || !targetTaskId || sourceTaskId === targetTaskId) return false;
    const state = get();
    const source = state.tasks.find((t) => t.id === sourceTaskId);
    const target = state.tasks.find((t) => t.id === targetTaskId);
    if (!source || !target || target.archived) return false;

    let ref: RefTaskItem;
    try {
      ref = await loadTaskAsRefItem({
        task: source,
        spaces: state.spaces,
        artifactDomain: window.api?.artifactDomain,
        loadHistory: window.api?.agent?.loadTaskHistory
          ? (id) => window.api!.agent!.loadTaskHistory!(id)
          : undefined,
      });
    } catch (err) {
      console.warn("[shareTaskToConversation] load source failed", err);
      return false;
    }

    // 先切到目标任务（会清掉跨任务 pending），再挂起本次分享引用
    get().setActiveTask(targetTaskId);
    set((s) => ({
      pendingRefTask: ref,
      chatFocusTick: s.chatFocusTick + 1,
      page: "chat",
    }));
    return true;
  },

  duplicateTaskWithMode: (mode, fromTaskId) => {
    const state = get();
    const sourceId = fromTaskId ?? state.activeTaskId;
    const source = sourceId ? state.tasks.find((t) => t.id === sourceId) : undefined;
    const task: Task = {
      id: uid(),
      title: source?.title ? `${source.title}（${mode === "working" ? "办公" : mode === "bot" ? "Bot" : "编码"}）` : "新任务",
      spaceId: source?.spaceId,
      projectId: source?.projectId,
      updatedAt: Date.now(),
      messages: [],
      modelId: source?.modelId ?? state.activeModelId,
      permissionMode: source?.permissionMode ?? state.permissionMode,
      welcomeMode: mode,
      cwd: source?.cwd,
      // 不复制 sessionFile / expertId（干净新会话；专家可再召唤）
      // preset：复制到当前模式带当前 selection；复制到其它模式用该模式默认（集中式，保证合法）
      modePresetId:
        mode === state.welcomeMode
          ? (state.modePresetId ?? defaultModePresetId(mode))
          : defaultModePresetId(mode),
    };
    set((s) => ({
      tasks: [task, ...s.tasks],
      activeTaskId: task.id,
      welcomeMode: mode,
      homeSpaceId: source?.spaceId ?? s.homeSpaceId,
      page: "chat",
      panelOpen: false,
      chatSelections: [],
      artifactTabs: [],
      activeArtifactId: null,
      selectMode: false,
      selectedMessageIds: [],
    }));
    void get().hydrateArtifacts(task.id);
  },

  /**
   * 通用关联任务（同 Space、独立 task/session；源任务引用复用 refTask 文本机制）。
   * 与具体场景无关：review / fix / explain / audit / design→implementation 都走这一条路，
   * 只靠 welcomeMode + modePresetId + expertId + permissionModel 参数组合。
   */
  createRelatedTask: async (opts) => {
    const state = get();
    const source = state.tasks.find((t) => t.id === opts.sourceTaskId);
    if (!source) return null;

    // 1) 目标专家：未安装 → 尝试市场安装（复用现有安装链路）；仍不可得 → 返回 null（调用方引导，不静默失败）
    let expertId = opts.expertId ?? undefined;
    if (expertId) {
      const has = (list: Expert[]): boolean =>
        list.some((e) => e.id === expertId || e.name === expertId);
      if (!has(get().experts)) {
        try {
          await window.api?.agent?.installExpert?.(expertId);
          await get().refreshExperts();
        } catch (err) {
          console.warn("[createRelatedTask] expert install failed", err);
        }
        if (!has(get().experts)) return null;
      }
    }

    // 2) 目标模式 profile → 统一策略解析（显式 > Tag 建议 > 回退链）
    let profile: ModeProfileDto | null = null;
    try {
      profile = (await window.api?.agent?.getModeProfile?.(opts.welcomeMode)) ?? null;
    } catch {
      profile = null;
    }
    const isModelAvailable = (id: string): boolean =>
      get().models.some((m) => m.id === id || `${m.vendor}/${m.id}` === id);
    const spec = resolveRelatedTaskSpec({
      sourceTitle: source.title,
      welcomeMode: opts.welcomeMode,
      modePresetId: opts.modePresetId,
      expertId,
      permissionMode: opts.permissionMode,
      modelId: opts.modelId,
      fallbackPermission: state.permissionMode,
      fallbackModelId: source.modelId ?? state.activeModelId,
      instruction: opts.instruction,
      isModelAvailable,
      profile,
    });

    // 3) 源任务上下文（对话 + 文件，复用 InputAddMenu 同一套 refTask 数据装配）
    const space = state.spaces.find((s) => s.id === source.spaceId) ?? undefined;
    let messages = source.messages
      .map((m) => ({
        role: m.role as "user" | "assistant",
        text: [...m.blocks, ...(m.finalBlocks ?? [])]
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim(),
      }))
      .filter((m) => m.text);
    const files: RefFileItem[] = [];
    if (source.sessionFile) {
      try {
        const history = await window.api?.agent?.loadTaskHistory?.(source.id);
        if (history && messages.length === 0) {
          messages = (history.messages ?? [])
            .map((m) => ({ role: m.role, text: m.text.trim() }))
            .filter((m) => m.text);
        }
        const seen = new Set<string>();
        const push = (item: RefFileItem): void => {
          const key = (item.path || item.name || item.id).toLowerCase();
          if (!key || seen.has(key)) return;
          seen.add(key);
          files.push(item);
        };
        for (const item of await collectTaskDomainArtifacts(window.api?.artifactDomain, source.id)) {
          push(item);
        }
        for (const m of history?.messages ?? []) {
          for (const a of m.artifacts ?? []) {
            push({
              id: a.id,
              name: a.name,
              path: a.path,
              content: a.path ? undefined : a.content || undefined,
              source: "artifact",
            });
          }
          for (const a of m.attachments ?? []) {
            push({
              id: `att:${a.path || a.name}`,
              name: a.name,
              path: a.path,
              source: "attachment",
            });
          }
        }
      } catch (err) {
        console.warn("[createRelatedTask] load source task history failed", err);
      }
    }
    const promptText = buildRelatedTaskPrompt(spec.instruction, {
      title: source.title,
      spaceName: space?.name,
      cwd: source.cwd ?? space?.path,
      messages,
      files,
    });

    // 4) 创建独立任务（同 Space；独立 session 由首条 prompt 创建）并激活
    const task: Task = {
      id: uid(),
      title: opts.title ?? spec.title,
      spaceId: source.spaceId,
      projectId: source.projectId,
      updatedAt: Date.now(),
      messages: [],
      modelId: spec.modelId,
      permissionMode: spec.permissionMode,
      welcomeMode: spec.welcomeMode,
      expertId: spec.expertId ?? undefined,
      modePresetId: spec.modePresetId,
    };
    set((s) => ({
      tasks: [task, ...s.tasks],
      activeTaskId: task.id,
      draft: null,
      welcomeMode: spec.welcomeMode,
      modePresetId: spec.modePresetId,
      activeModelId: spec.modelId ?? s.activeModelId,
      permissionMode: spec.permissionMode,
      fullAccessDuringRun: spec.permissionMode === "auto",
      // 关联任务从零开始：不继承源任务/上一任务的 Active 连接器（安装 ≠ active）
      activeConnectorIds: [],
      // F2：关联任务按「显式 > Tag > fallback」解析注入首条消息，但任务本身不置 explicit：
      // 首条消息后任务已有会话 → 后续消息沿用该任务上次生效值（重启兜底语义，与普通已有任务一致）；
      // 需要切换到当前 Tag/Mode 建议时使用「跟随场景建议」。
      modelExplicit: false,
      permissionExplicit: false,
      homeSpaceId: source.spaceId ?? s.homeSpaceId,
      page: "chat",
      panelOpen: false,
      chatSelections: [],
      artifactTabs: [],
      activeArtifactId: null,
      selectMode: false,
      selectedMessageIds: [],
    }));
    void get().hydrateArtifacts(task.id);
    void window.api?.db?.upsertTask({
      id: task.id,
      title: task.title,
      spaceId: task.spaceId,
      projectId: task.projectId,
      updatedAt: task.updatedAt,
      modelId: task.modelId,
      permissionMode: task.permissionMode,
      welcomeMode: task.welcomeMode,
      expertId: task.expertId,
      modePresetId: task.modePresetId,
    });

    // 5) 发送首条消息（引用源任务；独立 session 由此建立，模式/权限/专家由主进程按 task 字段装配）
    const taskRefs: TaskReference[] = [
      {
        taskId: source.id,
        title: source.title,
        spaceName: space?.name,
        files: files.map((f) => ({ id: f.id, name: f.name, path: f.path, source: f.source })),
      },
    ];
    get().sendMessage(promptText, undefined, taskRefs, undefined, undefined, {
      // 已解析场景（显式 > Tag 建议 > 回退链）直接作为 explicit 注入，与主进程解析等价
      modelId: spec.modelId,
      permissionMode: spec.permissionMode,
    });
    return task.id;
  },

  /**
   * 对话分支：从当前任务的某条消息创建独立 Task（实施规划 §4.1/§6.1）。
   * Renderer 只传 sourceTaskId + 稳定锚点（entryId）+ 过滤后 userMessageIndex；
   * session 路径、cwd、标题与血缘全部由主进程权威解析。
   */
  createBranchFromMessage: async (messageId, opts) => {
    const state = get();
    if (!state.conversationBranchEnabled) return false;
    const taskId = state.activeTaskId;
    if (!taskId || state.branchCreatingTaskId === taskId) return false;
    const messages = state.tasks.find((t) => t.id === taskId)?.messages ?? [];
    // 过滤后 UI 序号（辅助锚点；主锚点是 entryId，§7.1）
    const targetIndex = messages.findIndex((message) => message.id === messageId);
    if (targetIndex < 0) return false;
    const userMessageIndex = messages.slice(0, targetIndex + 1).filter((message) => message.role === "user").length - 1;
    if (userMessageIndex < 0) return false;
    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    set({ branchCreatingTaskId: taskId, branchError: null });
    try {
      const request: CreateConversationBranchRequest = {
        sourceTaskId: taskId,
        entryId: opts.entryId,
        userMessageIndex,
        position: opts.role === "user" ? "after_user" : "after_reply",
        requestId,
      };
      let result = await window.api?.conversationBranch?.create(request);
      // 任务仍在执行时主进程返回 TASK_BUSY：与安卓端「停止并删除」同构，
      // 先停止当前运行再重试（requestId 不变，重复请求返回同一个 child）。
      for (let attempt = 0; result && !result.ok && result.code === "TASK_BUSY" && attempt < 3; attempt += 1) {
        await get().abortActiveTask().catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 700));
        result = await window.api?.conversationBranch?.create(request);
      }
      if (!result) {
        set({ branchCreatingTaskId: null });
        return false;
      }
      if (!result.ok) {
        set({
          branchCreatingTaskId: null,
          branchError: {
            taskId,
            message:
              result.code === "TASK_BUSY"
                ? "任务仍在收尾：已停止当前运行，请稍后再点一次「从这里创建分支」。"
                : result.message,
          },
        });
        return false;
      }
      const child = result.result.task;
      const task: Task = {
        id: child.id,
        title: child.title,
        spaceId: child.spaceId,
        projectId: child.projectId,
        status: child.status,
        updatedAt: child.updatedAt,
        sessionFile: child.sessionFile,
        cwd: child.cwd,
        welcomeMode: child.welcomeMode,
        modelId: child.modelId,
        permissionMode: child.permissionMode,
        archived: child.archived,
        expertId: child.expertId,
        modePresetId: child.modePresetId,
        startAt: child.startAt,
        dueAt: child.dueAt,
        spaceSortOrder: child.spaceSortOrder,
        isFavorited: child.isFavorited,
        messages: [],
        connectorIds: state.activeConnectorIds,
      };
      set((s) => ({
        tasks: [task, ...s.tasks],
        branchCreatingTaskId: null,
        branchError: null,
      }));
      // setActiveTask 内自动：hydrateArtifacts + loadTaskHistory + context usage
      get().setActiveTask(child.id);
      get().refreshBranchLineage(taskId);
      return true;
    } catch (err) {
      set({
        branchCreatingTaskId: null,
        branchError: {
          taskId,
          message: err instanceof Error ? err.message : String(err),
        },
      });
      return false;
    }
  },

  refreshBranchLineage: (taskId) => {
    const api = window.api?.conversationBranch;
    if (!api) {
      set((s) => (s.activeTaskId === taskId ? { branchSource: null, branchChildren: [] } : {}));
      return;
    }
    void Promise.all([api.getInfo(taskId), api.listChildren(taskId)])
      .then(([source, children]) => {
        if (get().activeTaskId !== taskId) return; // 不污染其它任务
        set({ branchSource: source ?? null, branchChildren: children ?? [] });
      })
      .catch(() => {
        if (get().activeTaskId !== taskId) return;
        set({ branchSource: null, branchChildren: [] });
      });
  },

  clearBranchError: () => {
    if (get().branchError) set({ branchError: null });
  },

  initRuntime: () => {
    const api = window.api;
    if (!api?.agent) return () => undefined;

    // StrictMode / HMR 可能多次调用；先卸旧订阅，避免 text_delta 双倍追加
    agentEventUnsub?.();
    let deltaQueue: AgentDeltaPatch[] = [];
    let deltaFrame: number | null = null;
    let deltaTimer: number | null = null;

    const cancelDeltaSchedule = (): void => {
      if (deltaFrame !== null) cancelAnimationFrame(deltaFrame);
      if (deltaTimer !== null) window.clearTimeout(deltaTimer);
      deltaFrame = null;
      deltaTimer = null;
    };
    const flushDeltaQueue = (): void => {
      cancelDeltaSchedule();
      if (deltaQueue.length === 0) return;
      const patches = deltaQueue;
      deltaQueue = [];
      useAppStore.getState().applyAgentDeltaBatch(patches);
    };
    const scheduleDeltaFlush = (): void => {
      if (deltaFrame === null) deltaFrame = requestAnimationFrame(flushDeltaQueue);
      // 窗口在后台时 RAF 会被 Chromium 节流，定时器保证流式内容仍持续推进。
      if (deltaTimer === null) deltaTimer = window.setTimeout(flushDeltaQueue, 40);
    };
    const enqueueDelta = (patch: AgentDeltaPatch): void => {
      const previous = deltaQueue[deltaQueue.length - 1];
      if (
        previous &&
        previous.type === patch.type &&
        previous.taskId === patch.taskId &&
        previous.messageId === patch.messageId &&
        (previous.type !== "text_delta" ||
          (patch.type === "text_delta" && previous.final === patch.final))
      ) {
        previous.delta += patch.delta;
      } else {
        deltaQueue.push(patch);
      }
      scheduleDeltaFlush();
    };

    agentEventUnsub = api.agent.onEvent((patch) => {
      if (patch.type === "text_delta" || patch.type === "thinking_delta") {
        enqueueDelta(patch);
        return;
      }
      // 工具调用、结束等结构事件必须排在此前文本之后，先提交等待中的 delta。
      flushDeltaQueue();
      useAppStore.getState().applyAgentPatch(patch);
    });
    const unsubAgent = agentEventUnsub;

    externalAgentEventUnsub?.();
    externalAgentEventUnsub = api.externalAgent?.onEvent?.((event: ExternalAgentUiEvent) => {
      // 手机/其它设备发起的一轮 ACP：桌面端可能还没有这条 assistant 消息，补一次 history，
      // 否则下面的 patch 找不到目标消息会被整体丢弃（表现为「电脑上看不到手机的回复」）。
      const currentTask = useAppStore.getState().tasks.find((task) => task.id === event.taskId);
      if (currentTask && !currentTask.messages.some((message) => message.id === event.assistantMessageId)) {
        hydrateExternalAgentHistory(event.taskId);
      }
      // External Agent 与 Pi 共用消息渲染 reducer，但事件通道独立；先固化消息来源，
      // 再应用结构化 patch，避免 UI 把 Codex/Claude 等误标成 MyBuddy。
      useAppStore.setState((state) => ({
        tasks: state.tasks.map((task) =>
          task.id !== event.taskId
            ? task
            : {
                ...task,
                messages: task.messages.map((message) =>
                  message.id !== event.assistantMessageId
                    ? message
                    : {
                        ...message,
                        externalAgent: {
                          id: event.agentId,
                          name: event.agentName,
                          protocol: event.protocol,
                          runId: event.runId,
                          continuationMode: event.continuationMode,
                          sessionReady: Boolean(event.sessionId) || message.externalAgent?.sessionReady,
                          resumeSupported: event.resumeSupported,
                          recoveryState: event.recoveryState,
                          verificationStatus: event.verificationStatus,
                          outputCursor: event.outputCursor,
                        },
                        artifactIds: event.artifactRefs.length
                          ? [...new Set([...(message.artifactIds ?? []), ...event.artifactRefs])]
                          : message.artifactIds,
                      },
                ),
              },
        ),
      }));
      const patch = event.patch;
      if (patch.type === "text_delta" || patch.type === "thinking_delta") {
        enqueueDelta(patch);
        return;
      }
      flushDeltaQueue();
      useAppStore.getState().applyAgentPatch(patch);
    }) ?? null;
    const unsubExternalAgent = externalAgentEventUnsub;

    // 自动化执行产生的任务及时并入侧栏；结束后补一次 history，避免只剩空壳消息
    cronEventUnsub?.();
    cronEventUnsub =
      api.cron?.onEvent?.((ev: unknown) => {
        const e = ev as {
          type?: string;
          run?: { taskId?: string; status?: string; jobId?: string };
        };
        if (e?.type !== "run" || !e.run?.taskId) return;
        const taskId = e.run.taskId;
        const runStatus = e.run.status;
        void (async () => {
          const rows = (await window.api?.db?.listTasks?.()) ?? [];
          const row = rows.find((t) => t.id === taskId);
          if (!row) return;

          const mapped: Task = {
            id: row.id,
            title: row.title,
            spaceId: row.spaceId ?? undefined,
            projectId: row.projectId ?? undefined,
            status: (row.status as Task["status"]) ?? (
              runStatus === "success"
                ? "completed"
                : runStatus === "error"
                  ? "failed"
                  : "in_progress"
            ),
            updatedAt: row.updatedAt,
            messages: [],
            sessionFile: row.sessionFile,
            cwd: row.cwd,
            modelId: row.modelId ?? useAppStore.getState().activeModelId,
            permissionMode: row.permissionMode,
            welcomeMode: row.welcomeMode,
            archived: row.archived,
            expertId: normalizeSingleExpertId(row.expertId),
            expertBinding: row.expertBinding,
            modePresetId: row.modePresetId,
            startAt: row.startAt ?? undefined,
            dueAt: row.dueAt ?? undefined,
            externalAgentPin: row.externalAgentPin ?? undefined,
          };

          useAppStore.setState((s) => {
            const exists = s.tasks.some((t) => t.id === taskId);
            if (!exists) return { tasks: [mapped, ...s.tasks] };
            return {
              tasks: s.tasks.map((t) =>
                t.id === taskId
                  ? {
                      ...t,
                      title:
                        row.title && row.title !== "定时任务" && row.title !== "新任务"
                          ? row.title
                          : t.title,
                      status: mapped.status ?? t.status,
                      sessionFile: row.sessionFile ?? t.sessionFile,
                      cwd: row.cwd ?? t.cwd,
                      modelId: row.modelId ?? t.modelId,
                      updatedAt: Date.now(),
                    }
                  : t,
              ),
            };
          });

          // 运行结束且本地消息为空/过短时，从 session 恢复完整对话
          if (runStatus === "success" || runStatus === "error") {
            const cur = useAppStore.getState().tasks.find((t) => t.id === taskId);
            const needHistory =
              !cur ||
              cur.messages.length === 0 ||
              !cur.messages.some(
                (m) =>
                  m.role === "assistant" &&
                  ((m.finalBlocks?.some((b) => b.type === "text" && b.text.trim()) ?? false) ||
                    m.blocks.some((b) => b.type === "text" && b.text.trim())),
              );
            if (needHistory) {
              try {
                const history = await window.api?.agent?.loadTaskHistory?.(taskId);
                if (!history?.messages?.length) return;
                const restored: ChatMessage[] = history.messages.map((m) => ({
                  id: m.id,
                  role: m.role,
                  createdAt: m.createdAt,
                  modelName: m.modelName,
                  externalAgent: m.externalAgent,
                  durationLabel: formatDuration(m.durationMs),
                  entryId: m.entryId,
                  attachments: m.attachments,
                  blocks:
                    m.role === "user"
                      ? [{ type: "text" as const, text: m.text }]
                      : [
                          ...(m.thinking
                            ? [{ type: "thinking" as const, text: m.thinking }]
                            : []),
                          ...(m.tools ?? []).map((tool) => ({
                            type: "tool" as const,
                            toolCall: { ...tool },
                          })),
                          ...(m.text
                            ? []
                            : []),
                        ],
                  finalBlocks:
                    m.role === "assistant" && m.text
                      ? [{ type: "text" as const, text: m.text }]
                      : undefined,
                  artifactIds: m.artifactIds,
                  streaming: false,
                }));
                useAppStore.setState((s) => ({
                  tasks: s.tasks.map((t) =>
                    t.id === taskId
                      ? {
                          ...t,
                          messages: restored,
                          sessionFile: history.sessionFile ?? t.sessionFile,
                          cwd: history.cwd ?? t.cwd,
                          title:
                            row.title && row.title !== "定时任务"
                              ? row.title
                              : t.title,
                          updatedAt: Date.now(),
                        }
                      : t,
                  ),
                }));
              } catch {
                /* ignore history hydrate errors */
              }
            }
          }
        })();
      }) ?? null;
    const unsubCron = cronEventUnsub;

    // Wave 3A：Artifact Domain 事件订阅（projection 增量唯一来源；StrictMode 先卸旧订阅）
    for (const unsub of artifactEventUnsubs) unsub();
    artifactEventUnsubs = [];
    if (selectionEventUnsub) {
      selectionEventUnsub();
      selectionEventUnsub = null;
    }
    const dom = api.artifactDomain;
    if (dom) {
      artifactEventUnsubs = [
        dom.onCreated((ev) => useAppStore.getState().applyArtifactCreated(ev)),
        dom.onUpdated((ev) => useAppStore.getState().applyArtifactUpdated(ev)),
        dom.onRemoved((ev) => useAppStore.getState().applyArtifactRemoved(ev)),
      ];
    }

    // Wave 4D：Selection 投影订阅（唯一 truth 在 main SelectionStore；只读 mirror）
    void api.selection
      ?.get()
      ?.then((state) => {
        if (state) applySelectionMirror(state);
      })
      .catch(() => undefined);
    const offSelectionChanged = api.selection?.onChanged?.(({ state }) => {
      applySelectionMirror(state);
    });
    const offSelectionAttach = api.selection?.onAttach?.(({ selection, comment }) => {
      const current = useAppStore.getState().selection;
      if (current.status === "active" && current.descriptor && selectionFingerprintMatches(current.descriptor, selection)) {
        useAppStore.getState().attachSelectionToChat(comment);
      }
    });
    selectionEventUnsub = () => { offSelectionChanged?.(); offSelectionAttach?.(); };

    void (async () => {
      try {
        const [spaces, taskRows, projects, soul, models, skillRows, marketRows, appSettings, expertRows, marketExpertRows, connectorRows] =
          await Promise.all([
            api.db?.listSpaces() ?? Promise.resolve([]),
            api.db?.listTasks() ?? Promise.resolve([]),
            api.db?.listProjects?.() ?? Promise.resolve([]),
            api.db?.getSoul() ?? Promise.resolve(null),
            api.agent.listModels(),
            api.agent.listSkills(),
            api.agent.listMarketSkills?.() ?? Promise.resolve([]),
            api.agent.getAppSettings?.() ?? Promise.resolve(null),
            api.agent.listExperts?.() ?? Promise.resolve([]),
            api.agent.listMarketExperts?.() ?? Promise.resolve([]),
            api.agent.listConnectors?.() ?? Promise.resolve([]),
          ]);

        const mappedModels = models.map((m) => ({
          id: m.id,
          name: m.name,
          vendor: m.vendor,
          supportsToolCall: m.supportsToolCall,
          supportsImages: m.supportsImages,
          supportsReasoning: m.supportsReasoning,
          enabled: m.enabled !== false,
          contextWindow: m.contextWindow,
          api: m.api,
          thinkingLevels: m.thinkingLevels as ThinkingLevel[] | undefined,
          metadata: m.metadata,
        }));
        const enabledModels = mappedModels.filter((m) => m.enabled !== false);

        const defaultModelId =
          appSettings?.defaultModelId &&
          enabledModels.some((m) => m.id === appSettings.defaultModelId)
            ? appSettings.defaultModelId
            : (enabledModels[0]?.id ?? "");

        const modelPreferences = appSettings?.modelPreferences ?? {};

        // P0-1：hydration 直接以 TaskDto 为源保留 isFavorited/spaceSortOrder，去掉经截断 Task 再 as unknown TaskDto 的错误路径
        const mappedSpaces = recomputeEffectiveArchived((spaces as SpaceDto[]).map((s) => ({
            id: s.id,
            name: s.name,
            path: s.path,
            archived: s.archived,
            pathMissing: s.pathMissing,
            parentId: s.parentId ?? null,
            sortOrder: s.sortOrder ?? 0,
            createdAt: (s as SpaceDto).createdAt,
            effectiveArchived: s.effectiveArchived ?? Boolean(s.archived),
          })));
        const mappedTasks: Task[] = (taskRows as TaskDto[]).map((row) => mapTaskRowToTask(row, {
          enabledModelIds: new Set(enabledModels.map((model) => model.id)),
          defaultModelId,
          permissionModeDefault: appSettings?.permissionMode ?? "default",
          taskConnectorIds: appSettings?.taskConnectorIds,
        }));
        set({
          spaces: mappedSpaces,
          projects,
          tasks: mappedTasks,
          pinnedTaskIds: mappedTasks.filter((t) => t.isFavorited).map((t) => t.id),
          soul: soul ?? EMPTY_SOUL,
          models: mappedModels,
          skills: skillRows.map((s) => ({
            id: s.id,
            name: s.name,
            description: s.description,
            author: s.author,
            icon: s.icon,
            installed: s.installed,
            enabled: s.enabled,
            builtin: s.builtin,
            command: s.command,
            filePath: s.filePath,
            source: s.source,
          })),
          marketSkills: marketRows.map((s) => ({
            id: s.id,
            name: s.name,
            description: s.description,
            author: s.author,
            icon: s.icon,
            installed: false,
            enabled: false,
            command: s.name,
            version: s.version,
            source: s.source,
          })),
          experts: expertRows.map((e) => ({ ...e, installed: true })),
          marketExperts: marketExpertRows.map((e) => ({ ...e, installed: false, enabled: false })),
          connectors: connectorRows ?? [],
          activeModelId: defaultModelId,
          defaultModelId,
          modelPreferences,
          contextWindowTokens:
            mappedModels.find((m) => m.id === defaultModelId)?.contextWindow || 128_000,
          permissionMode: appSettings?.permissionMode ?? "default",
          conversationBranchEnabled: appSettings?.conversationBranchEnabled === true,
          activeTaskId: null,
          panelOpen: false,
          artifactTabs: [],
          activeArtifactId: null,
        });

        // 字体与字号：UI / Code 独立应用；旧版 CSS zoom 只用于一次性字号迁移。
        if (appSettings) {
          const resolvedTypography = {
            uiFontSize: normalizeUiFontSize(
              appSettings.uiFontSize ?? legacyFontScaleToUiFontSize(appSettings.fontSize),
            ),
            codeFontSize: normalizeCodeFontSize(appSettings.codeFontSize ?? DEFAULT_CODE_FONT_SIZE),
            uiFontFamily: appSettings.uiFontFamily ?? appSettings.fontFamily ?? "",
            codeFontFamily: appSettings.codeFontFamily ?? "",
          };
          applyFontSettings(resolvedTypography);
          document.documentElement.dataset.codeTheme = normalizeCodeTheme(appSettings.codeTheme);
          try {
            const fonts = (await window.api?.agent?.listUserFonts?.()) ?? [];
            await ensureAllUserFontsLoaded(fonts);
            // 用户字体就绪后再刷一次，避免启动时先落到 fallback。
            applyFontSettings(resolvedTypography);
          } catch (err) {
            console.warn("[initRuntime] load user fonts failed", err);
          }
        }
      } catch (err) {
        console.warn("[initRuntime] failed to load from main", err);
      }
    })();

    return () => {
      flushDeltaQueue();
      unsubAgent();
      unsubExternalAgent?.();
      unsubCron?.();
      for (const unsub of artifactEventUnsubs) unsub();
      artifactEventUnsubs = [];
      if (selectionEventUnsub) {
        selectionEventUnsub();
        selectionEventUnsub = null;
      }
      if (agentEventUnsub === unsubAgent) agentEventUnsub = null;
      if (externalAgentEventUnsub === unsubExternalAgent) externalAgentEventUnsub = null;
      if (cronEventUnsub === unsubCron) cronEventUnsub = null;
    };
  },

  // ---------- 场景产物显示策略（V3.6：黑白名单仅过滤产物面板显示，不拦截写入） ----------

  refreshArtifactPolicy: async (mode) => {
    try {
      const profile = await window.api?.agent?.getModeProfile?.(mode);
      if (!profile) return;
      set((s) => ({
        artifactPolicies: { ...s.artifactPolicies, [mode]: profile.policy.artifactPolicy },
      }));
    } catch (error) {
      console.warn("[appStore] refreshArtifactPolicy failed", mode, error);
    }
  },

  // ---------- Artifact Domain projection（Wave 3A：唯一写入口） ----------

  hydrateArtifacts: async (taskId) => {
    const api = window.api?.artifactDomain;
    if (!api) return;
    const p = get().artifactProjection;
    // 防重入 + lazy 语义：loading 中不并发拉；ready 靠常驻事件订阅增量更新，不重复 IPC
    if (p.artifactLoadState[taskId] === "loading" || p.artifactLoadState[taskId] === "ready") return;
    set((s) => ({
      artifactProjection: reduceArtifactProjection(s.artifactProjection, {
        type: "setLoadState",
        taskId,
        state: "loading",
      }),
    }));
    let attempts = 0;
    while (attempts < 3) {
      let snap: ArtifactSnapshot;
      try {
        snap = await api.snapshot({ taskId });
      } catch {
        set((s) => ({
          artifactProjection: reduceArtifactProjection(s.artifactProjection, {
            type: "setLoadState",
            taskId,
            state: "error",
          }),
        }));
        return;
      }
      const { applied } = applyArtifactSnapshot(get().artifactProjection, snap);
      if (applied) {
        set((s) => {
          const artifactProjection = reduceArtifactProjection(s.artifactProjection, {
            type: "snapshot",
            snapshot: snap,
          });
          const firstArtifactId = snap.artifacts[0]?.id ?? null;
          const shouldRestoreFirstTab =
            s.activeTaskId === taskId &&
            s.artifactTabs.length === 0 &&
            s.activeArtifactId === null &&
            firstArtifactId !== null;
          return {
            artifactProjection,
            ...(shouldRestoreFirstTab
              ? { artifactTabs: [firstArtifactId], activeArtifactId: firstArtifactId }
              : {}),
          };
        });
        // Domain 就绪后：把历史消息上的 hist-art 伪 id / 线索对账成真实 Domain id
        get().reconcileTaskMessageArtifacts(taskId);
        return;
      }
      // snapshot 落后于已 apply 的增量事件 → 重拉（幂等收敛，3A.4）
      attempts += 1;
    }
    set((s) => ({
      artifactProjection: reduceArtifactProjection(s.artifactProjection, {
        type: "setLoadState",
        taskId,
        state: "error",
      }),
    }));
  },

  /**
   * 刷新/切任务后：消息 artifactIds 与 Domain 对账。
   * 历史 jsonl 的 hist-art-* 不能直接当 Domain id 用，需按 name/path 映射。
   */
  reconcileTaskMessageArtifacts: (taskId) => {
    if (!taskId) return;
    const descriptors = get().artifactProjection.artifactsByTask[taskId];
    if (!descriptors?.length) return;
    set((s) => ({
      tasks: s.tasks.map((t) => {
        if (t.id !== taskId || !t.messages.length) return t;
        const messages = reconcileMessagesArtifactIds(t.messages, descriptors, taskId);
        if (messages === t.messages) return t;
        return { ...t, messages };
      }),
    }));
  },

  applyArtifactSnapshot: (snapshot) => {
    set((s) => ({
      artifactProjection: reduceArtifactProjection(s.artifactProjection, {
        type: "snapshot",
        snapshot,
      }),
    }));
  },
  applyArtifactCreated: (event) => {
    set((s) => ({
      artifactProjection: reduceArtifactProjection(s.artifactProjection, {
        type: "created",
        event,
      }),
    }));
  },
  applyArtifactUpdated: (event) => {
    set((s) => ({
      artifactProjection: reduceArtifactProjection(s.artifactProjection, {
        type: "updated",
        event,
      }),
    }));
    // V3.5 hotfix §10：cache 与 artifactVersion 绑定；内容版本移动 → 旧缓存失效
    getRenderHydration().invalidate(event.artifactId, event.version);
    // 当前打开的 artifact 自动重新 hydration（短暂 loading / 旧帧保持由 UI 层决定）
    if (get().activeArtifactId === event.artifactId) {
      void getRenderHydration().ensure(event.artifactId);
    }
  },
  applyArtifactRemoved: (event) => {
    set((s) => ({
      artifactProjection: reduceArtifactProjection(s.artifactProjection, {
        type: "removed",
        event,
      }),
    }));
    // V3.5 hotfix §11：removed → cache/loadState/error 全清；in-flight 结果由 stale guard 丢弃
    getRenderHydration().clear(event.artifactId);
    get().closeArtifactTab(event.artifactId);
  },
  clearArtifactTask: (taskId) => {
    set((s) => ({
      artifactProjection: reduceArtifactProjection(s.artifactProjection, {
        type: "clearTask",
        taskId,
      }),
    }));
  },
  cacheArtifactRender: (artifactId, payload) =>
    set((s) => ({
      artifactRenderCache: { ...s.artifactRenderCache, [artifactId]: payload },
    })),

  ensureArtifactRenderPayload: (artifactId) => getRenderHydration().ensure(artifactId),

  refreshModelConfiguration: async () => {
    const api = window.api?.agent;
    if (!api) return;
    try {
      const models = await api.listModels();
      const settings = await api.getAppSettings();
      set((s) => {
        const enabled = models.filter((model) => model.enabled !== false && model.available !== false);
        const defaultModelId = enabled.find((model) => model.id === settings.defaultModelId)?.id ?? enabled[0]?.id ?? "";
        // A task and an explicit draft selection belong to the user. External defaults
        // only select a model for an unmaterialized, unpinned draft.
        const activeModelId = !s.activeTaskId && !s.modelExplicit ? defaultModelId : s.activeModelId;
        return {
          models, defaultModelId, activeModelId,
          modelPreferences: settings.modelPreferences ?? {},
          contextWindowTokens: models.find((model) => model.id === activeModelId)?.contextWindow ?? s.contextWindowTokens,
        };
      });
    } catch (error) {
      console.warn("[models] External configuration refresh failed; keeping current selection", error);
    }
  },

  refreshSkills: async () => {
    const api = window.api?.agent;
    if (!api) return;
    const space = useAppStore.getState().spaces.find(
      (s) => s.id === useAppStore.getState().homeSpaceId,
    );
    const cwd = space?.path;
    const [skillRows, marketRows] = await Promise.all([
      api.listSkills(cwd),
      api.listMarketSkills?.(cwd) ?? Promise.resolve([]),
    ]);
    set({
      skills: skillRows.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        author: s.author,
        icon: s.icon,
        installed: s.installed,
        enabled: s.enabled,
        builtin: s.builtin,
        command: s.command,
        filePath: s.filePath,
        source: s.source,
      })),
      marketSkills: marketRows.map((s) => ({
            id: s.id,
            name: s.name,
            description: s.description,
            author: s.author,
            icon: s.icon,
            installed: false,
            enabled: false,
            command: s.name,
            version: s.version,
            source: s.source,
          })),
    });
  },

  applyAgentPatch: (patch) => {
    // deleteTask is an explicit lifecycle boundary. Main may still emit queued/terminal events while aborting;
    // those events must never resurrect the removed task in the renderer projection or upsert it back to DB.
    if (deletedTaskRuntimeTombstones.has(patch.taskId)) return;

    if (patch.type === "expert_binding") {
      set(state => ({ tasks: state.tasks.map(task => task.id === patch.taskId
        ? { ...task, expertBinding: patch.binding, expertId: patch.binding.desired?.sourceExpertId } : task) }));
      return;
    }

    if (patch.type === "durable_snapshot") {
      const snapshot = patch.snapshot;
      const known = get().tasks.find(task => task.id === patch.taskId);
      if (known?.durable?.epoch === snapshot.epoch && known.durable.revision >= snapshot.revision) return;
      const messages: ChatMessage[] = snapshot.messages.map(message => ({
        id: message.id, role: message.role, createdAt: message.createdAt,
        modelName: message.modelName, streaming: message.streaming,
        presentationKey: message.presentationKey, generationStats: message.generationStats,
        durationLabel: formatDuration(message.durationMs),
        attachments: message.attachments,
        blocks: message.role === "user" ? [{ type: "text", text: message.text }] : [
          ...(message.thinking ? [{ type: "thinking" as const, text: message.thinking }] : []),
          ...(message.tools ?? []).map(tool => ({ type: "tool" as const, toolCall: { ...tool } })),
        ],
        finalBlocks: message.role === "assistant" && message.text ? [{ type: "text", text: message.text }] : undefined,
      }));
      set(state => {
        const prior = state.tasks.find(task => task.id === patch.taskId);
        const task: Task = { ...prior, id: patch.taskId, welcomeMode: "bot", durable: snapshot, messages,
          title: prior?.title ?? taskTitleFromFirstMessage(snapshot.messages.find(m => m.role === "user")?.text ?? "Bot"),
          updatedAt: snapshot.messages.at(-1)?.createdAt ?? prior?.updatedAt ?? Date.now(),
          status: snapshot.busy ? "in_progress" : snapshot.error || snapshot.outcome === "failed" ? "failed" : snapshot.outcome === "completed" ? "completed" : "pending",
        };
        return { tasks: prior ? state.tasks.map(item => item.id === task.id ? task : item) : [task, ...state.tasks] };
      });
      if (!known) hydrateTaskMetadataFromDb(patch.taskId);
      get().reconcileTaskMessageArtifacts(patch.taskId);
      return;
    }

    if (patch.type === "user_message") {
      const needsTaskMetadataHydration = !get().tasks.some((task) => task.id === patch.taskId);
      set((s) => {
        let tasks = s.tasks;
        let task = tasks.find((t) => t.id === patch.taskId);
        const message: ChatMessage = {
          id: patch.messageId,
          role: "user",
          createdAt: patch.createdAt,
          blocks: [{ type: "text", text: patch.text }],
        };
        if (!task) {
          task = {
            id: patch.taskId,
            title: taskTitleFromFirstMessage(patch.text),
            updatedAt: patch.createdAt,
            messages: [message],
            status: "in_progress",
          };
          return { tasks: [task, ...tasks] };
        }
        if (task.messages.some((item) => item.id === patch.messageId)) return s;
        const promotePlaceholderTitle = task.messages.length === 0 &&
          (task.title === "新任务" || task.title === patch.taskId || task.title.startsWith("remote-"));
        tasks = tasks.map((item) => item.id === patch.taskId
          ? {
              ...item,
              title: promotePlaceholderTitle ? taskTitleFromFirstMessage(patch.text) : item.title,
              status: "in_progress",
              updatedAt: patch.createdAt,
              messages: [...item.messages, message],
            }
          : item);
        return { tasks };
      });
      if (needsTaskMetadataHydration) hydrateTaskMetadataFromDb(patch.taskId);
      return;
    }

    if (patch.type === "compaction_status") {
      set((s) => ({ compactionByTask: { ...s.compactionByTask, [patch.taskId]: patch.state } }));
      return;
    }
    if (patch.type === "context_usage") {
      const activeId = get().activeTaskId;
      if (activeId && patch.taskId !== activeId) return;
      set({
        contextUsedTokens: patch.usedTokens,
        contextEstimated: patch.estimated ?? false,
        contextWindowTokens: patch.contextWindow,
        contextCacheHitRate: patch.cacheHitRate ?? null,
        contextInputTokens: patch.inputTokens ?? null,
        contextCacheReadTokens: patch.cacheReadTokens ?? null,
        contextOutputTokens: patch.outputTokens ?? null,
      });
      return;
    }

    // 重新生成两阶段提交（方案 Problem Three 5.3 Phase B）：
    // 主进程真正发出 assistant_start 时，才按 pending 记录把会话原子替换为「源用户消息 + 新回复」。
    if (patch.type === "assistant_start") {
      const pending = get().pendingRegenerations[patch.messageId];
      if (pending) {
        const pendingTask = get().tasks.find((t) => t.id === pending.taskId);
        const srcUserIdx = pendingTask?.messages.findIndex(
          (m) => m.id === pending.sourceUserMessageId,
        );
        const srcIdx = pendingTask?.messages.findIndex(
          (m) => m.id === pending.sourceAssistantMessageId,
        );
        const cleanup = (): void => {
          const { [patch.messageId]: _drop, ...rest } = get().pendingRegenerations;
          set({ pendingRegenerations: rest });
        };
        if (pendingTask && srcUserIdx != null && srcUserIdx >= 0 && (srcIdx ?? -1) >= 0) {
          const newReply: ChatMessage = {
            id: patch.messageId,
            role: "assistant",
            createdAt: Date.now(),
            blocks: [],
            modelName: patch.modelName,
            streaming: true,
          };
          const { [patch.messageId]: _drop, ...rest } = get().pendingRegenerations;
          set((s) => ({
            pendingRegenerations: rest,
            tasks: s.tasks.map((t) =>
              t.id === pending.taskId
                ? {
                    ...t,
                    status: "in_progress",
                    updatedAt: Date.now(),
                    messages: [...t.messages.slice(0, srcUserIdx + 1), newReply],
                  }
                : t,
            ),
          }));
          return; // 已按语义原子替换，不再走通用 append
        }
        // 源消息已不存在（目标被删/漂移）：只清 pending，不创建空壳
        cleanup();
        return;
      }
    }

    const needsTaskMetadataHydration = !get().tasks.some((task) => task.id === patch.taskId);
    set((s) => {
      // 定时任务等主进程直驱场景：侧栏可能尚未有 task / 消息占位，先补齐再打补丁，
      // 否则 assistant_start / text_delta 全部 map 不中 → 空会话 + 「已完成 0ms」。
      let tasks = s.tasks;
      let task = tasks.find((t) => t.id === patch.taskId);
      if (!task && "taskId" in patch && patch.taskId) {
        task = {
          id: patch.taskId,
          title: patch.taskId.startsWith("cron-") ? "定时任务" : "新任务",
          updatedAt: Date.now(),
          messages: [],
          status: "in_progress",
        };
        tasks = [task, ...tasks];
      }
      if (!task) return s;

      if (
        "messageId" in patch &&
        patch.messageId &&
        (patch.type === "assistant_start" ||
          patch.type === "assistant_message_start" ||
          patch.type === "conversation_interaction_snapshot" ||
          patch.type === "text_delta" ||
          patch.type === "thinking_delta" ||
          patch.type === "tool_start" ||
          patch.type === "tool_update" ||
          patch.type === "assistant_end")
      ) {
        const hasMsg = task.messages.some((m) => m.id === patch.messageId);
        if (!hasMsg) {
          const shell: ChatMessage = {
            id: patch.messageId,
            role: "assistant",
            blocks: [],
            createdAt: Date.now(),
            streaming: patch.type !== "assistant_end",
            modelName: patch.type === "assistant_start" ? patch.modelName : undefined,
          };
          task = { ...task, messages: [...task.messages, shell] };
          tasks = tasks.map((t) => (t.id === task!.id ? task! : t));
        }
      }

      tasks = tasks.map((t) => {
        if (t.id !== patch.taskId) return t;
        const current = t.id === task!.id ? task! : t;

        if (patch.type === "capability_notices") {
          return { ...current, capabilityNotices: patch.notices };
        }

        if (patch.type === "conversation_goal_snapshot") {
          return { ...current, activeGoal: patch.goal, updatedAt: Date.now() };
        }

        if (patch.type === "artifact_ref") {
          // 3C：Artifact 本体由 Domain created/updated 事件驱动（projection → 派生视图）；
          // 这里只做消息关联 + 变更计数，不再直接写 task.artifacts。
          const fileChanges = patch.change
            ? [
                ...(current.fileChanges ?? []),
                {
                  id: `fc-${patch.change.name}-${Date.now()}`,
                  name: patch.change.name,
                  additions: patch.change.additions,
                  deletions: patch.change.deletions,
                },
              ]
            : current.fileChanges;
          return {
            ...current,
            fileChanges,
            messages: current.messages.map((m) =>
              m.id === patch.messageId
                ? {
                    ...m,
                    artifactIds: [...new Set([...(m.artifactIds ?? []), patch.artifactId])],
                    changesCount: (m.changesCount ?? 0) + (patch.change ? 1 : 0),
                  }
                : m,
            ),
            updatedAt: Date.now(),
          };
        }

        const messages = current.messages.map((msg) => {
          if (!("messageId" in patch) || msg.id !== patch.messageId) return msg;
          return applyPatchToMessage(msg, patch);
        });
        return {
          ...current,
          messages,
          updatedAt:
            patch.type === "assistant_start" || patch.type === "assistant_end"
              ? Date.now()
              : current.updatedAt,
          status:
            patch.type === "assistant_start"
              ? "in_progress"
              : patch.type === "assistant_end"
                ? hasActiveExecutionMessages(messages)
                  ? "in_progress"
                  : patch.error
                    ? "failed"
                    : "completed"
                : current.status,
        };
      });
      return { tasks };
    });
    if (needsTaskMetadataHydration) hydrateTaskMetadataFromDb(patch.taskId);
    if (patch.type === "assistant_start" || patch.type === "assistant_end") {
      const task = get().tasks.find((item) => item.id === patch.taskId);
      if (task) {
        void window.api?.db?.upsertTask({
          id: task.id,
          title: task.title,
          spaceId: task.spaceId,
          status: task.status,
          updatedAt: task.updatedAt,
          sessionFile: task.sessionFile,
          cwd: task.cwd,
          modelId: task.modelId,
          permissionMode: task.permissionMode,
          welcomeMode: task.welcomeMode,
        });
      }
    }
  },

  applyAgentDeltaBatch: (patches) => {
    if (patches.length === 0) return;

    const patchesByTask = new Map<string, AgentDeltaPatch[]>();
    for (const patch of patches) {
      if (deletedTaskRuntimeTombstones.has(patch.taskId)) continue;
      const queued = patchesByTask.get(patch.taskId);
      if (queued) queued.push(patch);
      else patchesByTask.set(patch.taskId, [patch]);
    }

    set((s) => ({
      tasks: s.tasks.map((task) => {
        const taskPatches = patchesByTask.get(task.id);
        if (!taskPatches) return task;

        const patchesByMessage = new Map<string, AgentDeltaPatch[]>();
        for (const patch of taskPatches) {
          const queued = patchesByMessage.get(patch.messageId);
          if (queued) queued.push(patch);
          else patchesByMessage.set(patch.messageId, [patch]);
        }

        return {
          ...task,
          messages: task.messages.map((message) => {
            const messagePatches = patchesByMessage.get(message.id);
            if (!messagePatches) return message;
            return messagePatches.reduce<ChatMessage>(applyPatchToMessage, message);
          }),
        };
      }),
    }));
  },

  toggleTheme: () => {
    const next: Theme = get().theme === "light" ? "dark" : "light";
    get().setTheme(next);
  },

  setTheme: (theme) => {
    applyTheme(theme);
    set({ theme });
  },

  toggleSidebar: () =>
    set((s) => {
      const sidebarCollapsed = !s.sidebarCollapsed;
      return {
        sidebarCollapsed,
        // 侧栏显隐会改变主区宽度，需重新夹紧右栏，避免聊天区被压穿最小宽度
        panelWidth: clampPanelWidth(s.panelWidth, sidebarCollapsed),
      };
    }),

  setActiveTask: (id) => {
    const task = get().tasks.find((t) => t.id === id);
    // 3E：首个产物 tab 从 projection 取（task.artifacts 已退役；未 hydrate 时为空，hydrate 后事件补齐）
    const first = get().artifactProjection.artifactsByTask[id]?.[0]?.id ?? null;
    const hasMessages = (task?.messages.length ?? 0) > 0;
    const taskModelId =
      task?.modelId && get().models.some((model) => model.id === task.modelId && model.enabled !== false)
        ? task.modelId
        : get().activeModelId;
    set({
      activeTaskId: id,
      // 切到具体任务 = 丢弃草稿（首条消息未发出即不存在）
      draft: null,
      // 工作空间选择跟随当前任务：独立任务清空 homeSpaceId，避免发消息时被上次空间偷绑
      homeSpaceId: task?.spaceId ?? null,
      // 抓取元素引用不跨任务：切任务即清理
      chatSelections: [],
      // 终端上下文不跨任务：切任务即清理（终端 PTY 本身在主进程按 taskId 保活）
      terminalContext: null,
      // 子代理临时 Chat 不跨任务：切任务即关闭（实例为 task-scoped disposable）
      subagentDrawer: undefined,
      // 产物「发送到对话」挂起项不跨任务
      pendingRefFile: null,
      // 分享任务挂起项不跨任务（shareTaskToConversation 在 setActiveTask 之后再写入）
      pendingRefTask: null,
      pendingExternalAgentContinuation: null,
      page: "chat",
      panelOpen: false,
      panelMode: hasMessages ? "overview" : "file",
      extensionView: hasMessages ? "overview" : "overview",
      extensionFlyoutOpen: false,
      extensionFlyoutPinned: false,
      extensionMenuOpen: false,
      panelExpanded: false,
      panelWidth: PANEL_RAIL_WIDTH,
      sidebarBeforePanelExpand: null,
      artifactTabs: first ? [first] : [],
      activeArtifactId: first,
      selectMode: false,
      selectedMessageIds: [],
      contextUsedTokens: null,
      contextEstimated: false,
      activeModelId: taskModelId,
      // F2：显式标记任务级隔离（不跨任务泄漏；新任务/继承值 = false）
      modelExplicit: task?.modelExplicit ?? false,
      contextWindowTokens:
        get().models.find((model) => model.id === taskModelId)?.contextWindow ||
        get().contextWindowTokens,
      permissionMode: task?.permissionMode ?? get().permissionMode,
      permissionExplicit: task?.permissionExplicit ?? false,
      fullAccessDuringRun: (task?.permissionMode ?? get().permissionMode) === "auto",
      welcomeMode: task?.welcomeMode ?? get().welcomeMode,
      // Active 连接器随任务切换（任务级；新任务/草稿为 []）
      activeConnectorIds: task?.connectorIds ?? [],
      // 全局 selection 跟随任务模式：任务已有 preset 用之，否则该模式默认（保证合法）
      modePresetId: task?.modePresetId ?? defaultModePresetId(task?.welcomeMode ?? get().welcomeMode),
    });
    // 打开任务 = 看过结果：清掉「已结束」绿点（持久化，重启不再亮）。仅对已结束未确认的任务写库。
    void get().ackTaskDone(id);
    const hydrateConversationRuntime = (): void => {
      void window.api?.conversationRuntime?.snapshot(id).then((snapshot) => {
        set((state) => ({
          tasks: state.tasks.map((candidate) => {
            if (candidate.id !== id) return candidate;
            const assistantMessages = candidate.messages.filter((message) => message.role === "assistant");
            const resolveHistoricalMessageId = (messageId: string, createdAt: number): string => {
              if (assistantMessages.some((message) => message.id === messageId)) return messageId;
              const nearest = assistantMessages.reduce<ChatMessage | undefined>((best, message) => {
                if (!best) return message;
                return Math.abs(message.createdAt - createdAt) < Math.abs(best.createdAt - createdAt) ? message : best;
              }, undefined);
              return nearest?.id ?? messageId;
            };
            const interactionsByMessage = new Map<string, typeof snapshot.interactions>();
            for (const interaction of snapshot.interactions) {
              const resolvedMessageId = resolveHistoricalMessageId(interaction.assistantMessageId, interaction.createdAt);
              const list = interactionsByMessage.get(resolvedMessageId) ?? [];
              list.push(interaction);
              interactionsByMessage.set(resolvedMessageId, list);
            }
            return {
              ...candidate,
              activeGoal: snapshot.activeGoal,
              messages: candidate.messages.map((message) => ({
                ...message,
                interactions: interactionsByMessage.get(message.id) ?? message.interactions,
              })),
            };
          }),
        }));
      }).catch((error) => console.warn("[appStore] conversation runtime hydrate failed", error));
    };
    hydrateConversationRuntime();
    void window.api?.agent?.getContextUsage?.(id).then((usage) => {
      if (!usage || get().activeTaskId !== id) return;
      set({
        contextUsedTokens: usage.usedTokens,
        contextEstimated: usage.estimated ?? false,
        contextWindowTokens: usage.contextWindow,
        contextCacheHitRate: usage.cacheHitRate ?? null,
        contextInputTokens: usage.inputTokens ?? null,
        contextCacheReadTokens: usage.cacheReadTokens ?? null,
        contextOutputTokens: usage.outputTokens ?? null,
      });
    });

    // Wave 3A：active task 强制 hydrate（未加载 → loading → snapshot → ready/error）
    void get().hydrateArtifacts(id);
    // 对话分支血缘：来源 chip + 子分支列表（切换任务即刷新）
    get().refreshBranchLineage(id);

    // 重启后 messages 为空时，从 session jsonl 恢复聊天记录
    // 3B.1：History 只恢复对话（messages/session/cwd）；Artifact 恢复唯一源 = Artifact Domain
    // （首次 hydrate 时 Main 侧一次性 legacy migration，见 ArtifactDomainSetup.ensureTaskLegacyMigrated）
    if (!hasMessages || get().tasks.find(task => task.id === id)?.welcomeMode === "bot") {
      void window.api?.agent?.loadTaskHistory?.(id).then(async (history) => {
        if (history.durable) {
          get().applyAgentPatch({ type: "durable_snapshot", taskId: id, snapshot: history.durable });
          // 模型目录收缩后主进程会把失效的任务模型修复为可解析模型：这里同步任务与输入框，
          // 否则输入框会继续显示旧的（已不存在的）模型，与实际执行不一致。
          const repairedModelId = history.modelId && get().models.some((model) => model.id === history.modelId && model.enabled !== false)
            ? history.modelId
            : undefined;
          set((s) => ({
            tasks: s.tasks.map((t) => (t.id === id
              ? {
                  ...t,
                  sessionRecovery: history.sessionRecovery,
                  historyError: history.historyError,
                  modelRecovery: history.modelRecovery,
                  modelId: history.modelId ?? t.modelId,
                }
              : t)),
            ...(s.activeTaskId === id && repairedModelId ? { activeModelId: repairedModelId } : {}),
          }));
          return;
        }
        const combinedHistoryMessages = history.messages ?? [];
        // 异步结果按目标 taskId 回填；切去其它任务不应丢弃已读出的历史。
        // 当前任务专属 UI 状态仍在下方按 activeTaskId 守卫，避免影响新页面。
        // 3B.1：Artifact 真源 = Domain；历史里的 hist-art-* 只作 name/path 线索
        const hints: HistoryArtifactHint[] = (history.messages ?? [])
          .filter((m) => (m.artifacts ?? []).length > 0)
          .map((m) => ({
            messageId: m.id,
            items: (m.artifacts ?? []).map((a) => ({
              name: a.name,
              path: a.path,
            })),
          }));
        setHistoryArtifactHints(id, hints);

        const restored: ChatMessage[] = combinedHistoryMessages.map((m) => {
          const referencedPaths = new Set(
            (m.taskReferences ?? [])
              .flatMap((reference) => reference.files ?? [])
              .map((file) => file.path?.toLowerCase())
              .filter((path): path is string => Boolean(path)),
          );
          const displayAttachments = (m.attachments ?? []).filter(
            (attachment) => !attachment.path || !referencedPaths.has(attachment.path.toLowerCase()),
          );
          return {
            id: m.id,
            role: m.role,
            createdAt: m.createdAt,
            modelName: m.modelName,
            externalAgent: m.externalAgent,
            durationLabel: formatDuration(m.durationMs),
            entryId: m.entryId,
            attachments: displayAttachments.length ? displayAttachments : undefined,
            selectionLabels: m.selectionLabels,
            blocks:
              m.role === "user"
                ? [{ type: "text" as const, text: m.text }]
                : [
                    ...(m.thinking
                      ? [{ type: "thinking" as const, text: m.thinking }]
                      : []),
                    ...(m.tools ?? []).map((tool) => ({
                      type: "tool" as const,
                      toolCall: { ...tool },
                    })),
                  ],
            finalBlocks:
              m.role === "assistant" && m.text
                ? [{ type: "text" as const, text: m.text }]
                : undefined,
            // Pi hist-art-* remains a hint; delegated runs may already carry trusted Domain ids.
            artifactIds: m.artifactIds,
            taskReferences: m.taskReferences?.map((reference) => ({
              taskId: reference.taskId,
              title: reference.title,
              spaceName: reference.spaceName,
              files: (reference.files ?? []).map((file, index) => ({
                id: file.id ?? `${id}-ref-${index}-${file.name}`,
                name: file.name,
                path: file.path,
                source: file.source,
              })),
            })),
            streaming: false,
          };
        });
        set((s) => ({
          tasks: s.tasks.map((t) =>
            t.id === id
              ? {
                  ...t,
                  messages: restored.length ? restored : t.messages,
                  sessionFile: history.sessionFile ?? t.sessionFile,
                  cwd: history.cwd ?? t.cwd,
                  sessionRecovery: history.sessionRecovery,
                  historyError: history.historyError,
                }
              : t,
          ),
          ...(s.activeTaskId === id ? { panelOpen: false } : {}),
        }));
        hydrateConversationRuntime();
        // Domain 若已 ready（hydrate 先完成）立刻对账；否则等 hydrate 回调
        get().reconcileTaskMessageArtifacts(id);
      }).catch((error: unknown) => {
        // 历史加载失败必须可见：空 projection 会渲染成「等待第一条消息」，
        // 把真实的存储损坏/占用伪装成正常空会话（真实事故：用户看到空白 Bot 会话）。
        const message = error instanceof Error ? error.message : String(error);
        console.warn("[appStore] loadTaskHistory failed", id, error);
        set((s) => ({
          tasks: s.tasks.map((t) => (t.id === id ? { ...t, historyError: message } : t)),
        }));
      });
    }
  },

  newTask: (spaceId, projectId) => {
    // 只登记草稿、不建任务：首条消息发出时才 materialize 并落库，
    // 避免每次点击都产生一条空白「新任务」行。
    set({
      activeModelId: get().defaultModelId,
      contextWindowTokens: get().models.find((model) => model.id === get().defaultModelId)?.contextWindow ?? 128_000,
      draft: spaceId !== undefined || projectId !== undefined ? { spaceId, projectId } : null,
      // A fresh task uses the product default, not the previous task's code scene.
      welcomeMode: DEFAULT_WELCOME_MODE,
      modePresetId: defaultModePresetId(DEFAULT_WELCOME_MODE),
      activeTaskId: null,
      chatSelections: [],
      // 新任务从零开始：不继承上一任务的 Active 连接器（安装 ≠ active）
      activeConnectorIds: [],
      // F2：新任务不继承任何显式选择（默认跟随 Tag/Mode 建议）
      modelExplicit: false,
      permissionExplicit: false,
      // 顶层「新建任务」必须回到普通任务；从空间内新建时则只保留该空间。
      // 否则 sendMessage 会把上一次首页选择的 homeSpaceId 当成兜底重新绑定。
      homeSpaceId: spaceId ?? null,
      page: "chat",
      panelOpen: false,
      artifactTabs: [],
      activeArtifactId: null,
      selectMode: false,
      selectedMessageIds: [],
    });
    void get().refreshModelConfiguration();
  },

  deleteTask: (id) => {
    // Mark before the optimistic UI removal / async Main trash call, closing the late-patch race window.
    deletedTaskRuntimeTombstones.add(id);
    const deletingActive = get().activeTaskId === id;
    set((s) => {
      const tasks = s.tasks.filter((x) => x.id !== id);
      if (deletingActive) {
        const nextTaskId = tasks[0]?.id ?? null;
        return {
          tasks,
          // 删除当前任务：Task 级 UI 原子收口（含 sidebar 恢复、browser 残留清理）
          ...resetTaskScopedUiState(s, {
            nextTaskId,
            deletedTaskId: id,
            clearBrowserUrl: true,
          }),
        };
      }
      // 删除非当前任务：不动当前右栏，只摘掉被删任务自身的 browser 残留
      const browserUrlByTask = s.browserUrlByTask ?? {};
      return {
        tasks,
        browserUrlByTask: Object.fromEntries(
          Object.entries(browserUrlByTask).filter(([k]) => k !== id),
        ),
      };
    });
    // P1.5：delete = 安全回收（move 到 projects-trash + 标记 trashed），保留 task/Artifact 至 purge。
    // 不再立即 artifactDomain.removeTask；永久清理由 purge 路径触发。
    const deletePromise = window.api?.db?.deleteTask(id);
    // 对话分支血缘：删除 child 后父任务「查看分支（N）」计数要刷新；
    // 删除 parent 后当前任务的来源 chip 要刷新为 parentExists=false。
    // 等主进程事务落库后再刷新，避免读到旧行。
    void deletePromise
      ?.then(() => {
        if (get().activeTaskId) get().refreshBranchLineage(get().activeTaskId!);
      })
      .catch(() => undefined);
    // 删除当前任务：在状态切换后立即显式关闭原生 Browser/Artifact WebContentsView，
    // 尽量缩短原生表面残留窗口；失败不阻止删除（App.tsx panel 卸载 effect 会兜底重关）。
    if (deletingActive && window.api?.artifact?.close) {
      try {
        window.api.artifact.close();
      } catch (err) {
        console.warn("[deleteTask] artifact.close failed", err);
      }
    }
    if (deletingActive && window.api?.browser?.close) {
      try {
        window.api.browser.close();
      } catch (err) {
        console.warn("[deleteTask] browser.close failed", err);
      }
    }
    // F3：taskConnectorIds 随任务保留至真正 purge —— delete = 回收站，restore 需恢复连接器配置；
    // 主进程 TaskExecutionWorkspaceLifecycle.purge 会在永久删除时清理对应 settings key。
    // projection 是 renderer 侧缓存：UI 隐藏即可；数据仍在 Domain 供恢复
    get().clearArtifactTask(id);
  },

  purgeArchivedContent: async (request) => {
    const api = window.api?.db?.purgeArchivedContent;
    if (!api) throw new Error("永久删除接口不可用，请重启到最新版本");
    // Only remove records acknowledged by Main; failed items remain available for retry.
    const result = await api(request);
    const taskIds = new Set(result.deletedTaskIds);
    const spaceIds = new Set(result.deletedSpaceIds);
    for (const id of taskIds) deletedTaskRuntimeTombstones.add(id);
    const deletingActive = taskIds.has(get().activeTaskId ?? "");
    set((state) => {
      const tasks = state.tasks.filter((task) => !taskIds.has(task.id));
      const spaces = recomputeEffectiveArchived(state.spaces.filter((space) => !spaceIds.has(space.id)));
      const archivedSpaceIds = new Set(spaces.filter((space) => space.effectiveArchived ?? space.archived).map((space) => space.id));
      const expandedSpaceIds = state.expandedSpaceIds.filter((id) => !spaceIds.has(id));
      if (expandedSpaceIds.length !== state.expandedSpaceIds.length) saveSidebarExpanded(expandedSpaceIds);
      const reset = deletingActive
        ? resetTaskScopedUiState(state, {
            nextTaskId: tasks.find((task) => !task.archived && !archivedSpaceIds.has(task.spaceId ?? ""))?.id ?? null,
            deletedTaskId: state.activeTaskId!,
            clearBrowserUrl: true,
          })
        : {};
      return {
        ...reset,
        tasks,
        spaces,
        pinnedTaskIds: state.pinnedTaskIds.filter((id) => !taskIds.has(id)),
        expandedSpaceIds,
        homeSpaceId: spaceIds.has(state.homeSpaceId ?? "") ? null : state.homeSpaceId,
        draft: spaceIds.has(state.draft?.spaceId ?? "") ? null : state.draft,
        browserUrlByTask: Object.fromEntries(Object.entries(state.browserUrlByTask ?? {}).filter(([id]) => !taskIds.has(id))),
      };
    });
    for (const id of taskIds) get().clearArtifactTask(id);
    if (deletingActive) {
      try {
        await window.api?.artifact?.close?.();
        await window.api?.browser?.close?.();
      } catch (error) {
        console.warn("[purgeArchivedContent] close native panel failed", error);
      }
    }
    if (get().activeTaskId && taskIds.size) void get().refreshBranchLineage(get().activeTaskId!);
    return result;
  },

  refreshTrashedTasks: async () => {
    const api = window.api?.db?.listTrashedTasks;
    if (!api) return;
    try {
      set({ trashedTasks: await api() });
    } catch (error) {
      console.warn("[refreshTrashedTasks]", error);
    }
  },

  restoreTrashedTask: async (id) => {
    const api = window.api?.db?.restoreTrashedTask;
    if (!api) throw new Error("回收站接口不可用，请重启到最新版本");
    const restored = await api(id);
    // 恢复后任务回到侧栏；回收站里不再列出它。
    deletedTaskRuntimeTombstones.delete(id);
    const state = get();
    const task = restored
      ? mapTaskRowToTask(restored, {
          enabledModelIds: new Set(state.models.filter((model) => model.enabled !== false).map((model) => model.id)),
          defaultModelId: state.defaultModelId,
          permissionModeDefault: state.permissionMode,
        })
      : null;
    set((current) => ({
      trashedTasks: current.trashedTasks.filter((item) => item.id !== id),
      tasks: task && !current.tasks.some((item) => item.id === task.id) ? [task, ...current.tasks] : current.tasks,
    }));
  },

  setTaskStatus: (id, status) => {
    const updatedAt = Date.now();
    set((state) => ({
      tasks: state.tasks.map((task) => (task.id === id ? { ...task, status, updatedAt } : task)),
    }));
    const task = get().tasks.find((item) => item.id === id);
    if (!task) return;
    void window.api?.db?.upsertTask({
      id: task.id,
      title: task.title,
      spaceId: task.spaceId,
      status,
      updatedAt,
    });
  },

  renameTask: (id, title) => {
    set((s) => ({
      tasks: s.tasks.map((x) => (x.id === id ? { ...x, title, updatedAt: Date.now() } : x)),
    }));
    const task = get().tasks.find((x) => x.id === id);
    if (task && (task.messages.length > 0 || task.sessionFile)) {
      void window.api?.db?.upsertTask({
        id: task.id,
        title,
        spaceId: task.spaceId,
        status: task.status,
        updatedAt: Date.now(),
      });
    }
  },

  toggleTaskSection: () => set((s) => ({ taskSectionCollapsed: !s.taskSectionCollapsed })),

  toggleSpaceCollapsed: (id) => {
    set((s) => {
      // 存储即「展开集合」：收起 = 从集合移除，展开 = 加入集合。
      // 默认（空集合）= 全部收起，所以新空间、新识别到的空间都从收起开始。
      const next = s.expandedSpaceIds.includes(id)
        ? s.expandedSpaceIds.filter((x) => x !== id)
        : [...s.expandedSpaceIds, id];
      saveSidebarExpanded(next);
      return { expandedSpaceIds: next };
    });
  },

  setAllSpacesExpanded: (expanded) => {
    set((s) => {
      const next = expanded ? s.spaces.map((space) => space.id) : [];
      saveSidebarExpanded(next);
      return { expandedSpaceIds: next };
    });
  },

  // 经 IPC 发给主进程 pi AgentService，并订阅 agent:event 流式补丁
  sendMessage: (text, attachments, taskReferences, streamingBehavior, connectorIds, explicitOverrides, externalAgent) => {
    let { activeTaskId } = get();
    let materializedPlanId: string | undefined;
    if (!activeTaskId) {
      // 草稿态（点「新建任务」/召唤专家后尚未发过消息）：此刻才创建任务并激活，
      // 随后按现有流程连同首条消息一起落库。未发消息的任务不会出现在列表/空间里。
      const state = get();
      materializedPlanId = state.draft?.planId;
      const task: Task = {
        id: uid(),
        title: state.draft?.title?.trim() || "新任务",
        spaceId: state.draft?.spaceId ?? undefined,
        projectId: state.draft?.projectId,
        updatedAt: Date.now(),
        messages: [],
        modelId: state.activeModelId,
        permissionMode: state.permissionMode,
        welcomeMode: state.welcomeMode,
        expertId: state.draft?.expertId,
        modePresetId: state.modePresetId ?? defaultModePresetId(state.welcomeMode),
        // 草稿期 pin 的 ACP Agent 随首条消息写入任务（任务级语义）
        externalAgentPin: state.draft?.externalAgentPin,
        // 草稿期挂载的 Active 连接器随首条消息写入任务（任务级语义）
        connectorIds: state.activeConnectorIds,
        // F2：materialize 继承当前（草稿期可能已显式选择的）标记
        modelExplicit: state.modelExplicit,
        permissionExplicit: state.permissionExplicit,
      };
      activeTaskId = task.id;
      set((s) => ({
        tasks: [task, ...s.tasks],
        activeTaskId: task.id,
        draft: null,
      }));
      // 新任务 materialize：hydrate 空 projection（快速 ready）
      void get().hydrateArtifacts(task.id);
    }

    const {
      tasks,
      models,
      activeModelId,
      modelExplicit,
      permissionMode,
      permissionExplicit,
      welcomeMode: defaultWelcomeMode,
    } = get();
    const task = tasks.find((x) => x.id === activeTaskId);
    if (!task) return;
    const welcomeMode = task.welcomeMode ?? defaultWelcomeMode;
    const isBot = task.welcomeMode === "bot";

    // ACP 路由：瞬态选择（+ 菜单/「继续」按钮）优先；任务级 pin 兜底并自动续接
    // 最近一个可恢复 run。「本轮新会话」= 不带 continueFromRunId 的同 agent 瞬态选择，
    // 走瞬态分支，pin 保持不变；新 run 随后自动成为续链新头。
    const pinnedAgent = task.externalAgentPin;
    const effectiveExternalAgent = isBot ? undefined : externalAgent
      ?? (pinnedAgent
        ? {
            id: pinnedAgent.id,
            name: pinnedAgent.name,
            protocol: "acp" as const,
            continueFromRunId: resolveExternalAgentContinuationRunId(task.messages, pinnedAgent.id),
          }
        : undefined);

    // 显式 vs 默认契约（P0）：用户显式选择过才作为 explicit 传主进程，否则 undefined，
    // 由主进程按 Tag 建议 → Mode 建议 → 系统默认链解析；createRelatedTask 等已解析场景
    // 通过 explicitOverrides 直接注入（等价于显式）。
    const reqModelId =
      explicitOverrides?.modelId !== undefined
        ? explicitOverrides.modelId
        : toRequestModelId({ explicit: modelExplicit, value: activeModelId });
    const reqPermissionMode =
      explicitOverrides?.permissionMode !== undefined
        ? explicitOverrides.permissionMode
        : toRequestPermissionMode({ explicit: permissionExplicit, value: permissionMode });

    // 「加入聊天」抓取元素：仅 pending 引用随本条消息发送；发送即消费（不无限复用）。
    // 实际内容由主进程 AgentService 发送时经 PromptContextService 解析（指纹不匹配不注入）。
    const pendingSelections = get().chatSelections.filter((item) => item.status === "pending");
    const selectionRefs = pendingSelections.map((item) => ({
      comment: normalizeSelectionComment(item.comment),
      artifactId: item.artifactId,
      artifactVersion: item.artifactVersion,
      surfaceGeneration: item.surfaceGeneration,
      backendNodeId: item.backendNodeId,
    }));
    // 气泡摘要在清空 pending 前先落下来，否则发送后引用芯片会消失
    const selectionLabelsForBubble = pendingSelections
      .map((item) => item.comment ? `${item.label.trim()}：${item.comment}` : item.label.trim())
      .filter(Boolean);
    set({ chatSelections: [] });

    // 「终端 → 加入对话」：显式附加上下文随本条消息发送，发送即消费（不无限复用）
    const terminalCtx = get().terminalContext;
    const terminalForBubble = terminalCtx?.text?.trim()
      ? {
          source: terminalCtx.source,
          charCount: terminalCtx.text.length,
          preview: terminalCtx.text.slice(0, 240),
        }
      : undefined;
    set({ terminalContext: null });

    const userMsgId = uid();
    const assistantMsgId = uid();
    const atts = (attachments ?? []).filter((a) => a.name);
    const referencedPaths = new Set(
      (taskReferences ?? [])
        .flatMap((reference) => reference.files ?? [])
        .map((file) => file.path?.toLowerCase())
        .filter((path): path is string => Boolean(path)),
    );
    const displayAttachments = atts.filter(
      (attachment) => !attachment.path || !referencedPaths.has(attachment.path.toLowerCase()),
    );
    // 气泡正文只存说明文字；技能/MCP/连接器以前缀芯片展示（不再「发送即消失」）
    const {
      display: visibleText,
      skillNames,
      mcpNames,
      connectorNames,
    } = userVisiblePromptText(text);
    // 专家：仅首次挂载或切换时贴气泡芯片（同专家后续消息不重复）
    const expertIdSnap = task.expertId?.trim() || get().draft?.expertId?.trim() || "";
    const prevAnnounced = task.lastAnnouncedExpertId?.trim() || "";
    let expertForBubble: ChatMessage["expert"];
    if (expertIdSnap && expertIdSnap !== prevAnnounced) {
      const { experts } = get();
      const expertHit = experts.find((e) => e.id === expertIdSnap);
      expertForBubble = {
        id: expertIdSnap,
        name: expertHit?.name?.trim() || expertIdSnap,
        emoji: expertHit?.emoji?.trim() || undefined,
      };
    }
    const nextAnnouncedExpertId = expertIdSnap || undefined;
    const userMsg: ChatMessage = {
      id: userMsgId,
      role: "user",
      createdAt: Date.now(),
      blocks: [{ type: "text", text: visibleText }],
      attachments: displayAttachments.length ? displayAttachments : undefined,
      taskReferences: taskReferences?.length ? taskReferences : undefined,
      terminalContext: terminalForBubble,
      selectionLabels: selectionLabelsForBubble.length ? selectionLabelsForBubble : undefined,
      skillCommands: skillNames.length ? skillNames : undefined,
      mcpNames: mcpNames.length ? mcpNames : undefined,
      connectorNames: connectorNames.length ? connectorNames : undefined,
      expert: expertForBubble,
    };
    const reply: ChatMessage = {
      id: assistantMsgId,
      role: "assistant",
      createdAt: Date.now(),
      modelName: effectiveExternalAgent ? `${effectiveExternalAgent.name} · ACP` : models.find((m) => m.id === activeModelId)?.name,
      externalAgent: effectiveExternalAgent ? { ...effectiveExternalAgent } : undefined,
      blocks: [],
      finalBlocks: [],
      streaming: true,
      pendingBehavior: streamingBehavior,
    };

    const isFirstMessage = task.messages.length === 0;
    // P0 冻结：任务归属仅由 task.spaceId 决定，不吃 homeSpaceId。
    // 独立任务（spaceId=null/undefined）始终保持独立，已有对话不因首页选择器被误挂。
    const spaceId = task.spaceId ?? undefined;
    // P0：任务执行目录由主进程按 taskId 解析（canonical task root），
    // Renderer 不再从 space.path 推导 cwd，也不把 space path 写入 task.cwd。

    set((s) => ({
      tasks: s.tasks.map((x) =>
        x.id === activeTaskId
          ? {
              ...x,
              title: isFirstMessage ? taskTitleFromFirstMessage(text) : x.title,
              // 仅在任务尚无绑定时写入；已有 spaceId 或已有对话的独立任务不改
              spaceId: x.spaceId ?? spaceId,
              // 同步「已公告专家」：有专家则记下，无则清空（取消后再次引用可再贴）
              lastAnnouncedExpertId: nextAnnouncedExpertId,
              updatedAt: Date.now(),
              messages: isBot ? x.messages : [...x.messages, userMsg, reply],
              ...(isBot ? { botInputError: undefined, botPendingSubmission: { id: userMsgId, text: visibleText, attachmentNames: displayAttachments.map(a => a.name) } } : {}),
            }
          : x,
      ),
    }));

    let taskPersistence: Promise<unknown> | undefined;
    const updated = get().tasks.find((x) => x.id === activeTaskId);
    if (updated) {
      const persisted = window.api?.db?.upsertTask({
        id: updated.id,
        title: updated.title,
        spaceId: updated.spaceId,
        projectId: updated.projectId,
        status: updated.status,
        updatedAt: updated.updatedAt,
        sessionFile: updated.sessionFile,
        modelId: activeModelId,
        permissionMode,
        welcomeMode,
        expertId: updated.expertId,
        modePresetId: updated.modePresetId,
        // undefined → 保留 DB 值：发送途中的 unpin 不会被本次 upsert 盖回
        externalAgentPin: updated.externalAgentPin,
      });
      taskPersistence = persisted;
      if (materializedPlanId && persisted) {
        void persisted
          .then(async () => {
            const result = await window.api?.workgraph?.addEdge?.({
              fromType: "plan",
              fromId: materializedPlanId!,
              relation: "CONTAINS",
              toType: "task",
              toId: updated.id,
            });
            if (result && !result.ok) console.warn("[ProjectPlan] failed to link task", result.error);
          })
          .catch((cause) => console.warn("[ProjectPlan] failed to persist/link task", cause));
      }
    }

    const api = window.api;
    if (effectiveExternalAgent) {
      const externalApi = api?.externalAgent;
      if (!externalApi) {
        get().applyAgentPatch({
          type: "assistant_end",
          taskId: activeTaskId,
          messageId: assistantMsgId,
          error: "（External Agent ACP API 未就绪，请完全退出并重启 MyBuddy）",
        });
        return;
      }
      void externalApi.prompt({
        taskId: activeTaskId,
        agentId: effectiveExternalAgent.id,
        text,
        displayText: visibleText,
        userMessageId: userMsgId,
        assistantMessageId: assistantMsgId,
        continueFromRunId: effectiveExternalAgent.continueFromRunId,
        attachments: atts
          .filter((a): a is Attachment & { path: string } => Boolean(a.path))
          .map((a) => ({ name: a.name, path: a.path })),
      }).then((result) => {
        set((state) => ({
          tasks: state.tasks.map((item) =>
            item.id !== activeTaskId
              ? item
              : {
                  ...item,
                  messages: item.messages.map((message) =>
                    message.id === assistantMsgId && message.externalAgent
                      ? { ...message, externalAgent: { ...message.externalAgent, runId: result.runId } }
                      : message,
                  ),
                },
          ),
        }));
      }).catch((err: unknown) => {
        get().applyAgentPatch({
          type: "assistant_end",
          taskId: activeTaskId,
          messageId: assistantMsgId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      return;
    }
    if (!api?.agent) {
      if (isBot) {
        set(state => ({ tasks: state.tasks.map(item => item.id === activeTaskId ? { ...item, botInputError: "主进程 Agent API 未就绪", botPendingSubmission: undefined } : item) }));
        return;
      }
      get().applyAgentPatch({
        type: "text_delta",
        taskId: activeTaskId,
        messageId: assistantMsgId,
        delta: "（主进程 Agent API 未就绪）",
        final: true,
      });
      get().applyAgentPatch({
        type: "assistant_end",
        taskId: activeTaskId,
        messageId: assistantMsgId,
      });
      return;
    }

    return Promise.resolve(taskPersistence)
      .then(() => api.agent.prompt({
        taskId: activeTaskId,
        text,
        modelId: reqModelId,
        permissionMode: reqPermissionMode,
        welcomeMode,
        spaceId,
        sessionFile: task.sessionFile,
        assistantMessageId: assistantMsgId,
        userMessageId: userMsgId,
        streamingBehavior,
        expertId: task.expertId,
        attachments: atts
          .filter((a): a is Attachment & { path: string } => Boolean(a.path))
          .map((a) => ({ name: a.name, path: a.path })),
        selections: selectionRefs.length ? selectionRefs : undefined,
        terminalContext: terminalCtx ?? undefined,
        modePresetId: task.modePresetId,
        // 任务级 Active 连接器（与 task.connectorIds 同步；主进程据此装配私有技能并在变更时重建会话）
        connectorIds: connectorIds ?? task.connectorIds,
      }))
      .then(async (result) => {
        // 主进程明确拒绝（如会话仍在生成但未指定 streamingBehavior）：给出用户可见错误，
        // 不静默吞掉。仅当本地确已插入空 assistant 壳时才以 error 结束它（诚实暴露失败）。
        if (result?.error) {
          if (isBot) {
            set(state => ({ tasks: state.tasks.map(item => item.id === activeTaskId ? { ...item, botInputError: result.error!.message } : item) }));
            return;
          }
          const currentTask = get().tasks.find((item) => item.id === activeTaskId);
          const replyStillStreaming = currentTask?.messages.some(
            (message) => message.id === assistantMsgId && message.streaming,
          );
          if (replyStillStreaming) {
            get().applyAgentPatch({
              type: "assistant_end",
              taskId: activeTaskId,
              messageId: assistantMsgId,
              error: result.error.message,
            });
          }
          return;
        }
        // 普通 prompt 的 Promise 在整轮结束后返回，可作为漏失 agent_end 的兜底；
        // steer/followUp 的 Promise 只表示“已入队”，绝不能据此结束 UI 流式态。
        // result 为空兼容热更新期间尚未重启的旧主进程；流式投递按 queued 处理更安全。
        const queued = result?.queued ?? Boolean(streamingBehavior);
        if (!queued) {
          const currentTask = get().tasks.find((item) => item.id === activeTaskId);
          const replyStillStreaming = currentTask?.messages.some(
            (message) => message.id === assistantMsgId && message.streaming,
          );
          if (replyStillStreaming) {
            get().applyAgentPatch({
              type: "assistant_end",
              taskId: activeTaskId,
              messageId: assistantMsgId,
            });
          }
        }
        // 同步主进程写入的 sessionFile / 权威 cwd（P0：主进程回读，Renderer 不决定目录）
        const rows = await api.db?.listTasks?.();
        const row = rows?.find((t) => t.id === activeTaskId);
        if (!row) return;
        set((s) => {
          // P1：以主进程落库的生效值回同步（重启后建议链/重启兜底可能改变任务实际模型/权限），
          // 保证 UI 显示值与真实 session 一致。
          // P3-1：守卫读取【目标任务自身】的 explicit flag（而非当前活跃任务 state）——
          // 轮次内切任务、目标任务被显式改选时不会被旧 row 回退；其它任务的显式状态不影响 T。
          return {
            tasks: s.tasks.map((t) =>
              t.id === activeTaskId
                ? {
                    ...t,
                    sessionFile: row.sessionFile ?? t.sessionFile,
                    cwd: row.cwd ?? t.cwd,
                    ...(t.modelExplicit === true
                      ? {}
                      : { modelId: row.modelId ?? t.modelId }),
                    ...(t.permissionExplicit === true
                      ? {}
                      : { permissionMode: row.permissionMode ?? t.permissionMode }),
                  }
                : t,
            ),
          };
        });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (isBot) {
          set(state => ({ tasks: state.tasks.map(item => item.id === activeTaskId ? { ...item, botInputError: message } : item) }));
          return;
        }
        get().applyAgentPatch({
          type: "assistant_end",
          taskId: activeTaskId,
          messageId: assistantMsgId,
          error: message,
        });
      })
      .finally(() => {
        if (isBot) set(state => ({ tasks: state.tasks.map(item => item.id === activeTaskId && item.botPendingSubmission?.id === userMsgId
          ? { ...item, botPendingSubmission: undefined } : item) }));
      });
  },

  deleteUserMessage: async (messageId) => {
    const { activeTaskId } = get();
    if (!activeTaskId) return;
    const task = get().tasks.find((item) => item.id === activeTaskId);
    if (!task) return;
    const messageIndex = task.messages.findIndex((message) => message.id === messageId);
    if (messageIndex < 0 || task.messages[messageIndex]?.role !== "user") return;
    const targetEntryId = task.messages[messageIndex].entryId;
    const userMessageIndex = task.messages
      .slice(0, messageIndex + 1)
      .filter((message) => message.role === "user").length - 1;
    if (userMessageIndex < 0) return;

    // 任务仍在执行时主进程会拒绝删除。与安卓端「停止并删除」对齐：先停止当前运行，
    // 再短暂重试（abort 收尾是异步的），避免删除入口在长任务上变成死胡同。
    if (hasActiveExecutionMessages(task.messages) || task.status === "in_progress") {
      await get().abortActiveTask().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 600));
    }

    const api = window.api?.agent;
    if (api?.deleteUserMessage) {
      let lastError: unknown;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          await api.deleteUserMessage({ taskId: activeTaskId, userMessageIndex, entryId: targetEntryId });
          lastError = undefined;
          break;
        } catch (cause) {
          lastError = cause;
          const text = cause instanceof Error ? cause.message : String(cause);
          if (!/执行|停止|busy|conflict/i.test(text)) throw cause;
          await get().abortActiveTask().catch(() => undefined);
          await new Promise((resolve) => setTimeout(resolve, 700));
        }
      }
      if (lastError) throw lastError;
    }

    const remaining = task.messages.slice(0, messageIndex);
    const nextStatus = remaining.length === 0 ? "pending" : "completed";
    set((state) => ({
      tasks: state.tasks.map((item) =>
        item.id === activeTaskId
          ? { ...item, messages: remaining, status: nextStatus, updatedAt: Date.now() }
          : item,
      ),
      selectedMessageIds: state.selectedMessageIds.filter((id) => remaining.some((message) => message.id === id)),
    }));
  },

  regenerateMessage: (messageId) => {
    const { activeTaskId } = get();
    if (!activeTaskId) return;
    const task = get().tasks.find((t) => t.id === activeTaskId);
    if (!task) return;

    const idx = task.messages.findIndex((m) => m.id === messageId);
    const sourceAssistant = task.messages[idx];
    if (!sourceAssistant || sourceAssistant.role !== "assistant") return;
    // 两阶段提交只允许对已终结的助手回复执行；源消息自身仍 streaming 时不在此路径进入。
    if (sourceAssistant.streaming) return;

    // 目标消息之后仍有消息在流式生成 → 不可重新生成（避免与正跑执行争夺叶子）
    if (task.messages.some((m, i) => i > idx && m.streaming)) return;

    // 定位被重生成的源用户消息 + 它在会话中的 0-based 用户序号
    let userIdx = idx - 1;
    while (userIdx >= 0 && task.messages[userIdx]?.role !== "user") userIdx -= 1;
    const sourceUser = userIdx >= 0 ? task.messages[userIdx] : undefined;
    if (!sourceUser) return;
    // 与主进程 SDK getUserMessagesForForking() 对齐：只统计「有正文文本」的用户消息。
    // SDK 侧过滤 text 非空的 user entry（contentText join 后非空），若 UI 侧把无文本
    // 用户消息（纯附件等）也计入序号，两边索引错位 → 静默 TARGET_NOT_FOUND。
    const hasForkableUserText = (m: ChatMessage): boolean =>
      (m.blocks ?? [])
        .filter((b) => b.type === "text")
        .map((b) => ("text" in b ? b.text ?? "" : ""))
        .join("\n") !== "";
    if (!hasForkableUserText(sourceUser)) return;
    const userMessageIndex =
      task.messages
        .slice(0, userIdx + 1)
        .filter((m) => m.role === "user" && hasForkableUserText(m)).length - 1;
    if (userMessageIndex < 0) return;

    // pending 去重：同一源助手消息已在重试中 → 忽略本次点击
    const alreadyPending = Object.values(get().pendingRegenerations).some(
      (p) => p.taskId === activeTaskId && p.sourceAssistantMessageId === messageId,
    );
    if (alreadyPending) return;

    const {
      models,
      activeModelId,
      modelExplicit,
      permissionMode,
      permissionExplicit,
      welcomeMode: defaultWelcomeMode,
    } = get();
    const welcomeMode = task.welcomeMode ?? defaultWelcomeMode;
    const newAssistantMsgId = uid();
    const requestId = uid();

    // 两阶段 Phase A：不截断、不插空壳；只登记 pending + 清源消息旧错误标记。
    // 原助手回复在 assistant_start 到达前始终保持完整。
    set((s) => ({
      pendingRegenerations: {
        ...s.pendingRegenerations,
        [newAssistantMsgId]: {
          requestId,
          taskId: activeTaskId,
          sourceAssistantMessageId: messageId,
          sourceUserMessageId: sourceUser.id,
          userMessageIndex,
          newAssistantMessageId: newAssistantMsgId,
          startedAt: Date.now(),
        },
      },
      tasks: s.tasks.map((t) =>
        t.id === activeTaskId
          ? {
              ...t,
              messages: t.messages.map((m) =>
                m.id === messageId ? { ...m, generateError: undefined } : m,
              ),
            }
          : t,
      ),
    }));

    const api = window.api;
    const failPending = (message: string): void => {
      const pending = get().pendingRegenerations[newAssistantMsgId];
      if (!pending) return;
      const { [newAssistantMsgId]: _drop, ...rest } = get().pendingRegenerations;
      set((s) => ({
        pendingRegenerations: rest,
        // 旧消息完整保留，仅在源助手消息上挂用户可见错误
        tasks: s.tasks.map((t) =>
          t.id === pending.taskId
            ? {
                ...t,
                messages: t.messages.map((m) =>
                  m.id === pending.sourceAssistantMessageId
                    ? { ...m, generateError: message }
                    : m,
                ),
              }
            : t,
        ),
      }));
    };

    if (!api?.agent?.regenerate) {
      failPending("（主进程 Agent API 未就绪，重新生成失败，原回复已保留）");
      return;
    }

    // 源用户消息文本指纹（drift 校验：主进程定位到的 editorText 应一致）
    const sourceUserText = (sourceUser.blocks ?? [])
      .filter((b) => b.type === "text")
      .map((b) => ("text" in b ? b.text ?? "" : ""))
      .join(" ");

    // 重新生成不改空间归属：只用任务自身 spaceId（不用 homeSpaceId 兜底）
    const spaceId = task.spaceId ?? undefined;
    void api.agent
      .regenerate({
        taskId: activeTaskId,
        requestId,
        userMessageIndex,
        assistantMessageId: newAssistantMsgId,
        sourceAssistantMessageId: messageId,
        sourceUserMessageId: sourceUser.id,
        sourceUserEntryId: sourceUser.entryId,
        expectedUserTextHash: normalizedEditorTextHash(sourceUserText),
        modelId: toRequestModelId({ explicit: modelExplicit, value: activeModelId }),
        permissionMode: toRequestPermissionMode({
          explicit: permissionExplicit,
          value: permissionMode,
        }),
        welcomeMode,
        spaceId,
        expertId: task.expertId,
        modePresetId: task.modePresetId,
        // 任务级 Active 连接器：会话重建时私有技能保持一致
        connectorIds: task.connectorIds,
      })
      .then((result: AgentRegenerateResult | undefined) => {
        // 主进程明确失败（含 navigate cancelled 等）：旧消息保留 + 用户可见错误
        if (result && !result.ok) {
          // 附上失败 code（NAVIGATION_CANCELLED / TARGET_DRIFTED / …），
          // tooltip 可显示具体原因，便于定位与反馈。
          failPending(`[${result.code}] ${result.message || "重新生成失败，原回复已保留。"}`);
          return;
        }
        if (result?.ok && result.userEntryId) {
          set((s) => ({ tasks: s.tasks.map((t) =>
            t.id === activeTaskId && t.messages.some((m) => m.id === newAssistantMsgId)
              ? { ...t, messages: t.messages.map((m) => m.id === sourceUser.id ? { ...m, entryId: result.userEntryId } : m) }
              : t,
          ) }));
        }
        // regenerate IPC 在 prompt 结束后才返回；正常的 assistant_start 已先完成 commit。
        // 若仍 pending，说明本次没有启动回复，不能永久占住去重锁。
        failPending("重新生成未启动，原回复已保留，请重试。");
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn("[appStore] regenerate IPC failed", err);
        failPending(message || "重新生成失败，原回复已保留。");
      });
  },

  abortActiveTask: async () => {
    const taskId = get().activeTaskId;
    if (!taskId) return;
    if (get().tasks.find(task => task.id === taskId)?.welcomeMode === "bot") {
      await window.api?.agent?.abort?.(taskId);
      const history = await window.api?.agent?.loadTaskHistory?.(taskId);
      if (history?.durable) get().applyAgentPatch({ type: "durable_snapshot", taskId, snapshot: history.durable });
      return;
    }

    // 先本地结束流式，避免按钮卡在「停止」态
    set((s) => ({
      tasks: s.tasks.map((task) => {
        if (task.id !== taskId) return task;
        let changed = false;
        const messages = task.messages.map((msg) => {
          if (!msg.streaming) return msg;
          changed = true;
          return {
            ...msg,
            streaming: false,
            durationLabel: msg.durationLabel ?? "已停止",
            pendingBehavior: undefined,
          };
        });
        if (!changed && task.status !== "in_progress") return task;
        return {
          ...task,
          messages,
          status: task.status === "in_progress" ? "completed" : task.status,
          updatedAt: Date.now(),
        };
      }),
    }));

    await window.api?.agent?.abort?.(taskId).catch(() => {
      /* 主进程已结束时忽略 */
    });
    await window.api?.externalAgent?.cancel?.(undefined, taskId).catch(() => {
      /* 无运行中的 ACP Agent 时忽略 */
    });
  },

  resolveToolApproval: (messageId, toolCallId, approved, externalWrite) => {
    const { activeTaskId } = get();
    if (!activeTaskId) return;

    const status: ToolStatus = approved ? "running" : "denied";
    set((s) => ({
      tasks: s.tasks.map((task) => ({
        ...task,
        messages: task.messages.map((msg) =>
          msg.id !== messageId
            ? msg
            : {
                ...msg,
                blocks: msg.blocks.map((b) =>
                  b.type === "tool" && b.toolCall.id === toolCallId
                    ? {
                        ...b,
                        toolCall: {
                          ...b.toolCall,
                          status,
                          output: approved ? undefined : "用户已拒绝",
                        },
                      }
                    : b,
                ),
                ...(approved
                  ? {}
                  : {
                      streaming: false,
                      finalBlocks: [
                        ...(msg.finalBlocks ?? []),
                        { type: "text" as const, text: "好的，已取消该操作。" },
                      ],
                    }),
              },
        ),
      })),
    }));

    void window.api?.agent?.approveTool({
      taskId: activeTaskId,
      toolCallId,
      approved,
      ...(externalWrite ? { externalWrite } : {}),
    });
  },

  setSkillEnabled: (id, enabled) => {
    set((s) => ({
      skills: s.skills.map((x) => (x.id === id ? { ...x, enabled } : x)),
    }));
    void window.api?.agent?.setSkillEnabled?.(id, enabled).then(() => {
      void get().refreshSkills();
    }).catch((err) => console.warn("[setSkillEnabled]", err));
  },

  installSkill: async (id) => {
    const agentApi = window.api?.agent;
    const fn = agentApi?.installSkill;
    if (!fn || !agentApi) throw new Error("安装技能 API 不可用，请完全退出并重启应用");
    const clean = id.trim();
    if (!clean) throw new Error("技能 id 为空");
    await fn.call(agentApi, clean);
    await get().refreshSkills();
  },

  installSkillByPath: async (path) => {
    const agentApi = window.api?.agent;
    const fn = agentApi?.installSkillByPath;
    if (!fn || !agentApi) throw new Error("从文件夹导入技能 API 不可用，请完全退出并重启应用");
    const clean = path.trim();
    if (!clean) throw new Error("请选择有效的本地技能目录（需含 SKILL.md）");
    const dto = await fn.call(agentApi, clean);
    await get().refreshSkills();
    if (!dto) return null;
    const fromList = get().skills.find((s) => s.id === dto.id || s.name === dto.name);
    return (
      fromList ?? {
        id: dto.id,
        name: dto.name,
        description: dto.description,
        author: dto.author,
        icon: dto.icon,
        installed: dto.installed,
        enabled: dto.enabled,
        builtin: dto.builtin,
        command: dto.command,
        filePath: dto.filePath,
      }
    );
  },

  uninstallSkill: async (id) => {
    const agentApi = window.api?.agent;
    const fn = agentApi?.uninstallSkill;
    if (!fn || !agentApi) throw new Error("卸载技能 API 不可用，请完全退出并重启应用");
    const clean = id.trim();
    if (!clean) throw new Error("技能 id 为空");
    await fn.call(agentApi, clean);
    await get().refreshSkills();
  },

  deleteMarketSkill: async (id) => {
    const fn = window.api?.agent?.deleteMarketSkill;
    if (!fn) {
      throw new Error("删除市场技能 API 不可用，请完全退出并重启应用");
    }
    await fn.call(window.api?.agent, id);
    await get().refreshSkills();
  },

  refreshExperts: async () => {
    const api = window.api?.agent;
    if (!api) return;
    const [expertRows, marketRows] = await Promise.all([
      api.listExperts?.() ?? Promise.resolve([]),
      api.listMarketExperts?.() ?? Promise.resolve([]),
    ]);
    set({
      experts: expertRows.map((e) => ({ ...e, installed: true })),
      marketExperts: marketRows.map((e) => ({ ...e, installed: false, enabled: false })),
    });
  },

  refreshTaskExpertBinding: async (taskId) => {
    const api = window.api?.agent;
    if (!api?.getTaskExpertBinding) throw new Error("专家绑定 API 不可用，请重启更新后的应用");
    const task = get().tasks.find(item => item.id === taskId);
    const persisted = await window.api?.db?.listTasks?.();
    if (task && !persisted?.some(item => item.id === taskId)) await window.api?.db?.upsertTask?.({ id: task.id, title: task.title, updatedAt: task.updatedAt,
      spaceId: task.spaceId, projectId: task.projectId, welcomeMode: task.welcomeMode, cwd: task.cwd, expertId: task.expertId });
    const binding = await api.getTaskExpertBinding(taskId);
    set(state => ({ tasks: state.tasks.map(task => task.id === taskId
      ? { ...task, expertBinding: binding, expertId: binding.desired?.sourceExpertId } : task) }));
    return binding;
  },

  saveTaskExpertBinding: async (input) => {
    const api = window.api?.agent;
    if (!api?.saveTaskExpertBinding) throw new Error("专家绑定 API 不可用，请重启更新后的应用");
    const task = get().tasks.find(item => item.id === input.taskId);
    if (!task) throw new Error("任务不存在");
    // Some sidebar tasks have not sent their first message yet; materialize before binding.
    const persisted = await window.api?.db?.listTasks?.();
    if (!persisted?.some(item => item.id === input.taskId)) await window.api?.db?.upsertTask?.({ id: task.id, title: task.title, updatedAt: task.updatedAt,
      spaceId: task.spaceId, projectId: task.projectId, welcomeMode: task.welcomeMode,
      cwd: task.cwd, expertId: task.expertId });
    const binding = await api.saveTaskExpertBinding(input);
    set(state => ({ tasks: state.tasks.map(item => item.id === input.taskId
      ? { ...item, expertBinding: binding, expertId: binding.desired?.sourceExpertId,
          ...(binding.desired ? {} : { lastAnnouncedExpertId: undefined }) } : item) }));
    return binding;
  },

  installExpert: async (id) => {
    const agentApi = window.api?.agent;
    const fn = agentApi?.installExpert;
    if (!fn || !agentApi) throw new Error("安装专家 API 不可用，请完全退出并重启应用");
    await fn.call(agentApi, id);
    await get().refreshExperts();
  },

  installExpertByPath: async (path) => {
    const agentApi = window.api?.agent;
    const fn = agentApi?.installExpertByPath;
    if (!fn || !agentApi) throw new Error("从文件夹导入 API 不可用，请完全退出并重启应用");
    const clean = path.trim();
    if (!clean) throw new Error("请选择有效的本地文件夹路径");
    const dto = await fn.call(agentApi, clean);
    await get().refreshExperts();
    if (!dto) return null;
    const fromList = get().experts.find((e) => e.id === dto.id || e.name === dto.name);
    return fromList ?? { ...dto, installed: true };
  },

  importExpertZip: async (zipPath) => {
    const agentApi = window.api?.agent;
    const fn = agentApi?.importExpertZip;
    if (!fn || !agentApi) throw new Error("导入 ZIP API 不可用，请完全退出并重启应用");
    const clean = zipPath.trim();
    if (!clean) throw new Error("请选择有效的 ZIP 文件");
    if (!clean.toLowerCase().endsWith(".zip")) throw new Error("仅支持 .zip 专家包，请选择 ZIP 文件");
    const dto = await fn.call(agentApi, clean);
    await get().refreshExperts();
    if (!dto) return null;
    const fromList = get().experts.find((e) => e.id === dto.id || e.name === dto.name);
    return fromList ?? { ...dto, installed: true };
  },

  uninstallExpert: async (id) => {
    const agentApi = window.api?.agent;
    const fn = agentApi?.uninstallExpert;
    if (!fn || !agentApi) throw new Error("卸载专家 API 不可用，请完全退出并重启应用");
    const clean = id.trim();
    if (!clean) throw new Error("专家 id 为空，无法卸载");
    await fn.call(agentApi, clean);
    await get().refreshExperts();
  },

  deleteMarketExpert: async (id) => {
    const fn = window.api?.agent?.deleteMarketExpert;
    if (!fn) {
      throw new Error("删除市场专家 API 不可用，请完全退出并重启应用");
    }
    await fn.call(window.api?.agent, id);
    await get().refreshExperts();
  },

  setExpertEnabled: (id, enabled) => {
    void window.api?.agent?.setExpertEnabled?.(id, enabled)
      .then(() => get().refreshExperts())
      .catch((err) => console.warn("[setExpertEnabled]", err));
  },

  summonExpert: (expertId, spaceId) => {
    if (!normalizeSingleExpertId(expertId)) return;
    // 只登记草稿、不建任务：首条消息发出时才 materialize 并落库，
    // 避免每次都产生一条空白「新任务」行。
    set({
      draft: { spaceId, expertId },
      activeTaskId: null,
      chatSelections: [],
      homeSpaceId: spaceId ?? null,
      page: "chat",
      panelOpen: false,
      artifactTabs: [],
      activeArtifactId: null,
      selectMode: false,
      selectedMessageIds: [],
      // F4：召唤新专家任务不继承上一任务的 Active 连接器（与 newTask/createRelatedTask 一致）
      activeConnectorIds: [],
      // F2：新任务不继承显式模型/权限标记
      modelExplicit: false,
      permissionExplicit: false,
    });
  },

  switchExpert: (expertId) => {
    const next = expertId == null ? null : normalizeSingleExpertId(expertId) ?? null;
    if (expertId != null && !next) return;
    const taskId = get().activeTaskId;
    if (!taskId) {
      // 草稿态（任务未落库）：记入 draft，首条消息 materialize 时随任务生效。
      // 无 draft 时也要创建，否则「只选专家再发送」会丢 expertId。
      set((s) => ({
        draft: s.draft
          ? { ...s.draft, expertId: next ?? undefined }
          : next
            ? { expertId: next }
            : null,
      }));
      return;
    }
    void get().saveTaskExpertBinding({ taskId, expertId: next })
      .catch(error => {
        console.error("[switchExpert]", error);
        set(state => ({ tasks: state.tasks.map(task => task.id === taskId
          ? { ...task, botInputError: error instanceof Error ? error.message : String(error) } : task) }));
      });
  },

  setExternalAgentPin: (pin) => {
    const taskId = get().activeTaskId;
    if (!taskId) {
      // 草稿态：记入 draft，首条消息 materialize 时随任务落库（与 expertId 同路径）。
      set((s) => ({
        draft: s.draft
          ? { ...s.draft, externalAgentPin: pin ?? undefined }
          : pin
            ? { externalAgentPin: pin }
            : null,
      }));
      return;
    }
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === taskId ? { ...t, externalAgentPin: pin ?? undefined } : t,
      ),
    }));
    const task = get().tasks.find((t) => t.id === taskId);
    if (!task) return;
    void window.api?.db?.upsertTask?.({
      id: taskId,
      title: task.title,
      updatedAt: Date.now(),
      externalAgentPin: pin,
    });
  },

  refreshConnectors: async () => {
    const rows = await window.api?.agent?.listConnectors?.() ?? [];
    set({ connectors: rows });
  },

  refreshProjects: async (includeArchived = false) => {
    const projects = (await window.api?.db?.listProjects?.(includeArchived)) ?? [];
    set({ projects });
  },

  bindProjectContext: (taskId, projectId) => {
    const task = get().tasks.find((item) => item.id === taskId);
    if (!task) return;
    const updatedAt = Date.now();
    set((state) => ({
      tasks: state.tasks.map((item) =>
        item.id === taskId ? { ...item, projectId: projectId ?? undefined, updatedAt } : item,
      ),
    }));
    void window.api?.db?.upsertTask?.({
      id: task.id,
      title: task.title,
      updatedAt,
      projectId,
    });
  },

  setDraftProject: (projectId) => {
    if (get().activeTaskId) return;
    set((state) => ({
      draft: projectId
        ? { ...(state.draft ?? {}), projectId }
        : state.draft
          ? { ...state.draft, projectId: undefined }
          : null,
    }));
  },

  installConnector: async (id) => {
    const agentApi = window.api?.agent;
    const fn = agentApi?.installConnector;
    if (!fn || !agentApi) throw new Error("安装连接器 API 不可用，请完全退出并重启应用");
    const clean = id.trim();
    if (!clean) throw new Error("连接器 id 为空");
    const names = (await fn.call(agentApi, clean)) ?? [];
    await get().refreshConnectors();
    await get().refreshSkills();
    return names;
  },

  importConnectorByPath: async (path) => {
    const agentApi = window.api?.agent;
    const fn = agentApi?.importConnectorByPath;
    if (!fn || !agentApi) throw new Error("连接器目录导入 API 不可用，请完全退出并重启应用");
    const dto = await fn.call(agentApi, path);
    await get().refreshConnectors();
    await get().refreshSkills();
    return dto;
  },

  importConnectorZip: async (zipPath) => {
    const agentApi = window.api?.agent;
    const fn = agentApi?.importConnectorZip;
    if (!fn || !agentApi) throw new Error("连接器 ZIP 导入 API 不可用，请完全退出并重启应用");
    const dto = await fn.call(agentApi, zipPath);
    await get().refreshConnectors();
    await get().refreshSkills();
    return dto;
  },

  uninstallConnector: async (id) => {
    const agentApi = window.api?.agent;
    const fn = agentApi?.uninstallConnector;
    if (!fn || !agentApi) throw new Error("卸载连接器 API 不可用，请完全退出并重启应用");
    const clean = id.trim();
    if (!clean) throw new Error("连接器 id 为空");
    await fn.call(agentApi, clean);
    await get().refreshConnectors();
    await get().refreshSkills();
  },

  deleteMarketConnector: async (id) => {
    const fn = window.api?.agent?.deleteMarketConnector;
    if (!fn) {
      throw new Error("删除市场连接器 API 不可用，请完全退出并重启应用");
    }
    await fn.call(window.api?.agent, id);
    await get().refreshConnectors();
    await get().refreshSkills();
  },

  setConnectorEnabled: async (id, enabled) => {
    const agentApi = window.api?.agent;
    const fn = agentApi?.setConnectorEnabled;
    if (!fn || !agentApi) throw new Error("启停连接器 API 不可用，请完全退出并重启应用");
    const clean = id.trim();
    if (!clean) throw new Error("连接器 id 为空");
    await fn.call(agentApi, clean, enabled);
    await get().refreshConnectors();
  },

  /**
   * 设置当前任务/草稿的 Active 连接器集合（任务级语义）。
   * 有任务时同步写入 task.connectorIds；草稿态存入全局待命值，随首条消息写入新任务。
   * 主进程会在下次 prompt 检测到连接器集合变化时重建会话（统一装配，私有技能/MCP 一致）。
   */
  setActiveConnectors: (ids) => {
    const taskId = get().activeTaskId;
    const next = [...new Set(ids.map((x) => String(x).trim()).filter(Boolean))];
    set((s) => ({
      activeConnectorIds: next,
      tasks: taskId
        ? s.tasks.map((t) => (t.id === taskId ? { ...t, connectorIds: next } : t))
        : s.tasks,
    }));
    // F3：任务级 Active 连接器持久化（settings.json，无新 DB schema）；重启后恢复
    if (taskId) void window.api?.agent?.setTaskConnectorIds?.(taskId, next);
  },

  setActiveModel: (id) => {
    const model = get().models.find((m) => m.id === id && m.enabled !== false);
    if (!model) return;
    const taskId = get().activeTaskId;
    set((s) => ({
      activeModelId: id,
      defaultModelId: id,
      // F2：显式选择只在当前任务内生效（任务级标记，不跨任务泄漏）
      modelExplicit: true,
      contextWindowTokens: model?.contextWindow || get().contextWindowTokens,
      tasks: taskId
        ? s.tasks.map((task) =>
            task.id === taskId ? { ...task, modelId: id, modelExplicit: true } : task,
          )
        : s.tasks,
    }));
    // 模型选择仍更新默认模型，但 reasoning preference 按 modelId 独立持久化。
    void window.api?.agent?.updateAppSettings?.({
      defaultModelId: id,
    });
    const task = taskId ? get().tasks.find((item) => item.id === taskId) : undefined;
    if (task && (task.messages.length > 0 || task.sessionFile)) {
      void window.api?.db?.upsertTask({
        id: task.id,
        title: task.title,
        updatedAt: Date.now(),
        modelId: id,
      });
    }
  },

  /**
   * F2：复位为「跟随场景建议」——清除本任务显式模型标记，并把当前值解析为
   * Tag > Mode 建议（建议可用时直接应用；不可用仅清标记，主进程回落默认）。
   * 不写全局 defaultModelId（跟随建议 ≠ 用户偏好）。
   */
  followSuggestedModel: async () => {
    const { activeTaskId, welcomeMode, modePresetId } = get();
    const task = activeTaskId ? get().tasks.find((t) => t.id === activeTaskId) : undefined;
    let resolved: string | null = null;
    try {
      const profile = await window.api?.agent?.getModeProfile?.(task?.welcomeMode ?? welcomeMode);
      const preset = profile
        ? resolveModePreset(profile.policy, task?.modePresetId ?? modePresetId ?? null)
        : undefined;
      const effective = profile ? resolveEffectiveModePolicy(profile.policy, preset) : null;
      const suggested = effective?.suggestedModelId ?? null;
      if (suggested && get().models.some((m) => m.id === suggested && m.enabled !== false)) resolved = suggested;
    } catch {
      /* 仅清标记；主进程回落默认 */
    }
    const targetId = resolved ?? get().activeModelId;
    const model = get().models.find((m) => m.id === targetId);
    set((s) => ({
      modelExplicit: false,
      activeModelId: targetId,
      contextWindowTokens: model?.contextWindow || s.contextWindowTokens,
      tasks: activeTaskId
        ? s.tasks.map((t) =>
            t.id === activeTaskId
              ? { ...t, modelExplicit: false, modelId: resolved ?? t.modelId }
              : t,
          )
        : s.tasks,
    }));
    if (resolved && activeTaskId) {
      const t = get().tasks.find((x) => x.id === activeTaskId);
      if (t && (t.messages.length > 0 || t.sessionFile)) {
        void window.api?.db?.upsertTask?.({
          id: t.id,
          title: t.title,
          updatedAt: Date.now(),
          modelId: resolved,
        });
      }
    }
  },

  /**
   * F2：复位为「跟随场景建议」——清除本任务显式权限标记，按 Tag > Mode 建议解析
   * （无建议则保持当前值由主进程按系统默认链处理）；已有会话立即应用解析值。
   */
  followSuggestedPermission: async () => {
    const { activeTaskId, welcomeMode, modePresetId } = get();
    const task = activeTaskId ? get().tasks.find((t) => t.id === activeTaskId) : undefined;
    let next: PermissionMode = get().permissionMode;
    try {
      const profile = await window.api?.agent?.getModeProfile?.(task?.welcomeMode ?? welcomeMode);
      const preset = profile
        ? resolveModePreset(profile.policy, task?.modePresetId ?? modePresetId ?? null)
        : undefined;
      const effective = profile ? resolveEffectiveModePolicy(profile.policy, preset) : null;
      const suggested = effective?.suggestedPermissionMode ?? null;
      if (suggested) next = suggested;
    } catch {
      /* 仅清标记 */
    }
    set((s) => ({
      permissionExplicit: false,
      permissionMode: next,
      fullAccessDuringRun: next === "auto",
      tasks: activeTaskId
        ? s.tasks.map((t) =>
            t.id === activeTaskId ? { ...t, permissionExplicit: false, permissionMode: next } : t,
          )
        : s.tasks,
    }));
    if (activeTaskId) {
      const t = get().tasks.find((x) => x.id === activeTaskId);
      if (t && (t.messages.length > 0 || t.sessionFile)) {
        void window.api?.db?.upsertTask?.({
          id: t.id,
          title: t.title,
          updatedAt: Date.now(),
          permissionMode: next,
        });
        // 已有会话立即应用（等价于显式切换；后续消息因标记已清不再发送 explicit）
        void window.api?.agent?.setPermissionMode?.({ taskId: activeTaskId, permissionMode: next });
      }
    }
  },
  setModelReasoningPreference: (modelId, preference) => {
    const id = modelId.trim();
    if (!id) return;
    const model = get().models.find((candidate) => candidate.id === id);
    const normalized = normalizeReasoningPreference(preference, model?.metadata);
    const previousPreferences = get().modelPreferences;
    const nextPreferences: ModelPreferencesDto = { ...previousPreferences };
    if (normalized) nextPreferences[id] = { reasoning: normalized };
    else delete nextPreferences[id];

    set({ modelPreferences: nextPreferences });
    void window.api?.agent?.updateAppSettings?.({ modelPreferences: nextPreferences }).then((settings) => {
      if (get().modelPreferences === nextPreferences) set({ modelPreferences: settings.modelPreferences ?? {} });
    }).catch((error) => {
      if (get().modelPreferences === nextPreferences) set({ modelPreferences: previousPreferences });
      console.error("保存 Pi 思考偏好失败", error);
    });
  },
  setPermissionMode: (mode) => {
    const taskId = get().activeTaskId;
    set((s) => ({
      permissionMode: mode,
      // F2：显式选择（含显式选 default）只在当前任务内生效（任务级标记）
      permissionExplicit: true,
      fullAccessDuringRun: mode === "auto",
      tasks: taskId
        ? s.tasks.map((task) =>
            task.id === taskId ? { ...task, permissionMode: mode, permissionExplicit: true } : task,
          )
        : s.tasks,
    }));
    void window.api?.agent?.updateAppSettings?.({ permissionMode: mode });
    if (taskId) {
      const task = get().tasks.find((item) => item.id === taskId);
      if (task && (task.messages.length > 0 || task.sessionFile)) {
        void window.api?.db?.upsertTask({
          id: task.id,
          title: task.title,
          updatedAt: Date.now(),
          permissionMode: mode,
        });
      }
      void window.api?.agent?.setPermissionMode?.({
        taskId,
        permissionMode: mode,
      });
    }
  },
  setStreamingSendMode: (mode) => {
    set({ streamingSendMode: mode });
  },
  updateSoul: (soul) => {
    set((s) => ({ soul: { ...s.soul, ...soul } }));
    const next = { ...get().soul, ...soul };
    void window.api?.db?.updateSoul(next);
  },
  setSettingsOpen: (open, tab) =>
    set((s) => ({ settingsOpen: open, settingsTab: tab ?? s.settingsTab })),

  openArtifact: (id) => {
    // 点击产物即收起右侧扩展栏悬浮菜单（钉住时保持打开，由 closeExtensionFlyout 内部判定）
    get().closeExtensionFlyout();
    // 有磁盘路径的 HTML：走扩展栏浏览器 file:// 直载，不再进 mybuddy-artifact 协议预览
    // （自定义协议栈导航失败 ERR_FAILED，且快照语义与外部浏览器不一致）
    const direct = findActiveTaskArtifact(get(), id);
    const directPath = direct?.kind === "html" ? direct.path?.trim() : "";
    if (directPath) {
      const fileUrl = fileUrlForAbsolutePath(directPath);
      get().setBrowserUrl(fileUrl);
      get().refreshBrowser();
      return;
    }
    set((s) => {
      const artifact = findActiveTaskArtifact(s, id);
      const extensionView =
        s.extensionFlyoutOpen && artifact
          ? defaultFlyoutViewForArtifact(artifact)
          : s.extensionView;
      return {
        panelOpen: true,
        panelMode: "file",
        activeArtifactId: id,
        artifactTabs: s.artifactTabs.includes(id) ? s.artifactTabs : [...s.artifactTabs, id],
        extensionView,
        extensionMenuOpen: false,
        // 打开文档/网页：自动扩到阅读宽度（对齐官方半屏+ 预览）
        panelWidth: adaptivePanelWidth(artifact?.kind, s.sidebarCollapsed),
      };
    });
    // V3.5 hotfix §8：打开即触发 hydration（cache 缺失/版本过期 → readContent；
    // single-flight；二进制 Viewer 不挂载空内容，UI 层显示 loading/error）
    const descriptor = findDescriptorByIdAnyTask(get(), id);
    const cached = get().artifactRenderCache[id];
    if (descriptor && (!cached || cached.artifactVersion !== descriptor.version)) {
      void getRenderHydration().ensure(id);
    }
  },

  closeArtifactTab: (id) => {
    set((s) => {
      const tabs = s.artifactTabs.filter((x) => x !== id);
      const active = s.activeArtifactId === id ? (tabs[tabs.length - 1] ?? null) : s.activeArtifactId;
      const noTabs = tabs.length === 0;
      const nextArtifact = findActiveTaskArtifact(s, active);
      return {
        artifactTabs: tabs,
        activeArtifactId: active,
        panelMode: noTabs && s.panelMode === "file" ? s.extensionView : s.panelMode,
        panelOpen: true,
        extensionFlyoutOpen: noTabs ? false : s.extensionFlyoutOpen,
        extensionMenuOpen: noTabs ? false : s.extensionMenuOpen,
        // 关完文件 → 窄轨；切换 tab → 按新类型重算
        panelWidth: noTabs
          ? PANEL_RAIL_WIDTH
          : adaptivePanelWidth(nextArtifact?.kind, s.sidebarCollapsed),
      };
    });
  },

  removeArtifact: async (id, opts) => {
    const descriptor = findDescriptorByIdAnyTask(get(), id);
    const trashFile = opts?.trashFile !== false;
    if (trashFile && descriptor?.source.type === "workspace-file") {
      const root = descriptor.source.rootDir;
      const entry = descriptor.source.entryFile;
      const rel = toWorkspaceRelative(root, entry);
      if (rel && window.api?.trashWorkspacePath) {
        const result = await window.api.trashWorkspacePath(root, rel);
        if (!result.ok) {
          console.error("[removeArtifact] trash failed:", result.error);
          return false;
        }
      }
    }
    try {
      const result = await window.api?.artifactDomain?.remove?.({ artifactId: id });
      if (!result?.ok) {
        // 文件已删但登记不存在：仍关掉 tab
        get().closeArtifactTab(id);
        return Boolean(result?.ok);
      }
      return true;
    } catch (err) {
      console.error("[removeArtifact] failed:", err);
      return false;
    }
  },

  removeArtifactsForWorkspacePath: async (root, relativePath) => {
    const prefix = normalizeComparePath(joinWorkspaceAbs(root, relativePath));
    const matches: string[] = [];
    for (const descriptors of Object.values(get().artifactProjection.artifactsByTask)) {
      for (const d of descriptors) {
        if (d.source.type !== "workspace-file") continue;
        const entry = normalizeComparePath(d.source.entryFile);
        if (entry === prefix || entry.startsWith(`${prefix}/`)) matches.push(d.id);
      }
    }
    for (const id of matches) {
      try {
        await window.api?.artifactDomain?.remove?.({ artifactId: id });
      } catch (err) {
        console.warn("[removeArtifactsForWorkspacePath] skip", id, err);
      }
    }
  },

  closePanel: () =>
    set((s) => ({
      panelOpen: false,
      extensionFlyoutOpen: false,
      extensionFlyoutPinned: false,
      extensionMenuOpen: false,
      panelExpanded: false,
      panelWidth: PANEL_RAIL_WIDTH,
      sidebarCollapsed:
        s.sidebarBeforePanelExpand !== null ? s.sidebarBeforePanelExpand : s.sidebarCollapsed,
      sidebarBeforePanelExpand: null,
    })),

  showOverview: () => {
    const s = get();
    const hasFileTabs = s.artifactTabs.length > 0;
    set({
      panelOpen: true,
      panelMode: hasFileTabs ? "file" : "overview",
      extensionView: "overview",
      extensionFlyoutOpen: hasFileTabs,
      panelWidth: hasFileTabs ? s.panelWidth : PANEL_RAIL_WIDTH,
    });
  },

  showAllArtifacts: () => {
    set({
      panelOpen: true,
      panelMode: "overview",
      extensionView: "overview",
      extensionFlyoutOpen: false,
      extensionFlyoutPinned: false,
      panelWidth: PANEL_RAIL_WIDTH,
    });
  },

  showWorkspace: () => {
    const s = get();
    const hasFileTabs = s.artifactTabs.length > 0;
    set({
      panelOpen: true,
      panelMode: hasFileTabs ? "file" : "workspace",
      extensionView: "workspace",
      extensionFlyoutOpen: hasFileTabs,
      panelWidth: hasFileTabs ? s.panelWidth : PANEL_RAIL_WIDTH,
    });
  },

  showGadgets: () => {
    set({
      panelOpen: true,
      panelMode: "gadgets",
      extensionView: "gadgets",
      extensionFlyoutOpen: false,
      extensionFlyoutPinned: false,
      panelWidth: PANEL_RAIL_WIDTH,
    });
  },

  showBrowser: () => {
    const s = get();
    const key = s.activeTaskId ?? HOME_BROWSER_KEY;
    const browserUrl = s.browserUrlByTask[key] ?? "";
    set({
      panelOpen: true,
      panelMode: "browser",
      extensionView: "browser",
      extensionFlyoutOpen: false,
      browserUrlInput: browserUrl,
      panelWidth: browserUrl
        ? canvasPanelWidth(s.sidebarCollapsed)
        : canvasPanelWidth(s.sidebarCollapsed),
    });
  },

  showTerminal: () => {
    const s = get();
    const hasFileTabs = s.artifactTabs.length > 0;
    set({
      panelOpen: true,
      // 与 Browser 一致：整面板模式。flyout 无终端视图（复用 flyout 会引入高度问题），
      // 因此有文件 tabs 时也直接整面板切换，保证任何入口都能正确到达终端。
      panelMode: "terminal",
      extensionView: "terminal",
      extensionFlyoutOpen: false,
      panelWidth: hasFileTabs ? s.panelWidth : canvasPanelWidth(s.sidebarCollapsed),
    });
  },

  setBrowserUrl: (url) => {
    const key = get().activeTaskId ?? HOME_BROWSER_KEY;
    if (!url) {
      set((s) => {
        const urls = { ...s.browserUrlByTask };
        delete urls[key];
        return { browserUrlByTask: urls, browserUrlInput: "" };
      });
      return;
    }
    set((s) => ({
      browserUrlByTask: { ...s.browserUrlByTask, [key]: url },
      browserUrlInput: url,
      panelMode: "browser",
      extensionView: "browser",
      extensionFlyoutOpen: false,
      panelOpen: true,
      panelWidth: canvasPanelWidth(s.sidebarCollapsed),
    }));
  },

  navigateBrowser: () => {
    const url = normalizeBrowserUrl(get().browserUrlInput);
    if (url) get().setBrowserUrl(url);
  },

  refreshBrowser: () => set((s) => ({ browserFrameKey: s.browserFrameKey + 1 })),

  showChanges: () => {
    const s = get();
    const hasFileTabs = s.artifactTabs.length > 0;
    set({
      panelOpen: true,
      panelMode: hasFileTabs ? "file" : "changes",
      extensionView: "changes",
      extensionFlyoutOpen: hasFileTabs,
      panelWidth: hasFileTabs ? s.panelWidth : PANEL_RAIL_WIDTH,
    });
  },

  showAllChanges: () => {
    set({
      panelOpen: true,
      panelMode: "changes",
      extensionView: "changes",
      extensionFlyoutOpen: false,
      extensionFlyoutPinned: false,
      panelWidth: PANEL_RAIL_WIDTH,
    });
  },

  openExtensionFlyout: (mode) => {
    const s = get();
    if (s.artifactTabs.length === 0) return;
    const artifact = findActiveTaskArtifact(s, s.activeArtifactId);
    const view =
      mode && mode !== "file" ? mode : defaultFlyoutViewForArtifact(artifact);
    if (view === "overview") get().showOverview();
    else if (view === "workspace") get().showWorkspace();
    else if (view === "terminal") get().showTerminal();
    else if (view === "browser") get().showBrowser();
    else if (view === "changes") get().showChanges();
  },

  toggleExtensionFlyout: () => {
    const s = get();
    if (s.artifactTabs.length === 0) return;
    if (s.extensionFlyoutOpen) {
      set({ extensionFlyoutOpen: false, extensionFlyoutPinned: false });
    } else {
      get().openExtensionFlyout();
    }
  },

  closeExtensionFlyout: () => {
    if (get().extensionFlyoutPinned) return;
    set({ extensionFlyoutOpen: false });
  },

  toggleExtensionFlyoutPinned: () =>
    set((s) => ({ extensionFlyoutPinned: !s.extensionFlyoutPinned })),

  setExtensionMenuOpen: (open) => set({ extensionMenuOpen: open }),

  openLocalFile: async () => {
    const file = await window.api?.pickLocalFile?.();
    if (!file) return;

    const kind = file.kind;
    const language = file.language ?? (kind === "code" ? languageFromName(file.name) : undefined);
    const taskId = get().activeTaskId;
    if (!taskId) return;
    const task = get().tasks.find((t) => t.id === taskId);
    const workspaceRoot = task?.cwd ?? get().spaces.find((sp) => sp.id === task?.spaceId)?.path;

    // 3C：Artifact create 唯一通道 = artifactDomain.register（不再直接写 task.artifacts）；
    // workspace root 内 → workspace-file；root 外 → managed-content copy（安全边界）
    let descriptor: ArtifactDescriptor | null = null;
    try {
      descriptor =
        (await window.api?.artifactDomain?.register(
          buildRegistration(taskId, {
            name: file.name,
            kind,
            content: file.content,
            language,
            path: file.path,
            workspaceRoot,
          }),
        )) ?? null;
    } catch (err) {
      console.error("[openLocalFile] register 失败:", err);
      return;
    }
    if (!descriptor) return;

    // 渲染缓存（内容快照，非真相；派生视图由此补 content；version 绑定 hotfix）
    get().cacheArtifactRender(descriptor.id, {
      name: file.name,
      kind,
      content: file.content,
      language,
      path: file.path,
      artifactVersion: descriptor.version,
    });

    const tabs = get().artifactTabs.includes(descriptor.id)
      ? get().artifactTabs
      : [...get().artifactTabs, descriptor.id];
    set({
      panelOpen: true,
      panelMode: "file",
      activeArtifactId: descriptor.id,
      artifactTabs: tabs,
      extensionView: defaultFlyoutViewForArtifact({ kind }),
      extensionFlyoutOpen: get().extensionFlyoutOpen,
      panelWidth: adaptivePanelWidth(kind, get().sidebarCollapsed),
    });
  },

  openLocalFolder: async () => {
    const folder = await window.api?.pickLocalFolder?.();
    if (!folder) return;
    const spaceId = await get().addSpaceFromPath(folder.path, folder.name);
    const taskId = get().activeTaskId;
    if (taskId) get().bindTaskSpace(taskId, spaceId);
  },

  openWorkspaceFile: async (relativePath, name) => {
    const state = get();
    const task = state.tasks.find((item) => item.id === state.activeTaskId);
    const root = task?.cwd ?? state.spaces.find((space) => space.id === task?.spaceId)?.path;
    if (!root) return;
    const taskId = state.activeTaskId;
    if (!taskId) return;
    const file = await window.api?.readWorkspaceFile(root, relativePath);
    if (!file) return;
    const kind = file.kind;
    const language = file.language ?? (kind === "code" ? languageFromName(name) : undefined);
    const normTarget = file.path.replace(/\\/g, "/").toLowerCase();

    // 3C：已注册（同 path）→ 复用 + 统一 hydration；否则 register（workspace-file，root=workspace root）
    const existing = state.artifactProjection.artifactsByTask[taskId]?.find(
      (d) =>
        d.source.type === "workspace-file" &&
        d.source.entryFile.replace(/\\/g, "/").toLowerCase() === normTarget,
    );
    let artifactId: string;
    if (existing) {
      artifactId = existing.id;
      // V3.5 hotfix：统一经 hydration 层 readContent（版本绑定 + single-flight + stale 防御）
      void getRenderHydration().ensure(artifactId);
    } else {
      let descriptor: ArtifactDescriptor | null = null;
      try {
        descriptor =
          (await window.api?.artifactDomain?.register(
            buildRegistration(taskId, {
              name,
              kind,
              content: file.content,
              language,
              path: file.path,
              workspaceRoot: root,
            }),
          )) ?? null;
      } catch (err) {
        console.error("[openWorkspaceFile] register 失败:", err);
        return;
      }
      if (!descriptor) return;
      artifactId = descriptor.id;
      // 内容已在手（同流程读盘）→ 直接 version 绑定入缓存（hotfix §5.2）
      get().cacheArtifactRender(artifactId, {
        name,
        kind,
        content: file.content,
        language,
        path: file.path,
        artifactVersion: descriptor.version,
      });
    }

    // 有磁盘路径的 HTML：工作区双击同样走扩展栏浏览器，不进协议预览
    if (kind === "html" && file.path?.trim()) {
      const fileUrl = fileUrlForAbsolutePath(file.path.trim());
      get().setBrowserUrl(fileUrl);
      get().refreshBrowser();
      return;
    }

    const tabs = get().artifactTabs.includes(artifactId)
      ? get().artifactTabs
      : [...get().artifactTabs, artifactId];
    set({
      panelOpen: true,
      panelMode: "file",
      activeArtifactId: artifactId,
      artifactTabs: tabs,
      extensionView: "workspace",
      extensionFlyoutOpen: false,
      panelWidth: adaptivePanelWidth(kind, get().sidebarCollapsed),
    });
  },

  openLocalAbsoluteFile: async (absPath) => {
    const path = absPath.trim();
    if (!path) return;
    const taskId = get().activeTaskId;
    if (!taskId) return;
    const name = fileNameFromPath(path);
    const norm = normalizeComparePath(path);
    const existing = get().artifactProjection.artifactsByTask[taskId]?.find((d) => {
      if (d.source.type === "workspace-file") {
        return normalizeComparePath(d.source.entryFile) === norm;
      }
      return typeof d.capabilities?.diskPath === "string" && normalizeComparePath(d.capabilities.diskPath) === norm;
    });
    if (existing) {
      get().openArtifact(existing.id);
      return;
    }
    const parent = parentDir(path);
    let file: { name: string; kind: import("@/types").ArtifactKind; content: string; language?: string; path: string } | null =
      null;
    try {
      file = (await window.api?.readWorkspaceFile(parent, name)) ?? null;
    } catch (err) {
      console.warn("[openLocalAbsoluteFile] read failed", path, err);
    }
    const kind = file?.kind ?? inferArtifactKind(name, file?.content ?? "");
    const language = file?.language ?? (kind === "code" ? languageFromName(name) : undefined);
    const content = file?.content ?? "";
    const resolvedPath = file?.path || path;
    let descriptor: ArtifactDescriptor | null = null;
    try {
      descriptor =
        (await window.api?.artifactDomain?.register(
          buildRegistration(taskId, {
            name,
            kind,
            content: content || " ",
            language,
            path: resolvedPath,
            workspaceRoot: parent,
          }),
        )) ?? null;
    } catch (err) {
      console.error("[openLocalAbsoluteFile] register 失败:", err);
      return;
    }
    if (!descriptor) return;
    get().cacheArtifactRender(descriptor.id, {
      name,
      kind,
      content,
      language,
      path: resolvedPath,
      artifactVersion: descriptor.version,
    });
    // 有磁盘路径的 HTML：走扩展栏浏览器 file:// 直载（existing 分支已由 openArtifact 覆盖）
    if (kind === "html" && resolvedPath.trim()) {
      const fileUrl = fileUrlForAbsolutePath(resolvedPath.trim());
      get().setBrowserUrl(fileUrl);
      get().refreshBrowser();
      return;
    }
    const tabs = get().artifactTabs.includes(descriptor.id)
      ? get().artifactTabs
      : [...get().artifactTabs, descriptor.id];
    set({
      panelOpen: true,
      panelMode: "file",
      activeArtifactId: descriptor.id,
      artifactTabs: tabs,
      extensionView: defaultFlyoutViewForArtifact({ kind }),
      extensionFlyoutOpen: get().extensionFlyoutOpen,
      panelWidth: adaptivePanelWidth(kind, get().sidebarCollapsed),
    });
    if (!content) void getRenderHydration().ensure(descriptor.id);
  },

  openWorkspaceFolder: async (relativePath?: string, taskId?: string) => {
    const state = get();
    const id = taskId ?? state.activeTaskId;
    if (!id) return;
    const task = state.tasks.find((item) => item.id === id);
    // cwd 优先；否则回落到所属空间 path（侧栏「打开文件夹」常用路径）
    const root =
      task?.cwd?.trim() ||
      state.spaces.find((space) => space.id === task?.spaceId)?.path?.trim() ||
      "";
    if (!root) {
      console.warn("[openWorkspaceFolder] 任务无工作区路径", id);
      return;
    }
    const sep = root.includes("\\") ? "\\" : "/";
    const normalized = relativePath?.replace(/[/\\]+/g, sep).replace(new RegExp(`^${sep === "\\" ? "\\\\" : "/"}+`), "");
    const path = normalized ? `${root.replace(/[/\\]+$/, "")}${sep}${normalized}` : root;
    try {
      await window.api?.openFolder?.(path);
    } catch (err) {
      console.error("[openWorkspaceFolder] 打开失败:", path, err);
    }
  },

  ensureCanvasArtifact: async ({ messageId, content, kind, preferredName, open = false }) => {
    const taskId = get().activeTaskId;
    if (!taskId || !content.trim()) return null;
    const task = get().tasks.find((t) => t.id === taskId);
    if (!task) return null;

    const ext = kind === "svg" ? "svg" : "html";
    const baseName = (preferredName?.trim() || guessCanvasArtifactName(content, kind)).replace(
      /[\\/:*?"<>|]+/g,
      "_",
    );
    const name = baseName.toLowerCase().endsWith(`.${ext}`)
      ? baseName
      : `${baseName}.${ext}`;

    // 同内容 + 同名 → 复用（幂等，旧语义保留）；否则注册
    const cache = get().artifactRenderCache;
    const existingId = Object.entries(cache).find(
      ([, p]) => p.name === name && p.content === content,
    )?.[0];
    let artifactId: string;
    if (existingId) {
      artifactId = existingId;
      // 幂等复用：校正 version 绑定（descriptor 已存在则与当前版本对齐）
      const existingDescriptor = findDescriptorByIdAnyTask(get(), artifactId);
      if (existingDescriptor) {
        const payload = get().artifactRenderCache[artifactId];
        if (payload) {
          get().cacheArtifactRender(artifactId, {
            ...payload,
            artifactVersion: existingDescriptor.version,
          });
        }
      }
    } else {
      // 3C：canvas 类产物 = managed-content html + capabilities（不新造 canvas kind）
      let descriptor: ArtifactDescriptor | null = null;
      try {
        descriptor =
          (await window.api?.artifactDomain?.register({
            taskId,
            kind: kind === "svg" ? "svg" : "html",
            title: name,
            capabilities: { executable: true, interactive: true, originalKind: kind },
            content,
          })) ?? null;
      } catch (err) {
        console.error("[ensureCanvasArtifact] register 失败:", err);
        return null;
      }
      if (!descriptor) return null;
      artifactId = descriptor.id;
      get().cacheArtifactRender(artifactId, {
        name,
        kind,
        content,
        language: kind,
        artifactVersion: descriptor.version,
      });
    }

    // message 关联（不再写 task.artifacts；派生视图由 created 事件驱动）
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === taskId
          ? {
              ...t,
              messages: t.messages.map((m) =>
                m.id === messageId
                  ? {
                      ...m,
                      artifactIds: [...new Set([...(m.artifactIds ?? []), artifactId])],
                    }
                  : m,
              ),
              updatedAt: Date.now(),
            }
          : t,
      ),
    }));
    if (!open) return artifactId;
    const tabs = get().artifactTabs.includes(artifactId)
      ? get().artifactTabs
      : [...get().artifactTabs, artifactId];
    set({
      panelOpen: true,
      panelMode: "file",
      activeArtifactId: artifactId,
      artifactTabs: tabs,
      extensionView: "overview",
      extensionFlyoutOpen: false,
      panelWidth: adaptivePanelWidth(kind, get().sidebarCollapsed),
    });
    return artifactId;
  },

  setPanelMode: (mode) =>
    set((s) => ({
      panelMode: mode,
      extensionView: mode === "file" ? s.extensionView : mode,
    })),

  setSelectMode: (on) => set({ selectMode: on, selectedMessageIds: [] }),

  toggleMessageSelected: (id) => {
    set((s) => ({
      selectedMessageIds: s.selectedMessageIds.includes(id)
        ? s.selectedMessageIds.filter((x) => x !== id)
        : [...s.selectedMessageIds, id],
    }));
  },

  selectAllMessages: (ids) => set({ selectedMessageIds: ids }),

  setTaskFilterStatus: (s) => set({ taskFilterStatus: s }),
  setTaskFilterTime: (t) => set({ taskFilterTime: t }),
  resetTaskFilters: () => set({ taskFilterStatus: "all", taskFilterTime: "all" }),
  setPanelWidth: (w) =>
    set((s) => {
      const key = s.activeTaskId ?? HOME_BROWSER_KEY;
      const canvasOpen = s.panelMode === "browser" && Boolean(s.browserUrlByTask[key]);
      return {
        panelWidth: canvasOpen
          ? clampCanvasPanelWidth(w, s.sidebarCollapsed)
          : clampPanelWidth(w, s.sidebarCollapsed),
      };
    }),

  togglePanelExpanded: () =>
    set((s) => {
      if (s.panelExpanded) {
        return {
          panelExpanded: false,
          sidebarCollapsed:
            s.sidebarBeforePanelExpand !== null ? s.sidebarBeforePanelExpand : s.sidebarCollapsed,
          sidebarBeforePanelExpand: null,
        };
      }
      return {
        panelExpanded: true,
        sidebarBeforePanelExpand: s.sidebarCollapsed,
        sidebarCollapsed: true,
      };
    }),

  setFullAccessDuringRun: (on) =>
    set({
      fullAccessDuringRun: on,
      permissionMode: on ? "auto" : "default",
    }),
  setSearchOpen: (open) => set({ searchOpen: open }),
  togglePinTask: async (id) => {
    if (pendingPinTaskIds.has(id)) return; // P1-1：同任务并发直接丢弃，避免重叠乐观更新形成幽灵 pin
    const task = get().tasks.find((t) => t.id === id);
    if (!task) return;
    const prevFav = Boolean(task.isFavorited);
    const prevUpdatedAt = task.updatedAt;
    const next = !prevFav;
    const now = Date.now(); // 单一 now：乐观与持久化同戳，回滚可精确还原
    pendingPinTaskIds.add(id);
    // 乐观更新：本地 tasks.isFavorited + pinnedTaskIds + updatedAt 同步，重启后以 DB is_favorited 为准（Phase 2 持久化闭环）
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, isFavorited: next, updatedAt: now } : t)),
      pinnedTaskIds: next
        ? [...s.pinnedTaskIds.filter((x) => x !== id), id]
        : s.pinnedTaskIds.filter((x) => x !== id),
    }));
    try {
      await window.api?.db?.upsertTask?.({
        id,
        title: task.title,
        updatedAt: now,
        isFavorited: next,
      });
    } catch (err) {
      // 失败仅回退目标 id（函数式），不以全量快照覆盖 pinnedTaskIds，避免跨任务并发时误删/误留其它任务的乐观 pin（P2 修复：prevFav 决定仅对 id 做增/删）
      set((s) => ({
        tasks: s.tasks.map((t) => (t.id === id ? { ...t, isFavorited: prevFav, updatedAt: prevUpdatedAt } : t)),
        pinnedTaskIds: prevFav
          ? s.pinnedTaskIds.includes(id)
            ? s.pinnedTaskIds
            : [...s.pinnedTaskIds, id]
          : s.pinnedTaskIds.filter((x) => x !== id),
      }));
      console.error("[appStore] togglePinTask 持久化失败:", err);
    } finally {
      pendingPinTaskIds.delete(id);
    }
  },
  archiveTask: async (id) => {
    const task = get().tasks.find((x) => x.id === id);
    if (!task) return;
    set((s) => ({
      tasks: s.tasks.map((x) => (x.id === id ? { ...x, archived: true } : x)),
    }));
    await window.api?.db?.archiveTask?.(id, true);
  },
  ackTaskDone: async (id) => {
    const task = get().tasks.find((t) => t.id === id);
    // 只处理「已结束且未确认」：进行中/空闲/已确认都不写库，避免每次切换任务产生无意义 IPC
    if (!task || !isTaskDoneUnread(task)) return;
    const ackedAt = Date.now();
    // 乐观更新：本地先关绿点（渲染层同帧生效），持久化失败也不回滚——
    // 绿点是「看过」的弱提示，误清比常亮代价小；下次点击会重试写库。
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, doneAckedAt: ackedAt } : t)),
    }));
    try {
      await window.api?.db?.ackTaskDone?.(id, ackedAt);
    } catch (error) {
      console.warn("[appStore] ackTaskDone 持久化失败（绿点会在重启后重现）:", error);
    }
  },
  restoreTask: async (id) => {
    set((s) => ({
      tasks: s.tasks.map((x) => (x.id === id ? { ...x, archived: false } : x)),
    }));
    await window.api?.db?.archiveTask?.(id, false);
  },
  archiveSpace: async (id) => {
    const space = get().spaces.find((x) => x.id === id);
    if (!space) return;
    // P1-2 修复：DB 只改 spaces.archived，UI 绝不 fan-out 到 tasks；effective 由 recompute 统一计算，重启前后一致
    set((s) => ({
      spaces: recomputeEffectiveArchived(s.spaces.map((x) => (x.id === id ? { ...x, archived: true } : x))),
      homeSpaceId: s.homeSpaceId === id ? null : s.homeSpaceId,
    }));
    await window.api?.db?.archiveSpace?.(id, true);
  },
  restoreSpace: async (id) => {
    set((s) => ({
      spaces: recomputeEffectiveArchived(s.spaces.map((x) => (x.id === id ? { ...x, archived: false } : x))),
    }));
    await window.api?.db?.archiveSpace?.(id, false);
  },
  deleteSpace: async (id) => {
    const res: any = await window.api?.db?.deleteSpace?.(id);
    if (res && res.ok === false) {
      if (res.reason === "workspace_not_empty") {
        throw new Error("空间非空，无法删除：请先移走子空间和任务");
      }
      throw new Error(res.error || "删除空间失败");
    }
    // P2-1 清理 stale id（删除后不再残留 localStorage；存储语义为「已展开集合」）
    set((s) => {
      const nextExpanded = s.expandedSpaceIds.filter((x) => x !== id);
      if (nextExpanded.length !== s.expandedSpaceIds.length) saveSidebarExpanded(nextExpanded);
      return {
        spaces: s.spaces.filter((x) => x.id !== id),
        homeSpaceId: s.homeSpaceId === id ? null : s.homeSpaceId,
        expandedSpaceIds: nextExpanded,
        // 主进程已把任务 space_id 置 NULL，内存同步解绑，任务归入「任务」分组
        tasks: s.tasks.map((t) => (t.spaceId === id ? { ...t, spaceId: undefined } : t)),
      };
    });
  },
  setHomeSpaceId: (id) => set({ homeSpaceId: id }),

  listTaskWriteGrants: async () => {
    const taskId = get().activeTaskId;
    if (!taskId) return [];
    return (await window.api?.db?.listTaskWriteGrants?.(taskId)) ?? [];
  },

  revokeTaskWriteGrant: async (path) => {
    const taskId = get().activeTaskId;
    if (!taskId) return false;
    return (await window.api?.db?.deleteTaskWriteGrant?.(taskId, path)) ?? false;
  },
  /** 新建空间，返回新空间 id（便于调用方立即切换）；parentId null=根，支持创建子空间 */
  addSpace: async (parentId?: string | null, requestedName?: string): Promise<string | undefined> => {
    const pid = parentId ?? null;
    const base = requestedName?.trim() || `工作空间 ${get().spaces.length + 1}`;
    const name = nextAvailableSpaceName(get().spaces, base, pid);
    const space: Space = {
      id: uid(),
      name,
      parentId: pid,
    };
    set((s) => ({
      spaces: [...s.spaces, space],
      homeSpaceId: space.id,
    }));
    const result = await window.api?.db?.upsertSpace({
      id: space.id,
      name: space.name,
      path: space.path,
      parentId: pid,
    } as any);
    if (result && !result.ok) {
      console.error("[addSpace] 写入失败：", result.error);
      set((s) => ({
        spaces: s.spaces.filter((x) => x.id !== space.id),
        homeSpaceId: s.homeSpaceId === space.id ? null : s.homeSpaceId,
      }));
      return undefined;
    }
    await get().refreshSpaces();
    return space.id;
  },
  refreshSpaces: async () => {
    try {
      const all = await window.api?.db?.listSpaces?.();
      if (!all) return;
      const mapped = (all as any[]).map((s: any) => ({ id: s.id, name: s.name, path: s.path, archived: Boolean(s.archived), parentId: s.parentId ?? null, sortOrder: s.sortOrder ?? 0, createdAt: s.createdAt ?? 0, effectiveArchived: s.effectiveArchived ?? false, pathMissing: Boolean(s.pathMissing) }));
      set((state) => ({ spaces: mapped.length ? mapped as Space[] : state.spaces }));
    } catch (error) {
      console.error("[refreshSpaces] 读取失败：", error);
    }
  },
  ensureSpaceFromPath: async (folderPath, name, parentId = null, options = {}) => {
    const activate = options.activate !== false;
    const normalized = normalizePath(folderPath);
    const spaces = get().spaces;
    const destKey = spacePathKey(normalized);

    // Same physical path: reuse the durable Space. Project flows may reuse it without
    // changing the global home workspace selection.
    const samePath = spaces.find((space) => space.path && spacePathKey(space.path) === destKey);
    if (samePath) {
      if (samePath.archived) await get().restoreSpace(samePath.id);
      set((state) => ({
        spaces: state.spaces.map((item) => item.id === samePath.id ? { ...item, pathMissing: false } : item),
        ...(activate ? { homeSpaceId: samePath.id } : {}),
      }));
      const persisted = await window.api?.db?.upsertSpace({
        id: samePath.id,
        name: samePath.name,
        path: samePath.path,
      });
      if (persisted && !persisted.ok) throw new Error(persisted.error || "目录记录更新失败");
      return { id: samePath.id, created: false };
    }

    const trimmedName = name.trim();
    const existence = new Map<string, boolean>();
    await Promise.all(
      spaces
        .filter((space) => space.path)
        .map(async (space) => {
          const key = spacePathKey(space.path!);
          if (existence.has(key)) return;
          const ok = (await window.api?.pathExists?.(space.path!)) ?? true;
          existence.set(key, ok);
        }),
    );
    const remount = findSpaceToRemount(
      spaces,
      normalized,
      trimmedName || normalized.split(/[\\/]/).pop() || normalized,
      (path) => existence.get(spacePathKey(path)) === true,
    );
    if (remount) {
      const written = await applySpacePath(remount, normalized);
      if (!written.ok) throw new Error(written.error || "目录重新关联失败");
      if (remount.archived) await get().restoreSpace(remount.id);
      set((state) => ({
        spaces: state.spaces.map((item) => item.id === remount.id ? { ...item, path: normalized, pathMissing: false } : item),
        ...(activate ? { homeSpaceId: remount.id } : {}),
      }));
      return { id: remount.id, created: false };
    }

    const base = trimmedName || normalized.split(/[\\/]/).pop() || normalized;
    const space: Space = {
      id: uid(),
      name: nextAvailableSpaceName(spaces, base, parentId),
      path: normalized,
      parentId,
    };
    set((state) => ({
      spaces: [space, ...state.spaces],
      ...(activate ? { homeSpaceId: space.id } : {}),
    }));
    const result = await window.api?.db?.upsertSpace({
      id: space.id,
      name: space.name,
      path: space.path,
      parentId,
    } as any);
    if (result && !result.ok) {
      set((state) => ({
        spaces: state.spaces.filter((item) => item.id !== space.id),
        ...(activate && state.homeSpaceId === space.id ? { homeSpaceId: null } : {}),
      }));
      throw new Error(result.error || "项目工作目录保存失败");
    }
    return { id: space.id, created: true };
  },
  addSpaceFromPath: async (folderPath, name, parentId = null) => {
    const result = await get().ensureSpaceFromPath(folderPath, name, parentId, { activate: true });
    return result.id;
  },  relocateSpace: async (id) => {
    const space = get().spaces.find((s) => s.id === id);
    if (!space) return { ok: false, reason: "missing" };
    const folder = await window.api?.pickLocalFolder?.();
    if (!folder) return { ok: false, reason: "cancel" };
    const normalized = normalizePath(folder.path);
    const destKey = spacePathKey(normalized);
    const other = get().spaces.find(
      (s) => s.id !== id && s.path && spacePathKey(s.path) === destKey,
    );
    if (other) {
      return { ok: false, reason: "occupied", otherName: other.name };
    }
    // DB 是 workspace path 的权威源。必须先写成功，再让 Renderer 发布新 path；
    // 否则 TerminalView 会先因 path 变化 reopen，而 main 此时仍解析到旧 cwd。
    const written = await applySpacePath({ ...space, path: normalized }, normalized);
    if (!written.ok) {
      console.error("[relocateSpace] 写入失败：", written.error);
      return { ok: false, reason: "write" };
    }
    set((s) => ({
      spaces: s.spaces.map((x) =>
        x.id === id ? { ...x, path: normalized, pathMissing: false } : x,
      ),
      homeSpaceId: id,
    }));
    return { ok: true };
  },
  refreshSpacePathStatus: async (id) => {
    const space = get().spaces.find((s) => s.id === id);
    if (!space?.path) return;
    const ok = (await window.api?.pathExists?.(space.path)) ?? true;
    const missing = !ok;
    if (missing === Boolean(space.pathMissing)) return;
    set((s) => ({
      spaces: s.spaces.map((x) => (x.id === id ? { ...x, pathMissing: missing } : x)),
    }));
  },
  renameSpace: async (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return false;
    // P1-4 修复：按 parentId 做同级唯一检查（DB 已支持跨父同名，UI 不得全局拦截）
    const target = get().spaces.find((s) => s.id === id);
    const parentId = target?.parentId ?? null;
    const conflict = get().spaces.some(
      (s) => s.id !== id && (s.parentId ?? null) === parentId && s.name.trim().toLowerCase() === trimmed.toLowerCase(),
    );
    if (conflict) return false;
    const result = await window.api?.db?.renameSpace?.(id, trimmed);
    if (result && !result.ok) {
      console.error("[renameSpace] 失败：", result.error);
      return false;
    }
    set((s) => ({
      spaces: s.spaces.map((x) => (x.id === id ? { ...x, name: trimmed } : x)),
    }));
    return true;
  },
  bindTaskSpace: (taskId, spaceId) => {
    // P1-2 消除 upsert 旁路：所有任务换空间必须复用 moveTaskInWorkspaceTree 的 archived/effectiveArchived 双层防御与排序/renumber 契约。
    // 保持 TaskItem/WorkspacePicker/ChatInput 原调用不动，仅将底层由 upsertTask 改为等价 moveTask（源校验、目标校验、排序一致）。
    // 若 IPC 不可用（单测 mock）则回退为轻量本地校验+upsert，但主流程一律走 move 语义。
    const targetSpaceId = spaceId ?? null;
    const hasMoveApi = typeof (window as any)?.api?.db?.moveTaskInWorkspaceTree === "function";
    if (hasMoveApi) {
      void get().moveTaskInWorkspaceTree({ taskId, targetSpaceId });
      // 同步 homeSpaceId / 展开的语义由 moveTaskInWorkspaceTree 已处理；此处补充 activeTask 的 homeSpaceId 立即可见（move 为异步乐观，已在内部处理）
      return;
    }
    // fallback（无 IPC 环境，如单测）：走本地轻量 upsert，但仍做归档校验避免脏写
    const state = get();
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) return;
    if (task.archived) return;
    if (targetSpaceId != null) {
      const eff = computeEffectiveArchivedShared(state.spaces.map((s) => ({ id: s.id, parentId: s.parentId ?? null, archived: Boolean(s.archived) })));
      if (eff.get(targetSpaceId)) return;
      if (!state.spaces.some((s) => s.id === targetSpaceId)) return;
    }
    const now = Date.now();
    set((s) => {
      const next: Partial<AppState> = {
        tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, spaceId: targetSpaceId ?? undefined, updatedAt: now } : t)),
      };
      if (s.activeTaskId === taskId) next.homeSpaceId = targetSpaceId;
      // 把任务挂进某个空间时自动展开它，否则用户看不见刚落进去的任务
      if (targetSpaceId && !s.expandedSpaceIds.includes(targetSpaceId)) {
        const expanded = [...s.expandedSpaceIds, targetSpaceId];
        saveSidebarExpanded(expanded);
        next.expandedSpaceIds = expanded;
      }
      return next;
    });
    void window.api?.db?.upsertTask({
      id: task.id,
      title: task.title,
      spaceId: targetSpaceId,
      status: task.status,
      updatedAt: now,
      sessionFile: task.sessionFile,
      cwd: task.cwd,
      welcomeMode: task.welcomeMode,
    });
  },
  moveSpace: async ({ spaceId, targetParentId, targetIndex }) => {
    if (pendingMoveSpaceIds.has(spaceId)) return { ok: false as const, error: "正在移动中，请稍后重试" };
    pendingMoveSpaceIds.add(spaceId);
    const prevChain = moveChain;
    let releaseChain!: () => void;
    moveChain = new Promise<void>((res) => (releaseChain = res));
    await prevChain;
    let prevSpaces: Space[] = [];
    let prevExpanded: string[] = [];
    let prevById = new Map<string, Space>();
    let newSiblingIds = new Set<string>();
    let oldSiblingIds = new Set<string>();
    let hasOptimistic = false;
    let result: { ok: true } | { ok: false; error: string } = { ok: true as const };
    try {
      prevSpaces = get().spaces.map((s) => ({ ...s }));
      prevExpanded = get().expandedSpaceIds.slice();
      prevById = new Map(prevSpaces.map((s) => [s.id, s]));
      const moving = prevById.get(spaceId);
      if (!moving) {
        result = { ok: false as const, error: "空间不存在" };
        return result;
      }
      const oldParentId = moving.parentId ?? null;
      if (targetParentId === spaceId) {
        result = { ok: false as const, error: "不能把空间移动到其自身之下（cycle）" };
        return result;
      }
      if (targetParentId != null) {
        const byId = new Map(prevSpaces.map((s) => [s.id, s.parentId ?? null]));
        let cur: string | null = targetParentId;
        const seen = new Set<string>();
        while (cur != null) {
          if (seen.has(cur)) break;
          seen.add(cur);
          if (cur === spaceId) {
            result = { ok: false as const, error: "不能把空间移动到其子孙空间之下（cycle）" };
            return result;
          }
          cur = byId.get(cur) ?? null;
        }
        const eff = computeEffectiveArchivedShared(prevSpaces.map((s) => ({ id: s.id, parentId: s.parentId ?? null, archived: Boolean(s.archived) })));
        if (eff.get(spaceId)) {
          result = { ok: false as const, error: "已归档空间不能移动" };
          return result;
        }
        if (eff.get(targetParentId)) {
          result = { ok: false as const, error: "不能移动到已归档空间" };
          return result;
        }
        if (!prevSpaces.some((s) => s.id === targetParentId)) {
          result = { ok: false as const, error: "目标空间不存在" };
          return result;
        }
      } else {
        const eff = computeEffectiveArchivedShared(prevSpaces.map((s) => ({ id: s.id, parentId: s.parentId ?? null, archived: Boolean(s.archived) })));
        if (eff.get(spaceId)) {
          result = { ok: false as const, error: "已归档空间不能移动" };
          return result;
        }
      }
      // 计算受影响 sibling 集合，用于精确回滚（跨 id 并发时不覆盖另一成功乐观）
      const siblingsTarget = prevSpaces
        .filter((s) => (s.parentId ?? null) === (targetParentId ?? null))
        .sort((a, b) => {
          const ao = a.sortOrder ?? 0;
          const bo = b.sortOrder ?? 0;
          if (ao !== bo) return ao - bo;
          const ac = a.createdAt ?? 0;
          const bc = b.createdAt ?? 0;
          if (ac !== bc) return ac - bc;
          return a.id.localeCompare(b.id);
        });
      const filteredTargetIds = siblingsTarget.map((s) => s.id).filter((id) => id !== spaceId);
      newSiblingIds = new Set(filteredTargetIds);
      if (oldParentId !== targetParentId) {
        const oldSiblings = prevSpaces
          .filter((s) => (s.parentId ?? null) === oldParentId && s.id !== spaceId)
          .sort((a, b) => {
            const ao = a.sortOrder ?? 0;
            const bo = b.sortOrder ?? 0;
            if (ao !== bo) return ao - bo;
            const ac = a.createdAt ?? 0;
            const bc = b.createdAt ?? 0;
            if (ac !== bc) return ac - bc;
            return a.id.localeCompare(b.id);
          });
        oldSiblingIds = new Set(oldSiblings.map((s) => s.id));
      }
      const now = Date.now();
      let nextSpaces: Space[] = prevSpaces.map((s) => ({ ...s }));
      if (targetIndex !== undefined) {
        const filtered = filteredTargetIds;
        const clamped = Math.max(0, Math.min(targetIndex, filtered.length));
        const newOrder = [...filtered.slice(0, clamped), spaceId, ...filtered.slice(clamped)];
        const orderMap = new Map(newOrder.map((id, idx) => [id, (idx + 1) * 1000]));
        nextSpaces = nextSpaces.map((s) => {
          if (orderMap.has(s.id)) {
            return { ...s, parentId: targetParentId, sortOrder: orderMap.get(s.id)! };
          }
          return s;
        });
        if (oldParentId !== targetParentId) {
          const oldSiblings = prevSpaces
            .filter((s) => (s.parentId ?? null) === oldParentId && s.id !== spaceId)
            .sort((a, b) => {
              const ao = a.sortOrder ?? 0;
              const bo = b.sortOrder ?? 0;
              if (ao !== bo) return ao - bo;
              const ac = a.createdAt ?? 0;
              const bc = b.createdAt ?? 0;
              if (ac !== bc) return ac - bc;
              return a.id.localeCompare(b.id);
            });
          const oldMap = new Map(oldSiblings.map((s, idx) => [s.id, (idx + 1) * 1000]));
          nextSpaces = nextSpaces.map((s) => (oldMap.has(s.id) ? { ...s, sortOrder: oldMap.get(s.id)! } : s));
        }
      } else {
        const curMax = Math.max(0, ...prevSpaces.filter((s) => (s.parentId ?? null) === (targetParentId ?? null) && s.id !== spaceId).map((s) => s.sortOrder ?? 0));
        nextSpaces = nextSpaces.map((s) => (s.id === spaceId ? { ...s, parentId: targetParentId, sortOrder: curMax + 1000 } : s));
        if (oldParentId !== targetParentId) {
          const oldSiblings = prevSpaces
            .filter((s) => (s.parentId ?? null) === oldParentId && s.id !== spaceId)
            .sort((a, b) => {
              const ao = a.sortOrder ?? 0;
              const bo = b.sortOrder ?? 0;
              if (ao !== bo) return ao - bo;
              return a.id.localeCompare(b.id);
            });
          const oldMap = new Map(oldSiblings.map((s, idx) => [s.id, (idx + 1) * 1000]));
          nextSpaces = nextSpaces.map((s) => (oldMap.has(s.id) ? { ...s, sortOrder: oldMap.get(s.id)! } : s));
        }
      }
      nextSpaces = recomputeEffectiveArchived(nextSpaces);
      // 移动进某个空间时自动展开它（否则用户看不到移动结果）；存储语义为「已展开集合」
      let nextExpanded = prevExpanded.slice();
      if (targetParentId && !nextExpanded.includes(targetParentId)) {
        nextExpanded = [...nextExpanded, targetParentId];
        saveSidebarExpanded(nextExpanded);
      }
      set({ spaces: nextSpaces, expandedSpaceIds: nextExpanded });
      hasOptimistic = true;
      const res: any = await (window.api as any)?.db?.moveSpace?.({ spaceId, targetParentId, targetIndex });
      if (res && res.ok === false) {
        // 精确函数式回滚：仅回退本 move 影响的 ids 与 targetParentId 折叠态，跨 kind/跨 id 成功展开不被覆盖（P2-3）
        set((s) => {
          const restored = s.spaces.map((cur) => {
            if (cur.id === spaceId) {
              const prev = prevById.get(cur.id)!;
              return { ...cur, parentId: prev.parentId, sortOrder: prev.sortOrder };
            }
            if (newSiblingIds.has(cur.id) || oldSiblingIds.has(cur.id)) {
              const prev = prevById.get(cur.id);
              if (prev) return { ...cur, sortOrder: prev.sortOrder };
            }
            return cur;
          });
          // P2-3 精确回退：仅当本次乐观展开了 targetParentId 时才把它移出展开集合
          const curExpanded = s.expandedSpaceIds;
          const wasExpanded = targetParentId ? prevExpanded.includes(targetParentId) : false;
          const isNowExpanded = targetParentId ? curExpanded.includes(targetParentId) : false;
          let nextExpanded = curExpanded;
          if (targetParentId && !wasExpanded && isNowExpanded) {
            nextExpanded = curExpanded.filter((id) => id !== targetParentId);
            saveSidebarExpanded(nextExpanded);
          }
          return { spaces: recomputeEffectiveArchived(restored), expandedSpaceIds: nextExpanded };
        });
        result = { ok: false as const, error: res.error || "移动空间失败" };
        return result;
      }
      result = { ok: true as const };
      return result;
    } catch (err) {
      if (hasOptimistic) {
        set((s) => {
          const restored = s.spaces.map((cur) => {
            if (cur.id === spaceId) {
              const prev = prevById.get(cur.id)!;
              return { ...cur, parentId: prev.parentId, sortOrder: prev.sortOrder };
            }
            if (newSiblingIds.has(cur.id) || oldSiblingIds.has(cur.id)) {
              const prev = prevById.get(cur.id);
              if (prev) return { ...cur, sortOrder: prev.sortOrder };
            }
            return cur;
          });
          const curExpanded = s.expandedSpaceIds;
          const wasExpanded = targetParentId ? prevExpanded.includes(targetParentId) : false;
          const isNowExpanded = targetParentId ? curExpanded.includes(targetParentId) : false;
          let nextExpanded = curExpanded;
          if (targetParentId && !wasExpanded && isNowExpanded) {
            nextExpanded = curExpanded.filter((id) => id !== targetParentId);
            saveSidebarExpanded(nextExpanded);
          }
          return { spaces: recomputeEffectiveArchived(restored), expandedSpaceIds: nextExpanded };
        });
      }
      result = { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      return result;
    } finally {
      releaseChain();
      pendingMoveSpaceIds.delete(spaceId);
    }
  },
  moveTaskInWorkspaceTree: async ({ taskId, targetSpaceId, targetIndex }) => {
    if (pendingMoveTaskIds.has(taskId)) return { ok: false as const, error: "正在移动中，请稍后重试" };
    pendingMoveTaskIds.add(taskId);
    const prevChain = moveChain;
    let releaseChain!: () => void;
    moveChain = new Promise<void>((res) => (releaseChain = res));
    await prevChain;
    let prevTasks: Task[] = [];
    let prevSpaces: Space[] = [];
    let prevExpanded: string[] = [];
    let prevHomeSpaceId: string | null = null;
    let isActiveTask = false;
    let prevById = new Map<string, Task>();
    let newSiblingIds = new Set<string>();
    let oldSiblingIds = new Set<string>();
    let hasOptimistic = false;
    let result: { ok: true } | { ok: false; error: string } = { ok: true as const };
    try {
      prevTasks = get().tasks.map((t) => ({ ...t }));
      prevSpaces = get().spaces;
      prevExpanded = get().expandedSpaceIds.slice();
      prevHomeSpaceId = get().homeSpaceId;
      isActiveTask = get().activeTaskId === taskId;
      prevById = new Map(prevTasks.map((t) => [t.id, t]));
      const moving = prevById.get(taskId);
      if (!moving) {
        result = { ok: false as const, error: "任务不存在" };
        return result;
      }
      const oldSpaceId = moving.spaceId ?? null;
      if (moving.archived) {
        result = { ok: false as const, error: "已归档任务不能移动" };
        return result;
      }
      if (targetSpaceId != null) {
        const eff = computeEffectiveArchivedShared(prevSpaces.map((s) => ({ id: s.id, parentId: s.parentId ?? null, archived: Boolean(s.archived) })));
        if (eff.get(targetSpaceId)) {
          result = { ok: false as const, error: "不能移动到已归档空间" };
          return result;
        }
        if (!prevSpaces.some((s) => s.id === targetSpaceId)) {
          result = { ok: false as const, error: "目标空间不存在" };
          return result;
        }
      }
      // 计算受影响 sibling 集合用于精确回滚
      if (targetIndex !== undefined && targetSpaceId != null) {
        const siblings = prevTasks.filter((t) => (t.spaceId ?? null) === targetSpaceId).sort((a, b) => {
          const ao = a.spaceSortOrder ?? 0;
          const bo = b.spaceSortOrder ?? 0;
          if (ao !== bo) return ao - bo;
          if (a.updatedAt !== b.updatedAt) return a.updatedAt - b.updatedAt;
          return a.id.localeCompare(b.id);
        });
        const filtered = siblings.map((t) => t.id).filter((id) => id !== taskId);
        newSiblingIds = new Set(filtered);
        if (oldSpaceId !== targetSpaceId && oldSpaceId != null) {
          const oldSiblings = prevTasks.filter((t) => (t.spaceId ?? null) === oldSpaceId && t.id !== taskId).sort((a, b) => {
            const ao = a.spaceSortOrder ?? 0;
            const bo = b.spaceSortOrder ?? 0;
            if (ao !== bo) return ao - bo;
            return a.id.localeCompare(b.id);
          });
          oldSiblingIds = new Set(oldSiblings.map((t) => t.id));
        }
      } else if (targetSpaceId == null) {
        if (oldSpaceId != null) {
          const oldSiblings = prevTasks.filter((t) => (t.spaceId ?? null) === oldSpaceId && t.id !== taskId).sort((a, b) => {
            const ao = a.spaceSortOrder ?? 0;
            const bo = b.spaceSortOrder ?? 0;
            if (ao !== bo) return ao - bo;
            return a.id.localeCompare(b.id);
          });
          oldSiblingIds = new Set(oldSiblings.map((t) => t.id));
        }
      } else {
        const curSiblings = prevTasks.filter((t) => (t.spaceId ?? null) === targetSpaceId && t.id !== taskId).map((t) => t.id);
        newSiblingIds = new Set(curSiblings);
        if (oldSpaceId !== targetSpaceId && oldSpaceId != null) {
          const oldSiblings = prevTasks.filter((t) => (t.spaceId ?? null) === oldSpaceId && t.id !== taskId).map((t) => t.id);
          oldSiblingIds = new Set(oldSiblings);
        }
      }
      const now = Date.now();
      let nextTasks: Task[] = prevTasks.map((t) => ({ ...t }));
      if (targetIndex !== undefined && targetSpaceId != null) {
        const siblings = prevTasks
          .filter((t) => (t.spaceId ?? null) === targetSpaceId)
          .sort((a, b) => {
            const ao = a.spaceSortOrder ?? 0;
            const bo = b.spaceSortOrder ?? 0;
            if (ao !== bo) return ao - bo;
            if (a.updatedAt !== b.updatedAt) return a.updatedAt - b.updatedAt;
            return a.id.localeCompare(b.id);
          });
        const filtered = siblings.map((t) => t.id).filter((id) => id !== taskId);
        const clamped = Math.max(0, Math.min(targetIndex, filtered.length));
        const newOrder = [...filtered.slice(0, clamped), taskId, ...filtered.slice(clamped)];
        const orderMap = new Map(newOrder.map((id, idx) => [id, (idx + 1) * 1000]));
        nextTasks = nextTasks.map((t) => {
          if (orderMap.has(t.id)) {
            return { ...t, spaceId: targetSpaceId ?? undefined, spaceSortOrder: orderMap.get(t.id)!, updatedAt: now };
          }
          if (t.id === taskId && !orderMap.has(t.id)) {
            return { ...t, spaceId: targetSpaceId ?? undefined, updatedAt: now };
          }
          return t;
        });
        if (oldSpaceId !== targetSpaceId && oldSpaceId != null) {
          const oldSiblings = prevTasks
            .filter((t) => (t.spaceId ?? null) === oldSpaceId && t.id !== taskId)
            .sort((a, b) => {
              const ao = a.spaceSortOrder ?? 0;
              const bo = b.spaceSortOrder ?? 0;
              if (ao !== bo) return ao - bo;
              if (a.updatedAt !== b.updatedAt) return a.updatedAt - b.updatedAt;
              return a.id.localeCompare(b.id);
            });
          const oldMap = new Map(oldSiblings.map((t, idx) => [t.id, (idx + 1) * 1000]));
          nextTasks = nextTasks.map((t) => (oldMap.has(t.id) ? { ...t, spaceSortOrder: oldMap.get(t.id)! } : t));
        }
      } else if (targetSpaceId == null) {
        nextTasks = nextTasks.map((t) => (t.id === taskId ? { ...t, spaceId: undefined, spaceSortOrder: 0, updatedAt: now } : t));
        if (oldSpaceId != null) {
          const oldSiblings = prevTasks
            .filter((t) => (t.spaceId ?? null) === oldSpaceId && t.id !== taskId)
            .sort((a, b) => {
              const ao = a.spaceSortOrder ?? 0;
              const bo = b.spaceSortOrder ?? 0;
              if (ao !== bo) return ao - bo;
              return a.id.localeCompare(b.id);
            });
          const oldMap = new Map(oldSiblings.map((t, idx) => [t.id, (idx + 1) * 1000]));
          nextTasks = nextTasks.map((t) => (oldMap.has(t.id) ? { ...t, spaceSortOrder: oldMap.get(t.id)! } : t));
        }
      } else {
        const curMax = Math.max(0, ...prevTasks.filter((t) => (t.spaceId ?? null) === targetSpaceId && t.id !== taskId).map((t) => t.spaceSortOrder ?? 0));
        nextTasks = nextTasks.map((t) => (t.id === taskId ? { ...t, spaceId: targetSpaceId ?? undefined, spaceSortOrder: curMax + 1000, updatedAt: now } : t));
        if (oldSpaceId !== targetSpaceId && oldSpaceId != null) {
          const oldSiblings = prevTasks.filter((t) => (t.spaceId ?? null) === oldSpaceId && t.id !== taskId).sort((a, b) => {
            const ao = a.spaceSortOrder ?? 0;
            const bo = b.spaceSortOrder ?? 0;
            if (ao !== bo) return ao - bo;
            return a.id.localeCompare(b.id);
          });
          const oldMap = new Map(oldSiblings.map((t, idx) => [t.id, (idx + 1) * 1000]));
          nextTasks = nextTasks.map((t) => (oldMap.has(t.id) ? { ...t, spaceSortOrder: oldMap.get(t.id)! } : t));
        }
      }
      const nextPinned = nextTasks.filter((t) => t.isFavorited).map((t) => t.id);
      // 任务被移进某空间时自动展开它（否则移动结果不可见）
      let nextExpanded = prevExpanded.slice();
      if (targetSpaceId && !nextExpanded.includes(targetSpaceId)) {
        nextExpanded = [...nextExpanded, targetSpaceId];
        saveSidebarExpanded(nextExpanded);
      }
      // P2-1 单一真相：homeSpaceId 由 moveTask 统一处理，activeTask 同步 targetSpaceId，失败回滚恢复旧值
      const nextHomeSpaceId = isActiveTask ? targetSpaceId : prevHomeSpaceId;
      set({ tasks: nextTasks, pinnedTaskIds: nextPinned, expandedSpaceIds: nextExpanded, homeSpaceId: nextHomeSpaceId });
      hasOptimistic = true;
      const res: any = await (window.api as any)?.db?.moveTaskInWorkspaceTree?.({ taskId, targetSpaceId, targetIndex });
      if (res && res.ok === false) {
        set((s) => {
          const restored = s.tasks.map((cur) => {
            if (cur.id === taskId) {
              const prev = prevById.get(cur.id)!;
              return { ...cur, spaceId: prev.spaceId, spaceSortOrder: prev.spaceSortOrder, updatedAt: prev.updatedAt };
            }
            if (newSiblingIds.has(cur.id) || oldSiblingIds.has(cur.id)) {
              const prev = prevById.get(cur.id);
              if (prev) return { ...cur, spaceSortOrder: prev.spaceSortOrder };
            }
            return cur;
          });
          // P2-3 精确回退（展开集合）+ P2-1 homeSpaceId 回滚
          const curExpanded = s.expandedSpaceIds;
          const wasExpanded = targetSpaceId ? prevExpanded.includes(targetSpaceId) : false;
          const isNowExpanded = targetSpaceId ? curExpanded.includes(targetSpaceId) : false;
          let restoredExpanded = curExpanded;
          if (targetSpaceId && !wasExpanded && isNowExpanded) {
            restoredExpanded = curExpanded.filter((id) => id !== targetSpaceId);
            saveSidebarExpanded(restoredExpanded);
          }
          const restoredHomeSpaceId = isActiveTask ? prevHomeSpaceId : s.homeSpaceId;
          return { tasks: restored, pinnedTaskIds: restored.filter((t) => t.isFavorited).map((t) => t.id), expandedSpaceIds: restoredExpanded, homeSpaceId: restoredHomeSpaceId };
        });
        result = { ok: false as const, error: res.error || "移动任务失败" };
        return result;
      }
      result = { ok: true as const };
      return result;
    } catch (err) {
      if (hasOptimistic) {
        set((s) => {
          const restored = s.tasks.map((cur) => {
            if (cur.id === taskId) {
              const prev = prevById.get(cur.id)!;
              return { ...cur, spaceId: prev.spaceId, spaceSortOrder: prev.spaceSortOrder, updatedAt: prev.updatedAt };
            }
            if (newSiblingIds.has(cur.id) || oldSiblingIds.has(cur.id)) {
              const prev = prevById.get(cur.id);
              if (prev) return { ...cur, spaceSortOrder: prev.spaceSortOrder };
            }
            return cur;
          });
          const curExpanded = s.expandedSpaceIds;
          const wasExpanded = targetSpaceId ? prevExpanded.includes(targetSpaceId) : false;
          const isNowExpanded = targetSpaceId ? curExpanded.includes(targetSpaceId) : false;
          let restoredExpanded = curExpanded;
          if (targetSpaceId && !wasExpanded && isNowExpanded) {
            restoredExpanded = curExpanded.filter((id) => id !== targetSpaceId);
            saveSidebarExpanded(restoredExpanded);
          }
          const restoredHomeSpaceId = isActiveTask ? prevHomeSpaceId : s.homeSpaceId;
          return { tasks: restored, pinnedTaskIds: restored.filter((t) => t.isFavorited).map((t) => t.id), expandedSpaceIds: restoredExpanded, homeSpaceId: restoredHomeSpaceId };
        });
      }
      result = { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      return result;
    } finally {
      releaseChain();
      pendingMoveTaskIds.delete(taskId);
    }
  },
}));

export function useActiveTask(): Task | null {
  return useAppStore((s) => s.tasks.find((x) => x.id === s.activeTaskId) ?? null);
}

/** P1：三态语义显式 selector，不新增持久化字段。 */
export function useHomeSpaceId(): string | null {
  return useAppStore((s) => s.homeSpaceId);
}
export function useDraftSpaceId(): string | null | undefined {
  return useAppStore((s) => s.draft?.spaceId ?? null);
}
export function useActiveTaskSpaceId(): string | null | undefined {
  return useAppStore((s) => s.tasks.find((x) => x.id === s.activeTaskId)?.spaceId ?? null);
}
export function getActiveTaskSpaceId(): string | null | undefined {
  const s = useAppStore.getState();
  return s.tasks.find((x) => x.id === s.activeTaskId)?.spaceId ?? null;
}
export function getDraftSpaceId(): string | null | undefined {
  return useAppStore.getState().draft?.spaceId ?? null;
}
export function getHomeSpaceId(): string | null {
  return useAppStore.getState().homeSpaceId;
}

let sidebarTasksCache: Task[] = [];

function sameSidebarTask(previous: Task, current: Task): boolean {
  return (
    previous.id === current.id &&
    previous.title === current.title &&
    previous.spaceId === current.spaceId &&
    previous.updatedAt === current.updatedAt &&
    previous.status === current.status &&
    previous.archived === current.archived &&
    previous.doneAckedAt === current.doneAckedAt &&
    getTaskDisplayStatus(previous) === getTaskDisplayStatus(current)
  );
}

function selectSidebarTasks(state: AppState): Task[] {
  const previousById = new Map(sidebarTasksCache.map((task) => [task.id, task]));
  const next = state.tasks.map((task) => {
    const previous = previousById.get(task.id);
    return previous && sameSidebarTask(previous, task) ? previous : task;
  });
  if (
    next.length === sidebarTasksCache.length &&
    next.every((task, index) => task === sidebarTasksCache[index])
  ) {
    return sidebarTasksCache;
  }
  sidebarTasksCache = next;
  return next;
}

/** 侧栏只订阅任务摘要，流式正文增长不会让整棵侧栏重复排序和渲染。 */
export function useSidebarTasks(): Task[] {
  return useAppStore(selectSidebarTasks);
}

/** 文本流更新时数组引用不变，文档与 PDF 预览不会被聊天内容拖着重渲染。 */
const EMPTY_ARTIFACTS: Artifact[] = [];

/**
 * Render hydration 引擎（V3.5 hotfix §6/§7/§12）：
 * store 适配器 + single-flight + stale 防御（descriptor 消失/版本移动 → discard）。
 */
let renderHydration: RenderHydration | null = null;

/** 跨任务按 id 找 descriptor（历史 Artifact/其他 task 打开链） */
function findDescriptorByIdAnyTask(state: AppState, artifactId: string | null): ArtifactDescriptor | null {
  if (!artifactId) return null;
  for (const descriptors of Object.values(state.artifactProjection.artifactsByTask)) {
    const d = descriptors.find((x) => x.id === artifactId);
    if (d) return d;
  }
  return null;
}

function getRenderHydration(): RenderHydration {
  if (renderHydration) return renderHydration;
  renderHydration = createRenderHydration({
    findDescriptor: (artifactId) => findDescriptorByIdAnyTask(useAppStore.getState(), artifactId),
    getCache: (artifactId) => useAppStore.getState().artifactRenderCache[artifactId],
    setCache: (artifactId, payload) => useAppStore.getState().cacheArtifactRender(artifactId, payload),
    removeCache: (artifactId) => {
      useAppStore.setState((s) => {
        if (!(artifactId in s.artifactRenderCache)) return s;
        const next = { ...s.artifactRenderCache };
        delete next[artifactId];
        return { artifactRenderCache: next };
      });
    },
    setLoadState: (artifactId, state, error) => {
      useAppStore.setState((s) => ({
        artifactRenderLoadState: { ...s.artifactRenderLoadState, [artifactId]: state },
        artifactRenderErrors: { ...s.artifactRenderErrors, [artifactId]: error },
      }));
    },
    clearState: (artifactId) => {
      useAppStore.setState((s) => {
        const loads = { ...s.artifactRenderLoadState };
        const errors = { ...s.artifactRenderErrors };
        delete loads[artifactId];
        delete errors[artifactId];
        return { artifactRenderLoadState: loads, artifactRenderErrors: errors };
      });
    },
    readContent: async (artifactId) => {
      const api = window.api?.artifactDomain;
      if (!api?.readContent) return null;
      return api.readContent({ artifactId });
    },
  });
  return renderHydration;
}

/**
 * 3E：task.artifacts 兼容桥退役后，所有产物 reader 统一走 projection 直读。
 * 派生视图 = artifactProjection.artifactsByTask[activeTaskId] + artifactRenderCache（内容快照，非真相）。
 * 缓存 key = descriptors 数组引用 + renderCache 引用：reducer/cacheArtifactRender 才换引用，
 * 流式文本（text_delta）不触发派生视图重建，避免聊天正文拖着重渲染文档/PDF 预览。
 */
let activeArtifactsKey: {
  taskId: string;
  descriptors: ArtifactDescriptor[];
  cache: Record<string, ArtifactRenderPayload>;
} | null = null;
let activeArtifactsCache: Artifact[] = EMPTY_ARTIFACTS;

export function selectActiveTaskArtifacts(state: AppState): Artifact[] {
  const taskId = state.activeTaskId;
  if (!taskId) return EMPTY_ARTIFACTS;
  const descriptors = state.artifactProjection.artifactsByTask[taskId];
  if (!descriptors || descriptors.length === 0) return EMPTY_ARTIFACTS;
  const key = activeArtifactsKey;
  if (
    key &&
    key.taskId === taskId &&
    key.descriptors === descriptors &&
    key.cache === state.artifactRenderCache
  ) {
    return activeArtifactsCache;
  }
  activeArtifactsKey = { taskId, descriptors, cache: state.artifactRenderCache };
  activeArtifactsCache = descriptors.map((d) => toRendererArtifact(d, state.artifactRenderCache[d.id]));
  return activeArtifactsCache;
}

export function useActiveTaskArtifacts(): Artifact[] {
  return useAppStore(selectActiveTaskArtifacts);
}

/**
 * 产物显示过滤版（V3.6）：按任务生效 mode 的 artifactPolicy 过滤（deny 命中/白名单外隐藏）。
 * 用于产物面板列表与消息内产物芯片；变更显示（FileRecordsTable / ChangesView）保持全量不受影响。
 * policy 未缓存时扩展名不过滤（仍隐藏 CAD 临时脚本）；挂载时异步补拉。
 */
let visibleArtifactsKey: {
  taskId: string;
  descriptors: ArtifactDescriptor[];
  cache: Record<string, ArtifactRenderPayload>;
  mode: string | undefined;
  policies: Record<string, ModeArtifactPolicy>;
} | null = null;
let visibleArtifactsCache: Artifact[] = EMPTY_ARTIFACTS;

export function selectVisibleActiveTaskArtifacts(state: AppState): Artifact[] {
  const base = selectActiveTaskArtifacts(state);
  if (base === EMPTY_ARTIFACTS || !state.activeTaskId) return base;
  const task = state.activeTaskId
    ? state.tasks.find((t) => t.id === state.activeTaskId)
    : undefined;
  const mode = task?.welcomeMode ?? state.welcomeMode;
  if (mode === "bot") return base;
  const policy = mode ? state.artifactPolicies[mode] : undefined;
  const taskId = state.activeTaskId;
  const descriptors = state.artifactProjection.artifactsByTask[taskId];
  const key = visibleArtifactsKey;
  if (
    key &&
    key.taskId === taskId &&
    key.descriptors === descriptors &&
    key.cache === state.artifactRenderCache &&
    key.mode === mode &&
    key.policies === state.artifactPolicies
  ) {
    return visibleArtifactsCache;
  }
  const artifactPaths = base.map((a) => a.path ?? a.name);
  const filtered = base.filter((a) =>
    artifactVisibleForDisplay(a.path ?? a.name, policy, artifactPaths),
  );
  visibleArtifactsKey = {
    taskId,
    descriptors,
    cache: state.artifactRenderCache,
    mode,
    policies: state.artifactPolicies,
  };
  visibleArtifactsCache = filtered;
  return filtered;
}

/** 产物面板 / 消息芯片专用（过滤版）；变更显示仍用 useActiveTaskArtifacts 全量 */
export function useVisibleTaskArtifacts(): Artifact[] {
  const mode = useAppStore(
    (s) => s.tasks.find((t) => t.id === s.activeTaskId)?.welcomeMode ?? s.welcomeMode,
  );
  const refreshArtifactPolicy = useAppStore((s) => s.refreshArtifactPolicy);
  useEffect(() => {
    if (mode) void refreshArtifactPolicy(mode);
  }, [mode, refreshArtifactPolicy]);
  return useAppStore(selectVisibleActiveTaskArtifacts);
}

/** 3E：按 id 从 projection 找当前任务 artifact（appStore 内部 reader，不再读 task.artifacts） */
function findActiveTaskArtifact(state: AppState, id: string | null): Artifact | undefined {
  if (!id || !state.activeTaskId) return undefined;
  const descriptors = state.artifactProjection.artifactsByTask[state.activeTaskId];
  if (!descriptors) return undefined;
  const descriptor = descriptors.find((d) => d.id === id);
  if (!descriptor) return undefined;
  return toRendererArtifact(descriptor, state.artifactRenderCache[descriptor.id]);
}

export function relativeTime(ts: number, opts?: { compact?: boolean }): string {
  const diff = Date.now() - ts;
  const MIN = 60_000;
  // compact：去掉「前」字的短格式（侧栏任务行右侧标签），完整格式用于表格/tooltip
  const suffix = opts?.compact ? "" : "前";
  if (diff < MIN) return "刚刚";
  if (diff < 60 * MIN) return `${Math.floor(diff / MIN)}分钟${suffix}`;
  if (diff < 24 * 60 * MIN) return `${Math.floor(diff / (60 * MIN))}小时${suffix}`;
  return `${Math.floor(diff / (24 * 60 * MIN))}天${suffix}`;
}

export function clockTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function sizeLabel(content: string): string {
  // 未打开的 workspace-file 产物 content 为空（内容在 renderCache）；勿显示误导性的「0 B」
  if (!content) return "—";
  // data URI：按 base64 有效载荷估算真实字节，避免把整段 URI 当 UTF-8 文本量
  const dataUri = /^data:[^;]*;base64,([\s\S]+)$/i.exec(content);
  if (dataUri) {
    const b64 = dataUri[1]!.replace(/\s+/g, "");
    const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
    const bytes = Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  const bytes = new TextEncoder().encode(content).length;
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** 从 SVG/HTML 源码猜测产物文件名 */
function guessCanvasArtifactName(content: string, kind: "html" | "svg"): string {
  const titleMatch =
    /<title[^>]*>([^<]+)<\/title>/i.exec(content) ??
    /<text[^>]*>([^<]{2,40})<\/text>/i.exec(content);
  const raw = titleMatch?.[1]?.replace(/\s+/g, " ").trim();
  if (raw) return raw.slice(0, 48);
  return kind === "svg" ? "流程图" : "画布";
}
