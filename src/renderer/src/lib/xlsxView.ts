/**
 * Wave 5D-2 — XLSX 视图纯逻辑（§88 / 1H spike：SheetJS 解析 + 自绘表格）
 *
 * 边界（冻结）：SheetJS 只负责解析；公式显示「已保存的计算结果」（cell.v/w），
 * V3.5 不重算公式；样式由自研 styles.xml 解析器提供（SheetJS 社区版无样式）。
 *
 * 纯逻辑无 DOM 依赖（SheetJS 可在 node 运行），可 node 直测。
 */

// ---------- 模型 ----------

export interface XlsxCell {
  r: number;
  c: number;
  /** 原始值（公式场景 = 已保存的计算结果） */
  v: unknown;
  /** 类型：n/s/b/d/e/z */
  t?: string;
  /** 格式化文本（SheetJS w，含数字/日期/百分比/货币格式） */
  w?: string;
  /** 数字格式代码 */
  z?: string;
  /** 公式字符串（仅展示，不重算） */
  f?: string;
  /** 样式索引（cellXfs） */
  s?: number;
}

export interface XlsxMerge {
  s: { r: number; c: number };
  e: { r: number; c: number };
}

export interface XlsxStyle {
  /** 字体 */
  bold?: boolean;
  italic?: boolean;
  color?: string;
  fontSize?: number;
  /** 填充 */
  fillColor?: string;
  /** 边框（thin/medium/thick 等） */
  border?: { left?: string; right?: string; top?: string; bottom?: string };
  /** 对齐 */
  align?: { h?: string; v?: string; wrap?: boolean };
  /** 数字格式（numFmtId → 格式串，已由 cell.w 呈现，此处留作元数据） */
  numFmtId?: number;
}

export interface XlsxSheetModel {
  name: string;
  rows: number;
  cols: number;
  cells: Map<string, XlsxCell>;
  merges: XlsxMerge[];
  /** 列宽（px） */
  colWidths: number[];
  /** 行高（px） */
  rowHeights: number[];
  /** 冻结窗格 */
  frozen: { rows: number; cols: number } | null;
}

export interface XlsxWorkbookModel {
  sheets: XlsxSheetModel[];
  activeSheet: number;
  styles: XlsxStyle[];
}

export const DEFAULT_COL_WIDTH = 64;
export const DEFAULT_ROW_HEIGHT = 20;
export const COL_HEADER_H = 24;
export const ROW_HEADER_W = 44;

// ---------- SheetJS 解析（纯函数） ----------

import * as XLSX from "xlsx";

export function parseWorkbookModel(
  bytes: Uint8Array,
  stylesXml: string | null,
  sheetXmls?: Array<string | null>,
): XlsxWorkbookModel {
  const wb = XLSX.read(bytes, { type: "array", cellNF: true, cellFormula: true, cellStyles: true });
  const styles = stylesXml ? parseStylesXml(stylesXml) : [];
  const sheets: XlsxSheetModel[] = [];
  for (let si = 0; si < wb.SheetNames.length; si += 1) {
    const name = wb.SheetNames[si];
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const frozen =
      ws["!freeze"]
        ? { rows: ws["!freeze"].ySplit ?? 0, cols: ws["!freeze"].xSplit ?? 0 }
        : sheetXmls?.[si]
          ? parseFreezePane(sheetXmls[si]!)
          : null;
    const ref = ws["!ref"];
    const cells: Map<string, XlsxCell> = new Map();
    let rows = 0;
    let cols = 0;
    const range = ref ? XLSX.utils.decode_range(ref) : null;
    if (range) {
      rows = range.e.r + 1;
      cols = range.e.c + 1;
    }
    for (const key of Object.keys(ws)) {
      if (key.startsWith("!")) continue;
      const addr = XLSX.utils.decode_cell(key);
      const raw = ws[key] as XLSX.CellObject;
      const cell: XlsxCell = {
        r: addr.r,
        c: addr.c,
        v: raw.v,
        t: raw.t as XlsxCell["t"],
        w: typeof raw.w === "string" ? raw.w : formatRaw(raw as unknown as { v: unknown; t: string }),
        z: raw.z as string | undefined,
        f: raw.f,
        s: typeof raw.s === "number" ? raw.s : undefined,
      };
      // SheetJS cellStyles:true 的 s 是解析对象而非 xf 索引 → 从 sheet XML 取数字索引
      const xmlS = sheetXmls?.[si] ? cellStyleIndex(sheetXmls[si]!, key) : undefined;
      if (xmlS !== undefined) cell.s = xmlS;
      cells.set(`${addr.r}:${addr.c}`, cell);
      rows = Math.max(rows, addr.r + 1);
      cols = Math.max(cols, addr.c + 1);
    }
    const colWidths: number[] = [];
    const wsCols = ws["!cols"];
    if (Array.isArray(wsCols)) {
      for (const col of wsCols) {
        colWidths.push(col && col.wch ? col.wch * 7 + 6 : DEFAULT_COL_WIDTH);
      }
    }
    const rowHeights: number[] = [];
    const wsRows = ws["!rows"];
    if (Array.isArray(wsRows)) {
      for (const row of wsRows) {
        if (row && typeof row.hpx === "number") rowHeights.push(row.hpx);
        else if (row && typeof row.hpt === "number") rowHeights.push(row.hpt * 1.3333);
        else rowHeights.push(DEFAULT_ROW_HEIGHT);
      }
    }
    sheets.push({
      name,
      rows,
      cols,
      cells,
      merges: (ws["!merges"] as XlsxMerge[] | undefined) ?? [],
      colWidths,
      rowHeights,
      frozen,
    });
  }
  return { sheets, activeSheet: Math.max(0, wb.Workbook?.Sheets?.findIndex((s) => (s as { Hidden?: unknown }).Hidden !== true) ?? 0), styles };
}

