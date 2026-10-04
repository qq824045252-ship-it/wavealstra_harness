import type { SessionEntry } from "./SessionRegistry";
import {
  acquirePromptSubmission,
  queueAssistantTurn,
} from "./SessionRegistry";

export type PromptStreamingBehavior = "steer" | "followUp";

/** A visible reply can finish before native post-run auto compaction settles.
 * Preserve a new user's input using the existing follow-up queue, never abort.
 * Manual compaction is rejected by AgentService before reaching this boundary. */
export function resolvePromptCompactionBehavior(requested: PromptStreamingBehavior | undefined,
  isCompacting: boolean | undefined): PromptStreamingBehavior | undefined {
  return requested ?? (isCompacting ? "followUp" : undefined);
}

export interface PromptSubmissionContext {
  wasStreaming: boolean;
  behavior: PromptStreamingBehavior;
  queueEpoch: number;
  assistantMessageId: string;
  executionId: string;
  startedAt: number;
}

export type PromptSubmissionBeginResult =
  | { ok: true; context: PromptSubmissionContext }
  | {
      ok: false;
      error: {
        code: "STREAMING_BEHAVIOR_REQUIRED";
        message: string;
      };
    };

export interface PromptSubmissionCallbacks {
  onCancelledTurn?: (messageId: string) => void;
}

/**
 * Projects accepted user requests onto visible reply IDs at the Pi prompt boundary.
 * Content/model/context preparation stays outside; this coordinator only handles streaming intent,
 * abort epochs and assistant-turn routing state. Pi alone owns the actual queues.
 */
export class PromptSubmissionCoordinator {
  begin(
    entry: SessionEntry,
    input: {
      streamingBehavior?: PromptStreamingBehavior;
      assistantMessageId: string;
      executionId: string;
      startedAt: number;
    },
  ): PromptSubmissionBeginResult {
    const wasStreaming = entry.session.isStreaming;
    const requested = resolvePromptCompactionBehavior(input.streamingBehavior, entry.session.isCompacting);
    const behavior = requested ?? "followUp";
    if (wasStreaming && !requested) {
      return {
        ok: false,
        error: {
          code: "STREAMING_BEHAVIOR_REQUIRED",
          message: "会话仍在生成，必须显式指定 streamingBehavior（continue/steer）或先打断执行。",
        },
      };
    }
    if (!wasStreaming) {
      entry.assistantMessageId = input.assistantMessageId;
      entry.executionId = input.executionId;
      entry.startedAt = input.startedAt;
    }
    return {
      ok: true,
      context: {
        wasStreaming,
        behavior,
        queueEpoch: entry.promptQueueEpoch,
        assistantMessageId: input.assistantMessageId,
        executionId: input.executionId,
        startedAt: input.startedAt,
      },
    };
  }

  async acquire(entry: SessionEntry, context: PromptSubmissionContext): Promise<(() => void) | null> {
    return context.wasStreaming ? await acquirePromptSubmission(entry) : null;
  }

  enqueue(
    entry: SessionEntry,
    context: PromptSubmissionContext,
    callbacks: PromptSubmissionCallbacks = {},
  ): "ready" | "cancelled" {
    if (!context.wasStreaming) return "ready";
    if (context.queueEpoch !== entry.promptQueueEpoch) {
      callbacks.onCancelledTurn?.(context.assistantMessageId);
      return "cancelled";
    }
    queueAssistantTurn(
      entry,
      context.assistantMessageId,
      context.startedAt,
      context.behavior,
      context.executionId,
    );
    return "ready";
  }

  removeQueuedTurn(entry: SessionEntry, assistantMessageId: string): void {
    entry.pendingAssistantTurns = entry.pendingAssistantTurns.filter(
      (turn) => turn.messageId !== assistantMessageId,
    );
  }
}