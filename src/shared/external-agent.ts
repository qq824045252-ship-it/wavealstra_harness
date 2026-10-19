import type { AgentUiPatch, ChatMessageDto } from "./agent-ipc";

export type ExternalAgentId = "codex" | "claude" | "grok" | "cline" | "opencode" | "devin" | "agy" | "dim" | "command";
export type ExternalAgentProtocol = "acp";
export type ExternalAgentAvailability = "ready" | "missing" | "adapter";
export type ExternalAgentRunStatus = "starting" | "working" | "blocked" | "completed" | "failed" | "cancelled";
export type ExternalAgentContinuationMode = "new" | "resume" | "load" | "fallback_new";
export type DelegatedRunVerificationStatus = "not_verified" | "workspace_observed";
export type DelegatedRunRecoveryState = "none" | "resume-available" | "new-run-required";

export interface DelegatedRunCapabilitiesDto {
  cancelSupported: boolean;
  resumeSupported: boolean;
}

export interface DelegatedRunVerificationDto {
  status: DelegatedRunVerificationStatus;
  /** Observation/verification evidence only; never implies business correctness. */
  message: string;
}

export interface DelegatedRunRecoveryDto {
  state: DelegatedRunRecoveryState;
  message?: string;
}

export interface DelegatedRunDiagnosticsDto {
  protocol: ExternalAgentProtocol;
  commandLabel: string;
  adapterKind?: "native" | "official" | "community";
}

/** ACP 会话级配置项（session/new|load|resume 的 configOptions）归一化后的下拉值。 */
export interface ExternalAgentConfigOptionValueDto {
  value: string;
  name: string;
  description?: string;
  /** select group 展平后保留的分组名。 */
  group?: string;
}

/**
 * ACP 会话级配置项（模型 / 会话模式 / 思考档位等）。
 * select：currentValue 为当前 valueId，options 为可选值（group 已展平）；
 * boolean：currentValue 为 true/false。
 */
export interface ExternalAgentConfigOptionDto {
  id: string;
  name: string;
  description?: string;
  category?: string;
  type: "select" | "boolean";
  currentValue: string | boolean;
  options?: ExternalAgentConfigOptionValueDto[];
}

/** 用户在 ACP 管理页保存的会话选项偏好：configId → value（select valueId 或 boolean）。 */
export type ExternalAgentConfigSelections = Record<string, string | boolean>;

export interface ExternalAgentSetConfigOptionRequest {
  agentId: ExternalAgentId;
  configId: string;
  /** 传入 undefined/null/"" 表示清除偏好，回到 Agent 默认值。 */
  value?: string | boolean | null;
}

const MAX_CONFIG_OPTIONS_PER_AGENT = 24;
const MAX_CONFIG_OPTION_VALUES = 400;

export function normalizeExternalAgentConfigOption(raw: unknown): ExternalAgentConfigOptionDto | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const type = record.type === "boolean" ? "boolean" : record.type === "select" ? "select" : null;
  if (!id || !name || !type) return null;
  const dto: ExternalAgentConfigOptionDto = { id, name, type, currentValue: "" };
  if (typeof record.description === "string" && record.description.trim()) dto.description = record.description;
  if (typeof record.category === "string" && record.category.trim()) dto.category = record.category;
  if (type === "boolean") {
    dto.currentValue = record.currentValue === true;
    return dto;
  }
  dto.currentValue = typeof record.currentValue === "string" ? record.currentValue : "";
  const options: ExternalAgentConfigOptionValueDto[] = [];
  if (Array.isArray(record.options)) {
    for (const item of record.options) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const entry = item as Record<string, unknown>;
      const value = typeof entry.value === "string" ? entry.value : "";
      const valueName = typeof entry.name === "string" ? entry.name.trim() : "";
      if (!value || !valueName) continue;
      const valueDto: ExternalAgentConfigOptionValueDto = { value, name: valueName };
      if (typeof entry.description === "string" && entry.description.trim()) valueDto.description = entry.description;
      if (typeof entry.group === "string" && entry.group.trim()) valueDto.group = entry.group;
      options.push(valueDto);
      if (options.length >= MAX_CONFIG_OPTION_VALUES) break;
    }
  }
  dto.options = options;
  return dto;
}

