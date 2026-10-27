/**
 * 系统托盘的平台行为。
 *
 * 把「图标格式 / 缩放 / 日志标签 / 关窗提示策略 / 托盘失败是否仍驻留」收拢成数据，
 * `TrayService` 只读 behavior，不再出现 `process.platform`。
 */
// electron-vite 会把该资源 emit 到 out/main/assets 下并返回正确路径（打包后在 asar 内也可读）
import trayIcoPath from "../../assets/tray.ico?asset";
import trayPngPath from "../../assets/tray.png?asset";
import { currentPlatformId, type PlatformId } from "../index";

/** 首次隐藏到托盘时的提示策略：Windows 气泡 / Linux 桌面通知 / macOS 不提示。 */
export type TrayHideHintStrategy = "balloon" | "notification" | "none";

export interface PlatformTrayBehavior {
  platform: PlatformId;
  /** 托盘图标资源路径（?asset 解析后的绝对路径）。 */
  iconAsset: string;
  /** 图标格式：Windows/macOS 用 ico，Linux StatusNotifier 需要 PNG。 */
  iconFormat: "ico" | "png";
  /** 图标超过 32px 时缩放到该边长（Linux 22px）。 */
  scaleToPx?: number;
  /** 托盘 tooltip / 通知标签。 */
  initialLabel: string;
  /** 首次隐藏到托盘时的提示策略。 */
  hideHint: TrayHideHintStrategy;
  /** Electron `Tray.displayBalloon` 是否可用。 */
  supportsBalloon: boolean;
  /** 托盘创建失败时是否仍驻留主进程（Linux：避免误杀提醒 / cron / Gateway）。 */
  degradedResidency: boolean;
}

type TrayBehaviorDefaults = Omit<PlatformTrayBehavior, "platform">;

const TRAY_BEHAVIORS: Record<PlatformId, TrayBehaviorDefaults> = {
  windows: {
    iconAsset: trayIcoPath,
    iconFormat: "ico",
    initialLabel: "MyBuddy",
    hideHint: "balloon",
    supportsBalloon: true,
    degradedResidency: false,
  },
  linux: {
    iconAsset: trayPngPath,
    iconFormat: "png",
    scaleToPx: 22,
    initialLabel: "MyBuddy",
    hideHint: "notification",
    supportsBalloon: false,
    degradedResidency: true,
  },
  macos: {
    iconAsset: trayIcoPath,
    iconFormat: "ico",
    initialLabel: "MyBuddy",
    hideHint: "none",
    supportsBalloon: false,
    degradedResidency: false,
  },
};

/** 解析指定平台（默认当前平台）的托盘行为。 */
export function resolveTrayPlatformBehavior(platform: PlatformId = currentPlatformId): PlatformTrayBehavior {
  return { platform, ...TRAY_BEHAVIORS[platform] };
}

/** 托盘图标资源路径（测试用；运行期走 resolveTrayPlatformBehavior().iconAsset）。 */
export function trayIconAsset(platform: PlatformId = currentPlatformId): string {
  return resolveTrayPlatformBehavior(platform).iconAsset;
}
