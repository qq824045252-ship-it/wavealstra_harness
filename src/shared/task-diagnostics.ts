export type DiagnosticSource = "main" | "subagent" | "auxiliary";
export interface ReportedTokenUsage {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
}
export interface ModelRequestDiagnostic {
  id: string;
  taskId: string | null;
  executionScope: string;
  conversationId: string;
  generationTaskId: number;
  /**
   * 该请求所属的「轮」身份，与 ToolDiagnostic.executionId / WaitDiagnostic.executionId 同一个口径：
   * Durable 下为 `durable:${taskId}:${conversationId}:${turnTaskId}`（turnTaskId 即 generationTaskId）。
   * 由主进程在读取时派生，旧记录也能得到（无需迁移）。
   */
  executionId: string;
  sourceKind: DiagnosticSource;
  provider: string;
  model: string;
  startedAt: number;
  firstResponseAt: number | null;
  finishedAt: number | null;
  modelMs: number | null;
  status: "running" | "completed" | "failed" | "aborted" | "interrupted";
  outcome: string | null;
  error: string | null;
  usage: ReportedTokenUsage;
  usageSource: string | null;
  knownCostUsd: number | null;
  costComplete: boolean;
  costSource: "provider-reported" | "pi-native" | "sdk-default" | null;
  attempts: Array<{ number: number; startedAt: number; finishedAt: number | null; httpStatus: number | null }>;
  cacheContext: { previousRequestId: string | null; prefixStable: boolean | null; changedFields: string[]; coverage: string };
}
export interface ToolDiagnosticEvent {
  phase: "start" | "finish";
  taskId?: string;
  executionScope?: string;
  conversationId: string;
  toolTaskId: number;
  callId: string;
  name: string;
  sourceKind: DiagnosticSource;
  at: number;
  isError?: boolean;
  diagnostics?: string[];
}
export interface ToolDiagnostic {
  id: string;
  conversationId: string;
  executionId: string;
  sourceKind: DiagnosticSource;
  name: string;
  callId: string;
  startedAt: number;
  finishedAt: number | null;
  status: "running" | "completed" | "failed" | "interrupted";
  observedMs: number;
  activeMs: number;
  waitingMs: number;
  complete: boolean;
  diagnostics: string[];
}
export interface WaitDiagnostic {
  id: string;
  executionId: string;
  title: string;
  startedAt: number;
  finishedAt: number | null;
  status: string;
}
export interface TaskDiagnosticsDto {
  taskId: string;
  capturedAt: number;
  offset: number;
  requests: ModelRequestDiagnostic[];
  tools: ToolDiagnostic[];
  waits: WaitDiagnostic[];
  truncated: boolean;
  unavailable?: string;
  totals: {
    modelMs: number | null;
    toolMs: number | null;
    waitingMs: number;
    knownCostUsd: number | null;
    costComplete: boolean;
    unknownUsageRequests: number;
  };
}
