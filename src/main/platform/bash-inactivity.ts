const BASH_INACTIVITY_MS = 120_000;
export const BASH_INACTIVITY_MESSAGE = "Bash produced no stdout or stderr for 120 seconds";

export class BashInactivityError extends Error {
  constructor() { super(BASH_INACTIVITY_MESSAGE); }
}

/** The runner owns its process tree. This deadline owns the caller's wait for it. */
export async function runBashWithInactivityTimeout<T>(parentSignal: AbortSignal | undefined,
  execute: (signal: AbortSignal, onOutput: () => void) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
  const expired = Promise.withResolvers<never>();
  const deadline = setTimeout(() => {
    if (signal.aborted) return;
    const error = new BashInactivityError();
    expired.reject(error);
    controller.abort(error);
  }, BASH_INACTIVITY_MS);
  try {
    return await Promise.race([expired.promise, execute(signal, () => {
      if (!signal.aborted) deadline.refresh();
    })]);
  } finally {
    clearTimeout(deadline);
  }
}
