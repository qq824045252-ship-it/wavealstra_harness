/**
 * Wave 5D-1 — 分页文档视图共享数学（PDF/DOCX 复用）
 *
 * 从 pdfView.ts 抽取的通用 fit/zoom 逻辑；pdfView 保留 re-export 兼容。
 */

/** 分页文档页间距（连续滚动） */
export const PAGE_GAP = 10;

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 4;

export function clampZoom(scale: number): number {
  return Math.min(Math.max(scale, MIN_ZOOM), MAX_ZOOM);
}

/** fit 模式（统一按首页尺寸计算；混合尺寸文档以首页为基准） */
export function fitScaleFor(
  pageW: number,
  pageH: number,
  containerW: number,
  containerH: number,
  mode: "fit-page" | "fit-width",
): number {
  if (pageW <= 0 || pageH <= 0 || containerW <= 0) return 1;
  if (mode === "fit-width") return containerW / pageW;
  return Math.min(containerW / pageW, (containerH - PAGE_GAP) / pageH);
}
