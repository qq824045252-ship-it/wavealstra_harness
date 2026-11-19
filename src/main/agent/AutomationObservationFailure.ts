import type { BrowserAutomationErrorCode } from "../capabilities/BrowserAutomationService";
import type { ExecutionFailureDto } from "../../shared/execution-recovery";

// Rejected locators are feedback for the Agent's observe/act loop. Only
// environment failures or uncertain dispatched effects belong in recovery UI.
const codes = new Set<BrowserAutomationErrorCode>([
  "SELECTOR_NOT_FOUND", "ELEMENT_NOT_CLICKABLE", "ELEMENT_NOT_EDITABLE",
  "ELEMENT_AMBIGUOUS", "ELEMENT_DISABLED", "ELEMENT_NOT_VISIBLE", "SURFACE_CHANGED", "WAIT_TIMEOUT",
]);
const causes = new Set([...codes].map(code => `browser-${code.toLowerCase().replaceAll("_", "-")}`));

export function isBrowserObservationCode(code: BrowserAutomationErrorCode): boolean {
  return codes.has(code);
}

export function isAutomationObservationFailure(failure: Pick<ExecutionFailureDto, "causeCode" | "target" | "phase" | "sideEffects" | "recovery" | "message">): boolean {
  // Older ui_exec classified all timeouts as pre-dispatch. Only the read-only
  // wait and locator rejections are sufficient evidence on those stored rows.
  const uiLookup = ["ui-element-not-found", "ui-element-ambiguous", "ui-element-disappeared", "ui-element-disabled", "ui-element-not-visible"].includes(failure.causeCode)
    || (failure.causeCode === "ui-wait-timeout" && failure.target?.startsWith("ui:wait_for:") === true);
  // Old Windows find_control recorded normal read-only misses as recovery cards.
  // Other backends also use CONTROL_NOT_FOUND for an inaccessible application tree.
  const nativeLookup = failure.target?.startsWith("computer:find_control:") === true && (
    failure.causeCode === "computer-control-not-found" && failure.message.endsWith(": No UI Automation control matched")
    || failure.causeCode === "computer-control-ambiguous" && (failure.message.endsWith(": Multiple UI Automation controls matched") || failure.message.endsWith(": UI Automation search was truncated; uniqueness cannot be established"))
  );
  return (causes.has(failure.causeCode) || uiLookup || nativeLookup) && failure.phase === "observe"
    && failure.sideEffects === "none" && failure.recovery === "recoverable";
}
