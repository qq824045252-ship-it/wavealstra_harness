import type { ComputerExecInput } from "./ComputerAutomationService";
import { isComputerUseSideEffect } from "./ComputerUsePolicy";
import { WindowsAutomationError } from "./windows/windowsAutomationProtocol";

export interface ComputerUseRecoveryPlan {
  retry: boolean;
  delayMs?: number;
  input?: ComputerExecInput;
  reason: string;
  guidance: string;
}

function readonlyAction(input: ComputerExecInput): boolean {
  return !isComputerUseSideEffect(input.action) || (input.action === "screenshot_window" && input.ensureForeground === false);
}

function stableSelectorAvailable(input: ComputerExecInput): boolean {
  return Boolean(input.windowHandle || input.windowTitle || input.processId || input.className);
}

export function planComputerUseRecovery(error: unknown, input: ComputerExecInput, attempt: number): ComputerUseRecoveryPlan | null {
  if (!(error instanceof WindowsAutomationError)) return null;
  // A batch may already have executed part of its steps; retrying the whole
  // batch could duplicate side effects. Re-observe and continue manually.
  if (input.actions?.length) {
    return { retry: false, reason: "batch", guidance: "批量动作可能已执行部分步骤；先观察窗口/控件状态，再决定剩余步骤，不要重复整批。" };
  }
  if (error.code === "REQUEST_CANCELLED") {
    return { retry: false, reason: "cancelled", guidance: "用户或运行时已取消 Computer Use；不要自动重试。" };
  }
  if (attempt > 0) {
    return { retry: false, reason: "retry-exhausted", guidance: "自动恢复已尝试一次；重新观察当前窗口/控件后再决定下一步。" };
  }

  if (error.code === "STALE_OBSERVATION" && stableSelectorAvailable(input)) {
    return {
      retry: true,
      delayMs: 80,
      input: { ...input, observationId: undefined },
      reason: "stale-observation",
      guidance: "旧 observation 已失效；按显式窗口 selector 重新绑定后重试一次。",
    };
  }
  if (error.code === "FOCUS_FAILED") {
    return {
      retry: true,
      delayMs: 180,
      input: { ...input, observationId: undefined },
      reason: "focus-retry",
      guidance: "前台焦点切换失败；短暂等待并重新绑定窗口后重试一次。",
    };
  }
  if (error.code === "CAPTURE_FAILED" && (input.action === "screenshot" || input.action === "screenshot_window")) {
    return {
      retry: true,
      delayMs: 120,
      input: { ...input, observationId: undefined },
      reason: "capture-retry",
      guidance: "截图前后窗口状态发生变化；重新观察后重试一次只读截图。",
    };
  }
  if ((error.code === "HOST_UNAVAILABLE" || error.code === "REQUEST_TIMEOUT") && readonlyAction(input)) {
    return {
      retry: true,
      delayMs: 100,
      input: { ...input, observationId: undefined },
      reason: "host-readonly-retry",
      guidance: "自动化 Host 不可用或超时；只读动作可安全重建 Host 后重试一次。",
    };
  }

  const guidance: Partial<Record<WindowsAutomationError["code"], string>> = {
    CONTROL_AMBIGUOUS: "控件匹配不唯一；先 inspect_controls，再用 automationId/runtimeId/controlType 缩小选择器。",
    CONTROL_NOT_FOUND: "控件已变化或不可见；重新 inspect_controls/screenshot_window 后再定位。",
    POINT_OUTSIDE_CLIENT: "坐标已失效；禁止修补旧坐标，重新 screenshot_window 或读取新的 clientBoundsDip。",
    WINDOW_AMBIGUOUS: "窗口标题匹配不唯一；改用 HWND/PID 或更精确的 class/title。",
    WINDOW_NOT_FOUND: "目标窗口不存在；重新 list_windows/wait_for_window，不要盲点。",
    CONTROL_NOT_ACTIONABLE: "控件 disabled/offscreen 或不支持目标 pattern；重新观察并选择可操作控件。",
    CAPTURE_SPANS_MULTIPLE_DISPLAYS: "目标窗口跨显示器；先移动/缩放到单一显示器或改用语义 UIA 操作。",
  };
  return {
    retry: false,
    reason: error.code.toLowerCase(),
    guidance: guidance[error.code] ?? "不要盲目重复原动作；重新观察当前窗口状态后再继续。",
  };
}

export function withRecoveryDetails(error: unknown, plan: ComputerUseRecoveryPlan | null, attempt: number): unknown {
  if (!(error instanceof WindowsAutomationError) || !plan) return error;
  const previous = error.details && typeof error.details === "object" ? error.details as Record<string, unknown> : { details: error.details };
  return new WindowsAutomationError(error.code, error.message, {
    ...previous,
    computerUseRecovery: { attempt, retry: plan.retry, reason: plan.reason, guidance: plan.guidance },
  });
}
