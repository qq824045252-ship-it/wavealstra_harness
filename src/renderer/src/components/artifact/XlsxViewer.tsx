import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "@/store/appStore";
import {
  COL_HEADER_H,
  DEFAULT_COL_WIDTH,
  DEFAULT_ROW_HEIGHT,
  ROW_HEADER_W,
  colLetter,
  cumulativeOffsets,
  mergeCovering,
  mergesIntersectingWindow,
  parseWorkbookModel,
  searchCells,
  splitMergeByFrozen,
  windowRange,
  xlsxViewerStats,
  type CellMatch,
  type XlsxCell,
  type XlsxMerge,
  type XlsxSheetModel,
  type XlsxStyle,
  type XlsxWorkbookModel,
} from "@/lib/xlsxView";
import { decodeBase64DataUri } from "@/lib/binaryArtifact";
import { shouldSkipOfficePreview } from "@shared/office-preview";
import { IconSearch, IconChevronUp, IconChevronDown, IconX } from "@/components/common/icons";

interface Props {
  content: string;
  name?: string;
}

const OVERSANCAN = 3;
const MERGE_OVERSANCAN = 8;

function styleCss(style: XlsxStyle | undefined): React.CSSProperties {
  if (!style) return {};
  const css: React.CSSProperties = {};
  if (style.bold) css.fontWeight = 600;
  if (style.italic) css.fontStyle = "italic";
  if (style.color) css.color = style.color;
  if (style.fontSize) css.fontSize = style.fontSize;
  if (style.fillColor) css.background = style.fillColor;
  if (style.align?.h) css.textAlign = style.align.h as React.CSSProperties["textAlign"];
  if (style.align?.v) css.verticalAlign = style.align.v as React.CSSProperties["verticalAlign"];
  if (style.align?.wrap) css.whiteSpace = "pre-wrap";
  if (style.border) {
    css.borderTop = `${style.border.top ?? "none"} 1px solid #999`;
    css.borderBottom = `${style.border.bottom ?? "none"} 1px solid #999`;
    css.borderLeft = `${style.border.left ?? "none"} 1px solid #999`;
    css.borderRight = `${style.border.right ?? "none"} 1px solid #999`;
  }
  return css;
}

/** data URI → bytes（严格校验见 lib/binaryArtifact） */
function decodeDataUriBytes(dataUri: string): Uint8Array {
  return decodeBase64DataUri(dataUri).bytes;
}

/**
 * Wave 5D-2 — XLSX Artifact 视图（§88 / 1H spike：SheetJS 解析 + 自绘表格）
 *
 * 分层网格（sticky 冻结窗格）：body / frozen-row / frozen-col / corner / 行号 / 列号。
 * 二维窗口化（行 × 列 overscan），DOM 有界；merge 按冻结边界分片渲染（anchor 在
 * 视口外也渲染可见部分）；公式显示已保存结果；搜索定位 + 高亮；选择 + Ctrl+C。
 */
