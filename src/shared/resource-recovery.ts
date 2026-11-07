/** One durable recovery generation, carried to native queues and their receipts. */
export interface ResourceRecoveryAttempt {
  readonly token: number;
  readonly attempt: number;
  readonly signal: AbortSignal;
  /** Checks cancellation, host authority and the persisted lease/attempt identity. */
  assertCurrent(): void;
}
