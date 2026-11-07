import {
  WindowsAutomationError,
  type HostAction,
  type HostRequestMap,
  type TargetIdentity,
  type WindowInfo,
  type WindowsFocusTarget,
  type WindowsOwnedInputState,
} from "./windowsAutomationProtocol";
import { isKnownWindowsShellOverlay } from "./windowsShellOverlayPolicy";

export interface WindowsFocusRecoveryBudget { attempted: boolean }
type NativeRequest = <TAction extends HostAction, TResult = unknown>(
  action: TAction, params: HostRequestMap[TAction], timeoutMs?: number, signal?: AbortSignal,
) => Promise<TResult>;

const FOCUS_ACTIONS = new Set<HostAction>([
  "focus_window", "invoke_control", "set_control_value", "move_client", "click_client",
  "mouse_down_client", "mouse_up_client", "drag_client", "scroll_client",
  "key_press", "key_down", "key_up", "type_text",
]);

function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new WindowsAutomationError("REQUEST_CANCELLED", "Windows focus recovery was cancelled");
}

function sameTarget(left: WindowInfo, right: WindowInfo): boolean {
  return left.handle === right.handle && left.processId === right.processId && left.className === right.className;
}

function sameGeometry(left: WindowInfo, right: WindowInfo): boolean {
  return left.dpi === right.dpi && left.scaleFactor === right.scaleFactor
    && left.clientOrigin?.x === right.clientOrigin?.x && left.clientOrigin?.y === right.clientOrigin?.y
    && left.clientRect?.width === right.clientRect?.width && left.clientRect?.height === right.clientRect?.height
    && left.windowRect?.left === right.windowRect?.left && left.windowRect?.top === right.windowRect?.top
    && left.windowRect?.width === right.windowRect?.width && left.windowRect?.height === right.windowRect?.height;
}

function exhausted(error: WindowsAutomationError): WindowsAutomationError {
  return new WindowsAutomationError(error.code, error.message, {
    ...(error.details && typeof error.details === "object" ? error.details : {}),
    shellOverlayRecoveryAttempted: true,
  });
}

function releasedInput(value: unknown, owner: string, hostInstance?: string): WindowsOwnedInputState | undefined {
  const state = value as Partial<WindowsOwnedInputState> | undefined;
  if (state?.owner !== owner || typeof state.hostInstance !== "string" || !state.hostInstance
    || (hostInstance !== undefined && state.hostInstance !== hostInstance)
    || !Array.isArray(state.controls) || state.controls.length !== 0) return;
  return { owner, hostInstance: state.hostInstance, controls: [] };
}

/**
 * Retry only a native request which failed in Focus-Target before any target input.
 * The budget spans a complete backend execute (including batches and outer retries).
 * The original guarded window is retained; recovery never refreshes coordinate evidence.
 */
