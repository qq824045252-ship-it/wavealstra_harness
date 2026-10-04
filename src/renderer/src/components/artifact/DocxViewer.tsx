import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "@/store/appStore";
import { clampZoom, fitScaleFor } from "@/lib/viewMath";
import {
  collectPageText,
  cumulativeOffsets,
  decodeDataUriBytes,
  DOCX_PAGE_GAP,
  docxViewerStats,
  pageAtScrollTop,
  recycleRange,
  visibleRange,
  searchMatches,
  type TextMatch,
} from "@/lib/docxView";
import { applySearchHighlights, clearSearchHighlights } from "@/lib/searchHighlight";
import { shouldSkipOfficePreview } from "@shared/office-preview";
import {
  IconChevronDown,
  IconChevronUp,
  IconExpand,
  IconMinimize,
  IconRotate,
  IconSearch,
  IconX,
  IconZoomIn,
  IconZoomOut,
} from "@/components/common/icons";

interface Props {
  content: string;
  name?: string;
}

type ZoomMode = "fit-page" | "fit-width" | "manual";

interface DocxPage {
  /** 页节点（超距回收后为 null，回看时 re-render 恢复） */
  node: HTMLElement | null;
  /** 原始尺寸（未缩放，px） */
  w: number;
  h: number;
  /** 当前是否挂载在视口 mount 中 */
  mounted: boolean;
}

interface SearchState {
  query: string;
  matches: Map<number, TextMatch[]>;
  total: number;
  currentIndex: number;
  currentPage: number;
}

const OVERSANCAN = 2;
const RECYCLE_MARGIN = 3;

/**
 * Wave 5D-1 — DOCX Artifact 视图（§88 / 1H spike：docx-preview）
 *
 * paged 渲染：parseAsync 一次 → renderDocument 全量分页节点 → 手动窗口化：
 * 可见页挂载到 mount div、超距页真回收（节点销毁，内存受控）、回看按需
 * re-render 恢复。zoom：fit-width / fit-page / 100% / ±（transform scale，
 * 不重排文档）。搜索：逐页文本 + mark 高亮 + prev/next；文本选择 = 原生 HTML。
 */
