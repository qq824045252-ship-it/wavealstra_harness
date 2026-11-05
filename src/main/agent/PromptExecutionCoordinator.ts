import type { AgentPromptRequest, AgentPromptResult } from "../../shared/agent-ipc";
import {
  PromptRetryRegistry,
  PromptRunRegistry,
  type PromptRunState,
} from "./PromptRunRegistry";

export interface PromptExecutionCallbacks {
  announceUserMessage: (request: AgentPromptRequest) => void;
  settleCancelled: (request: AgentPromptRequest) => void;
  execute: (
    request: AgentPromptRequest,
    run: PromptRunState,
    markReady: () => void,
  ) => Promise<AgentPromptResult>;
}

/**
 * Tracks product request admission and cancellation; never owns the Pi agent loop.
 *
 * This intentionally does not know how prompt content is assembled. It only owns:
 * - retry request retention;
 * - per-task run registration;
 * - session admission ordering before native Pi queue submission;
 * - cancellation gate before promptInternal starts;
 * - ready/done finalization and registry release.
 */
export class PromptExecutionCoordinator {
  private readonly runs = new PromptRunRegistry();
  private readonly retries = new PromptRetryRegistry<AgentPromptRequest>(200);

  isBusy(taskId: string): boolean {
    return this.runs.isBusy(taskId);
  }

  cancel(taskId: string, preservedRun?: PromptRunState): void {
    this.runs.cancel(taskId, preservedRun);
  }

  retryRequest(assistantMessageId: string): AgentPromptRequest | undefined {
    return this.retries.get(assistantMessageId);
  }

  forgetRetry(assistantMessageId: string): void {
    this.retries.delete(assistantMessageId);
  }

  async execute(
    request: AgentPromptRequest,
    callbacks: PromptExecutionCallbacks,
  ): Promise<AgentPromptResult> {
    if (request.announceUserMessage !== false) callbacks.announceUserMessage(request);
    this.retries.remember(request.assistantMessageId, request);

    const { run, predecessors } = this.runs.begin(
      request.taskId,
      request.streamingBehavior === "followUp",
    );
    try {
      // Wait only for session/prompt admission, never for an earlier model run to finish.
      // Pi receives every explicit steer/follow-up and owns consumption/continuation order.
      await Promise.all(predecessors.map((previous) => previous.ready));

      run.waitingFollowUp = false;
      if (run.cancelled) {
        callbacks.settleCancelled(request);
        return { queued: false, cancelled: true };
      }
      return await callbacks.execute(request, run, run.markReady);
    } finally {
      // Resolve both barriers on every path so no successor can deadlock on a failed/cancelled run.
      run.markReady();
      run.finish();
      this.runs.release(request.taskId, run);
    }
  }
}