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

/** ACP 权限应答策略（电脑端「ACP 管理」设置；手机端只读展示） */
export type RemoteAcpPermissionPolicy = 'ask' | 'auto-allow' | 'auto-deny'

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
  /** 权限策略：ask = 每次弹审批；auto-* = 电脑端按策略自动应答（手机端不再被打断） */
  permissionPolicy?: RemoteAcpPermissionPolicy
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

/** 手机端修改某 Agent 的权限策略（写电脑端设置；下一次权限请求立即生效） */
export interface RemoteAcpPermissionUpdate {
  policy: RemoteAcpPermissionPolicy
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
  /**
   * 带 beforeEntryId 读取「更早历史块」时的块元数据：顶层 messages 就是该块，
   * before 是该块之前（更早）的下一页游标，undefined = 已到最老。
   * 远端只能把这个块追加到列表前端，不能把它当成整页替换。
   */
  page?: { epoch: string; before?: number }
  imageArtifacts?: RemoteImageArtifact[]
  /**
   * 历史**完全打不开**时的人类可读原因。服务端必须如实回传，否则远端会把真实的存储/模型故障
   * 伪装成「空会话」，与桌面端「会话记录打不开」不一致。旧客户端忽略该字段（向后兼容）。
   */
  historyError?: string
  /** 任务当前实际使用的模型（provider/id）；服务端修复失效坐标后回传，供远端校正模型显示。 */
  modelId?: string
}

export interface RemoteDurableSnapshot {
  backend: 'pi-durable'
  epoch: string
  revision: number
  conversationId: string
  toolMode: 'native' | 'codemode'
  busy: boolean
  status?: 'idle' | 'running' | 'queued' | 'retrying' | 'waiting_input' | 'stopped' | 'failed' | 'completed'
  historyBefore?: number
  queued: number
  pendingInputs: Array<{ id: string; mode: 'steer' | 'followUp'; text: string }>
  retry?: { at: number; error: string }
  compacting: boolean
  messages: RemoteHistoryMessage[]
  error?: string
  outcome?: 'completed' | 'failed' | 'aborted'
}

export type RemoteDurableState = Omit<RemoteDurableSnapshot, 'epoch' | 'revision' | 'messages'>
export type RemoteDurableDelta = import('./durable-sync').DurableStreamDelta<RemoteHistoryMessage, RemoteDurableState>

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

export interface RemoteModelSetting extends RemoteModelSummary {
  enabled: boolean
  available: boolean
}

