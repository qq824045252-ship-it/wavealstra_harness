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
  "computer-batch-incomplete", "computer-delivery-uncertain",
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
  for (const key of ["targetAfter", "targetBefore", "window", "current", "observation", "after", "before", "details", "actionResult"]) {
    const found = findWindow(object[key], depth + 1, seen);
    if (found) return found;
  }
  return undefined;
}

export function computerUseRecoveryTarget(input: ComputerExecInput, evidence?: unknown): string {
  const action = actionName(input);
  const selector = selectorTarget(input);
  if (selector) return `computer:${action}:${selector}`;
  const window = findWindow(evidence);
  if (window) return `computer:${action}:hwnd=${encodeURIComponent(window.handle)}|pid=${window.processId}`;
  if (input.observationId?.trim()) return `computer:${action}:observation=${encodeURIComponent(input.observationId.trim())}`;
  return `computer:${action}:desktop`;
}

function actionName(input: ComputerExecInput): string { return input.actions?.length ? "batch" : input.action ?? "unknown"; }
function sideEffectingInput(input: ComputerExecInput): boolean {
  return Boolean(input.actions?.length) || isComputerUseSideEffect(input.action);
}

interface DeliveryEvidence {
  sideEffects?: "none" | "known" | "unknown";
  partial: boolean;
  completedSteps: number;
  completedClicks: number;
}

/** Inspect only delivery fields, not application trees or screenshot bytes. */
function deliveryEvidence(value: unknown): DeliveryEvidence {
  let delivered = false, notExecuted = false, uncertain = false, partial = false;
  let completedSteps = 0, completedClicks = 0;
  const seen = new Set<object>();
  const positive = (number: unknown): number => typeof number === "number" && Number.isFinite(number) && number > 0 ? number : 0;
  const visit = (entry: unknown, depth = 0): void => {
    if (!entry || typeof entry !== "object" || depth > 5 || seen.size >= 128 || seen.has(entry)) return;
    seen.add(entry);
    const record = entry as Record<string, unknown>;
    if (record.executed === true) delivered = true;
    else if (record.executed === false) notExecuted = true;
    else if (record.executed === "unknown") uncertain = true;
    if (record.executionUncertain === true) uncertain = true;
    if (record.clipboardChanged === true) delivered = true;
    completedSteps = Math.max(completedSteps, positive(record.completedSteps));
    completedClicks = Math.max(completedClicks, positive(record.completedClicks));
    if ([record.completedKeys, record.completedButtons].some(items => Array.isArray(items) && items.length > 0)) delivered = true;
    if ([record.unknownKeys, record.unknownButtons].some(items => Array.isArray(items) && items.length > 0)) uncertain = true;
    const batch = record.batch && typeof record.batch === "object" ? record.batch as Record<string, unknown> : undefined;
    if (batch) {
      if (batch.completed === false) partial = true;
      const steps = Array.isArray(batch.steps) ? batch.steps : [];
      let knownSteps = 0;
      for (const step of steps) {
        if (!step || typeof step !== "object") continue;
        const item = step as Record<string, unknown>;
        if (item.ok === false) partial = true;
        // Legacy Windows batch steps have ok but no executed field.
        if (item.ok === true && item.executed !== false && item.executed !== "unknown") knownSteps++;
        visit(item, depth + 2);
      }
      completedSteps = Math.max(completedSteps, knownSteps);
      visit(batch, depth + 1);
    }
    for (const key of ["details", "actionResult", "errorDetails"]) visit(record[key], depth + 1);
    if (Array.isArray(record.stepResults)) for (const result of record.stepResults.slice(0, 64)) visit(result, depth + 1);
  };
  visit(value);
  delivered ||= completedSteps > 0 || completedClicks > 0;
  return { sideEffects: uncertain ? "unknown" : delivered ? "known" : notExecuted ? "none" : undefined, partial, completedSteps, completedClicks };
}

