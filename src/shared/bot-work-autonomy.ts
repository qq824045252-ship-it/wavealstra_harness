import { z } from "zod";

/**
 * 自治策略（P0-B）。决定“谁来决定这个具体动作”，不决定资源准入，也不代表效果已结算。
 * 优先级由 `WorkAutonomyPolicy` 固定实现，策略结果必须说明来源，便于审计。
 */
export const workAutonomyScopeSchema = z.object({
  userId: z.string().max(200).optional(),
  botId: z.string().max(200).optional(),
  projectId: z.string().max(200).optional(),
  workspaceId: z.string().max(200).optional(),
  repo: z.string().max(200).optional(),
  effect: z.array(z.string().max(40)).max(12).optional(),
  operation: z.array(z.string().max(80)).max(24).optional(),
  provider: z.array(z.string().max(80)).max(16).optional(),
  target: z.array(z.string().max(300)).max(24).optional(),
  environment: z.array(z.string().max(20)).max(5).optional(),
  /** 过期时间（ms）。过期规则不参与匹配，也不能被当作先例。 */
  expiresAt: z.number().int().positive().optional(),
}).strict();
export type WorkAutonomyScope = z.infer<typeof workAutonomyScopeSchema>;

export const workAutonomyRuleSchema = z.object({
  ruleId: z.string().min(1).max(120),
  userId: z.string().min(1).max(200),
  botId: z.string().max(200).optional(),
  /** allow 只覆盖同作用域；deny 优先级更高且不可被先例覆盖。 */
  decision: z.enum(["allow", "deny"]),
  scope: workAutonomyScopeSchema,
  /** 用户可读的理由，显示在卡片与审计记录里。 */
  reason: z.string().min(1).max(500),
  createdBy: z.enum(["user", "owner"]),
  createdAt: z.number().int().nonnegative(),
  revokedAt: z.number().int().nonnegative().optional(),
}).strict();
export type WorkAutonomyRule = z.infer<typeof workAutonomyRuleSchema>;

/** 四种明确的用户语义：允许 / 拒绝 / 暂不处理 / 超时。ignore 不等于拒绝。 */
export const workAutonomyOutcomeSchema = z.enum(["allowed", "denied", "ignored", "expired"]);
export type WorkAutonomyOutcome = z.infer<typeof workAutonomyOutcomeSchema>;

export const workDecisionSchema = z.object({
  decisionId: z.string().min(1).max(160),
  userId: z.string().min(1).max(200),
  botId: z.string().max(200).optional(),
  workId: z.string().max(200).optional(),
  bindingId: z.string().max(200).optional(),
  actionHash: z.string().min(1).max(200),
  descriptor: z.object({
    effect: z.string(), operation: z.string(), provider: z.string().optional(), target: z.string().optional(),
    environment: z.string(), reversibility: z.string(), blastRadius: z.string(),
  }).strict(),
  policyVersion: z.string().min(1).max(40),
  /** 先例作用域：项目/工作区/仓库必须一致，不能把 A 项目的允许扩到 B 项目。 */
  scope: z.object({ projectId: z.string().max(200).optional(), workspaceId: z.string().max(200).optional(),
    repo: z.string().max(200).optional(), botId: z.string().max(200).optional() }).strict().optional(),
  /** 谁做的决定：user / policy / precedent / judge / exact-approval */
  decidedBy: z.enum(["user", "policy", "precedent", "judge", "exact-approval"]),
  outcome: workAutonomyOutcomeSchema,
  /** ignore/expired 永远不是可复用先例，也不是负样本。 */
  reusable: z.boolean(),
  reason: z.string().max(800),
  citedRuleIds: z.array(z.string().max(120)).max(16),
  citedDecisionIds: z.array(z.string().max(160)).max(16),
  createdAt: z.number().int().nonnegative(),
  resolvedAt: z.number().int().nonnegative().optional(),
  supersededBy: z.string().max(160).optional(),
}).strict();
export type WorkDecision = z.infer<typeof workDecisionSchema>;

export const WORK_AUTONOMY_POLICY_VERSION = "autonomy-1";

/** 归一化目标：允许按前缀/精确匹配，但绝不把路径/频道猜测成别的目标。 */
export function scopeMatches(scope: WorkAutonomyScope, action: {
  effect: string; operation: string; provider?: string; target?: string; environment: string;
  projectId?: string; workspaceId?: string; repo?: string; botId?: string; userId?: string;
}, now: number): boolean {
  if (scope.expiresAt !== undefined && scope.expiresAt <= now) return false;
  const one = (allowed: string[] | undefined, value: string | undefined) =>
    !allowed || (value !== undefined && allowed.some(item => item === value));
  const single = (value?: string): string[] | undefined => value ? [value] : undefined;
  return one(single(scope.userId), action.userId)
    && one(single(scope.botId), action.botId)
    && one(single(scope.projectId), action.projectId)
    && one(single(scope.workspaceId), action.workspaceId)
    && one(single(scope.repo), action.repo)
    && one(scope.effect, action.effect)
    && one(scope.operation, action.operation)
    && one(scope.provider, action.provider)
    && one(scope.target, action.target)
    && one(scope.environment, action.environment);
}
