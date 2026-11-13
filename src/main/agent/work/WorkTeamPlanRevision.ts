import { z } from "zod";
import { workTeamPlanSchema, type WorkTeamPlan } from "../../../shared/bot-work-team";

const storedPlanSchema = workTeamPlanSchema.safeExtend({
  planRevision: z.number().int().positive().default(1),
  predecessors: z.array(z.object({ taskId: z.string(), priorTaskIds: z.array(z.string()) }).strict()).default([]),
  retainedResults: z.object({ taskIds: z.array(z.string()), watchRound: z.number().int().positive().optional() }).strict().optional(),
});

export type TeamPlanPredecessors = z.infer<typeof storedPlanSchema>["predecessors"];
type RetainedTeamResults = z.infer<typeof storedPlanSchema>["retainedResults"];

export function readTeamPlan(value: string): { plan: WorkTeamPlan; revision: number; predecessors: TeamPlanPredecessors; retainedResults: RetainedTeamResults } {
  const { planRevision, predecessors, retainedResults, ...plan } = storedPlanSchema.parse(JSON.parse(value));
  return { plan, revision: planRevision, predecessors, retainedResults };
}

export function writeTeamPlan(plan: WorkTeamPlan, revision: number, predecessors: TeamPlanPredecessors = [], retainedResults?: RetainedTeamResults): string {
  return JSON.stringify({ ...plan, planRevision: revision, predecessors, retainedResults });
}
