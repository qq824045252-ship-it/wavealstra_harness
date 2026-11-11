import { z } from "zod";
import type { WorkProjectionDto } from "./bot-work";
export const workListStatusGroups = ["running", "waiting", "attention", "results", "watching", "paused", "succeeded", "cancelled", "unsuccessful", "ended"] as const;
export type WorkListStatusGroup = typeof workListStatusGroups[number];
export const workQueryRequestSchema = z.object({
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("personal"), botId: z.string().min(1) }),
    z.object({ kind: z.literal("team"), teamId: z.string().min(1) }),
    z.object({ kind: z.literal("historical_teams") }),
    z.object({ kind: z.literal("removed_teams") }),
    z.object({ kind: z.literal("all") }),
  ]),
  view: z.enum(["active", "completed", "closed", "all"]).optional(),
  query: z.string().max(10000).optional(),
  status: z.enum(["all", ...workListStatusGroups]).optional(),
  sort: z.enum(["recent", "oldest"]).optional(),
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
  showDeleted: z.boolean().optional(),
  candidateTaskIds: z.array(z.string().min(1)).max(500).optional(),
  watermark: z.object({ epoch: z.string(), sequence: z.number().int().nonnegative(), revision: z.string().optional() }).optional(),
});
export type WorkQueryRequest = z.infer<typeof workQueryRequestSchema>;
export interface WorkQueryResult {
  works: WorkProjectionDto[];
  /** Candidate task IDs bound to scoped works, including hidden/archived records. */
  workExecutionTaskIds: string[];
  total: number;
  filtered: number;
  page: number;
  pageSize: number;
  pages: number;
  filterCounts: Partial<Record<WorkListStatusGroup, number>>;
  viewCounts: { active: number; completed: number; closed: number; all: number };
  deletedCount: number;
  /** Current snapshot, not a historical page token. Requery replaces the page. */
  watermark: { epoch: string; sequence: number; revision: string };
}
export interface WorkListSummary {
  status: { label: string; group: WorkListStatusGroup };
  excerpt: string;
  hasResultExcerpt?: boolean;
  deliverableCount: number;
  nextCheckAt?: number;
  canArchive: boolean;
  executionTaskIds: string[];
  running: boolean;
}
