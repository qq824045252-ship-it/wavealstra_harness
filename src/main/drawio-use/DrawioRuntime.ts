import { app, BrowserWindow, type WebContents } from "electron";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { PDFDocument } from "@cantoo/pdf-lib";
import release from "../../../vendor/drawio/release.json";
import { assertDrawioBytes } from "./DrawioXml";

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
  ".xml": "application/xml", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".gif": "image/gif", ".jpg": "image/jpeg", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".wasm": "application/wasm",
  ".webp": "image/webp", ".txt": "text/plain",
};

export const drawioRuntimeDirectory = () => app.isPackaged
  ? join(process.resourcesPath, "drawio", "web")
  : join(app.getAppPath(), "vendor", "drawio", "assets", "web");

let engine: DrawioRuntime | undefined;
export const getDrawioRuntime = () => {
  if (!engine) throw new Error("Draw.io Use 尚未完成初始化");
  return engine;
};
export function installDrawioRuntime(start: () => Promise<string>) {
  return engine = new DrawioRuntime(start);
}

export function restrictDrawioContent(contents: WebContents, origin: string) {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  contents.session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !(details.url.startsWith(origin + "/") ||
      details.url.startsWith("blob:" + origin + "/") || details.url.startsWith("data:") ||
      details.url === "about:blank") });
  });
  contents.on("will-navigate", event => event.preventDefault());
  contents.on("will-frame-navigate", event => {
    if (!event.url.startsWith(origin + "/drawio-runtime/")) event.preventDefault();
  });
}

type Format = "xml" | "svg" | "png" | "pdf" | "jpg";
interface RenderOptions {
  format: Format; xml?: string; mermaid?: string; mermaidImage?: boolean;
  layout?: string; normalize?: boolean; page?: number; allPages?: boolean;
  editable?: boolean; transparent?: boolean; border?: number; scale?: number;
  width?: number; height?: number;
}

function argumentsFor(options: RenderOptions) {
  return {
    format: options.format, xml: options.xml, mermaid: options.mermaid,
    mermaidImage: options.mermaidImage, layout: options.layout === "libavoid" ? "orthogonalEdge" : options.layout,
    normalize: options.normalize,
    from: options.page == null ? undefined : options.page - 1,
    to: options.page == null ? undefined : options.page - 1,
    allPages: Boolean(options.allPages),
    embedXml: options.editable === false ? "0" : "1", uncompressed: true,
    embedImages: "1", embedFonts: "1",
    bg: options.transparent ? "none" : "#ffffff", crop: "1",
    border: options.border ?? 10, pageMargin: options.border ?? 10,
    scale: options.scale ?? 1, w: options.width, h: options.height,
  };
}

export class DrawioRuntime {
  private readonly pending = new Set<BrowserWindow>();
  constructor(private readonly start: () => Promise<string>) {}

  async assertAvailable() {
    const directory = drawioRuntimeDirectory();
    const marker = await readFile(join(directory, "mybuddy-release"), "utf8").catch(() => "");
    if (marker.trim() !== release.sha256 ||
        !(await Promise.all(release.files.map(file => stat(join(directory, file)).then(info => info.isFile(), () => false)))).every(Boolean)) {
      throw new Error("Draw.io 编辑器资源缺失。开发环境可运行 pnpm prepare:drawio。");
    }
  }

  async check() {
    try {
      await this.assertAvailable();
      return { state: "ready" as const, detail: "已找到官方 Draw.io " + release.version + " 编辑器和本地导出引擎。" };
    } catch (error) {
      return { state: "missing-dependency" as const, detail: (error as Error).message };
    }
  }

