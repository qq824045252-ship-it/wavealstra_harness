import type { Element } from "@xmldom/xmldom";
import { PNG } from "pngjs";
import { Package, children, linkedRelation, office, one, rels, requirePart, root, targetOf } from "./OfficePackage";
import { readOfficeEvidenceFile } from "./OfficeEvidenceFile";

const spreadsheet = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const workbook = "xl/workbook.xml";
const MAX_PIXELS = 16_777_216;

function cellPosition(value: string) {
  const match = /^\$?([A-Z]{1,3})\$?([1-9][0-9]{0,6})$/iu.exec(value);
  requirePart(match, "请使用工作表内的 A1 区域，例如 A1:AN40。");
  const row = Number(match[2]);
  const column = Array.from(match[1].toUpperCase())
    .reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0);
  requirePart(row <= 1_048_576 && column <= 16_384, "A1 区域超出 Excel 工作表。");
  return { row, column };
}

function columnName(column: number): string {
  let name = "";
  for (; column; column = Math.floor((column - 1) / 26)) name = String.fromCharCode(65 + (column - 1) % 26) + name;
  return name;
}

export function parseExcelEvidenceRange(input: string) {
  const parts = input.trim().split(":");
  requirePart(parts.length <= 2, "请选择一个连续的 A1 区域。");
  const start = cellPosition(parts[0]);
  const end = cellPosition(parts.at(-1)!);
  const rows = end.row - start.row + 1;
  const columns = end.column - start.column + 1;
  requirePart(rows >= 1 && columns >= 1 && rows * columns <= 16_384, "核验区域最多支持 16384 个单元格。");
  return { start, end, rows, columns, address: `${columnName(start.column)}${start.row}:${columnName(end.column)}${end.row}` };
}

export interface ExcelPixelArtRequest {
  path: string;
  sheet?: string;
  range: string;
  previewPath?: string;
  palette?: string[];
  background?: string;
}

