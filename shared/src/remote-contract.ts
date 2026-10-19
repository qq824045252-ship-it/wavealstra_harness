export const REMOTE_API_VERSION = 1 as const

export type RemoteConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'unauthorized'

export interface RemoteServerInfo {
  apiVersion: typeof REMOTE_API_VERSION
  service: 'mybuddy-remote'
  name: string
  now: number
}

export interface RemoteSpaceSummary {
  id: string
  name: string
  archived: boolean
  parentId: string | null
  sortOrder: number
  effectiveArchived: boolean
  pathMissing: boolean
}

export interface RemoteProjectSummary {
  id: string
  name: string
  description?: string
  updatedAt: number
  archived: boolean
}

export interface RemoteTaskSummary {
  id: string
  title: string
  spaceId: string | null
  projectId: string | null
  status?: string
  updatedAt: number
  welcomeMode?: 'working' | 'coding' | 'bot'
  modelId?: string
  permissionMode?: 'default' | 'readonly' | 'auto'
  archived: boolean
  expertId?: string
  modePresetId: string | null
  startAt: number | null
  dueAt: number | null
  isFavorited: boolean
  /**
   * 「已结束」绿点的确认水位（tasks.done_acked_at，unix ms；null = 从未查看过结果）。
   * 手机端规则与桌面一致：已结束 且 doneAckedAt(或本机确认水位) < updatedAt → 绿点；
   * 打开任务时 POST /v1/tasks/:id/ackDone 推进该值 → 绿点消失并持久到同一张 tasks 表。
   */
  doneAckedAt: number | null
  busy: boolean
  pendingActionCount: number
}

export interface RemoteToolCall {
  id: string
  tool: string
  summary: string
  detail?: string
  output?: string
  status: string
}

/**
 * ACP（Agent Client Protocol）外部 Agent 在手机端的投影。
 * 手机端只做「选 Agent → 发指令 → 看流式输出 → 审批权限」，进程与 session 始终在电脑端。
 */
export type RemoteAcpAgentAvailability = 'ready' | 'missing' | 'adapter'

export interface RemoteAcpAgentSummary {
  id: string
  name: string
  protocol: 'acp'
  /** 电脑端是否检测到可启动的 ACP runtime（CLI / adapter） */
  available: boolean
  availability: RemoteAcpAgentAvailability
  /** ACP 管理页开关；停用后不出现在手机端选择器 */
  enabled: boolean
  detail?: string
  commandLabel: string
  /** Agent 声明的会话配置项名（模型/会话模式等），仅展示用 */
  configOptionNames: string[]
}

/** ACP 授权请求的一项可选动作（kind 决定放行/拒绝与持久范围） */
export interface RemoteAcpPermissionOption {
  optionId: string
  name: string
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
}

/** 消息级 ACP 运行投影：本轮属于哪个外部 Agent、能否续聊、恢复/验证状态 */
export interface RemoteAcpRunInfo {
  runId: string
  agentId: string
  agentName: string
  protocol: 'acp'
  /** starting | working | blocked | completed | failed | cancelled */
  status: string
  sessionReady: boolean
  resumeSupported: boolean
  cancelSupported: boolean
  continuationMode?: 'new' | 'resume' | 'load' | 'fallback_new'
  recoveryState: 'none' | 'resume-available' | 'new-run-required'
  verificationStatus: 'not_verified' | 'workspace_observed'
  commandLabel: string
}

/** 手机端发起一轮 ACP 委托：电脑端用 ExternalAgentRuntime 启动真实 ACP 进程 */
export interface RemoteAcpPromptRequest {
  agentId: string
  text: string
  attachments?: RemoteAttachmentInput[]
  /** 续接上一轮同一 Agent、同一 cwd 的 session；省略或失效则新建 */
  continueFromRunId?: string
  /**
   * 强制开新会话（丢弃上下文）。缺省 false = 自动续接该任务同 Agent 最近一次可恢复 session，
   * 与桌面端「固定 ACP」语义一致：进程每轮都会新起，但会话上下文默认延续。
   */
  newSession?: boolean
}

export interface RemoteAcpPromptResponse {
  run: RemoteAcpRunInfo
  userMessageId: string
  assistantMessageId: string
}

/** 新建任务并直接交给 ACP 外部 Agent 执行（首页选好 Agent 后的第一轮） */
export interface RemoteAcpCreateRequest extends RemoteAcpPromptRequest {
  spaceId?: string
  projectId?: string
  welcomeMode?: 'working' | 'coding' | 'bot'
  modePresetId?: string | null
}

export interface RemoteAcpCreateResponse extends RemoteAcpPromptResponse {
  task: RemoteTaskSummary
}

