import { cp, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import JSZip from "jszip";
import { MANIFEST_FILENAME, MANIFEST_TMP_SUFFIX } from "../task/TaskExecutionWorkspace";
import type {
  ArtifactKind,
  WorkspaceFileNodeDto,
  WorkspaceFilePreviewDto,
  WorkspaceFileThumbnailDto,
} from "../../shared/agent-ipc";
import {
  OFFICE_PREVIEW_MAX_BYTES,
  OFFICE_PREVIEW_SKIP_MARKER,
  shouldSkipOfficePreview,
} from "../../shared/office-preview";

/** 任务目录内部元数据/临时文件：不进文件树、不进快照（§5.4/§10.1） */
function isInternalTaskFile(name: string): boolean {
  return name === MANIFEST_FILENAME || name.endsWith(MANIFEST_TMP_SUFFIX);
}

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".idea",
  ".venv",
  ".vscode",
  "node_modules",
  "out",
  "release",
]);

/**
 * 工具链生成物/缓存目录：只从「产物快照 diff」排除，文件树仍列出（用户可能要手动查看构建结果）。
 * 这些目录里的文件由外部构建工具随时改写 mtime，不是 Agent 本轮交付物；此前整个 build/、
 * intermediates/ 被批量登记成一轮产物，就是因为没有这一层过滤。
 */
const GENERATED_DIRECTORIES = new Set([
  "build", "dist", "target", "bin", "obj",
  ".gradle", ".next", ".nuxt", ".parcel-cache", ".turbo",
  "cache", ".cache", "caches-jvm", "intermediates", "__pycache__",
  ".pytest_cache", ".mypy_cache", "coverage", ".nyc_output",
]);

/** 产物快照扫描上限：超过后截断，diff 侧另有基线失配保险丝，不能把截断当成「本轮新增」。 */
export const WORKSPACE_SNAPSHOT_FILE_LIMIT = 5000;
/** 单轮允许登记的文件变化上限；超过这个量级几乎必然是基线失配或外部批量构建。 */
export const MAX_TURN_WORKSPACE_CHANGES = 200;

/** 路径是否落在版本控制/依赖/生成物目录内（按相对 root 的路径分段判断，跨平台）。 */
export function isGeneratedWorkspacePath(filePath: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(filePath));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;
  return rel.split(/[\\/]/).some((segment) =>
    IGNORED_DIRECTORIES.has(segment) || GENERATED_DIRECTORIES.has(segment),
  );
}

const TEXT_EXTENSIONS = new Set([
  ".css", ".csv", ".html", ".htm", ".js", ".jsx", ".json", ".log", ".md",
  ".markdown", ".py", ".sql", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
  // Mechanical CAD：STEP 是文本格式（不要按二进制处理）；model.py/model.json 同文本
  ".step", ".stp",
  // 3D 文本交换格式
  ".obj", ".gltf",
]);

const BINARY_CAD_EXTENSIONS = new Set([
  ".fcstd", ".stl", ".glb", ".blend", ".blend1",
]);

const SUPPORTED_EXTENSIONS = new Set([
  ...TEXT_EXTENSIONS,
  ".docx", ".xlsx", ".xls", ".pptx", ".pdf",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico", ".svg",
  ".mp4", ".webm", ".mov", ".mp3", ".wav", ".ogg", ".m4a",
  ...BINARY_CAD_EXTENSIONS,
]);

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number.parseInt(n, 10)))
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function tagTexts(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "g");
  return [...xml.matchAll(pattern)].map((match) => decodeXml(match[1].replace(/<[^>]+>/g, "")));
}

