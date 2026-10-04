import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { PermissionMode, WelcomeMode } from "../../shared/agent-ipc";
import type { ExternalWriteDecision } from "../../shared/external-write";
import type { AssemblyTraceDto } from "../../shared/mode-profile";

export interface SessionEntry {
  taskId: string;
  session: AgentSession;
  unsubscribe: () => void;
  cwd: string;
  spaceId?: string;
  /** Project configuration revision used to assemble this session. */
  projectContextVersion?: string;
  /** Exact prompt assembly used to create this session; immutable audit source. */
  runtimeAssembly?: AssemblyTraceDto;
  /** Content-addressed identity of runtimeAssembly; authoritative staleness gate. */
  runtimeAssemblyHash?: string;
  runtimeProjectId?: string;
  runtimeProjectUpdatedAt?: number;
  runtimeTagId?: string;
  welcomeMode?: WelcomeMode;
  /** 用户偏好权限（default/readonly/auto） */
  permissionMode: PermissionMode;
  /** Session expert id. */
  expertId?: string;
  /** 用户请求的专家；即使被 Runtime policy/global gate 拒绝也保留，供重建检测与审计。 */
  requestedExpertId?: string;
  /** 会话创建时的 Active 连接器 id（其 Private Skills 已进入本会话候选；重建时回传） */
  connectorIds?: string[];
  /** Exact MCP providers enabled for this session; used for provider/tool evidence identity. */
  mcpProviderIds?: string[];
  /** 本 session 最终允许的 learned Skills；仅用于 exposure/invocation telemetry，不参与能力解析。 */
  learnedSkills?: Array<{ skillId: string; candidateId?: string; sourceMemoryIds: string[] }>;
  /** queued /skill:name invocation keyed by future assistant message id. */
  pendingSkillCommands?: Map<string, string>;
  /** MyBuddy 记账模型（`provider/id`）；用量统计用这个，不跟 pi session.model */
  usageModelId?: string;
  /** 装配输入（专家/连接器）已变更但会话暂忙：空闲后的下一次 prompt 重建会话 */
  assemblyDirty?: boolean;
  assistantMessageId?: string;
  /** Last native settled reply, for idempotent observer finalization only. */
  lastSettledAssistantMessageId?: string;
  /** 当前真正运行的 execution；用户交互和执行证据绑定此 id。 */
  executionId?: string;
  startedAt?: number;
  /** 流式期间追加的 UI assistant 占位；等对应 user message 真正开始时再切换事件归属。 */
  pendingAssistantTurns: Array<{
    messageId: string;
    executionId: string;
    queuedAt: number;
    behavior: "steer" | "followUp";
  }>;
  /** Serializes UI reply-ID admission only; released at native preflight acceptance. */
  promptSubmissionTail: Promise<void>;
  /** abort 时递增，使仍在异步预处理或等待入队锁的旧请求失效。 */
  promptQueueEpoch: number;
  /** toolCallId → resolve(approved) */
  pendingApprovals: Map<string, (approved: boolean) => void>;
  /** toolCallId → resolve(decision)：外部写授权（approvalKind=external-write） */
  pendingExternalWrites: Map<string, (decision: ExternalWriteDecision) => void>;
  /** 已通过外部写授权的 toolCallId：后续 permission/MCP 审批直接放行，避免双弹窗 */
  grantedExternalWriteToolCalls: Set<string>;
}

type AssistantTurnRoutingState = Pick<
  SessionEntry,
  "assistantMessageId" | "executionId" | "startedAt" | "pendingAssistantTurns"
>;

export function queueAssistantTurn(
  entry: AssistantTurnRoutingState,
  messageId: string,
  queuedAt: number,
  behavior: "steer" | "followUp",
  executionId = `execution-${messageId}`,
): void {
  const turn = { messageId, executionId, queuedAt, behavior };
  if (behavior === "followUp") {
    entry.pendingAssistantTurns.push(turn);
    return;
  }
  // pi SDK 总是先消费 steering，再消费 follow-up；本地消息目标队列保持同序。
  const firstFollowUp = entry.pendingAssistantTurns.findIndex(
    (pending) => pending.behavior === "followUp",
  );
  if (firstFollowUp < 0) entry.pendingAssistantTurns.push(turn);
  else entry.pendingAssistantTurns.splice(firstFollowUp, 0, turn);
}