export function normalizeExternalAgentConfigOptions(raw: unknown): Record<string, ExternalAgentConfigOptionDto[]> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const result: Record<string, ExternalAgentConfigOptionDto[]> = {};
  for (const [agentId, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!agentId.trim() || !Array.isArray(list)) continue;
    const options = list
      .map(normalizeExternalAgentConfigOption)
      .filter((item): item is ExternalAgentConfigOptionDto => item !== null)
      .slice(0, MAX_CONFIG_OPTIONS_PER_AGENT);
    if (options.length) result[agentId] = options;
  }
  return Object.keys(result).length ? result : undefined;
}

export function normalizeExternalAgentConfigSelections(raw: unknown): Record<string, ExternalAgentConfigSelections> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const result: Record<string, ExternalAgentConfigSelections> = {};
  for (const [agentId, selections] of Object.entries(raw as Record<string, unknown>)) {
    if (!agentId.trim() || !selections || typeof selections !== "object" || Array.isArray(selections)) continue;
    const normalized: ExternalAgentConfigSelections = {};
    for (const [configId, value] of Object.entries(selections as Record<string, unknown>)) {
      if (!configId.trim()) continue;
      if (typeof value === "string" && value.trim()) normalized[configId] = value;
      else if (typeof value === "boolean") normalized[configId] = value;
    }
    if (Object.keys(normalized).length) result[agentId] = normalized;
  }
  return Object.keys(result).length ? result : undefined;
}

export interface ExternalAgentDescriptorDto {
  id: ExternalAgentId;
  name: string;
  protocol: ExternalAgentProtocol;
  available: boolean;
  availability: ExternalAgentAvailability;
  detail?: string;
  commandLabel: string;
  /** ACP 管理页开关；停用的 Agent 不出现在委托入口且 prompt 会被拒绝。 */
  enabled: boolean;
  /** 最近一次 session/new|load|resume 或连通测试捕获的会话级配置项（模型/模式等）。 */
  configOptions?: ExternalAgentConfigOptionDto[];
  /** 用户为该 Agent 保存的会话选项偏好；建会话后自动应用。 */
  configSelections?: ExternalAgentConfigSelections;
}

export interface ExternalAgentTestStepDto {
  id: "launch" | "initialize" | "session";
  label: string;
  ok: boolean;
  durationMs: number;
  detail?: string;
}

/** ACP 管理页连通性测试：启动进程 → initialize 握手 → session/new（必要时一次 authenticate 重试）。 */
export interface ExternalAgentTestResultDto {
  agentId: ExternalAgentId;
  ok: boolean;
  durationMs: number;
  steps: ExternalAgentTestStepDto[];
  sessionId?: string;
  resumeSupported?: boolean;
  authMethods?: string[];
  /** 测试会话捕获到的会话级配置项（模型/模式等），已同步进设置缓存。 */
  configOptions?: ExternalAgentConfigOptionDto[];
  /** 非致命提示：例如已保存的会话选项应用失败。 */
  notes?: string[];
  error?: string;
}

/** Task-level persistent ACP pin：固定后该任务每轮自动续接最近一次可恢复 run。 */
export interface ExternalAgentPinDto {
  id: ExternalAgentId;
  name: string;
  pinnedAt?: number;
}

/**
 * 解析 pin 任务本轮应续接的 run：从消息尾向前找同 agent、已建立 session
 * （sessionReady）且 runtime 宣告可续聊（resumeSupported）的最近一次运行。
 * 找不到返回 undefined —— 调用方落新 session（首轮/无可续 run 均正确）。
 * 对运行期消息与重启后 history 恢复的消息同样适用（两者 externalAgent 字段同构）。
 */
