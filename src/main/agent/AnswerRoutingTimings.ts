import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

type Identity = { taskId?: string; conversationId: string; generationTaskId: number };
type Phase = "evidenceProjection" | "memorySearch" | "memorySelection" | "ruleMatch" | "readEvidence";

const timings = process.env.MYBUDDY_ANSWER_ROUTING_TIMINGS === "1" ? new AsyncLocalStorage<Identity>() : undefined;

export function withAnswerRoutingTimings<T>(identity: () => Identity, run: () => T): T {
  return timings ? timings.run(identity(), run) : run();
}

export function startAnswerRoutingTiming(phase: Phase) {
  const identity = timings?.getStore();
  if (!identity) return;
  const start = performance.now();
  return (details?: () => Record<string, unknown>) => {
    const end = performance.now();
    try {
      console.log("[AnswerRoutingTiming] " + JSON.stringify({ ...identity, phase,
        startedAtMs: performance.timeOrigin + start, endedAtMs: performance.timeOrigin + end,
        elapsedMs: end - start, ...details?.() }));
    } catch { /* diagnostics cannot fail the request */ }
  };
}
