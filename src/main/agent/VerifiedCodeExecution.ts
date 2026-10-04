import { createHash } from "node:crypto";
import type { ExecutionAttempt, ExecutionAttemptRepository } from "./ExecutionAttemptRepository";
import type { ExecutionFailureRepository } from "./ExecutionFailureRepository";
import type { ConversationExecutionContext } from "./ConversationExecutionContext";
import { verifyObservedProcessExit } from "./ExecutionVerifierRegistry";

/** Outcome auditing for product-owned process tools; Pi tools do not use this bridge. */
export interface VerifiedProcessBridge {
  resolveContext: () => ConversationExecutionContext | undefined;
  attempts: ExecutionAttemptRepository;
  failures?: ExecutionFailureRepository;
}

export interface VerifiedProcessTransport<T> {
  result: T;
  exitCode: number | null;
  cancelled?: boolean;
  timedOut?: boolean;
}
export type VerifiedCodeTransport<T> = VerifiedProcessTransport<T>;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function codeExecutionEvidenceIdentity(input: {
  language: string;
  code?: string;
  scriptPath?: string;
  args?: readonly string[];
  pythonDependencies?: readonly string[];
}): string {
  const source = input.scriptPath ? `script:${sha256(input.scriptPath)}` : `code:${sha256(input.code ?? "")}`;
  const args = sha256(JSON.stringify(input.args ?? []));
  const deps = sha256(JSON.stringify([...(input.pythonDependencies ?? [])].map((item) => item.trim()).filter(Boolean).sort()));
  return `${input.language}:${source}:args=${args}:deps=${deps}`;
}

function executionDetails<T>(result: T, record: ExecutionAttempt): T {
  if (!result || typeof result !== "object") return result;
  const current = (result as { details?: unknown }).details;
  const details = current && typeof current === "object" ? current as Record<string, unknown> : {};
  return {
    ...(result as object),
    details: {
      ...details,
      executionVerification: {
        attemptId: record.id,
        verifierId: record.verifierId,
        verifierVersion: record.verifierVersion,
        status: record.status,
      },
    },
  } as T;
}

function exitCodeFromError(error: unknown): number | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/(?:Command exited with code|exit(?:ed)?(?: with)?(?: code)?[=: ]+)\s*(-?\d+)/i);
  const value = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(value) ? value : undefined;
}

