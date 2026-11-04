import type { ComputerExecInput, ControlInfo, ControlSelector, Point, WindowInfo } from "../protocol";
import { ComputerUseError } from "../protocol";

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ComputerUseError("REQUEST_CANCELLED", "操作已取消；未继续下发输入");
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfCancelled(signal);
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new ComputerUseError("REQUEST_CANCELLED", "等待期间操作被取消")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ComputerUseError("HOST_PROTOCOL_ERROR", `${name} 必须是有限数字`);
  return value;
}

export function boundedNumber(value: number | undefined, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  finiteNumber(value, name);
  if (value < min || value > max) throw new ComputerUseError("HOST_PROTOCOL_ERROR", `${name} 必须在 ${min}–${max} 之间`);
  return value;
}

export function filterWindows<T extends WindowInfo>(windows: T[], input: Pick<ComputerExecInput, "windowTitle" | "className" | "processName" | "processId">): T[] {
  const title = input.windowTitle?.trim().toLocaleLowerCase();
  const name = input.processName?.trim().toLocaleLowerCase();
  return windows.filter(w => (!title || w.title.toLocaleLowerCase().includes(title)) && (!input.className || w.className === input.className) && (!name || w.processName?.toLocaleLowerCase().includes(name)) && (input.processId === undefined || w.processId === input.processId));
}

export function matchesSelector(control: ControlInfo, selector: ControlSelector): boolean {
  return (!selector.controlRuntimeId || control.runtimeId === selector.controlRuntimeId)
    && (!selector.automationId || control.automationId === selector.automationId)
    && (!selector.controlType || control.controlType.toLocaleLowerCase() === selector.controlType.toLocaleLowerCase())
    && (!selector.controlClassName || control.className?.toLocaleLowerCase() === selector.controlClassName.toLocaleLowerCase())
    && (!selector.controlName || (selector.exactName ? control.name === selector.controlName : (control.name ?? "").toLocaleLowerCase().includes(selector.controlName.toLocaleLowerCase())));
}

export function hasControlSelector(input: ControlSelector): boolean {
  return Boolean(input.controlRuntimeId || input.controlName || input.automationId || input.controlType || input.controlClassName);
}

export function hasWindowSelector(input: ComputerExecInput): boolean {
  return Boolean(input.windowHandle || input.windowTitle || input.className || input.processName || input.processId !== undefined || input.observationId || input.appSessionId);
}

export function sameWindowIdentity(a: WindowInfo, b: WindowInfo): boolean {
  return a.handle === b.handle && a.processId === b.processId && a.className === b.className && a.identityToken === b.identityToken;
}

export function clientDipToLogical(window: WindowInfo, x: number, y: number): Point {
  finiteNumber(x, "x"); finiteNumber(y, "y");
  const info = window as WindowInfo & { coordinateSpace?: string; geometryReliable?: boolean };
  if (info.coordinateSpace !== "hyprland-logical" || info.geometryReliable === false || info.clientGeometryVerified !== true) throw new ComputerUseError("HOST_PROTOCOL_ERROR", "窗口未提供可信的 Hyprland 客户区逻辑坐标");
  if (x < 0 || y < 0 || x >= window.clientRect.width || y >= window.clientRect.height) throw new ComputerUseError("POINT_OUTSIDE_CLIENT", "点位超出当前客户区", { x, y, width: window.clientRect.width, height: window.clientRect.height });
  return { x: window.clientOrigin.x + x, y: window.clientOrigin.y + y };
}

const KEY_ALIASES: Record<string, string> = {
  CTRL: "Ctrl", CONTROL: "Ctrl", CONTROLKEY: "Ctrl", SHIFT: "Shift", SHIFTKEY: "Shift", ALT: "Alt", ALTGR: "AltGr",
  WIN: "Super", LWIN: "Super", RWIN: "Super", META: "Super", SUPER: "Super", CMD: "Super", COMMAND: "Super",
  ENTER: "Return", RETURN: "Return", ESC: "Escape", ESCAPE: "Escape", TAB: "Tab", BACKSPACE: "BackSpace", DELETE: "Delete", DEL: "Delete", SPACE: "space",
  HOME: "Home", END: "End", PAGEUP: "Page_Up", PAGEDOWN: "Page_Down", UP: "Up", DOWN: "Down", LEFT: "Left", RIGHT: "Right",
  INSERT: "Insert", INS: "Insert", PRINTSCREEN: "Print", PRTSC: "Print", CAPSLOCK: "Caps_Lock", NUMLOCK: "Num_Lock", SCROLLLOCK: "Scroll_Lock",
  APPS: "Menu", CONTEXTMENU: "Menu", MENU: "Alt", PAUSE: "Pause", MEDIAPLAYPAUSE: "XF86AudioPlay", MEDIASTOP: "XF86AudioStop",
  MEDIANEXT: "XF86AudioNext", MEDIAPREV: "XF86AudioPrev", VOLUMEUP: "XF86AudioRaiseVolume", VOLUMEDOWN: "XF86AudioLowerVolume", VOLUMEMUTE: "XF86AudioMute",
};
export function normalizeKey(key: string): string {
  if (!key.trim()) throw new ComputerUseError("HOST_PROTOCOL_ERROR", "key 不能为空");
  return key.split("+").map(part => {
    const token = part.trim(); const upper = token.toUpperCase();
    if (KEY_ALIASES[upper]) return KEY_ALIASES[upper];
    if (/^ARROW(UP|DOWN|LEFT|RIGHT)$/.test(upper)) return upper.slice(5);
    if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(upper) || token.length === 1) return token;
    if (/^[A-Z][A-Z0-9_ -]{0,23}$/i.test(token)) return token;
    throw new ComputerUseError("HOST_PROTOCOL_ERROR", `不支持的按键：${token}`);
  }).join("+");
}

export function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
