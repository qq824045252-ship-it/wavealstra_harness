import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ComputerUseError, type Point, type WindowInfo } from "../protocol";
import { abortableDelay, errorText, finiteNumber, sameWindowIdentity, throwIfCancelled } from "./nativeHelpers";
import { HyprlandEvents, type HyprlandEventSource } from "./hyprlandEvents";
import { monitorLayoutId, parseHyprlandMonitors, type HyprlandMonitor } from "./hyprlandMonitors";

const execFileAsync = promisify(execFile);
export type HyprctlRunner = (args: string[], signal?: AbortSignal) => Promise<string>;
export function createHyprctlRunner(timeoutMs = 5_000): HyprctlRunner {
  return async (args, signal) => {
    throwIfCancelled(signal);
    try {
      const { stdout } = await execFileAsync("hyprctl", args, { encoding: "utf8", timeout: timeoutMs, signal, maxBuffer: 4 * 1024 * 1024 });
      return stdout;
    } catch (error) {
      const cancelled = signal?.aborted;
      throw new ComputerUseError(cancelled ? "REQUEST_CANCELLED" : "HOST_UNAVAILABLE", `Hyprland IPC ${cancelled ? "已取消" : "失败"}：${errorText(error)}`, { args, executionUnknown: args[0] === "dispatch" || args[0] === "repl" || args[0] === "eval" });
    }
  };
}

/** Handles are opaque compositor strings. Never pass them through Number/BigInt or PID conversion. */
export function hyprlandAddressFromHandle(handle: string): string | undefined {
  return typeof handle === "string" && /^0x[0-9a-f]+$/i.test(handle) && !/^0x0+$/i.test(handle) ? handle.toLowerCase() : undefined;
}
function addressOrThrow(handle: string): string {
  const address = hyprlandAddressFromHandle(handle);
  if (!address) throw new ComputerUseError("HOST_PROTOCOL_ERROR", "需要 Hyprland 返回的 0x… 字符串窗口句柄", { handle });
  return address;
}
export interface LinuxWindowInfo extends WindowInfo {
  coordinateSpace: "hyprland-logical"; layoutId: string; observedAt: number;
  identity: string; geometryReliable: boolean; xwayland: boolean;
  workspaceId?: number; floating?: boolean; stableId?: string; acceptsInput?: boolean;
}
export interface HyprlandSnapshot {
  windows: LinuxWindowInfo[]; activeHandle?: string; monitors: HyprlandMonitor[]; layoutId: string; observedAt: number;
}
export function windowGeometryIdentity(window: WindowInfo): string {
  const w = window as Partial<LinuxWindowInfo>;
  return JSON.stringify([window.handle, window.identityToken, window.processId, window.className, w.xwayland, w.layoutId, window.clientOrigin.x, window.clientOrigin.y, window.clientRect.width, window.clientRect.height]);
}
function parseJson(raw: string, command: string): unknown {
  try { return JSON.parse(raw); } catch { throw new ComputerUseError("HOST_PROTOCOL_ERROR", `hyprctl ${command} 返回了无效 JSON`, { response: raw.slice(0, 200) }); }
}
export function parseHyprlandWindows(value: unknown, monitors: HyprlandMonitor[], activeHandle?: string, observedAt = Date.now()): LinuxWindowInfo[] {
  if (!Array.isArray(value)) throw new ComputerUseError("HOST_PROTOCOL_ERROR", "hyprctl clients 没有返回数组");
  const layoutId = monitorLayoutId(monitors);
  return value.filter(v => v && typeof v === "object" && v.mapped !== false).map(v => {
    const handle = hyprlandAddressFromHandle(v.address);
    const xy = v.at; const wh = v.size;
    if (!handle || !Number.isInteger(v.pid) || v.pid <= 0 || !Array.isArray(xy) || xy.length < 2 || !Array.isArray(wh) || wh.length < 2 || ![...xy.slice(0, 2), ...wh.slice(0, 2)].every(n => typeof n === "number" && Number.isFinite(n)) || wh[0] <= 0 || wh[1] <= 0 || typeof v.xwayland !== "boolean") {
      throw new ComputerUseError("HOST_PROTOCOL_ERROR", "Hyprland 窗口缺少可信的句柄、进程或坐标信息", { handle: v.address });
    }
    const output = monitors.find(m => m.id === v.monitor);
    const workspaceId = typeof v.workspace?.id === "number" ? v.workspace.id : undefined;
    const visibleWorkspace = Boolean(output && (v.pinned || workspaceId === output.activeWorkspaceId || workspaceId === output.specialWorkspaceId));
    const window: LinuxWindowInfo = {
      handle, processId: v.pid, processName: typeof v.class === "string" ? v.class : undefined,
      title: typeof v.title === "string" ? v.title : "", className: typeof v.class === "string" ? v.class : "",
      visible: v.visible !== false && !v.hidden && visibleWorkspace, minimized: Boolean(v.hidden), foreground: handle === activeHandle,
      windowRect: { left: xy[0], top: xy[1], right: xy[0] + wh[0], bottom: xy[1] + wh[1], width: wh[0], height: wh[1] },
      clientRect: { x: 0, y: 0, width: wh[0], height: wh[1] }, clientOrigin: { x: xy[0], y: xy[1] },
      dpi: output ? 96 * output.scale : 96, scaleFactor: output?.scale ?? 1,
      monitorHandle: output?.name, monitorRect: output ? { left: output.x, top: output.y, right: output.x + output.logicalRect.width, bottom: output.y + output.logicalRect.height, width: output.logicalRect.width, height: output.logicalRect.height } : undefined,
      coordinateSpace: "hyprland-logical", layoutId, observedAt, clientGeometryVerified: Boolean(output), identity: "", geometryReliable: Boolean(output), xwayland: v.xwayland, workspaceId, floating: Boolean(v.floating), stableId: typeof v.stableId === "string" && /^(?:0x)?[0-9a-f]+$/i.test(v.stableId) ? v.stableId.toLowerCase() : undefined, acceptsInput: typeof v.acceptsInput === "boolean" ? v.acceptsInput : undefined,
    };
    window.identity = windowGeometryIdentity(window);
    return window;
  });
}

