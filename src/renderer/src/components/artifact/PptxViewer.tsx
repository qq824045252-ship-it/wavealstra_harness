import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "@/store/appStore";
import {
  parsePptxModel,
  pptxViewerStats,
  searchSlides,
  type FillStyle,
  type PptxModel,
  type ShapeModel,
  type SlideModel,
  type TableModel,
  type TextStyle,
} from "@/lib/pptxView";
import { applySearchHighlights, clearSearchHighlights } from "@/lib/searchHighlight";
import { decodeBase64DataUri, hasZipMagic } from "@/lib/binaryArtifact";
import { shouldSkipOfficePreview } from "@shared/office-preview";
import { IconChevronLeft, IconChevronRight, IconExpand, IconRotate, IconSearch, IconX, IconZoomIn, IconZoomOut } from "@/components/common/icons";

interface Props {
  content: string;
  name?: string;
}

const MAIN_MARGIN = 1; // 主区预渲染 ±1
const THUMB_OVERSCAN = 2;
const THUMB_SCALE = 0.18;
const THUMB_GAP = 16; // 缩略图纵向间距（为 active 边框/圆角/阴影留完整显示空间）；两处 thumbH 计算共用

function mediaMime(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "svg") return "image/svg+xml";
  return "image/png";
}

function fillToCss(fill: FillStyle | undefined): React.CSSProperties {
  if (!fill) return {};
  if (fill.type === "solid" && fill.color) {
    return { background: fill.color, opacity: fill.alpha !== undefined ? Math.max(0.05, fill.alpha / 100) : undefined };
  }
  if (fill.type === "gradient" && fill.colors && fill.colors.length >= 2) {
    const angle = fill.angle !== undefined ? fill.angle : 0;
    return { background: `linear-gradient(${angle}deg, ${fill.colors.join(", ")})` };
  }
  if (fill.type === "blip") {
    return { backgroundSize: "cover", backgroundPosition: "center" };
  }
  return {};
}

function renderText(text: TextStyle | undefined): React.JSX.Element | null {
  if (!text) return null;
  return (
    <>
      {text.paragraphs.map((p, pi) => (
        <div
          key={pi}
          className="pptx-para"
          style={{ textAlign: (p.align as React.CSSProperties["textAlign"]) ?? "left" }}
        >
          {p.runs.map((r, ri) => (
            <span
              key={ri}
              style={{
                fontSize: r.size,
                fontWeight: r.bold ? 600 : undefined,
                fontStyle: r.italic ? "italic" : undefined,
                color: r.color,
                fontFamily: r.font,
                textDecoration: r.underline ? "underline" : undefined,
              }}
            >
              {r.text}
            </span>
          ))}
        </div>
      ))}
    </>
  );
}

/** 渲染单个 shape（递归 group） */
function renderShape(shape: ShapeModel, media: Map<string, Uint8Array>, scaleX = 1, scaleY = 1): React.JSX.Element | null {
  if (shape.hidden) return null;
  const style: React.CSSProperties = {
    position: "absolute",
    left: shape.x * scaleX,
    top: shape.y * scaleY,
    width: shape.w * scaleX,
    height: shape.h * scaleY,
    zIndex: shape.zIndex,
    ...(shape.rotation !== 0 ? { transform: `rotate(${shape.rotation}deg)` } : {}),
    ...fillToCss(shape.fill),
  };
  if (shape.line?.color) {
    style.border = `${shape.line.width ?? 1}px solid ${shape.line.color}`;
    style.boxSizing = "border-box";
  }

  if (shape.type === "image" && shape.image) {
    const bytes = media.get(shape.image.mediaPath);
    if (bytes) {
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const dataUrl = `data:${mediaMime(shape.image.mediaPath)};base64,${btoa(bin)}`;
      return <div key={shape.id} className="pptx-shape" style={style}><img src={dataUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "fill" }} draggable={false} /></div>;
    }
  }

  if (shape.type === "table" && shape.table) {
    return <div key={shape.id} className="pptx-shape pptx-table" style={{ ...style, overflow: "hidden" }}>{renderTable(shape.table)}</div>;
  }

  if (shape.type === "group" && shape.children) {
    const sx = shape.chExt && shape.chExt.x > 0 ? (shape.w * scaleX) / shape.chExt.x : scaleX;
    const sy = shape.chExt && shape.chExt.y > 0 ? (shape.h * scaleY) / shape.chExt.y : scaleY;
    return (
      <div key={shape.id} className="pptx-shape pptx-group" style={{ ...style, overflow: "visible" }}>
        {shape.children.map((c) => renderShape(c, media, sx, sy))}
      </div>
    );
  }

  // text / shape
  const hasText = shape.text && shape.text.paragraphs.some((p) => p.runs.some((r) => r.text.trim()));
  return (
    <div key={shape.id} className={`pptx-shape${hasText ? " pptx-shape--text" : ""}`} style={style}>
      {hasText && <div className="pptx-text">{renderText(shape.text)}</div>}
    </div>
  );
}

