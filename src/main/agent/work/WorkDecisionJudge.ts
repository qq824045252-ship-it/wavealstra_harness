import { z } from "zod";
import type { WorkActionDescriptor } from "../../../shared/bot-work-action";
import { isHardGateAction } from "../../../shared/bot-work-action";
import type { WorkDecision } from "../../../shared/bot-work-autonomy";

export const judgeVerdictSchema = z.object({
  verdict: z.enum(["DECIDED", "SENT_BACK", "HOLD"]),
  answer: z.string().max(2000).optional(),
  reason: z.string().max(2000),
  citedRuleIds: z.array(z.string().max(120)).max(16).default([]),
  citedDecisionIds: z.array(z.string().max(160)).max(16).default([]),
  /** 模型自报的置信度只用于 shadow 统计，永远不作为授权依据。 */
  confidence: z.number().min(0).max(1).optional(),
}).strict();
export type JudgeVerdict = z.infer<typeof judgeVerdictSchema>;

export interface JudgeRequest {
  descriptor: WorkActionDescriptor;
  question: string;
  /** 已经过确定性作用域过滤的候选先例，Judge 不能自己扩大范围。 */
  precedents: readonly WorkDecision[];
  policies: readonly { ruleId: string; reason: string }[];
}

export type JudgeTransport = (request: JudgeRequest, signal: AbortSignal) => Promise<unknown>;

/**
 * Judge 只能裁决“是否已被确定性作用域覆盖”：
 * - hard gate 直接 HOLD，不调用模型；
 * - 没有兼容先例/规则可引用时 HOLD（不接受语义相似）；
 * - 超时、异常、429、无效输出一律 HOLD；
 * - 默认 shadow：只记录预测，不改变真实决策。
 */
export class WorkDecisionJudge {
  constructor(private readonly options: {
    transport?: JudgeTransport;
    timeoutMs?: number;
    mode?: "shadow" | "off";
    onShadow?: (prediction: { request: JudgeRequest; verdict: JudgeVerdict | { verdict: "FAILED"; reason: string } }) => void;
  } = {}) {}

  get enabled(): boolean { return this.options.mode !== "off" && !!this.options.transport; }

  async predict(request: JudgeRequest): Promise<JudgeVerdict> {
    if (isHardGateAction(request.descriptor)) return { verdict: "HOLD", reason: "hard gate 不能由 Judge 决定", citedRuleIds: [], citedDecisionIds: [] };
    if (!this.options.transport) return { verdict: "HOLD", reason: "Judge 未启用", citedRuleIds: [], citedDecisionIds: [] };
    if (!request.precedents.length && !request.policies.length) {
      return { verdict: "HOLD", reason: "没有作用域兼容的规则或先例，必须询问主人", citedRuleIds: [], citedDecisionIds: [] };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("judge timeout")), Math.max(1, this.options.timeoutMs ?? 8_000));
    try {
      const raw = await this.options.transport(request, controller.signal);
      const parsed = judgeVerdictSchema.safeParse(raw);
      if (!parsed.success) return this.fail(request, "Judge 输出无效");
      const allowedRules = new Set(request.policies.map(item => item.ruleId));
      const allowedDecisions = new Set(request.precedents.map(item => item.decisionId));
      if (parsed.data.citedRuleIds.some(id => !allowedRules.has(id))
        || parsed.data.citedDecisionIds.some(id => !allowedDecisions.has(id))) {
        return this.fail(request, "Judge 引用了未提供的规则或先例");
      }
      if (parsed.data.verdict === "DECIDED" && (parsed.data.citedRuleIds.length || parsed.data.citedDecisionIds.length) === 0) {
        return this.fail(request, "DECIDED 必须引用确定性规则或先例");
      }
      return parsed.data;
    } catch (error) {
      return this.fail(request, error instanceof Error ? error.message : "Judge 调用失败");
    } finally { clearTimeout(timer); }
  }

  /** Shadow 模式只产出观察结果，调用方不得据此执行。 */
  async shadow(request: JudgeRequest): Promise<JudgeVerdict> {
    const verdict = await this.predict(request);
    this.options.onShadow?.({ request, verdict });
    return verdict;
  }

  private fail(request: JudgeRequest, reason: string): JudgeVerdict {
    this.options.onShadow?.({ request, verdict: { verdict: "FAILED", reason } });
    return { verdict: "HOLD", reason, citedRuleIds: [], citedDecisionIds: [] };
  }
}
