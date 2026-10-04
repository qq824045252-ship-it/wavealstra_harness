import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useAppStore } from "@/store/appStore";
import {
  addPageMatches,
  clampPdfZoom,
  emptySearchState,
  fitScaleFor,
  PDF_PAGE_GAP,
  pdfViewerStats,
  type SearchState,
  type TextMatch,
} from "@/lib/pdfView";
import {
  applySearchHighlights,
  clearSearchHighlights,
  extractAllPageTexts,
  openPdf,
  renderPageToCanvas,
  renderTextLayerTo,
  type PdfDocumentLike,
  type PdfPageLike,
  type PdfSession,
  type PdfViewportLike,
} from "@/lib/pdfRuntime";
import { IconSearch, IconX, IconChevronUp, IconChevronDown, IconExpand, IconMinimize, IconRotate, IconZoomIn, IconZoomOut } from "@/components/common/icons";

interface Props {
  content: string;
  name?: string;
}

type ZoomMode = "fit-page" | "fit-width" | "manual";

const PAGE_CACHE_CAP = 24;

/** 累积页偏移（含间距） */
function cumulativeOffsets(heights: number[]): number[] {
  const offsets: number[] = [];
  let acc = 0;
  for (const h of heights) {
    offsets.push(acc);
    acc += h + PDF_PAGE_GAP;
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

// ---------- 单页视图 ----------

interface PageViewProps {
  pageNumber: number;
  scale: number;
  dims: { w: number; h: number };
  dpr: number;
  getPage: (pageNumber: number) => Promise<PdfPageLike>;
  searchRanges: TextMatch[] | undefined;
  activeIndex: number;
}

const PdfPageView = memo(function PdfPageView({
  pageNumber,
  scale,
  dims,
  dpr,
  getPage,
  searchRanges,
  activeIndex,
}: PageViewProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null);
  const textLayerApiRef = useRef<{ cancel: () => void } | null>(null);
  const searchRef = useRef<{ ranges: TextMatch[]; active: number }>({ ranges: [], active: -1 });

  // 渲染 canvas + 文本层；结束后按最新搜索区间打高亮
  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    const textLayerDiv = textLayerRef.current;
    if (!canvas || !textLayerDiv) return;

    pdfViewerStats.canvasesLive += 1;
    pdfViewerStats.textLayersLive += 1;
    void (async () => {
      try {
        const page = await getPage(pageNumber);
        if (cancelled) return;
        const viewport = page.getViewport({ scale });
        const { task } = renderPageToCanvas(page, viewport as PdfViewportLike, canvas, dpr);
        renderTaskRef.current = task;
        await task.promise;
        pdfViewerStats.canvasesRendered += 1;
        if (cancelled) return;

        const textContent = await page.getTextContent();
        if (cancelled) return;
        const layer = await renderTextLayerTo(textLayerDiv, page, viewport as PdfViewportLike);
        textLayerApiRef.current = layer;
        if (cancelled) return;
        const { ranges, active } = searchRef.current;
        if (ranges.length > 0) applySearchHighlights(textLayerDiv, ranges, active);
      } catch {
        /* render cancelled / 失败 — 卸载路径处理 */
      }
    })();

    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
      textLayerApiRef.current?.cancel();
      textLayerApiRef.current = null;
      pdfViewerStats.canvasesLive -= 1;
      pdfViewerStats.textLayersLive -= 1;
      // 注意：这里不再 page.cleanup()——PDFPageProxy 归共享 pageCache（LRU）所有，
      // 由 evictPage / doc.destroy 统一清理。slot 卸载时 cleanup 一个仍被缓存共享的
      // proxy，会把其 worker 侧资源清掉，与其它 slot/搜索的并发使用形成所有权冲突。
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageNumber, scale, dpr]);

  // 搜索区间/活动命中变化 → 更新引用并重打（层未就绪时由渲染流末尾兜底）
  useEffect(() => {
    searchRef.current = { ranges: searchRanges ?? [], active: activeIndex };
    const div = textLayerRef.current;
    if (!div || !textLayerApiRef.current) return;
    if (searchRanges && searchRanges.length > 0) {
      applySearchHighlights(div, searchRanges, activeIndex);
    } else {
      clearSearchHighlights(div);
    }
  }, [searchRanges, activeIndex]);

  return (
    <div className="pdf-page" style={{ width: dims.w * scale, height: dims.h * scale }}>
      <canvas ref={canvasRef} className="pdf-canvas" />
      <div ref={textLayerRef} className="textLayer" />
    </div>
  );
});

