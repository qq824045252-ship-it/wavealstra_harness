/**
 * 兼容薄层：屏幕叠加层是 Windows 专属实现，已迁到
 * `src/main/platform/computer-use/windows/overlay.ts`。
 *
 * 业务/入口可继续从这里 import；Linux/macOS 上 `isSupported=false`，所有方法 no-op。
 */
export {
  ComputerUseOverlayService,
  computerUseOverlayService,
} from "../platform/computer-use/windows/overlay";