/** 从 sheet XML 提取单元格 xf 索引（s 属性） */
const cellStyleIndexCache = new Map<string, Map<string, number>>();

export function cellStyleIndex(sheetXml: string, address: string): number | undefined {
  let map = cellStyleIndexCache.get(sheetXml);
  if (!map) {
    map = new Map();
    const re = /<c r="([A-Z]+\d+)"[^>]*?s="(\d+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sheetXml)) !== null) {
      map.set(m[1]!, parseInt(m[2]!, 10));
    }
    cellStyleIndexCache.set(sheetXml, map);
  }
  return map.get(address);
}
export function parseFreezePane(sheetXml: string): { rows: number; cols: number } | null {
  const pane = /<pane\b[^>]*\bstate="frozen"[^>]*>/.exec(sheetXml)?.[0];
  if (!pane) return null;
  const xSplit = parseInt(/xSplit="(\d+)"/.exec(pane)?.[1] ?? "0", 10) || 0;
  const ySplit = parseInt(/ySplit="(\d+)"/.exec(pane)?.[1] ?? "0", 10) || 0;
  return { rows: ySplit, cols: xSplit };
}

function formatRaw(raw: { v: unknown; t?: string }): string {
  if (raw.v === null || raw.v === undefined) return "";
  if (raw.t === "s" || raw.t === "str") return String(raw.v);
  if (typeof raw.v === "number") return String(raw.v);
  if (raw.t === "b") return raw.v ? "TRUE" : "FALSE";
  return String(raw.v);
}

// ---------- styles.xml 解析（regex，node 可测） ----------