export interface RemoteArtifactMetadata {
  id: string
  name: string
  kind?: string
}

/** Authenticated raster image projection. Sources are comparison aliases, never fetch targets. */
export interface RemoteImageArtifact extends RemoteArtifactMetadata {
  kind: 'image'
  version: number
  mimeType?: string
  sources: string[]
  createdByMessageId?: string
  createdByToolCallId?: string
}

export interface RemoteHistoryMessage {
  streaming?: boolean
  id: string
  role: 'user' | 'assistant'
  text: string
  thinking?: string
  modelName?: string
  createdAt: number
  durationMs?: number
  tools?: RemoteToolCall[]
  artifacts?: RemoteArtifactMetadata[]
  attachments?: Array<{ name: string }>
  /** 本轮由 ACP 外部 Agent 执行时的运行投影（内置 Pi 轮次为 undefined） */
  acp?: RemoteAcpRunInfo
}

export interface RemoteTaskHistory {
  durable?: RemoteDurableSnapshot
  taskId: string
  messages: RemoteHistoryMessage[]
  imageArtifacts?: RemoteImageArtifact[]
}

export interface RemoteDurableSnapshot {
  backend: 'pi-durable'
  epoch: string
  revision: number
  conversationId: string
  toolMode: 'native' | 'codemode'
  busy: boolean
  queued: number
  pendingInputs: Array<{ id: string; mode: 'steer' | 'followUp'; text: string }>
  retry?: { at: number; error: string }
  compacting: boolean
  messages: RemoteHistoryMessage[]
  error?: string
}

export interface RemotePendingAction {
  taskId: string
  assistantMessageId: string
  toolCallId: string
  tool: string
  summary: string
  detail?: string
  dangerous: boolean
  /**
   * tool = 内置 Pi 工具审批；external-write = 目录级写入授权；
   * acp = ACP 外部 Agent 的权限请求，必须用 optionId 回传（见 RemoteAcpPermissionOption）。
   */
  approvalKind: 'tool' | 'external-write' | 'acp'
  createdAt: number
  externalWrite?: {
    targetPath: string
    taskRoot: string
    canonicalDir?: string
  }
  /** approvalKind === 'acp' 时的运行标识与候选动作 */
  acpRunId?: string
  acpPermissionOptions?: RemoteAcpPermissionOption[]
}

export type RemoteConversationInteractionKind =
  | 'confirm'
  | 'single_select'
  | 'multi_select'
  | 'short_text'
  | 'long_text'

export interface RemoteConversationInteractionOption {
  id: string
  label: string
  description?: string
  recommended?: boolean
  disabled?: boolean
}

export type RemoteConversationInteractionStatus = 'pending' | 'resolved' | 'cancelled' | 'expired'
export type RemoteConversationInteractionAnswer = boolean | string | string[]

export interface RemoteConversationInteraction {
  id: string
  taskId: string
  executionId: string
  assistantMessageId: string
  kind: RemoteConversationInteractionKind
  title: string
  description?: string
  options: RemoteConversationInteractionOption[]
  minSelections?: number
  maxSelections?: number
  allowCustom?: boolean
  customPlaceholder?: string
  status: RemoteConversationInteractionStatus
  answer?: RemoteConversationInteractionAnswer
  version: number
  createdAt: number
  resolvedAt?: number
}

export type RemoteConversationInteractionMutationResult =
  | { ok: true; interaction: RemoteConversationInteraction }
  | { ok: false; code: 'not_found' | 'already_resolved' | 'invalid_answer'; message: string }

export interface RemoteRuntimeSnapshot {
  taskId: string
  busy: boolean
  interactions: RemoteConversationInteraction[]
  activeGoal: unknown | null
  pendingActions: RemotePendingAction[]
  /** 当前活着的 ACP 外部 Agent 轮次（无则为 null）；手机端据此显示 Agent 胶囊与停止按钮 */
  acpRun?: RemoteAcpRunInfo | null
}

export interface RemoteNotification {
  id: string
  type: string
  level: string
  title: string
  body?: string
  taskId?: string
  projectId?: string
  workspaceId?: string
  createdAt: number
  readAt?: number
}

export interface RemoteDeviceSummary {
  id: string
  name: string
  createdAt: number
  lastSeenAt: number
  revokedAt?: number
  capabilities: string[]
}

export interface RemoteModelSummary {
  id: string
  name: string
  vendor: string
  contextWindow?: number
  supportsReasoning: boolean
  supportsImages: boolean
}

export type RemoteWelcomeMode = 'working' | 'coding' | 'bot'

