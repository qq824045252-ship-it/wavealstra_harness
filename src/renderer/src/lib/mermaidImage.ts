import { closeVoidElements, isValidXml } from "./mermaidXml";

/** Render in strict mode. The resulting SVG is only displayed as a static image.
 * Strict mode sanitizes through DOMPurify's HTML round-trip, which drops the slash of
 * `<br/>`; an image URL must be well-formed XML, so close void elements and verify
 * before handing it to `<img>`. A rejected render falls back to the source fence. */
export async function renderMermaidImage(source: string): Promise<string> {
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", maxTextSize: 50_000, suppressErrorRendering: true });
  const { svg } = await mermaid.render("mybuddy-mermaid-" + crypto.randomUUID(), source);
  const xml = closeVoidElements(svg);
  if (!isValidXml(xml)) throw new Error("Mermaid SVG is not well-formed XML");
  return "data:image/svg+xml," + encodeURIComponent(xml);
}

export function isChatMermaid(source: string): boolean {
  const code = source.trim();
  return code.length <= 8_000 && !/%%\{|^\s*click\s/m.test(code)
    && /^(?:flowchart|graph|sequenceDiagram|stateDiagram(?:-v2)?)(?:\s|$)/.test(code);
}