function previewShell(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    :root{color-scheme:light dark}body{margin:0;padding:28px;font:14px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif;background:#fff;color:#202124}
    h1{font-size:22px;margin:0 0 22px}h2{font-size:17px;margin:24px 0 10px;padding-bottom:7px;border-bottom:1px solid #e5e7eb}
    p{margin:8px 0;white-space:pre-wrap}table{border-collapse:collapse;width:100%;font-size:13px}td,th{border:1px solid #d9dde3;padding:7px 9px;text-align:left}tr:nth-child(even){background:#f7f8fa}
    .empty{color:#8a8f98}@media(prefers-color-scheme:dark){body{background:#1d1d1d;color:#e7e7e7}h2{border-color:#3a3a3a}td,th{border-color:#444}tr:nth-child(even){background:#242424}}
  </style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
}

async function docxPreview(buffer: Buffer, name: string): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file("word/document.xml")?.async("string");
  if (!xml) return previewShell(name, '<p class="empty">无法读取文档正文</p>');
  const paragraphs = [...xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)]
    .map((match) => tagTexts(match[1], "w:t").join(""))
    .filter((text) => text.trim());
  return previewShell(name, paragraphs.map((text) => `<p>${escapeHtml(text)}</p>`).join(""));
}

function columnIndex(cellRef: string): number {
  const letters = /^([A-Z]+)/i.exec(cellRef)?.[1].toUpperCase() ?? "A";
  let result = 0;
  for (const letter of letters) result = result * 26 + letter.charCodeAt(0) - 64;
  return result - 1;
}

async function xlsxPreview(buffer: Buffer, name: string): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const sharedXml = await zip.file("xl/sharedStrings.xml")?.async("string");
  const shared = sharedXml
    ? [...sharedXml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map((m) => tagTexts(m[1], "t").join(""))
    : [];
  const sheets = Object.keys(zip.files)
    .filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(path))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const sections: string[] = [];
  for (let index = 0; index < sheets.length; index += 1) {
    const xml = await zip.file(sheets[index])!.async("string");
    const rows: string[][] = [];
    for (const match of xml.matchAll(/<c\s([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = match[1];
      const body = match[2];
      const ref = /\br="([^"]+)"/.exec(attrs)?.[1] ?? "A1";
      const rowIndex = Math.max(0, Number.parseInt(/\d+/.exec(ref)?.[0] ?? "1", 10) - 1);
      const colIndex = columnIndex(ref);
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? tagTexts(body, "t").join("");
      const value = type === "s" ? shared[Number.parseInt(raw, 10)] ?? raw : decodeXml(raw);
      rows[rowIndex] ??= [];
      rows[rowIndex][colIndex] = value;
    }
    const width = Math.max(1, ...rows.map((row) => row.length));
    const table = rows.length
      ? `<table><tbody>${rows.map((row) => `<tr>${Array.from({ length: width }, (_, col) => `<td>${escapeHtml(row[col] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table>`
      : '<p class="empty">空工作表</p>';
    sections.push(`<h2>工作表 ${index + 1}</h2>${table}`);
  }
  return previewShell(name, sections.join("") || '<p class="empty">没有可读取的工作表</p>');
}

async function pptxPreview(buffer: Buffer, name: string): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const slides = Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const sections: string[] = [];
  for (let index = 0; index < slides.length; index += 1) {
    const xml = await zip.file(slides[index])!.async("string");
    const texts = tagTexts(xml, "a:t").filter((text) => text.trim());
    sections.push(`<h2>幻灯片 ${index + 1}</h2>${texts.map((text) => `<p>${escapeHtml(text)}</p>`).join("") || '<p class="empty">无文字内容</p>'}`);
  }
  return previewShell(name, sections.join("") || '<p class="empty">没有可读取的幻灯片</p>');
}

export function artifactKindForFile(filePath: string): ArtifactKind {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".html" || ext === ".htm") return "html";
  if (ext === ".md" || ext === ".markdown") return "markdown";
  // SVG is source-backed vector markup, not a bitmap data URI. Keeping it as its
  // own kind is what lets both the Artifact panel and the chat bubble use the
  // sandboxed/vector preview path instead of feeding it to the bitmap viewer.
  if (ext === ".svg") return "svg";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico"].includes(ext)) return "image";
  if ([".mp4", ".webm", ".mov"].includes(ext)) return "video";
  if ([".mp3", ".wav", ".ogg", ".m4a"].includes(ext)) return "audio";
  if (ext === ".pdf") return "pdf";
  if (ext === ".docx") return "docx";
  if (ext === ".xlsx" || ext === ".xls") return "xlsx";
  if (ext === ".pptx") return "pptx";
  // Mechanical CAD / Blender：二进制归 cad（渲染侧回退 code）；STEP/OBJ/glTF 文本归 code
  if (BINARY_CAD_EXTENSIONS.has(ext)) return "cad";
  return "code";
}

export function isSupportedWorkspaceFile(filePath: string): boolean {
  return SUPPORTED_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function imageMime(ext: string): string {
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".ico") return "image/x-icon";
  if (ext === ".bmp") return "image/bmp";
  if (ext === ".avif") return "image/avif";
  return `image/${ext.slice(1)}`;
}

function mediaMime(kind: "video" | "audio", ext: string): string {
  const value = ext.slice(1).toLowerCase();
  if (kind === "video" && value === "mov") return "video/quicktime";
  if (kind === "audio" && value === "m4a") return "audio/mp4";
  return `${kind}/${value || (kind === "video" ? "mp4" : "mpeg")}`;
}

/** Wave 5D-1：Office 二进制 mime（viewer 消费 data URI 字节） */
function officeMime(kind: string): string {
  if (kind === "xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (kind === "pptx") return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
}

/** 从 office data URI 还原字节（PromptContext 文本抽取用） */
export function decodeOfficeDataUri(dataUri: string): Buffer {
  const comma = dataUri.indexOf(",");
  const encoded = comma >= 0 ? dataUri.slice(comma + 1) : dataUri;
  return Buffer.from(encoded, "base64");
}

/** Wave 5D-1：office 二进制内容 → 文本抽取（PromptContext/旧预览用，主进程执行） */
export async function officeTextPreview(kind: string, dataUri: string, name: string): Promise<string> {
  if (shouldSkipOfficePreview(dataUri)) return "";
  const buffer = decodeOfficeDataUri(dataUri);
  if (buffer.byteLength > OFFICE_PREVIEW_MAX_BYTES) return "";
  if (kind === "docx") return docxPreview(buffer, name);
  if (kind === "xlsx") return xlsxPreview(buffer, name);
  if (kind === "pptx") return pptxPreview(buffer, name);
  return `[office ${kind}]`;
}

/**
 * 内联缩略图的显示上限（P0：图片消息拖动卡）。
 *
 * ChatImage 的显示上限是 480 CSS px；DPR 2 时需要 960 设备像素，长边 1280
 * 覆盖 4:3 的 960×1280。再大就只是白解码 —— 原图解码后的位图面积
 * （width×height×4）才是滚动时反复 evict/重解的根源，CSS 的 maxHeight 不减少它。
 */
const IMAGE_THUMBNAIL_MAX_EDGE = 1280;
/** 清单 P0：缩略图质量 q60（源为 webp 时 pi 保持 webp 编码） */
const IMAGE_THUMBNAIL_JPEG_QUALITY = 60;
/** 缩略图体积预算：超了让 pi 继续降质/降尺寸，别拿 1MB 的副本当缩略图 */
const IMAGE_THUMBNAIL_MAX_BYTES = 320 * 1024;
/**
 * 内联等待预算（实测 pi/photon 解一张 12.6MP 的 JPEG 要约 1.2s，0.9MP 约 0.1s）：
 * 超出预算就先按原图字节回协议请求，生成继续在后台跑完并进缓存。
 * 缩略图是"下一次看同一张图"的收益，绝不能变成首屏新增的等待。
 */
const IMAGE_THUMBNAIL_INLINE_BUDGET_MS = 400;
/** 进程内缩略图缓存条数（LRU，每条约 ≤320KB Buffer）：滚动回看、重开面板都命中它 */
const IMAGE_THUMBNAIL_CACHE_LIMIT = 64;
/**
 * 单图体积上限（清单 P0）：超过它，内联链路绝不生成整份原图 base64，
 * 只回缩略图元数据 + 磁盘路径；原图字节仅由协议在"点击看原图"时投递。
 */
export const IMAGE_INLINE_BASE64_MAX_BYTES = 512 * 1024;
/** 只降采样单帧位图：GIF/ICO 回落到原图，避免把动图变成静帧 */
const THUMBNAILABLE_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp"]);

export interface PreviewWorkspaceFileOptions {
  /**
   * 图像额外产出一份内联缩略图。缺省 false：content 与对外行为完全不变；
   * 只有明确要内联展示的调用方（Artifact Domain readContent → ChatImage）开启。
   */
  thumbnail?: boolean;
  /** 内联链路：不生成原图 base64，content 由 Artifact Domain 换成协议 URL */
  inlineImage?: boolean;
}

interface ThumbnailBytes {
  data: Buffer;
  mimeType: string;
  width: number;
  height: number;
}

/** 主进程缩略图字节缓存：只读文件头/mtime 就能命中，renderer 永远拿不到这些字节 */
const thumbnailCache = new Map<string, ThumbnailBytes | undefined>();

function thumbnailCacheKey(filePath: string, st: { mtimeMs: number; size: number }): string {
  return `${filePath}\u0000${st.mtimeMs}\u0000${st.size}`;
}

function touchThumbnailCache(key: string, value: ThumbnailBytes | undefined): void {
  if (thumbnailCache.has(key)) thumbnailCache.delete(key);
  while (thumbnailCache.size >= IMAGE_THUMBNAIL_CACHE_LIMIT) {
    const oldest = thumbnailCache.keys().next().value;
    if (oldest === undefined) break;
    thumbnailCache.delete(oldest);
  }
  thumbnailCache.set(key, value);
}

/**
 * 全局并发上限（2）：pi 的 resizeImage 每次调用都会 new 一个 worker 线程。
 * 一条 38 图的消息会并发打进来 38 个 readContent，不限流就是 38 个线程 + 38 份 wasm。
 */
let thumbnailFreeSlots = 2;
const thumbnailWaiters: Array<() => void> = [];
async function withThumbnailSlot<T>(run: () => Promise<T>): Promise<T> {
  if (thumbnailFreeSlots > 0) thumbnailFreeSlots -= 1;
  else await new Promise<void>((release) => thumbnailWaiters.push(release));
  try {
    return await run();
  } finally {
    const next = thumbnailWaiters.shift();
    if (next) next();
    else thumbnailFreeSlots += 1;
  }
}

/**
 * 图像固有尺寸：只读文件头，不解码。
 * 有了它，即使这一轮还没产出缩略图，内联 <img> 也能在加载完成前把行高钉死。
 */
function imageIntrinsicSize(buffer: Buffer): { width: number; height: number } | null {
  try {
    if (buffer.length > 24 && buffer.toString("latin1", 1, 4) === "PNG") {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    const head = buffer.toString("latin1", 0, 12);
    if (head.startsWith("GIF")) return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    if (head.startsWith("RIFF") && buffer.toString("latin1", 8, 12) === "WEBP") {
      const format = buffer.toString("latin1", 12, 16);
      if (format === "VP8 ") return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
      if (format === "VP8L") {
        const packed = buffer.readUInt32LE(21);
        return { width: (packed & 0x3fff) + 1, height: ((packed >> 14) & 0x3fff) + 1 };
      }
      if (format === "VP8X") return { width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 };
    }
    if (buffer[0] === 0xff && buffer[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) { offset += 1; continue; }
        const marker = buffer[offset + 1];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
        }
        offset += 2 + buffer.readUInt16BE(offset + 2);
      }
    }
  } catch {
    /* 头不完整/格式不认识：交给渲染端按原逻辑处理 */
  }
  return null;
}

/**
 * 懒加载 pi 的 resizeImage —— 这里必须是动态 import，不能静态 import。
 *
 * pi 的 barrel（dist/index.js）在模块求值阶段就会拉进 cli/config 初始化，而
 * config.js 依赖 import.meta.url；任何间接 import 到本文件的 esbuild CJS 测试
 * bundle（chat-markdown 等）都会在加载期直接抛 ERR_INVALID_ARG_TYPE。
 * 动态 import 把 pi 的求值推迟到「真的要产缩略图」那一刻，测试与不需要缩略图
 * 的调用方完全不碰它。resizeImage 本身跑 worker 线程，worker 起不来时它会自己
 * 回落 in-process，所以缩略图最坏情况只是慢，不会让预览报错。
 */
let piImageResize: Promise<typeof import("@earendil-works/pi-coding-agent")> | null = null;
function loadPiImageResize(): Promise<typeof import("@earendil-works/pi-coding-agent")> {
  piImageResize ??= import("@earendil-works/pi-coding-agent");
  return piImageResize;
}

/** 真做一次降采样（不含缓存/限流）：只在确实缩小过时返回。字节留在主进程。 */
async function resizeToThumbnail(buffer: Buffer, ext: string): Promise<ThumbnailBytes | undefined> {
  try {
    const { resizeImage } = await loadPiImageResize();
    const resized = await resizeImage(buffer, imageMime(ext), {
      maxWidth: IMAGE_THUMBNAIL_MAX_EDGE,
      maxHeight: IMAGE_THUMBNAIL_MAX_EDGE,
      maxBytes: IMAGE_THUMBNAIL_MAX_BYTES,
      jpegQuality: IMAGE_THUMBNAIL_JPEG_QUALITY,
    });
    // 原图本来就在显示尺寸内时，再产一份等大副本只是白占缓存
    if (!resized?.wasResized || !resized.data) return undefined;
    return {
      data: Buffer.from(resized.data, "base64"),
      mimeType: resized.mimeType,
      width: resized.width,
      height: resized.height,
    };
  } catch {
    return undefined;
  }
}

/**
 * 缩略图字节：LRU 缓存 → 限流 → 超预算先返回 undefined（生成继续在后台跑完并进缓存）。
 * previewWorkspaceFile 与 mybuddy-artifact://?variant=thumb 共用同一份缓存。
 */
function thumbnailBytesFor(
  buffer: Buffer,
  ext: string,
  cacheKey: string,
): Promise<ThumbnailBytes | undefined> {
  if (thumbnailCache.has(cacheKey)) {
    const hit = thumbnailCache.get(cacheKey);
    if (hit) touchThumbnailCache(cacheKey, hit);
    return Promise.resolve(hit);
  }
  if (!THUMBNAILABLE_IMAGE_EXTENSIONS.has(ext)) return Promise.resolve(undefined);
  const job = withThumbnailSlot(() => resizeToThumbnail(buffer, ext))
    .catch(() => undefined)
    .then((bytes) => {
      touchThumbnailCache(cacheKey, bytes);
      return bytes;
    });
  return Promise.race([
    job,
    new Promise<undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), IMAGE_THUMBNAIL_INLINE_BUDGET_MS);
      (timer as unknown as { unref?: () => void }).unref?.();
    }),
  ]);
}

