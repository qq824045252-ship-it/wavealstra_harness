import { stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { drawioUseSkillDirectory } from "../skills/DrawioUseSkill";
import { drawioRuntimeDirectory } from "./DrawioRuntime";

const referenceFiles = {
  mermaid: "mermaid-reference.md", xml: "xml-essentials.md",
  "xml-advanced": "xml-reference.md", styles: "style-reference.md", schema: "mxfile.xsd",
} as const;

const upstream = (...parts: string[]) => join(drawioUseSkillDirectory(), "references", "upstream", ...parts);
export const readDrawioReference = (name: keyof typeof referenceFiles) =>
  readFile(upstream("shared", referenceFiles[name]), "utf8");

type Shape = { title: string; w: number; h: number; style: string; tags?: string };
type SearchEngine = {
  buildTagMap(index: Shape[]): object;
  searchShapes(index: Shape[], tags: object, query: string, limit: number): Shape[];
};

let cached: Promise<{ engine: SearchEngine; index: Shape[]; tags: object }> | undefined;
async function shapeIndex() {
  cached ??= Promise.all([
    import(pathToFileURL(upstream("shared", "shape-search.js")).href) as Promise<SearchEngine>,
    readFile(upstream("shape-search", "search-index.json"), "utf8"),
  ]).then(([engine, json]) => {
    const index = JSON.parse(json) as Shape[];
    return { engine, index, tags: engine.buildTagMap(index) };
  }).catch(error => { cached = undefined; throw error; });
  return cached;
}

let repairModule: Promise<{ repairDiagramXml(xml: string): { xml: string; repairs: string[] } }> | undefined;
export async function repairDrawioXml(xml: string) {
  repairModule ??= import(pathToFileURL(upstream("shared", "repair-xml.js")).href);
  return (await repairModule).repairDiagramXml(xml);
}

// Pinned stencil images are carried in the diagram so exported files remain portable.
async function inlineShape(shape: Shape): Promise<Shape> {
  const match = /(?:^|;)image=https:\/\/app\.diagrams\.net\/((?:img|images)\/[\w./-]+)(?:;|$)/.exec(shape.style);
  if (!match || match[1].split("/").includes("..")) return shape;
  const path = join(drawioRuntimeDirectory(), match[1]);
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile() || info.size > 512 * 1024) return shape;
  const mime = match[1].endsWith(".png") ? "image/png" : "image/svg+xml";
  return { ...shape, style: shape.style.replace("https://app.diagrams.net/" + match[1],
    "data:" + mime + "," + (await readFile(path)).toString("base64")) };
}

async function officialIcons(query: string, signal?: AbortSignal): Promise<Shape[]> {
  const params = new URLSearchParams({ p: "0", c: "3", q: query });
  const timeout = AbortSignal.timeout(8000);
  const request = { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: "error" as const };
  const iconOrigin = "https://icons.diagrams.net";
  const response = await fetch(iconOrigin + "/api/icons/search?" + params, request);
  if (!response.ok) throw new Error("图标服务返回 HTTP " + response.status);
  const data = await response.json() as { images?: Array<{ url: string; title: string }> };
  const images = (data.images ?? []).filter(icon => typeof icon.url === "string" &&
    icon.url.startsWith(iconOrigin + "/") && /^https:\/\/[^;&"'< >\s]+$/.test(icon.url)).slice(0, 3);
  const results = await Promise.allSettled(images.map(async icon => {
    const image = await fetch(icon.url, request);
    const mime = image.headers.get("content-type")?.split(";")[0];
    if (!image.ok || !image.body || !mime || !/^image\/(svg\+xml|png|jpeg|webp)$/.test(mime)) {
      throw new Error("官方图标资源无法读取");
    }
    const reader = image.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 256 * 1024) throw new Error("官方图标尺寸超出限制");
        parts.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const encoded = Buffer.concat(parts).toString("base64");
    return {
      title: icon.title, w: 48, h: 48,
      style: "shape=image;html=1;verticalAlign=top;verticalLabelPosition=bottom;labelBackgroundColor=default;imageAspect=0;aspect=fixed;image=data:" + mime + "," + encoded + ";",
    };
  }));
  const icons = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
  if (images.length && !icons.length) throw new Error("官方图标下载失败");
  return icons;
}

export async function findDrawioShapes(query: string, includeOnlineIcons: boolean, signal?: AbortSignal) {
  const { engine, index, tags } = await shapeIndex();
  const local = await Promise.all(engine.searchShapes(index, tags, query, 6).map(inlineShape));
  if (!includeOnlineIcons) return { local };
  try { return { local, online: await officialIcons(query, signal) }; }
  catch (error) {
    signal?.throwIfAborted();
    return { local, onlineError: (error as Error).message };
  }
}
