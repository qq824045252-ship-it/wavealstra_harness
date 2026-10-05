export type ToolStatus = "pending_approval" | "running" | "success" | "error" | "denied";

export interface ToolCall {
  id: string;
  parentToolCallId?: string;
  /** 工具名，如 bash / write / edit */
  tool: string;
  /** 展示给用户的一行摘要，如命令内容或文件路径 */
  summary: string;
  detail?: string;
  output?: string;
  consult?: import("../../shared/multi-model-consult").MultiModelConsultReport;
  webSearch?: import("../../shared/web-search").WebSearchReport;
  status: ToolStatus;
  /** 是否为需要审批的危险操作 */
  dangerous?: boolean;
  /** 审批类型：外部写授权（三按钮：拒绝 / 允许一次 / 始终允许此文件夹） */
  approvalKind?: "external-write" | "acp";
  /** ACP permission request 所属 external run。 */
  externalRunId?: string;
  /** ACP Agent 原生权限选项。 */
  acpPermissionOptions?: import("../../shared/external-agent").ExternalAgentPermissionOptionDto[];
  /** approvalKind=external-write：请求写入的目标绝对路径 */
  targetPath?: string;
  /** approvalKind=external-write：当前任务工作目录 */
  taskRoot?: string;
  /** approvalKind=external-write：建议持久授权的 canonical 目录 */
  canonicalDir?: string;
}

export type ArtifactKind =
  | "markdown"
  | "code"
  | "html"
  | "svg"
  | "image"
  | "video"
  | "audio"
  | "table"
  | "pdf"
  | "docx"
  | "xlsx"
  | "pptx"
  | "cad";

export interface Artifact {
  id: string;
  name: string;
  kind: ArtifactKind;
  /** 文本类 artifact 的内容；图片为 data URL 或路径 */
  content: string;
  language?: string;
  /** 主进程解析/在资源管理器中定位所需的真实绝对路径 */
  path?: string;
  /** Domain capabilities（3C：canvas/cad 细分；renderer 只读展示用，非真相） */
  capabilities?: Record<string, unknown>;
}

export interface FileTableRow {
  file: string;
  summary: string;
  artifactId?: string;
}

export type MessageBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; toolCall: ToolCall }
  | { type: "file_table"; title?: string; rows: FileTableRow[] }
  | { type: "detail"; title: string; content: string; contentKind?: "markdown" | "html" }
  | { type: "callout"; variant: "warning" | "info"; title?: string; text: string };

export interface Attachment {
  name: string;
  path?: string;
}

/**
 * 已「加入聊天」的抓取元素（Capture Mode Selection 的结构化引用；
 * 发送时主进程经 PromptContextService 解析；不携带 DOM/整页内容）。
 */
export interface ChatSelection {
  comment?: string;
  artifactId: string;
  artifactVersion: number;
  surfaceGeneration: number;
  /** 元素级身份（4D canonical identity；同页内区分不同元素） */
  backendNodeId?: number;
  /** 芯片展示：tag#id.class */
  label: string;
  /** pending = 待发送；stale = 已失效（页面更新/删除），发送时跳过 */
  status: "pending" | "stale";
}

export type TaskReferenceFileSource = "artifact" | "attachment" | "change";

/** 一条用户消息中已应用的任务引用（只保存展示元数据，正文上下文仍走 prompt） */
export interface TaskReferenceFile {
  id: string;
  name: string;
  path?: string;
  source: TaskReferenceFileSource;
}

export interface TaskReference {
  taskId?: string;
  title: string;
  /** 任务所属空间；无空间任务不填 */
  spaceName?: string;
  files: TaskReferenceFile[];
}

