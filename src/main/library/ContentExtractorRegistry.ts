/**
 * ContentExtractorRegistry — 内容抽取统一注册表（Library FTS / Project Knowledge Retrieval 共用）。
 *
 * 解析器来源（全部复用仓库既有成熟依赖，禁止自造脆弱 parser）：
 * - text/markdown/html/csv：内置 TextExtractor（utf8 受管文件，256KB 上限）；
 * - PDF：pdfjs-dist legacy（renderer 已有同一 fake-worker 主线程模式，
 *   globalThis.pdfjsWorker = { WorkerMessageHandler }，无需真实 Worker/Canvas）；
 * - DOCX / PPTX：jszip（成熟 ZIP）+ 定向 XML 抽取（word/document.xml → w:t、ppt/slides/slideN.xml → a:t，
 *   Office 机器生成 XML 结构稳定，实体解码后按段落拼接）；
 * - XLSX：SheetJS `xlsx`（sheetRows 限行 + sheet_to_csv）；
 * - 图片：不 OCR → unsupported（requiresFileAccess）。
 *
 * 硬限制（防 zip bomb / 超大 / 损坏 / 耗时）：
 * - 输入文件 ≤40MB；ZIP 条目数 ≤2000；ZIP 解压总量 ≤64MB；单条目 ≤16MB；
 * - 输出 ≤200KB（超限截断并置 truncated）；逐阶段耗时预算 ≤8s（超时返回 error）；
 * - 任何异常 → error（调用方降级 requiresFileAccess，模型不得误以为已读正文）。
 * 所有读取路径由调用方（LibraryService）先过 managed-path + symlink/junction 守卫。
 */
import { readFileSync, statSync } from "node:fs";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import type { LibraryItemKind } from "../../shared/library-ipc";

export const EXTRACT_MAX_INPUT_BYTES = 40 * 1024 * 1024;
export const EXTRACT_MAX_OUTPUT_CHARS = 200 * 1024;
export const EXTRACT_MAX_ZIP_ENTRIES = 2000;
export const EXTRACT_MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
export const EXTRACT_MAX_ENTRY_BYTES = 16 * 1024 * 1024;
export const EXTRACT_TIMEOUT_MS = 8000;
const TEXT_INPUT_MAX_BYTES = 256 * 1024;

export type ContentExtractionStatus = "extracted" | "unsupported" | "error";

export interface ExtractionResult {
  status: ContentExtractionStatus;
  text: string | null;
  /** 输出被 200KB 预算截断（模型不得误以为已读完整正文） */
  truncated: boolean;
  error?: string;
}

export interface ExtractionBudget {
  startMs: number;
  maxInputBytes: number;
  maxOutputChars: number;
  maxZipEntries: number;
  maxUncompressedBytes: number;
  maxEntryBytes: number;
  timeoutMs: number;
}

export function defaultBudget(now = Date.now()): ExtractionBudget {
  return {
    startMs: now,
    maxInputBytes: EXTRACT_MAX_INPUT_BYTES,
    maxOutputChars: EXTRACT_MAX_OUTPUT_CHARS,
    maxZipEntries: EXTRACT_MAX_ZIP_ENTRIES,
    maxUncompressedBytes: EXTRACT_MAX_UNCOMPRESSED_BYTES,
    maxEntryBytes: EXTRACT_MAX_ENTRY_BYTES,
    timeoutMs: EXTRACT_TIMEOUT_MS,
  };
}

export interface ContentExtractor {
  readonly id: string;
  canExtract(kind: LibraryItemKind, mimeType: string): boolean;
  extract(absPath: string, budget: ExtractionBudget): Promise<ExtractionResult>;
}

const TEXT_KINDS: readonly LibraryItemKind[] = ["markdown", "html", "csv"];

/** 文本类：utf8 受管文件，256KB 输入上限（与检索/预览预算一致），输出 200KB 截断 */
class TextContentExtractor implements ContentExtractor {
  readonly id = "text-utf8";
  canExtract(kind: LibraryItemKind): boolean {
    return TEXT_KINDS.includes(kind);
  }
  async extract(absPath: string, budget: ExtractionBudget): Promise<ExtractionResult> {
    try {
      const st = statSync(absPath);
      if (!st.isFile() || st.size > TEXT_INPUT_MAX_BYTES) {
        return { status: "unsupported", text: null, truncated: false, error: "文本文件超过 256KB 输入上限" };
      }
      const text = readFileSync(absPath, "utf8");
      return capOutput(text, budget);
    } catch {
      return { status: "error", text: null, truncated: false, error: "文本读取失败" };
    }
  }
}