export function resolveExternalAgentContinuationRunId(
  messages: ReadonlyArray<{
    externalAgent?: {
      id: string;
      runId?: string;
      sessionReady?: boolean;
      resumeSupported?: boolean;
    };
  }>,
  agentId: string,
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const external = messages[index]?.externalAgent;
    if (!external || external.id !== agentId) continue;
    if (!external.runId || !external.sessionReady || external.resumeSupported !== true) continue;
    return external.runId;
  }
  return undefined;
}

export interface ExternalAgentPromptRequest {
  taskId: string;
  agentId: ExternalAgentId;
  /** Full execution prompt, including hidden MyBuddy context blocks. */
  text: string;
  /** User-visible bubble text, persisted separately so hidden context never leaks on reload. */
  displayText?: string;
  userMessageId: string;
  assistantMessageId: string;
  attachments?: Array<{ name: string; path: string }>;
  additionalDirectories?: string[];
  /** Explicit continuation request. Runtime resolves the source run/session authoritatively. */
  continueFromRunId?: string;
}

export interface ExternalAgentPromptResult {
  runId: string;
  queued: true;
}

export interface ExternalAgentPermissionOptionDto {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

/** 一次等待中的 ACP 权限请求（run 快照投影，供桌面/手机共用审批 UI） */
export interface DelegatedRunPendingPermissionDto {
  toolCallId: string;
  tool: string;
  summary: string;
  detail?: string;
  options: ExternalAgentPermissionOptionDto[];
}

export interface ExternalAgentResolvePermissionRequest {
  runId: string;
  toolCallId: string;
  optionId: string;
}

export interface ExternalAgentRunDto {
  runId: string;
  /** Backward-compatible task id; product-level delegated runs expose the same value as parentTaskId. */
  taskId: string;
  parentTaskId: string;
  agentId: ExternalAgentId;
  agentName: string;
  agent: { id: ExternalAgentId; name: string };
  protocol: ExternalAgentProtocol;
  status: ExternalAgentRunStatus;
  cwd: string;
  sessionId?: string;
  userMessageId: string;
  assistantMessageId: string;
  startedAt: number;
  completedAt?: number;
  error?: string;
  /** Monotonic cursor for streamed text/tool updates; consumers may poll from this watermark. */
  outputCursor: number;
  /** Artifact ids registered by MyBuddy for this delegated run's assistant message. */
  artifactRefs: string[];
  /**
   * 当前等待用户授权的 ACP 权限请求（status === "blocked" 时非空）。
   * 手机端无法读取进程状态，必须从 run 快照里拿到选项才能渲染审批卡片。
   */
  pendingPermissions: DelegatedRunPendingPermissionDto[];
  capabilities: DelegatedRunCapabilitiesDto;
  verification: DelegatedRunVerificationDto;
  recovery: DelegatedRunRecoveryDto;
  diagnostics: DelegatedRunDiagnosticsDto;
  continuedFromRunId?: string;
  continuationMode?: ExternalAgentContinuationMode;
}

export interface ExternalAgentHistoryDto {
  messages: ChatMessageDto[];
  runs: ExternalAgentRunDto[];
}

export interface ExternalAgentUiEvent {
  runId: string;
  taskId: string;
  agentId: ExternalAgentId;
  agentName: string;
  protocol: ExternalAgentProtocol;
  assistantMessageId: string;
  sessionId?: string;
  continuationMode?: ExternalAgentContinuationMode;
  resumeSupported: boolean;
  recoveryState: DelegatedRunRecoveryState;
  verificationStatus: DelegatedRunVerificationStatus;
  outputCursor: number;
  artifactRefs: string[];
  patch: AgentUiPatch;
}

export const ExternalAgentIpc = {
  listAgents: "external-agent:listAgents",
  setEnabled: "external-agent:setEnabled",
  setConfigOption: "external-agent:setConfigOption",
  test: "external-agent:test",
  prompt: "external-agent:prompt",
  cancel: "external-agent:cancel",
  resolvePermission: "external-agent:resolvePermission",
  history: "external-agent:history",
  active: "external-agent:active",
  event: "external-agent:event",
} as const;
