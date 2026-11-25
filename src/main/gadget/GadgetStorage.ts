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
import type { GadgetDescriptor, GadgetManifest, GadgetSourceFile, GadgetSourceSnapshot, GadgetSourceUpdateRequest } from "../../shared/gadget-types";
import type { GadgetSaveToTaskDirectoryResult } from "../../shared/gadget-ipc";
import type { RuntimeBlueprintGadgetFiles } from "../blueprint/BlueprintInstanceWrite";
import { normalizeGadgetManifest } from "../../shared/gadget-types";
import { BLUEPRINT_CAPTURE_DENY_PATTERN, isBlueprintSensitivePath, redactBlueprintSecrets } from "../../shared/blueprint-secret-policy";
import { decodeBlueprintFile } from "../blueprint/capture-file";
import type { RuntimeAuditReader, RuntimeGadgetArtifactSource, RuntimeGadgetSourceData } from "../platform/runtime-audit";
import { gadgetInsertValues } from "./GadgetRepository";
import { planGadgetExport } from "./saveGadgetToTaskDirectory";

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

interface GadgetSourceInspection {
  manifest: GadgetManifest;
  paths: string[];
  token: string;
}

export class GadgetStorage {
  private readonly canonicalRootDir: string;

  constructor(private readonly rootDir: string, private readonly native?: RuntimeAuditReader) {
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
    const materialized = this.materializeFiles(normalized, files);
    try {
      mkdirSync(target.sourcePath, { recursive: true });
      mkdirSync(target.dataPath, { recursive: true });
      for (const file of materialized) this.writeSourceFile(id, file);
      if (!existsSync(join(target.sourcePath, ...normalized.entry.split("/")))) {
        throw new Error(`Gadget 入口文件不存在：${normalized.entry}`);
      }
      if (normalized.backend && "entry" in normalized.backend && !existsSync(join(target.sourcePath, ...normalized.backend.entry.split("/")))) {
        throw new Error(`Gadget 后台入口不存在：${normalized.backend.entry}`);
      }
      this.writeManifest(id, normalized);
      return target;
    } catch (error) {
      rmSync(target.root, { recursive: true, force: true });
      throw error;
    }
  }

  async createNative(
    descriptor: GadgetDescriptor, manifest: GadgetManifest,
    source: { files?: GadgetSourceFile[] } | { sourceId: string; token: string },
  ): Promise<boolean> {
    if (!this.native || !await this.native.supportsGadgetFileMutations()) return false;
    const normalized = normalizeGadgetManifest(manifest);
    const result = await this.native.createGadgetFiles({
      root: this.canonicalRootDir,
      gadget: gadgetInsertValues(descriptor),
      manifest: `${JSON.stringify(normalized, null, 2)}\n`,
      entry: normalized.entry,
      backendEntry: normalized.backend && "entry" in normalized.backend ? normalized.backend.entry : undefined,
      source: "sourceId" in source
        ? { kind: "copy", ...source }
        : { kind: "generated", files: this.encodeGeneratedFiles(normalized, source.files) },
    });
    if (result?.status === "created") return true;
    if (result?.status === "scopeChanged") throw new Error("Gadget 目标或来源作用域已变化，请刷新后重试");
    if (result?.status === "sourceChanged") throw new Error("Gadget 源码已被修改，请重新复制");
    throw new Error(result?.status === "failed" ? result.message : "Gadget 创建结果未确认，请刷新列表");
  }

  blueprintFiles(id: string, manifest: GadgetManifest, files?: GadgetSourceFile[]): RuntimeBlueprintGadgetFiles {
    const normalized = normalizeGadgetManifest(manifest);
    return {
      id,
      root: this.canonicalRootDir,
      manifest: `${JSON.stringify(normalized, null, 2)}\n`,
      entry: normalized.entry,
      backendEntry: normalized.backend && "entry" in normalized.backend ? normalized.backend.entry : undefined,
      files: this.encodeGeneratedFiles(normalized, files),
    };
  }

  private encodeGeneratedFiles(manifest: GadgetManifest, files?: GadgetSourceFile[]) {
    return this.materializeFiles(manifest, files).map(file => ({ path: safeRelativePath(file.path), base64: sourceBase64(file) }));
  }

  private materializeFiles(manifest: GadgetManifest, files?: GadgetSourceFile[]): GadgetSourceFile[] {
    const materialized = files?.length ? files : [{ path: manifest.entry, content: defaultHtml(manifest.name), encoding: "utf8" as const }];
    this.validateSourceFiles(materialized);
    return materialized;
  }