/** 通用预算检查：超时 / 超输入大小 */
function checkBudget(budget: ExtractionBudget): void {
  if (Date.now() - budget.startMs > budget.timeoutMs) {
    throw new Error("抽取超时");
  }
}

function capOutput(text: string, budget: ExtractionBudget): ExtractionResult {
  if (text.length <= budget.maxOutputChars) {
    return { status: "extracted", text, truncated: false };
  }
  return {
    status: "extracted",
    text: text.slice(0, budget.maxOutputChars),
    truncated: true,
  };
}

/** XML 实体解码（Office 机器生成 XML 的文本节点专用） */
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** ZIP 炸弹守卫：条目数 / 解压总量 / 单条目上限（loadAsync 前静态检查） */
function guardZipArchive(zip: JSZip, budget: ExtractionBudget): void {
  const entries = Object.values(zip.files);
  if (entries.length > budget.maxZipEntries) {
    throw new Error(`ZIP 条目数超限（${entries.length} > ${budget.maxZipEntries}）`);
  }
  let total = 0;
  for (const entry of entries) {
    const raw = entry as unknown as { _data?: { uncompressedSize?: number } };
    const size = raw._data?.uncompressedSize ?? 0;
    total += size;
    if (size > budget.maxEntryBytes) {
      throw new Error(`ZIP 单条目解压超限（${size} 字节）`);
    }
    if (total > budget.maxUncompressedBytes) {
      throw new Error(`ZIP 解压总量超限（${total} 字节，疑似 zip bomb）`);
    }
  }
}

async function zipEntryText(
  zip: JSZip,
  name: string,
  budget: ExtractionBudget,
): Promise<string | null> {
  const entry = zip.file(name);
  if (!entry) return null;
  const raw = entry as unknown as { _data?: { uncompressedSize?: number } };
  const size = raw._data?.uncompressedSize ?? 0;
  if (size > budget.maxEntryBytes) throw new Error(`ZIP 条目解压超限：${name}`);
  checkBudget(budget);
  const xml = await entry.async("string");
  checkBudget(budget);
  return xml;
}

