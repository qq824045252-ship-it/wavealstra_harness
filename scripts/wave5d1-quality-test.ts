/**
 * Wave 5D-1 — DOCX Quality 单元/契约测试（node 直跑）
 *
 * 覆盖：
 *   - 纯函数：data URI 解码、窗口/回收区间数学、页偏移、二分页定位、搜索匹配复用
 *   - fixture XML 契约（jszip）：document.xml 存在、分页符计数、表格/合并单元格、
 *     图片 media、页眉页脚、中文/空格文件名
 *
 * 运行：pnpm test:wave5d1（esbuild bundle → node）
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import {
  cumulativeOffsets,
  decodeDataUriBytes,
  DOCX_PAGE_GAP,
  pageAtScrollTop,
  recycleRange,
  visibleRange,
} from "../src/renderer/src/lib/docxView";
import { searchMatches } from "../src/renderer/src/lib/pdfView";

const ROOT = process.cwd();
const OFFICE = join(ROOT, "fixtures", "artifacts", "synthetic", "office");

const results: Array<[string, boolean, string]> = [];
function check(name: string, pass: boolean, detail = ""): void {
  results.push([name, pass, detail]);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

// ---------- 纯函数 ----------

function pure() {
  const bytes = decodeDataUriBytes(
    `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${Buffer.from("docx bytes").toString("base64")}`,
  );
  check("decode: data URI → bytes", Buffer.from(bytes).toString() === "docx bytes");

  const offsets = cumulativeOffsets([100, 200, 150]);
  check("offsets: 累积含间距", offsets[0] === 0 && offsets[1] === 112 && offsets[2] === 324, JSON.stringify(offsets));

  check("pageAt: 二分定位", pageAtScrollTop([0, 112, 324], 50) === 0 && pageAtScrollTop([0, 112, 324], 200) === 1 && pageAtScrollTop([0, 112, 324], 9999) === 2);

  const vis = visibleRange([0, 112, 324, 546, 778], 200, 300, 2);
  check("visible: 窗口含 overscan", vis.start === 0 && vis.end === 4, JSON.stringify(vis));
  const recy = recycleRange([0, 112, 324, 546, 778], 200, 300, 1, 1);
  check("recycle: keep 窗口收窄", recy.keepStart <= vis.start && recy.keepEnd >= vis.end, JSON.stringify(recy));

  const m = searchMatches("中文文档 中文测试 DOCX", "中文");
  check("search: 复用 pdfView 匹配", m.length === 2);
  check("gap: DOCX_PAGE_GAP = 12", DOCX_PAGE_GAP === 12);
}

// ---------- fixture XML 契约（jszip） ----------

async function fixtureXml(name: string) {
  const buf = readFileSync(join(OFFICE, name));
  const zip = await JSZip.loadAsync(buf);
  return zip;
}

async function docxContract() {
  const simple = await fixtureXml("docx-simple.docx");
  const docXml = await simple.file("word/document.xml")?.async("string");
  check("docx: simple document.xml 存在", !!docXml && docXml.includes("<w:document"));
  check("docx: simple 含中文文本", docXml?.includes("简单文档") ?? false);
  check("docx: simple 无分页符", !(docXml ?? "").includes('w:type="page"'));

  const long = await fixtureXml("docx-long-24p.docx");
  const longXml = await long.file("word/document.xml")?.async("string");
  const breaks = (longXml?.match(/<w:br\s+w:type="page"\/>/g) ?? []).length;
  check("docx: long-24p 分页符 ≥ 23", breaks >= 23, `${breaks} 个分页符`);
  check("docx: long-24p 表格 ≥ 24", (longXml?.match(/<w:tbl>/g) ?? []).length >= 24);
  check("docx: long-24p 中英混排", (longXml?.includes("Chapter") ?? false) && (longXml?.includes("段落") ?? false));

  const table = await fixtureXml("docx-table.docx");
  const tableXml = await table.file("word/document.xml")?.async("string");
  check("docx: table 网格跨度合并", (tableXml ?? "").includes("w:gridSpan"), String((tableXml?.match(/w:gridSpan/g) ?? []).length));
  check("docx: table 40+ 行", (tableXml?.match(/<w:tr>/g) ?? []).length >= 41);

  const images = await fixtureXml("docx-images.docx");
  const media = Object.keys(images.files).filter((f) => f.startsWith("word/media/"));
  const imagesXml = await images.file("word/document.xml")?.async("string");
  const embeds = (imagesXml?.match(/r:embed/g) ?? []).length;
  check("docx: images media 去重后 ≥ 2", media.length >= 2, `${media.length} 个媒体文件`);
  check("docx: images 图片引用 ≥ 8（docx 包去重字节）", embeds >= 8, `${embeds} 处 r:embed`);

  const hf = await fixtureXml("docx-header-footer.docx");
  const hasHeader = hf.file("word/header1.xml") !== null;
  const hasFooter = hf.file("word/footer1.xml") !== null;
  check("docx: header-footer 页眉存在", hasHeader);
  check("docx: header-footer 页脚存在", hasFooter);
  const headerXml = await hf.file("word/header1.xml")?.async("string");
  check("docx: 页眉文本", headerXml?.includes("MyBuddy 页眉") ?? false);
  const footerXml = await hf.file("word/footer1.xml")?.async("string");
  check("docx: 页脚文本", footerXml?.includes("页脚 Footer") ?? false);

  const breaksDoc = await fixtureXml("docx-breaks.docx");
  const breaksXml = await breaksDoc.file("word/document.xml")?.async("string");
  check("docx: breaks 分页符 = 8", (breaksXml?.match(/<w:br\s+w:type="page"\/>/g) ?? []).length === 8);

  const mixed = await fixtureXml("docx-mixed.docx");
  const mixedXml = await mixed.file("word/document.xml")?.async("string");
  check("docx: mixed 中英混排", (mixedXml?.includes("English mixed") ?? false) && (mixedXml?.includes("段落") ?? false));

  const cn = await fixtureXml("中文-文档.docx");
  const cnXml = await cn.file("word/document.xml")?.async("string");
  check("docx: 中文文件名可解包", cnXml?.includes("简单文档") ?? false);
  const sp = await fixtureXml("spaced name.docx");
  const spXml = await sp.file("word/document.xml")?.async("string");
  check("docx: 空格文件名可解包", spXml?.includes("简单文档") ?? false);
}

// ---------- 入口 ----------

async function main(): Promise<void> {
  console.log("== Wave 5D-1 unit/contract（node） ==");
  pure();
  await docxContract();

  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n结果: ${results.length - failed.length}/${results.length} PASS`);
  if (failed.length > 0) {
    for (const [name, , detail] of failed) console.log(`  FAIL ${name}${detail ? ` (${detail})` : ""}`);
    process.exit(1);
  }
}

void main();
