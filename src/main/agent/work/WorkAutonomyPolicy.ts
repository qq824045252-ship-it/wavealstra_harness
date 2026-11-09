import type { WorkActionDescriptor } from "../../../shared/bot-work-action";
import { isHardGateAction } from "../../../shared/bot-work-action";
import { scopeMatches, WORK_AUTONOMY_POLICY_VERSION, type WorkDecision } from "../../../shared/bot-work-autonomy";
import type { WorkDecisionLedger } from "./WorkDecisionLedger";

export interface AutonomyContext {
  userId: string;
  botId?: string;
  workId?: string;
  bindingId?: string;
  actionHash: string;
  projectId?: string;
  workspaceId?: string;
  repo?: string;
  /** 当前 Work 的 delegated scope；readonly 仍是硬边界。 */
  delegatedScope: readonly string[];
  permissionMode: "auto" | "default" | "readonly";
  /** 这个动作的 actionKind 已同时被 Work 授权范围和本次委派覆盖。 */
  scopeGranted?: boolean;
  /** 写入目标可证明落在已授权工作区根内（只对本地写有意义）。 */
  targetInsideWorkspace?: boolean;
}

export type AutonomyVerdict =
  | { kind: "allow"; source: "policy" | "precedent" | "scope"; reason: string; citedRuleIds: string[]; citedDecisionIds: string[] }
  | { kind: "deny"; reason: string; citedRuleIds: string[] }
  | { kind: "ask"; reason: string; hardGate: boolean; citedRuleIds: string[]; citedDecisionIds: string[] };

/**
 * 确定性自治策略（P0-B）。它只回答“这个动作由谁决定”，不授予资源、不结算效果。
 * 优先级固定：用户 deny > hard gate > readonly/delegated 边界 > 用户 allow > 已授权范围内的常规动作 > 兼容先例 > ask。
 * 任何低优先级结果都不能覆盖高优先级限制，Judge 只能在 ask 之前提供建议且无法越过 hard gate。
 */
export class WorkAutonomyPolicy {
  constructor(private readonly ledger: Pick<WorkDecisionLedger, "listRules" | "precedentFor" | "record">,
    private readonly now: () => number = () => Date.now()) {}

  decide(descriptor: WorkActionDescriptor, context: AutonomyContext): AutonomyVerdict {
    const action = { effect: descriptor.effect, operation: descriptor.operation, provider: descriptor.provider,
      target: descriptor.target, environment: descriptor.environment, projectId: context.projectId,
      workspaceId: context.workspaceId, repo: context.repo ?? descriptor.repo, botId: context.botId, userId: context.userId };
    const rules = this.ledger.listRules(context.userId).filter(rule =>
      (!rule.botId || rule.botId === context.botId) && scopeMatches(rule.scope, action, this.now()));
    // 显式拒绝优先于任何自动放行或再次询问。
    const deny = rules.find(rule => rule.decision === "deny");
    if (deny) return { kind: "deny", reason: deny.reason, citedRuleIds: [deny.ruleId] };
    // 1) hard gate：auto/策略/先例/Judge 都不能放行。
    if (isHardGateAction(descriptor)) {
      return { kind: "ask", reason: `高风险动作（${descriptor.operation}）必须由主人明确批准`, hardGate: true,
        citedRuleIds: [], citedDecisionIds: [] };
    }
    // 2) 只读模式按效果区分：可证明的读取仍然允许，其余一律拒绝。
    if (context.permissionMode === "readonly") {
      if (descriptor.effect === "read") {
        return { kind: "allow", source: "scope", reason: "只读模式下允许只读动作", citedRuleIds: [], citedDecisionIds: [] };
      }
      return { kind: "deny", reason: `当前为只读模式，已阻止 ${descriptor.effect} 动作（未执行）`, citedRuleIds: [] };
    }
    // 3) 缺少委派范围时保留既有的一次性精确扩权，规则/先例都不能改写委派边界。
    if (descriptor.effect !== "read" && descriptor.effect !== "message" && context.delegatedScope.length > 0
      && !context.delegatedScope.includes("workspace:write")) {
      return { kind: "ask", reason: "当前 Work 缺少 workspace:write 授权，仅此动作可由你一次性授权", hardGate: false,
        citedRuleIds: [], citedDecisionIds: [] };
    }
    // 5) 用户显式 allow。
    const allow = rules.find(rule => rule.decision === "allow");
    if (allow) return { kind: "allow", source: "policy", reason: allow.reason, citedRuleIds: [allow.ruleId], citedDecisionIds: [] };
    // 6) 已授权范围内的常规动作：可证明的读取、以及目标在授权工作区内的本地写入。
    if (this.routine(descriptor, context)) {
      return { kind: "allow", source: "scope",
        reason: descriptor.effect === "read" ? "已授权范围内的只读动作" : "已授权工作区内的常规本地写入",
        citedRuleIds: [], citedDecisionIds: [] };
    }
    // 7) 结构化兼容先例（只认可复用、未撤销、来源规则仍有效的决定）。
    const precedent = this.precedent(descriptor, context);
    if (precedent) return { kind: "allow", source: "precedent", reason: `与先例 ${precedent.decisionId} 作用域一致`,
      citedRuleIds: [], citedDecisionIds: [precedent.decisionId] };
    // 8) 其余一律询问主人；是否非阻塞由执行层决定。
    return { kind: "ask", reason: descriptor.reason ?? `该动作（${descriptor.effect}/${descriptor.operation}）没有可复用的规则或先例`,
      hardGate: false, citedRuleIds: [], citedDecisionIds: [] };
  }