export function activateNextAssistantTurn(
  entry: AssistantTurnRoutingState,
  startedAt: number,
): { previousMessageId: string; previousExecutionId?: string; previousStartedAt: number; messageId: string; executionId: string } | null {
  const next = entry.pendingAssistantTurns.shift();
  const previousMessageId = entry.assistantMessageId;
  const previousExecutionId = entry.executionId;
  if (!next || !previousMessageId) return null;
  const previousStartedAt = entry.startedAt ?? next.queuedAt;
  entry.assistantMessageId = next.messageId;
  entry.executionId = next.executionId;
  entry.startedAt = startedAt;
  return { previousMessageId, previousExecutionId, previousStartedAt, messageId: next.messageId, executionId: next.executionId };
}

export async function acquirePromptSubmission(
  entry: Pick<SessionEntry, "promptSubmissionTail">,
): Promise<() => void> {
  const previous = entry.promptSubmissionTail;
  let release!: () => void;
  entry.promptSubmissionTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  return release;
}

/**
 * regenerate 全链连接器保留（F1）：请求显式 > 当前 entry > 重建前捕获的旧值。
 * regenerate 的内层 prompt() 必须带上同一份 connectorIds，否则 prompt() 的装配检测
 * （entry.connectorIds vs req.connectorIds）会把「一致」误判为「变更」并错误重建，
 * 重建时又因缺参而丢失 Active Connector 私有技能。
 */
export function resolveRegenerateConnectorIds(
  reqConnectorIds: string[] | undefined,
  entryConnectorIds: string[] | undefined,
  prevConnectorIds: string[] | undefined,
): string[] | undefined {
  return reqConnectorIds ?? entryConnectorIds ?? prevConnectorIds;
}

/**
 * P1（重启 explicit 语义收口）：请求未显式传值时的「上次生效值/重启兜底」。
 *
 * renderer 的 modelExplicit/permissionExplicit 不持久化（无新 DB schema），应用重启后为
 * false，若主进程直接走 Tag/Mode 建议链，会让重启后的真实 session 与 UI/任务 DB 显示值漂移。
 * 本函数在请求未显式传 modelId/permissionMode 时，把任务持久化的上次生效值作为兜底（优先于建议），
 * 但仅当任务已有真实会话（sessionFile 存在 = 上次生效值已由 createSession 落库）时生效：
 * 新任务 / 已有任务首次会话（无 sessionFile，未锁定）返回 undefined，继续走
 * 显式 > Tag/Mode 建议 > 系统默认 链。
 *
 * 「跟随场景建议」不冲突：followSuggestedModel/Permission 会把解析后的建议值 upsertTask
 * 写回 DB，本兜底随后返回的正是该解析值（建议链未被挡住，只是经由 DB 生效）。
 */
export function resolveSessionRestartFallback(
  req: { modelId?: string | null; permissionMode?: PermissionMode | null },
  existing:
    | {
        sessionFile?: string | null;
        modelId?: string | null;
        permissionMode?: PermissionMode | null;
      }
    | undefined,
): { modelId?: string; permissionMode?: PermissionMode } {
  if (!existing?.sessionFile) {
    return { modelId: undefined, permissionMode: undefined };
  }
  return {
    modelId: req.modelId ?? existing.modelId ?? undefined,
    permissionMode: req.permissionMode ?? existing.permissionMode ?? undefined,
  };
}

/**
 * 会话装配输入变更检测（F1/F3 共用）：专家 id、连接器集合或 assemblyDirty 任一变化即重建。
 * Project/Mode/Library 等真实 Prompt 内容变化由 runtimeAssemblyHash/fingerprint 负责；不要把
 * project.updated_at 之类活动时钟当成 Prompt 版本，否则 Memory/Plan 的普通写入会误杀缓存。
 * 连接器集合按排序后 JSON 比较（顺序无关）。提取为纯函数供单测直接覆盖。
 */
