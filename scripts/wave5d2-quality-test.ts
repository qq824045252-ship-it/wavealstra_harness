/**
 * Wave 5D-2 — XLSX Quality 单元/契约测试（node 直跑）
 *
 * 覆盖：
 *   - 真实 SheetJS 解析 fixtures：sheet 数/维度/merges/freeze/格式化文本（日期/
 *     百分比/货币）/公式缓存值/中文文件名
 *   - styles.xml 解析：粗体/红字/灰底黄底填充/边框/居中对齐
 *   - merge 窗口数学四边例：跨视口、anchor 视口外覆盖区进入、冻结边界分片、行/列回收
 *   - 行列窗口/偏移/列字母/搜索
 *
 * 运行：pnpm test:wave5d2（esbuild bundle → node）
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { previewWorkspaceFile } from "../src/main/workspace/WorkspaceService";
import {
  OFFICE_PREVIEW_MAX_BYTES,
  OFFICE_PREVIEW_SKIP_MARKER,
  estimateDataUriBytes,
  shouldSkipOfficePreview,
} from "../src/shared/office-preview";
import {
  colLetter,
  cumulativeOffsets,
  mergeCovering,
  mergesIntersectingWindow,
  parseStylesXml,
  parseWorkbookModel,
  searchCells,
  splitMergeByFrozen,
  windowRange,
  type XlsxMerge,
} from "../src/renderer/src/lib/xlsxView";

const ROOT = process.cwd();
const OFFICE = join(ROOT, "fixtures", "artifacts", "synthetic", "office");

const results: Array<[string, boolean, string]> = [];
function check(name: string, pass: boolean, detail = ""): void {
  results.push([name, pass, detail]);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

function load(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(OFFICE, name)));
}

async function stylesXmlOf(name: string): Promise<string | null> {
  const zip = await JSZip.loadAsync(load(name));
  const entry = zip.file("xl/styles.xml");
  return entry ? entry.async("string") : null;
}

// ---------- 真实 SheetJS 解析 ----------

async function parseFixtures() {
  const simple = parseWorkbookModel(load("xlsx-simple.xlsx"), null);
  check("simple: 1 sheet 中文名", simple.sheets.length === 1 && simple.sheets[0].name === "数据");
  check("simple: 41 行 × 5 列", simple.sheets[0].rows === 41 && simple.sheets[0].cols === 5, `${simple.sheets[0].rows}×${simple.sheets[0].cols}`);
  const a1 = simple.sheets[0].cells.get("0:0");
  check("simple: A1 文本", a1?.w === "id", a1?.w);

  const multi = parseWorkbookModel(load("xlsx-multi.xlsx"), null);
  check("multi: 3 sheets", multi.sheets.length === 3, multi.sheets.map((s) => s.name).join(","));
  check("multi: 汇总 sheet 存在", multi.sheets.some((s) => s.name === "汇总"));

  const frozen = parseWorkbookModel(load("xlsx-frozen.xlsx"), null, [await sheetXmlOf("xlsx-frozen.xlsx")]);
  check("frozen: 冻结 2 行 1 列（XML pane）", frozen.sheets[0].frozen?.rows === 2 && frozen.sheets[0].frozen?.cols === 1, JSON.stringify(frozen.sheets[0].frozen));
  check("frozen: 102 行 × 20 列", frozen.sheets[0].rows === 102 && frozen.sheets[0].cols === 20, `${frozen.sheets[0].rows}×${frozen.sheets[0].cols}`);

  const merged = parseWorkbookModel(load("xlsx-merged.xlsx"), null);
  check("merged: 5 个 merge", merged.sheets[0].merges.length === 5, String(merged.sheets[0].merges.length));
  const big = merged.sheets[0].merges.find((m) => m.s.r === 30);
  check("merged: 大块 anchor r30 存在", big?.s.r === 30 && big?.e.r === 40 && big?.e.c === 5);

  const formats = parseWorkbookModel(load("xlsx-formats.xlsx"), null);
  const c2 = formats.sheets[0].cells.get("1:2");
  const d2 = formats.sheets[0].cells.get("1:3");
  const e2 = formats.sheets[0].cells.get("1:4");
  check("formats: 日期格式", /^\d{4}-\d{2}-\d{2}$/.test(c2?.w ?? ""), c2?.w ?? "");
  check("formats: 百分比", /%$/.test(d2?.w ?? ""), d2?.w ?? "");
  check("formats: 货币 ¥", (e2?.w ?? "").includes("¥"), e2?.w ?? "");

  const formula = parseWorkbookModel(load("xlsx-formula.xlsx"), null);
  const d2f = formula.sheets[0].cells.get("1:3");
  const d22 = formula.sheets[0].cells.get("21:3");
  check("formula: 有公式串", (d2f?.f ?? "").includes("B2*C2"), d2f?.f ?? "");
  check("formula: 缓存结果保留", typeof d22?.v === "number" && (d22?.f ?? "").includes("SUM"), `${d22?.v} / ${d22?.f}`);

  const k1 = parseWorkbookModel(load("xlsx-1k50.xlsx"), null);
  check("1k50: 1001 行 × 50 列", k1.sheets[0].rows === 1001 && k1.sheets[0].cols === 50, `${k1.sheets[0].rows}×${k1.sheets[0].cols}`);

  const k10 = parseWorkbookModel(load("xlsx-10k30.xlsx"), null, [await sheetXmlOf("xlsx-10k30.xlsx")]);
  check("10k30: 10001 行 × 30 列", k10.sheets[0].rows === 10001 && k10.sheets[0].cols === 30);
  check("10k30: 冻结首行首列", k10.sheets[0].frozen?.rows === 1 && k10.sheets[0].frozen?.cols === 1);
  const far = k10.sheets[0].cells.get("9999:29");
  check("10k30: 远端单元格存在", far !== undefined, far?.w ?? "?");

  const cn = parseWorkbookModel(load("中文-表格.xlsx"), null);
  check("cn: 中文文件名可解析", cn.sheets.length === 1);
  const sp = parseWorkbookModel(load("spaced name.xlsx"), null);
  check("sp: 空格文件名可解析", sp.sheets.length === 1);
}

async function sheetXmlOf(name: string): Promise<string | null> {
  const zip = await JSZip.loadAsync(load(name));
  const path = Object.keys(zip.files).filter((p) => /xl\/worksheets\/sheet\d+\.xml$/.test(p)).sort()[0];
  return path ? zip.files[path].async("string") : null;
}

// ---------- styles.xml 解析 ----------

async function styles() {
  const xml = await stylesXmlOf("xlsx-formats.xlsx");
  check("styles: formats 有 styles.xml", xml !== null);
  if (!xml) return;
  const styles = parseStylesXml(xml);
  const base = styles.length - 8; // 我的 8 个 xf 追加在 SheetJS 原有 xfs 之后
  check("styles: 合并后 ≥10 个 cellXfs", styles.length >= 10, String(styles.length));
  const my = (n: number): XlsxStyle => styles[base + n] ?? ({} as XlsxStyle);
  check("styles: 我的 xf1 粗体", my(1).bold === true);
  check("styles: 我的 xf2 灰底", my(2).fillColor === "#eeeeee");
  check("styles: 我的 xf3 黄底粗体", my(3).bold === true && my(3).fillColor === "#ffff00");
  check("styles: 我的 xf4 红字", my(4).color === "#ff0000");
  check("styles: 我的 xf5 细边框", my(5).border?.left === "thin" && my(5).border?.top === "thin");
  check("styles: 我的 xf6 居中换行", my(6).align?.h === "center" && my(6).align?.wrap === true);
  const simpleXml = await stylesXmlOf("xlsx-simple.xlsx");
  check("styles: simple 有注入样式", simpleXml !== null && parseStylesXml(simpleXml!).length >= 8);
}

// ---------- merge / 窗口数学 ----------

function mergeMath() {
  const merges: XlsxMerge[] = [
    { s: { r: 30, c: 0 }, e: { r: 40, c: 5 } },
    { s: { r: 0, c: 0 }, e: { r: 0, c: 29 } },
    { s: { r: 2, c: 1 }, e: { r: 2, c: 8 } },
  ];
  check("merge: 覆盖命中", mergeCovering(merges, 35, 3)?.s.r === 30);
  check("merge: 覆盖未命中", mergeCovering(merges, 5, 5) === null);
  // anchor 视口外、覆盖区进入视口
  const win = mergesIntersectingWindow(merges, 38, 45, 0, 10);
  check("merge: anchor 视口外仍相交", win.some((m) => m.s.r === 30 && m.e.r === 40), JSON.stringify(win.map((m) => m.s)));
  // 窗口完全在 merge 内部
  const inner = mergesIntersectingWindow(merges, 32, 34, 2, 3);
  check("merge: 窗口在 merge 内", inner.length === 1 && inner[0].s.r === 30);
  // 不相交
  const none = mergesIntersectingWindow(merges, 50, 60, 0, 5);
  check("merge: 不相交为空", none.length === 0);

  // 冻结边界分片
  const cross = { s: { r: 1, c: 0 }, e: { r: 3, c: 1 } };
  const pieces = splitMergeByFrozen(cross, 2, 1);
  const regions = pieces.map((p) => p.region).sort().join(",");
  check("merge: 冻结边界四分片", regions === "body,corner,frozen-col,frozen-row", regions);
  const inFrozen = splitMergeByFrozen({ s: { r: 0, c: 0 }, e: { r: 1, c: 0 } }, 2, 1);
  check("merge: 完全在冻结区 → corner 单片", inFrozen.length === 1 && inFrozen[0].region === "corner");
  const inBody = splitMergeByFrozen({ s: { r: 5, c: 5 }, e: { r: 6, c: 6 } }, 2, 1);
  check("merge: 完全在滚动区 → body 单片", inBody.length === 1 && inBody[0].region === "body");
}

function windowMath() {
  const offsets = cumulativeOffsets([20, 20, 20, 20, 20], 5, 20);
  check("offsets: 累积", offsets[3] === 60, JSON.stringify(offsets));
  const w1 = windowRange(5, 0, 40, offsets, 1);
  check("window: 顶部窗口含 overscan", w1.start === 0 && w1.end === 3, JSON.stringify(w1));
  const w2 = windowRange(5, 61, 40, offsets, 1);
  check("window: 滚动后窗口", w2.start === 2 && w2.end === 4, JSON.stringify(w2));
  check("colLetter: A/AA", colLetter(0) === "A" && colLetter(26) === "AA" && colLetter(49) === "AX");
  const matches = searchCells([{ rows: 2, cols: 2, cells: new Map([["0:0", { r: 0, c: 0, v: "hello", w: "hello" }]]), merges: [], colWidths: [], rowHeights: [], frozen: null }], "HELLO");
  check("search: 大小写不敏感", matches.total === 1 && matches.matches[0]?.text === "hello");
}

async function officeSkipGate(): Promise<void> {
  check("skip: marker", shouldSkipOfficePreview(OFFICE_PREVIEW_SKIP_MARKER));
  check("skip: fileBytes 超限", shouldSkipOfficePreview("data:x;base64,AA==", OFFICE_PREVIEW_MAX_BYTES + 1));
  check("skip: 小文件不跳", !shouldSkipOfficePreview("data:x;base64,AA==", 1024));
  const oversizedPayload = "A".repeat(Math.ceil(((OFFICE_PREVIEW_MAX_BYTES + 64) * 4) / 3));
  const oversizedUri = `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${oversizedPayload}`;
  check("skip: data URI 估算超限", shouldSkipOfficePreview(oversizedUri));
  const estimated = estimateDataUriBytes(oversizedUri);
  check("skip: 估算大于 500KB", estimated !== null && estimated > OFFICE_PREVIEW_MAX_BYTES, String(estimated));

  const large = await previewWorkspaceFile(join(OFFICE, "xlsx-10k30.xlsx"));
  check("skip: 1.3MB xlsx 不读入 data URI", large.content === OFFICE_PREVIEW_SKIP_MARKER, large.content.slice(0, 32));
  const small = await previewWorkspaceFile(join(OFFICE, "xlsx-simple.xlsx"));
  check("skip: 小 xlsx 仍透传 data URI", small.content.startsWith("data:") && !shouldSkipOfficePreview(small.content));
}

// ---------- 入口 ----------

async function main(): Promise<void> {
  console.log("== Wave 5D-2 unit/contract（node） ==");
  await parseFixtures();
  await styles();
  mergeMath();
  windowMath();
  await officeSkipGate();

  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n结果: ${results.length - failed.length}/${results.length} PASS`);
  if (failed.length > 0) {
    for (const [name, , detail] of failed) console.log(`  FAIL ${name}${detail ? ` (${detail})` : ""}`);
    process.exit(1);
  }
}

void main();