export interface HyprlandDesktop {
  snapshot(signal?: AbortSignal): Promise<HyprlandSnapshot>;
  activeHandle(signal?: AbortSignal): Promise<string | undefined>;
  cursor(signal?: AbortSignal): Promise<Point>;
  focus(window: WindowInfo, signal?: AbortSignal): Promise<WindowInfo>;
  movePointer(point: Point, signal?: AbortSignal): Promise<Point>;
  shutdown?(): Promise<void>;
}
export const HYPRLAND_LUA_CAPABILITY_PROBE = 'return type(hl.get_windows) == "function" and type(hl.dispatch) == "function" and type(hl.dsp) == "table" and type(hl.dsp.focus) == "function" and type(hl.dsp.cursor) == "table" and type(hl.dsp.cursor.move) == "function" and type(hl.dsp.window.move) == "function" and type(hl.dsp.window.resize) == "function" and "wavealstra-lua-1" or "unsupported"';
export function buildFocusScript(handle: string): string {
  return `${findWindowLua(handle)}\nhl.dispatch(hl.dsp.focus({window = target}))\nreturn "focused"`;
}
export function buildCursorMoveScript(point: Point): string {
  return `hl.dispatch(hl.dsp.cursor.move({x = ${Math.floor(finiteNumber(point.x, "x"))}, y = ${Math.floor(finiteNumber(point.y, "y"))}}))\nreturn "moved"`;
}
export function createHyprlandDesktop(runner: HyprctlRunner = createHyprctlRunner(), options: { events?: HyprlandEventSource; onDisconnect?: (error: ComputerUseError) => void } = {}): HyprlandDesktop {
  const events = options.events ?? new HyprlandEvents({ onDisconnect: options.onDisconnect });
  let probed = false;
  const probe = async (signal?: AbortSignal) => {
    if (probed && events.connected) return;
    await events.connect(); throwIfCancelled(signal);
    const [version, capabilities] = await Promise.all([runner(["-j", "version"], signal), runner(["repl", HYPRLAND_LUA_CAPABILITY_PROBE], signal)]);
    const metadata = parseJson(version, "version") as Record<string, unknown>;
    if (capabilities.trim() !== "wavealstra-lua-1") throw new ComputerUseError("HOST_UNAVAILABLE", "当前 Hyprland 未提供所需 Lua 焦点、光标和窗口接口（目标版本 0.56.2）；请切换支持的 Lua 配置", { version: metadata.tag ?? metadata.commit, capabilities: capabilities.slice(0, 256) });
    probed = true;
  };
  const activeHandle = async (signal?: AbortSignal): Promise<string | undefined> => {
    const result = parseJson(await runner(["-j", "activewindow"], signal), "activewindow") as Record<string, unknown>;
    if (!result || typeof result !== "object") throw new ComputerUseError("HOST_PROTOCOL_ERROR", "无法读取活动窗口");
    if (Object.keys(result).length === 0 || result.address === "0x0") return undefined;
    const address = typeof result.address === "string" ? hyprlandAddressFromHandle(result.address) : undefined;
    if (!address) throw new ComputerUseError("HOST_PROTOCOL_ERROR", "活动窗口句柄无效");
    return address;
  };
  const snapshot = async (signal?: AbortSignal): Promise<HyprlandSnapshot> => {
    throwIfCancelled(signal); await probe(signal);
    for (let attempt = 0; attempt < 3; attempt++) {
      const revision = events.revision;
      const [monitorResult, clientsResult, active] = await Promise.all([runner(["-j", "monitors"], signal), runner(["-j", "clients"], signal), activeHandle(signal)]);
      if (!events.connected) throw new ComputerUseError("HOST_UNAVAILABLE", "Hyprland 生命周期事件连接丢失，不能使用此次窗口观察");
      if (revision !== events.revision) continue;
      const monitors = parseHyprlandMonitors(parseJson(monitorResult, "monitors"));
      const observedAt = Date.now(); const layoutId = monitorLayoutId(monitors);
      const windows = parseHyprlandWindows(parseJson(clientsResult, "clients"), monitors, active, observedAt);
      for (const window of windows) {
        const eventIdentity = events.identity(window.handle);
        // The compositor stableId detects reuse even before the matching socket2
        // close/open event is delivered; the event epoch rejects reconnects.
        window.identityToken = eventIdentity && window.stableId ? `${eventIdentity}:stable:${window.stableId}` : undefined;
        window.identity = windowGeometryIdentity(window);
      }
      return { monitors, observedAt, layoutId, activeHandle: active, windows };
    }
    throw new ComputerUseError("STALE_OBSERVATION", "Hyprland 窗口或输出在观察期间持续变化，请等待稳定后重新观察");
  };
  const cursor = async (signal?: AbortSignal): Promise<Point> => {
    const value = parseJson(await runner(["-j", "cursorpos"], signal), "cursorpos") as Record<string, unknown>;
    return { x: finiteNumber(value?.x, "cursor.x"), y: finiteNumber(value?.y, "cursor.y") };
  };
  const dispatch = async (code: string, expected: string, signal?: AbortSignal): Promise<void> => {
    throwIfCancelled(signal); await probe(signal);
    const result = (await runner(["repl", code], signal)).trim();
    if (result === "missing") throw new ComputerUseError("WINDOW_NOT_FOUND", "Hyprland 目标窗口已关闭");
    if (result !== expected) throw new ComputerUseError("HOST_PROTOCOL_ERROR", "Hyprland Lua 操作未获得确认", { response: result, executed: "unknown" });
  };
  return {
    snapshot, activeHandle, cursor, shutdown: () => events.shutdown(),
    focus: async (window, signal) => {
      // Re-read immediately before using the exact address, including its lifetime token.
      const before = await snapshot(signal); const current = before.windows.find(w => w.handle === window.handle);
      if (!current || !sameWindowIdentity(window, current)) throw new ComputerUseError("TARGET_CHANGED", "聚焦前目标窗口已关闭或重建");
      await dispatch(buildFocusScript(window.handle), "focused", signal);
      const deadline = Date.now() + 1_000;
      do {
        const fresh = await snapshot(signal);
        const target = fresh.windows.find(w => w.handle === window.handle);
        if (!target || !sameWindowIdentity(window, target)) throw new ComputerUseError("TARGET_CHANGED", "聚焦后窗口已关闭或身份改变", { executed: true });
        if (fresh.activeHandle === target.handle && target.visible) return target;
        await abortableDelay(30, signal);
      } while (Date.now() < deadline);
      throw new ComputerUseError("FOCUS_FAILED", "合成器未将目标窗口置于前台", { executed: true });
    },
    movePointer: async (point, signal) => {
      const requested = { x: Math.floor(finiteNumber(point.x, "x")), y: Math.floor(finiteNumber(point.y, "y")) };
      await dispatch(buildCursorMoveScript(requested), "moved", signal);
      const actual = await cursor(signal);
      if (Math.abs(actual.x - requested.x) > 1 || Math.abs(actual.y - requested.y) > 1) throw new ComputerUseError("HOST_PROTOCOL_ERROR", "光标实际位置与请求不符，后续按键未下发", { requested, actual, executed: true });
      return actual;
    },
  };
}