/** 用户消息中「终端 → 加入对话」的展示摘要（正文仍由主进程注入 Agent，气泡不展开全文） */
export interface MessageTerminalContext {
  source: "selection" | "recent-output";
  charCount: number;
  /** 悬停预览（截断） */
  preview?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  /** 用户消息附带的文件 */
  attachments?: Attachment[];
  /** 本条用户消息应用的任务引用；只在气泡中显示任务/文件摘要，不展开引用任务正文 */
  taskReferences?: TaskReference[];
  /**
   * 本条用户消息附带的终端上下文摘要（发送时从 pending terminalContext 落盘到气泡；
   * 全文只进 Agent prompt，不在 UI 展开）。
   */
  terminalContext?: MessageTerminalContext;
  /** 本条用户消息附带的抓取元素标签（发送时从 pending selections 落盘到气泡）。 */
  selectionLabels?: string[];
  /** @deprecated 兼容内存中的旧消息。 */
  selectionLabel?: string;
  /**
   * 本条消息挂载的技能 command（气泡芯片；正文不展示 /cmd 前缀）。
   * 发送时从 prompt 前缀解析写入；历史恢复时从 user text 再解析。
   */
  skillCommands?: string[];
  /** 本条消息挂载的 MCP 名（气泡芯片） */
  mcpNames?: string[];
  /** 本条消息挂载的连接器名（气泡芯片） */
  connectorNames?: string[];
  /**
   * 本条用户气泡上的专家芯片（仅首次挂载或切换专家时写入；
   * 同专家后续消息不重复贴，与技能/MCP 每条跟发送走不同）。
   */
  expert?: { id: string; name: string; emoji?: string };
  /** 执行过程（折叠在「已完成 xx」时间线里）：思考、工具调用、过程性说明 */
  blocks: MessageBlock[];
  /** 主进程分配的单轮执行 id；Interaction 不允许跨 execution 归属。 */
  executionId?: string;
  interactions?: import("../../shared/conversation-interaction").ConversationInteractionDto[];
  /** 最终回复（时间线之外的正文） */
  finalBlocks?: MessageBlock[];
  /** 本条消息关联的产物 id */
  artifactIds?: string[];
  /** 文件变更数（查看所有变更入口） */
  changesCount?: number;
  /** 执行耗时标签，如 1m26s */
  durationLabel?: string;
  presentationKey?: string;
  /** 生成本条消息的模型名 */
  modelName?: string;
  /** 外部 Agent（ACP）来源。存在时该助手消息不是 MyBuddy/Pi 主 Agent。 */
  externalAgent?: { id: string; name: string; protocol: "acp"; runId?: string; continuationMode?: "new" | "resume" | "load" | "fallback_new"; sessionReady?: boolean; resumeSupported?: boolean; recoveryState?: import("../../shared/external-agent").DelegatedRunRecoveryState; verificationStatus?: import("../../shared/external-agent").DelegatedRunVerificationStatus; outputCursor?: number };
  createdAt: number;
  /** 助手消息是否仍在生成中 */
  streaming?: boolean;
  /** 已提交但尚未收到主进程 assistant_start 的运行中追加消息。 */
  pendingBehavior?: "steer" | "followUp";
  /** 重新生成失败的用户可见错误（两阶段提交失败时挂在源助手消息上，原回复保留）。 */
  generateError?: string;
  /** Live session telemetry, scoped to this reply; not reconstructed from historical text. */
  generationStats?: import("../../shared/generation-stats").GenerationStats;
  /**
   * 会话分支锚点：真实 Pi session entry id（历史恢复时由 loadTaskHistory 透传；
   * 新回合无持久 entry 时不设置）。
   */
  entryId?: string;
}

export interface FileChange {
  id: string;
  name: string;
  additions: number;
  deletions: number;
}

export interface Task {
  durable?: import("../../shared/durable-bot").DurableBotSnapshot;
  /** Transport/configuration errors before Durable accepts an input, not execution state. */
  botInputError?: string;
  id: string;
  title: string;
  /** 所属空间；无则显示在「任务」分组 */
  spaceId?: string;
  /** 长期 Project 上下文；与 Space 正交。 */
  projectId?: string;
  /** 任务状态（筛选与展示） */
  status?: TaskStatus;
  updatedAt: number;
  messages: ChatMessage[];
  /** Task 跨轮长期目标；与 Project Goal 完全独立。 */
  activeGoal?: import("../../shared/conversation-goal").ConversationGoalDto;
  /** 右侧栏概览中的任务进程 */
  progressSteps?: ProgressStep[];
  /** 文件变更列表（变更面板） */
  fileChanges?: FileChange[];
  /** pi session jsonl 路径，重启后用于恢复 */
  sessionFile?: string;
  /** 会话 JSONL 只读恢复告警；原文件不会被历史加载逻辑修改。 */
  sessionRecovery?: import("../../shared/agent-ipc").SessionHistoryRecoveryDto;
  cwd?: string;
  modelId?: string;
  permissionMode?: import("../../shared/agent-ipc").PermissionMode;
  welcomeMode?: import("../../shared/agent-ipc").WelcomeMode;
  /** true = 已归档（从侧栏隐藏，数据保留，可在设置中恢复） */
  archived?: boolean;
  /** 会话绑定的专家 id；无 = 默认人设 */
  expertId?: string;
  /**
   * 气泡已公告过的专家 id（会话内 UI 态，不落库）。
   * 发送时仅 expertId 与此不同才贴专家芯片；取消专家时清空以便再次引用可再贴。
   */
  lastAnnouncedExpertId?: string;
  /** 选中场景预设 id（Design Mode）；非 design 任务为 null */
  modePresetId?: string | null;
  /** 计划开始日（当地 0 点 ms） */
  startAt?: number;
  /** 计划截止日（当地 0 点 ms，含当天） */
  dueAt?: number;
  /** 本任务 Active 连接器 id（任务级；持久化于 settings.json taskConnectorIds，无新 DB schema） */
  connectorIds?: string[];
  /** V2 Workspace Tree：任务在所属空间下的显式排序键（0=未显式，回退 updatedAt；不参与跨空间全局排序） */
  spaceSortOrder?: number;
  /** 固定/收藏：复用 DB is_favorited 冻结列，重启后持久；仅作展示层置顶（selector compareMixed 置顶），不改写 spaceSortOrder/sortOrder 持久排序键 */
  isFavorited?: boolean;
  /** 当前一次运行被统一策略拒绝的显式能力选择；仅 UI 态，不落库。 */
  capabilityNotices?: import("../../shared/agent-ipc").CapabilityPolicyNoticeDto[];
  /** 用户是否在本任务内显式选择过模型（setActiveModel 置 true；「跟随场景建议」复位） */
  modelExplicit?: boolean;
  /** 用户是否在本任务内显式选择过权限（setPermissionMode 置 true；「跟随场景建议」复位） */
  permissionExplicit?: boolean;
  /** ACP 外部 Agent 任务级固定：存在时本任务每轮自动路由该 Agent 并续接最近可恢复 run；undefined = 未固定（DB 列 external_agent_pin_json） */
  externalAgentPin?: import("../../shared/external-agent").ExternalAgentPinDto;
}