/**
 * 协议层唯一图片字节入口（P0）：renderer 只拿 URL，绝不拿 base64。
 * - full：原图（只由"查看原图"/产物面板点击触发）
 * - thumb：长边 1280 的降采样副本；不支持/生成超时/本来就在显示尺寸内 → 原图字节
 */
export async function workspaceImageVariant(
  filePath: string,
  variant: "thumb" | "full",
): Promise<{ data: Buffer; mimeType: string } | null> {
  try {
    const buffer = await readFile(filePath);
    const ext = extname(filePath).toLowerCase();
    const mimeType = imageMime(ext);
    if (variant === "full") return { data: buffer, mimeType };
    const st = await stat(filePath);
    const thumb = await thumbnailBytesFor(buffer, ext, thumbnailCacheKey(filePath, st));
    return thumb ? { data: thumb.data, mimeType: thumb.mimeType } : { data: buffer, mimeType };
  } catch {
    return null;
  }
}

export async function previewWorkspaceFile(
  filePath: string,
  options?: PreviewWorkspaceFileOptions,
): Promise<WorkspaceFilePreviewDto> {
  const name = basename(filePath);
  const ext = extname(name).toLowerCase();
  const kind = artifactKindForFile(filePath);
  if (kind === "docx" || kind === "xlsx" || kind === "pptx") {
    const st = await stat(filePath);
    if (st.size > OFFICE_PREVIEW_MAX_BYTES) {
      return {
        path: filePath,
        name,
        kind,
        content: OFFICE_PREVIEW_SKIP_MARKER,
        language: ext.slice(1) || undefined,
      };
    }
  }
  const buffer = await readFile(filePath);
  let content: string;
  let thumbnail: WorkspaceFileThumbnailDto | undefined;
  let size: { width: number; height: number } | null = null;
  if (kind === "docx" || kind === "xlsx" || kind === "pptx") {
    // Wave 5D-1：Office 以二进制 data URI 透传（viewer 渲染字节；文本抽取走 officeTextPreview）
    content = `data:${officeMime(kind)};base64,${buffer.toString("base64")}`;
  } else if (kind === "pdf") content = `data:application/pdf;base64,${buffer.toString("base64")}`;
  else if (kind === "image") {
    // 固有尺寸来自文件头：给渲染端在加载完成前钉住行高的依据
    size = imageIntrinsicSize(buffer);
    const st = await stat(filePath);
    if (options?.inlineImage) {
      // 内联链路（Artifact Domain → ChatImage）绝不生成原图 base64：content 由
      // ArtifactService 换成 mybuddy-artifact://?variant=full 的协议 URL。
      // 超体积上限也只回缩略图元数据 + path，原图字节只走协议、不过 IPC。
      content = "";
    } else {
      // 其它调用方（历史预览 / 索引）仍按旧契约拿 data URI
      content = `data:${imageMime(ext)};base64,${buffer.toString("base64")}`;
    }
    if (options?.thumbnail) {
      if (options?.inlineImage && size) {
        // 内联链路不和协议请求抢着算缩略图：尺寸元数据直接来自文件头，
        // 字节由 ?variant=thumb 按需生成并进缓存，同一张图只算一次。
        thumbnail = {
          width: size.width,
          height: size.height,
          mimeType: imageMime(ext),
          bytes: buffer.length,
        };
      } else {
        const thumb = await thumbnailBytesFor(buffer, ext, thumbnailCacheKey(filePath, st));
        if (thumb) {
          thumbnail = {
            width: thumb.width,
            height: thumb.height,
            mimeType: thumb.mimeType,
            bytes: thumb.data.byteLength,
          };
        }
      }
    }
  } else if (kind === "video" || kind === "audio") content = `data:${mediaMime(kind, ext)};base64,${buffer.toString("base64")}`;
  else if (kind === "cad") {
    // Mechanical CAD 二进制（FCStd/STL/GLB）：绝不按 UTF-8 文本解析；base64 透传保字节
    content = `data:application/octet-stream;base64,${buffer.toString("base64")}`;
  } else content = buffer.toString("utf-8");
  return {
    path: filePath,
    name,
    kind,
    content,
    language: ext.slice(1) || undefined,
    bytes: buffer.length,
    ...(kind === "image" ? { mimeType: imageMime(ext) } : {}),
    ...(size ? { width: size.width, height: size.height } : {}),
    ...(thumbnail ? { thumbnail } : {}),
  };
}

