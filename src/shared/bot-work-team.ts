import { z } from "zod";
import type { WorkDto, WorkExecutionStatus } from "./bot-work";

const id = z.string().trim().min(1).max(200);
const responsibility = z.string().trim().min(1).max(2000);
export const workTeamMemberSchema = z.object({
  botId: id,
  responsibility,
  dependsOnBotIds: z.array(id).max(24).optional(),
  delegatedScope: z.array(z.enum(["workspace:read", "workspace:write"])).min(1).max(2)
    .refine(scopes => new Set(scopes).size === scopes.length, "范围不能重复"),
}).strict();
export const workTeamPlanSchema = z.object({
  ownerBotId: id,
  ownerResponsibility: responsibility,
  members: z.array(workTeamMemberSchema).min(1).max(24),
  executionPolicy: z.enum(["sequential", "parallel"]).optional(),
  maxConcurrency: z.number().int().min(1).max(4).optional(),
}).strict().superRefine((plan, ctx) => {
  const ids = plan.members.map(member => member.botId);
  if (new Set(ids).size !== ids.length || ids.includes(plan.ownerBotId)) {
    ctx.addIssue({ code: "custom", message: "成员必须唯一，负责人不能同时作为成员" });
  }
  for (const [index, member] of plan.members.entries()) {
    const dependencies = member.dependsOnBotIds ?? [];
    if (new Set(dependencies).size !== dependencies.length || dependencies.some(botId => !ids.slice(0, index).includes(botId)))
      ctx.addIssue({ code: "custom", message: "依赖只能选择排在前面的不同成员，不能重复、自依赖或形成循环" });
  }
});
export const createTeamWorkSchema = workTeamPlanSchema.safeExtend({
  operationId: id,
  title: z.string().trim().min(1).max(240),
  goalDescription: z.string().trim().min(1).max(2000),
  workspacePath: z.string().trim().min(1).max(4096),
  projectId: id.optional(),
  conversationId: id.optional(),
  criteria: z.array(z.string().trim().min(1).max(1000)).min(1).max(12),
  budgetTokens: z.number().int().min(1024).max(1000000).default(32768),
});
const versionGuard = z.object({ expectedStateVersion: z.number().int().positive(),
  expectedIntentRevision: z.number().int().positive(), expectedOwnerEpoch: z.number().int().positive() }).strict();
export const workTeamControlSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create"), request: createTeamWorkSchema }).strict(),
  z.object({ kind: z.literal("get"), workId: id }).strict(),
  z.object({ kind: z.literal("retry"), workId: id, versionGuard, confirmNotStarted: z.literal(true) }).strict(),
  z.object({ kind: z.literal("replan"), workId: id, versionGuard, plan: workTeamPlanSchema }).strict(),
  z.object({ kind: z.literal("list_templates") }).strict(),
  z.object({ kind: z.literal("save_template"), request: z.object({ operationId: id,
    name: z.string().trim().min(1).max(120), plan: workTeamPlanSchema }).strict() }).strict(),
  z.object({ kind: z.literal("delete_template"), templateId: id }).strict(),
]);
export type WorkTeamMember = z.infer<typeof workTeamMemberSchema>;
export type WorkTeamPlan = z.infer<typeof workTeamPlanSchema>;
export type CreateTeamWorkRequest = z.input<typeof createTeamWorkSchema>;
export type WorkTeamControlRequest = z.input<typeof workTeamControlSchema>;
export interface WorkTeamExecution extends WorkTeamMember {
  role: "member" | "owner_summary";
  taskId: string;
  bindingId?: string;
  status: WorkExecutionStatus | "queued" | "blocked" | "cancelled";
  error?: string;
  resultSummary?: string;
  waitingReason?: string;
}
export interface WorkTeamDto extends WorkTeamPlan {
  workId: string;
  intentRevision: number;
  inputSnapshotId: string;
  ownerEpoch: number;
  state: "queued" | "running" | "blocked" | "awaiting_review" | "paused" | "cancelled" | "superseded" | "completed" | "ended_unsuccessfully" | "closing";
  executions: WorkTeamExecution[];
  createdAt: number;
}
export interface WorkTeamTemplateDto extends WorkTeamPlan {
  templateId: string;
  name: string;
  createdAt: number;
}
export type WorkTeamControlResult =
  | { ok: true; operationId?: string; work?: WorkDto; team?: WorkTeamDto; templates?: WorkTeamTemplateDto[]; template?: WorkTeamTemplateDto; replayed?: boolean }
  | { ok: false; code: string; message: string };
