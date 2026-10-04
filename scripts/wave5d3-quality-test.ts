/**
 * Wave 5D-3 — PPTX Quality 单元/契约测试（node 直跑）
 *
 * 覆盖：
 *   - XML lite parser（嵌套/属性/实体）
 *   - 真实 PPTX 解析：slide 数/EMU→px（16:9 1280×720 / 4:3 960×720）/
 *     z-order 顺序/文本抽取/图片媒体映射/表格/渐变/旋转
 *   - 搜索
 *
 * 运行：pnpm test:wave5d3（esbuild bundle → node）
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import {
  attrInt,
  emuToPx,
  findChildBySuffix,
  parsePptxModel,
  parseXmlLite,
  resolveRelTarget,
  rotToDeg,
  searchSlides,
  type ShapeModel,
} from "../src/renderer/src/lib/pptxView";

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

function xmlLite() {
  const node = parseXmlLite(`<?xml version="1.0"?><root a="1"><child b="2">text &amp; more</child><self c="3"/></root>`);
  check("xml: root 解析", node?.tag === "root" && attrInt(node.attrs, "a") === 1);
  check("xml: 子节点与实体", findChildBySuffix(node, "child")?.text === "text & more");
  check("xml: 自闭合", findChildBySuffix(node, "self")?.attrs["c"] === "3");
  check("emu: 16:9 EMU→px", emuToPx(12192000) === 1280 && emuToPx(6858000) === 720);
  check("emu: 4:3 EMU→px", emuToPx(9144000) === 960 && emuToPx(6858000) === 720);
  check("rot: 60000ths→度", rotToDeg(450000) === 7.5);
  check("rel: 相对 slides/", resolveRelTarget("slides/slide1.xml", "ppt") === "ppt/slides/slide1.xml");
  check("rel: OfficeCLI 绝对路径", resolveRelTarget("/ppt/slides/slide1.xml", "ppt") === "ppt/slides/slide1.xml");
  check("rel: 已是 ppt/ 前缀", resolveRelTarget("ppt/slides/slide1.xml", "ppt") === "ppt/slides/slide1.xml");
  check("rel: 相对 ../media", resolveRelTarget("../media/image1.png", "ppt/slides") === "ppt/media/image1.png");
  check("rel: 绝对 /ppt/media", resolveRelTarget("/ppt/media/image1.png", "ppt/slides") === "ppt/media/image1.png");
}

async function parseOfficeCliAbsoluteTargets() {
  const zip = new JSZip();
  zip.file(
    "ppt/presentation.xml",
    `<p:presentation xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst><p:sldId id="256" r:id="Rabc123"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`,
  );
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="/ppt/slides/slide1.xml" Id="Rabc123"/></Relationships>`,
  );
  zip.file(
    "ppt/slides/slide1.xml",
    `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>OfficeCLI absolute path</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
  );
  const bytes = new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
  const model = await parsePptxModel(bytes);
  check("officecli: 绝对 Target 解析出 1 页", model.slides.length === 1, String(model.slides.length));
  check("officecli: 页内文本", model.slides[0]?.textAll.includes("OfficeCLI absolute path") ?? false, model.slides[0]?.textAll.slice(0, 40) ?? "");
}

function walkShapes(shapes: ShapeModel[]): ShapeModel[] {
  const out: ShapeModel[] = [];
  const walk = (s: ShapeModel): void => {
    out.push(s);
    if (s.children) for (const c of s.children) walk(c);
  };
  for (const s of shapes) walk(s);
  return out;
}

async function parseFixtures() {
  const simple = await parsePptxModel(load("pptx-simple.pptx"));
  check("simple: 5 slides", simple.slides.length === 5, String(simple.slides.length));
  // pptxgenjs node LAYOUT_16x9 = 9144000×5143500 EMU = 960×540 px（10×5.625 英寸，仍为 16:9）
  check("simple: 16:9 尺寸 960×540", simple.slides[0].width === 960 && simple.slides[0].height === 540, `${simple.slides[0].width}×${simple.slides[0].height}`);
  const ratio = simple.slides[0].width / simple.slides[0].height;
  check("simple: 宽高比 16:9", Math.abs(ratio - 16 / 9) < 0.01, ratio.toFixed(3));
  check("simple: 标题文本", simple.slides[0].textAll.includes("MyBuddy PPTX Fixture"), simple.slides[0].textAll.slice(0, 60));
  check("simple: 中文文本", simple.slides[1].textAll.includes("第 1 页要点") && simple.slides[1].textAll.includes("Key Point"), simple.slides[1].textAll.slice(0, 40));
  const bg = simple.slides[0].background;
  check("simple: 深蓝背景", bg?.type === "solid" && bg.color === "#1f4e79", JSON.stringify(bg));

  const media = await parsePptxModel(load("pptx-media.pptx"));
  const shapes = walkShapes(media.slides[0].shapes);
  const img = shapes.find((s) => s.type === "image");
  check("media: 图片 shape 存在", !!img, JSON.stringify(img));
  check("media: 图片媒体映射", img?.image?.mediaPath?.includes("ppt/media/") ?? false, img?.image?.mediaPath ?? "?");
  check("media: 图片尺寸非零", (img?.w ?? 0) > 100 && (img?.h ?? 0) > 100, `${img?.w}×${img?.h}`);
  check("media: 文本含中文与英文", media.slides[0].textAll.includes("图文混排") && /aspect ratio/i.test(media.slides[0].textAll));

  const zorder = await parsePptxModel(load("pptx-zorder.pptx"));
  const zShapes = zorder.slides[0].shapes.filter((s) => s.type === "shape" && !s.text);
  check("zorder: 3 个 shape", zShapes.length === 3, String(zShapes.length));
  check("zorder: z 顺序（矩形→圆→三角）", zShapes[0]?.fill?.color === "#4472c4" && zShapes[1]?.fill?.color === "#ed7d31" && zShapes[2]?.fill?.color === "#70ad47");
  const overlap = zShapes[0] && zShapes[1];
  check("zorder: 形状重叠（x/y/w/h 几何）", !!overlap && zShapes[1]!.x < zShapes[0]!.x + zShapes[0]!.w, JSON.stringify(zShapes.map((s) => [s.x, s.y, s.w, s.h])));

  const grad = await parsePptxModel(load("pptx-gradient.pptx"));
  const gShapes = grad.slides[0].shapes;
  const gradientShape = gShapes[0];
  check("gradient: 渐变填充", gradientShape?.fill?.type === "gradient" && (gradientShape.fill.colors?.length ?? 0) >= 2, JSON.stringify(gradientShape?.fill));
  const transparentShape = gShapes[1];
  check("gradient: 半透明填充", typeof transparentShape?.fill?.alpha === "number" && (transparentShape.fill.alpha ?? 0) > 0, JSON.stringify(transparentShape?.fill));
  const rotatedShape = gShapes[2];
  check("gradient: 旋转 8°", Math.abs((rotatedShape?.rotation ?? 0) - 8) < 0.6, String(rotatedShape?.rotation));

  const table = await parsePptxModel(load("pptx-table.pptx"));
  const tShapes = walkShapes(table.slides[0].shapes);
  const tbl = tShapes.find((s) => s.type === "table");
  check("table: 表格 shape", !!tbl, JSON.stringify(tbl?.table));
  check("table: 7 行 3 列", tbl?.table?.rows === 7 && tbl?.table?.cols === 3, `${tbl?.table?.rows}×${tbl?.table?.cols}`);
  check("table: 表头文本", tbl?.table?.cells[0]?.text === "产品", tbl?.table?.cells[0]?.text);

  const p43 = await parsePptxModel(load("pptx-43.pptx"));
  check("43: 4:3 尺寸 960×720", p43.slides[0].width === 960 && p43.slides[0].height === 720, `${p43.slides[0].width}×${p43.slides[0].height}`);
  check("43: 2 slides", p43.slides.length === 2);

  const long = await parsePptxModel(load("pptx-long-24p.pptx"));
  check("long: 24 slides", long.slides.length === 24, String(long.slides.length));
  check("long: 末页文本", long.slides[23].textAll.includes("Section 24"), long.slides[23].textAll.slice(0, 40));

  const cn = await parsePptxModel(load("中文-演示.pptx"));
  check("cn: 中文文件名可解析", cn.slides.length === 5);
  const sp = await parsePptxModel(load("spaced name.pptx"));
  check("sp: 空格文件名可解析", sp.slides.length === 5);

  // 搜索
  const search = searchSlides(simple.slides, "KEY POINT");
  check("search: 大小写不敏感跨 slide", search.total >= 3, String(search.total));
}

// ---------- 入口 ----------

async function main(): Promise<void> {
  console.log("== Wave 5D-3 unit/contract（node） ==");
  xmlLite();
  await parseFixtures();
  await parseOfficeCliAbsoluteTargets();

  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n结果: ${results.length - failed.length}/${results.length} PASS`);
  if (failed.length > 0) {
    for (const [name, , detail] of failed) console.log(`  FAIL ${name}${detail ? ` (${detail})` : ""}`);
    process.exit(1);
  }
}

void main();
