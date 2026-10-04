import type { ComputerExecInput, ComputerExecOutput } from "./ComputerAutomationService";

export type ComputerUsePhase = "observing" | "acting" | "verifying" | "waiting" | "recovering" | "completed" | "failed";

const SIDE_EFFECT_ACTIONS = new Set<ComputerExecInput["action"]>([
  "focus_window", "screenshot_window",
  "invoke_control", "set_control_value",
  "move_client", "click_client", "drag_client", "scroll_client",
  "mouse_move", "mouse_click", "mouse_drag", "scroll",
  "key_press", "type_text",
]);

const VISUAL_VERIFY_ACTIONS = new Set<ComputerExecInput["action"]>([
  "invoke_control", "set_control_value",
  "click_client", "drag_client", "scroll_client",
  "key_press", "type_text",
]);

const LIGHTWEIGHT_ACTIONS = new Set<ComputerExecInput["action"]>(["move_client", "mouse_move"]);

export function isComputerUseSideEffect(action: ComputerExecInput["action"]): boolean {
  return SIDE_EFFECT_ACTIONS.has(action);
}

export function isComputerUseLightweightAction(action: ComputerExecInput["action"]): boolean {
  return LIGHTWEIGHT_ACTIONS.has(action);
}

export function hasWindowTarget(input: ComputerExecInput): boolean {
  return Boolean(input.windowHandle || input.windowTitle || input.processId || input.className || input.observationId);
}

/**
 * Real Agent Computer Use calls are wrapped in an Observe → Act → Verify loop.
 * Low-level tests and direct service consumers without taskId keep the raw contract.
 */
export function prepareComputerUseInput(input: ComputerExecInput): ComputerExecInput {
  const expectsSemanticOutcome = Boolean(input.expectedOutcomes?.length);
  if (!input.taskId || (!isComputerUseSideEffect(input.action) && !expectsSemanticOutcome)) return { ...input };
  if (isComputerUseLightweightAction(input.action) && !expectsSemanticOutcome) return { ...input };

  const next: ComputerExecInput = { ...input, observeAfter: true };
  if (VISUAL_VERIFY_ACTIONS.has(input.action) && hasWindowTarget(input)) {
    next.captureAfter = true;
  }
  return next;
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
  const postObservation = output.observation
    ? "verified"
    : output.observationStatus === "failed"
      ? "unavailable"
      : isComputerUseSideEffect(input.action) && !isComputerUseLightweightAction(input.action)
        ? "unavailable"
        : "not-required";
  const visualVerification = input.captureAfter
    ? output.captureStatus === "captured" || output.screenshot
      ? "captured"
      : "failed"
    : "not-required";
  return {
    strategy: "observe-act-verify",
    precondition: targeted ? "window-identity" : input.action === "screenshot_window" ? "foreground" : "desktop",
    postObservation,
    visualVerification,
    semanticVerification: output.semanticOutcome?.status ?? "not_requested",
    focusPreserved: output.observation?.focusPreserved,
  };
}
