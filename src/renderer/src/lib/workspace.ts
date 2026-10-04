import type { ArtifactKind } from "@/types";

/** 默认工作空间根（无任务 cwd 时的回退） */
export const MOCK_WORKSPACE_ROOT = "C:\\Users\\servi\\Desktop\\mybuddy";

/** 工作区文件内容缓存（由真实读盘/Artifact 填充；启动为空） */
export const mockWorkspaceFileContents: Record<string, string> = {};

/** 比较用：统一正斜杠、去尾斜杠、小写（Windows 盘符） */
export function normalizeComparePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** 工作区根 + 相对路径 → 绝对路径（保留根的分隔符风格） */
export function joinWorkspaceAbs(root: string, relativePath = ""): string {
  const trimmed = relativePath.replace(/^[\\/]+/, "").trim();
  if (!trimmed) return root.replace(/[\\/]+$/, "");
  const sep = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${sep}${trimmed.replace(/[/\\]+/g, sep)}`;
}

/** 绝对路径 → 相对工作区根（保留原大小写）；不在根下时返回空串 */
export function toWorkspaceRelative(root: string, absOrRel: string): string {
  const rootNorm = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const pathNorm = absOrRel.replace(/\\/g, "/");
  const nRoot = rootNorm.toLowerCase();
  const nPath = pathNorm.toLowerCase();
  if (nPath === nRoot) return "";
  if (nPath.startsWith(`${nRoot}/`)) return pathNorm.slice(rootNorm.length + 1);
  if (!/^[a-zA-Z]:\//.test(pathNorm) && !pathNorm.startsWith("/")) {
    return pathNorm.replace(/^\/+/, "");
  }
  return "";
}

export function resolveWorkspacePath(relativePath?: string): string {
  if (!relativePath) return MOCK_WORKSPACE_ROOT;
  const normalized = relativePath.replace(/\//g, "\\");
  return `${MOCK_WORKSPACE_ROOT}\\${normalized}`;
}

export function getWorkspaceFileContent(relativePath: string, name: string): string {
  const key = relativePath.replace(/\\/g, "/");
  if (mockWorkspaceFileContents[key]) return mockWorkspaceFileContents[key];
  const byName = Object.entries(mockWorkspaceFileContents).find(([p]) => p.endsWith(`/${name}`) || p === name);
  if (byName) return byName[1];
  if (name.toLowerCase().endsWith(".md") || name.toLowerCase().endsWith(".markdown")) {
    return `# ${name.replace(/\.(md|markdown)$/i, "")}\n\n`;
  }
  return "";
}

export function inferArtifactKind(name: string, content: string): ArtifactKind {
  const lower = name.toLowerCase();
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) return "xlsx";
  if (lower.endsWith(".pptx")) return "pptx";
  if (lower.endsWith(".svg")) return "svg";
  if (lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".gif") || lower.endsWith(".webp") || lower.endsWith(".avif") || lower.endsWith(".bmp") || lower.endsWith(".ico")) {
    return "image";
  }
  if (lower.endsWith(".mp4") || lower.endsWith(".webm") || lower.endsWith(".mov")) return "video";
  if (lower.endsWith(".mp3") || lower.endsWith(".wav") || lower.endsWith(".ogg") || lower.endsWith(".m4a")) return "audio";
  const trimmedContent = content.trim().toLowerCase();
  if (trimmedContent.startsWith("data:image/")) return "image";
  if (trimmedContent.startsWith("data:video/")) return "video";
  if (trimmedContent.startsWith("data:audio/")) return "audio";
  if (lower.endsWith(".json") || lower.endsWith(".py") || lower.endsWith(".ts") || lower.endsWith(".tsx") || lower.endsWith(".js") || lower.endsWith(".css")) {
    return "code";
  }
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  return "code";
}

export function languageFromName(name: string): string | undefined {
  const lower = name.toLowerCase();
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx")) return "javascript";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  return undefined;
}
