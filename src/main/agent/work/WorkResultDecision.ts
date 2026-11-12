import { z } from "zod";

/** Pure result contracts; importing Work facts must not load the model runtime. */
export const watchStopAssessmentSchema = z.object({
  status: z.enum(["met", "not_met", "unknown", "not_applicable"]),
  conditionExcerpt: z.string().max(2000), requestExcerpt: z.string().max(4000),
  evidence: z.array(z.object({ resultId: z.string().min(1), quote: z.string().min(1).max(4000) }).strict()).max(8),
}).strict();
export const watchPriorRiskAssessmentSchema = z.object({
  status:z.enum(["independent","dependent","unknown"]),riskIds:z.array(z.string().min(1)).min(1).max(40),
  reason:z.string().trim().min(1).max(2000),requestExcerpt:z.string().trim().min(1).max(4000),
  evidence:z.array(z.object({resultId:z.string().min(1),quote:z.string().trim().min(1).max(4000)}).strict()).min(1).max(8),
}).strict();
export const watchFollowUpSchema = z.object({
  task: z.string().trim().min(1).max(1500),
  requestExcerpt: z.string().trim().min(1).max(1500),
}).strict();
export const teamMissingTargetSchema = z.object({
  sourceBindingId: z.string().min(1), botId: z.string().min(1), responsibility: z.string().min(1),
  intentRevision: z.number().int(), inputSnapshotId: z.string().min(1),
  evidence: z.object({ deliverableId: z.string().min(1), quote: z.string().trim().min(1).max(4000) }).strict(),
}).strict();
export const workWaitPlanSchema = z.object({
  basis:z.enum(["user_specified","observed_dependency"]),
  requestExcerpt:z.string().trim().min(1).max(1500),reason:z.string().trim().min(1).max(1500),
  nextWakeAt:z.number().int().nonnegative().max(8640000000000000).optional(),
  eventSource:z.string().trim().min(1).max(200).optional(),eventTarget:z.string().trim().min(1).max(2000).optional(),
  evidence:z.object({resultId:z.string().min(1),quote:z.string().trim().min(1).max(4000)}).strict().optional(),
}).strict().superRefine((plan,ctx)=>{
  if ((plan.nextWakeAt!==undefined)===Boolean(plan.eventSource)) ctx.addIssue({code:"custom",message:"等待须选择一次时刻或事件来源之一"});
  if (plan.basis==="observed_dependency"&&!plan.evidence) ctx.addIssue({code:"custom",message:"外部依赖等待须附本轮原生证据"});
});
export const resultDecisionSchema = z.object({
  decision: z.enum(["deliver", "continue", "ask", "wait"]),
  outcome: z.enum(["completed", "partial", "unknown"]),
  reply: z.string().trim().min(1).max(16000),
  artifactRefs: z.array(z.string().min(1)).max(20).optional(),
  priorRiskAssessment: watchPriorRiskAssessmentSchema.optional(),
  notificationAssessment: watchStopAssessmentSchema.optional(),
  stopAssessment: watchStopAssessmentSchema.optional(),
  followUp: watchFollowUpSchema.optional(),
  waitPlan: workWaitPlanSchema.optional(),
  userInput: z.object({ requestExcerpt: z.string().trim().min(1).max(1500) }).strict().optional(),
  correction: z.object({ kind: z.literal("host_delivery_responsibility") }).strict().optional(),
  missing: z.array(z.object({ task: z.string().trim().min(1).max(1500), requestExcerpt: z.string().trim().min(1).max(1500), teamTarget: teamMissingTargetSchema.optional(), readOnly: z.boolean().optional() }).strict()).max(8),
}).strict().superRefine((decision, ctx) => {
  if (decision.decision !== "continue" && decision.missing.length) {
    ctx.addIssue({ code: "custom", path: ["missing"], message: "非 continue 时 missing 必须为空数组；已知缺口仍须在 reply 中如实说明" });
  }
  if (decision.decision === "wait" && (!decision.userInput || decision.outcome === "completed" || decision.waitPlan || decision.followUp)) {
    ctx.addIssue({ code: "custom", path: ["userInput"], message: "wait 必须引用原用户等待输入的要求，保持 partial/unknown，不能同时安排执行或外部等待计划" });
  }
});
export type WorkResultDecision = z.infer<typeof resultDecisionSchema>;
export interface WorkResultTurnInput { eventId: string; botId: string; context: Record<string, unknown>; personalPreferences?: string }
