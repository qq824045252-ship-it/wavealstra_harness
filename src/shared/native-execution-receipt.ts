import { z } from "zod";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
export const nativeFileReadAttemptSchema = z.object({
  target: z.string().min(1), openFailure: z.string().min(1).optional(), contentSha256: sha256.optional(),
});

/** Issued by the host for one native ToolTask after execution and verification. */
export const nativeExecutionReceiptSchema = z.object({
  version: z.literal(1),
  taskId: z.string().min(1),
  conversationId: z.number().int().nonnegative(),
  toolTaskId: z.number().int().nonnegative(),
  callId: z.string().min(1),
  toolName: z.string().min(1),
  executionId: z.string().min(1),
  assistantMessageId: z.string().min(1),
  attemptId: z.string().min(1).optional(),
  status: z.enum(["passed", "failed", "inconclusive"]),
  transport: z.enum(["returned", "not_started", "interrupted"]),
  settlement: z.enum(["consumed", "released", "unknown"]),
  exitCode: z.number().int().optional(),
  causeCode: z.string().min(1).optional(),
  verifierId: z.string().min(1),
  verifierVersion: z.number().int().positive(),
  checkedAt: z.number().int().nonnegative(),
  fileReadAttempt: nativeFileReadAttemptSchema.optional(),
  fileRead: z.object({
    target: z.string().min(1), outputHash: sha256, returnedChars: z.number().int().nonnegative(),
    images: z.number().int().nonnegative(), partial: z.boolean(),
    offset: z.number().int().positive().optional(), limit: z.number().int().positive().optional(),
  }).optional(),
  fileChange: z.object({
    target: z.string().min(1),
    checkedRange: z.object({ sha256, bytes: z.number().int().nonnegative(), offset: z.number().int().nonnegative().optional() }).optional(),
  }).optional(),
}).strict();

export type NativeExecutionReceipt = z.infer<typeof nativeExecutionReceiptSchema>;

/** Compare full file versions only when the native tool observed all bytes. */
export function nativeFileVersion(receipt?: NativeExecutionReceipt): string | undefined {
  const change = receipt?.fileChange?.checkedRange;
  if (change && change.offset === undefined) return change.sha256;
  if (receipt?.fileRead?.partial === true) return undefined;
  return receipt?.fileReadAttempt?.contentSha256;
}

export function nativeExecutionOperationId(identity: Pick<NativeExecutionReceipt, "conversationId" | "toolTaskId" | "callId">): string {
  return `tool:${identity.conversationId}:${identity.toolTaskId}:${identity.callId}`;
}

const receiptDetails = z.object({ executionReceipt: nativeExecutionReceiptSchema });

export function readNativeExecutionReceipt(details: unknown): NativeExecutionReceipt | undefined {
  return receiptDetails.safeParse(details).data?.executionReceipt;
}

export function hasNativeExecutionReceipt(details: unknown): boolean {
  return !!details && typeof details === "object" && Object.hasOwn(details, "executionReceipt");
}

type NativeResult = { details?: unknown; isError?: boolean };
type NativeResultIdentity = Partial<Pick<NativeExecutionReceipt, "taskId" | "conversationId" | "toolTaskId" | "toolName" | "callId">>;

export function matchingNativeExecutionReceipt(result: NativeResult, identity: NativeResultIdentity): NativeExecutionReceipt | undefined {
  const receipt = readNativeExecutionReceipt(result.details);
  return receipt && Object.entries(identity).every(([key, value]) =>
    value === undefined || receipt[key as keyof NativeResultIdentity] === value) ? receipt : undefined;
}

/** An old result may have only Pi's error flag. A present receipt must match
 * the result that carries it, and cannot override a transport error. */
export function nativeExecutionSucceeded(result: NativeResult, identity?: NativeResultIdentity): boolean {
  if (result.isError) return false;
  if (!hasNativeExecutionReceipt(result.details)) return true;
  return matchingNativeExecutionReceipt(result, identity ?? {})?.status === "passed";
}
