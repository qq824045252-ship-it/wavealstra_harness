import type {
  ActionObservation,
  ComputerOutcomeCheckResult,
  ComputerOutcomeExpectation,
  ComputerOutcomeKind,
  ComputerSemanticOutcome,
  ControlInfo,
  ControlSelector,
  TargetIdentity,
  WindowInfo,
} from "../platform/computer-use/protocol";

// 跨平台 DTO 在 platform/computer-use/protocol.ts；这里 re-export 保持旧 import 路径可用。
export type {
  ComputerOutcomeCheckResult,
  ComputerOutcomeExpectation,
  ComputerOutcomeKind,
  ComputerSemanticOutcome,
};

export interface ComputerOutcomeEvaluationContext {
  observation?: ActionObservation;
  outputWindow?: WindowInfo;
  findControl?: (target: TargetIdentity, selector: ControlSelector) => Promise<ControlInfo | undefined>;
}

function titleMatches(window: WindowInfo | undefined, expected?: string): boolean {
  if (!window) return false;
  const needle = expected?.trim().toLocaleLowerCase();
  return !needle || window.title.toLocaleLowerCase().includes(needle);
}

function selectorFor(expectation: ComputerOutcomeExpectation): ControlSelector | undefined {
  const selector: ControlSelector = {
    controlName: expectation.controlName?.trim() || undefined,
    automationId: expectation.automationId?.trim() || undefined,
    controlType: expectation.controlType?.trim() || undefined,
    controlRuntimeId: expectation.controlRuntimeId?.trim() || undefined,
    controlClassName: expectation.controlClassName?.trim() || undefined,
    exactName: expectation.exactName,
  };
  if (!selector.controlName && !selector.automationId && !selector.controlType && !selector.controlRuntimeId && !selector.controlClassName) {
    return undefined;
  }
  return selector;
}

function targetIdentity(window: WindowInfo): TargetIdentity {
  return { windowHandle: window.handle, expectedProcessId: window.processId };
}

async function evaluateOne(
  expectation: ComputerOutcomeExpectation,
  context: ComputerOutcomeEvaluationContext,
): Promise<ComputerOutcomeCheckResult> {
  const observation = context.observation;
  const targetAfter = observation?.targetAfter ?? context.outputWindow;
  if (expectation.kind === "target_present") {
    const passed = titleMatches(targetAfter, expectation.windowTitleContains);
    return {
      kind: expectation.kind,
      status: passed ? "passed" : "failed",
      evidence: passed
        ? `target present: ${targetAfter?.title ?? "untitled"}`
        : `target not present${expectation.windowTitleContains ? ` with title containing "${expectation.windowTitleContains}"` : ""}`,
    };
  }
  if (expectation.kind === "target_closed") {
    if (!observation?.targetBefore) {
      return { kind: expectation.kind, status: "not_evaluable", evidence: "no pre-action target observation" };
    }
    const passed = !observation.targetAfter;
    return {
      kind: expectation.kind,
      status: passed ? "passed" : "failed",
      evidence: passed ? "original target closed" : `target still present: ${observation.targetAfter?.title ?? "untitled"}`,
    };
  }
  if (expectation.kind === "target_foreground") {
    if (!targetAfter) return { kind: expectation.kind, status: "failed", evidence: "target missing after action" };
    const passed = targetAfter.foreground && titleMatches(targetAfter, expectation.windowTitleContains);
    return {
      kind: expectation.kind,
      status: passed ? "passed" : "failed",
      evidence: passed ? `foreground target: ${targetAfter.title}` : `target is not foreground or title does not match: ${targetAfter.title}`,
    };
  }
  if (expectation.kind === "new_window") {
    if (!observation) return { kind: expectation.kind, status: "not_evaluable", evidence: "no post-action window observation" };
    const match = (observation.newWindows ?? []).find((window) => titleMatches(window, expectation.windowTitleContains));
    return {
      kind: expectation.kind,
      status: match ? "passed" : "failed",
      evidence: match
        ? `new window: ${match.title}`
        : `no new window${expectation.windowTitleContains ? ` with title containing "${expectation.windowTitleContains}"` : ""}`,
    };
  }

  const selector = selectorFor(expectation);
  if (!selector) return { kind: expectation.kind, status: "not_evaluable", evidence: "control expectation is missing a selector" };
  if (!targetAfter) return { kind: expectation.kind, status: "not_evaluable", evidence: "target unavailable for control verification" };
  if (!context.findControl) return { kind: expectation.kind, status: "not_evaluable", evidence: "control verifier unavailable" };
  const control = await context.findControl(targetIdentity(targetAfter), selector);
  const present = Boolean(control && !control.offscreen);
  const passed = expectation.kind === "control_present" ? present : !present;
  return {
    kind: expectation.kind,
    status: passed ? "passed" : "failed",
    evidence: control
      ? `control ${present ? "present" : "offscreen"}: ${control.name ?? control.automationId ?? control.runtimeId}`
      : "control not found",
  };
}

export async function evaluateComputerOutcome(
  expectations: ComputerOutcomeExpectation[] | undefined,
  context: ComputerOutcomeEvaluationContext,
): Promise<ComputerSemanticOutcome> {
  if (!expectations?.length) return { status: "not_requested", checks: [] };
  const checks: ComputerOutcomeCheckResult[] = [];
  for (const expectation of expectations.slice(0, 4)) {
    try {
      checks.push(await evaluateOne(expectation, context));
    } catch (error) {
      checks.push({
        kind: expectation.kind,
        status: "not_evaluable",
        evidence: `semantic verifier error: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  const status = checks.some((check) => check.status === "failed")
    ? "failed"
    : checks.some((check) => check.status === "not_evaluable")
      ? "not_evaluable"
      : "passed";
  return { status, checks };
}