export function assemblyInputsChanged(
  entry: {
    expertId?: string;
    requestedExpertId?: string;
    connectorIds?: string[];
    projectContextVersion?: string;
    assemblyDirty?: boolean;
  } | undefined,
  expertId: string | null,
  connectorIds: string[] | undefined,
  _projectContextVersion?: string,
): boolean {
  if (!entry) return false;
  const connectorsChanged =
    JSON.stringify([...(entry.connectorIds ?? [])].sort()) !==
    JSON.stringify([...(connectorIds ?? [])].sort());
  return (
    (entry.requestedExpertId ?? entry.expertId ?? null) !== expertId ||
    connectorsChanged ||
    entry.assemblyDirty === true
  );
}

export function invalidatePendingPromptQueue(
  entry: Pick<
    SessionEntry,
    "promptQueueEpoch" | "pendingAssistantTurns"
  >,
): void {
  entry.promptQueueEpoch += 1;
  entry.pendingAssistantTurns = [];
}

export class SessionRegistry {
  private readonly byTask = new Map<string, SessionEntry>();

  get(taskId: string): SessionEntry | undefined {
    return this.byTask.get(taskId);
  }

  set(entry: SessionEntry): void {
    const prev = this.byTask.get(entry.taskId);
    if (prev && prev.session !== entry.session) {
      try {
        prev.unsubscribe();
        prev.session.dispose();
      } catch {
        /* ignore */
      }
    }
    this.byTask.set(entry.taskId, entry);
  }

  values(): SessionEntry[] {
    return [...this.byTask.values()];
  }

  delete(taskId: string): void {
    const prev = this.byTask.get(taskId);
    if (!prev) return;
    try {
      prev.unsubscribe();
      prev.session.dispose();
    } catch {
      /* ignore */
    }
    this.byTask.delete(taskId);
  }

  resolveApproval(taskId: string, toolCallId: string, approved: boolean): boolean {
    const entry = this.byTask.get(taskId);
    if (!entry) return false;
    const resolve = entry.pendingApprovals.get(toolCallId);
    if (!resolve) return false;
    entry.pendingApprovals.delete(toolCallId);
    resolve(approved);
    return true;
  }

  /** 解析外部写授权：pendingExternalWrites → decision；同时记录已授权 toolCallId */
  resolveExternalWrite(taskId: string, toolCallId: string, decision: ExternalWriteDecision): boolean {
    const entry = this.byTask.get(taskId);
    if (!entry) return false;
    const resolve = entry.pendingExternalWrites.get(toolCallId);
    if (!resolve) return false;
    entry.pendingExternalWrites.delete(toolCallId);
    if (decision.kind !== "deny") entry.grantedExternalWriteToolCalls.add(toolCallId);
    resolve(decision);
    return true;
  }

  /**
   * 连接器启用/停用后标记所有装配了该连接器的会话为 dirty（F3）：
   * 下一轮空闲 prompt 由 prompt() 统一重建（忙时保持既有 assemblyDirty 延迟语义）。
   * 返回受影响 taskId 列表（调试/测试用）。
   */
  markConnectorDirty(connectorId: string): string[] {
    const affected: string[] = [];
    for (const [taskId, entry] of this.byTask) {
      if (!(entry.connectorIds ?? []).includes(connectorId)) continue;
      entry.assemblyDirty = true;
      affected.push(taskId);
    }
    return affected;
  }

  setPermissionMode(taskId: string, permissionMode: PermissionMode): string[] {
    const entry = this.byTask.get(taskId);
    if (!entry) return [];

    entry.permissionMode = permissionMode;
    // readonly/auto 之外（default）不自动放行挂起审批
    if (entry.permissionMode !== "auto") return [];

    // 挂起的外部写授权同样自动放行（auto = 用户已完全授权）
    if (entry.pendingExternalWrites.size > 0) {
      for (const [toolCallId, resolve] of [...entry.pendingExternalWrites.entries()]) {
        entry.pendingExternalWrites.delete(toolCallId);
        entry.grantedExternalWriteToolCalls.add(toolCallId);
        resolve({ kind: "allow-once" });
      }
    }

    if (entry.pendingApprovals.size === 0) return [];
    const pendingToolCallIds = [...entry.pendingApprovals.keys()];
    const resolvers = [...entry.pendingApprovals.values()];
    entry.pendingApprovals.clear();
    for (const resolve of resolvers) resolve(true);
    return pendingToolCallIds;
  }

  disposeAll(): void {
    for (const id of [...this.byTask.keys()]) this.delete(id);
  }
}