const rgb = (value: string) => {
  const hex = value.replace(/^#/, "");
  requirePart(/^[0-9a-f]{6}$/iu.test(hex), "颜色须为六位 RGB 十六进制，例如 #F7D84B。");
  return parseInt(hex, 16);
};
const hex = (color: number) => "#" + color.toString(16).padStart(6, "0").toUpperCase();
const index = (element: Element | undefined, name: string, fallback = 0) => {
  const value = element?.getAttribute(name);
  if (!value) return fallback;
  requirePart(/^\d+$/u.test(value) && Number.isSafeInteger(Number(value)), "工作簿样式引用无效。");
  return Number(value);
};
const disabled = (value: string | null) => value === "0" || value === "false";

function readStyles(styles: Element) {
  const elements = (parent: Element, name: string) => children(parent, spreadsheet, name);
  const xfs = elements(one(styles, spreadsheet, "cellXfs"), "xf");
  const bases = elements(styles, "cellStyleXfs").flatMap(element => elements(element, "xf"));
  const fills = elements(one(styles, spreadsheet, "fills"), "fill");
  const borders = elements(styles, "borders").flatMap(element => elements(element, "border"));
  const cache = new Map<number, { fill: number | null; border: boolean }>();
  return (id: number) => {
    const cached = cache.get(id);
    if (cached) return cached;
    const xf = xfs[id];
    requirePart(xf, "工作簿引用了不存在的单元格样式。");
    const base = bases[index(xf, "xfId")];
    const fillNode = fills[index(disabled(xf.getAttribute("applyFill")) ? base : xf, "fillId", index(base, "fillId"))];
    requirePart(fillNode && !elements(fillNode, "gradientFill").length, "仅支持无填充或纯 RGB 填充，工作簿包含渐变或无效填充。");
    const pattern = elements(fillNode, "patternFill")[0];
    const patternType = pattern?.getAttribute("patternType");
    let fill: number | null = null;
    if (patternType && patternType !== "none") {
      requirePart(patternType === "solid", "工作簿包含图案填充。");
      const foreground = elements(pattern!, "fgColor")[0];
      const color = foreground?.getAttribute("rgb") ?? "";
      const tint = foreground?.getAttribute("tint");
      requirePart(/^(?:[0-9a-f]{2})?[0-9a-f]{6}$/iu.test(color) && (!tint || Number(tint) === 0),
        "工作簿包含主题色、索引色或带色调的填充，无法按纯 RGB 核验。");
      fill = rgb(color.slice(-6));
    }
    const borderId = index(disabled(xf.getAttribute("applyBorder")) ? base : xf, "borderId", index(base, "borderId"));
    requirePart(borderId === 0 || borders[borderId], "工作簿引用了不存在的边框样式。");
    const border = Boolean(borders[borderId] && children(borders[borderId], spreadsheet).some(element => element.hasAttribute("style")));
    const result = { fill, border };
    cache.set(id, result);
    return result;
  };
}

async function readGrid(bytes: Buffer, selected: string | undefined, range: ReturnType<typeof parseExcelEvidenceRange>, signal?: AbortSignal) {
  const archive = await Package.open(bytes);
  try {
    const [book, links] = await Promise.all([archive.xml(workbook), archive.xml("xl/_rels/workbook.xml.rels")]);
    const sheets = children(one(root(book, spreadsheet, "workbook"), spreadsheet, "sheets"), spreadsheet, "sheet");
    const chosen = selected === undefined && sheets.length === 1 ? sheets[0]
      : sheets.find(element => element.getAttribute("name") === selected);
    requirePart(chosen, "请选择工作簿中的确切工作表名称。");
    const stylesheet = children(root(links, rels, "Relationships"), rels, "Relationship")
      .filter(element => element.getAttribute("Type") === office + "/styles");
    requirePart(stylesheet.length === 1, "工作簿缺少唯一的样式表。");
    const [sheetDoc, styleDoc] = await Promise.all([
      archive.xml(targetOf(linkedRelation(links, chosen.getAttributeNS(office, "id")), workbook, "worksheet", "xl/worksheets")),
      archive.xml(targetOf(stylesheet[0], workbook, "styles", "xl")),
    ]);
    const sheet = root(sheetDoc, spreadsheet, "worksheet");
    const getStyle = readStyles(root(styleDoc, spreadsheet, "styleSheet"));
    const data = one(sheet, spreadsheet, "sheetData");
    let priorRow = 0;
    const rows = new Map(children(data, spreadsheet, "row").map(element => {
      priorRow = index(element, "r", priorRow + 1);
      return [priorRow, element] as const;
    }));
    const cols = children(sheet, spreadsheet, "cols").flatMap(element => children(element, spreadsheet, "col")).reverse();
    const columns = Array.from({ length: range.columns }, (_, i) => cols.find(col =>
      range.start.column + i >= index(col, "min") && range.start.column + i <= index(col, "max")));
    const defaultView = children(sheet, spreadsheet, "sheetViews").flatMap(element => children(element, spreadsheet, "sheetView"));
    const gridlinesHidden = defaultView.length > 0 && defaultView.every(view => disabled(view.getAttribute("showGridLines")));
    const overlays = ["conditionalFormatting", "mergeCells", "drawing", "legacyDrawing", "legacyDrawingHF", "picture", "oleObjects", "tableParts"]
      .filter(name => children(sheet, spreadsheet, name).length > 0);
    if (["hidden", "veryHidden"].includes(chosen.getAttribute("state") ?? "")) overlays.push("hiddenSheet");
    if (columns.some(column => ["1", "true"].includes(column?.getAttribute("hidden") ?? ""))) overlays.push("hiddenColumns");
    const fills: (number | null)[] = [];
    let borderedCells = 0;
    let contentCells = 0;
    const sheetFormat = children(sheet, spreadsheet, "sheetFormatPr")[0];
    if (["1", "true"].includes(sheetFormat?.getAttribute("zeroHeight") ?? "")) overlays.push("hiddenRows");
    const storedRowHeights: (number | null)[] = [];
    for (let row = range.start.row; row <= range.end.row; row++) {
      signal?.throwIfAborted();
      const record = rows.get(row);
      let priorColumn = 0;
      const cells = new Map((record ? children(record, spreadsheet, "c") : []).map(cell => {
        const reference = cell.getAttribute("r");
        priorColumn = reference ? cellPosition(reference).column : priorColumn + 1;
        return [priorColumn, cell] as const;
      }));
      if (["1", "true"].includes(record?.getAttribute("hidden") ?? "")) overlays.push("hiddenRows");
      const height = record?.getAttribute("ht") || sheetFormat?.getAttribute("defaultRowHeight");
      storedRowHeights.push(height ? Number(height) : null);
      for (const [i, column] of columns.entries()) {
        const cell = cells.get(range.start.column + i);
        const implicit = ["1", "true"].includes(record?.getAttribute("customFormat") ?? "")
          ? index(record, "s") : index(column, "style");
        const style = getStyle(index(cell, "s", implicit));
        fills.push(style.fill);
        if (style.border) borderedCells++;
        if (cell && children(cell, spreadsheet).some(element => ["f", "v", "is"].includes(element.localName))) contentCells++;
      }
    }
    return {
      sheet: chosen.getAttribute("name"), sheetCount: sheets.length, fills, gridlinesHidden, overlays: [...new Set(overlays)],
      borderedCells, contentCells, storedRowHeights: [...new Set(storedRowHeights)],
      storedColumnWidths: [...new Set(columns.map(col => {
        const value = col?.getAttribute("width") || sheetFormat?.getAttribute("defaultColWidth");
        return value ? Number(value) : null;
      }))],
    };
  } finally {
    archive.zip.close();
  }
}

function comparePreview(bytes: Buffer, range: ReturnType<typeof parseExcelEvidenceRange>, fills: (number | null)[], background: number) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  requirePart(bytes.length >= 33 && bytes.subarray(0, 8).equals(signature) && bytes.toString("ascii", 12, 16) === "IHDR",
    "预览文件不是 PNG。");
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  requirePart(width > 0 && height > 0 && width * height <= MAX_PIXELS, "PNG 验证上限为 16777216 个像素。");
  const cellWidth = width / range.columns;
  const cellHeight = height / range.rows;
  requirePart(Number.isInteger(cellWidth) && Number.isInteger(cellHeight), "PNG 尺寸不能被工作簿区域的行列整除。");
  const png = PNG.sync.read(bytes, { checkCRC: true });
  requirePart(png.width === width && png.height === height && png.data.length === width * height * 4, "PNG 像素数据无效。");
  let mismatchedCells = 0;
  let mismatchedPixels = 0;
  const examples: string[] = [];
  for (const [i, fill] of fills.entries()) {
    const row = Math.floor(i / range.columns);
    const column = i % range.columns;
    const expected = fill ?? background;
    const [red, green, blue] = [expected >> 16, (expected >> 8) & 255, expected & 255];
    let differences = 0;
    for (let y = row * cellHeight; y < (row + 1) * cellHeight; y++) {
      for (let x = column * cellWidth; x < (column + 1) * cellWidth; x++) {
        const offset = (y * width + x) * 4;
        if (png.data[offset] !== red || png.data[offset + 1] !== green || png.data[offset + 2] !== blue ||
          png.data[offset + 3] !== 255) differences++;
      }
    }
    if (!differences) continue;
    mismatchedCells++;
    mismatchedPixels += differences;
    if (examples.length < 10) examples.push(columnName(range.start.column + column) + (range.start.row + row));
  }
  return { width, height, cellWidth, cellHeight, checkedPixels: width * height, mismatchedCells, mismatchedPixels, examples };
}

