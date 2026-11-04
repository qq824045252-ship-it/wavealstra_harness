import { ComputerUseError, type ComputerExecInput, type ComputerExecOutput } from "../platform/computer-use/protocol";

export type ComputerUsePhase = "observing" | "acting" | "verifying" | "waiting" | "recovering" | "completed" | "failed";

const SIDE_EFFECT_ACTIONS = new Set<ComputerExecInput["action"]>([
  "focus_window", "screenshot_window",
  "invoke_control", "set_control_value",
  "move_client", "click_client", "drag_client", "scroll_client",
  "mouse_down_client", "mouse_up_client", "key_down", "key_up", "paste_text", "drag_screen",
  "mouse_move", "mouse_click", "mouse_drag", "scroll",
  "key_press", "type_text",
  "move_window", "resize_window",
]);

const LIGHTWEIGHT_ACTIONS = new Set<ComputerExecInput["action"]>(["move_client", "mouse_move"]);

export function isComputerUseSideEffect(action: ComputerExecInput["action"] | undefined): boolean {
  return action !== undefined && SIDE_EFFECT_ACTIONS.has(action);
}

export function isComputerUseLightweightAction(action: ComputerExecInput["action"] | undefined): boolean {
  return action !== undefined && LIGHTWEIGHT_ACTIONS.has(action);
}

/** Validate before any window lookup, focus change, clipboard write or overlay. */
export function validateComputerAction(input: ComputerExecInput): void {
  if (input.action != null && input.actions != null) throw new Error("computer_exec 的 action 与 actions 只能二选一");
  if (input.actions != null && (!Array.isArray(input.actions) || input.actions.length < 1 || input.actions.length > 8)) throw new Error("actions 需要 1–8 个步骤");
  if (!input.action && !input.actions?.length) throw new Error("computer_exec 需要 action 或 actions");
}

/** Preserve backend failure evidence and returned results through cancellation/artifact delivery. */
export function withComputerUseDeliveryEvidence(error: unknown, result?: ComputerExecOutput, signal?: AbortSignal): unknown {
  // A backend may reject with a submitted prefix or uncertain delivery. The
  // generic cancellation reason cannot replace that more specific evidence.
  const failure = error instanceof ComputerUseError ? error : signal?.aborted ? signal.reason ?? error : error;
  if (!result) return failure;
  const { screenshot: _screenshot, ...actionResult } = result;
  const original = failure instanceof ComputerUseError ? failure : undefined;
  const details = original?.details && typeof original.details === "object" ? original.details : {};
  const executed = result.executed === true || result.executed === false || result.executed === "unknown"
    ? result.executed : result.action === "batch" || isComputerUseSideEffect(result.action) ? "unknown" : false;
  return new ComputerUseError(original?.code ?? (failure instanceof Error && failure.name === "AbortError" ? "REQUEST_CANCELLED" : "HOST_PROTOCOL_ERROR"),
    `动作已返回结果，但后续结果交付失败；先核对已执行步骤，禁止重放：${failure instanceof Error ? failure.message : String(failure)}`,
    { ...details, stage: "result-delivery", doNotReplay: true, executed, actionResult });
}

