import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ComputerUseError, type ComputerExecOutput } from "../protocol";
import { executableInPath } from "../support";
import { monitorForRect, type LogicalRect } from "./hyprlandMonitors";
import type { HyprlandSnapshot, LinuxWindowInfo } from "./hyprlandWindows";
import { errorText, throwIfCancelled } from "./nativeHelpers";
const execFileAsync = promisify(execFile);

export interface LinuxScreenshotRequest {
  snapshot: HyprlandSnapshot; window?: LinuxWindowInfo; screenId?: string; signal?: AbortSignal;
}
export interface LinuxScreenshotProvider {
  probe(): Promise<{ available: boolean; verified: boolean; checkedAt: number; reason?: string }>;
  capture(request: LinuxScreenshotRequest): Promise<Pick<ComputerExecOutput, "screenshot" | "screenshotMimeType" | "imageScale" | "imageSize"> & { captureRegion: LogicalRect; coordinateSpace: "hyprland-logical"; outputName?: string }>;
}
export type GrimRunner = (args: string[], signal?: AbortSignal) => Promise<Buffer>;
export function createGrimScreenshotProvider(options: { runner?: GrimRunner; available?: () => boolean } = {}): LinuxScreenshotProvider {
  let verifiedAt: number | undefined;
  const available = () => options.available?.() ?? Boolean(options.runner || executableInPath("grim"));
  const runner: GrimRunner = options.runner ?? (async (args, signal) => {
    const { stdout } = await execFileAsync("grim", args, { encoding: "buffer", signal, timeout: 10_000, maxBuffer: 128 * 1024 * 1024 });
    return stdout;
  });
  return {
    probe: async () => ({ available: available(), verified: Boolean(verifiedAt), checkedAt: verifiedAt ?? Date.now(), reason: available() ? verifiedAt ? undefined : "grim 存在；截图仅在明确请求时验证" : "找不到可选截图程序 grim" }),
    capture: async ({ snapshot, window, screenId, signal }) => {
      verifiedAt = undefined;
      throwIfCancelled(signal);
      if (!available()) throw new ComputerUseError("CAPTURE_FAILED", "截图程序 grim 不可用；不影响无障碍与输入能力");
      let region: LogicalRect; let outputName: string | undefined;
      if (window) {
        region = { ...window.clientOrigin, width: window.clientRect.width, height: window.clientRect.height };
        outputName = monitorForRect(snapshot.monitors, region).name;
      } else if (screenId) {
        const output = snapshot.monitors.find(m => m.name === screenId || String(m.id) === screenId);
        if (!output) throw new ComputerUseError("CAPTURE_FAILED", "指定输出不存在", { screenId });
        region = output.logicalRect; outputName = output.name;
      } else {
        const left = Math.min(...snapshot.monitors.map(m => m.x)); const top = Math.min(...snapshot.monitors.map(m => m.y));
        region = { x: left, y: top, width: Math.max(...snapshot.monitors.map(m => m.x + m.logicalRect.width)) - left, height: Math.max(...snapshot.monitors.map(m => m.y + m.logicalRect.height)) - top };
      }
      // grim accepts compositor logical geometry. Force a known raster scale so mixed-output scale never becomes a guessed global conversion.
      region = { x: Math.floor(region.x), y: Math.floor(region.y), width: Math.ceil(region.x + region.width) - Math.floor(region.x), height: Math.ceil(region.y + region.height) - Math.floor(region.y) };
      const args = ["-g", `${region.x},${region.y} ${region.width}x${region.height}`, "-s", "1", "-t", "png", ...(outputName ? ["-o", outputName] : []), "-"];
      let bytes: Buffer;
      try { bytes = await runner(args, signal); } catch (error) { throw new ComputerUseError(signal?.aborted ? "REQUEST_CANCELLED" : "CAPTURE_FAILED", `grim 截图失败：${errorText(error)}`); }
      if (bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new ComputerUseError("CAPTURE_FAILED", "grim 未返回有效 PNG 图像");
      const width = bytes.readUInt32BE(16); const height = bytes.readUInt32BE(20);
      if (!width || !height || Math.abs(width - region.width) > 1 || Math.abs(height - region.height) > 1) throw new ComputerUseError("CAPTURE_FAILED", "截图实际尺寸与请求的逻辑区域不符", { width, height, region });
      verifiedAt = Date.now();
      return { screenshot: bytes, screenshotMimeType: "image/png", imageScale: region.width / width, imageSize: { width, height }, captureRegion: region, coordinateSpace: "hyprland-logical", outputName };
    },
  };
}
