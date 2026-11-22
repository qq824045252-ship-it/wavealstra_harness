import ReviewWorker from "./worker?worker";
import type { CanbanReviewRuntime } from "./runtime";

export type {
  CanbanDiff, CanbanDiffHunk, CanbanDiffLine, CanbanGapExpansion, CanbanInlineComment,
} from "./runtime";

type WorkerMethods = Pick<CanbanReviewRuntime, "parse" | "formatHunkHeader" | "expandGap" | "formatPendingMarkdown">;
type Method = keyof WorkerMethods;
type AsyncMethods = {
  [K in Method]: (...args: Parameters<WorkerMethods[K]>) => Promise<ReturnType<WorkerMethods[K]>>;
};
export type CanbanReviewEngine = AsyncMethods & { contextStep: number };

export type EngineRequest = {
  [K in Method]: { id: number; method: K; args: Parameters<WorkerMethods[K]> };
}[Method];
export type EngineResponse =
  | { contextStep: number }
  | { id: number; value: ReturnType<WorkerMethods[Method]> }
  | { id: number; error: string };

let connection: Promise<CanbanReviewEngine> | undefined;

export function getCanbanReviewEngine(): Promise<CanbanReviewEngine> {
  if (connection) return connection;
  connection = connectEngine().catch((error: unknown) => {
    connection = undefined;
    throw error;
  });
  return connection;
}

function connectEngine(): Promise<CanbanReviewEngine> {
  return new Promise((ready, rejectReady) => {
    const worker = new ReviewWorker();
    const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
    let nextId = 0;
    let failure: Error | undefined;

    function call<K extends Method>(method: K, ...args: Parameters<WorkerMethods[K]>): Promise<ReturnType<WorkerMethods[K]>> {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve: (value) => resolve(value as ReturnType<WorkerMethods[K]>), reject });
        try {
          worker.postMessage({ id, method, args });
        } catch (error) {
          pending.delete(id);
          reject(error);
        }
      });
    }

    worker.onmessage = ({ data }: MessageEvent<EngineResponse>) => {
      if ("contextStep" in data) {
        ready({
          contextStep: data.contextStep,
          parse: (...args) => call("parse", ...args),
          formatHunkHeader: (...args) => call("formatHunkHeader", ...args),
          expandGap: (...args) => call("expandGap", ...args),
          formatPendingMarkdown: (...args) => call("formatPendingMarkdown", ...args),
        });
        return;
      }
      const request = pending.get(data.id);
      pending.delete(data.id);
      if ("error" in data) request?.reject(new Error(data.error));
      else request?.resolve(data.value);
    };
    worker.onerror = (event) => {
      worker.terminate();
      failure = new Error(event.message || "Canban review worker failed to load");
      rejectReady(failure);
      for (const request of pending.values()) request.reject(failure);
      pending.clear();
      connection = undefined;
    };
  });
}