export default function XlsxViewer({ content, name }: Props): React.JSX.Element {
  const theme = useAppStore((s) => s.theme);
  const skipPreview = shouldSkipOfficePreview(content);
  const scrollRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [workbook, setWorkbook] = useState<XlsxWorkbookModel | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [error, setError] = useState("");
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  const [rowWindow, setRowWindow] = useState({ start: 0, end: -1 });
  const [colWindow, setColWindow] = useState({ start: 0, end: -1 });
  const [selection, setSelection] = useState<{ r: number; c: number } | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchState, setSearchState] = useState<{ matches: CellMatch[]; total: number; current: number }>({
    matches: [],
    total: 0,
    current: 0,
  });

  const workbookRef = useRef<XlsxWorkbookModel | null>(null);

  useEffect(() => {
    workbookRef.current = workbook;
  }, [workbook]);

  // 打开解析（含 sheet XML 的冻结窗格解析）
  useEffect(() => {
    let cancelled = false;
    setError("");
    setWorkbook(null);
    setSheetIndex(0);
    setSelection(null);
    setSearchQuery("");
    setSearchState({ matches: [], total: 0, current: 0 });
    if (skipPreview) return () => { cancelled = true; };
    void (async () => {
      try {
        const bytes = decodeDataUriBytes(content);
        const blob = new Blob([bytes as BlobPart], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });
        const zip = await import("jszip");
        const archive = await zip.default.loadAsync(blob);
        const sheetPaths = Object.keys(archive.files)
          .filter((p) => /xl\/worksheets\/sheet\d+\.xml$/.test(p))
          .sort();
        const sheetXmls = await Promise.all(sheetPaths.map((p) => archive.files[p].async("string")));
        const stylesEntry = archive.file("xl/styles.xml");
        const stylesXml = stylesEntry ? await stylesEntry.async("string") : null;
        if (cancelled) return;
        const model = parseWorkbookModel(bytes, stylesXml, sheetXmls);
        xlsxViewerStats.docs += 1;
        setWorkbook(model);
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      }
    })();
    return () => {
      cancelled = true;
      xlsxViewerStats.docs -= 1;
    };
  }, [content, skipPreview]);

  const sheet: XlsxSheetModel | null = workbook?.sheets[sheetIndex] ?? null;
  const styles = workbook?.styles ?? [];

  // 偏移表
  const rowOffsets = useMemo(
    () => (sheet ? cumulativeOffsets(sheet.rowHeights, sheet.rows, DEFAULT_ROW_HEIGHT) : []),
    [sheet],
  );
  const colOffsets = useMemo(
    () => (sheet ? cumulativeOffsets(sheet.colWidths, sheet.cols, DEFAULT_COL_WIDTH) : []),
    [sheet],
  );
  const frozenRows = sheet?.frozen?.rows ?? 0;
  const frozenCols = sheet?.frozen?.cols ?? 0;
  const bodyTop = frozenRows > 0 ? rowOffsets[frozenRows] ?? 0 : 0;
  const bodyLeft = frozenCols > 0 ? colOffsets[frozenCols] ?? 0 : 0;
  const bodyW = colOffsets.length > 0 ? (colOffsets[colOffsets.length - 1] ?? 0) + (sheet?.colWidths[sheet.cols - 1] ?? DEFAULT_COL_WIDTH) - bodyLeft : 0;
  const bodyH = rowOffsets.length > 0 ? (rowOffsets[rowOffsets.length - 1] ?? 0) + (sheet?.rowHeights[sheet.rows - 1] ?? DEFAULT_ROW_HEIGHT) - bodyTop : 0;

  // 容器尺寸
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    xlsxViewerStats.observers += 1;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setContainerSize({ w: rect.width, h: rect.height });
    });
    observer.observe(container);
    const rect = container.getBoundingClientRect();
    setContainerSize({ w: rect.width, h: rect.height });
    return () => {
      observer.disconnect();
      xlsxViewerStats.observers -= 1;
    };
  }, []);

  // 滚动 → 行列窗口（body 从冻结边界开始）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !sheet) return;
    xlsxViewerStats.listeners += 1;
    let raf = 0;
    const update = (): void => {
      const rw = windowRange(sheet.rows, el.scrollTop, el.clientHeight, rowOffsets, OVERSANCAN);
      const cw = windowRange(sheet.cols, el.scrollLeft, el.clientWidth, colOffsets, OVERSANCAN);
      setRowWindow({ start: Math.max(frozenRows, rw.start), end: rw.end });
      setColWindow({ start: Math.max(frozenCols, cw.start), end: cw.end });
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
      xlsxViewerStats.listeners -= 1;
    };
  }, [sheet, rowOffsets, colOffsets, frozenRows, frozenCols]);

  // 切换 sheet → 重置
  const selectSheet = useCallback((index: number): void => {
    setSheetIndex(index);
    setSelection(null);
    setSearchState({ matches: [], total: 0, current: 0 });
    setSearchQuery("");
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = 0;
      el.scrollLeft = 0;
    }
  }, []);

  // 合并窗口（各层）
  const mergeWindow = useMemo(() => {
    if (!sheet) return null;
    return {
      body: mergesIntersectingWindow(sheet.merges, Math.max(frozenRows, rowWindow.start), rowWindow.end, Math.max(frozenCols, colWindow.start), colWindow.end),
      frozenRow: frozenRows > 0 ? mergesIntersectingWindow(sheet.merges, 0, frozenRows - 1, Math.max(frozenCols, colWindow.start), colWindow.end) : [],
      frozenCol: frozenCols > 0 ? mergesIntersectingWindow(sheet.merges, Math.max(frozenRows, rowWindow.start), rowWindow.end, 0, frozenCols - 1) : [],
      corner: frozenRows > 0 && frozenCols > 0 ? mergesIntersectingWindow(sheet.merges, 0, frozenRows - 1, 0, frozenCols - 1) : [],
    };
  }, [sheet, rowWindow, colWindow, frozenRows, frozenCols]);

  // 渲染一个单元格（或 merge 覆盖判定）
  const renderCell = useCallback(
    (r: number, c: number, layer: "body" | "frozen-row" | "frozen-col" | "corner"): React.JSX.Element | null => {
      if (!sheet) return null;
      const merge = mergeCovering(sheet.merges, r, c);
      if (merge && !(merge.s.r === r && merge.s.c === c)) return null; // 非 anchor 覆盖区不渲染单格
      const cell: XlsxCell | undefined = sheet.cells.get(`${r}:${c}`);
      const text = cell ? String(cell.w ?? cell.v ?? "") : "";
      const style = cell?.s !== undefined ? styleCss(styles[cell.s]) : {};
      const selected = selection && selection.r === r && selection.c === c;
      const searchHit = searchState.matches.find((m) => m.sheetIndex === sheetIndex && m.r === r && m.c === c);
      const isAnchor = merge && merge.s.r === r && merge.s.c === c;
      const layerOffset = layer === "body" ? { top: bodyTop, left: bodyLeft } : layer === "frozen-row" ? { top: 0, left: bodyLeft } : layer === "frozen-col" ? { top: bodyTop, left: 0 } : { top: 0, left: 0 };
      return (
        <div
          key={`${r}:${c}`}
          className={`xlsx-cell${selected ? " xlsx-cell--selected" : ""}${isAnchor ? " xlsx-cell--merge-anchor" : ""}${searchHit ? " xlsx-cell--search" : ""}`}
          data-r={r}
          data-c={c}
          data-testid="xlsx-cell"
          style={{
            position: "absolute",
            top: (rowOffsets[r] ?? 0) - layerOffset.top,
            left: (colOffsets[c] ?? 0) - layerOffset.left,
            width: sheet.colWidths[c] ?? DEFAULT_COL_WIDTH,
            height: sheet.rowHeights[r] ?? DEFAULT_ROW_HEIGHT,
            ...style,
          }}
          onClick={() => setSelection({ r, c })}
        >
          {text}
        </div>
      );
    },
    [sheet, styles, selection, searchState, sheetIndex, bodyTop, bodyLeft, rowOffsets, colOffsets],
  );

  // 渲染 merge 覆盖块（按层分片）
  const renderMergePiece = useCallback(
    (merge: XlsxMerge, region: "body" | "frozen-row" | "frozen-col" | "corner"): React.JSX.Element | null => {
      if (!sheet) return null;
      const pieces = splitMergeByFrozen(merge, frozenRows, frozenCols);
      const piece = pieces.find((p) => p.region === region);
      if (!piece) return null;
      const layerOffset = region === "body" ? { top: bodyTop, left: bodyLeft } : region === "frozen-row" ? { top: 0, left: bodyLeft } : region === "frozen-col" ? { top: bodyTop, left: 0 } : { top: 0, left: 0 };
      const anchor = sheet.cells.get(`${merge.s.r}:${merge.s.c}`);
      const style = anchor?.s !== undefined ? styleCss(styles[anchor.s]) : {};
      const selected = selection && selection.r >= merge.s.r && selection.r <= merge.e.r && selection.c >= merge.s.c && selection.c <= merge.e.c;
      return (
        <div
          key={`m${merge.s.r}:${merge.s.c}-${region}`}
          className={`xlsx-merge${selected ? " xlsx-merge--selected" : ""}`}
          data-merge={`${merge.s.r}:${merge.s.c}-${merge.e.r}:${merge.e.c}`}
          data-testid="xlsx-merge"
          style={{
            position: "absolute",
            top: (rowOffsets[piece.r0] ?? 0) - layerOffset.top,
            left: (colOffsets[piece.c0] ?? 0) - layerOffset.left,
            width: (colOffsets[piece.c1 + 1] ?? (colOffsets[piece.c0] ?? 0) + DEFAULT_COL_WIDTH) - (colOffsets[piece.c0] ?? 0),
            height: (rowOffsets[piece.r1 + 1] ?? (rowOffsets[piece.r0] ?? 0) + DEFAULT_ROW_HEIGHT) - (rowOffsets[piece.r0] ?? 0),
            ...style,
          }}
          onClick={() => setSelection({ r: merge.s.r, c: merge.s.c })}
        >
          {String(anchor?.w ?? anchor?.v ?? "")}
        </div>
      );
    },
    [sheet, styles, selection, frozenRows, frozenCols, bodyTop, bodyLeft, rowOffsets, colOffsets],
  );

  // 搜索
  useEffect(() => {
    if (!workbook) return;
    if (!searchQuery.trim()) {
      setSearchState({ matches: [], total: 0, current: 0 });
      return;
    }
    const { matches, total } = searchCells(workbook.sheets, searchQuery);
    setSearchState({ matches, total, current: 0 });
    if (matches.length > 0) {
      void jumpToMatch(matches[0]!);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, workbook]);

  const jumpToMatch = useCallback(
    (match: CellMatch): void => {
      const el = scrollRef.current;
      if (!el || !sheet) return;
      const targetSheet = workbookRef.current?.sheets[match.sheetIndex];
      if (!targetSheet) return;
      const ro = cumulativeOffsets(targetSheet.rowHeights, targetSheet.rows, DEFAULT_ROW_HEIGHT);
      const co = cumulativeOffsets(targetSheet.colWidths, targetSheet.cols, DEFAULT_COL_WIDTH);
      const targetCol = Math.min(match.c, targetSheet.cols - 1);
      el.scrollTop = Math.max(0, (ro[match.r] ?? 0) - 40);
      el.scrollLeft = Math.max(0, (co[targetCol] ?? 0) - 40);
      if (match.sheetIndex !== sheetIndex) setSheetIndex(match.sheetIndex);
    },
    [sheet, sheetIndex],
  );

  const goToMatch = useCallback(
    (delta: 1 | -1): void => {
      const { matches, total, current } = searchState;
      if (total === 0) return;
      const next = (current + delta + total) % total;
      setSearchState((prev) => ({ ...prev, current: next }));
      jumpToMatch(matches[next]!);
    },
    [searchState, jumpToMatch],
  );

  // Ctrl+C 复制选中单元格
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.key === "c" && selection && sheet) {
        const cell = sheet.cells.get(`${selection.r}:${selection.c}`);
        if (cell) void navigator.clipboard.writeText(String(cell.w ?? cell.v ?? ""));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection, sheet]);

  // 卸载清理
  useEffect(() => {
    return () => {
      xlsxViewerStats.listeners = 0;
      xlsxViewerStats.observers = 0;
    };
  }, []);

  if (skipPreview) {
    return (
      <div
        className={`xlsx-viewer ${theme === "dark" ? "xlsx-viewer--dark" : ""}`}
        data-testid="office-preview-skipped"
      />
    );
  }

  if (!sheet) {
    return (
      <div className={`xlsx-viewer ${theme === "dark" ? "xlsx-viewer--dark" : ""}`}>
        <div className="xlsx-viewer-toolbar">
          <span className="xlsx-viewer-title">{name ?? "XLSX"}</span>
          {error && <span className="xlsx-viewer-status">加载失败：{error}</span>}
          {!error && <span className="xlsx-viewer-status">正在解析…</span>}
        </div>
      </div>
    );
  }

  const rw = rowWindow;
  const cw = colWindow;
  const totalW = ROW_HEADER_W + bodyLeft + bodyW;
  const totalH = COL_HEADER_H + bodyTop + bodyH;
  const cellsLive = xlsxViewerStats.cellsLive;

  return (
    <div className={`xlsx-viewer ${theme === "dark" ? "xlsx-viewer--dark" : ""}`}>
      <div className="xlsx-viewer-toolbar">
        <span className="xlsx-viewer-title" title={name}>
          {name ?? "XLSX"}
        </span>
        <span className="xlsx-viewer-meta">
          {sheet.rows.toLocaleString()} 行 × {sheet.cols.toLocaleString()} 列
        </span>
        <div className="xlsx-viewer-sheets">
          {workbook?.sheets.map((s, i) => (
            <button
              key={s.name}
              type="button"
              className={`xlsx-sheet-tab${i === sheetIndex ? " active" : ""}`}
              data-sheet={i}
              onClick={() => selectSheet(i)}
            >
              {s.name}
            </button>
          ))}
        </div>
        <div className="xlsx-viewer-search">
          <IconSearch size={13} />
          <input
            className="xlsx-viewer-search-input"
            value={searchQuery}
            placeholder="搜索…"
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label="XLSX 搜索"
          />
          {searchState.total > 0 && (
            <span className="xlsx-viewer-search-count" data-testid="xlsx-search-count">
              {searchState.current + 1}/{searchState.total}
            </span>
          )}
          <button type="button" className="xlsx-viewer-btn" data-action="search-prev" onClick={() => goToMatch(-1)} title="上一个命中">
            <IconChevronUp size={13} />
          </button>
          <button type="button" className="xlsx-viewer-btn" data-action="search-next" onClick={() => goToMatch(1)} title="下一个命中">
            <IconChevronDown size={13} />
          </button>
          {searchQuery && (
            <button type="button" className="xlsx-viewer-btn" data-action="search-clear" onClick={() => setSearchQuery("")} title="清除搜索">
              <IconX size={13} />
            </button>
          )}
        </div>
        <span className="xlsx-viewer-live" data-testid="xlsx-live">
          {cellsLive} cells
        </span>
      </div>
      <div ref={containerRef} className="xlsx-viewer-stage">
        <div ref={scrollRef} className="xlsx-viewer-scroll" data-testid="xlsx-scroll">
          <div className="xlsx-canvas" style={{ width: totalW, height: totalH }}>
            {/* 列号头（sticky top） */}
            <div className="xlsx-col-header" style={{ width: totalW }}>
              {Array.from({ length: cw.end - cw.start + 1 }, (_, k) => {
                const c = cw.start + k;
                if (c < 0) return null;
                return (
                  <div
                    key={c}
                    className="xlsx-col-header-cell"
                    data-col={c}
                    style={{ left: ROW_HEADER_W + (colOffsets[c] ?? 0), width: sheet.colWidths[c] ?? DEFAULT_COL_WIDTH }}
                  >
                    {colLetter(c)}
                  </div>
                );
              })}
            </div>
            {/* 行号头（sticky left） */}
            <div className="xlsx-row-header" style={{ height: totalH }}>
              {Array.from({ length: rw.end - rw.start + 1 }, (_, k) => {
                const r = rw.start + k;
                if (r < 0) return null;
                return (
                  <div
                    key={r}
                    className="xlsx-row-header-cell"
                    data-row={r}
                    style={{ top: COL_HEADER_H + (rowOffsets[r] ?? 0), height: sheet.rowHeights[r] ?? DEFAULT_ROW_HEIGHT }}
                  >
                    {r + 1}
                  </div>
                );
              })}
            </div>
            {/* 角 */}
            <div className="xlsx-corner" style={{ width: ROW_HEADER_W, height: COL_HEADER_H }} />
            {/* body 单元格 */}
            <div className="xlsx-body" style={{ left: ROW_HEADER_W, top: COL_HEADER_H, width: bodyLeft + bodyW, height: bodyTop + bodyH }}>
              <div className="xlsx-body-inner" style={{ position: "relative", width: bodyW, height: bodyH, marginLeft: bodyLeft, marginTop: bodyTop }}>
                {Array.from({ length: rw.end - rw.start + 1 }, (_, rk) =>
                  Array.from({ length: cw.end - cw.start + 1 }, (_, ck) => {
                    const r = rw.start + rk;
                    const c = cw.start + ck;
                    if (r < 0 || c < 0) return null;
                    return renderCell(r, c, "body");
                  }),
                )}
                {mergeWindow?.body.map((m) => renderMergePiece(m, "body"))}
              </div>
            </div>
            {/* frozen-row 层（sticky top） */}
            {frozenRows > 0 && (
              <div className="xlsx-frozen-row" style={{ width: totalW - ROW_HEADER_W, height: bodyTop }}>
                <div style={{ position: "relative", width: bodyW, height: bodyTop, marginLeft: bodyLeft }}>
                  {Array.from({ length: frozenRows }, (_, r) =>
                    Array.from({ length: cw.end - cw.start + 1 }, (_, ck) => {
                      const c = cw.start + ck;
                      if (c < 0) return null;
                      return renderCell(r, c, "frozen-row");
                    }),
                  )}
                  {mergeWindow?.frozenRow.map((m) => renderMergePiece(m, "frozen-row"))}
                </div>
              </div>
            )}
            {/* frozen-col 层（sticky left） */}
            {frozenCols > 0 && (
              <div className="xlsx-frozen-col" style={{ width: bodyLeft, height: totalH - COL_HEADER_H }}>
                <div style={{ position: "relative", width: bodyLeft, height: bodyH, marginTop: bodyTop }}>
                  {Array.from({ length: frozenCols }, (_, c) =>
                    Array.from({ length: rw.end - rw.start + 1 }, (_, rk) => {
                      const r = rw.start + rk;
                      if (r < 0) return null;
                      return renderCell(r, c, "frozen-col");
                    }),
                  )}
                  {mergeWindow?.frozenCol.map((m) => renderMergePiece(m, "frozen-col"))}
                </div>
              </div>
            )}
            {/* corner 层 */}
            {frozenRows > 0 && frozenCols > 0 && (
              <div className="xlsx-frozen-corner" style={{ width: bodyLeft, height: bodyTop }}>
                {Array.from({ length: frozenRows }, (_, r) =>
                  Array.from({ length: frozenCols }, (_, c) => renderCell(r, c, "corner")),
                )}
                {mergeWindow?.corner.map((m) => renderMergePiece(m, "corner"))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
