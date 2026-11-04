/** 从 SVG/HTML 源码猜测产物文件名 */
export function guessCanvasArtifactName(
  content: string,
  kind: "html" | "svg",
): string {
  const titleMatch =
    /<title[^>]*>([^<]+)<\/title>/i.exec(content) ??
    /<text[^>]*>([^<]{2,40})<\/text>/i.exec(content);
  const raw = titleMatch?.[1]?.replace(/\s+/g, " ").trim();
  if (raw) return raw.slice(0, 48);
  return kind === "svg" ? "流程图" : "画布";
}
