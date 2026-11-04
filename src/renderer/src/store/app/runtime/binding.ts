import type { AppContext } from "../context";

/** One initRuntime invocation owns these subscriptions and its asynchronous reads. */
export interface RuntimeBinding {
  context: AppContext;
  api: NonNullable<ReturnType<AppContext["getApi"]>>;
  isActive(): boolean;
  addCleanup(cleanup: (() => void) | null | undefined): void;
}