export default function DocxViewer({ content, name }: Props): React.JSX.Element {
  const theme = useAppStore((s) => s.theme);
  const skipPreview = shouldSkipOfficePreview(content);
  const scrollRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const styleHostRef = useRef<HTMLDivElement>(null);
  const mountRefs = useRef(new Map<number, HTMLDivElement>());

  const [pages, setPages] = useState<DocxPage[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [scale, setScale] = useState(1);
  const [zoomMode, setZoomMode] = useState<ZoomMode>("fit-page");
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  const [range, setRange] = useState({ start: 0, end: -1 });
  const [currentPage, setCurrentPage] = useState(1);
  const [pageInput, setPageInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchState, setSearchState] = useState<SearchState>({
    query: "",
    matches: new Map(),
    total: 0,
    currentIndex: 0,
    currentPage: 0,
  });

  const pagesRef = useRef<DocxPage[]>([]);
  const parsedDocRef = useRef<unknown>(null);
  const renderTokenRef = useRef(0);
  const anchorRef = useRef<{ pageIndex: number; offset: number } | null>(null);
  const searchTextCache = useRef(new Map<number, string>());

  useEffect(() => {
    pagesRef.current = pages;
  }, [pages]);

  // 打开/解析文档
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setError("");
    setPages([]);
    pagesRef.current = [];
    searchTextCache.current = new Map();
    setSearchState({ query: "", matches: new Map(), total: 0, currentIndex: 0, currentPage: 0 });
    setSearchQuery("");
    renderTokenRef.current += 1;
    if (skipPreview) {
      setReady(true);
      return () => {
        cancelled = true;
        renderTokenRef.current += 1;
      };
    }

    void (async () => {
      try {
        const docx = await import("docx-preview");
        const bytes = decodeDataUriBytes(content);
        const blob = new Blob([bytes as BlobPart], {
          type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        });
        const renderOptions = {
          breakPages: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
          inWrapper: true,
          className: "docx",
        };
        docxViewerStats.docs += 1;
        const parsed = await docx.parseAsync(blob, renderOptions);
        if (cancelled) return;
        parsedDocRef.current = parsed;
        const nodes = await docx.renderDocument(parsed, renderOptions);
        docxViewerStats.renders += 1;
        if (cancelled) return;
        const host = styleHostRef.current;
        if (!host) return;
        host.replaceChildren();
        // docx-preview 输出：div.docx-wrapper > section.docx×N（inWrapper 时）
        const wrapper = nodes.find(
          (n) => n.nodeType === Node.ELEMENT_NODE && n.nodeName === "DIV" && String((n as HTMLElement).className ?? "").includes("docx-wrapper"),
        ) as HTMLElement | undefined;
        // STYLE 节点与 wrapper 进入宿主（样式必须挂载才能生效/测量）
        for (const n of nodes) {
          if (n.nodeName === "STYLE") host.appendChild(n);
        }
        const pageEls: HTMLElement[] = wrapper
          ? Array.from(wrapper.querySelectorAll("section.docx"))
          : (nodes.filter((n) => n.nodeType === Node.ELEMENT_NODE && n.nodeName !== "STYLE") as HTMLElement[]);
        if (wrapper) host.appendChild(wrapper);
        const pageNodes: DocxPage[] = pageEls.map((el) => ({
          node: el,
          w: el.offsetWidth || 842,
          h: el.offsetHeight || 1122,
          mounted: false,
        }));
        if (pageNodes.length === 0) throw new Error("docx-preview 未产出分页");
        setPages(pageNodes);
        setReady(true);
      } catch (reason) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason));
          setReady(true);
        }
      }
    })();

    return () => {
      cancelled = true;
      renderTokenRef.current += 1;
      parsedDocRef.current = null;
      docxViewerStats.docs -= 1;
    };
  }, [content, skipPreview]);

  // 容器尺寸观测
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    docxViewerStats.observers += 1;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setContainerSize({ w: rect.width, h: rect.height });
    });
    observer.observe(container);
    const rect = container.getBoundingClientRect();
    setContainerSize({ w: rect.width, h: rect.height });
    return () => {
      observer.disconnect();
      docxViewerStats.observers -= 1;
    };
  }, []);

  // fit 模式跟随容器尺寸
  useEffect(() => {
    if (zoomMode === "manual" || containerSize.w <= 0 || pages.length === 0) return;
    const first = pages[0];
    if (!first) return;
    setScale(clampZoom(fitScaleFor(first.w, first.h, containerSize.w, containerSize.h, zoomMode)));
  }, [zoomMode, containerSize.w, containerSize.h, pages]);

  // 页高表（含间距，缩放后）；offsets 按内容签名稳定（防 setPages 导致 effect 重挂 → 回收循环）
  const pageHeights = useMemo(() => pages.map((p) => p.h * scale + DOCX_PAGE_GAP), [pages, scale]);
  const pageHeightsKey = pageHeights.join(",");
  const offsets = useMemo(() => cumulativeOffsets(pageHeights), [pageHeightsKey]);
  const totalHeight = offsets.length > 0 ? offsets[offsets.length - 1] + pageHeights[pageHeights.length - 1] : 0;

  // 缩放锚点保持
  useEffect(() => {
    if (anchorRef.current && offsets.length > 0) {
      const { pageIndex, offset } = anchorRef.current;
      anchorRef.current = null;
      const el = scrollRef.current;
      if (el) el.scrollTop = Math.max(0, offsets[pageIndex] + offset);
    }
  }, [offsets]);

  const zoomTo = useCallback(
    (nextScale: number): void => {
      const el = scrollRef.current;
      if (el && offsets.length > 0) {
        const pageIndex = pageAtScrollTop(offsets, el.scrollTop);
        anchorRef.current = { pageIndex, offset: el.scrollTop - offsets[pageIndex] };
      }
      setScale(clampZoom(nextScale));
      setZoomMode("manual");
    },
    [offsets],
  );

  const setMode = useCallback(
    (mode: ZoomMode | "100%"): void => {
      if (mode === "100%") {
        zoomTo(1);
        return;
      }
      if (containerSize.w <= 0 || pages.length === 0) return;
      const first = pages[0];
      if (!first) return;
      const fitMode = mode as "fit-page" | "fit-width";
      setZoomMode(fitMode);
      setScale(clampZoom(fitScaleFor(first.w, first.h, containerSize.w, containerSize.h, fitMode)));
    },
    [zoomTo, containerSize.w, containerSize.h, pages],
  );

  const jumpToPage = useCallback(
    (pageNumber: number): void => {
      const clamped = Math.min(Math.max(pageNumber, 1), pages.length);
      const el = scrollRef.current;
      if (el && offsets.length > 0) el.scrollTop = Math.max(0, offsets[clamped - 1]);
      setPageInput(String(clamped));
      setCurrentPage(clamped);
    },
    [pages.length, offsets],
  );

  // 挂载/回收页节点（手动窗口化核心）
  const mountPage = useCallback((index: number): void => {
    const mount = mountRefs.current.get(index);
    const page = pagesRef.current[index];
    if (!mount || !page) return;
    if (page.node) {
      if (!page.mounted) {
        mount.replaceChildren(page.node);
        page.mounted = true;
        docxViewerStats.pagesLive += 1;
      }
      return;
    }
    // 节点已回收 → 触发整篇 re-render 恢复
    void requestReRender();
  }, []);

  const requestReRenderRef = useRef<(() => void) | null>(null);
  const requestReRender = useCallback((): void => {
    requestReRenderRef.current?.();
  }, []);

  // 整篇 re-render 恢复回收页（parseAsync 结果缓存，renderDocument 复用）
  useEffect(() => {
    requestReRenderRef.current = async () => {
      const token = ++renderTokenRef.current;
      const host = styleHostRef.current;
      const doc = parsedDocRef.current;
      if (!host || !doc) return;
      try {
        const docx = await import("docx-preview");
        const nodes = await docx.renderDocument(doc, {
          breakPages: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
          inWrapper: true,
          className: "docx",
        });
        if (token !== renderTokenRef.current) return;
        docxViewerStats.renders += 1;
        host.replaceChildren();
        const wrapper = nodes.find(
          (n) => n.nodeType === Node.ELEMENT_NODE && n.nodeName === "DIV" && String((n as HTMLElement).className ?? "").includes("docx-wrapper"),
        ) as HTMLElement | undefined;
        const pageEls: HTMLElement[] = wrapper
          ? Array.from(wrapper.querySelectorAll("section.docx"))
          : (nodes.filter((n) => n.nodeType === Node.ELEMENT_NODE && n.nodeName !== "STYLE") as HTMLElement[]);
        if (pageEls.length === 0 && docxViewerStats.renders % 10 === 0) {
          console.log("[DocxViewer] re-render 无 section，wrapper=", !!wrapper, "nodes=", nodes.length);
        }
        if (wrapper) host.appendChild(wrapper);
        const next: DocxPage[] = pageEls.map((el, i) => ({
          node: el,
          w: el.offsetWidth || pagesRef.current[i]?.w || 842,
          h: el.offsetHeight || pagesRef.current[i]?.h || 1122,
          mounted: false,
        }));
        pagesRef.current = next;
        setPages(next);
        // 等 React 提交新 slots 后再挂载可见页（rAF 保证在 commit 之后）
        requestAnimationFrame(() => {
          const scrollEl = scrollRef.current;
          if (scrollEl) {
            const heights = next.map((p) => p.h * scale + DOCX_PAGE_GAP);
            const nextRange = visibleRange(cumulativeOffsets(heights), scrollEl.scrollTop, scrollEl.clientHeight, OVERSANCAN);
            for (let k = nextRange.start; k <= nextRange.end; k += 1) mountPage(k);
          }
        });
      } catch (reason) {
        console.warn("[DocxViewer] re-render 失败", reason);
      }
    };
    return () => {
      requestReRenderRef.current = null;
    };
  }, [scale, mountPage]);

  // 滚动 → 窗口计算 + 挂载/回收
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    docxViewerStats.listeners += 1;
    let raf = 0;
    let lastRangeKey = "";
    const update = (): void => {
      const next = visibleRange(offsets, el.scrollTop, el.clientHeight, OVERSANCAN);
      const rangeKey = `${next.start}:${next.end}`;
      setRange(next);
      setCurrentPage(pageAtScrollTop(offsets, el.scrollTop) + 1);
      for (let i = next.start; i <= next.end; i += 1) mountPage(i);
      // 窗口未变 → 跳过回收（防 setPages/offsets 重挂后误伤刚恢复的节点）
      if (rangeKey === lastRangeKey) return;
      lastRangeKey = rangeKey;
      // 超距真回收（节点销毁，内存受控）
      const { keepStart, keepEnd } = recycleRange(offsets, el.scrollTop, el.clientHeight, OVERSANCAN, RECYCLE_MARGIN);
      const arr = pagesRef.current;
      for (let i = 0; i < arr.length; i += 1) {
        const page = arr[i];
        if (!page) continue;
        if (i < keepStart || i > keepEnd) {
          if (page.mounted) {
            mountRefs.current.get(i)?.replaceChildren();
            page.mounted = false;
            docxViewerStats.pagesLive -= 1;
          }
          if (page.node) {
            page.node.remove();
            page.node = null;
          }
          searchTextCache.current.delete(i + 1);
        }
      }
    };
    const onScroll = (): void => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(update);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    update();
    return () => {
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
      docxViewerStats.listeners -= 1;
    };
  }, [offsets, mountPage]);

  // 初始窗口
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || offsets.length === 0) return;
    const next = visibleRange(offsets, el.scrollTop, el.clientHeight, OVERSANCAN);
    setRange(next);
    for (let i = next.start; i <= next.end; i += 1) mountPage(i);
  }, [ready, offsets, mountPage]);

  // 卸载清理
  useEffect(() => {
    return () => {
      renderTokenRef.current += 1;
      for (const page of pagesRef.current) {
        if (page.node) page.node.remove();
      }
      pagesRef.current = [];
      styleHostRef.current?.replaceChildren();
      docxViewerStats.pagesLive = 0;
    };
  }, []);

  // 搜索
  useEffect(() => {
    if (!searchQuery.trim() || pages.length === 0) {
      setSearchState({ query: "", matches: new Map(), total: 0, currentIndex: 0, currentPage: 0 });
      for (const page of pagesRef.current) {
        if (page.node) clearSearchHighlights(page.node);
      }
      return;
    }
    setSearchState((prev) => ({ ...prev, query: searchQuery }));
    // 搜索需要全文：被回收页先整篇 re-render 恢复（完成后 pages 变化 → 本 effect 重跑）
    if (pagesRef.current.some((p) => !p.node)) {
      void requestReRender();
      return;
    }
    const matches = new Map<number, TextMatch[]>();
    let total = 0;
    let firstPage = 0;
    for (let i = 0; i < pagesRef.current.length; i += 1) {
      const page = pagesRef.current[i];
      if (!page) continue;
      const cached = searchTextCache.current.get(i + 1);
      const text = cached ?? (page.node ? collectPageText(page.node) : "");
      if (!cached && page.node) searchTextCache.current.set(i + 1, text);
      const ranges = searchMatches(text, searchQuery);
      if (ranges.length > 0) {
        matches.set(i + 1, ranges);
        total += ranges.length;
        if (!firstPage) firstPage = i + 1;
      }
    }
    setSearchState({ query: searchQuery, matches, total, currentIndex: 0, currentPage: firstPage });
    if (firstPage) jumpToPage(firstPage);
    for (const [pageNumber, ranges] of matches) {
      const page = pagesRef.current[pageNumber - 1];
      if (page?.node && page.mounted) applySearchHighlights(page.node, ranges, 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, pages]);

  // 命中导航
  const goToMatch = useCallback(
    (delta: 1 | -1): void => {
      if (searchState.total === 0) return;
      const index = (searchState.currentIndex + delta + searchState.total) % searchState.total;
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
        for (const [p, ranges] of searchState.matches) {
          const pNode = pagesRef.current[p - 1];
          if (pNode?.node && pNode.mounted) {
            applySearchHighlights(pNode.node, ranges, p === page ? local : -1);
          }
        }
      }
    },
    [searchState, jumpToPage],
  );

  if (skipPreview) {
    return (
      <div
        className={`docx-viewer ${theme === "dark" ? "docx-viewer--dark" : ""}`}
        data-testid="office-preview-skipped"
      />
    );
  }

  return (
    <div className={`docx-viewer ${theme === "dark" ? "docx-viewer--dark" : ""}`}>
      <div className="docx-viewer-toolbar">
        <span className="docx-viewer-title" title={name}>
          {name ?? "DOCX"}
        </span>
        <span className="docx-viewer-meta">{ready ? `${pages.length} 页` : "解析中…"}</span>
        <div className="docx-viewer-page-jump">
          <input
            className="docx-viewer-page-input"
            value={pageInput}
            placeholder={String(currentPage)}
            onChange={(e) => setPageInput(e.target.value.replace(/[^0-9]/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Enter") jumpToPage(parseInt(pageInput || String(currentPage), 10) || 1);
            }}
            aria-label="页码跳转"
          />
          <span className="docx-viewer-page-total">/ {pages.length || "–"}</span>
          <button
            type="button"
            className="docx-viewer-btn"
            data-action="jump"
            onClick={() => jumpToPage(parseInt(pageInput || String(currentPage), 10) || 1)}
          >
            跳转
          </button>
        </div>
        <div className="docx-viewer-zoom">
          <button type="button" className="docx-viewer-btn" data-action="fit-page" onClick={() => setMode("fit-page")} title="fit-page">
            <IconExpand size={13} /> 页宽
          </button>
          <button type="button" className="docx-viewer-btn" data-action="fit-width" onClick={() => setMode("fit-width")} title="fit-width">
            <IconMinimize size={13} /> 宽度
          </button>
          <button type="button" className="docx-viewer-btn" data-action="zoom-100" onClick={() => setMode("100%")} title="100%">
            <IconRotate size={13} /> 100%
          </button>
          <button type="button" className="docx-viewer-btn" data-action="zoom-out" onClick={() => zoomTo(scale / 1.25)} title="缩小">
            <IconZoomOut size={13} />
          </button>
          <button type="button" className="docx-viewer-btn" data-action="zoom-in" onClick={() => zoomTo(scale * 1.25)} title="放大">
            <IconZoomIn size={13} />
          </button>
          <span className="docx-viewer-scale" data-testid="docx-scale">
            {Math.round(scale * 100)}%
          </span>
        </div>
        <div className="docx-viewer-search">
          <IconSearch size={13} />
          <input
            className="docx-viewer-search-input"
            value={searchQuery}
            placeholder="搜索…"
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label="DOCX 搜索"
          />
          {searchState.total > 0 && (
            <span className="docx-viewer-search-count" data-testid="docx-search-count">
              {searchState.currentIndex + 1}/{searchState.total}
            </span>
          )}
          <button type="button" className="docx-viewer-btn" data-action="search-prev" onClick={() => goToMatch(-1)} title="上一个命中">
            <IconChevronUp size={13} />
          </button>
          <button type="button" className="docx-viewer-btn" data-action="search-next" onClick={() => goToMatch(1)} title="下一个命中">
            <IconChevronDown size={13} />
          </button>
          {searchQuery && (
            <button type="button" className="docx-viewer-btn" data-action="search-clear" onClick={() => setSearchQuery("")} title="清除搜索">
              <IconX size={13} />
            </button>
          )}
        </div>
      </div>
      <div ref={containerRef} className="docx-viewer-stage">
        {!ready && !error && <div className="docx-viewer-status">正在解析 DOCX…</div>}
        {error && <div className="docx-viewer-status">DOCX 加载失败：{error}</div>}
        {ready && !error && (
          <div ref={scrollRef} className="docx-viewer-scroll" data-testid="docx-scroll">
            <div className="docx-viewer-inner" style={{ height: totalHeight, position: "relative" }}>
              {range.start >= 0 &&
                Array.from({ length: range.end - range.start + 1 }, (_, k) => {
                  const index = range.start + k;
                  const page = pages[index];
                  if (!page) return null;
                  return (
                    <div
                      key={index}
                      className="docx-page-slot"
                      data-page={index + 1}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        height: page.h * scale,
                        transform: `translateY(${offsets[index]}px)`,
                      }}
                    >
                      <div
                        className="docx-page-frame"
                        style={{
                          width: page.w * scale,
                          height: page.h * scale,
                          transform: `scale(${scale})`,
                          transformOrigin: "top left",
                        }}
                      >
                        <div
                          className="docx-page-mount"
                          style={{ width: page.w, height: page.h }}
                          ref={(el) => {
                            // 用 pagesRef 当前值而非渲染闭包（闭包在重渲染后 stale，会误触发 re-render 循环）
                            const current = pagesRef.current[index];
                            if (el) {
                              const prev = mountRefs.current.get(index);
                              if (prev !== el) {
                                mountRefs.current.set(index, el);
                                if (current?.node && !current.mounted) {
                                  el.replaceChildren(current.node);
                                  current.mounted = true;
                                  docxViewerStats.pagesLive += 1;
                                } else if (!current?.node) {
                                  // 节点已回收：请求整篇 re-render 恢复（commit 后此处才可触达）
                                  void requestReRender();
                                }
                              }
                            } else {
                              const had = mountRefs.current.has(index);
                              mountRefs.current.delete(index);
                              if (had && current?.mounted) {
                                current.mounted = false;
                                docxViewerStats.pagesLive -= 1;
                              }
                            }
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        )}
      </div>
      {/* docx-preview 样式与页节点的隐藏宿主（必须挂载才能测量/注入样式） */}
      <div ref={styleHostRef} className="docx-viewer-style-host" aria-hidden="true" />
      <div className="docx-viewer-hint">文本可选择复制 · 缩放 fit/宽度/100%/± · 搜索高亮 · 页节点按视口挂载/回收</div>
    </div>
  );
}