export interface RemoteModelRefreshResult {
  models: RemoteModelSummary[]
  errors: Array<{ providerId: string; message: string }>
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
  /** One business input, persisted by the client before POST and reused after a lost response. */
  operationId: string
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
  receipt: { taskId: string; operationId: string; submissionId: number; status: 'queued' | 'placed' | 'done' | 'unanswered' }
  cancelled?: boolean
  error?: { code: string; message: string }
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

/** 桌面端“允许新设备接入”窗口：一次性 6 位配对码 + 到期时间 */
export interface RemotePairWindowDto {
  code: string;
  expiresAt: number
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

export interface RemoteStatus {
  configuredEnabled: boolean
  running: boolean
  /** 服务固定监听 127.0.0.1；手机端通过 Tailscale Serve / Cloudflare 域名反代访问 */
  port: number
  baseUrl: string
  error?: string
}

export interface RemotePairingSession {
  pairingId: string
  secret: string
  expiresAt: number
  pairingUrl: string
}

export interface RemoteConfigureRequest {
  enabled?: boolean
  port?: number
  baseUrl?: string
}

export const RemoteAccessIpc = {
  status: 'remoteAccess:status',
  configure: 'remoteAccess:configure',
  listDevices: 'remoteAccess:listDevices',
  revokeDevice: 'remoteAccess:revokeDevice',
  createPairingSession: 'remoteAccess:createPairingSession',
  cancelPairingSession: 'remoteAccess:cancelPairingSession',
  openPairWindow: 'remoteAccess:openPairWindow',
  closePairWindow: 'remoteAccess:closePairWindow',
  pairWindowState: 'remoteAccess:pairWindowState',
} as const

// ---------------------------------------------------------------- Work (Bot)

/**
 * Work sync contract for paired devices.
 *
 * The cursor belongs to the host's durable projection journal: `epoch` changes when the
 * host replaces its stream, `scope` says which view the cursor was read in. A client must
 * replace its whole set whenever the cursor's epoch/scope no longer matches, and must never
 * treat an SSE event id as a Work cursor.
 */
export interface RemoteWorkCursor {
  epoch: string
  sequence: number
  scope: 'open' | 'all'
}

export interface RemoteWorkCard {
  cardKey: string
  semanticCardKey: string
  kind: 'accepted_result' | 'closure_succeeded' | 'closure_cancelled' | 'closure_failed' | 'blocked_escalation' | 'owner_summary'
  previousCardKey?: string
  intentRevision: number
  inputSnapshotId: string
  title: string
  summary: string
  deliverables: string[]
  artifacts: string[]
  unverifiedScope: string[]
  currency: 'current' | 'historical' | 'superseded'
  createdAt: number
  readAt?: number
  readVersion: number
}

export interface RemoteWorkSummary {
  workId: string
  title: string
  goal?: string
  lifecycle: 'active' | 'paused' | 'closing' | 'closed'
  closureConclusion?: 'succeeded' | 'cancelled' | 'ended_unsuccessfully'
  mode: 'once' | 'watch'
  ownerEpoch: number
  intentRevision: number
  inputSnapshotId: string
  artifactSnapshotId?: string
  stateVersion: number
  acceptedCount: number
  currentCardKeys: string[]
  currentConclusion?: string
  pendingUserDecisions: string[]
  nextSteps: string[]
  unverifiedScope: Array<{ criterionId: string; text: string; reason: string; requiredEnvironment?: string }>
  delivery: Array<{
    notificationId: string
    cardKey?: string
    kind: 'result' | 'blocked' | 'closed' | 'handoff' | 'summary'
    state: 'pending' | 'sent' | 'unknown' | 'failed'
    externalStatus: 'not_requested' | 'in_app_only' | 'waiting_receipt' | 'delivered' | 'unconfirmed_no_auto_retry' | 'failed'
    attemptCount: number
    readAt?: number
  }>
  cards: RemoteWorkCard[]
  updatedAt: number
  closedAt?: number
}

export type RemoteWorkUpdate =
  | { kind: 'snapshot'; cursor: RemoteWorkCursor; works: RemoteWorkSummary[] }
  | {
    kind: 'delta'
    cursor: RemoteWorkCursor
    from: number
    hasMore: boolean
    events: Array<{ kind: 'upsert'; sequence: number; work: RemoteWorkSummary } | { kind: 'remove'; sequence: number; workId: string; reason: 'closed' | 'removed' }>
  }
  | { kind: 'resync_required' }

export interface RemoteWorkCardReadRequest {
  workId: string
  semanticCardKey: string
  readAt?: number
}

export interface RemoteWorkCardReadResult {
  ok: boolean
  message?: string
  cardKey?: string
  readAt?: number
  readVersion?: number
}

export interface RemoteWorkFeedbackRequest {
  operationId: string
  workId: string
  criterionIds: string[]
  environment: string
  sourceRef: string
  inputSnapshotId: string
  artifactSnapshotId?: string
  versionGuard: RemoteWorkVersionGuard
  failed: boolean
  detail?: string
}

export interface RemoteWorkResendRequest {
  operationId: string
  notificationId: string
  reason: string
  acknowledgedDuplicateRisk: true
  versionGuard: RemoteWorkVersionGuard
}

/** The control version the user actually reviewed before confirming an action. */
export interface RemoteWorkVersionGuard {
  expectedStateVersion: number
  expectedIntentRevision: number
  expectedOwnerEpoch: number
}

export interface RemoteWorkControlResult {
  ok: boolean
  code?: string
  message?: string
  replayed?: boolean
}
