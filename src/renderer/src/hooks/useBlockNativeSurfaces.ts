import { useId, useLayoutEffect } from "react";

/** 与 NativeSurfaceCoordinator / HtmlArtifactView 的主 surface 对齐 */
const SURFACE_MAIN = "artifact-main";
/**
 * 与原生 WebContentsView 重叠的 DOM 弹层/菜单必须持有 blocker。
 * Electron 的 artifact/browser 视图叠在 renderer 之上，CSS z-index 管不到。
 *
 * 每个调用实例拥有独立 blocker token：不能让多个 overlay 共享 "modal"，否则
 * 任一 overlay 先卸载都会把另一个 overlay 的 blocker 一并解除。useLayoutEffect
 * 让 blocker 在浏览器绘制 DOM 弹层前尽早登记，避免设置页打开瞬间闪出 WCV。
 */
export function useBlockNativeSurfaces(active: boolean): void {
  const ownerId = useId();
  const token = `renderer-overlay:${ownerId}`;

  useLayoutEffect(() => {
    if (!active) return;
    const artifact = window.api?.artifact?.surface;
    const browser = window.api?.browser;
    artifact?.addBlocker(SURFACE_MAIN, token);
    browser?.addBlocker?.(token);
    return () => {
      artifact?.removeBlocker(SURFACE_MAIN, token);
      browser?.removeBlocker?.(token);
    };
  }, [active, token]);
}