export function parseStylesXml(xml: string): XlsxStyle[] {
  // numFmts
  const numFmtIds = new Map<number, string>();
  const numFmtRe = /<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = numFmtRe.exec(xml)) !== null) {
    numFmtIds.set(parseInt(m[1], 10), m[2].replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
  }

  // fonts
  const fonts: Array<{ bold?: boolean; italic?: boolean; color?: string; size?: number }> = [];
  const fontRe = /<font>([\s\S]*?)<\/font>/g;
  while ((m = fontRe.exec(xml)) !== null) {
    const body = m[1];
    fonts.push({
      bold: /<b\/>/.test(body),
      italic: /<i\/>/.test(body),
      color: /<color\b[^>]*rgb="([0-9A-Fa-f]{6,8})"/.exec(body)?.[1],
      size: /<sz\b[^>]*val="([\d.]+)"/.exec(body) ? parseFloat(/<sz\b[^>]*val="([\d.]+)"/.exec(body)![1]) : undefined,
    });
  }

  // fills
  const fills: Array<{ color?: string }> = [];
  const fillRe = /<fill>([\s\S]*?)<\/fill>/g;
  while ((m = fillRe.exec(xml)) !== null) {
    const body = m[1];
    const solid = /<patternFill[^>]*patternType="solid"/.test(body);
    fills.push({
      color: solid ? /<fgColor\b[^>]*rgb="([0-9A-Fa-f]{6,8})"/.exec(body)?.[1] : undefined,
    });
  }

  // borders
  const borders: Array<{ sides: Record<string, string> }> = [];
  const borderRe = /<border\b[^>]*>([\s\S]*?)<\/border>/g;
  while ((m = borderRe.exec(xml)) !== null) {
    const body = m[1];
    const sides: Record<string, string> = {};
    for (const side of ["left", "right", "top", "bottom"]) {
      const sm = new RegExp(`<${side}\\b[^>]*style="([^"]*)"`).exec(body);
      if (sm) sides[side] = sm[1];
    }
    borders.push({ sides });
  }

  // cellXfs：先提取 cellXfs 段（cellStyleXfs 不被单元格引用，排除），再收集 alignment 配对
  const cellXfsSection = /<cellXfs\s[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? xml;
  const alignments: Array<{ h?: string; v?: string; wrap?: boolean }> = [];
  const alignRe = /<alignment\b([^>]*)\/>/g;
  while ((m = alignRe.exec(cellXfsSection)) !== null) {
    const body = m[1];
    alignments.push({
      h: /horizontal="([^"]*)"/.exec(body)?.[1],
      v: /vertical="([^"]*)"/.exec(body)?.[1],
      wrap: /wrapText="([01])"/.exec(body)?.[1] === "1",
    });
  }

  const xfs: Array<{ fontId: number; fillId: number; borderId: number; align?: { h?: string; v?: string; wrap?: boolean }; numFmtId?: number }> = [];
  const xfRe = /<xf\b([^>]*?)(?:\/>|>)/g;
  let alignIdx = 0;
  while ((m = xfRe.exec(cellXfsSection)) !== null) {
    const attrs = m[1] ?? "";
    const isOpen = !/\/>\s*$/.test(m[0]);
    xfs.push({
      fontId: parseInt(/fontId="(\d+)"/.exec(attrs)?.[1] ?? "0", 10) || 0,
      fillId: parseInt(/fillId="(\d+)"/.exec(attrs)?.[1] ?? "0", 10) || 0,
      borderId: parseInt(/borderId="(\d+)"/.exec(attrs)?.[1] ?? "0", 10) || 0,
      numFmtId: parseInt(/numFmtId="(\d+)"/.exec(attrs)?.[1] ?? "0", 10) || 0,
      align: isOpen ? alignments[alignIdx++] : undefined,
    });
  }

  return xfs.map((xf) => {
    const font = fonts[xf.fontId];
    const fill = fills[xf.fillId];
    const border = borders[xf.borderId];
    return {
      bold: font?.bold,
      italic: font?.italic,
      color: font?.color ? `#${font.color.slice(-6).toLowerCase()}` : undefined,
      fontSize: font?.size,
      fillColor: fill?.color ? `#${fill.color.slice(-6).toLowerCase()}` : undefined,
      border:
        border && Object.keys(border.sides).length > 0
          ? { left: border.sides.left, right: border.sides.right, top: border.sides.top, bottom: border.sides.bottom }
          : undefined,
      align: xf.align,
      numFmtId: xf.numFmtId || undefined,
    };
  });
}

// ---------- merge / 窗口数学 ----------

/** (r,c) 是否被某 merge 覆盖（返回该 merge） */
export function mergeCovering(merges: XlsxMerge[], r: number, c: number): XlsxMerge | null {
  for (const merge of merges) {
    if (r >= merge.s.r && r <= merge.e.r && c >= merge.s.c && c <= merge.e.c) return merge;
  }
  return null;
}

/** 与窗口相交的 merges（anchor 可在窗口外） */
export function mergesIntersectingWindow(
  merges: XlsxMerge[],
  r0: number,
  r1: number,
  c0: number,
  c1: number,
): XlsxMerge[] {
  return merges.filter((m) => m.s.r <= r1 && m.e.r >= r0 && m.s.c <= c1 && m.e.c >= c0);
}

