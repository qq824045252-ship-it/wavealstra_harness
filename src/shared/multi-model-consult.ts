/** Product-owned, one-shot consultation. No scheduler, judge or persistent child sessions. */
export const MULTI_MODEL_CONSULT_TOOL = "multi_model_consult";
export const CONSULT_MAX_PARTICIPANTS = 6;
export const CONSULT_MAX_TOOL_CALLS = 24;

export interface ConsultParticipant {
  /** Exact Pi provider/model identity; never automatically substituted. */
  modelId: string;
  /** Undefined follows the existing Pi per-model/default preference. */
  thinkingLevel?: string;
}

export interface MultiModelConsultConfig {
  enabled: boolean;
  participants: ConsultParticipant[];
  maxParallel: number;
  readProjectFiles: boolean;
  timeoutSeconds: number;
}

export const DEFAULT_MULTI_MODEL_CONSULT_CONFIG: MultiModelConsultConfig = {
  enabled: false,
  participants: [],
  maxParallel: 3,
  readProjectFiles: true,
  timeoutSeconds: 300,
};

export interface MultiModelConsultInput {
  task: string;
  /** Explicit shared evidence only, not the parent's conversation transcript. */
  context?: string;
}

export type ConsultWorkerStatus = "queued" | "running" | "complete" | "error" | "cancelled" | "timeout";
export interface ConsultToolTrace {
  id: string;
  name: string;
  arguments: unknown;
  status: "running" | "success" | "error" | "cancelled";
  output?: string;
  outputTruncated?: boolean;
}
export interface ConsultWorkerResult {
  modelId: string;
  modelName?: string;
  thinkingLevel?: string;
  status: ConsultWorkerStatus;
  startedAt?: number;
  endedAt?: number;
  /** Complete provider-visible answer, never a generated summary or hidden reasoning. */
  answer: string;
  error?: string;
  tools: ConsultToolTrace[];
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}
export interface MultiModelConsultReport {
  schemaVersion: 1;
  id: string;
  taskId: string;
  task: string;
  context?: string;
  startedAt: number;
  endedAt?: number;
  status: "running" | "complete" | "partial" | "degraded" | "failed" | "cancelled";
  expected: number;
  succeeded: number;
  workers: ConsultWorkerResult[];
}

export function normalizeConsultConfig(raw: unknown): MultiModelConsultConfig {
  const v = (raw && typeof raw === "object" ? raw : {}) as Partial<MultiModelConsultConfig>;
  const integer = (value: unknown, fallback: number, min: number, max: number): number =>
    typeof value === "number" && Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
  const seen = new Set<string>();
  const participants: ConsultParticipant[] = [];
  for (const item of Array.isArray(v.participants) ? v.participants : []) {
    const modelId = typeof item?.modelId === "string" ? item.modelId.trim().slice(0, 300) : "";
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    const thinkingLevel = typeof item.thinkingLevel === "string" ? item.thinkingLevel.trim().slice(0, 32) || undefined : undefined;
    participants.push({ modelId, ...(thinkingLevel ? { thinkingLevel } : {}) });
    if (participants.length === CONSULT_MAX_PARTICIPANTS) break;
  }
  return {
    enabled: v.enabled === true,
    participants,
    maxParallel: integer(v.maxParallel, 3, 1, CONSULT_MAX_PARTICIPANTS),
    readProjectFiles: v.readProjectFiles !== false,
    timeoutSeconds: integer(v.timeoutSeconds, 300, 10, 1800),
  };
}

/** Details are produced by our tool, not parsed from model-generated prose. */
export function consultReportFromDetails(details: unknown): MultiModelConsultReport | undefined {
  if (!details || typeof details !== "object") return undefined;
  const r = (details as { consult?: MultiModelConsultReport }).consult;
  return r?.schemaVersion === 1 && typeof r.id === "string" && Array.isArray(r.workers) ? r : undefined;
}

export function consultSummary(report: MultiModelConsultReport): string {
  const labels: Record<MultiModelConsultReport["status"], string> = {
    running: "执行中", complete: "已完成", partial: "部分完成", degraded: "仅一个模型成功，未完成多模型会诊", failed: "失败", cancelled: "已取消",
  };
  return `多模型会诊 · ${report.succeeded}/${report.expected} · ${labels[report.status]}`;
}

/** The button adds an explicit request to this message only; it never dispatches workers. */
export function requestConsultForMessage(text: string): string {
  return `【多模型会诊 · 仅本条消息】\n请显式调用 ${MULTI_MODEL_CONSULT_TOOL}，让设置中的不同模型独立处理下面同一个任务；传入必要的事实与材料，不预先给出你的结论。根据真实返回结果综合共识、分歧和独有发现，证据优先，不作多数投票。工具不可用或失败时如实说明，不要声称已经会诊。此要求不延续到后续消息。\n\n${text}`;
}
