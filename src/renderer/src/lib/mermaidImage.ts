/** Render in strict mode. The resulting SVG is only displayed as a static image. */
export async function renderMermaidImage(source: string): Promise<string> {
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", maxTextSize: 50_000, suppressErrorRendering: true });
  const { svg } = await mermaid.render("mybuddy-mermaid-" + crypto.randomUUID(), source);
  return "data:image/svg+xml," + encodeURIComponent(svg);
}

export function isChatMermaid(source: string): boolean {
  const code = source.trim();
  return code.length <= 8_000 && !/%%\{|^\s*click\s/m.test(code)
    && /^(?:flowchart|graph|sequenceDiagram|stateDiagram(?:-v2)?)(?:\s|$)/.test(code);
}