function deliverySummary(evidence: DeliveryEvidence): string {
  const facts = [
    evidence.completedSteps ? `${evidence.completedSteps} completed input steps` : undefined,
    evidence.completedClicks ? `${evidence.completedClicks} completed clicks` : undefined,
    evidence.sideEffects === "unknown" ? "delivery remains uncertain" : undefined,
  ].filter(Boolean);
  return facts.length ? ` Evidence: ${facts.join("; ")}.` : "";
}

/** Deduplication must not let an earlier no-effect error hide newly uncertain delivery. */
function recordRecovery(bridge: ComputerUseRecoveryBridge, input: Parameters<ExecutionFailureRepository["recordIfAbsent"]>[0]): void {
  const existing = bridge.failures.list(input.taskId).filter(item => !item.resolvedAt && item.causeCode === input.causeCode &&
    item.target === input.target && item.recovery === input.recovery && item.phase === input.phase);
  const rank = { none: 0, known: 1, unknown: 2 };
  if (existing.length && existing.every(item => rank[item.sideEffects] < rank[input.sideEffects])) bridge.failures.record(input);
  else bridge.failures.recordIfAbsent(input);
}

/** A fresh binding can clear a no-effect lookup failure, not a delivered prefix with the same code. */
function resolveNoEffectFailures(bridge: ComputerUseRecoveryBridge, taskId: string, target: string, codes: readonly string[]): void {
  const unresolved = bridge.failures.list(taskId).filter(item => !item.resolvedAt && item.target === target);
  const safe = codes.filter(code => unresolved.some(item => item.causeCode === code) &&
    unresolved.filter(item => item.causeCode === code).every(item => item.sideEffects === "none"));
  if (safe.length) bridge.failures.resolveMatching(taskId, { target, causeCodes: safe });
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
    CONTROL_NOT_FOUND: "Re-inspect structured controls in the same target window before selecting a replacement control.",
    CONTROL_AMBIGUOUS: "Refine the control selector with automationId/runtimeId/controlType before retrying.",
    POINT_OUTSIDE_CLIENT: "Discard the old coordinates and obtain fresh structured client bounds for the same target window.",
    REQUEST_TIMEOUT: "Re-observe the same target first. The original action may have reached the application, so do not blindly replay it.",
    HOST_UNAVAILABLE: "Restore the platform automation driver, then re-observe the intended target before continuing.",
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
  const evidence = deliveryEvidence(error.details);
  const sideEffects = evidence.sideEffects ?? (PRE_ACTION_CODES.has(error.code) || !sideEffectingInput(input) ? "none" : "unknown");
  recordRecovery(bridge, {
    ...ctx,
    causeCode: causeCodeFor(error.code),
    phase: PRE_ACTION_CODES.has(error.code) && sideEffects === "none" ? "observe" : "execute",
    recovery: "recoverable",
    sideEffects,
    target,
    message: `Computer Use ${actionName(input)} failed (${error.code}): ${error.message}${deliverySummary(evidence)}`,
    nextAction: sideEffects !== "none" ? `${recoveryGuidance(error)} Already-delivered input may exist; preserve its prefix and do not replay the operation.` : recoveryGuidance(error),
  });
  return true;
}

function verificationState(output: ComputerExecOutput): { post?: string; visual?: string; semantic?: string } {
  const run = output.computerUseRun && typeof output.computerUseRun === "object" ? output.computerUseRun as Record<string, unknown> : undefined;
  const verification = run?.verification && typeof run.verification === "object" ? run.verification as Record<string, unknown> : undefined;
  return {
    post: output.observationStatus === "failed" ? "unavailable" : typeof verification?.postObservation === "string" ? verification.postObservation : output.observation ? "verified" : undefined,
    visual: output.captureError || output.captureStatus === "failed" ? "failed" : typeof verification?.visualVerification === "string" ? verification.visualVerification : output.screenshot ? "captured" : undefined,
    semantic: output.semanticOutcome?.status,
  };
}