function assertInsideRoot(root: string, target: string): void {
  const rel = relative(resolve(root), resolve(target));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("文件不在当前工作区内");
  }
}

function isInsideRoot(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export type WorkspaceCopyResult =
  | { ok: true; relativePath: string; alreadyThere: boolean }
  | WorkspaceMutationErr;

/**
 * 把工作区外（或另一任务工作区）的文件/文件夹复制进 dest root。
 * 源已在 dest 内则不复制，返回 alreadyThere。
 */
export async function copyExternalIntoWorkspace(
  root: string,
  absSource: string,
): Promise<WorkspaceCopyResult> {
  try {
    const destRoot = resolve(root);
    const source = resolve(absSource.trim());
    if (!absSource.trim()) throw new Error("源路径为空");
    const sourceStat = await stat(source);
    if (!sourceStat.isFile() && !sourceStat.isDirectory()) {
      throw new Error("不支持的文件类型");
    }
    if (resolve(source) === destRoot) throw new Error("不能复制工作区根目录");
    if (isInsideRoot(destRoot, source)) {
      return { ok: true, relativePath: toWorkspaceRel(destRoot, source), alreadyThere: true };
    }
    await mkdir(destRoot, { recursive: true });
    const destDirStat = await stat(destRoot);
    if (!destDirStat.isDirectory()) throw new Error("目标不是文件夹");
    const name = await uniqueChildName(destRoot, basename(source));
    const dest = join(destRoot, name);
    assertInsideRoot(destRoot, dest);
    await cp(source, dest, { recursive: true, errorOnExist: true, force: false });
    return { ok: true, relativePath: toWorkspaceRel(destRoot, dest), alreadyThere: false };
  } catch (error) {
    return fail(error);
  }
}

export interface WorkspaceMutationOk {
  ok: true;
  relativePath: string;
}

export interface WorkspaceMutationErr {
  ok: false;
  error: string;
}

export type WorkspaceMutationResult = WorkspaceMutationOk | WorkspaceMutationErr;

const INVALID_NAME = /[\\/]/;

/** 相对路径统一为正斜杠，与 listWorkspaceFiles 一致 */
export function toWorkspaceRel(root: string, target: string): string {
  const rel = relative(resolve(root), resolve(target));
  if (!rel || rel === ".") return "";
  return rel.split(sep).join("/");
}

export function resolveWorkspaceTarget(root: string, relativePath = ""): string {
  const target = relativePath.trim() ? resolve(root, relativePath) : resolve(root);
  assertInsideRoot(root, target);
  return target;
}

export function assertSafeEntryName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("名称不能为空");
  if (trimmed === "." || trimmed === "..") throw new Error("名称不合法");
  if (INVALID_NAME.test(trimmed)) throw new Error("名称不能包含路径分隔符");
  return trimmed;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function uniqueChildName(dir: string, name: string): Promise<string> {
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  let candidate = name;
  for (let i = 1; i < 1000; i += 1) {
    if (!(await pathExists(join(dir, candidate)))) return candidate;
    candidate = `${stem} (${i})${ext}`;
  }
  throw new Error("无法生成唯一名称");
}

function fail(error: unknown): WorkspaceMutationErr {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

/** 重命名工作区内文件/文件夹（同级改名） */
export async function renameWorkspacePath(
  root: string,
  relativePath: string,
  newName: string,
): Promise<WorkspaceMutationResult> {
  try {
    const source = resolveWorkspaceTarget(root, relativePath);
    if (resolve(source) === resolve(root)) throw new Error("不能重命名工作区根目录");
    const name = assertSafeEntryName(newName);
    const dest = join(dirname(source), name);
    assertInsideRoot(root, dest);
    if (resolve(source) === resolve(dest)) return { ok: true, relativePath: toWorkspaceRel(root, dest) };
    if (await pathExists(dest)) throw new Error("目标名称已存在");
    await rename(source, dest);
    return { ok: true, relativePath: toWorkspaceRel(root, dest) };
  } catch (error) {
    return fail(error);
  }
}

/** 将工作区内文件/文件夹移到目标文件夹（destRel 空 = 工作区根） */
export async function moveWorkspacePath(
  root: string,
  fromRel: string,
  destDirRel: string,
): Promise<WorkspaceMutationResult> {
  try {
    const source = resolveWorkspaceTarget(root, fromRel);
    if (resolve(source) === resolve(root)) throw new Error("不能移动工作区根目录");
    const destDir = resolveWorkspaceTarget(root, destDirRel);
    const destStat = await stat(destDir);
    if (!destStat.isDirectory()) throw new Error("目标不是文件夹");
    const dest = join(destDir, basename(source));
    assertInsideRoot(root, dest);
    if (resolve(source) === resolve(dest)) return { ok: true, relativePath: toWorkspaceRel(root, dest) };
    const sourceRel = toWorkspaceRel(root, source);
    const destDirNorm = toWorkspaceRel(root, destDir);
    if (destDirNorm === sourceRel || destDirNorm.startsWith(`${sourceRel}/`)) {
      throw new Error("不能将文件夹移入自身");
    }
    if (await pathExists(dest)) throw new Error("目标位置已存在同名文件");
    await rename(source, dest);
    return { ok: true, relativePath: toWorkspaceRel(root, dest) };
  } catch (error) {
    return fail(error);
  }
}

/** 在工作区创建空文件或文件夹 */
export async function createWorkspacePath(
  root: string,
  parentRel: string,
  name: string,
  kind: "file" | "folder",
): Promise<WorkspaceMutationResult> {
  try {
    const parent = resolveWorkspaceTarget(root, parentRel);
    const parentStat = await stat(parent);
    if (!parentStat.isDirectory()) throw new Error("父目录不是文件夹");
    const safe = assertSafeEntryName(name);
    const unique = await uniqueChildName(parent, safe);
    const dest = join(parent, unique);
    assertInsideRoot(root, dest);
    if (kind === "folder") await mkdir(dest);
    else await writeFile(dest, "", "utf8");
    return { ok: true, relativePath: toWorkspaceRel(root, dest) };
  } catch (error) {
    return fail(error);
  }
}

export async function readWorkspaceFile(root: string, relativePath: string): Promise<WorkspaceFilePreviewDto> {
  const target = resolve(root, relativePath);
  assertInsideRoot(root, target);
  return previewWorkspaceFile(target);
}

export async function listWorkspaceFiles(root: string): Promise<WorkspaceFileNodeDto[]> {
  const resolvedRoot = resolve(root);
  const rootStat = await stat(resolvedRoot);
  if (!rootStat.isDirectory()) throw new Error("工作区路径不是文件夹");
  let seen = 0;
  const walk = async (dir: string, prefix = "", depth = 0): Promise<WorkspaceFileNodeDto[]> => {
    if (depth > 12 || seen > 5000) return [];
    const entries = await readdir(dir, { withFileTypes: true });
    const nodes: WorkspaceFileNodeDto[] = [];
    for (const entry of entries) {
      if (isInternalTaskFile(entry.name)) continue;
      if (entry.name.startsWith(".") && entry.isDirectory()) continue;
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        const children = await walk(absolutePath, relativePath, depth + 1);
        nodes.push({ name: entry.name, path: relativePath, kind: "folder", children });
      } else if (entry.isFile()) {
        // 文件树展示磁盘实文件；产物黑名单只过滤产物面板/芯片，不藏工作空间文件
        seen += 1;
        nodes.push({ name: entry.name, path: relativePath, kind: "file" });
      }
    }
    return nodes.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name, "zh-CN", { numeric: true }) : a.kind === "folder" ? -1 : 1);
  };
  return walk(resolvedRoot);
}