const findWindowLua = (address: string) => `local target = nil\nfor _, w in ipairs(hl.get_windows()) do\n  if string.lower(tostring(w.address)) == "${addressOrThrow(address)}" then target = w end\nend\nif target == nil then return "missing" end`;
export function buildMoveScript(address: string, x: number, y: number): string {
  return `${findWindowLua(address)}\nif not target.floating then hl.dispatch(hl.dsp.window.float({window = target, action = "set"})) end\nhl.dispatch(hl.dsp.window.move({window = target, x = ${Math.round(finiteNumber(x, "windowX"))}, y = ${Math.round(finiteNumber(y, "windowY"))}}))\nreturn "moved"`;
}
export function buildResizeScript(address: string, width: number, height: number): string {
  finiteNumber(width, "windowWidth"); finiteNumber(height, "windowHeight");
  if (width < 1 || height < 1) throw new ComputerUseError("HOST_PROTOCOL_ERROR", "窗口宽高必须大于零");
  return `${findWindowLua(address)}\nif not target.floating then hl.dispatch(hl.dsp.window.float({window = target, action = "set"})) end\nhl.dispatch(hl.dsp.window.resize({window = target, x = ${Math.round(width)}, y = ${Math.round(height)}}))\nreturn "resized"`;
}
export interface HyprlandWindowRect { x: number; y: number; width: number; height: number; floating: boolean }
export function buildReadGeometryScript(address: string): string {
  return `${findWindowLua(address)}\nreturn tostring(target.at.x) .. "," .. tostring(target.at.y) .. "," .. tostring(target.size.x) .. "," .. tostring(target.size.y) .. "," .. tostring(target.floating)`;
}
export function parseGeometry(raw: string): HyprlandWindowRect | undefined {
  const parts = raw.trim().split(",");
  if (parts.length !== 5 || !/^(true|false)$/.test(parts[4].trim())) return undefined;
  const [x, y, width, height] = parts.slice(0, 4).map(Number);
  return [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0 ? { x, y, width, height, floating: parts[4].trim() === "true" } : undefined;
}
export interface HyprlandWindowControl {
  move(handle: string, x: number, y: number, signal?: AbortSignal): Promise<HyprlandWindowRect | undefined>;
  resize(handle: string, width: number, height: number, signal?: AbortSignal): Promise<HyprlandWindowRect | undefined>;
  geometry(handle: string, signal?: AbortSignal): Promise<HyprlandWindowRect | undefined>;
}
export function createHyprlandWindowControl(runner: HyprctlRunner = createHyprctlRunner()): HyprlandWindowControl {
  const geometry = async (handle: string, signal?: AbortSignal) => parseGeometry(await runner(["repl", buildReadGeometryScript(addressOrThrow(handle))], signal));
  const apply = async (handle: string, script: string, signal?: AbortSignal) => {
    throwIfCancelled(signal);
    const response = (await runner(["repl", script], signal)).trim();
    if (response === "missing") throw new ComputerUseError("WINDOW_NOT_FOUND", "Hyprland 目标窗口已关闭");
    if (!/^(moved|resized)$/.test(response)) throw new ComputerUseError("HOST_PROTOCOL_ERROR", "窗口操作没有获得 Hyprland 确认", { response, executionUnknown: true });
    return geometry(handle, signal).catch(() => undefined);
  };
  return { geometry, move: (h, x, y, s) => apply(h, buildMoveScript(h, x, y), s), resize: (h, w, hgt, s) => apply(h, buildResizeScript(h, w, hgt), s) };
}