/** 按冻结边界把 merge 切成 ≤4 片（每片归属一个层区域） */
export interface MergePiece {
  merge: XlsxMerge;
  r0: number;
  r1: number;
  c0: number;
  c1: number;
  region: "body" | "frozen-row" | "frozen-col" | "corner";
}

export function splitMergeByFrozen(
  merge: XlsxMerge,
  frozenRows: number,
  frozenCols: number,
): MergePiece[] {
  const pieces: MergePiece[] = [];
  const rowSplit = Math.min(Math.max(frozenRows, 0), merge.e.r + 1);
  const colSplit = Math.min(Math.max(frozenCols, 0), merge.e.c + 1);
  const rowRegions: Array<[number, number, "frozen-row" | "body"]> = [];
  if (merge.s.r < rowSplit) rowRegions.push([merge.s.r, Math.min(rowSplit - 1, merge.e.r), "frozen-row"]);
  if (merge.e.r >= rowSplit) rowRegions.push([Math.max(rowSplit, merge.s.r), merge.e.r, "body"]);
  const colRegions: Array<[number, number, "frozen-col" | "body"]> = [];
  if (merge.s.c < colSplit) colRegions.push([merge.s.c, Math.min(colSplit - 1, merge.e.c), "frozen-col"]);
  if (merge.e.c >= colSplit) colRegions.push([Math.max(colSplit, merge.s.c), merge.e.c, "body"]);
  for (const [r0, r1, rKind] of rowRegions) {
    for (const [c0, c1, cKind] of colRegions) {
      const region = rKind === "frozen-row" && cKind === "frozen-col" ? "corner" : rKind === "frozen-row" ? "frozen-row" : cKind === "frozen-col" ? "frozen-col" : "body";
      pieces.push({ merge, r0, r1, c0, c1, region });
    }
  }
  return pieces;
}

/** 行/列窗口（含 overscan），返回 [start, end]（含） */
export function windowRange(
  count: number,
  scrollOffset: number,
  viewportSize: number,
  offsets: number[],
  overscan: number,
): { start: number; end: number } {
  if (count === 0) return { start: 0, end: -1 };
  let start = 0;
  while (start < count - 1 && offsets[start + 1] <= scrollOffset) start += 1;
  let end = start;
  const bottom = scrollOffset + viewportSize;
  while (end < count - 1 && offsets[end + 1] <= bottom) end += 1;
  return { start: Math.max(0, start - overscan), end: Math.min(count - 1, end + overscan) };
}

/** 累积偏移（含默认宽高补齐） */
export function cumulativeOffsets(sizes: number[], count: number, def: number): number[] {
  const offsets: number[] = [];
  let acc = 0;
  for (let i = 0; i < count; i += 1) {
    offsets.push(acc);
    acc += sizes[i] ?? def;
  }
  return offsets;
}

export function colLetter(index: number): string {
  let n = index;
  let out = "";
  while (n >= 0) {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  }
  return out;
}

// ---------- 搜索 ----------

export interface CellMatch {
  sheetIndex: number;
  r: number;
  c: number;
  text: string;
}

export function searchCells(
  sheets: XlsxSheetModel[],
  query: string,
  limit = 200,
): { matches: CellMatch[]; total: number } {
  if (!query) return { matches: [], total: 0 };
  const needle = query.toLowerCase();
  const matches: CellMatch[] = [];
  let total = 0;
  for (let si = 0; si < sheets.length; si += 1) {
    for (const cell of sheets[si].cells.values()) {
      const text = String(cell.w ?? cell.v ?? "");
      if (text.toLowerCase().includes(needle)) {
        total += 1;
        if (matches.length < limit) matches.push({ sheetIndex: si, r: cell.r, c: cell.c, text });
      }
    }
  }
  return { matches, total };
}

// ---------- 生命周期统计（E2E 泄漏断言用） ----------

export const xlsxViewerStats = {
  docs: 0,
  listeners: 0,
  observers: 0,
  /** 当前 DOM 中的网格单元数（含 merge 覆盖块） */
  cellsLive: 0,
  mergesLive: 0,
};

export function resetXlsxViewerStats(): void {
  xlsxViewerStats.docs = 0;
  xlsxViewerStats.listeners = 0;
  xlsxViewerStats.observers = 0;
  xlsxViewerStats.cellsLive = 0;
  xlsxViewerStats.mergesLive = 0;
}
