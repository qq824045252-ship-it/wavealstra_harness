import type { UiExecInput, UiExecOutput, UiAutomationErrorCode } from "../capabilities/UiAutomationService";
import { UiAutomationError } from "../capabilities/UiAutomationService";
import { isUiInputAction } from "../../shared/native-tools";
import type { ConversationExecutionContext } from "./ConversationExecutionContext";
import type { ExecutionFailureRepository } from "./ExecutionFailureRepository";
import type { DesktopOperationOutcome } from "./DesktopOperationOutcome";

export interface UiAutomationRecoveryBridge {
  resolveContext: () => ConversationExecutionContext | undefined;
  failures: ExecutionFailureRepository;
}

const ENVIRONMENT_CODES = ["TARGET_UNAVAILABLE", "SCREENSHOT_EMPTY", "CAPTURE_TIMEOUT", "EXECUTION_FAILED"] as const;
const uiCause = (code: UiAutomationErrorCode): string => `ui-${code.toLowerCase().replaceAll("_", "-")}`;

export function uiAutomationRecoveryTarget(input: UiExecInput): string {
  const target = input.target ?? "app";
  const parts: string[] = [];
  for (const key of ["selector", "role", "name", "text", "label", "placeholder", "testId", "within"] as const) {
    const value = input[key]?.trim();
    if (!value) continue;
    const literal = input.exact || key === "selector" || key === "testId" || key === "within";
    parts.push(`${key}=${encodeURIComponent(literal ? value : value.toLowerCase())}`);
  }
  if (input.exact) parts.push("exact");
  return `ui:${input.action}:${target}:${parts.join("|") || "surface"}`;
}

export function uiRecoveryGuidance(error: UiAutomationError, input: UiExecInput): string {
  if (error.details?.stage === "verify") return "输入步骤已完成，尚未确认预期界面状态。请用 wait_for、inspect 或截图核对结果。";
  if (error.outcome?.dispatch === "dispatched") return "输入可能已经生效。请先用 find、inspect 或截图核对结果，再决定下一步。";
  switch (error.code) {
    case "TARGET_UNAVAILABLE": return `请先打开 ${input.target ?? "app"} 对应的界面，再重新观察。`;
    case "ELEMENT_NOT_FOUND":
    case "ELEMENT_DISAPPEARED":
    case "SURFACE_CHANGED":
      if (error.details?.scopePresent === false) return "上次观察的菜单或弹窗已经消失。请先确认当前页面，再重新打开目标区域。";
      return error.candidates?.length ? "原引用已失效。请核对当前候选控件的名称和所属区域，确认后使用新引用。" : "请先确认菜单或弹窗仍然打开，再用 within 限定区域，按 role 和 name 查找当前控件。";
    case "ELEMENT_AMBIGUOUS": return "请核对候选控件，使用唯一引用，或用 within、role、name 和 exact 缩小范围。";
    case "ELEMENT_NOT_VISIBLE": return "请查看遮挡物或所属折叠区，展开目标或关闭遮挡后重新查找。";
    case "ELEMENT_DISABLED": return "请检查控件的启用条件，完成前置步骤后重新查找。";
    case "ELEMENT_NOT_EDITABLE": return "请检查控件类型、只读状态和焦点，重新选择可编辑控件。";
    case "SCREENSHOT_EMPTY":
    case "CAPTURE_TIMEOUT": return "请确认目标界面可见并已就绪，再获取截图。";
    default: return "请先读取当前界面状态，再决定下一步。";
  }
}

export function uiOperationOutcome(input: UiExecInput, error: UiAutomationError): DesktopOperationOutcome {
  const sideEffects = error.outcome?.dispatch === "dispatched" && isUiInputAction(input.action)
    ? error.outcome.effect === "confirmed" ? "known" : "unknown"
    : "none";
  return { status: sideEffects === "unknown" ? "inconclusive" : "failed", sideEffects, causeCode: uiCause(error.code) };
}

export function recordUiAutomationFailureRecovery(bridge: UiAutomationRecoveryBridge | undefined, input: UiExecInput, error: unknown): boolean {
  if (!bridge || !(error instanceof UiAutomationError)) return false;
  const dispatched = error.outcome?.dispatch === "dispatched";
  if (!dispatched && !ENVIRONMENT_CODES.some(code => code === error.code)) return false;
  const ctx = bridge.resolveContext();
  if (!ctx) return false;
  const outcome = uiOperationOutcome(input, error);
  bridge.failures.recordIfAbsent({
    ...ctx,
    causeCode: outcome.causeCode,
    phase: error.details?.stage === "verify" ? "verify" : outcome.sideEffects !== "none" ? "execute" : "observe",
    recovery: "recoverable",
    sideEffects: outcome.sideEffects,
    target: uiAutomationRecoveryTarget(input),
    message: `界面操作 ${input.action} 失败（${error.code}）：${error.message}`,
    nextAction: uiRecoveryGuidance(error, input),
  });
  return true;
}

export function settleUiAutomationRecovery(bridge: UiAutomationRecoveryBridge | undefined, input: UiExecInput, output: UiExecOutput): void {
  const ctx = bridge?.resolveContext();
  if (!bridge || !ctx || output.detail === "unavailable") return;
  bridge.failures.resolveMatching(ctx.taskId, { target: uiAutomationRecoveryTarget(input), sideEffects: "none", causeCodes: ENVIRONMENT_CODES.map(uiCause) });
}
