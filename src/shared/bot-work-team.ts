import { workWatchNormalizedSchema } from "./work-watch-intent";
import { z } from "zod";
import type { WorkDto, WorkExecutionStatus } from "./bot-work";

const id = z.string().trim().min(1).max(200);
const responsibility = z.string().trim().min(1).max(2000);
export const workTeamMemberSchema = z.object({
  botId: id,
  responsibility,
  dependsOnBotIds: z.array(id).max(24).optional(),
  /** Legacy metadata only; retired grants must not prevent team creation. */
  delegatedScope: z.array(z.enum(["workspace:read", "workspace:write"])).max(2)
    .refine(scopes => new Set(scopes).size === scopes.length, "范围不能重复").default([]),
}).strict();
/** Per-commission planning over an existing user-selected team, not new grants. */
export const workTeamTaskAssignmentSchema = z.object({
  ownerResponsibility: responsibility,
  members: z.array(z.object({
    botId: id,
    responsibility,
    dependsOnBotIds: z.array(id).max(24).optional(),
  }).strict()).min(1).max(24),
}).strict();
export type WorkTeamTaskAssignment = z.infer<typeof workTeamTaskAssignmentSchema>;
/** A primary Bot assembling a new named team from existing Bots. The host supplies
the owner identity and scopes; the model only chooses available members and duties. */
export const workTeamBuildSchema = z.object({
  name: z.string().trim().min(1).max(120),
  ownerResponsibility: responsibility,
  members: z.array(z.object({
    botId: id,
    responsibility,
    dependsOnBotIds: z.array(id).max(24).optional(),
  }).strict()).min(1).max(24),
  executionPolicy: z.enum(["sequential", "parallel"]).optional(),
  maxConcurrency: z.number().int().min(1).max(4).optional(),
  /** Optional team folder; omitted means the host-managed team directory. */
  workspacePath: z.string().trim().min(1).max(4096).optional(),
}).strict().superRefine((plan, ctx) => {
  const ids = plan.members.map(member => member.botId);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "成员必须唯一" });
  for (const [index, member] of plan.members.entries()) {
    const dependencies = member.dependsOnBotIds ?? [];
    if (new Set(dependencies).size !== dependencies.length || dependencies.some(botId => !ids.slice(0, index).includes(botId)))
      ctx.addIssue({ code: "custom", message: "依赖只能选择排在前面的不同成员，不能重复、自依赖或形成循环" });
  }
});
export type WorkTeamBuildInput = z.infer<typeof workTeamBuildSchema>;
export const workTeamPlanSchema = z.object({
  ownerBotId: id,
  ownerResponsibility: responsibility,
  members: z.array(workTeamMemberSchema).min(1).max(24),
  executionPolicy: z.enum(["sequential", "parallel"]).optional(),
  maxConcurrency: z.number().int().min(1).max(4).optional(),
  /** Optional team-specific folder; omitted means the host-managed team directory. */
  workspacePath: z.string().trim().min(1).max(4096).optional(),
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
  mode: z.enum(["once", "watch"]).optional(),
  watchRule: workWatchNormalizedSchema.optional(),
  deadlineAt: z.number().int().nonnegative().optional(),
  operationId: id,
  /** Required for new admission; optional only to validate persisted operation replays. */
  templateId: id.optional(),
  title: z.string().trim().min(1).max(240),
  goalDescription: z.string().trim().min(1).max(2000),
  workspacePath: z.string().trim().min(1).max(4096),
  projectId: id.optional(),
  conversationId: id.optional(),
  criteria: z.array(z.string().trim().min(1).max(1000)).min(1).max(12),
});
const versionGuard = z.object({ expectedStateVersion: z.number().int().positive(),
  expectedIntentRevision: z.number().int().positive(), expectedOwnerEpoch: z.number().int().positive() }).strict();
