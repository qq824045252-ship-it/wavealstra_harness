import { z } from "zod";

/** 单个附件 base64 上限（约 3MB 原始字节） */
const ATTACHMENT_DATA_MAX = 4_000_000;

export const remotePromptSchema = z.object({
  // P1 修复：纯附件消息（拍照直接发送）允许 text 为空，但 text 与 attachments 不能同时为空
  text: z.string().trim().max(100_000),
  spaceId: z.string().trim().min(1).max(200).optional(),
  projectId: z.string().trim().min(1).max(200).optional(),
  welcomeMode: z.enum(["working", "coding", "bot"]).optional(),
  modePresetId: z.string().trim().min(1).max(200).nullable().optional(),
  modelId: z.string().trim().min(1).max(200).optional(),
  permissionMode: z.enum(["default", "readonly", "auto"]).optional(),
  /**
   * 非空 = 新任务第一轮直接交给该 ACP 外部 Agent（忽略 modelId/permissionMode：
   * ACP 进程用自己的推理与权限模型）。Agent 必须存在于电脑端 ACP 目录且已启用。
   */
  acpAgentId: z.string().trim().min(1).max(64).optional(),
  attachments: z.array(z.object({
    name: z.string().trim().min(1).max(200),
    data: z.string().min(1).max(ATTACHMENT_DATA_MAX),
    mimeType: z.string().trim().min(1).max(100).optional(),
  }).strict()).max(4).optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.text && !(value.attachments?.length)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["text"], message: "消息与附件不能同时为空" });
  }
});

export const remoteApprovalSchema = z.object({
  decision: z.enum(["deny", "allow-once", "allow-task-dir"]),
  // ACP 外部 Agent 的权限请求用 Agent 自己声明的 optionId 回传（allow_once/allow_always/reject_*）；
  // 缺省时由服务端按 decision 映射到最接近的选项。
  optionId: z.string().trim().min(1).max(200).optional(),
}).strict();

/** 手机端修改 ACP 权限策略：只接受三档，其余 400 */
export const remoteAcpPermissionSchema = z.object({
  policy: z.enum(["ask", "auto-allow", "auto-deny"]),
}).strict();

/** 手机端发起一轮 ACP 委托：Agent 由电脑端 ACP 目录决定，text/attachments 与内置 prompt 同语义 */
export const remoteAcpPromptSchema = z.object({
  agentId: z.string().trim().min(1).max(64),
  text: z.string().trim().max(100_000),
  continueFromRunId: z.string().trim().min(1).max(200).optional(),
  /** true = 丢弃上下文开新会话；缺省自动续接同任务同 Agent 的可恢复 session */
  newSession: z.boolean().optional(),
  attachments: z.array(z.object({
    name: z.string().trim().min(1).max(200),
    data: z.string().min(1).max(ATTACHMENT_DATA_MAX),
    mimeType: z.string().trim().min(1).max(100).optional(),
  }).strict()).max(4).optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.text && !(value.attachments?.length)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["text"], message: "消息与附件不能同时为空" });
  }
});

export const remoteInteractionAnswerSchema = z.object({
  answer: z.union([
    z.boolean(),
    z.string().max(100_000),
    z.array(z.string().max(100_000)).max(20),
  ]),
}).strict();

export const remotePairSchema = z.object({
  pairingId: z.string().trim().min(1).max(200),
  secret: z.string().trim().min(16).max(256),
  deviceName: z.string().trim().min(1).max(80),
  installationId: z.string().trim().min(8).max(200).optional(),
}).strict();

export const remoteDirectPairSchema = z.object({
  deviceName: z.string().trim().min(1).max(80).optional(),
  installationId: z.string().trim().min(8).max(200).optional(),
  /** 电脑端“允许新设备接入”窗口里显示的 6 位一次性配对码 */
  code: z.string().trim().regex(/^\d{6}$/, "配对码必须是 6 位数字"),
}).strict();

export const remoteConfigureSchema = z.object({
  enabled: z.boolean().optional(),
  port: z.number().int().min(1024).max(65535).optional(),
  baseUrl: z.string().trim().max(500).optional(),
}).strict();
