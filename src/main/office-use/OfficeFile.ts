import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep, extname } from "node:path";
import type { EventEmitter } from "node:events";
import yauzlPackage from "yauzl";
import { prepareOfficeRoundTrip } from "./OfficeRoundTrip";
import { assertDrawioBytes, DRAWIO_FILE_LIMIT } from "../drawio-use/DrawioXml";

export type OfficeKind = "word" | "excel" | "ppt";
export type EditorFileKind = OfficeKind | "drawio";
export const kindFor = (name: string): OfficeKind | undefined =>
  ({ ".docx": "word", ".xlsx": "excel", ".pptx": "ppt" } as const)[extname(name).toLowerCase() as ".docx" | ".xlsx" | ".pptx"];
export const editorKindFor = (name: string): EditorFileKind | undefined =>
  extname(name).toLowerCase() === ".drawio" ? "drawio" : kindFor(name);
export const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
};
export interface OfficeFileTarget {
  path: string; name: string; kind: EditorFileKind; base64?: boolean; readOnly?: boolean; taskId?: string;
  identity: string;
  check(): Promise<void>;
  readVerified?(): Promise<Buffer>;
  copy?(bytes: Buffer, checkUnchanged?: () => Promise<void>): Promise<string | null>;
  published?(): void | Promise<void>;
}

export async function plainFile(path: string): Promise<void> {
  const st = await lstat(path);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || relative(await realpath(path), resolve(path)) !== "") {
    throw new Error("Office 文件位置已变化，请重新打开");
  }
}

export async function atomicBytes(path: string, bytes: Buffer | string, check?: () => Promise<void>, options?: { create: boolean }): Promise<void> {
  const tmp = join(dirname(path), ".mybuddy-office-" + randomUUID());
  try {
    await writeFile(tmp, bytes, { flag: "wx", mode: 0o600, flush: true });
    await check?.();
    if (options?.create) await link(tmp, path);
    else await rename(tmp, path);
  } finally { await unlink(tmp).catch(e => { if (e.code !== "ENOENT") throw e; }); }
}

const operations = new Map<string, Promise<unknown>>();
async function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (operations.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
  operations.set(key, next);
  try { return await next; } finally { if (operations.get(key) === next) operations.delete(key); }
}

const yauzl = yauzlPackage as { fromBuffer(data: Buffer, options: {lazyEntries: boolean}, done: (error: Error | null, file?: EventEmitter & { readEntry(): void }) => void): void };

// Only inspect the ZIP central directory. No Office XML or media is inflated here.
export function assertOfficePackage(bytes: Buffer, kind: OfficeKind): Promise<void> {
  const required = new Set(["[Content_Types].xml", { word: "word/document.xml", excel: "xl/workbook.xml", ppt: "ppt/presentation.xml" }[kind]]);
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, {lazyEntries:true}, (error, file) => {
      if (error || !file) { reject(error || new Error("Office 文件无效")); return; }
      file.on("error", reject);
      file.on("entry", (entry: { fileName: string }) => {
        required.delete(entry.fileName);
        file.readEntry();
      });
      file.on("end", () => required.size ? reject(new Error("Office 文件缺少必要内容")) : resolve());
      file.readEntry();
    });
  });
}

export async function assertEditorFile(bytes: Buffer, kind: EditorFileKind) {
  if (kind === "drawio") assertDrawioBytes(bytes);
  else await assertOfficePackage(bytes, kind);
}
export class OfficeFile {
  private base = "";
  private prefix = "";
  private draftPath = "";
  private presentation?: Buffer;
  private savedBaseline = false;
  recovered = false;
  conflict = false;
  constructor(readonly target: OfficeFileTarget, private drafts: string) {}
  private async current(): Promise<Buffer> {
    if (this.target.readVerified) {
      await plainFile(this.target.path);
      return this.target.readVerified();
    }
    await this.target.check();
    await plainFile(this.target.path);
    if (this.target.kind === "drawio" && (await lstat(this.target.path)).size >
        (this.target.base64 ? Math.ceil(DRAWIO_FILE_LIMIT / 3) * 4 + 1024 : DRAWIO_FILE_LIMIT)) {
      throw new Error("Draw.io 源文件超过 32 MiB");
    }
    const data = await readFile(this.target.path);
    if (!this.target.base64) return data;
    const encoded = data.toString("utf8");
    this.prefix = encoded.match(/^data:[^,]+;base64,/i)?.[0] ?? "";
    return Buffer.from(encoded.slice(this.prefix.length), "base64");
  }
  async open(): Promise<Buffer> {
    const bytes = await this.current();
    await assertEditorFile(bytes, this.target.kind);
    this.base = digest(bytes);
    if (this.target.kind === "ppt") this.presentation = bytes;
    this.setDraftPath();
    if (!this.target.readOnly) {
      const draft = await readFile(this.draftPath).catch(e => { if (e.code !== "ENOENT") throw e; return null; });
      if (draft) {
        const base = draft.subarray(0,64).toString("ascii");
        const content = draft.subarray(64);
        if (!/^[0-9a-f]{64}$/.test(base)) throw new Error("Office 草稿版本无效");
        await assertEditorFile(content, this.target.kind);
        this.recovered = true;
        this.conflict = base !== this.base;
        if (this.presentation && this.conflict) {
          this.presentation = await readFile(this.draftPath + ".source");
          if (digest(this.presentation) !== base) throw new Error("演示稿草稿的来源校验失败");
          this.savedBaseline = true;
        }
        this.base = base;
        return content;
      }
    }
    return bytes;
  }
  private setDraftPath(): void {
    this.draftPath = join(this.drafts, digest(this.target.identity) + ".draft");
  }
  async prepareExport(bytes: Buffer): Promise<Buffer> {
    return this.presentation && this.target.kind === "ppt" ? prepareOfficeRoundTrip(this.presentation, bytes, this.target.kind) : bytes;
  }
  async write(bytes: Buffer, draft: boolean): Promise<{ message: string; saved: boolean }> {
    if (this.target.readOnly) throw new Error("文件只读");
    await assertEditorFile(bytes, this.target.kind);
    return serial(this.target.path, async () => {
      await mkdir(this.drafts, { recursive: true });
      // Preserve the editing buffer even when compare-and-save detects an external change.
      if (this.presentation && !this.savedBaseline) {
        await atomicBytes(this.draftPath + ".source", this.presentation);
        this.savedBaseline = true;
      }
      await atomicBytes(this.draftPath, Buffer.concat([Buffer.from(this.base,"ascii"), bytes]));
      if (draft) return { message: "草稿已保留", saved: false };
      const unchanged = async () => {
        if (digest(await this.current()) !== this.base) throw new Error("原文件已被修改，已保留草稿。请另存副本。");
      };
      await unchanged();
      bytes = await this.prepareExport(bytes);
      let message = "已保存";
      if (this.target.copy) {
        const result = await this.target.copy(bytes, unchanged);
        if (!result) return { message: "未选择保存位置，已保留草稿", saved: false };
        message = result;
      } else {
        const output = this.target.base64 ? this.prefix + bytes.toString("base64") : bytes;
        await atomicBytes(this.target.path, output, unchanged);
        await this.target.published?.();
      }
      await unlink(this.draftPath);
      if (this.savedBaseline) { await unlink(this.draftPath + ".source"); this.savedBaseline = false; }
      if (!this.target.copy && this.presentation) this.presentation = bytes;
      if (!this.target.copy) { this.base = digest(bytes); this.setDraftPath(); }
      this.recovered = false;
      return { message, saved: true };
    });
  }
}
