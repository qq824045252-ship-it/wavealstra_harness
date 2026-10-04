export type RecoveryClass = "retryable" | "recoverable" | "requires-user-action" | "terminal";

export interface ExecutionFailureDto {
  id: string;
  taskId: string;
  assistantMessageId?: string;
  executionId?: string;
  causeCode: string;
  phase: "prepare" | "execute" | "observe" | "verify" | "recover";
  recovery: RecoveryClass;
  sideEffects: "none" | "known" | "unknown";
  message: string;
  nextAction: string;
  spaceId?: string;
  target?: string;
  createdAt: number;
  resolvedAt?: number;
  /** User hid the card; the failure may still be unresolved. */
  dismissedAt?: number;
}