export async function verifyExcelPixelArt(taskRoot: string, request: ExcelPixelArtRequest, signal?: AbortSignal) {
  const range = parseExcelEvidenceRange(request.range);
  const palette = request.palette?.map(rgb);
  const background = rgb(request.background ?? "#FFFFFF");
  const file = await readOfficeEvidenceFile(taskRoot, request.path, ".xlsx", signal);
  const { fills, ...grid } = await readGrid(file.bytes, request.sheet, range, signal);
  const counts: Record<string, number> = {};
  let filledCells = 0;
  for (const fill of fills) {
    if (fill === null) continue;
    filledCells++;
    const color = hex(fill);
    counts[color] = (counts[color] ?? 0) + 1;
  }
  const unexpectedColors = palette && Object.keys(counts).filter(color => !palette.includes(rgb(color)));
  const png = request.previewPath ? await readOfficeEvidenceFile(taskRoot, request.previewPath, ".png", signal) : undefined;
  signal?.throwIfAborted();
  const preview = png && { sha256: png.sha256, ...comparePreview(png.bytes, range, fills, background) };
  const clean = grid.gridlinesHidden && grid.contentCells === 0 && grid.borderedCells === 0 && !grid.overlays.length;
  const status = !clean || unexpectedColors?.length || preview?.mismatchedCells ? "mismatch" : preview ? "matched" : "verified";
  return { status, ...grid, workbookSha256: file.sha256, range: range.address, rows: range.rows, columns: range.columns,
    filledCells, blankCells: fills.length - filledCells, colors: counts, unexpectedColors, blankBackground: hex(background), preview };
}
