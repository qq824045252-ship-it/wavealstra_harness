import { z } from "zod";

/**
 * 动作语义（P0-A）。它描述“这是什么业务动作”，而不是“工具有没有副作用”：
 * 本地改文件、普通分支 push、受保护分支 push、发消息、发布、删除、凭据操作
 * 的风险与主人偏好完全不同，不能继续压成一个 `workspace:write`。
 */
export const workEffectSchema = z.enum([
  "read", "work_progress", "local_write", "repo_write", "external_write", "message", "publish", "delete", "credential",
  "financial", "physical_input",
]);
export type WorkEffect = z.infer<typeof workEffectSchema>;

export const workEnvironmentSchema = z.enum(["local", "test", "staging", "production", "unknown"]);
export const workReversibilitySchema = z.enum(["reversible", "recoverable", "irreversible", "unknown"]);
export const workBlastRadiusSchema = z.enum(["single", "project", "account", "external", "unknown"]);
export const workRiskTagSchema = z.enum([
  "protected-target", "destructive", "irreversible", "external-side-effect", "credential", "publish",
  "unclassified", "physical-input",
]);

export const workActionDescriptorSchema = z.object({
  effect: workEffectSchema,
  /** write_file / git_commit / git_push / pr_merge / send_message / release / delete / use_secret / input */
  operation: z.string().min(1).max(80),
  provider: z.string().min(1).max(80).optional(),
  /** 归一化目标身份（仓库名/频道/路径），不含密钥原文。 */
  target: z.string().min(1).max(300).optional(),
  environment: workEnvironmentSchema,
  reversibility: workReversibilitySchema,
  blastRadius: workBlastRadiusSchema,
  workspaceId: z.string().max(200).optional(),
  projectId: z.string().max(200).optional(),
  repo: z.string().max(200).optional(),
  tags: z.array(workRiskTagSchema).max(12),
  /** hard gate 只能由这里声明；策略/Judge 不能自行降级。 */
  hardGate: z.boolean(),
  /** 分类来源：结构化工具/MCP 身份优先，shell 猜测只能保守。 */
  source: z.enum(["builtin", "mcp", "shell", "physical", "fallback"]),
  /** 保守分类时给出的原因，便于审计“为什么问主人”。 */
  reason: z.string().max(400).optional(),
}).strict();
export type WorkActionDescriptor = z.infer<typeof workActionDescriptorSchema>;

/** hard gate 永远不能被 auto/Judge/先例绕过。 */
export const isHardGateAction = (descriptor: WorkActionDescriptor): boolean => descriptor.hardGate
  || descriptor.tags.includes("protected-target") || descriptor.tags.includes("credential")
  || descriptor.tags.includes("publish") || descriptor.tags.includes("destructive");

/** 未识别动作不能降级成低风险读取。 */
export const conservativeDescriptor = (reason: string): WorkActionDescriptor => ({
  effect: "external_write", operation: "unclassified", environment: "unknown", reversibility: "unknown",
  blastRadius: "unknown", tags: ["unclassified"], hardGate: false, source: "fallback", reason,
});
