import type {
  BrowserAutomationErrorCode,
  BrowserExecInput,
  BrowserExecOutput,
} from "../capabilities/BrowserAutomationService";
import { BrowserAutomationError } from "../capabilities/BrowserAutomationService";
import type { ConversationExecutionContext } from "./ConversationExecutionContext";
import type { ExecutionFailureRepository } from "./ExecutionFailureRepository";

export interface BrowserAutomationRecoveryBridge {
  resolveContext: () => ConversationExecutionContext | undefined;
  failures: ExecutionFailureRepository;
}

const SIDE_EFFECT_ACTIONS = new Set<BrowserExecInput["action"]>(["navigate", "click", "fill", "press"]);
const PRE_ACTION_CODES = new Set<BrowserAutomationErrorCode>([
  "HOST_UNAVAILABLE", "PAGE_UNAVAILABLE", "SCREENSHOT_EMPTY", "SELECTOR_NOT_FOUND", "ELEMENT_NOT_CLICKABLE", "ELEMENT_NOT_EDITABLE",
]);
const RECOVERABLE_CODES = new Set<BrowserAutomationErrorCode>([
  ...PRE_ACTION_CODES,
  "NAVIGATION_FAILED", "FOCUS_FAILED", "EXECUTION_FAILED",
]);
const PRE_ACTION_CAUSE_CODES = [
  "browser-host-unavailable", "browser-page-unavailable", "browser-screenshot-empty", "browser-selector-not-found",
  "browser-element-not-clickable", "browser-element-not-editable",
] as const;

function encoded(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? encodeURIComponent(text) : undefined;
}

function normalizedUrl(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    return new URL(withScheme).toString();
  } catch { return raw; }
}

function evidenceRecord(evidence: unknown): Record<string, unknown> | undefined {
  return evidence && typeof evidence === "object" ? evidence as Record<string, unknown> : undefined;
}

function evidenceUrl(evidence: unknown): string | undefined {
  const row = evidenceRecord(evidence);
  for (const key of ["currentUrl", "url", "targetUrl"]) {
    const value = row?.[key];
    if (typeof value === "string" && value.trim()) return normalizedUrl(value);
  }
  return undefined;
}

function actionUrl(input: BrowserExecInput, evidence?: unknown): string | undefined {
  if (input.action === "navigate") return normalizedUrl(input.url) ?? evidenceUrl(evidence);
  return evidenceUrl(evidence);
}

export function browserAutomationRecoveryTarget(input: BrowserExecInput, evidence?: unknown): string {
  const url = actionUrl(input, evidence);
  const pieces = [url ? `url=${encoded(url)}` : undefined];
  if (input.selector?.trim()) pieces.push(`selector=${encoded(input.selector.trim())}`);
  return `browser:${input.action}:${pieces.filter(Boolean).join("|") || "surface"}`;
}

function uncertainPageTarget(evidence?: unknown): string {
  const url = evidenceUrl(evidence);
  return url ? `browser:uncertain:url=${encoded(url)}` : "browser:uncertain:surface";
}

function causeCode(error: BrowserAutomationError): string {
  return `browser-${error.code.toLowerCase().replaceAll("_", "-")}`;
}

function guidance(error: BrowserAutomationError, input: BrowserExecInput): string {
  const map: Partial<Record<BrowserAutomationErrorCode, string>> = {
    HOST_UNAVAILABLE: "Open or restore the MyBuddy browser surface, then observe it again before continuing.",
    NAVIGATION_FAILED: "Inspect the current browser URL/page before retrying navigation; the failed load may have partially changed browser state.",
    PAGE_UNAVAILABLE: "Open or navigate to a page before attempting to read or capture it again.",
    SCREENSHOT_EMPTY: "Make the browser surface visible and wait for the page to render before capturing again.",
    SELECTOR_NOT_FOUND: "Read or inspect the current page again and choose a selector that exists on that page.",
    ELEMENT_NOT_CLICKABLE: "Re-observe the page and choose a genuinely interactive element rather than forcing the old selector.",
    ELEMENT_NOT_EDITABLE: "Re-observe the form and select the actual editable input before filling.",
    FOCUS_FAILED: "Re-observe the page and confirm the same target element can receive focus before sending a key.",
    EXECUTION_FAILED: SIDE_EFFECT_ACTIONS.has(input.action)
      ? "Re-read or screenshot the current page before deciding whether to repeat the action; it may already have taken effect."
      : "Re-observe the current page and retry only after the browser document is healthy.",
  };
  return map[error.code] ?? "Re-observe the browser page and re-plan before retrying.";
}

export function recordBrowserAutomationFailureRecovery(
  bridge: BrowserAutomationRecoveryBridge | undefined,
  input: BrowserExecInput,
  error: unknown,
): boolean {
  if (!bridge || !(error instanceof BrowserAutomationError) || !RECOVERABLE_CODES.has(error.code)) return false;
  const ctx = bridge.resolveContext();
  if (!ctx) return false;
  const sideEffecting = SIDE_EFFECT_ACTIONS.has(input.action);
  const preAction = PRE_ACTION_CODES.has(error.code);
  const unknownEffect = error.code === "EXECUTION_FAILED" && sideEffecting;
  const target = error.code === "HOST_UNAVAILABLE"
    ? `browser:${input.action}:surface`
    : unknownEffect ? uncertainPageTarget(error.details) : browserAutomationRecoveryTarget(input, error.details);
  bridge.failures.recordIfAbsent({
    ...ctx,
    causeCode: causeCode(error),
    phase: preAction ? "observe" : "execute",
    recovery: "recoverable",
    sideEffects: preAction || !sideEffecting ? "none" : error.code === "FOCUS_FAILED" ? "known" : "unknown",
    target,
    message: `Browser automation ${input.action} failed (${error.code}): ${error.message}`,
    nextAction: guidance(error, input),
  });
  return true;
}

export function settleBrowserAutomationRecovery(
  bridge: BrowserAutomationRecoveryBridge | undefined,
  input: BrowserExecInput,
  output: BrowserExecOutput,
): void {
  if (!bridge) return;
  const ctx = bridge.resolveContext();
  if (!ctx) return;
  const exact = browserAutomationRecoveryTarget(input, output);
  const surface = browserAutomationRecoveryTarget({ ...input, selector: undefined }, undefined);
  bridge.failures.resolveMatching(ctx.taskId, { target: exact, causeCodes: PRE_ACTION_CAUSE_CODES });
  if (surface !== exact) bridge.failures.resolveMatching(ctx.taskId, { target: surface, causeCodes: ["browser-host-unavailable"] });

  if (input.action === "navigate") {
    bridge.failures.resolveMatching(ctx.taskId, { target: exact, causeCodes: ["browser-navigation-failed"] });
  } else if (input.action === "press") {
    bridge.failures.resolveMatching(ctx.taskId, { target: exact, causeCodes: ["browser-focus-failed"] });
  } else if (input.action === "read" || input.action === "screenshot") {
    bridge.failures.resolveMatching(ctx.taskId, { target: exact, causeCodes: ["browser-execution-failed"] });
    bridge.failures.resolveMatching(ctx.taskId, { target: uncertainPageTarget(output), causeCodes: ["browser-execution-failed"] });
    bridge.failures.resolveMatching(ctx.taskId, { target: "browser:uncertain:surface", causeCodes: ["browser-execution-failed"] });
  }
}