/** Model providers consume tool content, not the UI-only details field. */
export function formatComputerUseFailureEvidence(error: unknown): string {
  if (!(error instanceof ComputerUseError)) return "";
  const keys = [
    "code", "action", "executed", "verified", "executionUncertain", "doNotReplay", "retrySafe", "stage",
    "completed", "completedSteps", "requestedSteps", "completedClicks", "requestedClicks",
    "completedKeys", "completedButtons", "unknownKeys", "unknownButtons", "heldKeys", "heldButtons",
    "batch", "steps", "actionResult", "index", "ok", "errorCode", "errorDetails",
    "clipboardChanged", "pasted", "textLength", "actualPointer", "x", "y",
    "observationStatus", "captureError", "observationError", "readbackError",
    "semanticOutcome", "checks", "kind", "status", "cleanup", "cleanupError", "cleanupFailed", "keys", "buttons", "errors",
    "window", "handle", "processId", "className", "title", "identityToken", "layoutId", "observationId",
    "message", "detail", "evidence", "reason", "diagnosticCode",
  ];
  let budget = 6_000;
  let truncated = false;
  const visit = (value: unknown, depth: number): unknown => {
    if (budget <= 0 || depth > 7) { truncated = true; return undefined; }
    if (value === null || typeof value === "number" || typeof value === "boolean") { budget -= 16; return value; }
    if (typeof value === "string") {
      const kept = value.slice(0, Math.min(320, budget));
      budget -= kept.length + 4;
      if (kept.length !== value.length) truncated = true;
      return kept;
    }
    if (!value || typeof value !== "object" || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return undefined;
    if (Array.isArray(value)) {
      if (value.length > 16) truncated = true;
      return value.slice(0, 16).map(item => visit(item, depth + 1)).filter(item => item !== undefined);
    }
    const picked: Record<string, unknown> = {};
    const source = value as Record<string, unknown>;
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(source, key) || source[key] === undefined) continue;
      budget -= key.length + 6;
      const item = visit(source[key], depth + 1);
      if (item !== undefined) picked[key] = item;
    }
    return picked;
  };
  const details = error.details && typeof error.details === "object" ? error.details : {};
  const evidence = visit({ ...details, code: error.code }, 0) as Record<string, unknown>;
  return JSON.stringify({ ...evidence, ...(truncated ? { evidenceTruncated: true } : {}) });
}

export function hasWindowTarget(input: ComputerExecInput): boolean {
  return Boolean(input.appSessionId || input.windowHandle || input.windowTitle || input.processId || input.className || input.observationId);
}

/**
 * Real Agent Computer Use calls are wrapped in an Observe → Act → Verify loop.
 * Low-level tests and direct service consumers without taskId keep the raw contract.
 *
 * `capture_after` stays opt-in: forcing a window screenshot after every click,
 * key press and scroll doubled the image payload and added ~0.36s per action.
 * Callers ask for visual proof explicitly when the result is ambiguous.
 */
export function prepareComputerUseInput(input: ComputerExecInput): ComputerExecInput {
  const expectsSemanticOutcome = Boolean(input.expectedOutcomes?.length);
  if (!input.taskId || (!isComputerUseSideEffect(input.action) && !expectsSemanticOutcome)) return { ...input };
  if (isComputerUseLightweightAction(input.action) && !expectsSemanticOutcome) return { ...input };
  return { ...input, observeAfter: true };
}

export interface ComputerUseVerification {
  strategy: "observe-act-verify";
  precondition: "window-identity" | "foreground" | "desktop";
  postObservation: "verified" | "unavailable" | "not-required";
  visualVerification: "captured" | "failed" | "not-required";
  semanticVerification: "passed" | "failed" | "not_evaluable" | "not_requested";
  focusPreserved?: boolean;
}

export function verificationFor(input: ComputerExecInput, output: ComputerExecOutput): ComputerUseVerification {
  const targeted = hasWindowTarget(input);
  const screenshotObserved = (input.action === "screenshot_window" || input.action === "screenshot" || input.action === "ocr_window") && Boolean(output.screenshot);
  const postObservation = output.observation || screenshotObserved
    ? "verified"
    : output.observationStatus === "failed"
      ? "unavailable"
      : isComputerUseSideEffect(input.action) && !isComputerUseLightweightAction(input.action)
        ? "unavailable"
        : "not-required";
  const visualVerification = output.screenshot ? "captured"
    : input.captureAfter || input.action === "screenshot_window" || input.action === "screenshot" ? "failed" : "not-required";
  return {
    strategy: "observe-act-verify",
    precondition: targeted ? "window-identity" : input.action === "screenshot_window" ? "foreground" : "desktop",
    postObservation,
    visualVerification,
    semanticVerification: output.semanticOutcome?.status ?? "not_requested",
    focusPreserved: output.observation?.focusPreserved,
  };
}