  async serveAsset(name: string, res: ServerResponse) {
    const parts = name.split("/").map(part => decodeURIComponent(part));
    if (parts.some(part => !part || part.startsWith(".") || /[\\/:\x00-\x1f]/.test(part)) ||
        ["WEB-INF", "META-INF"].includes(parts[0].toUpperCase())) {
      res.writeHead(404).end();
      return;
    }
    const path = join(drawioRuntimeDirectory(), ...parts);
    const type = mime[extname(path).toLowerCase()] ?? "application/octet-stream";
    res.setHeader("Content-Type", type);
    if (name === "export3.html") {
      const html = await readFile(path, "utf8");
      res.end(html.replace("<head>", '<head><script src="/drawio/engine.js"></script>'));
      return;
    }
    if (name === "js/export.js") {
      const source = await readFile(path, "utf8");
      // Local orthogonal routing uses WebAssembly in the official export renderer.
      res.end(source.replace(/(script-src \\'self\\')/, "$1 \\'wasm-unsafe-eval\\'")
        .replaceAll("data.xml = getMermaidPageXml(editorUi, xml);",
          "data.xml = data.mermaidImage ? editorUi.createMermaidImageXml(data.mermaid, null, xml) : getMermaidPageXml(editorUi, xml);"));
      return;
    }
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "Content-Length": info.size, "Cache-Control": "private, max-age=86400" });
    await pipeline(createReadStream(path), res);
  }

  async render(options: RenderOptions, signal?: AbortSignal): Promise<Buffer> {
    signal?.throwIfAborted();
    await this.assertAvailable();
    const origin = await this.start();
    signal?.throwIfAborted();
    if (this.pending.size >= 4) throw new Error("Draw.io 正在处理多个导出，请稍后重试");
    const bitmap = options.format === "png" || options.format === "jpg";
    const window = new BrowserWindow({
      show: false, width: 1024, height: 768, frame: false, enableLargerThanScreen: true,
      transparent: options.format === "png" && options.transparent,
      webPreferences: {
        sandbox: true, contextIsolation: true, nodeIntegration: false,
        partition: "mybuddy-drawio-render", spellcheck: false, backgroundThrottling: false,
        offscreen: bitmap ? { deviceScaleFactor: 1 } : false,
      },
    });
    this.pending.add(window);
    const contents = window.webContents;
    restrictDrawioContent(contents, origin);
    contents.setUserAgent(contents.getUserAgent() + " draw.io/" + release.version);
    const abort = () => { if (!window.isDestroyed()) window.destroy(); };
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, 120_000);
    try {
      await contents.loadURL(origin + "/drawio-runtime/export3.html");
      const input = JSON.stringify(argumentsFor(options));
      const result = await contents.executeJavaScript(`window.myBuddyDrawioRender(${input})`);
      signal?.throwIfAborted();
      if (options.format === "xml") {
        const bytes = Buffer.from(result as string);
        assertDrawioBytes(bytes);
        return bytes;
      }
      if (options.format === "svg") {
        if (typeof result !== "string" || !result.includes("<svg")) throw new Error("Draw.io SVG 导出失败");
        if (options.editable === false || !options.xml) return Buffer.from(result);
        const content = options.xml.replace(/[&"<>\n\r\t]/g, value => ({
          "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;", "\n": "&#10;", "\r": "&#13;", "\t": "&#9;",
        })[value]!);
        return Buffer.from(result.replace(/<svg\b[^>]*>/, tag =>
          tag.replace(/\scontent="[^"]*"/, "").replace("<svg", () => '<svg content="' + content + '"')));
      }
      if (options.format === "pdf") {
        const pdf = await PDFDocument.load(await contents.printToPDF({ preferCSSPageSize: true, printBackground: true }));
        pdf.setCreator("diagrams.net");
        if (options.editable !== false && options.xml) {
          pdf.setSubject(encodeURIComponent(options.xml).replace(/\(/g, "\\(").replace(/\)/g, "\\)"));
        }
        return Buffer.from(await pdf.save({ useObjectStreams: true }));
      }
      const dimensions = JSON.parse(result.bounds) as { x: number; y: number; width: number; height: number };
      const width = Math.ceil(dimensions.x + dimensions.width);
      const height = Math.ceil(dimensions.y + dimensions.height);
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 36_000_000) {
        throw new Error("Draw.io 位图尺寸超出限制，请缩小比例");
      }
      window.setContentSize(width + 1, height + 1);
      await contents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      const image = await contents.capturePage({ x: 0, y: 0, width, height }, { stayHidden: true });
      if (image.isEmpty()) throw new Error("Draw.io 位图渲染失败");
      const fit = options.height ?? options.width;
      const resized = fit ? image.resize(options.height ? { height: fit } : { width: fit }) : image;
      if (options.format === "jpg") return resized.toJPEG(90);
      const png = resized.toPNG();
      if (options.editable === false || !options.xml) return png;
      const encoded = await contents.executeJavaScript(
        `Editor.writeGraphModelToPng(${JSON.stringify(png.toString("base64"))}, "tEXt", "mxGraphModel", encodeURIComponent(${JSON.stringify(options.xml)}))`,
      ) as string;
      return Buffer.from(encoded.slice(encoded.indexOf(",") + 1), "base64");
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      this.pending.delete(window);
      abort();
    }
  }

  dispose() {
    for (const window of this.pending) if (!window.isDestroyed()) window.destroy();
  }
}
