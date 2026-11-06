/**
 * 产物面板工具栏动作：复制 / 下载 / 按 kind 推断 MIME / 发送到对话。
 * 纯函数，不依赖 React；data URI 二进制与纯文本统一处理。
 */
import type { Artifact, ArtifactKind } from "@/types";
import type { RefFileItem } from "./refTaskArtifacts";
import { isBinaryDataUri } from "./binaryArtifact";

const MIME_BY_KIND: Record<ArtifactKind, string> = {
  markdown: "text/markdown;charset=utf-8",
  table: "text/markdown;charset=utf-8",
  code: "text/plain;charset=utf-8",
  html: "text/html;charset=utf-8",
  svg: "image/svg+xml;charset=utf-8",
  image: "application/octet-stream",
  video: "video/mp4",
  audio: "audio/mpeg",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  cad: "application/octet-stream",
};

const EXT_BY_KIND: Partial<Record<ArtifactKind, string>> = {
  markdown: "md",
  table: "md",
  code: "txt",
  html: "html",
  svg: "svg",
  image: "png",
  video: "mp4",
  audio: "mp3",
  pdf: "pdf",
  docx: "docx",
  xlsx: "xlsx",
  pptx: "pptx",
  cad: "bin",
};

/** 文本类产物（可全文搜索 / 复制正文） */
export function isTextualArtifact(kind: ArtifactKind): boolean {
  return kind === "markdown" || kind === "table" || kind === "code" || kind === "html" || kind === "svg";
}

/** 二进制产物（图片/Office/CAD 等）：有 path 走附件读盘；无 path 不把 base64 塞进 prompt */
export function isBinaryArtifact(artifact: Pick<Artifact, "kind" | "content">): boolean {
  if (
    artifact.kind === "image" ||
    artifact.kind === "video" ||
    artifact.kind === "audio" ||
    artifact.kind === "pdf" ||
    artifact.kind === "docx" ||
    artifact.kind === "xlsx" ||
    artifact.kind === "pptx" ||
    artifact.kind === "cad"
  ) {
    return true;
  }
  return Boolean(artifact.content && isBinaryDataUri(artifact.content));
}

/**
 * 预览产物 → 对话引用项（与 InputAddMenu「引用对话中的文件」同构）。
 * - 有磁盘 path：只带 path（Agent 读盘；不塞 content）
 * - 文本无 path：内联 content（限长）
 * - 二进制无 path：短说明，避免 base64 污染 prompt
 */
export function artifactToRefFile(artifact: Artifact): RefFileItem {
  const path = artifact.path?.trim() || undefined;
  const item: RefFileItem = {
    id: artifact.id,
    name: artifact.name || "未命名文件",
    path,
    source: "artifact",
  };
  if (path) return item;

  if (isBinaryArtifact(artifact) || (artifact.content && isBinaryDataUri(artifact.content))) {
    item.content = `（二进制产物 ${item.name}，类型 ${artifact.kind}；已在产物面板打开预览。若需 Agent 读盘，请确认工作区路径。）`;
    return item;
  }

  const body = (artifact.content ?? "").trim();
  if (!body) {
    item.content = `（产物 ${item.name} 暂无可用内容）`;
    return item;
  }
  item.content = body.length > 12_000 ? `${body.slice(0, 12_000)}\n…（已截断）` : body;
  return item;
}

export function mimeForArtifact(artifact: Artifact): string {
  if (isBinaryDataUri(artifact.content)) {
    const comma = artifact.content.indexOf(",");
    const header = artifact.content.slice(5, comma);
    const mime = header.split(";")[0];
    if (mime) return mime;
  }
  return MIME_BY_KIND[artifact.kind] ?? "application/octet-stream";
}

/** 保证下载文件名带扩展名 */
export function downloadFileName(artifact: Artifact): string {
  const name = artifact.name?.trim() || "download";
  if (name.includes(".")) return name;
  const ext = EXT_BY_KIND[artifact.kind];
  return ext ? `${name}.${ext}` : name;
}

