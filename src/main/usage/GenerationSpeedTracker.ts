import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { GenerationStats } from "../../shared/generation-stats";
import { PerformanceTracker } from "./PerformanceTracker";

const PUBLISH_INTERVAL_MS = 500;

/** Incremental character heuristic, not a tokenizer. Never scan accumulated text. */
export function estimateDeltaTokens(delta: string): number {
  let tokens = 0;
  for (const char of delta) tokens += char.codePointAt(0)! <= 0x7f ? 0.25 : 1;
  return tokens;
}

/** One tracker per session, reset by UI message ID (including queued follow-ups).
 * No timers: stream updates are throttled; lifecycle transitions publish immediately.
 * Real final averages use the same PerformanceTracker as the usage dashboard.
 */
export class GenerationSpeedTracker {
  private messageId: string | null = null;
  private performance = new PerformanceTracker();
  private phase: GenerationStats["phase"] = "waiting";
  private phaseStartedAt = 0;
  private lastPublishedAt = -Infinity;
  private estimatedTokens = 0;
  private outputTokens = 0;
  private decodeMs = 0;
  private usageComplete = true;
  private ttftMs: number | null = null;
  private outcome: GenerationStats["outcome"];
  private activeTools = new Set<string>();

  /** A queued user message can end a UI reply without an SDK agent_end. */
  finishReply(now = Date.now()): GenerationStats {
    return {
      phase: "complete", startedAt: this.phaseStartedAt, updatedAt: now,
      tps: this.usageComplete && this.decodeMs > 0 ? this.outputTokens / (this.decodeMs / 1000) : null,
      estimated: false,
      outputTokens: this.usageComplete && this.outputTokens > 0 ? this.outputTokens : null,
      ttftMs: this.ttftMs,
      outcome: this.outcome ?? "completed",
    };
  }

  onEvent(event: AgentSessionEvent, messageId: string, now = Date.now()): GenerationStats | null {
    if (messageId !== this.messageId) {
      // pi emits turn_start BEFORE queued message_start(user). Keep that fresh
      // request's clock when AgentService switches the UI message target.
      const carry = event.type === "message_start" && event.message.role === "user"
        ? this.performance.snapshot() : null;
      this.messageId = messageId;
      this.performance = new PerformanceTracker();
      this.phase = "waiting";
      this.phaseStartedAt = now;
      this.lastPublishedAt = -Infinity;
      this.estimatedTokens = 0;
      this.outputTokens = 0;
      this.decodeMs = 0;
      this.usageComplete = true;
      this.ttftMs = null;
      this.outcome = undefined;
      this.activeTools.clear();
      if (carry && carry.firstResponseAt === null) {
        this.performance.onTurnStart(carry.turnIndex, carry.requestStartedAt);
        this.phaseStartedAt = carry.requestStartedAt;
      }
    }

    const previousPhase = this.phase;
    let force = true;
    switch (event.type) {
      case "agent_start":
        // Retries reuse the reply ID; preserve already completed request totals.
        this.phase = "waiting";
        this.phaseStartedAt = now;
        break;
      case "turn_start": {
        const turn = event as { turnIndex?: number; timestamp?: number };
        this.performance.onTurnStart(turn.turnIndex ?? 0, turn.timestamp ?? now);
        this.estimatedTokens = 0;
        this.outcome = undefined;
        this.phase = "waiting";
        this.phaseStartedAt = now;
        break;
      }
      case "message_update": {
        const update = event.assistantMessageEvent;
        this.performance.onMessageUpdate(update.type, now);
        if ("delta" in update && typeof update.delta === "string") {
          this.estimatedTokens += estimateDeltaTokens(update.delta);
        }
        const pending = this.performance.snapshot();
        if (pending?.firstResponseAt != null) {
          this.phase = "generating";
          if (this.ttftMs === null) {
            this.ttftMs = Math.max(0, pending.firstResponseAt - pending.requestStartedAt);
          }
        }
        force = this.phase !== previousPhase;
        break;
      }
      case "message_end": {
        if (event.message.role !== "assistant") return null;
        const sample = this.performance.onMessageEnd(now, event.message);
        const hasUsage = sample?.generationTps != null && Number.isFinite(sample.generationTps);
        if (hasUsage) {
          this.outputTokens += sample.outputTokens!;
          this.decodeMs += sample.decodeMs!;
        } else {
          // Unknown usage, instant responses and interrupted streams cannot produce a true TPS.
          this.usageComplete = false;
        }
        this.ttftMs ??= sample?.ttftMs ?? null;
        this.outcome = event.message.stopReason === "aborted" ? "aborted"
          : event.message.stopReason === "error" ? "error" : "completed";
        this.phase = event.message.stopReason === "toolUse" ? "tools" : "waiting";
        this.phaseStartedAt = now;
        break;
      }
      case "tool_execution_start":
        this.activeTools.add(event.toolCallId);
        this.phase = "tools";
        this.phaseStartedAt = now;
        break;
      case "tool_execution_end":
        this.activeTools.delete(event.toolCallId);
        this.phase = this.activeTools.size ? "tools" : "waiting";
        this.phaseStartedAt = now;
        break;
      case "auto_retry_start":
        this.performance.onSettled();
        this.phase = "retrying";
        this.phaseStartedAt = now;
        break;
      case "compaction_start":
        if (this.phase === "complete") return null;
        this.phase = "compacting";
        this.phaseStartedAt = now;
        break;
      case "compaction_end":
        if (this.phase === "complete") return null;
        this.phase = "waiting";
        this.phaseStartedAt = now;
        break;
      case "agent_settled":
        if (this.performance.pendingCount) this.usageComplete = false;
        this.performance.onSettled();
        this.phase = "complete";
        break;
      default:
        return null;
    }

    if (!force && now - this.lastPublishedAt < PUBLISH_INTERVAL_MS) return null;
    this.lastPublishedAt = now;
    const pending = this.performance.snapshot();
    const elapsed = pending?.firstResponseAt == null ? 0 : now - pending.firstResponseAt;
    const generating = this.phase === "generating";
    const tps = generating
      ? elapsed >= PUBLISH_INTERVAL_MS && this.estimatedTokens > 0
        ? this.estimatedTokens / (elapsed / 1000) : null
      : this.usageComplete && this.decodeMs > 0 ? this.outputTokens / (this.decodeMs / 1000) : null;
    return {
      phase: this.phase,
      startedAt: this.phaseStartedAt,
      updatedAt: now,
      tps: tps !== null && Number.isFinite(tps) && tps > 0 ? tps : null,
      estimated: generating,
      outputTokens: this.usageComplete && this.outputTokens > 0 ? this.outputTokens : null,
      ttftMs: this.ttftMs,
      outcome: this.outcome,
    };
  }
}