/**
 * 工作目录快照：产物 diff 的**唯一**口径。
 *
 * 没有 unfiltered 参数：baseline（会话打开/回合开始）与 after（回合结束）必须走完全相同的
 * 过滤规则，否则两份快照的路径集合不重叠，既有项目文件会被整体误判为「本轮新增产物」。
 */
export async function snapshotWorkspace(root: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  const files: string[] = [];
  const visit = async (dir: string, depth = 0): Promise<void> => {
    if (depth > 12 || files.length >= WORKSPACE_SNAPSHOT_FILE_LIMIT) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= WORKSPACE_SNAPSHOT_FILE_LIMIT) break;
      if (isInternalTaskFile(entry.name)) continue;
      if (entry.isDirectory() && (
        entry.name.startsWith(".") ||
        IGNORED_DIRECTORIES.has(entry.name) ||
        GENERATED_DIRECTORIES.has(entry.name)
      )) continue;
      const fullPath = resolve(dir, entry.name);
      if (entry.isDirectory()) await visit(fullPath, depth + 1);
      else if (entry.isFile()) files.push(fullPath);
    }
  };
  await visit(resolve(root));

  // 元数据读取是 workspace snapshot 的主要 I/O 成本。目录遍历保持串行、可预测；
  // 文件 stat 采用有限并发，避免 5000 个串行 await，也避免 Promise.all(5000) 瞬时打满文件系统。
  const STAT_BATCH_SIZE = 64;
  for (let offset = 0; offset < files.length; offset += STAT_BATCH_SIZE) {
    const batch = files.slice(offset, offset + STAT_BATCH_SIZE);
    const rows = await Promise.all(batch.map(async (fullPath) => {
      try {
        const info = await stat(fullPath);
        return [fullPath, `${info.size}:${info.mtimeMs}`] as const;
      } catch {
        return null;
      }
    }));
    for (const row of rows) if (row) snapshot.set(row[0], row[1]);
  }
  return snapshot;
}

