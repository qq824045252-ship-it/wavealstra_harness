/**
 * conversation-branch.ts — 对话分支（Branch in new task）共享契约。
 *
 * 领域名统一使用 ConversationBranch，避免与 Git branch、Workspace Tree、Pi 内部
 * branch 混淆（实施规划 §3.1）。本文件只承载 DTO / 枚举 / IPC 常量 / 错误码，
 * 所有定位、物化、继承逻辑都在主进程（DurableTaskBranch.ts / ConversationBranchService.ts）。
 *
 * Renderer 请求中禁止出现：sessionFile、cwd、parentTitle、rootTaskId、
 * sourceLeafEntryId、Project/Space policy 文本——这些全部由主进程从可信 Task 和
 * Durable 历史解析（实施规划 §5.3）。
 */
import type { TaskDto } from "./agent-ipc";

export class ConversationBranchDomainError extends Error {
  constructor(readonly code: ConversationBranchErrorCode, message: string) {
    super(message);
    this.name = "ConversationBranchDomainError";
  }
}

/** 分支点相对所选 user 消息的位置（实施规划 §3.2） */
export type ConversationBranchPosition = "after_user" | "after_reply";

/**
 * 新 Task 的文件工作区策略（实施规划 §8）。
 * - shared_space：继承 Space.path，与源任务共用真实目录；
 * - current_snapshot：复制源任务当前文件快照到独立目录（非历史时点恢复）；
 * - conversation_only：新空工作区，仅分支对话。
 */
export type ConversationBranchWorkspaceStrategy =
  | "shared_space"
  | "current_snapshot"
  | "conversation_only";

export interface CreateConversationBranchRequest {
  sourceTaskId: string;
  /**
   * 主锚点：所选消息的真实 Durable entry id（由 loadTaskHistory 透传的
   * ChatMessageDto.entryId 提供）。主进程以它在 active branch 中的位置为准
   * （实施规划 §7.1 评审裁决 1-4）。
   */
  entryId?: string;
  /**
   * 辅助/回退锚点：过滤后 UI 序号，仅用于跨 UI/Pi 一致性校验与展示；
   * 不作为唯一定位依据（UI 序号与 Pi 原始序号可能偏移，§7.1）。
   */
  userMessageIndex?: number;
  position: ConversationBranchPosition;
  /** 只有主进程预检要求用户选择时才允许传入（§8.3 大目录阈值）。 */
  workspaceStrategy?: ConversationBranchWorkspaceStrategy;
  /** 幂等键，来自 Renderer；永不暴露为 Task ID，不参与标题（§5.4）。 */
  requestId: string;
}

export interface ConversationBranchInfoDto {
  childTaskId: string;
  parentTaskId: string;
  rootTaskId: string;
  /** 创建时父任务标题快照（父被删后仍可解释血缘，§5.1） */
  parentTitle: string;
  /** child 任务当前标题（已回收/已删除时为 undefined；展示用） */
  childTitle?: string;
  /** 展示用源 user 消息序号（过滤后 UI 口径，非定位锚点） */
  sourceUserMessageIndex: number;
  sourcePosition: ConversationBranchPosition;
  workspaceStrategy: ConversationBranchWorkspaceStrategy;
  createdAt: number;
  /** 父任务当前是否仍存在（parent_task_id 不加 FK，§5.1） */
  parentExists: boolean;
}

/** 创建前预检结果（§8.3 大目录策略选择）。无副作用。 */
export interface ConversationBranchPreviewDto {
  ok: boolean;
  /** 主进程解析出的实际策略（Space-bound 强制 shared_space） */
  strategy: ConversationBranchWorkspaceStrategy;
  /** current_snapshot 时源工作区预检信息 */
  snapshot?: {
    fileCount: number;
    totalBytes: number;
    /** 超过阈值需要用户确认（复制 / 仅分支对话 / 取消） */
    overLimit: boolean;
  };
  sourceUserMessageIndex?: number;
  sourcePosition?: ConversationBranchPosition;
  code?: ConversationBranchErrorCode;
  message?: string;
}

export interface CreateConversationBranchResult {
  task: TaskDto;
  branch: ConversationBranchInfoDto;
  warnings: string[];
  inheritedArtifactCount: number;
  skippedArtifactCount: number;
}

export type ConversationBranchCreateOutcome =
  | { ok: true; result: CreateConversationBranchResult }
  | { ok: false; code: ConversationBranchErrorCode; message: string };

export const ConversationBranchIpc = {
  preview: "conversationBranch:preview",
  create: "conversationBranch:create",
  getInfo: "conversationBranch:getInfo",
  listChildren: "conversationBranch:listChildren",
} as const;

/** 错误码：UI 按 code 做可读展示与 disabled 提示（实施规划 §6.2） */
export type ConversationBranchErrorCode =
  | "TASK_NOT_FOUND"
  | "TASK_TRASHED"
  | "TASK_SPECIAL"
  | "TASK_BUSY"
  | "SESSION_MISSING"
  | "ANCHOR_NOT_FOUND"
  | "ANCHOR_NOT_IN_ACTIVE_BRANCH"
  | "POSITION_MISMATCH"
  | "WORKSPACE_LIMIT_EXCEEDED"
  | "BRANCH_SESSION_FAILED"
  | "TASK_CREATE_FAILED"
  | "INVALID_REQUEST";

export function isConversationBranchErrorCode(
  value: unknown,
): value is ConversationBranchErrorCode {
  return (
    typeof value === "string" &&
    [
      "TASK_NOT_FOUND",
      "TASK_TRASHED",
      "TASK_SPECIAL",
      "TASK_BUSY",
      "SESSION_MISSING",
      "ANCHOR_NOT_FOUND",
      "ANCHOR_NOT_IN_ACTIVE_BRANCH",
      "POSITION_MISMATCH",
      "WORKSPACE_LIMIT_EXCEEDED",
      "BRANCH_SESSION_FAILED",
      "TASK_CREATE_FAILED",
      "INVALID_REQUEST",
    ].includes(value)
  );
}
