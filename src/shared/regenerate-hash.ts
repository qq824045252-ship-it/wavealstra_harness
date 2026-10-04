/**
 * regenerate 目标漂移校验用的规范化文本指纹（方案 Problem Three 5.5）。
 *
 * renderer 与 main 必须使用同一函数，否则会误报 TARGET_DRIFTED：
 * - renderer：对被重新生成的源用户消息文本做 hash，随请求传给主进程。
 * - main：对 navigateTree 返回的 editorText 做 hash，二者应一致。
 *
 * 实现取「规范化文本 + FNV-1a 32-bit」十六进制串；归一化只做 trim 与空白折叠，
 * 避免不同来源（消息 dto / editor）因换行差异误判漂移。
 */
export function normalizedEditorTextHash(text: string): string {
  const normalized = text
    .replace(/\r\n/g, "\n")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ")
    .trim();
  // FNV-1a 32-bit
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}