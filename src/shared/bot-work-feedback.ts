import { z } from "zod";
import { workVerificationSchema } from "./bot-work-verification";

const id = z.string().trim().min(1).max(200);

/** Host-authored durable Work feedback, never inferred from message wording. */
export const workFeedbackSchema = z.object({
  workId: id, eventId: z.string().min(1).max(500), kind: z.enum(["binding", "result", "blocker", "closure"]),
  category: z.enum(["progress", "decision", "result"]), executionId: id.optional(),
  intentRevision: z.number().int().positive().optional(), inputSnapshotId: z.string().min(1).max(2000).optional(),
  /** Immutable host projection of this exact result version; text retains the full original record. */
  report: z.object({
    title: z.string(), summary: z.string(), artifactRefs: z.array(z.string()),
    /** Display-only verified partial progress, never a goal-completion review. */
    milestone: z.literal(true).optional(),
    /** This is the foreground goal review, not the worker's execution status. */
    completion: z.object({ outcome: z.enum(["completed", "partial", "unknown"]), nextStep: z.enum(["deliver", "continue", "ask"]) }).strict().optional(),
    verification: workVerificationSchema.optional(),
    primaryArtifactRefs: z.array(z.string()).optional(),
    sourceNotices: z.array(z.string()).optional(),
    files: z.array(z.object({ ref: z.string(), name: z.string(), openPath: z.string().optional(), previewManifestPath: z.string().optional() }).strict()).optional(),
    reviewStatus: z.enum(["proposed", "accepted", "rejected", "superseded"]),
    current: z.boolean(), notices: z.array(z.string()),
    teamFacts: z.array(z.object({ displayName: z.string(), responsibility: z.string(), executionStatus: z.string(),
      failureReason: z.string().optional(), failureSummary: z.string().optional(), sourceRefs: z.array(z.string()) }).strict()).optional(),
    structured: z.object({ version: z.literal(1), conclusions: z.array(z.object({ text: z.string(), requestMessageId: z.string(),
      requestText: z.string(), sources: z.array(z.object({ ref: z.string(), label: z.string() }).strict()) }).strict()),
      observations: z.array(z.string()) }).strict().optional(),
  }).strict().optional(),
}).strict().superRefine((feedback, ctx) => {
  const verification = feedback.report?.verification;
  if (verification && (!feedback.report?.completion || feedback.report.milestone || feedback.kind !== "result"))
    ctx.addIssue({ code: "custom", path: ["report", "verification"], message: "核对快照只属于结果核对，不能把阶段进展当作目标核对" });
  if (verification && (verification.workId !== feedback.workId || verification.executionId !== feedback.executionId
    || verification.intentRevision !== feedback.intentRevision || verification.inputSnapshotId !== feedback.inputSnapshotId))
    ctx.addIssue({ code: "custom", path: ["report", "verification"], message: "核对记录必须属于本条结果的任务、执行和输入版本" });
});
export type WorkFeedbackDto = z.infer<typeof workFeedbackSchema>;