export const workTeamControlSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create"), request: createTeamWorkSchema }).strict(),
  z.object({ kind: z.literal("get"), workId: id }).strict(),
  z.object({ kind: z.literal("get_by_operation"), operationId: id }).strict(),
  z.object({ kind: z.literal("retry"), workId: id, versionGuard, confirmNotStarted: z.literal(true) }).strict(),
  z.object({ kind: z.literal("replan"), workId: id, operationId: id.optional(), versionGuard, plan: workTeamPlanSchema }).strict(),
  z.object({ kind: z.literal("resolve_workspace"), templateId: id }).strict(),
  z.object({ kind: z.literal("list_templates"), includeDeleted: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal("save_template"), request: z.object({ operationId: id,
    name: z.string().trim().min(1).max(120), plan: workTeamPlanSchema }).strict() }).strict(),
  z.object({ kind: z.literal("update_template"), templateId: id,
    name: z.string().trim().min(1).max(120), plan: workTeamPlanSchema,
    expected: z.object({ name: z.string(), plan: workTeamPlanSchema }).strict() }).strict(),
  z.object({ kind: z.literal("set_work_team"), workId: id, templateId: id }).strict(),
  z.object({ kind: z.literal("remove_work"), workId: id }).strict(),
  z.object({ kind: z.literal("stop_and_remove_work"), workId: id }).strict(),
  z.object({ kind: z.literal("restore_work"), workId: id }).strict(),
  z.object({ kind: z.literal("restore_template"), templateId: id }).strict(),
  z.object({ kind: z.literal("delete_template"), templateId: id }).strict(),
]);
export type WorkTeamMember = z.infer<typeof workTeamMemberSchema>;
export type WorkTeamPlan = z.infer<typeof workTeamPlanSchema>;
export type CreateTeamWorkRequest = z.input<typeof createTeamWorkSchema>;
export type WorkTeamControlRequest = z.input<typeof workTeamControlSchema>;
export interface WorkTeamForegroundReplanInput {
  workId: string;
  operationId: string;
  conversationId: string;
  sourceMessageId: string;
  versionGuard: z.infer<typeof versionGuard>;
  taskAssignment: WorkTeamTaskAssignment;
  executionPolicy?: WorkTeamPlan["executionPolicy"];
  maxConcurrency?: number;
}
export interface WorkTeamExecution extends WorkTeamMember {
  role: "member" | "owner_summary";
  taskId: string;
  bindingId?: string;
  status: WorkExecutionStatus | "queued" | "recovering" | "recovered" | "blocked" | "cancelled";
  error?: string;
  resultSummary?: string;
  waitingReason?: string;
  /** A terminal dependency prevented this member from starting; no native receipt exists. */
  notStartedReason?: string;
  /** Durable automatic-recovery progress; the original task/member identity is unchanged. */
  recoveryState?: "pending" | "claimed" | "dispatched" | "completed" | "stopped";
  recoveryGeneration?: number;
  recoveryAttempts?: number;
  recoveryOutcome?: string;
  failureReason?: string;
}
export interface WorkTeamDto extends WorkTeamPlan {
  /** Stable owning team; may be absent only on historical records. */
  teamId?: string;
  teamName?: string;
  /** Recoverable removal from normal team/task lists; execution and artifacts remain intact. */
  removedAt?: number;
  removalRequestedAt?: number;
  workId: string;
  /** Execution strategy changes independently of the user's requirement revision. */
  planRevision: number;
  intentRevision: number;
  inputSnapshotId: string;
  ownerEpoch: number;
  state: "watching" | "expired" | "queued" | "running" | "blocked" | "awaiting_review" | "paused" | "cancelled" | "superseded" | "completed" | "ended_unsuccessfully" | "closing";
  watchRound?: number;
  executions: WorkTeamExecution[];
  createdAt: number;
}
export interface WorkTeamTemplateDto extends WorkTeamPlan {
  deletedAt?: number;
  templateId: string;
  name: string;
  createdAt: number;
}
export type WorkTeamControlResult =
  | { ok: true; workspacePath?: string; operationId?: string; work?: WorkDto; team?: WorkTeamDto; templates?: WorkTeamTemplateDto[]; template?: WorkTeamTemplateDto; replayed?: boolean }
  | { ok: false; code: string; message: string };
