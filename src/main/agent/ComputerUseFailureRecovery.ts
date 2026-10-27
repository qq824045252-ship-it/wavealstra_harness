import type { ComputerExecInput, ComputerExecOutput } from "../platform/computer-use/protocol";
import { isComputerUseSideEffect } from "../capabilities/ComputerUsePolicy";
import { WindowsAutomationError, type AutomationErrorCode, type WindowInfo } from "../platform/computer-use/protocol";
import type { ConversationExecutionContext } from "./ConversationExecutionContext";
import type { ExecutionFailureRepository } from "./ExecutionFailureRepository";

export interface ComputerUseRecoveryBridge {
  resolveContext: () => ConversationExecutionContext | undefined;
  failures: ExecutionFailureRepository;
}

const OPERATIONAL_CAUSE_CODES = [
  "computer-window-not-found", "computer-window-ambiguous", "computer-target-changed", "computer-window-not-visible",
  "computer-focus-failed", "computer-stale-observation", "computer-control-not-found", "computer-control-ambiguous",
  "computer-control-not-actionable", "computer-capture-failed", "computer-capture-spans-multiple-displays",
  "computer-point-outside-client", "computer-wait-timeout", "computer-host-unavailable", "computer-host-protocol-error",
  "computer-request-timeout",
] as const;

const PRE_ACTION_CAUSE_CODES = [
  "computer-window-not-found", "computer-window-ambiguous", "computer-target-changed", "computer-window-not-visible",
  "computer-stale-observation", "computer-control-not-found", "computer-control-ambiguous", "computer-control-not-actionable",
  "computer-point-outside-client", "computer-wait-timeout",
] as const;
const PRE_ACTION_CODES = new Set<AutomationErrorCode>([
  "WINDOW_NOT_FOUND", "WINDOW_AMBIGUOUS", "TARGET_CHANGED", "WINDOW_NOT_VISIBLE", "STALE_OBSERVATION",
  "CONTROL_NOT_FOUND", "CONTROL_AMBIGUOUS", "CONTROL_NOT_ACTIONABLE", "POINT_OUTSIDE_CLIENT", "WAIT_TIMEOUT",
]);

function causeCodeFor(code: AutomationErrorCode): string {
  return `computer-${code.toLowerCase().replaceAll("_", "-")}`;
}

function normalized(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? encodeURIComponent(text.toLocaleLowerCase()) : undefined;
}

function selectorTarget(input: ComputerExecInput): string | undefined {
  if (input.windowHandle?.trim()) return `hwnd=${encodeURIComponent(input.windowHandle.trim())}`;
  const parts = [
    Number.isInteger(input.processId) ? `pid=${input.processId}` : undefined,
    normalized(input.className) ? `class=${normalized(input.className)}` : undefined,
    normalized(input.windowTitle) ? `title=${normalized(input.windowTitle)}` : undefined,
  ].filter(Boolean);
  return parts.length ? parts.join("|") : undefined;
}

function asWindow(value: unknown): WindowInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Partial<WindowInfo>;
  if (typeof row.handle === "string" && row.handle.trim() && Number.isFinite(row.processId)) return row as WindowInfo;
  return undefined;
}

function findWindow(value: unknown, depth = 0, seen = new Set<object>()): WindowInfo | undefined {
  if (!value || typeof value !== "object" || depth > 4) return undefined;
  const direct = asWindow(value);
  if (direct) return direct;
  const object = value as Record<string, unknown>;
  if (seen.has(object)) return undefined;
  seen.add(object);
  for (const key of ["targetAfter", "targetBefore", "window", "current", "observation", "after", "before", "details"]) {
    const found = findWindow(object[key], depth + 1, seen);
    if (found) return found;
  }
  return undefined;
}

export function computerUseRecoveryTarget(input: ComputerExecInput, evidence?: unknown): string {
  const selector = selectorTarget(input);
  if (selector) return `computer:${input.action}:${selector}`;
  const window = findWindow(evidence);
  if (window) return `computer:${input.action}:hwnd=${encodeURIComponent(window.handle)}|pid=${window.processId}`;
  if (input.observationId?.trim()) return `computer:${input.action}:observation=${encodeURIComponent(input.observationId.trim())}`;
  return `computer:${input.action}:desktop`;
}

function recoveryGuidance(error: WindowsAutomationError): string {
  const details = error.details && typeof error.details === "object" ? error.details as Record<string, unknown> : undefined;
  const recovery = details?.computerUseRecovery && typeof details.computerUseRecovery === "object"
    ? details.computerUseRecovery as Record<string, unknown> : undefined;
  if (typeof recovery?.guidance === "string" && recovery.guidance.trim()) return recovery.guidance.trim();
  const fallback: Partial<Record<AutomationErrorCode, string>> = {
    WINDOW_NOT_FOUND: "Re-observe the available windows and re-plan against the intended application; do not replay input to a different window.",
    WINDOW_AMBIGUOUS: "Use HWND/PID or a more specific class/title to bind exactly one window before retrying.",
    STALE_OBSERVATION: "Discard the stale observation and re-observe the same stable window identity before acting again.",
    CONTROL_NOT_FOUND: "Re-inspect controls or capture the same target window before selecting a replacement control.",
    CONTROL_AMBIGUOUS: "Refine the control selector with automationId/runtimeId/controlType before retrying.",
    POINT_OUTSIDE_CLIENT: "Discard the old coordinates and obtain fresh client bounds or a fresh window screenshot.",
    REQUEST_TIMEOUT: "Re-observe the same target first. The original action may have reached Windows, so do not blindly replay it.",
    HOST_UNAVAILABLE: "Restore the Windows automation host, then re-observe the intended target before continuing.",
    FOCUS_FAILED: "Re-observe foreground state and bind the same intended window before another input action.",
    WAIT_TIMEOUT: "Re-list or re-observe windows and decide whether the expected state is still reachable.",
  };
  return fallback[error.code] ?? "Re-observe the same intended target and re-plan. Do not blindly repeat the failing input action.";
}

