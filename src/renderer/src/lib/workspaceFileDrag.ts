/**
 * 工作空间文件拖拽：系统级 startDrag 与同窗口落点共用一份路径。
 * startDrag 会取消 HTML5 dataTransfer，侧栏/输入框改读这份会话或 Files。
 */

export const WORKSPACE_FILE_DRAG_TYPE = "application/x-mybuddy-workspace-file";

const TASK_DRAG_TYPE = "application/x-mybuddy-task";

let dragSession: { paths: string[] } | null = null;

export function beginWorkspaceFileDrag(paths: string[]): void {
  const clean = paths.map((p) => p.trim()).filter(Boolean);
  dragSession = clean.length ? { paths: clean } : null;
}

export function peekWorkspaceFileDrag(): string[] {
  return dragSession?.paths ?? [];
}

export function endWorkspaceFileDrag(): void {
  dragSession = null;
}

export function encodeWorkspaceFileDrag(paths: string[]): string {
  return JSON.stringify({
    paths: paths.map((p) => p.trim()).filter(Boolean),
  });
}

export function decodeWorkspaceFileDrag(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as { paths?: unknown };
    if (!Array.isArray(parsed?.paths)) return [];
    return parsed.paths.filter((p): p is string => typeof p === "string" && p.trim().length > 0);
  } catch {
    return [];
  }
}

export function isTaskDrag(types: ArrayLike<string>): boolean {
  return Array.from(types).includes(TASK_DRAG_TYPE);
}

export function isWorkspaceFileDrag(types: ArrayLike<string>): boolean {
  return Array.from(types).includes(WORKSPACE_FILE_DRAG_TYPE);
}

export function isFileLikeDrag(types?: ArrayLike<string> | null): boolean {
  if (peekWorkspaceFileDrag().length) return true;
  if (!types) return false;
  const list = Array.from(types);
  return list.includes(WORKSPACE_FILE_DRAG_TYPE) || list.includes("Files");
}

export function fileNameFromPath(abs: string): string {
  const norm = abs.replace(/\\/g, "/");
  return norm.split("/").pop() || abs;
}

export function setWorkspaceFileDragData(
  event: { dataTransfer: DataTransfer },
  paths: string[],
): boolean {
  const clean = paths.map((p) => p.trim()).filter(Boolean);
  if (!clean.length) return false;
  event.dataTransfer.setData(WORKSPACE_FILE_DRAG_TYPE, encodeWorkspaceFileDrag(clean));
  event.dataTransfer.setData("text/plain", clean.join("\n"));
  event.dataTransfer.effectAllowed = "copyMove";
  return true;
}

export function pathsFromWorkspaceDrop(event: { dataTransfer: DataTransfer }): string[] {
  const encoded = event.dataTransfer.getData(WORKSPACE_FILE_DRAG_TYPE);
  if (encoded) {
    const paths = decodeWorkspaceFileDrag(encoded);
    if (paths.length) return paths;
  }
  const session = peekWorkspaceFileDrag();
  if (session.length) return session;
  const files = event.dataTransfer.files;
  if (!files?.length) return [];
  return Array.from(files)
    .map((file) => window.api?.getPathForFile?.(file) || "")
    .filter(Boolean);
}

export const WORKSPACE_FILES_CHANGED_EVENT = "mybuddy:workspace-files-changed";

export function notifyWorkspaceFilesChanged(): void {
  window.dispatchEvent(new Event(WORKSPACE_FILES_CHANGED_EVENT));
}
