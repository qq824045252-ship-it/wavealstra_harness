/**
 * External Write（任务工作区外写入授权）共享契约。
 *
 * 语义：任务默认只能写 taskRoot（未绑定 Space 时为 ~/.mybuddy/task-workspaces/<task>，
 * 绑定 Space 时为 space.path）。write/edit 或可识别的 MCP 本地写试图越界时，
 * 不再直接拒绝，而是经现有 permission/approval 通道弹出外部写授权，由用户决定：
 *  - allow-once：仅放行本次 tool call（不持久化）；
 *  - allow-task-dir：对当前任务持久化该目录写 grant（重启后仍有效），并放行本次；
 *  - deny：拒绝，返回可理解的原因给 Agent。
 *
 * 安全约束：目录 grant 只允许「任务内持久授权」，不存在全局 trusted-dir；
 * readonly 权限模式永远不能经授权获得写能力；auto（完全访问）保持放行语义。
 */

/** 外部写授权决策（用户选择结果） */
export type ExternalWriteDecision =
  /** 仅放行本次 tool call / 目标路径 */
  | { kind: "allow-once" }
  /** 持久授权 canonical 目录（绝对路径），并放行本次 */
  | { kind: "allow-task-dir"; path: string }
  /** 拒绝 */
  | { kind: "deny" };

/** 外部写授权请求（guard / MCP side-effect 发起，经 permission 通道送达 renderer） */
export interface ExternalWriteApprovalRequest {
  taskId: string;
  toolCallId: string;
  /** 触发工具名（write / edit / MCP tool 名） */
  toolName: string;
  /** 请求写入的目标绝对路径 */
  targetPath: string;
  /** 当前任务工作目录（canonical taskRoot） */
  taskRoot: string;
  /** 建议持久授权的 canonical 目录（目标所在目录，已规范化） */
  canonicalDir: string;
  /** 展示摘要 */
  summary: string;
  /** 补充说明（风险提示等） */
  detail?: string;
}

/** 持久化写 grant 行（DB 表 task_write_grants） */
export interface TaskWriteGrantRow {
  taskId: string;
  /** canonical 目录绝对路径 */
  path: string;
  createdAt: number;
}

/** approveTool 请求中附带的外部写决策（与 AgentApproveToolRequest 兼容扩展） */
export interface ExternalWriteApprovalChoice {
  scope: "once" | "task-dir";
  /** scope=task-dir 时：用户选择的目录绝对路径（主进程会 canonicalize 后持久化） */
  path?: string;
}

/** 统一产品文案（与 ToolCallCard 审批条风格一致，避免复杂术语） */
export const EXTERNAL_WRITE_LABEL = "允许写入任务目录外";
export const EXTERNAL_WRITE_ALLOW_ONCE_LABEL = "允许一次";
export const EXTERNAL_WRITE_ALLOW_TASK_DIR_LABEL = "始终允许此文件夹";
export const EXTERNAL_WRITE_DENY_LABEL = "拒绝";
export const EXTERNAL_WRITE_RISK_HINT =
  "Agent 正在请求写入任务工作目录之外的位置。仅在你确认目标可信后允许；「始终允许此文件夹」只对当前任务生效，可在任务外部写入授权中撤销。";