export function recordComputerUseFailureRecovery(bridge: ComputerUseRecoveryBridge | undefined, input: ComputerExecInput, error: unknown): boolean {
  if (!bridge || !(error instanceof WindowsAutomationError) || error.code === "REQUEST_CANCELLED") return false;
  const ctx = bridge.resolveContext();
  if (!ctx) return false;
  const target = computerUseRecoveryTarget(input, error.details);
  bridge.failures.recordIfAbsent({
    ...ctx,
    causeCode: causeCodeFor(error.code),
    phase: PRE_ACTION_CODES.has(error.code) ? "observe" : "execute",
    recovery: "recoverable",
    sideEffects: PRE_ACTION_CODES.has(error.code) || !isComputerUseSideEffect(input.action) ? "none" : "unknown",
    target,
    message: `Computer Use ${input.action} failed (${error.code}): ${error.message}`,
    nextAction: recoveryGuidance(error),
  });
  return true;
}

function verificationState(output: ComputerExecOutput): { post?: string; visual?: string; semantic?: string } {
  const run = output.computerUseRun && typeof output.computerUseRun === "object" ? output.computerUseRun as Record<string, unknown> : undefined;
  const verification = run?.verification && typeof run.verification === "object" ? run.verification as Record<string, unknown> : undefined;
  return {
    post: typeof verification?.postObservation === "string" ? verification.postObservation : undefined,
    visual: typeof verification?.visualVerification === "string" ? verification.visualVerification : undefined,
    semantic: output.semanticOutcome?.status,
  };
}

export function settleComputerUseResultRecovery(bridge: ComputerUseRecoveryBridge | undefined, input: ComputerExecInput, output: ComputerExecOutput): void {
  if (!bridge) return;
  const ctx = bridge.resolveContext();
  if (!ctx) return;
  const target = computerUseRecoveryTarget(input, output);
  const sideEffecting = isComputerUseSideEffect(input.action);
  // A later successful call proves pre-action binding/selector failures are repaired. It does NOT, by itself,
  // reconcile a prior side-effecting timeout/host failure that may already have reached Windows.
  bridge.failures.resolveMatching(ctx.taskId, { target, causeCodes: PRE_ACTION_CAUSE_CODES });
  if (!sideEffecting) bridge.failures.resolveMatching(ctx.taskId, { target, causeCodes: OPERATIONAL_CAUSE_CODES });

  const state = verificationState(output);
  const verifyCodes = ["computer-post-verification-unavailable", "computer-semantic-verification-failed", "computer-semantic-verification-unavailable"];
  const sideEffects = sideEffecting ? "known" as const : "none" as const;
  if (state.post === "unavailable" || state.visual === "failed") {
    bridge.failures.recordIfAbsent({ ...ctx, causeCode: "computer-post-verification-unavailable", phase: "verify", recovery: "recoverable",
      sideEffects, target, message: `Computer Use ${input.action} ran, but post-action observation or visual verification was unavailable.`,
      nextAction: "Re-observe the same target before deciding whether another input action is necessary; do not infer success from the attempted action alone." });
  } else {
    bridge.failures.resolveMatching(ctx.taskId, { target, causeCodes: ["computer-post-verification-unavailable"] });
  }

  if (state.semantic === "failed") {
    bridge.failures.recordIfAbsent({ ...ctx, causeCode: "computer-semantic-verification-failed", phase: "verify", recovery: "recoverable",
      sideEffects, target, message: `Computer Use ${input.action} executed, but the requested semantic postcondition failed.`,
      nextAction: "Re-observe the same target and re-plan from the actual UI state; do not repeat the input merely because the transport succeeded." });
  } else if (state.semantic === "not_evaluable") {
    bridge.failures.recordIfAbsent({ ...ctx, causeCode: "computer-semantic-verification-unavailable", phase: "verify", recovery: "recoverable",
      sideEffects, target, message: `Computer Use ${input.action} executed, but the requested semantic postcondition could not be evaluated.`,
      nextAction: "Acquire fresh observable evidence for the same target before deciding whether another action is needed." });
  } else if (state.semantic === "passed") {
    bridge.failures.resolveMatching(ctx.taskId, { target, causeCodes: ["computer-semantic-verification-failed", "computer-semantic-verification-unavailable"] });
  }

  if (state.post !== "unavailable" && state.visual !== "failed" && state.semantic === "passed") {
    bridge.failures.resolveMatching(ctx.taskId, { target, causeCodes: verifyCodes });
    // Explicit postcondition success is the first point where a prior side-effecting transport uncertainty may be cleared.
    bridge.failures.resolveMatching(ctx.taskId, { target, causeCodes: OPERATIONAL_CAUSE_CODES });
  }
}