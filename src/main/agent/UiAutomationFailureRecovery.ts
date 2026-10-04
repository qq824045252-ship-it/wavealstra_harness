import type { UiExecInput, UiExecOutput, UiAutomationErrorCode } from "../capabilities/UiAutomationService";
import { UiAutomationError } from "../capabilities/UiAutomationService";
import type { ConversationExecutionContext } from "./ConversationExecutionContext";
import type { ExecutionFailureRepository } from "./ExecutionFailureRepository";

export interface UiAutomationRecoveryBridge {
  resolveContext: () => ConversationExecutionContext | undefined;
  failures: ExecutionFailureRepository;
}

const SIDE_EFFECT_ACTIONS = new Set<UiExecInput["action"]>(["click", "fill", "press", "scroll"]);
const RECOVERABLE_CODES = new Set<UiAutomationErrorCode>([
  "TARGET_UNAVAILABLE", "ELEMENT_NOT_FOUND", "ELEMENT_AMBIGUOUS", "ELEMENT_DISAPPEARED", "ELEMENT_NOT_VISIBLE",
  "ELEMENT_DISABLED", "ELEMENT_NOT_EDITABLE", "SCREENSHOT_EMPTY", "WAIT_TIMEOUT", "EXECUTION_FAILED",
]);
const PRE_ACTION_CODES = new Set<UiAutomationErrorCode>([
  "TARGET_UNAVAILABLE", "ELEMENT_NOT_FOUND", "ELEMENT_AMBIGUOUS", "ELEMENT_DISAPPEARED", "ELEMENT_NOT_VISIBLE",
  "ELEMENT_DISABLED", "SCREENSHOT_EMPTY", "WAIT_TIMEOUT", "EXECUTION_FAILED",
]);
const UI_CAUSE_CODES = [
  "ui-target-unavailable", "ui-element-not-found", "ui-element-ambiguous", "ui-element-disappeared", "ui-element-not-visible",
  "ui-element-disabled", "ui-element-not-editable", "ui-screenshot-empty", "ui-wait-timeout", "ui-execution-failed",
] as const;

function clean(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? encodeURIComponent(text.toLocaleLowerCase()) : undefined;
}

export function uiAutomationRecoveryTarget(input: UiExecInput): string {
  const target = input.target ?? "app";
  const locator = input.selector?.trim()
    ? `selector=${encodeURIComponent(input.selector.trim())}`
    : [clean(input.role) ? `role=${clean(input.role)}` : undefined, clean(input.name) ? `name=${clean(input.name)}` : undefined,
        clean(input.text) ? `text=${clean(input.text)}` : undefined].filter(Boolean).join("|") || "surface";
  return `ui:${input.action}:${target}:${locator}`;
}

function causeCode(error: UiAutomationError): string {
  return `ui-${error.code.toLowerCase().replaceAll("_", "-")}`;
}

function guidance(error: UiAutomationError, input: UiExecInput): string {
  const messages: Partial<Record<UiAutomationErrorCode, string>> = {
    TARGET_UNAVAILABLE: `Reopen or restore the ${input.target ?? "app"} UI surface, then observe it again before retrying.`,
    ELEMENT_NOT_FOUND: "Refresh the UI snapshot/find result and locate the intended element again; do not reuse stale coordinates or selectors blindly.",
    ELEMENT_AMBIGUOUS: "Refine the selector/role/name so exactly one element matches before acting.",
    ELEMENT_DISAPPEARED: "The element changed between observation and action. Re-observe the same UI surface before another action.",
    ELEMENT_NOT_VISIBLE: "Re-observe layout/scroll state and target a visible element before acting.",
    ELEMENT_DISABLED: "Inspect why the control is disabled and satisfy its prerequisite instead of forcing the action.",
    ELEMENT_NOT_EDITABLE: "The attempted fill focused/clicked the target but it is not editable. Re-observe and choose the correct input control.",
    SCREENSHOT_EMPTY: "Restore the UI surface to a visible/ready state, then capture it again.",
    WAIT_TIMEOUT: "Read the current UI state and decide whether the awaited condition is still reachable before waiting again.",
    EXECUTION_FAILED: "Re-observe the UI surface and retry only after confirming the target document is still healthy.",
  };
  return messages[error.code] ?? "Re-observe the UI surface and re-plan before retrying.";
}

export function recordUiAutomationFailureRecovery(bridge: UiAutomationRecoveryBridge | undefined, input: UiExecInput, error: unknown): boolean {
  if (!bridge || !(error instanceof UiAutomationError) || !RECOVERABLE_CODES.has(error.code)) return false;
  const ctx = bridge.resolveContext();
  if (!ctx) return false;
  const preAction = PRE_ACTION_CODES.has(error.code);
  bridge.failures.recordIfAbsent({
    ...ctx,
    causeCode: causeCode(error),
    phase: preAction ? "observe" : "execute",
    recovery: "recoverable",
    sideEffects: preAction || !SIDE_EFFECT_ACTIONS.has(input.action) ? "none" : "known",
    target: uiAutomationRecoveryTarget(input),
    message: `UI automation ${input.action} failed (${error.code}): ${error.message}`,
    nextAction: guidance(error, input),
  });
  return true;
}

export function settleUiAutomationRecovery(bridge: UiAutomationRecoveryBridge | undefined, input: UiExecInput, _output: UiExecOutput): void {
  if (!bridge) return;
  const ctx = bridge.resolveContext();
  if (!ctx) return;
  bridge.failures.resolveMatching(ctx.taskId, { target: uiAutomationRecoveryTarget(input), causeCodes: UI_CAUSE_CODES });
}