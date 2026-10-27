import type { ComputerExecInput, ComputerExecOutput } from "../platform/computer-use/protocol";

export type ComputerUsePhase = "observing" | "acting" | "verifying" | "waiting" | "recovering" | "completed" | "failed";

const SIDE_EFFECT_ACTIONS = new Set<ComputerExecInput["action"]>([
  "focus_window", "screenshot_window",
  "invoke_control", "set_control_value",
  "move_client", "click_client", "drag_client", "scroll_client",
  "mouse_down_client", "mouse_up_client", "key_down", "key_up", "paste_text", "drag_screen",
  "mouse_move", "mouse_click", "mouse_drag", "scroll",
  "key_press", "type_text",
]);

const LIGHTWEIGHT_ACTIONS = new Set<ComputerExecInput["action"]>(["move_client", "mouse_move"]);

export function isComputerUseSideEffect(action: ComputerExecInput["action"] | undefined): boolean {
  return action !== undefined && SIDE_EFFECT_ACTIONS.has(action);
}

export function isComputerUseLightweightAction(action: ComputerExecInput["action"] | undefined): boolean {
  return action !== undefined && LIGHTWEIGHT_ACTIONS.has(action);
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
