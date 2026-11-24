import { shell, type BrowserWindow, type WebContents } from "electron";
import { showOpenFileDialog, showSaveFileDialog } from "../FileDialogService";
import { readFileSync, statSync } from "node:fs";
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { promisify } from "node:util";
import { gzip, gunzip } from "node:zlib";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom/worker";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import JSZip from "jszip";
import { LIBRARY_INLINE_FILE_MAX_BYTES, type LibraryItemDto, type LibraryNoteOperation, type LibraryNoteOperationResults } from "../../shared/library-ipc";
import type { BrowserHost } from "../browser/BrowserHost";
import type { LibraryService } from "./LibraryService";
import { libraryNotesBackup } from "./library-note-backup";
import { rewriteNoteLinks } from "./library-note-links";

const IMAGE_LIMIT = 20 * 1024 * 1024;
const NOTE_IMAGE_TYPES = new Map([
  ["png", "image/png"], ["jpg", "image/jpeg"], ["jpeg", "image/jpeg"], ["gif", "image/gif"],
  ["webp", "image/webp"], ["avif", "image/avif"], ["bmp", "image/bmp"],
]);
const BACKUP_LIMIT = 256 * 1024 * 1024;
const NOTE_LINK = /^mybuddy-library:\/\/local\/([A-Za-z0-9_-]+)\/?$/;
const printing = new WeakSet<WebContents>();
const DOCUMENT_STYLE = "body{background:white;color:#222;font:15px/1.6 system-ui,sans-serif;max-width:820px;margin:40px auto;padding:0 20px}img{max-width:100%}pre{white-space:pre-wrap;background:#eee;padding:12px}td,th{border:1px solid #aaa;padding:4px 8px}table{border-collapse:collapse}";
const Turndown = TurndownService as new (options: { headingStyle: "atx"; codeBlockStyle: "fenced" }) => {
  use(plugin: typeof gfm): void;
  turndown(html: string): string;
};
const clipMarkdown = new Turndown({ headingStyle: "atx", codeBlockStyle: "fenced" });
clipMarkdown.use(gfm);

export async function runLibraryNoteOperation(library: LibraryService, browser: BrowserHost, parent: BrowserWindow | null, request: LibraryNoteOperation) {
  switch (request.type) {
    case "trashList": return library.listTrashedNotes(request.owner);
    case "metadata": return library.setNoteMetadata(request.owner, request.id, request);
    case "trash": return library.setNoteTrashed(request.owner, request.ids, true);
    case "restore": return library.setNoteTrashed(request.owner, request.ids, false);
    case "move": return library.moveNotes(request.owner, request.ids, request.collectionId);
    case "merge": return library.mergeNotes(request.owner, request.ids);
    case "versions":
      if (!library.getItem(request.id)) throw new Error("笔记已不可用");
      return library.listVersions(request.id);
    case "readVersion": return library.readVersion(request.id, request.version);
    case "noteImage": return library.noteImageUrl(request.id, request.href, request.version);
    case "restoreVersion": {
      library.requireOwnedNoteItems(request.owner, [request.id]);
      return library.writeContent({ id: request.id, content: library.readVersion(request.id, request.version),
        expectedContentHash: request.expectedContentHash });
    }
    case "addImage": {
      const [note] = library.requireOwnedNoteItems(request.owner, [request.id]);
      return library.previewUrl(library.addNoteImage(request.owner, note.spaceId, note.collectionId, request.name, request.mime, request.bytes).id);
    }
    case "pickImages": return pickNoteImages(library, parent, request);
    case "openLink":
      if (!/^https?:$/i.test(new URL(request.url).protocol)) throw new Error("只能打开 HTTP 或 HTTPS 网页");
      await shell.openExternal(request.url);
      return;
    case "attachment": {
      const item = library.getItem(request.id);
      const asset = item && ["office", "pdf"].includes(item.kind) ? library.resolvePreview(item.id, "") : null;
      if (!asset) throw new Error("附件预览不可用");
      if (statSync(asset.path).size > LIBRARY_INLINE_FILE_MAX_BYTES) throw new Error("请通过「打开位置」访问大型附件");
      return "data:" + asset.mime + ";base64," + readFileSync(asset.path).toString("base64");
    }
    case "importFolder": {
      if (request.spaceId) library.requireOwnedNoteDestination(request.owner, request.spaceId, request.collectionId);
      const options: Electron.OpenDialogOptions = { title: "导入本地文件夹", properties: ["openDirectory"] };
      const selection = await showOpenFileDialog(parent, options);
      if (selection.canceled || !selection.filePaths[0]) return null;
      return library.importFolder({ ...request, sourcePath: selection.filePaths[0] });
    }
    case "backup": {
      const options = { defaultPath: "MyBuddy-笔记备份.mynotes", filters: [{ name: "MyBuddy 笔记备份", extensions: ["mynotes"] }] };
      const result = await showSaveFileDialog(parent, options);
      if (result.canceled || !result.filePath) return false;
      const archive = JSON.stringify(libraryNotesBackup.parse(library.createNoteBackup(request.owner)));
      if (Buffer.byteLength(archive) > BACKUP_LIMIT) throw new Error("资料超过单份本地备份的大小上限");
      await writeFile(result.filePath, await promisify(gzip)(archive));
      return true;
    }
    case "restoreBackup": {
      const options: Electron.OpenDialogOptions = { properties: ["openFile"], filters: [{ name: "MyBuddy 笔记备份", extensions: ["mynotes"] }] };
      const result = await showOpenFileDialog(parent, options);
      const path = result.filePaths[0];
      if (result.canceled || !path) return null;
      if ((await stat(path)).size > BACKUP_LIMIT) throw new Error("备份文件过大");
      const json = await promisify(gunzip)(await readFile(path), { maxOutputLength: BACKUP_LIMIT });
      const parsed = libraryNotesBackup.safeParse(JSON.parse(json.toString("utf8")));
      if (!parsed.success) throw new Error("这不是有效的 MyBuddy 笔记备份");
      return library.restoreNoteBackup(request.owner, parsed.data);
    }
    case "export": return exportNotes(library, parent, request);
    case "clip": return clipPage(library, browser, request);
  }
}

