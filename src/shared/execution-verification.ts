export interface ExecutionVerificationResult {
  taskId: string;
  executionId: string;
  assistantMessageId: string;
  verifierId: string;
  verifierVersion: number;
  attemptId: string;
  target: string;
  canonicalTarget: string;
  status: "passed" | "failed" | "inconclusive" | "not_run";
  expected: Record<string, unknown>;
  observed?: Record<string, unknown>;
  causeCode?: string;
  checkedAt: number;
}