export function settleComputerUseResultRecovery(bridge: ComputerUseRecoveryBridge | undefined, input: ComputerExecInput, output: ComputerExecOutput): void {
  if (!bridge) return;
  const ctx = bridge.resolveContext();
  if (!ctx) return;
  const target = computerUseRecoveryTarget(input, output);
  const action = actionName(input);
  const sideEffecting = sideEffectingInput(input);
  const evidence = deliveryEvidence(output);
  const state = verificationState(output);
  const incomplete = evidence.partial || evidence.sideEffects === "unknown" || output.verified === false;
  const observationFailed = state.post === "unavailable" || state.visual === "failed";
  // A later successful call proves pre-action binding/selector failures are repaired. It does NOT, by itself,
  // reconcile a prior delivered prefix, even if its error code normally describes a precondition.
  if (!incomplete && !observationFailed) {
    resolveNoEffectFailures(bridge, ctx.taskId, target, PRE_ACTION_CAUSE_CODES);
    if (!sideEffecting) resolveNoEffectFailures(bridge, ctx.taskId, target, OPERATIONAL_CAUSE_CODES);
  }

  const verifyCodes = ["computer-post-verification-unavailable", "computer-semantic-verification-failed", "computer-semantic-verification-unavailable"];
  // Windows legacy successful outputs omit executed; keep their established inference.
  const sideEffects = evidence.sideEffects ?? (sideEffecting ? "known" as const : "none" as const);
  if (evidence.partial || evidence.sideEffects === "unknown") {
    recordRecovery(bridge, { ...ctx, causeCode: evidence.partial ? "computer-batch-incomplete" : "computer-delivery-uncertain", phase: "execute", recovery: "recoverable",
      sideEffects, target, message: `Computer Use ${action} ${evidence.partial ? "stopped before all steps completed" : "returned without confirmed delivery"}.${deliverySummary(evidence)}`,
      nextAction: "Keep the completed prefix and inspect the same target. Do not replay the batch or an uncertain input; reconcile its effects before planning another action." });
  }
  if (observationFailed) {
    recordRecovery(bridge, { ...ctx, causeCode: "computer-post-verification-unavailable", phase: "verify", recovery: "recoverable",
      sideEffects, target, message: `Computer Use ${action} returned, but post-action observation or visual verification was unavailable.`,
      nextAction: "Re-observe the same target before deciding whether another input action is necessary; do not infer success from the attempted action alone." });
  } else if (!incomplete) {
    bridge.failures.resolveMatching(ctx.taskId, { target, causeCodes: ["computer-post-verification-unavailable"] });
  }

  if (state.semantic === "failed") {
    recordRecovery(bridge, { ...ctx, causeCode: "computer-semantic-verification-failed", phase: "verify", recovery: "recoverable",
      sideEffects, target, message: `Computer Use ${action} returned, but the requested semantic postcondition failed.`,
      nextAction: "Re-observe the same target and re-plan from the actual UI state; do not repeat the input merely because the transport succeeded." });
  } else if (state.semantic === "not_evaluable") {
    recordRecovery(bridge, { ...ctx, causeCode: "computer-semantic-verification-unavailable", phase: "verify", recovery: "recoverable",
      sideEffects, target, message: `Computer Use ${action} returned, but the requested semantic postcondition could not be evaluated.`,
      nextAction: "Acquire fresh observable evidence for the same target before deciding whether another action is needed." });
  } else if (state.semantic === "passed" && !incomplete && !observationFailed) {
    bridge.failures.resolveMatching(ctx.taskId, { target, causeCodes: ["computer-semantic-verification-failed", "computer-semantic-verification-unavailable"] });
  }

  if (!incomplete && !observationFailed && state.semantic === "passed") {
    bridge.failures.resolveMatching(ctx.taskId, { target, causeCodes: verifyCodes });
    // Explicit postcondition success is the first point where a prior side-effecting transport uncertainty may be cleared.
    bridge.failures.resolveMatching(ctx.taskId, { target, causeCodes: OPERATIONAL_CAUSE_CODES });
  }
}