async function pickNoteImages(
  library: LibraryService,
  parent: BrowserWindow | null,
  { owner, id }: Extract<LibraryNoteOperation, { type: "pickImages" }>,
): Promise<LibraryNoteOperationResults["pickImages"]> {
  const getNote = () => {
    const [note] = library.requireOwnedNoteItems(owner, [id]);
    if (note.kind !== "markdown") throw new Error("请选择可编辑的笔记");
    return note;
  };
  getNote();
  const selection = await showOpenFileDialog(parent, {
    title: "插入图片", buttonLabel: "插入", properties: ["openFile", "multiSelections"],
    filters: [{ name: "图片", extensions: [...NOTE_IMAGE_TYPES.keys()] }],
  });
  const images: LibraryNoteOperationResults["pickImages"]["images"] = [];
  const errors: string[] = [];
  if (selection.canceled) return { images, errors };
  for (const path of selection.filePaths) {
    const name = basename(path);
    try {
      const mime = NOTE_IMAGE_TYPES.get(extname(name).slice(1).toLowerCase());
      if (!mime) throw new Error("请选择 PNG、JPEG、GIF、WebP、AVIF 或 BMP 图片");
      const bytes = await readPickedImage(path);
      if (!matchesImageMime(bytes, mime)) throw new Error("图片内容与文件格式不符");
      const note = getNote();
      const image = library.addNoteImage(owner, note.spaceId, note.collectionId, name, mime, bytes);
      images.push({ name, url: library.previewUrl(image.id) });
    } catch (error) {
      errors.push(`${name}：${error instanceof Error ? error.message : "无法导入图片"}`);
    }
  }
  return { images, errors };
}

async function readPickedImage(path: string): Promise<Buffer> {
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile() || !info.size) throw new Error("图片为空或不可读取");
    if (info.size > IMAGE_LIMIT) throw new Error("图片大小超过 20 MiB");
    const bytes = Buffer.allocUnsafe(info.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== info.size) throw new Error("读取期间图片已更改，请重新选择");
    return bytes.subarray(0, length);
  } finally {
    await file.close();
  }
}