export interface WorkspaceSnapshotDiff {
  /** 本轮真实变化的文件；基线不可信时为空数组 */
  changed: string[];
  /** 非空表示 diff 被整体拒绝，调用方应打日志并跳过登记，绝不能退化为「全量当新增」 */
  rejected?: string;
}

/**
 * before/after 快照 diff。两道保险丝防止把整个工作目录灌进产物列表：
 *  1. 基线路径重叠率 < 50%：说明两份快照口径不一致或工作目录被整体换掉；
 *  2. 单轮变化超过 MAX_TURN_WORKSPACE_CHANGES：说明是外部批量构建/误扫描，不是 Agent 交付物。
 * 正常轮次（含一次性生成几十个文件）不受影响；真实工具 write/edit 另有即时登记通道。
 */
export function diffWorkspaceSnapshot(
  before: Map<string, string>,
  after: Map<string, string>,
): WorkspaceSnapshotDiff {
  let overlap = 0;
  for (const path of before.keys()) if (after.has(path)) overlap += 1;
  if (before.size > 0 && overlap / before.size < 0.5) {
    return {
      changed: [],
      rejected: `基线失配（before=${before.size}, after=${after.size}, 路径重叠=${overlap}）`,
    };
  }
  const changed: string[] = [];
  for (const [path, signature] of after) {
    if (before.get(path) === signature) continue;
    changed.push(path);
  }
  if (changed.length > MAX_TURN_WORKSPACE_CHANGES) {
    return {
      changed: [],
      rejected: `单轮变化 ${changed.length} 个文件，超过上限 ${MAX_TURN_WORKSPACE_CHANGES}`,
    };
  }
  return { changed };
}
