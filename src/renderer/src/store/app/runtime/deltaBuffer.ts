import type { AgentUiPatch } from "../../../../../shared/agent-ipc";

export type AgentDeltaPatch = Extract<
  AgentUiPatch,
  { type: "text_delta" | "thinking_delta" }
>;

/** Browser scheduling is injected so the stream ordering can be tested without a DOM. */
export interface AgentDeltaScheduler {
  requestFrame(callback: () => void): number;
  cancelFrame(handle: number): void;
  setTimer(callback: () => void, delayMs: number): number;
  clearTimer(handle: number): void;
}

export interface AgentDeltaBuffer {
  push(patch: AgentDeltaPatch): void;
  /** Structural events must flush all preceding deltas before applying their own patch. */
  flush(): void;
  /** Stop accepting events, cancel scheduled work, and drain the remaining batch once. */
  dispose(): void;
}

const BACKGROUND_FLUSH_MS = 40;

export function createAgentDeltaBuffer(deps: {
  scheduler: AgentDeltaScheduler;
  applyBatch(patches: AgentDeltaPatch[]): void;
}): AgentDeltaBuffer {
  let queue: AgentDeltaPatch[] = [];
  let frame: number | null = null;
  let timer: number | null = null;
  let disposed = false;

  function cancelScheduledFlush(): void {
    if (frame !== null) deps.scheduler.cancelFrame(frame);
    if (timer !== null) deps.scheduler.clearTimer(timer);
    frame = null;
    timer = null;
  }

  function flush(): void {
    cancelScheduledFlush();
    if (queue.length === 0) return;
    const patches = queue;
    queue = [];
    deps.applyBatch(patches);
  }

  function scheduleFlush(): void {
    if (frame !== null || timer !== null) return;
    frame = deps.scheduler.requestFrame(flush);
    // Background Chromium windows throttle RAF; streamed content must still advance.
    timer = deps.scheduler.setTimer(flush, BACKGROUND_FLUSH_MS);
  }

  function push(patch: AgentDeltaPatch): void {
    if (disposed) return;
    const previous = queue[queue.length - 1];
    if (
      previous &&
      previous.type === patch.type &&
      previous.taskId === patch.taskId &&
      previous.messageId === patch.messageId &&
      (patch.type !== "text_delta" ||
        previous.type !== "text_delta" ||
        previous.final === patch.final)
    ) {
      previous.delta += patch.delta;
    } else {
      queue.push(patch);
    }
    scheduleFlush();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    flush();
  }

  return { push, flush, dispose };
}
