/**
 * Wave 5C — PDF 视图纯逻辑（§86）
 *
 * 无 DOM/pdfjs 依赖（decodeDataUriBytes 只用 atob/btoa，node ≥16 可用），
 * 可在 node 中直接单测。
 */

// 共享分页视图数学（Wave 5D-1 起由 lib/viewMath.ts 提供，此处 re-export 兼容）
export {
  PAGE_GAP as PDF_PAGE_GAP,
  clampZoom as clampPdfZoom,
  fitScaleFor,
  MAX_ZOOM as PDF_MAX_ZOOM,
  MIN_ZOOM as PDF_MIN_ZOOM,
} from "./viewMath";

// ---------- 基础工具 ----------

import { decodeBase64DataUri } from "./binaryArtifact";

/** data URI → Uint8Array（data:application/pdf;base64,...；严格校验见 lib/binaryArtifact） */
export function decodeDataUriBytes(dataUri: string): Uint8Array {
  return decodeBase64DataUri(dataUri).bytes;
}

// ---------- 搜索 ----------

export interface TextMatch {
  start: number;
  end: number;
}

/**
 * 大小写不敏感匹配（中文/英文通用）。返回所有 [start,end) 区间，
 * 上限 limit 防止巨型页超量（大文档内存控制）。
 */
export function searchMatches(text: string, query: string, limit = 500): TextMatch[] {
  if (!query) return [];
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  const matches: TextMatch[] = [];
  let from = 0;
  for (;;) {
    const idx = hay.indexOf(needle, from);
    if (idx < 0) break;
    matches.push({ start: idx, end: idx + needle.length });
    from = idx + needle.length;
    if (matches.length >= limit) break;
  }
  return matches;
}

/** pdfjs getTextContent items → 可搜索的整页文本（按阅读顺序 + 空格） */
export function collectPageText(items: Array<{ str: string }>): string {
  let out = "";
  for (const item of items) {
    const str = item.str ?? "";
    if (str === "") continue;
    // pdfjs 已把行内空格放入 str；跨 item 补一个空格避免词粘连
    if (out.length > 0 && !/\s$/.test(out) && !/^\s/.test(str)) out += " ";
    out += str;
  }
  return out;
}

/** 匹配区间 → 渲染用（页码 → 区间列表） */
export interface SearchState {
  query: string;
  /** pageNumber → matches */
  matches: Map<number, TextMatch[]>;
  /** 匹配总数（用于 UI 计数） */
  total: number;
  /** 当前命中的全局序号 */
  currentIndex: number;
  /** 当前命中所在的页 */
  currentPage: number;
}

export function emptySearchState(): SearchState {
  return { query: "", matches: new Map(), total: 0, currentIndex: 0, currentPage: 0 };
}

/** 递增构建搜索状态（页面文本就绪后调用） */
export function addPageMatches(
  state: SearchState,
  pageNumber: number,
  text: string,
): SearchState {
  const ranges = searchMatches(text, state.query);
  const next = new Map(state.matches);
  next.set(pageNumber, ranges);
  const total = [...next.values()].reduce((sum, r) => sum + r.length, 0);
  return { ...state, matches: next, total };
}

// ---------- 缩放策略 ----------

// 由 viewMath.ts 提供（见顶部 re-export）

// ---------- 生命周期统计（E2E 泄漏断言用） ----------

export const pdfViewerStats = {
  /** 打开的 PDFDocumentProxy 数（打开+1/销毁-1） */
  docs: 0,
  /** 创建的 PDFWorker 数（创建+1/terminate-1） */
  workers: 0,
  /** 容器级监听器（scroll/resize 等） */
  listeners: 0,
  /** ResizeObserver 数 */
  observers: 0,
  /** 当前存活（挂载中）的 canvas 数 */
  canvasesLive: 0,
  /** 当前存活（挂载中）的 text layer 数 */
  textLayersLive: 0,
  /** 累计渲染 canvas 数（回收复用对比用） */
  canvasesRendered: 0,
  /** 累计抽取文本页数（搜索用） */
  textPagesExtracted: 0,
};

export function resetPdfViewerStats(): void {
  pdfViewerStats.docs = 0;
  pdfViewerStats.workers = 0;
  pdfViewerStats.listeners = 0;
  pdfViewerStats.observers = 0;
  pdfViewerStats.canvasesLive = 0;
  pdfViewerStats.textLayersLive = 0;
  pdfViewerStats.canvasesRendered = 0;
  pdfViewerStats.textPagesExtracted = 0;
}