  async inspectNative(id: string): Promise<GadgetSourceInspection | undefined> {
    if (!this.native || !await this.native.supportsGadgetFileMutations()) return undefined;
    const source = await this.native.inspectGadgetSource(this.canonicalRootDir, id);
    if (!source || source.status === "needsHost") return undefined;
    if (source.status === "rejected") throw new Error(source.message);
    this.validateSourceFiles(source.paths.map(path => ({ path, content: "" })));
    return { manifest: normalizeGadgetManifest(JSON.parse(source.manifest)), paths: source.paths, token: source.token };
  }

  async exportNative(
    taskDirectory: string, gadget: GadgetDescriptor, source: GadgetSourceInspection,
  ): Promise<GadgetSaveToTaskDirectoryResult> {
    if (!this.native) throw new Error("Gadget 存储服务已关闭");
    const result = await this.native.exportGadgetFiles({
      taskDirectory,
      root: this.canonicalRootDir,
      id: gadget.id,
      token: source.token,
      ...planGadgetExport(gadget, source.manifest, source.paths),
    });
    if (result?.status === "exported") {
      return { directory: result.directory, entryPath: result.entryPath, fileCount: result.fileCount };
    }
    if (result?.status === "sourceChanged") throw new Error("Gadget 源码已被修改，请重新保存副本");
    throw new Error(result?.status === "failed" ? result.message : "导出结果未确认，请检查任务目录");
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

  async readManifestNative(id: string): Promise<{ manifest: GadgetManifest; token: string } | undefined> {
    const result = await this.native?.readGadgetManifest(this.canonicalRootDir, id);
    if (!result || result.status === "needsHost") return undefined;
    if (result.status === "rejected") throw new Error(result.message);
    return { manifest: normalizeGadgetManifest(JSON.parse(result.manifest)), token: result.token };
  }

  artifactSource(id: string, entry: string, token: string): RuntimeGadgetArtifactSource {
    return { root: this.canonicalRootDir, id, entry, token };
  }

  async saveManifestNative(descriptor: GadgetDescriptor, manifest: GadgetManifest, token: string): Promise<boolean> {
    if (!this.native) return false;
    const fields = gadgetInsertValues(descriptor);
    const result = await this.native.saveGadgetSource({
      root: this.canonicalRootDir,
      id: descriptor.id,
      operationId: randomUUID(),
      token,
      updatedAt: descriptor.updatedAt,
      files: [],
      manifest: `${JSON.stringify(normalizeGadgetManifest(manifest), null, 2)}\n`,
      update: { name: fields.name, description: fields.description, metadataJson: fields.metadataJson },
    });
    if (result?.status === "manifestSaved") return true;
    if (result?.status === "needsHost") return false;
    if (result?.status === "conflict") throw new Error("Gadget 配置已被修改，请刷新后重试");
    throw new Error(`工作台数据写入失败，请重试${result?.status === "failed" ? `：${result.message}` : ""}`);
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
    return this.sourceSnapshot(this.readManifest(id), files);
  }

  async readSourceAsync(id: string): Promise<GadgetSourceSnapshot> {
    const source = await this.native?.readGadgetSource(this.canonicalRootDir, id);
    if (!source || source.status === "needsHost") return this.readSource(id);
    if (source.status === "rejected") throw new Error(source.message);
    return this.nativeSnapshot(source);
  }

  private nativeSnapshot(source: RuntimeGadgetSourceData): GadgetSourceSnapshot {
    // Match the existing per-directory localeCompare order to retain saved revisions.
    const firstPosition = new Map<string, number>();
    const ordered = source.files.map((file, index) => {
      const parts = file.path.split("/");
      const prefixes = parts.map((_, depth) => parts.slice(0, depth + 1).join("/"));
      for (const prefix of prefixes) {
        if (!firstPosition.has(prefix)) firstPosition.set(prefix, index);
      }
      return { file, parts, prefixes };
    }).sort((a, b) => {
      for (let depth = 0; depth < Math.min(a.parts.length, b.parts.length); depth++) {
        if (a.parts[depth] !== b.parts[depth]) {
          return a.parts[depth].localeCompare(b.parts[depth])
            || firstPosition.get(a.prefixes[depth])! - firstPosition.get(b.prefixes[depth])!;
        }
      }
      return a.parts.length - b.parts.length;
    });
    const files: GadgetSourceFile[] = ordered.map(({ file }) => ({
      path: file.path,
      content: file.text ? Buffer.from(file.content, "base64").toString("utf8") : file.content,
      encoding: file.text ? "utf8" : "base64",
    }));
    return this.sourceSnapshot(normalizeGadgetManifest(JSON.parse(source.manifest)), files);
  }

  private sourceSnapshot(manifest: GadgetManifest, files: GadgetSourceFile[]): GadgetSourceSnapshot {
    this.validateSourceFiles(files);
    const hash = createHash("sha256");
    hash.update('{"manifest":').update(JSON.stringify(manifest)).update(',"files":[');
    for (const [index, file] of files.entries()) {
      if (index > 0) hash.update(",");
      hash.update(JSON.stringify(file));
    }
    return { manifest, files, revision: hash.update("]}").digest("hex") };
  }

  async updateSourceNative(
    request: GadgetSourceUpdateRequest, updatedAt: number, authorize?: () => void,
  ): Promise<GadgetSourceSnapshot | undefined> {
    if (!this.native) return undefined;
    const source = await this.native.readGadgetSource(this.canonicalRootDir, request.gadgetId);
    if (!source || source.status === "needsHost") return undefined;
    if (source.status === "rejected") throw new Error(source.message);
    if (!source.token) return undefined;
    const { manifest, patches } = this.prepareSourceEdit(request, this.nativeSnapshot(source));
    authorize?.();
    const result = await this.native.saveGadgetSource({
      root: this.canonicalRootDir,
      id: request.gadgetId,
      operationId: randomUUID(),
      token: source.token,
      updatedAt,
      files: patches.map(file => ({
        path: file.path,
        base64: sourceBase64(file),
      })),
      ...(request.backend === undefined ? {} : { manifest: `${JSON.stringify(manifest, null, 2)}\n` }),
    });
    if (result?.status === "saved") return this.nativeSnapshot(result.source);
    if (result?.status === "needsHost") return undefined;
    if (result?.status === "conflict") throw new Error("Gadget 已被修改，请重新读取源码后再保存");
    throw new Error(`工作台数据写入失败，请重试${result?.status === "failed" ? `：${result.message}` : ""}`);
  }

  private prepareSourceEdit(request: GadgetSourceUpdateRequest, current: GadgetSourceSnapshot) {
    const { files, expectedRevision } = request;
    if (!expectedRevision || current.revision !== expectedRevision) throw new Error("Gadget 已被修改，请重新读取源码后再保存");
    if (!files.length) throw new Error("请提供要修改的 Gadget 源文件");
    this.validateSourceFiles(files);
    const merged = new Map(current.files.map((file) => [file.path.toLowerCase(), file]));
    const patches = files.map(file => {
      const path = safeRelativePath(file.path);
      const old = merged.get(path.toLowerCase());
      const patch = { ...file, path: old?.path ?? path };
      merged.set(path.toLowerCase(), patch);
      return patch;
    });
    this.validateSourceFiles([...merged.values()]);
    const manifest = normalizeGadgetManifest({ ...current.manifest,
      ...(request.backend === undefined ? {} : { backend: request.backend === null ? undefined : request.backend }),
    });
    if (!merged.has(manifest.entry.toLowerCase())) throw new Error("Gadget 缺少入口文件");
    if (manifest.backend && "entry" in manifest.backend && !merged.has(manifest.backend.entry.toLowerCase())) throw new Error("Gadget 缺少后台入口文件");
    return { merged, manifest, patches };
  }

  updateSource(request: GadgetSourceUpdateRequest, commit: () => Promise<void>): Promise<GadgetSourceSnapshot>;
  updateSource(request: GadgetSourceUpdateRequest, commit: () => void): GadgetSourceSnapshot;
  updateSource(request: GadgetSourceUpdateRequest, commit: () => void | Promise<void>): GadgetSourceSnapshot | Promise<GadgetSourceSnapshot> {
    const id = request.gadgetId;
    const current = this.readSource(id);
    const { merged, manifest, patches } = this.prepareSourceEdit(request, current);
    const paths = this.paths(id);
    const next = join(paths.root, `code.next-${randomUUID()}`);
    const previous = join(paths.root, `code.previous-${randomUUID()}`);
    mkdirSync(next);
    const applied: Array<{ destination: string; backup: string | null }> = [];
    let manifestWritten = false;
    let waitingForCommit = false;
    const cleanupStage = () => {
      try { rmSync(next, { recursive: true, force: true }); }
      catch (error) { console.warn("[GadgetStorage] 保留源码暂存目录", next, error); }
    };
    const complete = (snapshot: GadgetSourceSnapshot) => {
      // A cleanup failure must not report a committed source edit as failed.
      try { rmSync(previous, { recursive: true, force: true }); }
      catch (error) { console.warn("[GadgetStorage] 保留源码备份", previous, error); }
      return snapshot;
    };
    const rollback = (error: unknown): never => {
      for (const { destination, backup } of applied.reverse()) {
        if (backup) renameSync(backup, destination);
        else rmSync(destination, { force: true });
      }
      if (manifestWritten) this.writeManifest(id, current.manifest);
      rmSync(previous, { recursive: true, force: true });
      throw error;
    };
    try {
      for (const file of merged.values()) {
        const destination = resolve(next, ...safeRelativePath(file.path).split("/"));
        mkdirSync(resolve(destination, ".."), { recursive: true });
        writeFileSync(destination, file.encoding === "base64" ? Buffer.from(file.content, "base64") : file.content);
      }
      // The running host uses code/ as cwd; Windows cannot rename that directory.
      // Stage/validate the entire tree, then replace individual files atomically.
      for (const file of patches) {
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
      if (request.backend !== undefined) { this.writeManifest(id, manifest); manifestWritten = true; }
      const snapshot = this.readSource(id);
      const written = commit();
      if (written instanceof Promise) {
        waitingForCommit = true;
        return written.then(() => complete(snapshot), rollback).finally(cleanupStage);
      }
      return complete(snapshot);
    } catch (error) {
      return rollback(error);
    } finally {
      if (!waitingForCommit) cleanupStage();
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

  async captureSourceAsync(id: string): Promise<{ manifest: GadgetManifest; sourceFiles: GadgetSourceFile[] }> {
    const result = await this.native?.captureBlueprintGadget(this.canonicalRootDir, id, BLUEPRINT_CAPTURE_DENY_PATTERN);
    if (!result || result.status === "needsHost") return this.captureSource(id);
    if (result.status === "rejected") throw new Error(result.message);
    return {
      manifest: normalizeGadgetManifest(JSON.parse(result.manifest)),
      sourceFiles: result.files.filter(file => !isBlueprintSensitivePath(file.path)).map(decodeBlueprintFile),
    };
  }

  delete(id: string): void {
    const target = this.paths(id).root;
    if (!isInside(this.rootDir, target) || target === resolve(this.rootDir)) throw new Error("拒绝删除越界 Gadget storage");
    rmSync(target, { recursive: true, force: true });
  }

  async removeUnregistered(id: string): Promise<void> {
    const result = this.native ? await this.native.removeUnregisteredGadget(this.canonicalRootDir, id) : "needsHost";
    if (result === "needsHost") {
      this.delete(id);
      return;
    }
    if (result !== true) throw new Error("Gadget 存储清理未完成");
  }

  /** SQLite descriptor 是 durable truth；清理崩溃窗口留下的未提交目录。 */
  async recover(validIds: () => ReadonlySet<string>): Promise<void> {
    const failed = await this.native?.reconcileGadgetStorage(this.canonicalRootDir);
    if (failed === undefined) {
      this.reconcile(validIds());
      return;
    }
    for (const error of failed) console.warn("[GadgetStorage] 无法清理 orphan storage", error);
  }

  private reconcile(validIds: ReadonlySet<string>): void {
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
    if (lstatSync(join(target.root, ".mybuddy-source-save"), { throwIfNoEntry: false })) {
      throw new Error("Gadget 源码保存尚未恢复");
    }
  }
}

function sourceBase64(file: GadgetSourceFile): string {
  return file.encoding === "base64" ? file.content : Buffer.from(file.content, "utf8").toString("base64");
}

function defaultHtml(name: string): string {
  const escaped = name.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escaped}</title><style>
:root { color-scheme: light; --canvas: #f1f5fc; --card: #fff; --ink: #17253b; --muted: #475b76; --line: #cfdbea; }
@media (prefers-color-scheme: dark) {
  :root { color-scheme: dark; --canvas: #101827; --card: #151f30; --ink: #e9f0fc; --muted: #b2c0d6; --line: #354863; }
}
body { font: 15px/1.5 system-ui, "Segoe UI", sans-serif; margin: 0; padding: clamp(16px, 6vw, 40px); background: var(--canvas); color: var(--ink); }
.card { max-width: 720px; margin-inline: auto; background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: clamp(16px, 4vw, 28px); }
h1 { margin: 0; font-size: clamp(20px, 4vw, 28px); overflow-wrap: anywhere; }
p { color: var(--muted); margin: 8px 0 0; }
</style></head><body><main class="card"><h1>${escaped}</h1><p>这个 Gadget 已准备好，可以继续编辑源码。</p></main></body></html>`;
}