function renderTable(table: TableModel): React.JSX.Element {
  const cells: React.JSX.Element[] = [];
  let idx = 0;
  for (let r = 0; r < table.rows; r += 1) {
    const rowCells: React.JSX.Element[] = [];
    for (let c = 0; c < table.cols; c += 1) {
      const cell = table.cells[idx];
      idx += 1;
      if (!cell) continue;
      rowCells.push(
        <td key={`${r}-${c}`} colSpan={cell.colspan ?? 1} rowSpan={cell.rowspan ?? 1} style={{ background: cell.fill, fontSize: cell.size, color: cell.color, fontWeight: cell.bold ? 600 : undefined, border: "1px solid #999", padding: "4px 8px" }}>
          {cell.text}
        </td>,
      );
    }
    cells.push(<tr key={r}>{rowCells}</tr>);
  }
  return (
    <table className="pptx-table-inner" style={{ width: "100%", height: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
      <tbody>{cells}</tbody>
    </table>
  );
}

function renderSlide(slide: SlideModel, media: Map<string, Uint8Array>): React.JSX.Element {
  return (
    <div className="pptx-slide-inner" style={{ width: slide.width, height: slide.height, ...fillToCss(slide.background) }}>
      {slide.shapes.map((s) => renderShape(s, media))}
    </div>
  );
}

interface SearchState {
  query: string;
  matches: Array<{ slideIndex: number; text: string }>;
  total: number;
  current: number;
}

/**
 * Wave 5D-3 — PPTX Artifact 视图（§88 / 1H spike：自研 OOXML slide 渲染器）
 *
 * 左侧缩略图 rail（lazy 窗口化）+ 主 slide 区（当前 ±1 预渲染，远端回收）+
 * fit-slide/100%/zoom + 键盘导航 + 搜索跳转高亮。slide = 绝对定位 div
 * （shape/image/table/文本 run，rotation/fill/line/z-order/group 缩放）。
 */
export default function PptxViewer({ content, name }: Props): React.JSX.Element {
  const theme = useAppStore((s) => s.theme);
  const skipPreview = shouldSkipOfficePreview(content);
  const stageRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);

  const [model, setModel] = useState<PptxModel | null>(null);
  const [error, setError] = useState("");
  const [current, setCurrent] = useState(0);
  const [zoom, setZoom] = useState<"fit" | number>(0.5);
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });
  const [thumbWindow, setThumbWindow] = useState({ start: 0, end: -1 });
  const [searchState, setSearchState] = useState<SearchState>({ query: "", matches: [], total: 0, current: 0 });
  const [searchQuery, setSearchQuery] = useState("");
  const [pageInput, setPageInput] = useState("");

  const modelRef = useRef<PptxModel | null>(null);
  const slideRefs = useRef(new Map<number, HTMLDivElement>());
  const thumbRefs = useRef(new Map<number, HTMLDivElement>());

  useEffect(() => {
    modelRef.current = model;
  }, [model]);

  // 打开解析
  useEffect(() => {
    let cancelled = false;
    setError("");
    setModel(null);
    setCurrent(0);
    setSearchState({ query: "", matches: [], total: 0, current: 0 });
    setSearchQuery("");
    if (skipPreview) return () => { cancelled = true; };
    void (async () => {
      try {
        const { bytes } = decodeBase64DataUri(content);
        if (!hasZipMagic(bytes)) {
          setError("PPTX 文件不是有效 ZIP/OOXML 数据");
          return;
        }
        pptxViewerStats.docs += 1;
        const parsed = await parsePptxModel(bytes);
        if (cancelled) return;
        setModel(parsed);
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      }
    })();
    return () => {
      cancelled = true;
      pptxViewerStats.docs -= 1;
    };
  }, [content, skipPreview]);

  // stage 尺寸
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    pptxViewerStats.observers += 1;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setStageSize({ w: rect.width, h: rect.height });
    });
    observer.observe(stage);
    const rect = stage.getBoundingClientRect();
    setStageSize({ w: rect.width, h: rect.height });
    return () => {
      observer.disconnect();
      pptxViewerStats.observers -= 1;
    };
  }, []);

  const slideCount = model?.slides.length ?? 0;
  const slideW = model?.slides[0]?.width ?? 960;
  const slideH = model?.slides[0]?.height ?? 540;

  const fitZoom = useMemo(() => {
    if (stageSize.w <= 0 || stageSize.h <= 0) return 0.5;
    return Math.min((stageSize.w - 40) / slideW, (stageSize.h - 40) / slideH, 2);
  }, [stageSize.w, stageSize.h, slideW, slideH]);

  const effectiveZoom = zoom === "fit" ? fitZoom : zoom;
  const media = model?.media ?? new Map<string, Uint8Array>();

  // 缩略图 rail 滚动窗口
  useEffect(() => {
    const rail = railRef.current;
    if (!rail || slideCount === 0) return;
    pptxViewerStats.listeners += 1;
    let raf = 0;
    const update = (): void => {
      const thumbH = Math.round(slideH * THUMB_SCALE) + THUMB_GAP;
      const start = Math.max(0, Math.floor(rail.scrollTop / thumbH) - THUMB_OVERSCAN);
      const end = Math.min(slideCount - 1, Math.ceil((rail.scrollTop + rail.clientHeight) / thumbH) + THUMB_OVERSCAN);
      setThumbWindow({ start, end });
    };
    const onScroll = (): void => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(update);
    };
    rail.addEventListener("scroll", onScroll, { passive: true });
    update();
        // 首次窗口（rail 可能尚未布局，兜底初始窗口）
    if (thumbWindow.end < 0) setThumbWindow((prev) => (prev.end >= 0 ? prev : { start: 0, end: Math.min(6, slideCount - 1) }));
    return () => {
      rail.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
      pptxViewerStats.listeners -= 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slideCount, slideH]);

  // 主 slide 回收统计 + 卸载归零
  useEffect(() => {
    pptxViewerStats.slidesLive = 0;
    for (let i = Math.max(0, current - MAIN_MARGIN); i <= Math.min(slideCount - 1, current + MAIN_MARGIN); i += 1) {
      pptxViewerStats.slidesLive += 1;
    }
    return () => {
      pptxViewerStats.slidesLive = 0;
    };
  }, [current, slideCount]);

  const goTo = useCallback(
    (index: number): void => {
      setCurrent(Math.min(Math.max(index, 0), slideCount - 1));
      setPageInput(String(index + 1));
    },
    [slideCount],
  );

  const goToMatch = useCallback(
    (delta: 1 | -1): void => {
      const { matches, total, current: cur } = searchState;
      if (total === 0) return;
      const next = (cur + delta + total) % total;
      setSearchState((prev) => ({ ...prev, current: next }));
      goTo(matches[next]!.slideIndex);
    },
    [searchState, goTo],
  );

  // 键盘导航
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "ArrowRight" || e.key === "PageDown") goTo(current + 1);
      else if (e.key === "ArrowLeft" || e.key === "PageUp") goTo(current - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, goTo]);

  // 搜索
  useEffect(() => {
    if (!model) return;
    if (!searchQuery.trim()) {
      setSearchState({ query: "", matches: [], total: 0, current: 0 });
      for (const ref of slideRefs.current.values()) clearSearchHighlights(ref);
      return;
    }
    const { matches, total } = searchSlides(model.slides, searchQuery);
    setSearchState({ query: searchQuery, matches, total, current: 0 });
    if (matches.length > 0) goTo(matches[0]!.slideIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, model]);

  // 当前 slide 高亮
  useEffect(() => {
    if (!model || !searchState.query) return;
    const ref = slideRefs.current.get(current);
    if (!ref) return;
    const slide = model.slides[current];
    if (!slide) return;
    // 在文本节点上打 mark（textAll 定位）
    const ranges = findRanges(slide.textAll, searchState.query);
    if (ranges.length > 0) applySearchHighlights(ref, ranges, -1);
  }, [current, searchState, model]);

  if (skipPreview) {
    return (
      <div
        className={`pptx-viewer ${theme === "dark" ? "pptx-viewer--dark" : ""}`}
        data-testid="office-preview-skipped"
      />
    );
  }

  if (!model) {
    return (
      <div className={`pptx-viewer ${theme === "dark" ? "pptx-viewer--dark" : ""}`}>
        <div className="pptx-viewer-toolbar">
          <span className="pptx-viewer-title">{name ?? "PPTX"}</span>
          {error && <span className="pptx-viewer-status">加载失败：{error}</span>}
          {!error && <span className="pptx-viewer-status">正在解析…</span>}
        </div>
      </div>
    );
  }

  const mainSlides = [];
  for (let i = Math.max(0, current - MAIN_MARGIN); i <= Math.min(slideCount - 1, current + MAIN_MARGIN); i += 1) {
    mainSlides.push(
      <div
        key={i}
        className={`pptx-stage-slide${i === current ? " active" : ""}`}
        data-slide={i}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: slideW * effectiveZoom,
          height: slideH * effectiveZoom,
          opacity: i === current ? 1 : 0.6,
          pointerEvents: i === current ? "auto" : "none",
          transform: `translateX(${(i - current) * (slideW * effectiveZoom + 24)}px)`,
        }}
        onClick={() => goTo(i)}
      >
        <div style={{ transform: `scale(${effectiveZoom})`, transformOrigin: "top left", width: slideW, height: slideH }} ref={(el) => {
          if (el) slideRefs.current.set(i, el);
          else slideRefs.current.delete(i);
        }}>
          {renderSlide(model.slides[i]!, media)}
        </div>
      </div>,
    );
  }

  const thumbH = Math.round(slideH * THUMB_SCALE) + THUMB_GAP;

  return (
    <div className={`pptx-viewer ${theme === "dark" ? "pptx-viewer--dark" : ""}`}>
      <div className="pptx-viewer-toolbar">
        <span className="pptx-viewer-title" title={name}>{name ?? "PPTX"}</span>
        <span className="pptx-viewer-meta">{slideCount} slides</span>
        <div className="pptx-viewer-nav">
          <button type="button" className="pptx-viewer-btn" data-action="prev" onClick={() => goTo(current - 1)} title="上一页">
            <IconChevronLeft size={13} />
          </button>
          <input
            className="pptx-viewer-page-input"
            value={pageInput}
            placeholder={String(current + 1)}
            onChange={(e) => setPageInput(e.target.value.replace(/[^0-9]/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Enter") goTo(parseInt(pageInput || String(current + 1), 10) - 1);
            }}
            aria-label="页码跳转"
          />
          <span className="pptx-viewer-page-total">/ {slideCount}</span>
          <button type="button" className="pptx-viewer-btn" data-action="next" onClick={() => goTo(current + 1)} title="下一页">
            <IconChevronRight size={13} />
          </button>
        </div>
        <div className="pptx-viewer-zoom">
          <button type="button" className="pptx-viewer-btn" data-action="fit-slide" onClick={() => setZoom("fit")} title="fit-slide">
            <IconExpand size={13} /> fit
          </button>
          <button type="button" className="pptx-viewer-btn" data-action="zoom-100" onClick={() => setZoom(1)} title="100%">
            <IconRotate size={13} /> 100%
          </button>
          <button type="button" className="pptx-viewer-btn" data-action="zoom-out" onClick={() => setZoom(Math.max(0.2, (zoom === "fit" ? fitZoom : zoom) / 1.25))} title="缩小">
            <IconZoomOut size={13} />
          </button>
          <button type="button" className="pptx-viewer-btn" data-action="zoom-in" onClick={() => setZoom(Math.min(3, (zoom === "fit" ? fitZoom : zoom) * 1.25))} title="放大">
            <IconZoomIn size={13} />
          </button>
          <span className="pptx-viewer-scale" data-testid="pptx-scale">{Math.round(effectiveZoom * 100)}%</span>
        </div>
        <div className="pptx-viewer-search">
          <IconSearch size={13} />
          <input
            className="pptx-viewer-search-input"
            value={searchQuery}
            placeholder="搜索…"
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label="PPTX 搜索"
          />
          {searchState.total > 0 && (
            <span className="pptx-viewer-search-count" data-testid="pptx-search-count">
              {searchState.current + 1}/{searchState.total}
            </span>
          )}
          <button type="button" className="pptx-viewer-btn" data-action="search-prev" onClick={() => goToMatch(-1)} title="上一个命中">
            <IconChevronLeft size={13} />
          </button>
          <button type="button" className="pptx-viewer-btn" data-action="search-next" onClick={() => goToMatch(1)} title="下一个命中">
            <IconChevronRight size={13} />
          </button>
          {searchQuery && (
            <button type="button" className="pptx-viewer-btn" data-action="search-clear" onClick={() => setSearchQuery("")} title="清除搜索">
              <IconX size={13} />
            </button>
          )}
        </div>
      </div>
      <div className="pptx-viewer-body">
        <div ref={railRef} className="pptx-thumb-rail" data-testid="pptx-thumb-rail">
          <div style={{ height: slideCount * thumbH, position: "relative" }}>
            {Array.from({ length: thumbWindow.end - thumbWindow.start + 1 }, (_, k) => {
              const i = thumbWindow.start + k;
              if (i < 0) return null;
              return (
                <div
                  key={i}
                  className={`pptx-thumb${i === current ? " active" : ""}`}
                  data-thumb={i}
                  style={{ position: "absolute", top: i * thumbH, width: "100%", height: Math.ceil(slideH * THUMB_SCALE) + 4 }} // 缩放后内容高 + 上下 2px border，避免 transform 布局盒保持 slideH 高度互相覆盖
                  onClick={() => goTo(i)}
                >
                  <div style={{ transform: `scale(${THUMB_SCALE})`, transformOrigin: "top left", width: slideW, height: slideH }} ref={(el) => {
                    if (el) thumbRefs.current.set(i, el);
                    else thumbRefs.current.delete(i);
                  }}>
                    {renderSlide(model.slides[i]!, media)}
                  </div>
                  <span className="pptx-thumb-num">{i + 1}</span>
                </div>
              );
            })}
          </div>
        </div>
        <div ref={stageRef} className="pptx-stage" data-testid="pptx-stage">
          {mainSlides}
        </div>
      </div>
    </div>
  );
}

/** 文本中匹配区间（复用 searchHighlight 的 mark 机制） */
function findRanges(text: string, query: string): Array<{ start: number; end: number }> {
  if (!query) return [];
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  const ranges: Array<{ start: number; end: number }> = [];
  let from = 0;
  for (;;) {
    const idx = hay.indexOf(needle, from);
    if (idx < 0) break;
    ranges.push({ start: idx, end: idx + needle.length });
    from = idx + needle.length;
    if (ranges.length >= 50) break;
  }
  return ranges;
}
