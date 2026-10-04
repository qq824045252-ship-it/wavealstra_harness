/**
 * 把本地文件拖到软件外（桌面 / 资源管理器 / 其它应用）。
 * Electron 要求在 dragstart 中同步调用 webContents.startDrag。
 */

export function canNativeDrag(path?: string | null): boolean {
  return Boolean(path?.trim()) && typeof window.api?.startNativeDrag === "function";
}

/**
 * 在 onDragStart 中调用：preventDefault 后交给主进程 startDrag。
 * 无有效 path 时返回 false（调用方可取消拖拽）。
 */
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
