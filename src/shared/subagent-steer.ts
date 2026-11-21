export interface SubagentSteerReceipt {
  requestId: string;
  submissionId: number;
  accepted: true;
  instruction: string;
  origin?: "user" | "parent";
  status: "queued" | "processed" | "settled" | "cancelled" | "unprocessed" | "unanswered";
  nativeStatus: "queued" | "placed" | "done" | "unanswered";
  entryId?: number;
  answerEntryId?: number;
  reason?: string;
  detail?: string;
}

export type SubagentSteerResultDto =
  | { ok: true; receipt: SubagentSteerReceipt }
  | { ok: false; requestId: string; reason: string; message: string };
