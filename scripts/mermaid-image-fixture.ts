import mermaid from "mermaid";
import { renderMermaidImage } from "../src/renderer/src/lib/mermaidImage";
import { closeVoidElements, isValidXml } from "../src/renderer/src/lib/mermaidXml";

/** Test fixture: expose the shipped renderer modules plus a raw render for the red control. */
Object.assign(globalThis, {
  MermaidProbe: {
    renderMermaidImage,
    closeVoidElements,
    isValidXml,
    async renderRaw(source: string): Promise<string> {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", maxTextSize: 50_000, suppressErrorRendering: true });
      const { svg } = await mermaid.render("raw-" + Math.random().toString(36).slice(2), source);
      return svg;
    },
  },
});
