/**
 * Office 预览/抽取体积门槛：大于 500KB 的 Excel / Word / PPT 不解析，
 * 直接空白页（SheetJS / docx-preview / JSZip 全量解析会拖死渲染进程）。
 */
export const OFFICE_PREVIEW_MAX_BYTES = 500 * 1024;

/** previewWorkspaceFile 对超限 office 返回的占位内容（非 data URI，Viewer 不得当二进制解） */
export const OFFICE_PREVIEW_SKIP_MARKER = "office-preview-skipped";

const OFFICE_KINDS = new Set(["docx", "xlsx", "pptx"]);

export function isOfficePreviewKind(kind: string | undefined): boolean {
  return Boolean(kind && OFFICE_KINDS.has(kind));
}

/** 从 data URI 估算解码后字节数（不 atob，避免大文件再拷一遍） */
export function estimateDataUriBytes(content: string): number | null {
  if (!content.startsWith("data:")) return null;
  const comma = content.indexOf(",");
  if (comma < 0) return null;
  const header = content.slice(5, comma);
  if (!header.split(";").includes("base64")) return null;
  const payload = content.slice(comma + 1);
  if (!payload) return 0;
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

export function shouldSkipOfficePreview(content: string, fileBytes?: number): boolean {
  if (content === OFFICE_PREVIEW_SKIP_MARKER) return true;
  if (fileBytes !== undefined && fileBytes > OFFICE_PREVIEW_MAX_BYTES) return true;
  const estimated = estimateDataUriBytes(content);
  return estimated !== null && estimated > OFFICE_PREVIEW_MAX_BYTES;
}