export async function requestWithWindowsFocusRecovery<TAction extends HostAction, TResult>(
  request: NativeRequest,
  action: TAction,
  params: HostRequestMap[TAction],
  expectedWindow: WindowInfo | undefined,
  budget: WindowsFocusRecoveryBudget | undefined,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<TResult> {
  assertActive(signal);
  try {
    const result = await request<TAction, TResult>(action, params, timeoutMs, signal);
    assertActive(signal);
    return result;
  } catch (error) {
    assertActive(signal);
    if (!(error instanceof WindowsAutomationError) || error.code !== "FOCUS_FAILED") throw error;
    if (budget?.attempted) throw exhausted(error);
    if (!budget || !expectedWindow || !FOCUS_ACTIONS.has(action)) throw error;
    const target = (params as { target?: TargetIdentity }).target;
    const details = error.details as { ownedInputState?: unknown; focusAttempt?: { beforeInput?: boolean; targetWindow?: WindowInfo; foregroundWindow?: unknown } } | undefined;
    const proof = details?.focusAttempt;
    const owner = "inputOwner" in params && typeof params.inputOwner === "string" ? params.inputOwner : "__direct__";
    const beforeEscape = releasedInput(details?.ownedInputState, owner,
      "expectedInputHost" in params && typeof params.expectedInputHost === "string" ? params.expectedInputHost : undefined);
    if (!target || target.windowHandle !== expectedWindow.handle
      || (target.expectedProcessId ?? target.processId) !== expectedWindow.processId
      || proof?.beforeInput !== true || !proof.targetWindow || !sameTarget(proof.targetWindow, expectedWindow)
      || !isKnownWindowsShellOverlay(proof.foregroundWindow)
      || proof.foregroundWindow.handle === expectedWindow.handle || !beforeEscape) throw error;
    if (action !== "focus_window" && !sameGeometry(proof.targetWindow, expectedWindow)) {
      throw new WindowsAutomationError("STALE_OBSERVATION", "Target geometry changed before focus recovery; observe again", { expectedWindow, current: proof.targetWindow });
    }

    // Consume before the RPC: a missing/late reply must never authorize another Escape.
    budget.attempted = true;
    let afterEscape: WindowsOwnedInputState | undefined;
    let retryStarted = false;
    try {
      const recovered = await request<"dismiss_shell_overlay", { dismissed: boolean; ownedInputState?: unknown }>("dismiss_shell_overlay", {
        target: { windowHandle: expectedWindow.handle, expectedProcessId: expectedWindow.processId, className: expectedWindow.className },
        overlay: proof.foregroundWindow,
        inputOwner: owner, expectedInputHost: beforeEscape.hostInstance,
      }, timeoutMs, signal);
      assertActive(signal);
      afterEscape = releasedInput(recovered?.ownedInputState, owner, beforeEscape.hostInstance);
      if (!afterEscape) throw new WindowsAutomationError("HOST_PROTOCOL_ERROR", "Shell overlay recovery lacks an original-host key release receipt", {
        executed: "unknown", shellOverlayRecoveryAttempted: true,
      });
      if (recovered?.dismissed !== true) throw new WindowsAutomationError(error.code, error.message, {
        ...(error.details && typeof error.details === "object" ? error.details : {}),
        // The first failed focus receipt predates Escape. Only the latest native
        // receipt can prove whether recovery injected and released its key.
        ownedInputState: afterEscape, shellOverlayRecoveryAttempted: true,
      });
      const current = await request<"inspect_window", WindowInfo>("inspect_window", {
        target: { windowHandle: expectedWindow.handle, expectedProcessId: expectedWindow.processId, className: expectedWindow.className },
      }, timeoutMs, signal);
      assertActive(signal);
      if (!current || !sameTarget(current, expectedWindow)
        || (action !== "focus_window" && !sameGeometry(current, expectedWindow))) {
        throw new WindowsAutomationError("STALE_OBSERVATION", "Target changed during focus recovery; observe again", { expectedWindow, current });
      }
      const retryTarget: WindowsFocusTarget = {
        ...target,
        // Native focus acquisition can wait: keep checking the original geometry
        // inside that wait boundary, not just in the preceding TS inspection.
        ...(action !== "focus_window" ? { expectedFocusWindow: expectedWindow } : {}),
      };
      retryStarted = true;
      const result = await request<TAction, TResult>(action, {
        ...params, target: retryTarget, inputOwner: owner, expectedInputHost: beforeEscape.hostInstance,
      }, timeoutMs, signal);
      assertActive(signal);
      return result;
    } catch (retryError) {
      assertActive(signal);
      if (retryError instanceof WindowsAutomationError) throw new WindowsAutomationError(retryError.code, retryError.message, {
        ...(retryError.details && typeof retryError.details === "object" ? retryError.details : {}),
        // Inspection cannot inject input; its failure can carry the latest UP
        // receipt. Once replay begins, only the replay's own receipt is valid.
        ...(!retryStarted && afterEscape ? { ownedInputState: afterEscape } : {}),
        shellOverlayRecoveryAttempted: true,
      });
      throw retryError;
    }
  }
}
