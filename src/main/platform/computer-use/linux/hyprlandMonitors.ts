import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ComputerUseError, type Point } from "../protocol";
import { throwIfCancelled } from "./nativeHelpers";

const execFileAsync = promisify(execFile);
export interface LogicalRect { x: number; y: number; width: number; height: number }
export interface HyprlandMonitor {
  id: number; name: string; x: number; y: number;
  /** Native output mode size. Rotated outputs swap these axes in layout space. */
  width: number; height: number; scale: number; transform: number;
  logicalRect: LogicalRect;
  activeWorkspaceId?: number; specialWorkspaceId?: number;
}

export function parseHyprlandMonitors(value: unknown): HyprlandMonitor[] {
  if (!Array.isArray(value)) throw new ComputerUseError("HOST_PROTOCOL_ERROR", "hyprctl monitors 没有返回数组");
  const monitors = value.filter(v => v && typeof v === "object" && !v.disabled).map(v => {
    const { id, name, x, y, width, height, scale, transform } = v as Record<string, unknown>;
    if (typeof name !== "string" || !name || ![id, x, y, width, height, scale, transform].every(n => typeof n === "number" && Number.isFinite(n)) || Number(width) <= 0 || Number(height) <= 0 || Number(scale) <= 0 || !Number.isInteger(transform) || Number(transform) < 0 || Number(transform) > 7) {
      throw new ComputerUseError("HOST_PROTOCOL_ERROR", "输出布局缺少尺寸、缩放或旋转信息；无法安全推测坐标", { monitor: name });
    }
    const rotated = Number(transform) % 2 === 1;
    return {
      id: Number(id), name, x: Number(x), y: Number(y), width: Number(width), height: Number(height), scale: Number(scale), transform: Number(transform),
      logicalRect: { x: Number(x), y: Number(y), width: Math.round((rotated ? Number(height) : Number(width)) / Number(scale)), height: Math.round((rotated ? Number(width) : Number(height)) / Number(scale)) },
      activeWorkspaceId: typeof v.activeWorkspace?.id === "number" ? v.activeWorkspace.id : undefined,
      specialWorkspaceId: typeof v.specialWorkspace?.id === "number" ? v.specialWorkspace.id : undefined,
    } satisfies HyprlandMonitor;
  });
  if (!monitors.length) throw new ComputerUseError("HOST_UNAVAILABLE", "Hyprland 没有可用输出");
  return monitors;
}

export function monitorLayoutId(monitors: readonly HyprlandMonitor[]): string {
  return createHash("sha256").update(JSON.stringify(monitors.map(m => [m.id, m.name, m.x, m.y, m.width, m.height, m.scale, m.transform]).sort((a, b) => String(a[1]).localeCompare(String(b[1]))))).digest("hex").slice(0, 24);
}
export function containsPoint(rect: LogicalRect, point: Point): boolean {
  return point.x >= rect.x && point.y >= rect.y && point.x < rect.x + rect.width && point.y < rect.y + rect.height;
}
export function monitorForPoint(monitors: readonly HyprlandMonitor[], point: Point): HyprlandMonitor {
  const candidates = monitors.filter(m => containsPoint(m.logicalRect, point));
  if (candidates.length !== 1) throw new ComputerUseError("POINT_OUTSIDE_CLIENT", candidates.length ? "输出逻辑区域重叠，点位归属不明确" : "点位不在任何有效输出上", { point });
  return candidates[0];
}
/** Coordinates in the displayed (already rotated/flipped) pixel raster of one named output. Never a global physical desktop. */
export function logicalToOutputPixel(monitor: HyprlandMonitor, point: Point): Point {
  if (!containsPoint(monitor.logicalRect, point)) throw new ComputerUseError("POINT_OUTSIDE_CLIENT", "点位不在指定输出上");
  const result = { x: (point.x - monitor.x) * monitor.scale, y: (point.y - monitor.y) * monitor.scale };
  if (!containsPoint(outputRasterRect(monitor), result)) throw new ComputerUseError("POINT_OUTSIDE_CLIENT", "逻辑点位超出输出实际像素边界");
  return result;
}
function outputRasterRect(monitor: HyprlandMonitor): LogicalRect {
  return { x: 0, y: 0, width: monitor.transform % 2 ? monitor.height : monitor.width, height: monitor.transform % 2 ? monitor.width : monitor.height };
}
export function outputPixelToLogical(monitor: HyprlandMonitor, point: Point): Point {
  if (!containsPoint(outputRasterRect(monitor), point)) throw new ComputerUseError("POINT_OUTSIDE_CLIENT", "物理点位超出输出实际像素边界");
  const result = { x: monitor.x + point.x / monitor.scale, y: monitor.y + point.y / monitor.scale };
  if (!containsPoint(monitor.logicalRect, result)) throw new ComputerUseError("POINT_OUTSIDE_CLIENT", "物理点位不在指定输出上");
  return result;
}
export function monitorForRect(monitors: readonly HyprlandMonitor[], rect: LogicalRect): HyprlandMonitor {
  const matches = monitors.filter(m => rect.width > 0 && rect.height > 0 && rect.x >= m.x && rect.y >= m.y && rect.x + rect.width <= m.x + m.logicalRect.width + 0.001 && rect.y + rect.height <= m.y + m.logicalRect.height + 0.001);
  if (matches.length !== 1) throw new ComputerUseError("CAPTURE_SPANS_MULTIPLE_DISPLAYS", "区域未完全落在一个明确输出上；请指定单个输出或调整窗口");
  return matches[0];
}
export async function readHyprlandMonitors(options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<HyprlandMonitor[]> {
  throwIfCancelled(options.signal);
  const { stdout } = await execFileAsync("hyprctl", ["-j", "monitors"], { encoding: "utf8", timeout: options.timeoutMs ?? 3_000, signal: options.signal, maxBuffer: 4 * 1024 * 1024 });
  return parseHyprlandMonitors(JSON.parse(stdout));
}