export async function executeVerifiedProcess<T>(input: {
  bridge?: VerifiedProcessBridge;
  toolCallId: string;
  toolName: string;
  targetNamespace: string;
  evidenceIdentity: string;
  causePrefix: string;
  executionLabel: string;
  signal?: AbortSignal;
  execute: () => Promise<VerifiedProcessTransport<T>>;
}): Promise<T> {
  if (!input.bridge) return (await input.execute()).result;
  const ctx = input.bridge.resolveContext();
  if (!ctx) throw new Error(`${input.executionLabel} verification requires an active main-process execution context`);
  const commandHash = sha256(input.evidenceIdentity);
  const target = `${input.targetNamespace}:${commandHash}`;
  const timeoutCause = `${input.causePrefix}-timeout`;
  const nonzeroCause = `${input.causePrefix}-exit-nonzero`;
  const unknownExitCause = `${input.causePrefix}-exit-unknown`;
  const errorCause = `${input.causePrefix}-error`;
  const transientCauses = [timeoutCause, nonzeroCause, unknownExitCause, errorCause, "application-restarted"];
  let record = input.bridge.attempts.begin({
    ...ctx,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    target,
    commandHash,
    expectedExitCode: 0,
    verifierId: "process-exit-code",
    verifierVersion: 1,
  });
  const assertActive = () => {
    const live = input.bridge!.resolveContext();
    if (input.signal?.aborted) throw new Error("cancelled");
    if (!live || live.taskId !== ctx.taskId || live.executionId !== ctx.executionId
      || live.assistantMessageId !== ctx.assistantMessageId) throw new Error("stale-execution");
  };
  const settleRecovery = (finished: ExecutionAttempt) => {
    if (["cancelled", "stale-execution"].includes(finished.causeCode ?? "")) return;
    input.bridge!.failures?.recordIfAbsent({
      ...ctx,
      causeCode: finished.causeCode ?? errorCause,
      phase: "execute",
      recovery: finished.recovery ?? "recoverable",
      sideEffects: "unknown",
      target: finished.target,
      message: `${input.executionLabel} did not complete reliably (${finished.causeCode ?? errorCause}). Partial side effects may exist.`,
      nextAction: "Inspect the process output and affected files/state before deciding whether to retry.",
    });
  };
  const finishStructuredFailure = async (
    transport: VerifiedProcessTransport<T>,
    causeCode: string,
    status: "failed" | "inconclusive",
  ): Promise<T> => {
    let verification = record.verification;
    if (typeof transport.exitCode === "number" && Number.isSafeInteger(transport.exitCode)) {
      verification = await verifyObservedProcessExit({ ...ctx, attemptId: record.id, target: record.target, exitCode: transport.exitCode }, () => {});
    }
    record = {
      ...record,
      observedExitCode: typeof transport.exitCode === "number" ? transport.exitCode : undefined,
      verification,
      status,
      phase: "finished",
      causeCode,
      recovery: "recoverable",
      finishedAt: Date.now(),
    };
    input.bridge!.attempts.update(record);
    settleRecovery(record);
    return executionDetails(transport.result, record);
  };

  try {
    assertActive();
    const transport = await input.execute();
    if (transport.cancelled || input.signal?.aborted) {
      record = {
        ...record,
        observedExitCode: typeof transport.exitCode === "number" ? transport.exitCode : undefined,
        status: "inconclusive",
        phase: "finished",
        causeCode: "cancelled",
        recovery: "terminal",
        finishedAt: Date.now(),
      };
      input.bridge.attempts.update(record);
      return executionDetails(transport.result, record);
    }
    assertActive();
    if (transport.timedOut) return finishStructuredFailure(transport, timeoutCause, "inconclusive");
    if (typeof transport.exitCode !== "number" || !Number.isSafeInteger(transport.exitCode)) {
      return finishStructuredFailure(transport, unknownExitCause, "inconclusive");
    }
    record = { ...record, observedExitCode: transport.exitCode, phase: "verifying" };
    input.bridge.attempts.update(record);
    const verification = await verifyObservedProcessExit({ ...ctx, attemptId: record.id, target: record.target, exitCode: transport.exitCode }, assertActive);
    record = {
      ...record,
      verification,
      status: verification.status === "passed" ? "passed" : "failed",
      phase: "finished",
      causeCode: verification.status === "passed" ? undefined : nonzeroCause,
      recovery: verification.status === "passed" ? undefined : "recoverable",
      finishedAt: Date.now(),
    };
    input.bridge.attempts.update(record);
    if (record.status === "passed") {
      input.bridge.failures?.resolveMatching(ctx.taskId, { target: record.target, causeCodes: transientCauses });
    } else settleRecovery(record);
    return executionDetails(transport.result, record);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const observedExitCode = exitCodeFromError(error);
    let verification = record.verification;
    if (observedExitCode !== undefined) {
      try {
        verification = await verifyObservedProcessExit({ ...ctx, attemptId: record.id, target: record.target, exitCode: observedExitCode }, () => {});
      } catch { /* preserve original execution error */ }
    }
    const causeCode = input.signal?.aborted || /Command aborted|cancelled|canceled|已取消|\babort(?:ed)?\b/i.test(message) ? "cancelled"
      : /timed out|超时/i.test(message) ? timeoutCause
      : observedExitCode !== undefined ? nonzeroCause
      : /stale-execution/i.test(message) ? "stale-execution" : errorCause;
    const failed: ExecutionAttempt = {
      ...record,
      observedExitCode,
      verification,
      status: observedExitCode !== undefined ? "failed" : "inconclusive",
      phase: "finished",
      causeCode,
      recovery: causeCode === "cancelled" || causeCode === "stale-execution" ? "terminal" : "recoverable",
      finishedAt: Date.now(),
    };
    try { input.bridge.attempts.update(failed); } catch { /* stale settlement must not hide original error */ }
    settleRecovery(failed);
    throw error;
  }
}

export async function executeVerifiedCode<T>(input: {
  bridge?: VerifiedProcessBridge;
  toolCallId: string;
  evidenceIdentity: string;
  signal?: AbortSignal;
  execute: () => Promise<VerifiedCodeTransport<T>>;
}): Promise<T> {
  return executeVerifiedProcess({
    ...input,
    toolName: "execute_code",
    targetNamespace: "code:execute_code",
    causePrefix: "code-execution",
    executionLabel: "execute_code",
  });
}

export function recordCodeRuntimePreparationFailure(bridge: VerifiedProcessBridge | undefined, message: string): void {
  const ctx = bridge?.resolveContext();
  if (!bridge?.failures || !ctx) return;
  bridge.failures.recordIfAbsent({ ...ctx, causeCode: "code-python-runtime-not-ready", phase: "prepare", recovery: "recoverable",
    sideEffects: "none", target: "code-runtime:python", message,
    nextAction: "Repair or prepare the managed Python runtime, then retry; user code has not started." });
}

export function resolveCodeRuntimePreparationFailure(bridge: VerifiedProcessBridge | undefined): void {
  const ctx = bridge?.resolveContext();
  if (!bridge?.failures || !ctx) return;
  bridge.failures.resolveMatching(ctx.taskId, { target: "code-runtime:python", causeCodes: ["code-python-runtime-not-ready"] });
}