  /** 常规动作不等于任意动作：只覆盖读与已证明在授权工作区内的本地写。 */
  private routine(descriptor: WorkActionDescriptor, context: AutonomyContext): boolean {
    if (context.scopeGranted !== true) return false;
    if (descriptor.operation === "delegate" || descriptor.source === "fallback" || descriptor.tags.includes("unclassified")) return false;
    if (descriptor.effect === "read") return true;
    return descriptor.effect === "local_write" && context.targetInsideWorkspace === true;
  }

  private precedent(descriptor: WorkActionDescriptor, context: AutonomyContext): WorkDecision | undefined {
    return this.ledger.precedentFor(context.userId, descriptor, { effect: descriptor.effect, operation: descriptor.operation,
      provider: descriptor.provider, target: descriptor.target, environment: descriptor.environment,
      projectId: context.projectId, workspaceId: context.workspaceId, repo: context.repo, botId: context.botId });
  }

  /** 记录自动决定，保证每个放行都能追溯到规则/先例/明确范围。 */
  record(verdict: Extract<AutonomyVerdict, { kind: "allow" | "deny" }>, descriptor: WorkActionDescriptor,
    context: AutonomyContext, reason: string): WorkDecision {
    return this.ledger.record({ userId: context.userId, botId: context.botId, workId: context.workId,
      bindingId: context.bindingId, actionHash: context.actionHash, policyVersion: WORK_AUTONOMY_POLICY_VERSION,
      scope: { projectId: context.projectId, workspaceId: context.workspaceId, repo: context.repo, botId: context.botId },
      descriptor: { effect: descriptor.effect, operation: descriptor.operation, provider: descriptor.provider,
        target: descriptor.target, environment: descriptor.environment, reversibility: descriptor.reversibility,
        blastRadius: descriptor.blastRadius },
      decidedBy: verdict.kind === "allow" ? (verdict.source === "precedent" ? "precedent" : "policy") : "policy",
      outcome: verdict.kind === "allow" ? "allowed" : "denied",
      // deny 不是先例；allow 只有来自显式规则时才可复用：范围放行与先例都不得自我复制。
      reusable: verdict.kind === "allow" && verdict.source === "policy" && verdict.citedRuleIds.length > 0,
      reason, citedRuleIds: verdict.citedRuleIds, citedDecisionIds: verdict.kind === "allow" ? verdict.citedDecisionIds : [],
    });
  }
}
