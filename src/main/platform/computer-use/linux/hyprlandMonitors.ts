import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseMonitors, type CulMonitor } from "./culProtocol";

const execFileAsync = promisify(execFile);

/**
 * 读取 Hyprland 的显示器布局（`hyprctl -j monitors`）。
 *
 * 用途只有一个：把「物理像素」换算成 DIP 时需要每块屏的 scale。CUL 自己已经通过
 * hyprctl 拿窗口，这里额外读一次 monitors 是为了给协议里的 DIP 坐标提供缩放，
 * 不参与窗口枚举。
 *
 * 非 Hyprland（GNOME/KDE/niri）或没装 hyprctl 时返回空数组，调用方按 scale=1
 * 处理（DIP 等于物理像素）——这是可诊断的降级，不是静默错误。
 */
export async function readHyprlandMonitors(options: { timeoutMs?: number } = {}): Promise<CulMonitor[]> {
  try {
    const { stdout } = await execFileAsync("hyprctl", ["-j", "monitors"], {
      encoding: "utf8",
      timeout: options.timeoutMs ?? 3_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return parseMonitors(JSON.parse(stdout));
  } catch {
    return [];
  }
}
