import { z } from "zod";

export const workActionApprovalSchema = z.object({
  approvalId: z.string(), workId: z.string(), bindingId: z.string(), taskId: z.string(), operationId: z.string(),
  actionHash: z.string().optional(),
  continuation: z.object({ status: z.enum(["deferred", "queued", "running", "consumed", "unknown", "invalidated"]), reason: z.string().optional() }).optional(),
  toolName: z.string(), summary: z.string(), detail: z.string(), requiredScope: z.string(), scopeMissing: z.boolean(),
  intentRevision: z.number(), inputSnapshotId: z.string(), ownerEpoch: z.number(),
  status: z.enum(["pending", "approved", "denied", "ignored", "expired", "invalidated", "consumed"]),
  version: z.number(), createdAt: z.number(), expiresAt: z.number(), resolvedAt: z.number().optional(),
  outcome: z.string().optional(),
  /** P0-A：这个卡片到底在问什么动作；UI 直接展示，不再只有工具名。 */
  descriptor: z.object({ effect: z.string(), operation: z.string(), provider: z.string().optional(),
    target: z.string().optional(), environment: z.string(), reversibility: z.string(), blastRadius: z.string(),
    hardGate: z.boolean(), reason: z.string().optional() }).strict().optional(),
  /** 为什么需要主人 + 不处理会怎样，供卡片文案使用。 */
  question: z.string().optional(),
  /** 可以安全表达长期规则的作用域键（无则不提供“以后这样处理”）。 */
  ruleScope: z.object({ projectId: z.string().optional(), repo: z.string().optional(), workspaceId: z.string().optional(),
    botId: z.string().optional() }).strict().optional(),
  /** 放行来源：规则/先例/明确范围/auto 必须可追溯；规则撤销后要能复核。 */
  decision: z.object({ decisionId: z.string(), source: z.string(), citedRuleIds: z.array(z.string()).max(16),
    citedDecisionIds: z.array(z.string()).max(16) }).strict().optional(),
});
export type WorkActionApprovalDto = z.infer<typeof workActionApprovalSchema>;
export const workActionDecisionSchema = z.object({
  approvalId: z.string().min(1), workId: z.string().min(1), bindingId: z.string().min(1),
  expectedVersion: z.number().int().positive(), expectedStateVersion: z.number().int().positive(),
  expectedIntentRevision: z.number().int().positive(), expectedOwnerEpoch: z.number().int().positive(),
  /** allow / deny / ignore 三态；ignore 不等于拒绝，也不取消事项。 */
  decision: z.enum(["allow", "deny", "ignore", "refresh"]).optional(),
  approved: z.boolean().optional(), grantScopeOnce: z.boolean().default(false),
  /** 用户明确保存的可复用规则；只有软决策才允许携带。 */
  saveRule: z.enum(["project", "repo", "workspace"]).optional(),
}).strict();
export type WorkActionDecision = z.infer<typeof workActionDecisionSchema>;
/** P0-D：审批返回显式结果，避免用 boolean 猜“拒绝/未处理/不适用”。 */
export type WorkActionAuthorization =
  | { kind: "allow"; source: "policy" | "precedent" | "scope" | "exact" | "auto" }
  | { kind: "deny"; reason: string }
  | { kind: "defer"; approvalId: string; reason: string }
  | { kind: "not_applicable" };

export type WorkActionDecisionResult = { ok: true; approval: WorkActionApprovalDto; replayed: boolean }
  | { ok: false; code: "invalid_request" | "forbidden" | "not_found" | "version_conflict" | "already_resolved"; message: string };