function matchesImageMime(bytes: Buffer, mime: string): boolean {
  const header = (start: number, end: number) => bytes.toString("latin1", start, end);
  switch (mime) {
    case "image/png": return bytes.length >= 24 && header(0, 8) === "\x89PNG\r\n\x1a\n";
    case "image/jpeg": return bytes.length >= 4 && header(0, 3) === "\xff\xd8\xff";
    case "image/gif": return bytes.length >= 13 && /^GIF8[79]a$/.test(header(0, 6));
    case "image/webp": return bytes.length >= 16 && header(0, 4) === "RIFF" && header(8, 12) === "WEBP";
    case "image/bmp": return bytes.length >= 26 && header(0, 2) === "BM";
    case "image/avif": {
      if (bytes.length < 16 || header(4, 8) !== "ftyp") return false;
      if (/^avi[fs]$/.test(header(8, 12))) return true;
      const boxLength = Math.min(bytes.readUInt32BE(0), bytes.length);
      for (let offset = 16; offset + 4 <= boxLength; offset += 4) {
        if (/^avi[fs]$/.test(header(offset, offset + 4))) return true;
      }
      return false;
    }
    default: return false;
  }
}

async function clipPage(library: LibraryService, browser: BrowserHost, request: Extract<LibraryNoteOperation, { type: "clip" }>) {
  library.requireOwnedNoteDestination(request.owner, request.spaceId, request.collectionId);
  const host = browser.getTabHost(request.tabId);
  const wc = host?.inspectionWebContents;
  if (!host || !wc || wc.isDestroyed() || browser.activeTabId !== request.tabId || wc.isLoadingMainFrame()) {
    throw new Error("请先打开要剪藏的网页并等它加载完成");
  }
  const url = wc.getURL();
  if (!/^https?:\/\//i.test(url)) throw new Error("此页面无法剪藏");
  const generation = host.captureVersion;
  const page = await wc.executeJavaScriptInIsolatedWorld(999, [{ code: "(" + function (selection: boolean) {
    let html: string;
    if (selection) {
      const selected = window.getSelection();
      const wrapper = document.createElement("div");
      if (selected) for (let i = 0; i < selected.rangeCount; i++) wrapper.append(selected.getRangeAt(i).cloneContents());
      html = wrapper.innerHTML;
    } else {
      html = document.documentElement.outerHTML;
    }
    return { url: location.href, base: document.baseURI, title: document.title, html };
  }.toString() + ")(" + (request.selection === true) + ")" }]) as { url: string; base: string; title: string; html: string };
  if (wc.isDestroyed() || browser.activeTabId !== request.tabId || host.captureVersion !== generation || page.url !== url || wc.getURL() !== url) {
    throw new Error("剪藏期间网页已切换，请重试");
  }
  const capturedAt = Date.now();
  const pageDocument = parseHTML(request.selection ? "<html><body>" + page.html + "</body></html>" : page.html).document;
  for (const node of pageDocument.querySelectorAll("script,style,noscript,iframe,object,embed,form")) node.remove();
  for (const anchor of pageDocument.querySelectorAll("a[href]")) {
    const href = toWebUrl(anchor.getAttribute("href"), page.base);
    if (href) anchor.setAttribute("href", href);
    else anchor.removeAttribute("href");
  }
  for (const img of pageDocument.querySelectorAll("img")) {
    const src = img.getAttribute("data-src") || img.getAttribute("data-original") || img.getAttribute("src");
    const resolved = toWebUrl(src, page.base);
    if (resolved) img.setAttribute("src", resolved);
    img.removeAttribute("srcset");
  }
  const article = request.selection ? null : new Readability(pageDocument as unknown as Document).parse();
  if (!request.selection && !article?.content) throw new Error("这页未提取到文章正文，可以选中需要的内容再剪藏");
  const content = parseHTML("<html><body>" + (article?.content ?? pageDocument.body.innerHTML) + "</body></html>").document.body;
  const initial = clipMarkdown.turndown(content.innerHTML).trim();
  if (!content.textContent?.trim() && !content.querySelector("img[src]")) {
    throw new Error(request.selection ? "请先选中网页上的文字或图片" : "这页未提取到文章正文");
  }
  const capturedImages = new Map<string, { bytes: Uint8Array; mime: string } | null>();
  const failedImages = new Set<string>();
  let imageBytes = 0;
  for (const img of content.querySelectorAll("img[src]")) {
    const src = img.getAttribute("src")!;
    if (capturedImages.has(src)) continue;
    try {
      if (!toWebUrl(src, page.base) || capturedImages.size >= 15 || imageBytes >= IMAGE_LIMIT * 2) throw new Error("无法保存图片");
      const image = await fetchImage(wc.session, src);
      imageBytes += image.bytes.byteLength;
      capturedImages.set(src, image);
    } catch {
      capturedImages.set(src, null);
      failedImages.add(src);
    }
  }
  library.requireOwnedNoteDestination(request.owner, request.spaceId, request.collectionId);
  const createdImages: LibraryItemDto[] = [];
  const stored = new Map<string, string>();
  try {
    for (const [src, image] of capturedImages) {
      if (!image) continue;
      try {
        const item = library.addNoteImage(request.owner, request.spaceId, request.collectionId, basename(new URL(src).pathname), image.mime, image.bytes);
        createdImages.push(item);
        stored.set(src, library.previewUrl(item.id));
      } catch { failedImages.add(src); }
    }
    for (const img of content.querySelectorAll("img[src]")) {
      const src = img.getAttribute("src")!;
      const local = stored.get(src);
      if (local) img.setAttribute("src", local);
      else if (!toWebUrl(src, page.base)) img.replaceWith(content.ownerDocument.createTextNode(img.getAttribute("alt") || "图片未保存"));
    }
    const title = (article?.title || page.title || "网页剪藏").trim().slice(0, 200);
    const item = library.createItem({ spaceId: request.spaceId, collectionId: request.collectionId, kind: "markdown",
      title, content: clipMarkdown.turndown(content.innerHTML).trim() || initial }, { url, title: page.title || title, capturedAt,
      failedImages: failedImages.size ? [...failedImages] : undefined },
      [...new Set(request.tags.map((tag) => tag.trim()).filter(Boolean))]);
    return { item, failedImages: [...failedImages] };
  } catch (error) {
    for (const item of createdImages) {
      try { library.deleteItem(item.id); } catch (cleanupError) { console.warn("[Notes] 图片清理失败", cleanupError); }
    }
    throw error;
  }
}

function toWebUrl(value: string | null, base: string): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value, base);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : null;
  } catch { return null; }
}

