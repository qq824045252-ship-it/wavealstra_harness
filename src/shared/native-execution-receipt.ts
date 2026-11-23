import { z } from "zod";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

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

export function nativeExecutionOperationId(identity: Pick<NativeExecutionReceipt, "conversationId" | "toolTaskId" | "callId">): string {
  return `tool:${identity.conversationId}:${identity.toolTaskId}:${identity.callId}`;
}

const receiptDetails = z.object({ executionReceipt: nativeExecutionReceiptSchema });

export function readNativeExecutionReceipt(details: unknown): NativeExecutionReceipt | undefined {
  return receiptDetails.safeParse(details).data?.executionReceipt;
}

type NativeResult = { details?: unknown; isError?: boolean };
type NativeResultIdentity = Partial<Pick<NativeExecutionReceipt, "taskId" | "conversationId" | "toolTaskId" | "toolName" | "callId">>;

/** An old result may have only Pi's error flag. A present receipt must match
 * the result that carries it, and cannot override a transport error. */
export function nativeExecutionSucceeded(result: NativeResult, identity?: NativeResultIdentity): boolean {
  if (result.isError) return false;
  const { details } = result;
  if (!details || typeof details !== "object" || !Object.hasOwn(details, "executionReceipt")) return true;
  const receipt = readNativeExecutionReceipt(details);
  return receipt?.status === "passed" && Object.entries(identity ?? {}).every(([key, value]) =>
    value === undefined || receipt[key as keyof NativeResultIdentity] === value);
}