function triggerDownload(href: string, filename: string): void {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** 下载当前产物：二进制 data URI 直下；文本按 MIME 打包 Blob */
export function downloadArtifact(artifact: Artifact): void {
  const filename = downloadFileName(artifact);
  if (!artifact.content) return;

  // 图片产物 content 是协议 URL：字节由主进程投递（CSP connect-src 已放行），
  // fetch 到 Blob 再触发下载，避免把 URL 字符串当文件内容下载。
  if (artifact.content.startsWith("mybuddy-artifact://local/")) {
    void fetch(artifact.content)
      .then((response) => {
        if (!response.ok) throw new Error(`artifact image ${response.status}`);
        return response.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        try {
          triggerDownload(url, filename);
        } finally {
          window.setTimeout(() => URL.revokeObjectURL(url), 4_000);
        }
      })
      .catch(() => {
        // 下载失败不改变其它产物行为；用户仍可用"在系统应用中打开"走磁盘路径
      });
    return;
  }

  if (isBinaryDataUri(artifact.content) || artifact.content.startsWith("data:")) {
    triggerDownload(artifact.content, filename);
    return;
  }

  const mime = mimeForArtifact(artifact);
  const blob = new Blob([artifact.content], { type: mime });
  const url = URL.createObjectURL(blob);
  try {
    triggerDownload(url, filename);
  } finally {
    // 延迟 revoke，避免部分浏览器取消下载
    window.setTimeout(() => URL.revokeObjectURL(url), 4_000);
  }
}

/**
 * 复制产物：
 * - 文本类 → 复制正文
 * - 二进制且有磁盘路径 → 复制路径
 * - 二进制无路径 → 复制文件名（避免把 base64 塞进剪贴板）
 */
export async function copyArtifact(artifact: Artifact): Promise<"content" | "path" | "name"> {
  if (isTextualArtifact(artifact.kind) && artifact.content && !isBinaryDataUri(artifact.content)) {
    await navigator.clipboard.writeText(artifact.content);
    return "content";
  }
  if (artifact.path) {
    await navigator.clipboard.writeText(artifact.path);
    return "path";
  }
  await navigator.clipboard.writeText(artifact.name || "");
  return "name";
}

/** 在系统默认应用中打开磁盘文件；无路径时返回 false */
export async function openArtifactInSystem(artifact: Artifact): Promise<boolean> {
  const path = artifact.path?.trim();
  if (!path) return false;
  try {
    // openFolder 底层 shell.openPath，对文件/目录均可用
    await window.api?.openFolder?.(path);
    return true;
  } catch {
    return false;
  }
}

/** 在资源管理器中定位文件 */
export async function revealArtifactInFolder(artifact: Artifact): Promise<boolean> {
  const path = artifact.path?.trim();
  if (!path) return false;
  try {
    await window.api?.showItemInFolder?.(path);
    return true;
  } catch {
    return false;
  }
}

export interface TextMatch {
  /** 匹配起始偏移（在 content 中） */
  index: number;
  /** 所在行号（0-based） */
  line: number;
}

/** 在全文中查找（大小写不敏感），返回所有命中 */
export function findTextMatches(content: string, query: string): TextMatch[] {
  const q = query.trim();
  if (!q || !content) return [];
  const hay = content.toLowerCase();
  const needle = q.toLowerCase();
  const matches: TextMatch[] = [];
  let from = 0;
  while (from <= hay.length - needle.length) {
    const idx = hay.indexOf(needle, from);
    if (idx < 0) break;
    const line = content.slice(0, idx).split("\n").length - 1;
    matches.push({ index: idx, line });
    from = idx + Math.max(needle.length, 1);
  }
  return matches;
}

/**
 * 将滚动容器滚到约等于 content 偏移比例的位置。
 * 虚拟列表高度与字符不成严格正比，作为近似跳转足够。
 */
export function scrollArtifactBodyToOffset(offset: number, contentLength: number): void {
  if (contentLength <= 0) return;
  const ratio = Math.min(1, Math.max(0, offset / contentLength));
  const root =
    document.querySelector<HTMLElement>(".artifact-body .md-doc-viewer") ??
    document.querySelector<HTMLElement>(".artifact-body .code-view--virtual") ??
    document.querySelector<HTMLElement>(".artifact-body .code-view") ??
    document.querySelector<HTMLElement>(".artifact-body");
  if (!root) return;
  const max = root.scrollHeight - root.clientHeight;
  if (max <= 0) return;
  root.scrollTo({ top: ratio * max, behavior: "smooth" });
}
