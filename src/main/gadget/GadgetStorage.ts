import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import type { GadgetManifest, GadgetSourceFile, GadgetSourceSnapshot, GadgetSourceUpdateRequest } from "../../shared/gadget-types";
import { normalizeGadgetManifest } from "../../shared/gadget-types";
import { isBlueprintSensitivePath, redactBlueprintSecrets } from "../../shared/blueprint-secret-policy";

const EXCLUDED = new Set(["node_modules", "cache", ".next", "dist", "build", ".mybuddy-task.json"]);
const MAX_BLUEPRINT_FILE_BYTES = 4 * 1024 * 1024;
const MAX_BLUEPRINT_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_SOURCE_FILES = 512;

function htmlAttribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return match ? match[1] ?? match[2] ?? match[3] ?? null : null;
}

/** Legacy Agents sometimes persisted a file:// trampoline instead of the actual Gadget HTML. */
function legacyLocalHtmlTarget(html: string): string | null {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    if (htmlAttribute(tag, "http-equiv")?.trim().toLowerCase() !== "refresh") continue;
    const content = htmlAttribute(tag, "content")?.trim();
    if (!content) continue;
    const target = /^\d+(?:\.\d+)?\s*;\s*url\s*=\s*(file:\/\/\/.+)$/i.exec(content)?.[1]?.trim();
    if (target) return target.replace(/^(?:"|')|(?:"|')$/g, "");
  }
  return null;
}

function isInside(root: string, candidate: string): boolean {
  const base = resolve(root);
  const target = resolve(candidate);
  return target === base || target.startsWith(base + sep);
}

function safeRelativePath(raw: string): string {
  const normalized = raw.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    !normalized || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized) || normalized.includes("\0") ||
    normalized.split("/").some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part) || /[<>:"|?*\x00-\x1f]/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
  ) {
    throw new Error(`Gadget 文件路径无效：${raw}`);
  }
  if (normalized.split("/").some((part) => EXCLUDED.has(part))) throw new Error(`Gadget 文件路径包含禁用目录：${raw}`);
  return normalized;
}

export class GadgetStorage {
  private readonly canonicalRootDir: string;

  constructor(private readonly rootDir: string) {
    mkdirSync(rootDir, { recursive: true });
    this.canonicalRootDir = realpathSync(rootDir);
  }

  paths(id: string): { root: string; manifestPath: string; sourcePath: string; dataPath: string } {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Gadget id 无效");
    const root = resolve(this.rootDir, id);
    if (!isInside(this.rootDir, root) || root === resolve(this.rootDir)) throw new Error("Gadget storage 路径越界");
    return { root, manifestPath: join(root, "gadget.json"), sourcePath: join(root, "code"), dataPath: join(root, "data") };
  }

  create(id: string, manifest: GadgetManifest, files?: GadgetSourceFile[]): ReturnType<GadgetStorage["paths"]> {
    const target = this.paths(id);
    if (existsSync(target.root)) throw new Error(`Gadget storage 已存在：${id}`);
    const normalized = normalizeGadgetManifest(manifest);
    const materialized = files?.length ? files : [{ path: normalized.entry, content: defaultHtml(normalized.name), encoding: "utf8" as const }];
    this.validateSourceFiles(materialized);
    mkdirSync(target.sourcePath, { recursive: true });
    mkdirSync(target.dataPath, { recursive: true });
    try {
      for (const file of materialized) this.writeSourceFile(id, file);
      if (!existsSync(join(target.sourcePath, ...normalized.entry.split("/")))) {
        throw new Error(`Gadget 入口文件不存在：${normalized.entry}`);
      }
      this.writeManifest(id, normalized);
      return target;
    } catch (error) {
      rmSync(target.root, { recursive: true, force: true });
      throw error;
    }
  }