// ---------- 主视图 ----------

/**
 * Wave 5C — PDF Artifact 视图（§86）
 *
 * continuous scroll（react-virtual 精确高度）+ lazy render + 离屏 page 回收
 * （virtualizer 卸载 + pageCache LRU + page.cleanup）+ text layer（选择/复制）+
 * 搜索（后台逐页抽文本、可取消、mark 高亮、不整篇重渲染）+ 页码跳转 +
 * zoom（fit-page/fit-width/100%/±，滚动锚点保持）+ DPR canvas +
 * 大文档内存控制（disableAutoFetch、pageCache 上限、doc.destroy/worker.terminate）。
 */
export default function PdfViewer({ content, name }: Props): React.JSX.Element {
  const theme = useAppStore((s) => s.theme);
  const scrollRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [session, setSession] = useState<PdfSession | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [baseDims, setBaseDims] = useState({ w: 0, h: 0 });
  const [scale, setScale] = useState(1);
  const [zoomMode, setZoomMode] = useState<ZoomMode>("fit-page");
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  const [pageInput, setPageInput] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchState, setSearchState] = useState<SearchState>(emptySearchState());
  const [searchExtracting, setSearchExtracting] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const sessionRef = useRef<PdfSession | null>(null);
  const pageCacheRef = useRef(new Map<number, PdfPageLike>());
  const searchTokenRef = useRef<{ cancelled: boolean } | null>(null);
  const dimsRef = useRef(new Map<number, { w: number; h: number }>());
  const anchorRef = useRef<{ pageIndex: number; offset: number } | null>(null);

  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;

  // 打开/关闭文档
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setNumPages(0);
    setBaseDims({ w: 0, h: 0 });
    setSearchState(emptySearchState());
    setSearchQuery("");
    dimsRef.current = new Map();
    pageCacheRef.current = new Map();

    void (async () => {
      try {
        const pdfSession = await openPdf(content);
        if (cancelled) {
          pdfSession.close();
          return;
        }
        sessionRef.current = pdfSession;
        setSession(pdfSession);
        setNumPages(pdfSession.doc.numPages);
        const first = await pdfSession.doc.getPage(1);
        const vp = first.getViewport({ scale: 1 });
        setBaseDims({ w: vp.width, h: vp.height });
        dimsRef.current.set(1, { w: vp.width, h: vp.height });
        first.cleanup();

        // 预取全部页面尺寸（元数据级，精确虚拟化高度）
        void (async () => {
          for (let p = 2; p <= pdfSession.doc.numPages; p += 1) {
            if (cancelled) continue;
            const page = await pdfSession.doc.getPage(p);
            const viewport = page.getViewport({ scale: 1 });
            dimsRef.current.set(p, { w: viewport.width, h: viewport.height });
            pageCacheRef.current.set(p, page);
            if (pageCacheRef.current.size > PAGE_CACHE_CAP) evictPage();
          }
        })();
      } catch (reason) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason));
          setLoading(false);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      searchTokenRef.current && (searchTokenRef.current.cancelled = true);
      sessionRef.current?.close();
      sessionRef.current = null;
      setSession(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content]);

  const evictPage = useCallback((): void => {
    const cache = pageCacheRef.current;
    if (cache.size <= PAGE_CACHE_CAP) return;
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      const page = cache.get(oldest);
      cache.delete(oldest);
      page?.cleanup();
    }
  }, []);

  const getPage = useCallback(async (pageNumber: number): Promise<PdfPageLike> => {
    const cache = pageCacheRef.current;
    const hit = cache.get(pageNumber);
    if (hit) {
      cache.delete(pageNumber);
      cache.set(pageNumber, hit); // LRU 触摸
      return hit;
    }
    const doc = sessionRef.current?.doc;
    if (!doc) throw new Error("PDF 未打开");
    const page = await doc.getPage(pageNumber);
    cache.set(pageNumber, page);
    evictPage();
    return page;
  }, [evictPage]);

  // 容器尺寸观测
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    pdfViewerStats.observers += 1;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setContainerSize({ w: rect.width, h: rect.height });
    });
    observer.observe(container);
    const rect = container.getBoundingClientRect();
    setContainerSize({ w: rect.width, h: rect.height });
    return () => {
      observer.disconnect();
      pdfViewerStats.observers -= 1;
    };
  }, []);

  // fit 模式跟随容器尺寸
  useEffect(() => {
    if (zoomMode === "manual" || containerSize.w <= 0 || baseDims.w <= 0) return;
    setScale(clampPdfZoom(fitScaleFor(baseDims.w, baseDims.h, containerSize.w, containerSize.h, zoomMode)));
  }, [zoomMode, containerSize.w, containerSize.h, baseDims.w, baseDims.h]);

  // 页高表（精确，含间距）
  const pageHeights = useMemo(() => {
    const heights: number[] = [];
    for (let p = 1; p <= numPages; p += 1) {
      const dims = dimsRef.current.get(p) ?? baseDims;
      heights.push(dims.h * scale + PDF_PAGE_GAP);
    }
    return heights;
  }, [numPages, scale, baseDims]);

  const offsets = useMemo(() => cumulativeOffsets(pageHeights), [pageHeights]);

  const virtualizer = useVirtualizer({
    // baseDims 就绪前不挂载：初始 pageHeights 会按 baseDims={0,0} 算出仅 GAP 高的
    // 假尺寸，而 virtual-core 的 getMeasurements memo 不依赖 estimateSize——
    // 首次算出的尺寸永不失效（无 measureElement ref）→ 所有页以 10px 叠在顶部，
    // 全尺寸画布互相重叠，视觉上永远只见最后一页（用户手测 bug 根因）。
    count: baseDims.w > 0 ? numPages : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => pageHeights[index] ?? 400,
    overscan: 2,
  });

  // 页高表变化（baseDims 就绪 / 缩放）后强制虚拟化器重算尺寸：
  // virtualizer.measure() 清 itemSizeCache 并 bump itemSizeCacheVersion
  // （getMeasurements 的 memo 依赖）→ 下一次渲染按新 estimateSize 重建布局。
  // 没有这一步，缩放后 item.start/totalSize 仍是旧尺寸，slot 错位叠放。
  useEffect(() => {
    if (numPages > 0) virtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageHeights]);

  // 缩放锚点保持（改 scale 前记录顶部页 + 偏移，改后恢复）
  useEffect(() => {
    if (offsets.length === 0) return;
    if (anchorRef.current) {
      const { pageIndex, offset } = anchorRef.current;
      anchorRef.current = null;
      const target = offsets[pageIndex] + offset;
      const el = scrollRef.current;
      if (el) el.scrollTop = Math.max(0, target);
    }
  }, [offsets]);

  const zoomTo = useCallback(
    (nextScale: number): void => {
      const el = scrollRef.current;
      if (el && offsets.length > 0) {
        const pageIndex = pageAtScrollTop(offsets, el.scrollTop);
        anchorRef.current = { pageIndex, offset: el.scrollTop - offsets[pageIndex] };
      }
      const clamped = clampPdfZoom(nextScale);
      if (Math.abs(clamped - scale) < 0.0001) {
        setZoomMode("manual");
        return;
      }
      setScale(clamped);
      setZoomMode("manual");
    },
    [scale, offsets],
  );

  const setMode = useCallback(
    (mode: ZoomMode | "100%"): void => {
      if (mode === "100%") {
        zoomTo(1);
        return;
      }
      if (containerSize.w <= 0 || baseDims.w <= 0) return;
      const fitMode = mode as "fit-page" | "fit-width";
      setZoomMode(fitMode);
      setScale(clampPdfZoom(fitScaleFor(baseDims.w, baseDims.h, containerSize.w, containerSize.h, fitMode)));
    },
    [zoomTo, containerSize.w, containerSize.h, baseDims.w, baseDims.h],
  );

  const jumpToPage = useCallback(
    (pageNumber: number): void => {
      const clamped = Math.min(Math.max(pageNumber, 1), numPages);
      virtualizer.scrollToIndex(clamped - 1, { align: "start" });
      setPageInput(String(clamped));
      setCurrentPage(clamped);
    },
    [numPages, virtualizer],
  );

  // 滚动 → 当前页指示
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    pdfViewerStats.listeners += 1;
    let raf = 0;
    const onScroll = (): void => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (offsets.length > 0) setCurrentPage(pageAtScrollTop(offsets, el.scrollTop) + 1);
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
      pdfViewerStats.listeners -= 1;
    };
  }, [offsets]);

  // 搜索：防抖 + 后台逐页抽取 + 渐进匹配
  useEffect(() => {
    searchTokenRef.current && (searchTokenRef.current.cancelled = true);
    if (!searchQuery.trim() || !sessionRef.current) {
      setSearchState(emptySearchState());
      setSearchExtracting(false);
      return;
    }
    const token = { cancelled: false };
    searchTokenRef.current = token;
    setSearchExtracting(true);
    setSearchState((prev) => ({ ...emptySearchState(), query: searchQuery }));
    void (async () => {
      await extractAllPageTexts(sessionRef.current!.doc, pageCacheRef.current, token, (result) => {
        if (token.cancelled) return;
        setSearchState((prev) => {
          const next = addPageMatches({ ...prev, query: searchQuery }, result.pageNumber, result.text);
          // 首个命中出现时跳转
          if (prev.total === 0 && next.total > 0 && result.pageNumber > 0) {
            const page = result.pageNumber;
            setTimeout(() => jumpToPage(page), 0);
          }
          return next;
        });
      });
      if (!token.cancelled) setSearchExtracting(false);
    })();
    return () => {
      token.cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);

  // 命中导航
  const goToMatch = useCallback(
    (delta: 1 | -1): void => {
      if (searchState.total === 0) return;
      let index = (searchState.currentIndex + delta + searchState.total) % searchState.total;
      let page = 0;
      let local = 0;
      let acc = 0;
      for (const [p, ranges] of searchState.matches) {
        if (index < acc + ranges.length) {
          page = p;
          local = index - acc;
          break;
        }
        acc += ranges.length;
      }
      if (page > 0) {
        setSearchState((prev) => ({ ...prev, currentIndex: index, currentPage: page }));
        jumpToPage(page);
        void local;
      }
    },
    [searchState, jumpToPage],
  );

  const activeIndexForPage = useCallback(
    (pageNumber: number): number => {
      let acc = 0;
      for (const [p, ranges] of searchState.matches) {
        if (p === pageNumber) {
          const local = searchState.currentIndex - acc;
          return local >= 0 && local < ranges.length ? local : -1;
        }
        acc += ranges.length;
      }
      return -1;
    },
    [searchState],
  );

  const items = virtualizer.getVirtualItems();

  return (
    <div
      className={`pdf-viewer ${theme === "dark" ? "pdf-viewer--dark" : ""}`}
      style={{ "--scale-factor": scale } as React.CSSProperties}
    >
      <div className="pdf-viewer-toolbar">
        <span className="pdf-viewer-title" title={name}>{name ?? "PDF"}</span>
        <span className="pdf-viewer-meta">
          {numPages > 0 ? `${numPages} 页` : "解析中…"}
        </span>
        <div className="pdf-viewer-page-jump">
          <input
            className="pdf-viewer-page-input"
            value={pageInput}
            placeholder={String(currentPage)}
            onChange={(e) => setPageInput(e.target.value.replace(/[^0-9]/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Enter") jumpToPage(parseInt(pageInput || String(currentPage), 10) || 1);
            }}
            aria-label="页码跳转"
          />
          <span className="pdf-viewer-page-total">/ {numPages || "–"}</span>
          <button type="button" className="pdf-viewer-btn" data-action="jump" onClick={() => jumpToPage(parseInt(pageInput || String(currentPage), 10) || 1)}>
            跳转
          </button>
        </div>
        <div className="pdf-viewer-zoom">
          <button type="button" className="pdf-viewer-btn" data-action="fit-page" onClick={() => setMode("fit-page")} title="fit-page">
            <IconExpand size={13} /> 页宽
          </button>
          <button type="button" className="pdf-viewer-btn" data-action="fit-width" onClick={() => setMode("fit-width")} title="fit-width">
            <IconMinimize size={13} /> 宽度
          </button>
          <button type="button" className="pdf-viewer-btn" data-action="zoom-100" onClick={() => setMode("100%")} title="100%">
            <IconRotate size={13} /> 100%
          </button>
          <button type="button" className="pdf-viewer-btn" data-action="zoom-out" onClick={() => zoomTo(scale / 1.25)} title="缩小">
            <IconZoomOut size={13} />
          </button>
          <button type="button" className="pdf-viewer-btn" data-action="zoom-in" onClick={() => zoomTo(scale * 1.25)} title="放大">
            <IconZoomIn size={13} />
          </button>
          <span className="pdf-viewer-scale" data-testid="pdf-scale">{Math.round(scale * 100)}%</span>
        </div>
        <div className="pdf-viewer-search">
          <IconSearch size={13} />
          <input
            className="pdf-viewer-search-input"
            value={searchQuery}
            placeholder="搜索…"
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label="PDF 搜索"
          />
          {searchState.total > 0 && (
            <span className="pdf-viewer-search-count" data-testid="pdf-search-count">
              {searchState.currentIndex + 1}/{searchState.total}
            </span>
          )}
          {searchExtracting && <span className="pdf-viewer-search-status">检索中…</span>}
          <button type="button" className="pdf-viewer-btn" data-action="search-prev" onClick={() => goToMatch(-1)} title="上一个命中">
            <IconChevronUp size={13} />
          </button>
          <button type="button" className="pdf-viewer-btn" data-action="search-next" onClick={() => goToMatch(1)} title="下一个命中">
            <IconChevronDown size={13} />
          </button>
          {searchQuery && (
            <button type="button" className="pdf-viewer-btn" data-action="search-clear" onClick={() => setSearchQuery("")} title="清除搜索">
              <IconX size={13} />
            </button>
          )}
        </div>
      </div>
      <div ref={containerRef} className="pdf-viewer-stage">
        {loading && <div className="pdf-viewer-status">正在解析 PDF…</div>}
        {error && <div className="pdf-viewer-status">PDF 加载失败：{error}</div>}
        {!loading && !error && (
          <div ref={scrollRef} className="pdf-viewer-scroll" data-testid="pdf-scroll">
            <div className="pdf-viewer-inner" style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
              {items.map((item) => {
                const pageNumber = item.index + 1;
                const dims = dimsRef.current.get(pageNumber) ?? baseDims;
                const ranges = searchState.matches.get(pageNumber);
                return (
                  <div
                    key={pageNumber}
                    data-index={item.index}
                    className="pdf-page-slot"
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      height: pageHeights[item.index],
                      transform: `translateY(${item.start}px)`,
                    }}
                  >
                    <PdfPageView
                      pageNumber={pageNumber}
                      scale={scale}
                      dims={dims}
                      dpr={dpr}
                      getPage={getPage}
                      searchRanges={ranges}
                      activeIndex={activeIndexForPage(pageNumber)}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
