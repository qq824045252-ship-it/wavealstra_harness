import { AsyncLocalStorage } from "node:async_hooks";

const currentCheck = new AsyncLocalStorage<(() => Promise<void>) | undefined>();
export class DurableInputDeferredError extends Error {}

export function withToolInputFreshness<T>(check: (() => Promise<void>) | undefined, invoke: () => Promise<T>): Promise<T> {
  return currentCheck.run(check, invoke);
}

export function checkCurrentToolInput(): Promise<void> | undefined {
  return currentCheck.getStore()?.();
}
