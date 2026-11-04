import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ComputerUsePhase } from "../../../capabilities/ComputerUsePolicy";
import { executableInPath } from "../support";

const execFileAsync = promisify(execFile);

/**
 * Linux 上的「Computer Use 正在操作」用户可见反馈。
 *
 * Hyprland 通知独立于自动化驱动，不参与截图、坐标或动作成功判定。
 * 没有实现窗口级高亮；任务停止使用原有运行协调器。
 *
 * 用 `hyprctl notify` 而不是 `notify-send`：
 * - `notify-send` 走 D-Bus org.freedesktop.Notifications，在 Hyprland 上通常由
 *   mako/swaync 承接，用户可能没装、也可能被勿扰模式吞掉；
 * - `hyprctl notify` 是 Hyprland 内建的通知层，无依赖、延迟低（实测 <50ms）。
 * - `hyprctl dismissnotify` **能把用户自己的通知一起关掉**，所以这里从不调用它：
 *   每条通知都靠 `time_ms` 自己过期。
 *
 * 非 Hyprland（GNOME/KDE/niri）上 `hyprctl` 不存在 → 所有方法静默 no-op，
 * 不是错误：这些桌面上我们本来就没有可靠的跨合成器通知通道。
 */

export type HyprctlNotifyRunner = (args: string[]) => Promise<void>;

/** hyprctl notify 的 icon 取值（见 `hyprctl notify --help`）。 */
const ICON = { info: 1, ok: 5, error: 3, hint: 2 } as const;

interface PhasePresentation {
  icon: number;
  /** `rgb(r,g,b)`；Hyprland 的颜色格式。与 Windows overlay 的阶段配色保持一致。 */
  color: string;
  label: string;
  /** 毫秒。`waiting` 会停留、其余短暂出现以免吵到用户。 */
  durationMs: number;
}

export function phasePresentation(phase: ComputerUsePhase): PhasePresentation {
  switch (phase) {
    case "observing": return { icon: ICON.info, color: "rgb(91,141,255)", label: "观察界面", durationMs: 3_000 };
    case "acting": return { icon: ICON.info, color: "rgb(91,141,255)", label: "正在操作", durationMs: 4_000 };
    case "verifying": return { icon: ICON.ok, color: "rgb(43,178,132)", label: "验证结果", durationMs: 3_000 };
    case "waiting": return { icon: ICON.hint, color: "rgb(112,91,255)", label: "等待下一步", durationMs: 5_000 };
    case "recovering": return { icon: ICON.hint, color: "rgb(240,174,61)", label: "重新定位", durationMs: 4_000 };
    case "completed": return { icon: ICON.ok, color: "rgb(43,178,132)", label: "操作完成", durationMs: 2_500 };
    case "failed": return { icon: ICON.error, color: "rgb(232,85,85)", label: "操作受阻", durationMs: 5_000 };
  }
}

/** 通知正文：`MyBuddy · 正在操作 · <目标>`。目标太长会截断，通知栏放不下。 */
export function noticeMessage(phase: ComputerUsePhase, target?: string): string {
  const head = `MyBuddy · ${phasePresentation(phase).label}`;
  const trimmed = target?.trim();
  if (!trimmed) return head;
  const max = 48;
  const label = trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
  return `${head} · ${label}`;
}

export function createHyprctlNotifyRunner(timeoutMs = 2_000): HyprctlNotifyRunner {
  return async (args) => {
    // notify 是 fire-and-forget：hyprctl 打印 "ok" 就退了。失败也不该打断 Computer Use，
    // 所以这里把「hyprctl 不存在」当 no-op，把其它错误吞掉（调用方还会 catch 一层）。
    const { stdout } = await execFileAsync("hyprctl", args, { encoding: "utf8", timeout: timeoutMs });
    void stdout;
  };
}

export interface ActivityNotice {
  /** 显示一条阶段通知。不可用平台/缺 hyprctl 时静默 no-op。 */
  show(phase: ComputerUsePhase, target?: string): void;
  /** 是否真的能显示（供 status/诊断用）。 */
  readonly available: boolean;
}

interface ActivityNoticeOptions {
  runner?: HyprctlNotifyRunner;
  /** 显式关闭时所有 show() 变成 no-op（单测断言「不发通知」用）。 */
  available?: boolean;
}

export function createActivityNotice(options: ActivityNoticeOptions = {}): ActivityNotice {
  const runner = options.runner ?? createHyprctlNotifyRunner();
  // 静态依赖和会话缺失时不承诺可见反馈；执行失败只影响通知能力。
  let available = options.available ?? Boolean(options.runner || (executableInPath("hyprctl") && process.env.HYPRLAND_INSTANCE_SIGNATURE));
  return {
    get available(): boolean {
      return available;
    },
    show(phase, target) {
      if (!available) return;
      const presentation = phasePresentation(phase);
      // 不要 await：通知只是反馈，绝不能因为它失败/变慢就阻塞自动化动作。
      void runner([
        "notify", String(presentation.icon), String(presentation.durationMs),
        presentation.color, noticeMessage(phase, target),
      ]).catch(() => { available = false; });
    },
  };
}
