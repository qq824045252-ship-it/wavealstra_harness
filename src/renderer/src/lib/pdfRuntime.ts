/**
 * Wave 5C — pdfjs 运行时封装（renderer）
 *
 * 职责：
 *   - worker 生命周期（?worker&inline blob worker，open 时创建、close 时 terminate）
 *   - getDocument 参数（isEvalSupported:false 适配 CSP；disableAutoFetch 大文档友好）
 *   - 页面渲染（DPR canvas，v6 render contract：预置 canvas 尺寸 + transform 缩放）
 *   - 文本层（v6 TextLayer：render/update/cancel；OutputScale.pixelRatio 同步）
 *   - 搜索文本抽取（可取消、逐页让出主线程）
 *
 * 所有资源（worker/document/renderTask/textLayer）由调用方负责释放，
 * 计数写入 pdfViewerStats 供 E2E 泄漏断言。
 */
// eslint-disable-next-line import/no-unresolved
import PdfWorker from "@/lib/pdfWorkerEntry?worker&inline";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { decodeDataUriBytes, pdfViewerStats, type TextMatch } from "./pdfView";

/**
 * pdfjs build flavor 常量（R24 机器锁）：主线程 API 与 worker 必须统一 legacy。
 * 真实 worker（pdfWorkerEntry）与 fake-worker fallback 都不得引入
 * `pdfjs-dist/build/pdf.worker.min.mjs`（modern）：modern worker 在真实 worker
 * 作用域内没有 legacy polyfill（Uint8Array.prototype.toHex 等），
 * 会报 `n2.toHex is not a function`。
 */
export const PDFJS_BUILD_FLAVOR = "legacy" as const;

/**
 * pdfjs-dist 6.2.108 的 types 滞后于 runtime（pixelRatio readonly / 无 isEvalSupported /
 * 无 destroy 等），以 mjs 源码为准用本地接口描述实际 API 面。
 */
export interface PdfViewportLike {
  width: number;
  height: number;
  scale: number;
  rotation: number;
  rawDims: { pageWidth: number; pageHeight: number; pageX: number; pageY: number };
}

export interface PdfPageLike {
  getViewport: (params: { scale: number }) => PdfViewportLike;
  render: (params: {
    canvas: HTMLCanvasElement;
    canvasContext: CanvasRenderingContext2D;
    viewport: PdfViewportLike;
    transform: Array<number> | null;
  }) => { promise: Promise<void>; cancel: () => void };
  getTextContent: () => Promise<{ items: Array<{ str: string }> }>;
  cleanup: () => void;
}

export interface PdfDocumentLike {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfPageLike>;
  cleanup: () => void;
  /** v6：destroy 在 loadingTask 上（PDFDocumentProxy 无 destroy） */
  loadingTask: { destroy: () => Promise<void> };
}

interface PdfjsSurface {
  getDocument: (params: {
    data: Uint8Array;
    isEvalSupported?: boolean;
    disableAutoFetch?: boolean;
    useSystemFonts?: boolean;
  }) => { promise: Promise<PdfDocumentLike> };
  GlobalWorkerOptions: { workerPort: Worker | null };
  TextLayer: new (params: {
    textContentSource: object;
    container: HTMLElement;
    viewport: PdfViewportLike;
  }) => { render: () => Promise<void>; cancel: () => void };
}

const api = pdfjs as unknown as PdfjsSurface;

export interface PdfSession {
  doc: PdfDocumentLike;
  worker: Worker | null;
  /** 释放全部资源（doc.destroy + worker.terminate，幂等） */
  close: () => void;
}

/**
 * 共享真实 Worker 生命周期状态机：
 *   - undefined = 尚未创建 / 已释放 → 下次 open 重新创建
 *   - Worker     = 当前存活的真实 worker（引用计数 workerUsers 管理）
 *
 * 不用 null 表示「需要重新创建」：release 后必须回到 undefined，否则第二次
 * open 时 workerPort 为 null 且 globalThis.pdfjsWorker 未注册，pdf.js 会落到
 * workerSrc 猜测路径，报 `No "GlobalWorkerOptions.workerSrc" specified.`。
 */
let worker: Worker | undefined;
let workerUsers = 0;

