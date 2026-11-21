/**
 * 把本地文件拖到软件外（桌面 / 资源管理器 / 其它应用）。
 */

import type { HTMLAttributes, PointerEvent as ReactPointerEvent } from "react";

export function canNativeDrag(path?: string | null): boolean {
  return Boolean(path?.trim()) && typeof window.api?.startNativeDrag === "function";
}

export function resolveArtifactDragPath(
  artifact: { path?: string; capabilities?: Record<string, unknown> },
): string {
  const direct = artifact.path?.trim();
  if (direct) return direct;
  const disk = artifact.capabilities?.diskPath;
  return typeof disk === "string" ? disk.trim() : "";
}

export function startNativeFileDrag(
  event: { preventDefault: () => void },
  pathOrPaths?: string | string[] | null,
): boolean {
  const files = (Array.isArray(pathOrPaths) ? pathOrPaths : [pathOrPaths ?? ""])
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter(Boolean);
  if (!files.length || typeof window.api?.startNativeDrag !== "function") {
    return false;
  }
  event.preventDefault();
  try {
    window.api.startNativeDrag(files);
    return true;
  } catch {
    return false;
  }
}

/** Windows 鼠标拖动直接交给系统。触屏长按和其他平台继续使用浏览器的 dragstart。 */
export function fileTitleDragProps(path?: string): HTMLAttributes<HTMLElement> {
  if (!path || !canNativeDrag(path)) return {};
  return {
    draggable: true,
    onPointerDown(event) {
      if (window.api?.platform !== "win32") return;
      const mouse = event.pointerType === "mouse";
      event.currentTarget.draggable = !mouse;
      if (mouse && event.isPrimary && event.button === 0) startMouseFileDragOnMove(event, path);
    },
    onDragStart(event) {
      if (!startNativeFileDrag(event, path)) event.preventDefault();
    },
  };
}

function startMouseFileDragOnMove(event: ReactPointerEvent<HTMLElement>, path: string): void {
  const handle: HTMLElement = event.currentTarget;
  if (event.target instanceof Element && event.target.closest("button")) return;
  const { pointerId, clientX, clientY } = event;
  const listeners = new AbortController();
  const options = { signal: listeners.signal };

  function finish(pointer: PointerEvent): void {
    if (pointer.pointerId !== pointerId) return;
    listeners.abort();
    if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
  }

  handle.setPointerCapture(pointerId);
  handle.addEventListener("pointerup", finish, options);
  handle.addEventListener("pointercancel", finish, options);
  handle.addEventListener("lostpointercapture", finish, options);
  handle.addEventListener("pointermove", (move) => {
    if (move.pointerId !== pointerId) return;
    if ((move.buttons & 1) === 0) return finish(move);
    if (Math.max(Math.abs(move.clientX - clientX), Math.abs(move.clientY - clientY)) < 4) return;
    finish(move);
    startNativeFileDrag(move, path);
  }, options);
}
