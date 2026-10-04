/**
 * Wave 5D-1 — DOCX 视图纯逻辑（§88 / 1H spike：docx-preview）
 *
 * 无 DOM 依赖（decode 复用 atob，node ≥16 可用），可在 node 中单测。
 * 渲染策略：parseAsync 一次 + renderDocument 全量产出分页节点 →
 * 视口窗口挂载 + 超距真回收（节点销毁）→ 回看时按需 re-render 恢复。
 */
import { searchMatches, type TextMatch } from "./pdfView";
import { decodeBase64DataUri } from "./binaryArtifact";

export { searchMatches };
export type { TextMatch };

/** data URI → Uint8Array（office 二进制；严格校验见 lib/binaryArtifact） */
export function decodeDataUriBytes(dataUri: string): Uint8Array {
  return decodeBase64DataUri(dataUri).bytes;
}

/** 页内文本（搜索索引用；innerText 与渲染一致） */
export function collectPageText(pageEl: Element): string {
  return pageEl.textContent ?? "";
}

/** 累积页偏移（含间距） */
export function cumulativeOffsets(heights: number[]): number[] {
  const offsets: number[] = [];
  let acc = 0;
  for (const h of heights) {
    offsets.push(acc);
    acc += h + DOCX_PAGE_GAP;
  }
  return offsets;
}

/** scrollTop → 页码（二分） */
export function pageAtScrollTop(offsets: number[], scrollTop: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= scrollTop) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export const DOCX_PAGE_GAP = 12;

/** 可见窗口（含 overscan） */
export function visibleRange(
  offsets: number[],
  scrollTop: number,
  viewportH: number,
  overscan: number,
): { start: number; end: number } {
  if (offsets.length === 0) return { start: 0, end: -1 };
  const top = pageAtScrollTop(offsets, scrollTop);
  const bottom = pageAtScrollTop(offsets, scrollTop + Math.max(viewportH, 1));
  return {
    start: Math.max(0, top - overscan),
    end: Math.min(offsets.length - 1, bottom + overscan),
  };
}

/** 回收窗口（可见窗口 + 两侧 margin 之外 → 真回收） */
export function recycleRange(
  offsets: number[],
  scrollTop: number,
  viewportH: number,
  overscan: number,
  marginPages: number,
): { keepStart: number; keepEnd: number } {
  const { start, end } = visibleRange(offsets, scrollTop, viewportH, overscan);
  return {
    keepStart: Math.max(0, start - marginPages),
    keepEnd: Math.min(offsets.length - 1, end + marginPages),
  };
}

// ---------- 生命周期统计（E2E 泄漏断言用） ----------

export const docxViewerStats = {
  /** 解析过的文档数（parse+1/清理-1） */
  docs: 0,
  /** 容器级监听器（scroll/resize） */
  listeners: 0,
  /** ResizeObserver 数 */
  observers: 0,
  /** 当前挂载在视口内的页节点数 */
  pagesLive: 0,
  /** 累计 renderDocument 次数（回收后重建计数） */
  renders: 0,
};

export function resetDocxViewerStats(): void {
  docxViewerStats.docs = 0;
  docxViewerStats.listeners = 0;
  docxViewerStats.observers = 0;
  docxViewerStats.pagesLive = 0;
  docxViewerStats.renders = 0;
}
