/**
 * PerformanceTracker.ts — 单次模型调用 performance sample 状态机（阶段 0）。
 *
 * 事件源：AgentService 主事件桥（AgentSession.subscribe）与 BTW 桥转发的
 * pi AgentSessionEvent。按 assistant message / turn 隔离，一轮内多次模型请求
 * （工具循环）、retry、abort、error 不串样本。
 *
 * TTFT 口径（依据 pi 源码 agent-loop.js 核对）：
 * - request_started_at = turn_start.timestamp。pi 的 runLoop 在每次模型请求前
 *   emit `turn_start`（agent-loop.js L90），其后才做 transformContext /
 *   convertToLlm / getApiKey / streamFunction（provider 请求）——它是公开事件
 *   中**最靠近 provider request 的可靠起点**。message_start 在流式首包到达后
 *   才 emit（agent-loop.js L214-215），不能作为 requestStart。
 * - first_response_at = 首个**有效流式响应**的 message_update 到达时间：
 *   thinking_delta / text_delta 优先；纯 tool-call 响应允许 toolcall_start /
 *   toolcall_delta；极短响应以 *_end 兜底（text_end/thinking_end/toolcall_end）。
 *   只记录一次（首次）。`start`/`text_start`/`thinking_start` 是首包结构事件，
 *   不作为"有效响应"（避免把空结构包当 TTFT 完成点）。
 *
 * tokens/s 口径：
 * - 以最终 AssistantMessage.usage.output 为 token 数（与 pi Usage 定义一致；
 *   reasoning 独立计数时保持 usage.reasoning 原样）。
 * - decodeDuration = message_end 到达 - first_response_at。
 * - generationTps = outputTokens / decodeDurationSeconds；output=0 或无
 *   first_response_at → null（不造数）。
 * - model_wall_ms = message_end - request_started_at（e2e/model wall time）。
 */
export interface PerfSample {
  turnIndex: number;
  requestStartedAt: number;
  firstResponseAt: number | null;
  completedAt: number | null;
  ttftMs: number | null;
  decodeMs: number | null;
  generationTps: number | null;
  modelWallMs: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  stopReason?: string;
  errorMessage?: string;
}

/** message_update.assistantMessageEvent.type 中视为"有效首响应"的类型 */
const FIRST_RESPONSE_EVENT_TYPES = new Set([
  "text_delta",
  "thinking_delta",
  "toolcall_start",
  "toolcall_delta",
  "text_end",
  "thinking_end",
  "toolcall_end",
]);

export class PerformanceTracker {
  private pending: PerfSample | null = null;
  /** 防御：turn_start 与 message_end 之间发生异常跳变时兜底清空 */
  private lastTurnIndex = -1;

  onTurnStart(turnIndex: number, timestamp: number): void {
    // 正常流：每个 turn_start 之间必有 message_end 结算；若出现连续 turn_start
    // （异常/重试路径），丢弃旧 pending（孤儿样本不结算，避免串样本）。
    if (this.pending && this.pending.turnIndex !== turnIndex) {
      this.pending = null;
    }
    this.pending = {
      turnIndex,
      requestStartedAt: timestamp,
      firstResponseAt: null,
      completedAt: null,
      ttftMs: null,
      decodeMs: null,
      generationTps: null,
      modelWallMs: null,
      outputTokens: null,
      reasoningTokens: null,
    };
    this.lastTurnIndex = turnIndex;
  }

  onMessageUpdate(eventType: string, timestamp: number): void {
    if (!this.pending) return;
    if (this.pending.firstResponseAt === null && FIRST_RESPONSE_EVENT_TYPES.has(eventType)) {
      this.pending.firstResponseAt = timestamp;
    }
  }

  /**
   * 结算当前 pending 样本并返回（供调用方投影到 usage_events）。
   * message_end 事件本身可能没有 pending（turn_start 缺失的旧事件流）→ 返回 null。
   * 时钟防御：firstResponseAt < requestStartedAt 或 completedAt < firstResponseAt 时
   * 对应时延置 null（负值不入库），不抛出、不造数。
   */
  onMessageEnd(
    timestamp: number,
    message: { usage?: { output?: number; reasoning?: number } | null; stopReason?: string; errorMessage?: string },
  ): PerfSample | null {
    const sample = this.pending;
    if (!sample) return null;
    this.pending = null;

    const outputTokens = message.usage?.output ?? 0;
    const firstResponseAt = sample.firstResponseAt;
    sample.completedAt = timestamp;
    sample.outputTokens = outputTokens;
    sample.reasoningTokens = message.usage?.reasoning ?? null;
    sample.stopReason = message.stopReason;
    sample.errorMessage = message.errorMessage;
    // 时钟防御：负/异常时延置 null（不污染 TTFT/TPS/wall 聚合）
    sample.ttftMs =
      firstResponseAt !== null && firstResponseAt >= sample.requestStartedAt
        ? firstResponseAt - sample.requestStartedAt
        : null;
    sample.decodeMs =
      firstResponseAt !== null && timestamp >= firstResponseAt ? timestamp - firstResponseAt : null;
    sample.modelWallMs = timestamp >= sample.requestStartedAt ? timestamp - sample.requestStartedAt : null;
    if (outputTokens > 0 && sample.decodeMs !== null && sample.decodeMs > 0) {
      sample.generationTps = outputTokens / (sample.decodeMs / 1000);
    }
    return sample;
  }

  /**
   * 会话被强制终止（如 BTW dispose）时安全结算：pending 有 requestStartedAt 但没有
   * message_end——落一行 wall time（TTFT 若有首响应也可记），output=0 → TPS=null，
   * 不制造 token/cost。无 pending → null。
   */
  settlePending(timestamp: number, reason?: string): PerfSample | null {
    const sample = this.pending;
    if (!sample) return null;
    this.pending = null;
    const firstResponseAt = sample.firstResponseAt;
    sample.completedAt = timestamp;
    sample.outputTokens = 0;
    sample.reasoningTokens = null;
    sample.stopReason = reason ?? "disposed";
    sample.ttftMs =
      firstResponseAt !== null && firstResponseAt >= sample.requestStartedAt
        ? firstResponseAt - sample.requestStartedAt
        : null;
    sample.decodeMs = null;
    sample.modelWallMs = timestamp >= sample.requestStartedAt ? timestamp - sample.requestStartedAt : null;
    sample.generationTps = null;
    return sample;
  }

  /** agent_settled / 会话释放：丢弃孤悬 pending（不伪造样本）。 */
  onSettled(): void {
    this.pending = null;
  }

  get pendingCount(): number {
    return this.pending ? 1 : 0;
  }

  /** Read-only copy for live UI telemetry; does not settle or modify usage accounting. */
  snapshot(): Readonly<PerfSample> | null {
    return this.pending ? { ...this.pending } : null;
  }
}