/** 创建 blob worker；失败（预览 stub/环境限制）→ 主线程安装 legacy fake worker */
async function ensureWorker(): Promise<Worker | null> {
  if (worker === undefined) {
    try {
      worker = new PdfWorker();
      pdfViewerStats.workers += 1;
    } catch (error) {
      console.warn("[pdfRuntime] pdfjs worker 创建失败，回退主线程解析", error);
      try {
        // 主线程注册 globalThis.pdfjsWorker → PDFWorker.#initialize 直接走 fake worker。
        // 必须与真实 worker 同一 flavor（legacy），否则 fallback 路径重新引入 modern
        // worker 的运行时缺口（Uint8Array.prototype.toHex 等）。
        const workerModule = await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs");
        globalThis.pdfjsWorker = {
          WorkerMessageHandler: workerModule.WorkerMessageHandler,
        };
      } catch (fallbackError) {
        console.error("[pdfRuntime] fake worker 初始化失败", fallbackError);
        throw fallbackError;
      }
      // fake worker 由 globalThis.pdfjsWorker 全局生效，无需占位；
      // 下次 open 可重试真实 worker 创建。
    }
  }
  workerUsers += 1;
  return worker ?? null;
}

function releaseWorker(): void {
  workerUsers -= 1;
  if (workerUsers <= 0) {
    if (worker) {
      worker.terminate();
      pdfViewerStats.workers -= 1;
    }
    // 关键：恢复 undefined 而非 null —— 下次 open 才能重建 worker
    worker = undefined;
    workerUsers = 0;
  }
}

/** 打开 PDF（data URI 内容）。失败时自动归还 worker。 */
export async function openPdf(dataUri: string): Promise<PdfSession> {
  const pdfWorker = await ensureWorker();
  api.GlobalWorkerOptions.workerPort = pdfWorker;
  try {
    const doc = await api
      .getDocument({
        data: decodeDataUriBytes(dataUri),
        isEvalSupported: false,
        disableAutoFetch: true,
        useSystemFonts: true,
      })
      .promise;
    pdfViewerStats.docs += 1;
    let closed = false;
    return {
      doc,
      worker: pdfWorker,
      close: () => {
        if (closed) return;
        closed = true;
        pdfViewerStats.docs -= 1;
        void doc.loadingTask.destroy();
        releaseWorker();
      },
    };
  } catch (error) {
    releaseWorker();
    throw error;
  }
}

/** 渲染单页到 canvas（DPR 精确；v6 contract：预置 canvas 尺寸 + transform）
 * 返回 renderTask 供调用方取消。 */
export function renderPageToCanvas(
  page: PdfPageLike,
  viewport: PdfViewportLike,
  canvas: HTMLCanvasElement,
  dpr: number,
): { task: { promise: Promise<void>; cancel: () => void } } {
  const w = Math.floor(viewport.width);
  const h = Math.floor(viewport.height);
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: false });
  if (!ctx) throw new Error("无法创建 PDF 画布");
  const task = page.render({
    canvas,
    canvasContext: ctx,
    viewport,
    transform: dpr > 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
  });
  return { task };
}

/** 渲染文本层（v6 TextLayer；container 需 .textLayer class 与 CSS 变量） */
export async function renderTextLayerTo(
  container: HTMLElement,
  page: PdfPageLike,
  viewport: PdfViewportLike,
): Promise<{ render: () => Promise<void>; cancel: () => void }> {
  const textContent = await page.getTextContent();
  const layer = new api.TextLayer({
    textContentSource: textContent as object,
    container,
    viewport,
  });
  await layer.render();
  return layer;
}

export interface ExtractedText {
  pageNumber: number;
  text: string;
}

/**
 * 逐页抽取全文（搜索索引）。每页之间让出主线程；token.cancelled 时立即停止。
 * 页面对象从 doc 按需获取（pageCache 缓存，避免重复 getPage）。
 */
export async function extractAllPageTexts(
  doc: PdfDocumentLike,
  pageCache: Map<number, PdfPageLike>,
  token: { cancelled: boolean },
  onPage: (result: ExtractedText) => void,
): Promise<void> {
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    if (token.cancelled) return;
    let page = pageCache.get(pageNumber);
    if (!page) {
      page = await doc.getPage(pageNumber);
      pageCache.set(pageNumber, page);
    }
    if (token.cancelled) return;
    const textContent = await page.getTextContent();
    if (token.cancelled) return;
    const text = (textContent.items as Array<{ str: string }>)
      .map((item) => item.str ?? "")
      .join(" ");
    pdfViewerStats.textPagesExtracted += 1;
    onPage({ pageNumber, text });
    // 让出主线程（大文档搜索不冻结 UI）
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// ---------- 搜索高亮（自 lib/searchHighlight.ts，PDF/DOCX 复用） ----------
export { applySearchHighlights, clearSearchHighlights, countSearchMarks } from "./searchHighlight";
export type { TextMatch } from "./searchHighlight";