/** OOXML 文本节点抽取（docx w:t / pptx a:t 通用）；tag 如 "w:t" / "a:t" */
function collectXmlText(xml: string, tag: string): string {
  const parts: string[] = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)<\\/${tag}>`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const value = decodeXmlEntities(m[1] ?? "").trim();
    if (value) parts.push(value);
  }
  return parts.join(" ");
}

/** DOCX：jszip + word/document.xml 的 w:t 抽取 */
class DocxExtractor implements ContentExtractor {
  readonly id = "docx-jszip";
  canExtract(kind: LibraryItemKind, mimeType: string): boolean {
    return kind === "office" && /docx|word|officedocument\.wordprocessingml/i.test(mimeType || "");
  }
  async extract(absPath: string, budget: ExtractionBudget): Promise<ExtractionResult> {
    try {
      const buffer = readFileSync(absPath);
      if (buffer.byteLength > budget.maxInputBytes) return { status: "unsupported", text: null, truncated: false };
      const zip = await JSZip.loadAsync(buffer, { checkCRC32: false });
      guardZipArchive(zip, budget);
      const xml = await zipEntryText(zip, "word/document.xml", budget);
      if (xml === null) return { status: "unsupported", text: null, truncated: false, error: "缺少 word/document.xml" };
      return capOutput(collectXmlText(xml, "w:t"), budget);
    } catch (err) {
      return { status: "error", text: null, truncated: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** PPTX：jszip + ppt/slides/slideN.xml 的 a:t 抽取（按页号排序） */
class PptxExtractor implements ContentExtractor {
  readonly id = "pptx-jszip";
  canExtract(kind: LibraryItemKind, mimeType: string): boolean {
    return kind === "office" && /pptx|presentationml/i.test(mimeType || "");
  }
  async extract(absPath: string, budget: ExtractionBudget): Promise<ExtractionResult> {
    try {
      const buffer = readFileSync(absPath);
      if (buffer.byteLength > budget.maxInputBytes) return { status: "unsupported", text: null, truncated: false };
      const zip = await JSZip.loadAsync(buffer, { checkCRC32: false });
      guardZipArchive(zip, budget);
      const slides = Object.keys(zip.files)
        .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
        .sort((a, b) => {
          const na = Number(/slide(\d+)/.exec(a)?.[1] ?? 0);
          const nb = Number(/slide(\d+)/.exec(b)?.[1] ?? 0);
          return na - nb;
        });
      if (slides.length === 0) return { status: "unsupported", text: null, truncated: false, error: "缺少幻灯片" };
      const parts: string[] = [];
      for (const name of slides) {
        checkBudget(budget);
        const xml = await zipEntryText(zip, name, budget);
        if (xml === null) continue;
        const text = collectXmlText(xml, "a:t").trim();
        if (text) parts.push(text);
        if (parts.join(" ").length > budget.maxOutputChars) break;
      }
      return capOutput(parts.join("\n"), budget);
    } catch (err) {
      return { status: "error", text: null, truncated: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** XLSX：SheetJS（sheetRows 限行 + sheet_to_csv），多 sheet 拼接 */
/** XLSX 同步解析（SheetJS read 阻塞主线程）：输入上限收紧到 20MB */
const XLSX_MAX_INPUT_BYTES = 20 * 1024 * 1024;

class XlsxExtractor implements ContentExtractor {
  readonly id = "xlsx-sheetjs";
  readonly maxSheetRows = 5000;
  canExtract(kind: LibraryItemKind, mimeType: string): boolean {
    return kind === "office" && /xlsx|spreadsheetml/i.test(mimeType || "");
  }
  async extract(absPath: string, budget: ExtractionBudget): Promise<ExtractionResult> {
    try {
      const buffer = readFileSync(absPath);
      if (buffer.byteLength > XLSX_MAX_INPUT_BYTES) {
        return { status: "unsupported", text: null, truncated: false, error: "XLSX 超过 20MB 输入上限（同步解析防阻塞）" };
      }
      checkBudget(budget);
      const wb = XLSX.read(buffer, { type: "buffer", sheetRows: this.maxSheetRows, cellDates: false });
      const parts: string[] = [];
      for (const sheetName of wb.SheetNames) {
        checkBudget(budget);
        const sheet = wb.Sheets[sheetName];
        if (!sheet) continue;
        const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
        const text = csv.replace(/[,\t]/g, " ").trim();
        if (text) parts.push(`[工作表 ${sheetName}]\n${text}`);
        if (parts.join("\n").length > budget.maxOutputChars) break;
      }
      if (parts.length === 0) return { status: "unsupported", text: null, truncated: false, error: "无可抽取工作表" };
      return capOutput(parts.join("\n\n"), budget);
    } catch (err) {
      return { status: "error", text: null, truncated: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/**
 * pdfjs 已知非致命噪音（bundled 环境无 require / Node 无渲染 polyfill / 修复性索引提示）：
 * 在抽取期间用局部 console.warn 过滤器静音，避免污染主进程日志；
 * 真实解析错误仍以异常/error 状态向上传播，绝不吞掉。
 */
const PDFJS_NOISE_PATTERNS: RegExp[] = [
  /Cannot access the `require` function/i,
  /Cannot polyfill `(DOMMatrix|Path2D)`/i,
  /Indexing all PDF objects/i,
  /standardFontDataUrl/i,
];

function suppressKnownPdfjsNoise(): () => void {
  const originalWarn = console.warn.bind(console);
  const filtered = (message?: unknown, ...args: unknown[]): void => {
    const text = String(message ?? "");
    if (PDFJS_NOISE_PATTERNS.some((re) => re.test(text))) return;
    originalWarn(message, ...args);
  };
  console.warn = filtered as typeof console.warn;
  return () => {
    console.warn = originalWarn;
  };
}

/** PDF：pdfjs-dist legacy fake-worker 主线程（renderer 同款模式），逐页 getTextContent */
class PdfExtractor implements ContentExtractor {
  readonly id = "pdf-pdfjs";
  readonly maxPages = 500;
  canExtract(kind: LibraryItemKind, mimeType: string): boolean {
    return kind === "pdf" || /application\/pdf/i.test(mimeType || "");
  }
  async extract(absPath: string, budget: ExtractionBudget): Promise<ExtractionResult> {
    const restoreWarn = suppressKnownPdfjsNoise();
    try {
      const buffer = readFileSync(absPath);
      if (buffer.byteLength > budget.maxInputBytes) return { status: "unsupported", text: null, truncated: false };
      // pdfjs 模块初始化时会捕获 DOMMatrix 引用：polyfill 必须先于 import 安装
      installPdfjsNodePolyfills();
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const workerModule = await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs");
      // 与 renderer pdfRuntime 相同的 fake-worker 主线程模式（legacy flavor）
      (globalThis as unknown as { pdfjsWorker?: unknown }).pdfjsWorker = {
        WorkerMessageHandler: workerModule.WorkerMessageHandler,
      };
      checkBudget(budget);
      const getDocument = pdfjs.getDocument as (params: {
        data: Uint8Array;
        isEvalSupported?: boolean;
        disableAutoFetch?: boolean;
        useSystemFonts?: boolean;
      }) => {
        promise: Promise<{
          numPages: number;
          getPage: (page: number) => Promise<{
            getTextContent: () => Promise<{ items: Array<{ str?: string }> }>;
            cleanup: () => void;
          }>;
        }>;
        destroy: () => Promise<void>;
      };
      const loadingTask = getDocument({
        data: new Uint8Array(buffer),
        isEvalSupported: false,
        disableAutoFetch: true,
        useSystemFonts: false,
      });
      const doc = await loadingTask.promise;
      checkBudget(budget);
      const parts: string[] = [];
      try {
        const pageCount = Math.min(doc.numPages, this.maxPages);
        for (let page = 1; page <= pageCount; page += 1) {
          checkBudget(budget);
          const pageObj = await doc.getPage(page);
          const textContent = await pageObj.getTextContent();
          const text = (textContent.items as Array<{ str?: string }>)
            .map((item) => item.str ?? "")
            .join(" ")
            .trim();
          if (text) parts.push(text);
          pageObj.cleanup();
          if (parts.join(" ").length > budget.maxOutputChars) break;
        }
      } finally {
        try {
          await loadingTask.destroy();
        } catch {
          /* ignore */
        }
      }
      if (parts.length === 0) {
        return { status: "unsupported", text: null, truncated: false, error: "PDF 无可抽取文本（扫描件？）" };
      }
      return capOutput(parts.join("\n"), budget);
    } catch (err) {
      return { status: "error", text: null, truncated: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      restoreWarn();
    }
  }
}

/** 图片/未知文件：不 OCR → unsupported（requiresFileAccess） */
class UnsupportedExtractor implements ContentExtractor {
  readonly id = "unsupported";
  canExtract(): boolean {
    return true; // 兜底
  }
  async extract(): Promise<ExtractionResult> {
    return { status: "unsupported", text: null, truncated: false };
  }
}

/**
 * pdfjs 在 Node 环境的 DOMMatrix polyfill（仅 getTextContent 路径用到的矩阵运算子集）。
 * 与 pdfjs 内部 Matrix 工具语义一致（a-f 仿射矩阵）；渲染路径不在 main 使用。
 */
function installPdfjsNodePolyfills(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  if (typeof g.DOMMatrix === "undefined") {
    class SimpleDOMMatrix {
      a = 1;
      b = 0;
      c = 0;
      d = 1;
      e = 0;
      f = 0;
      constructor(init?: string | number[]) {
        if (typeof init === "string") {
          const parts = init.split(/[,\s]+/).map(Number);
          if (parts.length >= 6) {
            [this.a, this.b, this.c, this.d, this.e, this.f] = parts;
          }
        } else if (Array.isArray(init) && init.length >= 6) {
          [this.a, this.b, this.c, this.d, this.e, this.f] = init as number[];
        }
      }
      get is2D(): boolean {
        return true;
      }
      get isIdentity(): boolean {
        return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0;
      }
      setMatrixValue(init: string | number[]): SimpleDOMMatrix {
        const m = new SimpleDOMMatrix(init);
        this.a = m.a;
        this.b = m.b;
        this.c = m.c;
        this.d = m.d;
        this.e = m.e;
        this.f = m.f;
        return this;
      }
      multiply(other: SimpleDOMMatrix): SimpleDOMMatrix {
        return new SimpleDOMMatrix([
          this.a * other.a + this.c * other.b,
          this.b * other.a + this.d * other.b,
          this.a * other.c + this.c * other.d,
          this.b * other.c + this.d * other.d,
          this.a * other.e + this.c * other.f + this.e,
          this.b * other.e + this.d * other.f + this.f,
        ]);
      }
      multiplySelf(other: SimpleDOMMatrix): SimpleDOMMatrix {
        const m = this.multiply(other);
        this.a = m.a;
        this.b = m.b;
        this.c = m.c;
        this.d = m.d;
        this.e = m.e;
        this.f = m.f;
        return this;
      }
      translate(tx: number, ty: number): SimpleDOMMatrix {
        return this.multiply(new SimpleDOMMatrix([1, 0, 0, 1, tx, ty]));
      }
      translateSelf(tx: number, ty: number): SimpleDOMMatrix {
        return this.multiplySelf(new SimpleDOMMatrix([1, 0, 0, 1, tx, ty]));
      }
      scale(sx: number, sy = sx): SimpleDOMMatrix {
        return this.multiply(new SimpleDOMMatrix([sx, 0, 0, sy, 0, 0]));
      }
      scaleSelf(sx: number, sy = sx): SimpleDOMMatrix {
        return this.multiplySelf(new SimpleDOMMatrix([sx, 0, 0, sy, 0, 0]));
      }
      rotate(angle: number): SimpleDOMMatrix {
        const rad = (angle * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        return this.multiply(new SimpleDOMMatrix([cos, sin, -sin, cos, 0, 0]));
      }
      rotateSelf(angle: number): SimpleDOMMatrix {
        return this.multiplySelf(this.rotate(angle));
      }
      transformPoint(point: { x: number; y: number }): { x: number; y: number } {
        return {
          x: this.a * point.x + this.c * point.y + this.e,
          y: this.b * point.x + this.d * point.y + this.f,
        };
      }
      inverse(): SimpleDOMMatrix {
        const det = this.a * this.d - this.b * this.c;
        if (det === 0) return new SimpleDOMMatrix();
        const inv = new SimpleDOMMatrix([
          this.d / det,
          -this.b / det,
          -this.c / det,
          this.a / det,
          (this.c * this.f - this.d * this.e) / det,
          (this.b * this.e - this.a * this.f) / det,
        ]);
        return inv;
      }
      invertSelf(): SimpleDOMMatrix {
        const m = this.inverse();
        this.a = m.a;
        this.b = m.b;
        this.c = m.c;
        this.d = m.d;
        this.e = m.e;
        this.f = m.f;
        return this;
      }
      toString(): string {
        return `matrix(${this.a}, ${this.b}, ${this.c}, ${this.d}, ${this.e}, ${this.f})`;
      }
    }
    g.DOMMatrix = SimpleDOMMatrix;
  }
}

export class ContentExtractorRegistry {
  private readonly extractors: ContentExtractor[] = [];

  constructor() {
    this.register(new TextContentExtractor());
    this.register(new DocxExtractor());
    this.register(new PptxExtractor());
    this.register(new XlsxExtractor());
    this.register(new PdfExtractor());
    this.register(new UnsupportedExtractor()); // 兜底：图片/未知
  }

  register(extractor: ContentExtractor): void {
    this.extractors.push(extractor);
  }

  listExtractors(): string[] {
    return this.extractors.map((e) => e.id);
  }

  /** 提取（async）；任何异常 → error（调用方按 requiresFileAccess 降级） */
  async extract(
    kind: LibraryItemKind,
    mimeType: string,
    absPath: string,
    budget?: ExtractionBudget,
  ): Promise<ExtractionResult> {
    const b = budget ?? defaultBudget();
    const kindKey = kind;
    const extractor =
      this.extractors.find((e) => e.canExtract(kindKey, mimeType)) ?? new UnsupportedExtractor();
    return extractor.extract(absPath, b);
  }
}




