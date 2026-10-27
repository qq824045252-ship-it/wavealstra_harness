/**
 * 输入/快捷键平台差异（platform/input）。
 *
 * 迁自 capabilities/UiAutomationService.ts 的 `process.platform === "darwin" ? "meta" : "control"`
 * （Electron sendInputEvent 的修饰键：macOS 用 Command，其余用 Control）。
 */
import { currentPlatformId, type PlatformId } from "./index";

export type SelectAllModifier = "meta" | "control";

/** 「全选」修饰键：macOS = meta(Command)，Windows/Linux = control。 */
export function selectAllModifier(platform: PlatformId = currentPlatformId): SelectAllModifier {
  return platform === "macos" ? "meta" : "control";
}
