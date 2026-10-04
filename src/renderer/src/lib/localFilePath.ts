/** 对话/表格里的绝对路径：可点开、可拖到系统 */

export function looksLikeLocalFilePath(text: string): boolean {
  const t = text.trim();
  if (t.length < 3 || t.length > 512 || /[\n\r]/.test(t)) return false;
  if (/^[A-Za-z]:[\\/]/.test(t)) return true;
  if (t.startsWith("\\\\")) return true;
  if (t.startsWith("/") && !t.startsWith("//") && /\.[a-z0-9]{1,8}$/i.test(t)) return true;
  return false;
}

export function parentDir(absPath: string): string {
  const norm = absPath.replace(/[\\/]+$/, "");
  const idx = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  if (idx <= 0) return norm;
  if (idx === 2 && /^[A-Za-z]:/.test(norm)) return norm.slice(0, 3);
  return norm.slice(0, idx);
}

export function fileNameFromPath(absPath: string): string {
  const norm = absPath.replace(/[\\/]+$/, "");
  const idx = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}
