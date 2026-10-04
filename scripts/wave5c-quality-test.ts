/**
 * Wave 5C — PDF Quality 单元/契约测试（node 直跑）
 *
 * 覆盖（5C Gate 机器可测部分）：
 *   - 纯函数：data URI 解码、搜索匹配（大小写/Unicode/上限）、文本拼接、缩放策略
 *   - 真实 pdfjs（legacy build，node 直跑）：fixture 页码/文本抽取/扫描件无文本/
 *     横向页宽>高/中文文件名
 *   - fixture 统计
 *
 * 运行：pnpm test:wave5c（esbuild bundle → node）
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

// pdfjs 在 node 需要 DOMMatrix/Path2D 全局：@napi-rs/canvas 提供（pdfjs 直接 import 时
// 会自行 polyfill，但 esbuild bundle 后其 createRequire(import.meta.url) 断裂 → 此处显式补）。
// 本测试以 ESM 打包且 pdfjs/@napi-rs/canvas 保持 external（运行时从 node_modules 解析）。
const canvasModule = await import("@napi-rs/canvas");
const g = globalThis as Record<string, unknown>;
if (!g.DOMMatrix) g.DOMMatrix = (canvasModule as { DOMMatrix: unknown }).DOMMatrix;
if (!g.Path2D) g.Path2D = (canvasModule as { Path2D: unknown }).Path2D;

const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");

import {
  addPageMatches,
  clampPdfZoom,
  collectPageText,
  decodeDataUriBytes,
  emptySearchState,
  fitScaleFor,
  PDF_MAX_ZOOM,
  PDF_MIN_ZOOM,
  searchMatches,
} from "../src/renderer/src/lib/pdfView";

const ROOT = process.cwd();
const FIX = join(ROOT, "fixtures", "artifacts", "synthetic");

const results: Array<[string, boolean, string]> = [];
function check(name: string, pass: boolean, detail = ""): void {
  results.push([name, pass, detail]);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

// ---------- 纯函数 ----------

function pure() {
  const bytes = decodeDataUriBytes(`data:application/pdf;base64,${Buffer.from("hello pdf").toString("base64")}`);
  check("decode: data URI → bytes", Buffer.from(bytes).toString() === "hello pdf");
  let threw = false;
  try {
    decodeDataUriBytes("not-a-data-uri");
  } catch {
    threw = true;
  }
  check("decode: 非法输入抛错", threw);

  const m = searchMatches("Hello hello HELLO", "hello");
  check("search: 大小写不敏感 ×3", m.length === 3, String(m.length));
  const cn = searchMatches("中文文档中文测试", "中文");
  check("search: Unicode 匹配 ×2", cn.length === 2 && cn[0]?.start === 0 && cn[1]?.start === 4, JSON.stringify(cn));
  const lim = searchMatches("ab".repeat(100), "ab", 10);
  check("search: 上限 10", lim.length === 10);
  check("search: 空 query → 0", searchMatches("abc", "").length === 0);
  check("search: 无命中 → 0", searchMatches("abc", "xyz").length === 0);
  const span = searchMatches("abc", "b");
  check("search: 区间正确", span[0]?.start === 1 && span[0]?.end === 2);

  const text = collectPageText([{ str: "Hello" }, { str: "world" }, { str: "" }, { str: "!" }]);
  check("collect: 空格拼接", text === "Hello world !", text);
  check("collect: 空列表", collectPageText([]) === "");

  check("zoom: 下限/上限", clampPdfZoom(0.001) === PDF_MIN_ZOOM && clampPdfZoom(99) === PDF_MAX_ZOOM);
  check("zoom: 中间值", clampPdfZoom(1.5) === 1.5);
  const fw = fitScaleFor(595, 842, 800, 900, "fit-width");
  check("fit-width: 宽度适配", Math.abs(fw - 800 / 595) < 1e-9, fw.toFixed(4));
  const fp = fitScaleFor(595, 842, 800, 900, "fit-page");
  const expectFp = Math.min(800 / 595, (900 - 10) / 842);
  check("fit-page: contain（含页间距）", Math.abs(fp - expectFp) < 1e-9, fp.toFixed(4));

  let state = emptySearchState();
  state = { ...state, query: "性能" };
  state = addPageMatches(state, 3, "性能基准测试性能");
  state = addPageMatches(state, 5, "无关文本");
  check("search-state: 跨页计数", state.total === 2, String(state.total));
  check("search-state: 按页映射", state.matches.get(3)?.length === 2 && state.matches.get(5)?.length === 0);
}

// ---------- 真实 pdfjs（node，legacy build） ----------

async function realPdfjs() {
  const open = async (name: string) => {
    const data = readFileSync(join(FIX, name));
    const doc = await getDocument({ data: new Uint8Array(data), isEvalSupported: false }).promise;
    return doc;
  };
  const pageText = async (doc: Awaited<ReturnType<typeof open>>, pageNumber: number): Promise<string> => {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    page.cleanup();
    return content.items.map((i: { str?: string }) => i.str ?? "").join(" ");
  };

  const simple = await open("pdf-simple.pdf");
  check("pdf: simple 1 页", simple.numPages === 1, String(simple.numPages));
  const simpleText = await pageText(simple, 1);
  check("pdf: simple 文本层含中英", simpleText.includes("MyBuddy PDF Fixture") && simpleText.includes("简单文档"), simpleText.slice(0, 80));
  await simple.loadingTask.destroy();

  const normal = await open("pdf-normal-40p.pdf");
  check("pdf: normal 20-50 页", normal.numPages >= 20 && normal.numPages <= 55, String(normal.numPages));
  const n1 = await pageText(normal, 1);
  const nLast = await pageText(normal, normal.numPages);
  check("pdf: normal 第 1 页含中文", n1.includes("设计文档") || n1.includes("章节"), n1.slice(0, 60));
  check("pdf: normal 末页含英文", /benchmark|evaluate|The quick/i.test(nLast), nLast.slice(0, 60));
  await normal.loadingTask.destroy();

  const large = await open("pdf-large-120p.pdf");
  check("pdf: large ≥100 页", large.numPages >= 100, String(large.numPages));
  const lMid = await pageText(large, Math.floor(large.numPages / 2));
  check("pdf: large 中页可抽取", lMid.length > 50, `${lMid.length} chars`);
  await large.loadingTask.destroy();

  const scanned = await open("pdf-scanned.pdf");
  check("pdf: scanned 4 页", scanned.numPages === 4);
  const scanText = await pageText(scanned, 1);
  check("pdf: scanned 无文本层", scanText.trim().length === 0, `len=${scanText.length}`);
  await scanned.loadingTask.destroy();

  const landscape = await open("pdf-landscape.pdf");
  check("pdf: landscape 5 页", landscape.numPages === 5);
  const page1 = await landscape.getPage(1);
  const vp = page1.getViewport({ scale: 1 });
  check("pdf: landscape 页宽 > 高", vp.width > vp.height, `${vp.width.toFixed(0)}×${vp.height.toFixed(0)}`);
  page1.cleanup();
  await landscape.loadingTask.destroy();

  const cn = await open("中文-文档.pdf");
  check("pdf: 中文文件名可打开", cn.numPages === 1);
  await cn.loadingTask.destroy();
  const spaced = await open("spaced name.pdf");
  check("pdf: 空格文件名可打开", spaced.numPages === 1);
  await spaced.loadingTask.destroy();
}

// ---------- fixture 统计 ----------

function fixtureStats() {
  const sizes = ["pdf-simple.pdf", "pdf-normal-40p.pdf", "pdf-large-120p.pdf", "pdf-scanned.pdf", "pdf-tables-images.pdf", "pdf-landscape.pdf", "中文-文档.pdf", "spaced name.pdf"];
  for (const name of sizes) {
    const size = readFileSync(join(FIX, name)).length;
    check(`fixture: ${name} 存在 (${(size / 1024).toFixed(0)}KB)`, size > 500, String(size));
  }
}

// ---------- 入口 ----------

async function main(): Promise<void> {
  console.log("== Wave 5C unit/contract（node） ==");
  pure();
  await realPdfjs();
  fixtureStats();

  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n结果: ${results.length - failed.length}/${results.length} PASS`);
  if (failed.length > 0) {
    for (const [name, , detail] of failed) console.log(`  FAIL ${name}${detail ? ` (${detail})` : ""}`);
    process.exit(1);
  }
}

void main();