/** Display/configuration metadata only. Execution remains owned by the selected runtime. */
export interface RemoteTaskMode {
  id: RemoteWelcomeMode
  label: string
  tags: Array<{ id: string; label: string; description?: string }>
}

export interface RemoteBootstrap {
  apiVersion: typeof REMOTE_API_VERSION
  server: RemoteServerInfo
  spaces: RemoteSpaceSummary[]
  projects: RemoteProjectSummary[]
  tasks: RemoteTaskSummary[]
  unreadNotificationCount: number
  device: RemoteDeviceSummary
  /** 服务端可用聊天模型目录（白名单投影）；手机端模型选择器数据源 */
  models: RemoteModelSummary[]
  /** settings.defaultModelId；空表示尚未配置 */
  defaultModelId: string | null
  /** settings.permissionMode；手机端 Tool access 初始状态 */
  defaultPermissionMode: 'default' | 'readonly' | 'auto'
  /** Optional for older hosts; new clients require the catalog before creating tasks. */
  taskModes?: RemoteTaskMode[]
  /**
   * ACP 外部 Agent 目录（ACP 管理页开关已合并）。旧电脑端没有该字段 → 手机端隐藏 ACP 入口；
   * 空数组表示电脑端已升级但当前没有可用/已启用的 ACP Agent。
   */
  acpAgents?: RemoteAcpAgentSummary[]
}

/** 远程附件输入：data 为 base64（不带 dataUrl 前缀） */
export interface RemoteAttachmentInput {
  name: string
  data: string
  mimeType?: string
}

export interface RemotePromptRequest {
  text: string
  spaceId?: string
  projectId?: string
  welcomeMode?: 'working' | 'coding' | 'bot'
  modePresetId?: string | null
  /** 显式指定模型（须在服务端 models 目录内）；缺省跟随任务/服务端默认 */
  modelId?: string
  /** 显式权限模式；缺省跟随任务/服务端默认 */
  permissionMode?: 'default' | 'readonly' | 'auto'
  /** 随消息上传的附件；服务端落盘后交给 agent */
  attachments?: RemoteAttachmentInput[]
}

export interface RemotePromptResponse {
  task: RemoteTaskSummary
  userMessageId: string
  assistantMessageId: string
  queued: boolean
}

export interface RemoteApprovalRequest {
  decision: 'deny' | 'allow-once' | 'allow-task-dir'
  /** approvalKind === 'acp' 时必填：ACP Agent 声明的选项 id（决定放行/拒绝与持久范围） */
  optionId?: string
}

export interface RemotePairRequest {
  pairingId: string
  secret: string
  deviceName: string
  installationId?: string
}

export interface RemotePairResponse {
  deviceId: string
  deviceToken: string
  server: RemoteServerInfo
}

export type RemoteEventType =
  | 'agent.patch'
  | 'notification.changed'
  | 'task.changed'
  | 'pending_action.changed'
  | 'server.status'
  | 'resync_required'

export interface RemoteEventEnvelope<T = unknown> {
  apiVersion: typeof REMOTE_API_VERSION
  id: number
  at: number
  type: RemoteEventType
  payload: T
}

export type RemoteBindMode = 'loopback' | 'lan'

export interface RemoteStatus {
  configuredEnabled: boolean
  running: boolean
  bindMode: RemoteBindMode
  host: '127.0.0.1' | '0.0.0.0'
  port: number
  baseUrl: string
  lanUrls: string[]
  error?: string
}

export interface RemotePairingSession {
  pairingId: string
  secret: string
  expiresAt: number
  pairingUrl: string
}

export interface RemoteUsbDevice {
  serial: string
  state: string
  product?: string
  model?: string
  device?: string
  transportId?: string
}

export interface RemoteUsbStatus {
  adbAvailable: boolean
  adbPath?: string
  devices: RemoteUsbDevice[]
  error?: string
}

export interface RemoteUsbPairingResult {
  device: RemoteUsbDevice
  session: RemotePairingSession
  port: number
}

export interface RemoteConfigureRequest {
  enabled?: boolean
  port?: number
  baseUrl?: string
  bindMode?: RemoteBindMode
}

export const RemoteAccessIpc = {
  status: 'remoteAccess:status',
  configure: 'remoteAccess:configure',
  listDevices: 'remoteAccess:listDevices',
  revokeDevice: 'remoteAccess:revokeDevice',
  createPairingSession: 'remoteAccess:createPairingSession',
  cancelPairingSession: 'remoteAccess:cancelPairingSession',
  usbStatus: 'remoteAccess:usbStatus',
  pairUsb: 'remoteAccess:pairUsb',
} as const