  writeManifest(id: string, manifest: GadgetManifest): void {
    const target = this.paths(id);
    mkdirSync(target.root, { recursive: true });
    this.assertSafeStorage(id);
    if (existsSync(target.manifestPath) && lstatSync(target.manifestPath).isSymbolicLink()) {
      throw new Error("Gadget manifest 不得是符号链接");
    }
    const normalized = normalizeGadgetManifest(manifest);
    const temp = `${target.manifestPath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    try {
      renameSync(temp, target.manifestPath);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }

  readManifest(id: string): GadgetManifest {
    const target = this.paths(id);
    this.assertSafeStorage(id);
    const realRoot = realpathSync(target.root);
    const realManifest = realpathSync(target.manifestPath);
    if (!isInside(realRoot, realManifest)) throw new Error("Gadget manifest 符号链接越界");
    return normalizeGadgetManifest(JSON.parse(readFileSync(realManifest, "utf8")));
  }

  writeSourceFile(id: string, file: GadgetSourceFile): void {
    const target = this.paths(id);
    this.assertSafeStorage(id);
    const relativePath = safeRelativePath(file.path);
    const destination = resolve(target.sourcePath, ...relativePath.split("/"));
    if (!isInside(target.sourcePath, destination)) throw new Error(`Gadget 文件路径越界：${file.path}`);
    let cursor = target.sourcePath;
    for (const part of relativePath.split("/").slice(0, -1)) {
      cursor = join(cursor, part);
      if (existsSync(cursor)) {
        const info = lstatSync(cursor);
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Gadget 文件父路径不安全：${file.path}`);
      } else {
        mkdirSync(cursor);
      }
    }
    if (existsSync(destination) && lstatSync(destination).isSymbolicLink()) throw new Error(`Gadget 文件不得覆盖符号链接：${file.path}`);
    writeFileSync(destination, file.encoding === "base64" ? Buffer.from(file.content, "base64") : file.content);
  }

  readEntry(id: string): { manifest: GadgetManifest; content: string; path: string } {
    this.assertSafeStorage(id);
    const manifest = this.readManifest(id);
    const sourcePath = this.paths(id).sourcePath;
    const entryPath = resolve(sourcePath, ...manifest.entry.split("/"));
    if (!isInside(sourcePath, entryPath) || !existsSync(entryPath)) throw new Error(`Gadget 入口不存在：${manifest.entry}`);
    const realSource = realpathSync(sourcePath);
    const realEntry = realpathSync(entryPath);
    if (!isInside(realSource, realEntry)) throw new Error(`Gadget 入口符号链接越界：${manifest.entry}`);
    return { manifest, content: readFileSync(realEntry, "utf8"), path: realEntry };
  }

  /** Editing needs exact source, not the redacted Blueprint export. */
  readSource(id: string): GadgetSourceSnapshot {
    this.assertSafeStorage(id);
    const sourcePath = this.paths(id).sourcePath;
    const files: GadgetSourceFile[] = [];
    let totalBytes = 0;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = join(dir, entry.name);
        if (entry.isSymbolicLink()) throw new Error("Gadget 源码包含符号链接，不能编辑");
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.isFile()) throw new Error("Gadget 源码包含非普通文件");
        const size = lstatSync(full).size;
        totalBytes += size;
        if (size > MAX_BLUEPRINT_FILE_BYTES || totalBytes > MAX_BLUEPRINT_TOTAL_BYTES || files.length >= MAX_SOURCE_FILES) {
          throw new Error("Gadget 源码超过读取大小限制");
        }
        const bytes = readFileSync(full);
        const content = bytes.toString("utf8");
        const text = Buffer.from(content, "utf8").equals(bytes);
        files.push({ path: relative(sourcePath, full).replaceAll("\\", "/"), content: text ? content : bytes.toString("base64"), encoding: text ? "utf8" : "base64" });
      }
    };
    walk(sourcePath);
    this.validateSourceFiles(files);
    const manifest = this.readManifest(id);
    return { manifest, files, revision: createHash("sha256").update(JSON.stringify({ manifest, files })).digest("hex") };
  }

  updateSource(request: GadgetSourceUpdateRequest, commit: () => void): GadgetSourceSnapshot {
    const { gadgetId: id, files, expectedRevision } = request;
    const current = this.readSource(id);
    if (!expectedRevision || current.revision !== expectedRevision) throw new Error("Gadget 已被修改，请重新读取源码后再保存");
    if (!files.length) throw new Error("请提供要修改的 Gadget 源文件");
    this.validateSourceFiles(files);
    const merged = new Map(current.files.map((file) => [file.path.toLowerCase(), file]));
    for (const file of files) {
      const path = safeRelativePath(file.path);
      const old = merged.get(path.toLowerCase());
      merged.set(path.toLowerCase(), { ...file, path: old?.path ?? path });
    }
    this.validateSourceFiles([...merged.values()]);
    if (!merged.has(current.manifest.entry.toLowerCase())) throw new Error("Gadget 缺少入口文件");
    const paths = this.paths(id);
    const next = join(paths.root, `code.next-${randomUUID()}`);
    const previous = join(paths.root, `code.previous-${randomUUID()}`);
    mkdirSync(next);
    const applied: Array<{ destination: string; backup: string | null }> = [];
    try {
      for (const file of merged.values()) {
        const destination = resolve(next, ...safeRelativePath(file.path).split("/"));
        mkdirSync(resolve(destination, ".."), { recursive: true });
        writeFileSync(destination, file.encoding === "base64" ? Buffer.from(file.content, "base64") : file.content);
      }
      // The running host uses code/ as cwd; Windows cannot rename that directory.
      // Stage/validate the entire tree, then replace individual files atomically.
      for (const patch of files) {
        const file = merged.get(safeRelativePath(patch.path).toLowerCase())!;
        const destination = resolve(paths.sourcePath, ...file.path.split("/"));
        const backup = existsSync(destination) ? resolve(previous, ...file.path.split("/")) : null;
        if (backup) {
          mkdirSync(resolve(backup, ".."), { recursive: true });
          writeFileSync(backup, readFileSync(destination));
        }
        mkdirSync(resolve(destination, ".."), { recursive: true });
        renameSync(resolve(next, ...file.path.split("/")), destination);
        applied.push({ destination, backup });
      }
      const snapshot = this.readSource(id);
      commit();
      // A cleanup failure must not report a successful source/DB commit as a failed edit.
      try { rmSync(previous, { recursive: true, force: true }); }
      catch (error) { console.warn("[GadgetStorage] 保留源码备份", previous, error); }
      return snapshot;
    } catch (error) {
      for (const { destination, backup } of applied.reverse()) {
        if (backup) renameSync(backup, destination);
        else rmSync(destination, { force: true });
      }
      rmSync(previous, { recursive: true, force: true });
      throw error;
    } finally {
      try { rmSync(next, { recursive: true, force: true }); }
      catch (error) { console.warn("[GadgetStorage] 保留源码暂存目录", next, error); }
    }
  }

  /**
   * One-way repair for the old "Gadget = local file redirect" shape.
   * The explicit Open action imports the referenced single-file HTML into durable Gadget storage,
   * so the iframe renders the tool itself instead of a broken redirect/help page.
   */
  materializeLegacyLocalHtmlRedirect(id: string): boolean {
    const entry = this.readEntry(id);
    const fileUrl = legacyLocalHtmlTarget(entry.content);
    if (!fileUrl) return false;

    let target: string;
    try {
      target = fileURLToPath(fileUrl);
    } catch {
      throw new Error("Gadget 引用的本地 HTML 路径无效");
    }
    if (![".html", ".htm"].includes(extname(target).toLowerCase()) || !existsSync(target)) {
      throw new Error(`Gadget 引用的本地 HTML 不存在：${target}`);
    }
    const info = statSync(target);
    if (!info.isFile() || info.size > MAX_BLUEPRINT_FILE_BYTES) {
      throw new Error("Gadget 引用的本地 HTML 不是可导入的单文件看板");
    }

    const imported = readFileSync(target, "utf8");
    const temp = `${entry.path}.${process.pid}.${Date.now()}.import.tmp`;
    writeFileSync(temp, imported, "utf8");
    try {
      renameSync(temp, entry.path);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
    return true;
  }

  captureSource(id: string): { manifest: GadgetManifest; sourceFiles: GadgetSourceFile[] } {
    const paths = this.paths(id);
    this.assertSafeStorage(id);
    const sourceFiles: GadgetSourceFile[] = [];
    let totalBytes = 0;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (EXCLUDED.has(entry.name) || entry.name.startsWith(".cache") || isBlueprintSensitivePath(entry.name)) continue;
        const full = join(dir, entry.name);
        if (!isInside(paths.sourcePath, full)) continue;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        const info = lstatSync(full);
        if (info.size > MAX_BLUEPRINT_FILE_BYTES || totalBytes + info.size > MAX_BLUEPRINT_TOTAL_BYTES) {
          throw new Error("Gadget 源码超过 Blueprint 白名单大小限制");
        }
        totalBytes += info.size;
        const buffer = readFileSync(full);
        const rel = relative(paths.sourcePath, full).replaceAll("\\", "/");
        const text = buffer.toString("utf8");
        const roundTrip = Buffer.from(text, "utf8").equals(buffer);
        sourceFiles.push({ path: rel, content: roundTrip ? redactBlueprintSecrets(text) : buffer.toString("base64"), encoding: roundTrip ? "utf8" : "base64" });
      }
    };
    walk(paths.sourcePath);
    return { manifest: this.readManifest(id), sourceFiles };
  }

  delete(id: string): void {
    const target = this.paths(id).root;
    if (!isInside(this.rootDir, target) || target === resolve(this.rootDir)) throw new Error("拒绝删除越界 Gadget storage");
    rmSync(target, { recursive: true, force: true });
  }

  /** SQLite descriptor 是 durable truth；清理崩溃窗口留下的未提交目录。 */
  reconcile(validIds: ReadonlySet<string>): void {
    for (const entry of readdirSync(this.rootDir, { withFileTypes: true })) {
      if (!/^gdt-[a-zA-Z0-9-]+$/.test(entry.name) || validIds.has(entry.name)) continue;
      const target = resolve(this.rootDir, entry.name);
      if (!isInside(this.rootDir, target) || target === resolve(this.rootDir)) continue;
      try {
        const info = lstatSync(target);
        rmSync(target, { recursive: !info.isSymbolicLink(), force: true });
      } catch (error) {
        console.warn(`[GadgetStorage] 无法清理 orphan storage ${entry.name}`, error);
      }
    }
  }

  private validateSourceFiles(files: GadgetSourceFile[]): void {
    if (files.length > MAX_SOURCE_FILES) throw new Error(`Gadget 源文件数量不能超过 ${MAX_SOURCE_FILES}`);
    const paths = new Set<string>();
    let totalBytes = 0;
    for (const file of files) {
      if (typeof file.content !== "string") throw new Error("Gadget 源文件 content 必须是字符串");
      if (file.encoding !== undefined && file.encoding !== "utf8" && file.encoding !== "base64") {
        throw new Error(`Gadget 源文件 encoding 无效：${String(file.encoding)}`);
      }
      const path = safeRelativePath(file.path);
      const pathKey = path.toLocaleLowerCase();
      if (paths.has(pathKey)) throw new Error(`Gadget 源文件路径重复：${path}`);
      paths.add(pathKey);
      let bytes: number;
      if (file.encoding === "base64") {
        if (file.content && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content)) {
          throw new Error(`Gadget 源文件不是规范 base64：${path}`);
        }
        bytes = file.content ? (file.content.length / 4) * 3 - (file.content.endsWith("==") ? 2 : file.content.endsWith("=") ? 1 : 0) : 0;
      } else {
        bytes = Buffer.byteLength(file.content, "utf8");
      }
      if (bytes > MAX_BLUEPRINT_FILE_BYTES) throw new Error(`Gadget 源文件过大：${path}`);
      totalBytes += bytes;
      if (totalBytes > MAX_BLUEPRINT_TOTAL_BYTES) throw new Error("Gadget 源文件总大小超过限制");
    }
  }

  private assertSafeStorage(id: string): void {
    const target = this.paths(id);
    for (const [label, path] of [["root", target.root], ["source", target.sourcePath], ["data", target.dataPath]] as const) {
      if (!existsSync(path)) throw new Error(`Gadget ${label} storage 不存在`);
      const info = lstatSync(path);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Gadget ${label} storage 不得是符号链接或非目录`);
      if (!isInside(this.canonicalRootDir, realpathSync(path))) throw new Error(`Gadget ${label} storage 越界`);
    }
  }
}

function defaultHtml(name: string): string {
  const escaped = name.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escaped}</title><style>body{font-family:system-ui;margin:0;padding:40px;background:#f7f7f5;color:#20201e}.card{max-width:720px;margin:auto;background:white;border:1px solid #ddd;border-radius:16px;padding:28px}</style></head><body><main class="card"><h1>${escaped}</h1><p>这个 Gadget 已准备好，可以继续编辑源码。</p></main></body></html>`;
}