async function fetchImage(session: Electron.Session, url: string): Promise<{ bytes: Uint8Array; mime: string }> {
  const response = await session.fetch(url, { credentials: "omit", redirect: "error", signal: AbortSignal.timeout(6000) });
  const mime = response.headers.get("content-type")?.split(";")[0]?.toLowerCase() ?? "";
  if (!response.ok || !response.body || !/^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(mime)
    || Number(response.headers.get("content-length")) > IMAGE_LIMIT) {
    await response.body?.cancel();
    throw new Error("无法保存此图片");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > IMAGE_LIMIT) { await reader.cancel(); throw new Error("图片超过大小限制"); }
    chunks.push(value);
  }
  return { bytes: Buffer.concat(chunks, size), mime };
}

async function exportNotes(library: LibraryService, parent: BrowserWindow | null, request: Extract<LibraryNoteOperation, { type: "export" }>) {
  const content = [...new Set(request.ids)].map((id) => library.readContent(id));
  if (!content.length || content.some((entry) => entry.item.kind !== "markdown")) throw new Error("请选择要导出的 Markdown 笔记");
  if (content.some((entry) => entry.contentTooLarge)) throw new Error("请通过「打开位置」复制大型资料原文件");
  const [first] = content;
  const format = request.format;
  const assets = new Map<string, { path: string; mime: string; name: string }>();
  const findAsset = (id: string, source: LibraryItemDto) => {
    const item = library.getItem(id);
    if (!item || item.spaceId !== source.spaceId || item.kind === "markdown") return;
    const asset = library.resolvePreview(id, "");
    if (!asset) return;
    const record = { ...asset, name: id + extname(item.filename) };
    assets.set(id, record);
    return record;
  };
  const portable = (entry: typeof first, directory: string) => rewriteNoteLinks(entry.content, (href) => {
    const id = NOTE_LINK.exec(href)?.[1];
    const asset = id && findAsset(id, entry.item);
    return asset ? directory + "/" + asset.name : undefined;
  });
  const archive = format === "markdown" && content.length > 1;
  const ext = archive ? "zip" : format === "markdown" ? "md" : format;
  const options = { defaultPath: first.item.title.replace(/[<>:"/\\|?*]/g, "_").slice(0, 120) + "." + ext,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }] };
  const result = await showSaveFileDialog(parent, options);
  if (result.canceled || !result.filePath) return false;
  if (archive) {
    const zip = new JSZip();
    for (const doc of content) zip.file(doc.item.title.replace(/[<>:"/\\|?*]/g, "_").slice(0, 120) + "-" + doc.item.id + ".md", portable(doc, "assets"));
    for (const asset of assets.values()) zip.file("assets/" + asset.name, readFileSync(asset.path));
    await writeFile(result.filePath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  } else if (format === "markdown") {
    const directory = basename(result.filePath, extname(result.filePath)) + ".assets";
    const markdown = portable(first, encodeURIComponent(directory));
    if (assets.size) {
      const path = join(dirname(result.filePath), directory);
      await mkdir(path, { recursive: true });
      for (const asset of assets.values()) await writeFile(join(path, asset.name), readFileSync(asset.path));
    }
    await writeFile(result.filePath, markdown, "utf8");
  } else {
    if (content.length !== 1 || typeof request.html !== "string") throw new Error("每次导出一篇 HTML 或 PDF 笔记");
    const parsed = parseHTML("<html><body>" + request.html + "</body></html>").document;
    for (const node of parsed.querySelectorAll("script, iframe, object, embed, link, meta, base, form, video, audio, source, style")) node.remove();
    for (const node of parsed.body.querySelectorAll("*")) {
      for (const field of Array.from(node.attributes)) {
        if (!["href", "src", "alt", "title", "class", "colspan", "rowspan", "type", "checked", "disabled", "xmlns"].includes(field.name)) node.removeAttribute(field.name);
      }
      const href = node.getAttribute("href");
      if (href && !/^(https?:\/\/|mailto:|#|mybuddy-library:\/\/local\/)/i.test(href)) node.removeAttribute("href");
      const src = node.getAttribute("src");
      if (!src) continue;
      const id = NOTE_LINK.exec(src)?.[1];
      const asset = id ? findAsset(id, first.item) : !/[:?#\\/]/.test(src) ? library.resolvePreview(first.item.id, decodeURIComponent(src)) : null;
      if (asset && /^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(asset.mime)) {
        node.setAttribute("src", "data:" + asset.mime + ";base64," + readFileSync(asset.path).toString("base64"));
      } else if (!/^data:image\/(png|jpeg|gif|webp|avif|bmp);base64,/i.test(src)) node.removeAttribute("src");
    }
    const body = parsed.body.innerHTML;
    if (format === "html") {
      const html = "<!doctype html><html><head><meta charset=utf-8><meta http-equiv=Content-Security-Policy content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'\"><style>"
        + DOCUMENT_STYLE + "</style></head><body>" + body + "</body></html>";
      await writeFile(result.filePath, html, "utf8");
    } else {
      if (!parent || parent.isDestroyed()) throw new Error("笔记页面已关闭");
      await writeFile(result.filePath, await printNote(parent.webContents, body));
    }
  }
  return true;
}

async function printNote(contents: WebContents, html: string): Promise<Buffer> {
  if (printing.has(contents)) throw new Error("另一篇笔记正在导出 PDF，请稍后重试");
  printing.add(contents);
  const printCss = "#mybuddy-note-print{display:none!important}@media print{html,body{height:auto!important;overflow:visible!important;background:white!important;color:#222!important}"
    + "body:has(>#mybuddy-note-print)>:not(#mybuddy-note-print){display:none!important}#mybuddy-note-print{display:block!important}"
    + DOCUMENT_STYLE.replace(/(^|})([^}]+)\{/g, (_, start, selectors: string) =>
      start + selectors.split(",").map((selector) => selector === "body" ? "#mybuddy-note-print" : "#mybuddy-note-print " + selector).join(",") + "{") + "}";
  let inserted = false;
  try {
    await contents.executeJavaScriptInIsolatedWorld(999, [{ code: "(" + async function (html: string, css: string) {
      const style = document.createElement("style");
      style.id = "mybuddy-note-print-style";
      style.textContent = css;
      const printable = document.createElement("article");
      printable.id = "mybuddy-note-print";
      printable.innerHTML = html;
      document.head.append(style);
      document.body.append(printable);
      await Promise.all([...printable.querySelectorAll("img")].map((image) => image.decode().catch(() => {})));
    }.toString() + ")(" + JSON.stringify(html) + "," + JSON.stringify(printCss) + ")" }]);
    inserted = true;
    return await contents.printToPDF({ printBackground: true, pageSize: "A4" });
  } finally {
    if (inserted && !contents.isDestroyed()) {
      await contents.executeJavaScriptInIsolatedWorld(999, [{ code: "document.getElementById('mybuddy-note-print')?.remove();document.getElementById('mybuddy-note-print-style')?.remove();" }])
        .catch(() => {});
    }
    printing.delete(contents);
  }
}
