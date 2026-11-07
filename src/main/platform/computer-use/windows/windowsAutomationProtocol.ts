/**
 * Windows Automation Host 的线协议（host 子进程 stdin/stdout 的 JSON）。
 *
 * 共享 DTO（WindowInfo / ControlInfo / 错误码 / 错误类）在 `../protocol`；
 * 本文件只保留 host 请求/响应形状，并 re-export 共享 DTO 供 Windows 内部使用。
 */
import type { AutomationErrorCode, ControlSelector, TargetIdentity, WindowInfo } from "../protocol";
import type { WindowsShellOverlay } from "./windowsShellOverlayPolicy";

export * from "../protocol";

/** Internal retry guard, never accepted as model-supplied observation evidence. */
export interface WindowsFocusTarget extends TargetIdentity { expectedFocusWindow?: WindowInfo }
export interface WindowsOwnedInputState { hostInstance: string; owner: string; controls: string[] }

export interface HostRequestMap {
  active_window: Record<string, never>;
  list_windows: Record<string, never>;
  inspect_window: { target: TargetIdentity };
  focus_window: { target: TargetIdentity };
  dismiss_shell_overlay: { target: TargetIdentity; overlay: WindowsShellOverlay; inputOwner: string; expectedInputHost: string };
  release_owned_input: { inputOwner: string; expectedInputHost: string; controls: string[] };
  wait_for_window: {
    target: TargetIdentity;
    state?: "visible" | "foreground" | "closed";
    timeoutMs?: number;
  };
  inspect_controls: { target: TargetIdentity; maxDepth?: number; maxNodes?: number };
  find_control: { target: TargetIdentity; selector: ControlSelector; maxDepth?: number; maxNodes?: number };
  invoke_control: { target: TargetIdentity; selector: ControlSelector; maxDepth?: number; maxNodes?: number };
  set_control_value: { target: TargetIdentity; selector: ControlSelector; value: string; maxDepth?: number; maxNodes?: number };
  move_client: { target: TargetIdentity; x: number; y: number };
  click_client: {
    target: TargetIdentity; x: number; y: number; button?: "left" | "right" | "middle";
    clickCount?: number; modifiers?: number[]; holdMs?: number; background?: boolean;
  };
  mouse_down_client: { target: TargetIdentity; x: number; y: number; button?: "left" | "right" | "middle" };
  mouse_up_client: { target: TargetIdentity; x: number; y: number; button?: "left" | "right" | "middle" };
  drag_client: {
    target: TargetIdentity; x: number; y: number; x2: number; y2: number; button?: "left" | "right" | "middle";
    steps?: number; durationMs?: number;
  };
  drag_screen: { x: number; y: number; x2: number; y2: number; button?: "left" | "right" | "middle"; steps?: number; durationMs?: number };
  scroll_client: { target: TargetIdentity; x?: number; y?: number; deltaX?: number; deltaY?: number; notches?: number };
  mouse_move: { x: number; y: number };
  mouse_click: { x?: number; y?: number; button?: "left" | "right" | "middle" };
  mouse_drag: { x: number; y: number; x2: number; y2: number; button?: "left" | "right" | "middle" };
  scroll: { deltaX?: number; deltaY?: number };
  key_press: { key: string; target?: TargetIdentity };
  key_down: { key: string; target?: TargetIdentity };
  key_up: { key: string; target?: TargetIdentity };
  type_text: { text: string; target?: TargetIdentity };
  capture_window_background: { target: TargetIdentity; path: string };
  shutdown: Record<string, never>;
}

export type HostAction = keyof HostRequestMap;

export interface WindowsAutomationRequest<T extends HostAction = HostAction> {
  id: string;
  action: T;
  params: HostRequestMap[T];
}

export interface AutomationErrorPayload {
  code: AutomationErrorCode;
  message: string;
  details?: unknown;
}

export interface WindowsAutomationResponse<T = unknown> {
  id: string;
  ok: boolean;
  result?: T;
  error?: AutomationErrorPayload;
  inputState?: WindowsOwnedInputState;
}

