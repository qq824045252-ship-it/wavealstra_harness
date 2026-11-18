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

export function isBrowserObservationFailure(failure: Pick<ExecutionFailureDto, "causeCode" | "phase" | "sideEffects" | "recovery">): boolean {
  return causes.has(failure.causeCode) && failure.phase === "observe"
    && failure.sideEffects === "none" && failure.recovery === "recoverable";
}
