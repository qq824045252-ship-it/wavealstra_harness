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
}).strict();

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

export const remoteConfigureSchema = z.object({
  enabled: z.boolean().optional(),
  port: z.number().int().min(1024).max(65535).optional(),
  baseUrl: z.string().trim().max(500).optional(),
  bindMode: z.enum(["loopback", "lan"]).optional(),
}).strict();