export type TaskStatus = "in_progress" | "completed" | "failed" | "pending" | "planning";

export interface ProgressStep {
  id: string;
  text: string;
  status: "done" | "running" | "pending";
}

export type TaskFilterStatus = "all" | TaskStatus;
export type TaskFilterTime = "all" | "today" | "7d" | "30d";

export interface Space {
  id: string;
  name: string;
  /** 本地文件夹绝对路径（「打开本地文件夹」时写入） */
  path?: string;
  /** true = 已归档（从空间列表隐藏，数据保留，可在设置中恢复） */
  archived?: boolean;
  /** 已绑路径但目录当前不存在（文件夹被挪走/改名） */
  pathMissing?: boolean;
  /** V2 Workspace Tree：直接父空间 id；null = 根空间 */
  parentId?: string | null;
  /** V2 Workspace Tree：同父下显式排序键（1000 步进）— 权威排序键，不受 isFavorited 影响 */
  sortOrder?: number;
  /** DB created_at 映射（可选，供 selector tie-break 与 DB 对齐） */
  createdAt?: number;
  /** V2 Archive：effective = 自身或任一祖先已归档 */
  effectiveArchived?: boolean;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  author: string;
  icon: string;
  installed: boolean;
  enabled: boolean;
  builtin?: boolean;
  /** / 命令触发词 */
  command?: string;
  filePath?: string;
  /** 来源标记：manual=本地导入 | builtin-market | local-market | connector:<id> */
  source?: string;
  /** 市场来源版本号 */
  version?: string;
}

/** 已安装专家 */
export interface Expert {
  id: string;
  name: string;
  description: string;
  author: string;
  emoji: string;
  tags: string[];
  category?: string;
  version?: string;
  examples?: string[];
  enabled: boolean;
  installed: boolean;
  source?: string;
  installedAt?: number;
  filePath?: string;
  /** 专家包自带 Private Skills 目录名（~/.mybuddy/experts/<id>/skills/ 下，不进入全局 Skill Center） */
  skills?: string[];
}

/** 市场中的专家 */
export interface MarketExpert extends Omit<Expert, "installed" | "enabled"> {}


/** Pi runtime transport level; not a product reasoning preference. */
export type ThinkingLevel = string;

export interface ModelConfig {
  id: string;
  name: string;
  vendor: string;
  supportsToolCall?: boolean;
  supportsImages: boolean;
  supportsReasoning: boolean;
  /** 模型是否在普通选择器中启用；缺省视为启用。 */
  enabled?: boolean;
  /** 模型上下文窗口；0/undefined 表示未知，不再伪造 128K。 */
  contextWindow?: number;
  /** 实际传输协议。 */
  api?: string;
  /** Runtime transport levels；模型事实请读取 metadata.reasoningOptions。 */
  thinkingLevels?: string[];
  /** Pi runtime / manual provenance + provider-resolved facts. */
  metadata?: import("../../shared/model-metadata").ModelMetadataDto;
}

export type WelcomeMode = "working" | "coding" | "bot";

/** 助理人设（对应数据目录中的 SOUL.md / IDENTITY.md） */
export interface Soul {
  name: string;
  /** 助理对用户的称呼 */
  alias: string;
  persona: string;
}

export type PermissionMode = "default" | "readonly" | "auto";

export type Page =
  | "chat"
  | "assistant"
  | "projects"
  | "experts"
  | "skills"
  | "mcp"
  | "connectors"
  | "automation"
  | "files"
  | "mailbox"
  | "library"
  | "gadgets"
  | "memory"
  | "workspace";
