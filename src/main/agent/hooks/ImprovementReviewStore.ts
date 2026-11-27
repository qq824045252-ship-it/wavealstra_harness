import type { ImprovementKind, ImprovementRun } from "../../../shared/native-improvement";
import type { RuntimeAuditReader, NativePersistenceReply } from "../../platform/runtime-audit";
import type { HookFeedbackSource } from "./NativeHookStore";

export type ManagedImprovement = { key: string; hook: string; revision: number; installed: number; week: string };
export type ReviewBinding = { taskId: string; directory: string; cwd: string; projectId: string | null; spaceId: string | null };
export type ImprovementGroup = { key: string; kind: ImprovementKind; scope: string; total: number; cost: number | null };
export type ReviewSnapshot = {
  managed: ManagedImprovement[];
  items: (ImprovementGroup & {
    sources: { source: string }[];
    feedback: HookFeedbackSource[];
    pendingReason: string | null;
    assessment: { assessment: string; source: string } | null;
  })[];
  runs: (Omit<ImprovementRun, "issues" | "followup"> & {
    issues: string; followup: { metrics: string }[]; assessmentErrors: { error: string }[];
  })[];
  children: { task: string; directory: string; summary: string }[];
};

type ScanObservation = {
  key: string; kind: ImprovementKind; scope: string; entry: number;
  source: string; replay: string; generation?: number;
};

export type ImprovementReviewQuery =
  | { kind: "bindings"; task?: string }
  | { kind: "source"; key: string; task: string; conversation: string; entry: number }
  | { kind: "children"; task: string }
  | { kind: "checkpoint"; task: string; conversation: string }
  | { kind: "managed" | "groups" }
  | { kind: "samples"; key: string }
  | { kind: "unverified"; key: string; source: string }
  | { kind: "unfinished"; through: string }
  | { kind: "assessmentCandidates"; week: string }
  | { kind: "weeklyStats"; week: string; start: number; end: number }
  | { kind: "report"; exportWeek?: string };

type ReviewChange =
  | { kind: "saveScan"; week: string; task: string; conversation: string; state: string; observations: ScanObservation[]; scanned: number }
  | { kind: "saveChild"; task: string; directory: string; conversation: number; childId: string; immutable: boolean; summary: string }
  | { kind: "pruneChildren"; task: string; seen: number[] }
  | { kind: "reserveSlot" | "releaseSlot"; key: string; week: string }
  | ({ kind: "saveManaged" } & ManagedImprovement)
  | { kind: "unverified"; key: string; source: string; reason: string }
  | { kind: "followup"; week: string; key: string; metrics: string }
  | { kind: "finishScan"; week: string; at: number; duration: number; issues: string }
  | { kind: "markExported"; week: string; finished: boolean }
  | { kind: "sealReview" | "assessmentStarted"; week: string }
  | { kind: "reserveAssessment"; key: string; week: string; source: string }
  | { kind: "assessmentResult"; key: string; week: string; source: string; assessment?: string; error?: string };

export type ImprovementReviewMutation =
  | { kind: "begin"; owner: string; week: string; at: number; scheduled: boolean }
  | { kind: "renew" | "release"; owner: string }
  | { kind: "write"; owner: string; change: ReviewChange };

export class ImprovementReviewStore {
  constructor(private readonly core: Pick<RuntimeAuditReader, "readImprovementReview" | "writeImprovementReview"> | undefined) {}

  bindings(task?: string): Promise<ReviewBinding[]> {
    return this.read({ kind: "bindings", task });
  }

  async binding(task: string): Promise<ReviewBinding | undefined> {
    const [binding] = await this.bindings(task);
    return binding;
  }

  async read<T>(query: ImprovementReviewQuery): Promise<T> {
    return this.unwrap(await this.core?.readImprovementReview<T>(query));
  }

  async command<T>(mutation: ImprovementReviewMutation): Promise<T> {
    return this.unwrap(await this.core?.writeImprovementReview<T>(mutation));
  }

  write<T = null>(owner: string, change: ReviewChange): Promise<T> {
    return this.command<T>({ kind: "write", owner, change });
  }

  private unwrap<T>(reply: NativePersistenceReply<T> | undefined): T {
    if (!reply) throw new Error("Core 改进复盘账本不可用");
    if (reply.status === "rejected") throw new Error(reply.message);
    return reply.data;
  }
}
