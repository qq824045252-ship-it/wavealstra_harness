/**
 * 1H — Office fixtures 生成器（V3.5 §28 office 样本）
 *
 * 生成真实尺度 office 样本到 fixtures/artifacts/synthetic/office/：
 *   docx-rich.docx   多段文字/表格/图片占位/列表/标题层级
 *   xlsx-rich.xlsx   多 sheet/合并单元格/样式/数字格式/图表数据
 *   pptx-rich.pptx   多页/文本/形状/图片占位/表格
 *
 * 运行：node scripts/gen-office-fixtures.mjs
 */
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  PageBreak,
  Header,
  Footer,
  ImageRun,
} from "docx";
import * as XLSX from "xlsx";
import pptxgen from "pptxgenjs";

const OUT = join(import.meta.dirname, "..", "fixtures", "artifacts", "synthetic", "office");
mkdirSync(OUT, { recursive: true });

// ---------- DOCX ----------
async function genDocx() {
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ text: "Rich Document Fixture", heading: HeadingLevel.TITLE }),
        new Paragraph({ text: "Section 1 — Paragraphs and styles", heading: HeadingLevel.HEADING_1 }),
        ...Array.from({ length: 24 }, (_, i) => [
          new Paragraph({ text: `Paragraph ${i + 1}: mixed formatting `, children: [
            new TextRun({ text: "bold text, ", bold: true }),
            new TextRun({ text: "italic text, ", italics: true }),
            new TextRun({ text: "inline code", font: "Consolas" }),
          ] }),
          new Paragraph({ text: `Body copy ${i + 1}. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.`, alignment: AlignmentType.JUSTIFIED }),
        ]).flat(),
        new Paragraph({ text: "Section 2 — Table", heading: HeadingLevel.HEADING_1 }),
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({ children: Array.from({ length: 5 }, (_, c) => new TableCell({ children: [new Paragraph({ text: `Header ${c + 1}` })] })) }),
            ...Array.from({ length: 30 }, (_, r) => new TableRow({
              children: Array.from({ length: 5 }, (_, c) => new TableCell({
                children: [new Paragraph({ text: `R${r + 1}C${c + 1} — data cell with some longer content for wrap testing` })],
              })),
            })),
          ],
        }),
        new Paragraph({ text: "Section 3 — Lists", heading: HeadingLevel.HEADING_1 }),
        ...Array.from({ length: 12 }, (_, i) => new Paragraph({ text: `List item ${i + 1} with sub-detail`, bullet: { level: i % 2 } })),
      ],
    }],
  });
  const buf = await Packer.toBuffer(doc);
  writeFileSync(join(OUT, "docx-rich.docx"), buf);
  console.log(`docx-rich.docx ${(buf.length / 1024).toFixed(1)} KB`);
}

// ---------- XLSX ----------
function genXlsx() {
  const wb = XLSX.utils.book_new();
  // Sheet1: 数据表（500 行 × 8 列，含数字/文本/日期/公式）
  const rows = [["id", "name", "qty", "price", "total", "date", "status", "note"]];
  for (let i = 1; i <= 500; i++) {
    rows.push([
      i,
      `item-${i}`,
      (i * 7) % 100,
      19.99 + (i % 50) * 0.5,
      { f: `C${i + 1}*D${i + 1}` },
      new Date(2026, 0, (i % 28) + 1),
      i % 3 === 0 ? "done" : "pending",
      `note for row ${i} with some longer text`,
    ]);
  }
  const ws1 = XLSX.utils.aoa_to_sheet(rows);
  ws1["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 7 } }];
  ws1["!cols"] = Array.from({ length: 8 }, () => ({ wch: 22 }));
  XLSX.utils.book_append_sheet(wb, ws1, "data");

  // Sheet2: 汇总（合并单元格 + 样式表头）
  const sum = XLSX.utils.aoa_to_sheet([
    ["Summary Report"],
    ["", "Q1", "Q2", "Q3", "Q4"],
    ...Array.from({ length: 20 }, (_, i) => ["", `metric-${i}`, (i * 13) % 500, (i * 29) % 400, (i * 7) % 300, (i * 3) % 200]),
  ]);
  sum["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 5 } }];
  sum["!cols"] = Array.from({ length: 6 }, () => ({ wch: 14 }));
  XLSX.utils.book_append_sheet(wb, sum, "summary");

  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  writeFileSync(join(OUT, "xlsx-rich.xlsx"), buf);
  console.log(`xlsx-rich.xlsx ${(buf.length / 1024).toFixed(1)} KB`);
}

// ---------- PPTX ----------
async function genPptx() {
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_16x9";
  pptx.author = "mybuddy-fixture";
  pptx.title = "Rich PPTX Fixture";
  for (let s = 1; s <= 10; s++) {
    const slide = pptx.addSlide();
    slide.background = { color: s % 2 ? "F5F5F5" : "FFFFFF" };
    slide.addText(`Slide ${s} — Title`, { x: 0.5, y: 0.3, w: 9, h: 0.8, fontSize: 28, bold: true });
    slide.addText(
      Array.from({ length: 6 }, (_, i) => `Bullet ${i + 1}: content line with formatting details`).join("\n"),
      { x: 0.7, y: 1.4, w: 8, h: 2.5, fontSize: 16, bullet: true },
    );
    slide.addShape("rect", { x: 0.7, y: 4.3, w: 3, h: 1.2, fill: { color: "4472C4" }, line: { color: "000000" } });
    slide.addText(`Footer ${s}`, { x: 0.5, y: 5.2, w: 9, h: 0.4, fontSize: 10, color: "888888" });
  }
  const buf = await pptx.write({ outputType: "nodebuffer" });
  writeFileSync(join(OUT, "pptx-rich.pptx"), buf);
  console.log(`pptx-rich.pptx ${(buf.length / 1024).toFixed(1)} KB`);
}

await genDocx();
genXlsx();
await genPptx();
console.log("office fixtures 生成完成 →", OUT);

// ---------- Wave 5D-1：DOCX fixture 集 ----------

const tinyPng = readFileSync(join(import.meta.dirname, "..", "fixtures", "artifacts", "synthetic", "image-small.png"));
const bigPng = readFileSync(join(import.meta.dirname, "..", "fixtures", "artifacts", "synthetic", "image-basic.png"));

function mixedParagraph(n) {
  return new Paragraph({
    children: [
      new TextRun({ text: `段落 ${n}：中文与 English mixed content。` }),
      new TextRun({ text: `The quick brown fox jumps over the lazy dog. `, italics: true }),
      new TextRun({ text: `性能预算与内存回收需要统一基准。`, bold: true }),
      new TextRun({ text: "Paragraph " + n + " ends with formatting variety." }),
    ],
    alignment: AlignmentType.JUSTIFIED,
  });
}

function mixedHeading(n) {
  return new Paragraph({
    text: `第 ${n} 章 — Chapter ${n}`,
    heading: HeadingLevel.HEADING_1,
  });
}

// docx-simple：单页（标题/段落/列表/中英）
async function genDocxSimple() {
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ text: "MyBuddy DOCX Fixture — 简单文档", heading: HeadingLevel.TITLE }),
        new Paragraph({ text: "这是一页简单的 Word 文档，包含中文与 English 内容，用于基础渲染与文本层验证。", alignment: AlignmentType.JUSTIFIED }),
        new Paragraph({ text: "Features: paged rendering, tables, images, headers and footers." }),
        ...Array.from({ length: 3 }, (_, i) => new Paragraph({ text: `要点 ${i + 1}：可靠查看 Key point ${i + 1}`, bullet: { level: 0 } })),
        new Paragraph({ text: "结束 — End of document." }),
      ],
    }],
  });
  const buf = await Packer.toBuffer(doc);
  writeFileSync(join(OUT, "docx-simple.docx"), buf);
  writeFileSync(join(OUT, "中文-文档.docx"), buf);
  writeFileSync(join(OUT, "spaced name.docx"), buf);
  console.log(`docx-simple.docx / 中文-文档.docx / spaced name.docx ${(buf.length / 1024).toFixed(1)} KB`);
}

// docx-long-24p：≥20 页（分页符 + 章节模板）
async function genDocxLong() {
  const children = [];
  for (let n = 1; n <= 24; n++) {
    children.push(mixedHeading(n));
    children.push(mixedParagraph(n));
    children.push(new Paragraph({ children: [new TextRun("表格 Table " + n)], heading: HeadingLevel.HEADING_2 }));
    children.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({ children: Array.from({ length: 4 }, (_, c) => new TableCell({ children: [new Paragraph({ text: `H${n}-${c + 1}` })] })) }),
          ...Array.from({ length: 10 }, (_, r) => new TableRow({
            children: Array.from({ length: 4 }, (_, c) => new TableCell({ children: [new Paragraph({ text: `r${n}-${r + 1}-${c + 1}` })] })),
          })),
        ],
      }),
    );
    children.push(new Paragraph({ children: [new TextRun("段落文本 Paragraph body with mixed 中文 content "), new PageBreak()] }));
  }
  const doc = new Document({ sections: [{ children }] });
  const buf = await Packer.toBuffer(doc);
  writeFileSync(join(OUT, "docx-long-24p.docx"), buf);
  console.log(`docx-long-24p.docx ${(buf.length / 1024).toFixed(1)} KB`);
}

// docx-mixed：中英文混排重点
export async function genDocxMixed() {
  const children = [
    new Paragraph({ text: "中英文混排文档 — Mixed Language Document", heading: HeadingLevel.TITLE }),
  ];
  for (let i = 0; i < 18; i++) {
    children.push(mixedParagraph(i + 1));
    if (i % 6 === 5) children.push(new Paragraph({ children: [new PageBreak()] }));
  }
  children.push(...Array.from({ length: 6 }, (_, i) => new Paragraph({ text: `列表 List ${i + 1}：混合内容 mixed content line` })));
  const doc = new Document({ sections: [{ children }] });
  const buf = await Packer.toBuffer(doc);
  writeFileSync(join(OUT, "docx-mixed.docx"), buf);
  console.log(`docx-mixed.docx ${(buf.length / 1024).toFixed(1)} KB`);
}

// docx-table：复杂表格（合并单元格 + 多行列）
async function genDocxTable() {
  const headerRow = new TableRow({
    children: Array.from({ length: 6 }, (_, c) => new TableCell({
      children: [new Paragraph({ text: `列 Column ${c + 1}` })] ,
      shading: { fill: "EEEEEE" },
    })),
  });
  const rows = [headerRow];
  for (let r = 0; r < 40; r++) {
    rows.push(new TableRow({
      children: Array.from({ length: 6 }, (_, c) => new TableCell({
        children: [new Paragraph({ text: `R${r + 1}C${c + 1} 数据 data ${(r * 31 + c * 7) % 97}` })] ,
      })),
    }));
  }
  const merged = new TableRow({
    children: [
      new TableCell({ children: [new Paragraph({ text: "合并单元格 Merged Cell A" })], columnSpan: 3 }),
      new TableCell({ children: [new Paragraph({ text: "B" })] , columnSpan: 3 }),
    ],
  });
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ text: "复杂表格 — Complex Table", heading: HeadingLevel.TITLE }),
        new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [merged, ...rows] }),
      ],
    }],
  });
  const buf = await Packer.toBuffer(doc);
  writeFileSync(join(OUT, "docx-table.docx"), buf);
  console.log(`docx-table.docx ${(buf.length / 1024).toFixed(1)} KB`);
}

// docx-images：图片较多
export async function genDocxImages() {
  const imageParagraphs = [];
  for (let i = 0; i < 8; i++) {
    imageParagraphs.push(
      new Paragraph({ text: `图 ${i + 1} — Figure ${i + 1}`, heading: HeadingLevel.HEADING_2 }),
      new Paragraph({
        children: [
          new ImageRun({
            data: i % 2 === 0 ? tinyPng : bigPng,
            transformation: { width: i % 2 === 0 ? 220 : 420, height: i % 2 === 0 ? 220 : 315 },
          }),
        ],
      }),
      mixedParagraph(i + 1),
      // 每图一页（docx-preview 仅按显式分页符分页）
      new Paragraph({ children: [new PageBreak()] }),
    );
  }
  const doc = new Document({ sections: [{ children: imageParagraphs }] });
  const buf = await Packer.toBuffer(doc);
  writeFileSync(join(OUT, "docx-images.docx"), buf);
  console.log(`docx-images.docx ${(buf.length / 1024).toFixed(1)} KB`);
}

// docx-header-footer：页眉页脚
export async function genDocxHeaderFooter() {
  const doc = new Document({
    sections: [{
      headers: {
        default: new Header({ children: [new Paragraph({ text: "MyBuddy 页眉 Header — Wave 5D-1" })] }),
      },
      footers: {
        default: new Footer({ children: [new Paragraph({ text: "页脚 Footer — mybuddy artifact fixture" })] }),
      },
      children: [
        new Paragraph({ text: "页眉页脚测试 — Header/Footer Test", heading: HeadingLevel.TITLE }),
        ...Array.from({ length: 10 }, (_, i) => mixedParagraph(i + 1)),
      ],
    }],
  });
  const buf = await Packer.toBuffer(doc);
  writeFileSync(join(OUT, "docx-header-footer.docx"), buf);
  console.log(`docx-header-footer.docx ${(buf.length / 1024).toFixed(1)} KB`);
}

// docx-breaks：分页符
export async function genDocxBreaks() {
  const children = [];
  for (let i = 0; i < 8; i++) {
    children.push(mixedHeading(i + 1));
    children.push(mixedParagraph(i + 1));
    children.push(new Paragraph({ children: [new PageBreak()] }));
  }
  const doc = new Document({ sections: [{ children }] });
  const buf = await Packer.toBuffer(doc);
  writeFileSync(join(OUT, "docx-breaks.docx"), buf);
  console.log(`docx-breaks.docx ${(buf.length / 1024).toFixed(1)} KB`);
}

await genDocxSimple();
await genDocxLong();
await genDocxMixed();
await genDocxTable();
await genDocxImages();
await genDocxHeaderFooter();
await genDocxBreaks();
console.log("Wave 5D-1 DOCX fixtures 完成");

// ---------- Wave 5D-2：XLSX fixture 集 ----------

import JSZip from "jszip";

/**
 * SheetJS 社区版写出的 xlsx：无冻结窗格、公式无缓存值、样式表极简。
 * jszip 后处理：
 *   1) 合并注入 styles.xml（追加 fonts/fills/borders/xfs，保持 SheetJS 原有 numFmt/xf 索引有效）
 *   2) 单元格 s 属性（相对 SheetJS 已有 xf 数偏移）
 *   3) 带 <f> 的单元格补 t="n" + <v>（已保存的计算结果）
 *   4) 冻结窗格 <pane> 注入
 */
export async function postProcessXlsx(buf, { styleCells = {}, formulaValues = {}, freeze = {} } = {}) {
  const zip = await JSZip.loadAsync(buf);
  const sheetPaths = Object.keys(zip.files)
    .filter((p) => /xl\/worksheets\/sheet\d+\.xml$/.test(p))
    .sort();

  // ---- 1) styles.xml 合并注入 ----
  const existingStyles = zip.file("xl/styles.xml") ? await zip.file("xl/styles.xml").async("string") : null;
  // SheetJS count 属性可能与实际 xf 数不一致 → 直接数 cellXfs 段内的 <xf 标签
  const baseXfCount = existingStyles
    ? (/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(existingStyles)?.[1]?.match(/<xf\b/g) ?? []).length
    : 0;
  // 追加后我的 font/fill/border 索引 = SheetJS 原有数量 + 相对索引（0/1 默认项不偏移）
  const fontBase = existingStyles ? (/<fonts[^>]*>([\s\S]*?)<\/fonts>/.exec(existingStyles)?.[1]?.match(/<font\b/g) ?? []).length : 1;
  const fillBase = existingStyles ? (/<fills[^>]*>([\s\S]*?)<\/fills>/.exec(existingStyles)?.[1]?.match(/<fill\b/g) ?? []).length : 2;
  const borderBase = existingStyles ? (/<borders[^>]*>([\s\S]*?)<\/borders>/.exec(existingStyles)?.[1]?.match(/<border\b/g) ?? []).length : 1;

  const MY_NUMFMTS = `<numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="0.0%"/><numFmt numFmtId="166" formatCode="\"¥\"#,##0.00"/>`;
  const MY_FONTS =
    `<font><b/><sz val="11"/><name val="Calibri"/></font>` +
    `<font><sz val="11"/><color rgb="FFFF0000"/><name val="Calibri"/></font>` +
    `<font><b/><sz val="13"/><name val="Calibri"/></font>`;
  const MY_FILLS =
    `<fill><patternFill patternType="solid"><fgColor rgb="FFEEEEEE"/></patternFill></fill>` +
    `<fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/></patternFill></fill>`;
  const MY_BORDERS = `<border><left style="thin"><color rgb="FF000000"/></left><right style="thin"><color rgb="FF000000"/></right><top style="thin"><color rgb="FF000000"/></top><bottom style="thin"><color rgb="FF000000"/></bottom><diagonal/></border>`;
  const MY_XFS =
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
    `<xf numFmtId="0" fontId="${fontBase}" fillId="0" borderId="0" xfId="0"/>` +
    `<xf numFmtId="0" fontId="0" fillId="${fillBase}" borderId="0" xfId="0"/>` +
    `<xf numFmtId="0" fontId="${fontBase}" fillId="${fillBase + 1}" borderId="0" xfId="0"/>` +
    `<xf numFmtId="0" fontId="${fontBase + 1}" fillId="0" borderId="0" xfId="0"/>` +
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="${borderBase}" xfId="0"/>` +
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>` +
    `<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0"/>`;

  let stylesXml = existingStyles;
  if (stylesXml) {
    stylesXml = stylesXml
      .replace(/(<numFmts count=")(\d+)(">)/, (m, a, n, c) => `${a}${parseInt(n, 10) + 3}${c}`)
      .replace(/(<\/numFmts>)/, `${MY_NUMFMTS}$1`)
      .replace(/(<fonts count=")(\d+)(">)/, (m, a, n, c) => `${a}${parseInt(n, 10) + 3}${c}`)
      .replace(/(<\/fonts>)/, `${MY_FONTS}$1`)
      .replace(/(<fills count=")(\d+)(">)/, (m, a, n, c) => `${a}${parseInt(n, 10) + 2}${c}`)
      .replace(/(<\/fills>)/, `${MY_FILLS}$1`)
      .replace(/(<borders count=")(\d+)(">)/, (m, a, n, c) => `${a}${parseInt(n, 10) + 1}${c}`)
      .replace(/(<\/borders>)/, `${MY_BORDERS}$1`)
      // 我的 xfs 追加在 SheetJS 原有 xfs 之后（原 s 索引保持有效）
      .replace(/(<cellXfs count=")(\d+)(">)/, (m, a, n, c) => `${a}${parseInt(n, 10) + 8}${c}`)
      .replace(/(<\/cellXfs>)/, `${MY_XFS}$1`);
  } else {
    stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3">${MY_NUMFMTS}</numFmts>
<fonts count="4"><font><sz val="11"/><name val="Calibri"/></font>${MY_FONTS}</fonts>
<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>${MY_FILLS}</fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>${MY_BORDERS}</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="8">${MY_XFS}</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
  }
  zip.file("xl/styles.xml", stylesXml);

  // ---- 2/3/4) sheet XML 补丁 ----
  for (let si = 0; si < sheetPaths.length; si++) {
    const path = sheetPaths[si];
    let xml = await zip.files[path].async("string");
    const sheetStyle = styleCells[si] ?? {};
    for (const [addr, sIdx] of Object.entries(sheetStyle)) {
      xml = xml.replace(new RegExp(`<c r="${addr}"([^>]*)>`), (m, attrs) => {
        const rest = attrs.replace(/\s+s="\d+"/, "");
        return `<c r="${addr}"${rest} s="${sIdx + baseXfCount}">`;
      });
    }
    const sheetFormulas = formulaValues[si] ?? {};
    for (const [addr, value] of Object.entries(sheetFormulas)) {
      xml = xml.replace(new RegExp(`(<c r="${addr}"[^>]*)(><f>[\\s\\S]*?<\\/f>)(<\\/c>)`), `$1 t="n"$2<v>${value}</v>$3`);
    }
    const sheetFreeze = freeze[si];
    if (sheetFreeze) {
      const { xSplit, ySplit } = sheetFreeze;
      const topLeft = `${colLetterX(xSplit)}${ySplit + 1}`;
      xml = xml.replace(
        /(<sheetViews><sheetView[^>]*>)/,
        `$1<pane xSplit="${xSplit}" ySplit="${ySplit}" topLeftCell="${topLeft}" activePane="bottomRight" state="frozen"/><selection pane="bottomRight"/>`,
      );
    }
    zip.file(path, xml);
  }
  return await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

function colLetterX(index) {
  let n = index;
  let out = "";
  while (n >= 0) {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  }
  return out;
}

async function writeXlsxFixture(name, wb, post) {
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const out = post ? await postProcessXlsx(buf, post) : buf;
  writeFileSync(join(OUT, name), out);
  console.log(`${name} ${(out.length / 1024).toFixed(1)} KB`);
}

// xlsx-simple：单 sheet 基础
async function genXlsxSimple() {
  const ws = XLSX.utils.aoa_to_sheet([
    ["id", "名称 name", "数量", "单价", "金额"],
    ...Array.from({ length: 40 }, (_, i) => [i + 1, `item-${i + 1}`, (i * 3) % 50, 9.99 + (i % 10), Math.round(((i * 3) % 50) * (9.99 + (i % 10)) * 100) / 100]),
  ]);
  ws["!cols"] = Array.from({ length: 5 }, () => ({ wch: 14 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "数据");
  await writeXlsxFixture("xlsx-simple.xlsx", wb, {
    styleCells: {
      0: { A1: 1, B1: 1, C1: 1, D1: 1, E1: 1, A2: 2, B2: 2 },
    },
  });
  const buf2 = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  writeFileSync(join(OUT, "中文-表格.xlsx"), buf2);
  writeFileSync(join(OUT, "spaced name.xlsx"), buf2);
  console.log(`中文-表格.xlsx / spaced name.xlsx ${(buf2.length / 1024).toFixed(1)} KB`);
}

// xlsx-multi：3 sheets
async function genXlsxMulti() {
  const wb = XLSX.utils.book_new();
  const data = XLSX.utils.aoa_to_sheet([["月份", "销售额", "成本"], ...Array.from({ length: 12 }, (_, i) => [`2026-${String(i + 1).padStart(2, "0")}`, 1000 + i * 250, 600 + i * 120])]);
  XLSX.utils.book_append_sheet(wb, data, "销售数据");
  const sum = XLSX.utils.aoa_to_sheet([["指标", "值"], ["总收入", 27500], ["总成本", 13920], ["利润率", 0.494]]);
  XLSX.utils.book_append_sheet(wb, sum, "汇总");
  const note = XLSX.utils.aoa_to_sheet([["说明 Note"], ["本工作簿用于多 Sheet 测试"], ["Sheet tab 切换验证"]]);
  XLSX.utils.book_append_sheet(wb, note, "说明");
  await writeXlsxFixture("xlsx-multi.xlsx", wb, {
    styleCells: {
      0: { A1: 1, B1: 1, C1: 1 },
      1: { A1: 1 },
      2: { A1: 3 },
    },
  });
}

// xlsx-frozen：冻结 2 行 + 1 列
async function genXlsxFrozen() {
  const rows = [["ID", "项目", ...Array.from({ length: 18 }, (_, c) => `C${c + 1}`)]];
  rows.push(["", "类型", ...Array.from({ length: 18 }, (_, c) => `col${c + 1}`)]);
  for (let r = 1; r <= 100; r++) {
    rows.push([r, `项目-${r}`, ...Array.from({ length: 18 }, (_, c) => (r * 7 + c * 13) % 997)]);
  }
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!freeze"] = { xSplit: 1, ySplit: 2 };
  ws["!cols"] = Array.from({ length: 20 }, (_, c) => ({ wch: c < 2 ? 12 : 9 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "冻结");
  await writeXlsxFixture("xlsx-frozen.xlsx", wb, {
    styleCells: { 0: { A1: 1, A2: 1, B1: 1, B2: 1 } },
    freeze: { 0: { xSplit: 1, ySplit: 2 } },
  });
}

// xlsx-merged：跨视口/跨冻结边界的 merge
async function genXlsxMerged() {
  const rows = Array.from({ length: 60 }, (_, r) => Array.from({ length: 30 }, (_, c) => `r${r + 1}c${c + 1}`));
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 29 } }, // 跨全宽标题（anchor 在视口内）
    { s: { r: 2, c: 1 }, e: { r: 2, c: 8 } }, // 普通跨列
    { s: { r: 4, c: 2 }, e: { r: 9, c: 2 } }, // 跨行
    { s: { r: 30, c: 0 }, e: { r: 40, c: 5 } }, // 大块：anchor 在视口外时覆盖区进入视口
    { s: { r: 50, c: 20 }, e: { r: 55, c: 29 } }, // 右下角大块
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "合并");
  await writeXlsxFixture("xlsx-merged.xlsx", wb, {
    styleCells: { 0: { A1: 3 } },
  });
}

// xlsx-formats：数字/日期/百分比/货币 + 样式（粗体/填充/红字/边框/对齐）
async function genXlsxFormats() {
  const rows = [
    ["类别", "数值", "日期", "百分比", "货币"],
    ...Array.from({ length: 20 }, (_, i) => [
      `行 ${i + 1}`,
      1234.5678 + i,
      new Date(2026, 0, (i % 28) + 1),
      (i % 10) / 10,
      99.9 + i * 10,
    ]),
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = Array.from({ length: 5 }, () => ({ wch: 14 }));
  // 数字格式
  for (let i = 2; i <= 21; i++) {
    ws[`B${i}`].z = "#,##0.00";
    ws[`C${i}`].z = "yyyy-mm-dd";
    ws[`D${i}`].z = "0.0%";
    ws[`E${i}`].z = "\"¥\"#,##0.00";
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "格式");
  // 装饰样式只打在 A 列与表头（不覆盖 B-E 的数字格式单元格）
  const styleCells = { 0: { A1: 1, B1: 1, C1: 1, D1: 1, E1: 1 } };
  for (let i = 2; i <= 21; i++) {
    styleCells[0][`A${i}`] = 6; // 居中
    if (i % 4 === 0) styleCells[0][`A${i}`] = 4; // 红字
    if (i % 5 === 0) styleCells[0][`A${i}`] = 2; // 灰底
    if (i % 3 === 0) styleCells[0][`B${i}`] = 5; // 边框（B 列无格式，安全）
  }
  await writeXlsxFixture("xlsx-formats.xlsx", wb, { styleCells });
}

// xlsx-formula：公式 + 已保存结果
async function genXlsxFormula() {
  const rows = [
    ["产品", "单价", "数量", "小计", "备注"],
    ...Array.from({ length: 20 }, (_, i) => [
      `产品-${i + 1}`,
      10 + i * 2.5,
      (i * 7) % 40 + 1,
      { f: `B${i + 2}*C${i + 2}` },
      "公式结果",
    ]),
    ["合计", "", "", { f: "SUM(D2:D21)" }, "SUM"],
    ["平均", "", "", { f: "AVERAGE(D2:D21)" }, "AVG"],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "公式");
  const formulaValues = { 0: {} };
  for (let i = 2; i <= 21; i++) {
    formulaValues[0][`D${i}`] = Math.round((10 + (i - 2) * 2.5) * ((i - 2) * 7 % 40 + 1) * 100) / 100;
  }
  formulaValues[0].D22 = 1234.5;
  formulaValues[0].D23 = 61.7;
  await writeXlsxFixture("xlsx-formula.xlsx", wb, { formulaValues });
}

// xlsx-1k50：1000 行 × 50 列
async function genXlsx1k50() {
  const rows = [Array.from({ length: 50 }, (_, c) => `列 Column ${c + 1}`)];
  for (let r = 1; r <= 1000; r++) {
    rows.push(Array.from({ length: 50 }, (_, c) => (r * 31 + c * 17) % 10000));
  }
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = Array.from({ length: 50 }, () => ({ wch: 10 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "大表");
  await writeXlsxFixture("xlsx-1k50.xlsx", wb, { styleCells: { 0: { A1: 1 } } });
}

// xlsx-10k30：10000 行 × 30 列
async function genXlsx10k30() {
  const rows = [["ID", "名称", ...Array.from({ length: 28 }, (_, c) => `字段${c + 1}`)]];
  for (let r = 1; r <= 10000; r++) {
    rows.push([r, `记录-${r}`, ...Array.from({ length: 28 }, (_, c) => (r * 13 + c * 7) % 5000)]);
  }
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!freeze"] = { xSplit: 1, ySplit: 1 };
  ws["!cols"] = Array.from({ length: 30 }, (_, c) => ({ wch: c < 2 ? 12 : 10 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "大数据");
  await writeXlsxFixture("xlsx-10k30.xlsx", wb, {
    styleCells: { 0: { A1: 1, B1: 1 } },
    freeze: { 0: { xSplit: 1, ySplit: 1 } },
  });
}

await genXlsxSimple();
await genXlsxMulti();
await genXlsxFrozen();
await genXlsxMerged();
await genXlsxFormats();
await genXlsxFormula();
await genXlsx1k50();
await genXlsx10k30();
console.log("Wave 5D-2 XLSX fixtures 完成");

// ---------- Wave 5D-3：PPTX fixture 集 ----------

const imgPath = join(import.meta.dirname, "..", "fixtures", "artifacts", "synthetic", "image-basic.png");

async function writePptx(name, pptx) {
  const buf = await pptx.write({ outputType: "nodebuffer" });
  writeFileSync(join(OUT, name), buf);
  console.log(`${name} ${(buf.length / 1024).toFixed(1)} KB`);
}

// pptx-simple：16:9 标题页 + 要点页
async function genPptxSimple() {
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_16x9";
  pptx.author = "mybuddy-fixture";
  pptx.title = "Simple Deck";
  const s1 = pptx.addSlide();
  s1.background = { color: "1F4E79" };
  s1.addText("MyBuddy PPTX Fixture", { x: 0.6, y: 1.8, w: 8.8, h: 1, fontSize: 40, bold: true, color: "FFFFFF", fontFace: "Arial" });
  s1.addText("简单演示文稿 Simple Presentation", { x: 0.6, y: 3.0, w: 8.8, h: 0.6, fontSize: 18, color: "BDD7EE" });
  for (let i = 1; i <= 4; i++) {
    const s = pptx.addSlide();
    s.background = { color: "FFFFFF" };
    s.addText(`第 ${i} 页要点 Key Point ${i}`, { x: 0.5, y: 0.3, w: 9, h: 0.8, fontSize: 28, bold: true, color: "1F4E79" });
    s.addText(
      Array.from({ length: 4 }, (_, k) => `• 内容项 Item ${k + 1}：中文与 English mixed`).join("\n"),
      { x: 0.7, y: 1.4, w: 8.6, h: 2.5, fontSize: 16, color: "333333" },
    );
    s.addText(`Page ${i + 1} / 5`, { x: 0.5, y: 5.3, w: 9, h: 0.4, fontSize: 10, color: "888888" });
  }
  const buf = await pptx.write({ outputType: "nodebuffer" });
  writeFileSync(join(OUT, "pptx-simple.pptx"), buf);
  writeFileSync(join(OUT, "中文-演示.pptx"), buf);
  writeFileSync(join(OUT, "spaced name.pptx"), buf);
  console.log(`pptx-simple.pptx / 中文-演示.pptx / spaced name.pptx ${(buf.length / 1024).toFixed(1)} KB`);
}

// pptx-media：图文混排
async function genPptxMedia() {
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_16x9";
  const s = pptx.addSlide();
  s.background = { color: "F5F5F5" };
  s.addText("图文混排 — Media Layout", { x: 0.5, y: 0.3, w: 9, h: 0.7, fontSize: 26, bold: true });
  s.addImage({ path: imgPath, x: 0.6, y: 1.3, w: 4.4, h: 3.3 });
  s.addText(
    "左侧为图片，右侧为说明文字。The image keeps its aspect ratio.\n图片保持宽高比，字体使用中文字体渲染。\n• 要点 1\n• 要点 2",
    { x: 5.4, y: 1.5, w: 4.4, h: 3.0, fontSize: 14, color: "333333" },
  );
  s.addText("Page 1 / 1", { x: 0.5, y: 5.4, w: 9, h: 0.4, fontSize: 10, color: "888888" });
  await writePptx("pptx-media.pptx", pptx);
}

// pptx-zorder：重叠 shape + z-order
async function genPptxZorder() {
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_16x9";
  const s = pptx.addSlide();
  s.background = { color: "FFFFFF" };
  s.addShape(pptx.ShapeType.rect, { x: 1.0, y: 1.0, w: 4.0, h: 2.5, fill: { color: "4472C4" }, line: { color: "000000" } });
  s.addShape(pptx.ShapeType.ellipse, { x: 3.2, y: 1.6, w: 2.6, h: 2.6, fill: { color: "ED7D31" }, line: { color: "000000" } });
  s.addShape(pptx.ShapeType.triangle, { x: 5.0, y: 2.2, w: 2.2, h: 2.2, fill: { color: "70AD47" }, line: { color: "000000" } });
  s.addText("Z-ORDER：矩形 → 圆 → 三角形（后添加在上层）", { x: 0.8, y: 4.9, w: 8.4, h: 0.6, fontSize: 14, color: "333333" });
  await writePptx("pptx-zorder.pptx", pptx);
}

// pptx-gradient：透明度 + 渐变（pptxgenjs node 不写 gradFill → jszip 注入）
async function genPptxGradient() {
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_16x9";
  const s = pptx.addSlide();
  s.background = { color: "F0F0F0" };
  s.addShape(pptx.ShapeType.rect, {
    x: 0.7, y: 0.8, w: 4.4, h: 2.2,
    fill: { color: "FF0000" },
    line: { color: "333333" },
  });
  s.addShape(pptx.ShapeType.rect, {
    x: 5.4, y: 0.8, w: 4.4, h: 2.2,
    fill: { color: "00B050", transparency: 50 },
    line: { color: "333333" },
  });
  s.addShape(pptx.ShapeType.rect, {
    x: 0.7, y: 3.4, w: 9.1, h: 1.8,
    fill: { color: "FFC000" },
    rotate: 8,
    line: { color: "333333" },
  });
  s.addText("渐变（左上→右下）· 半透明绿 · 旋转 8°", { x: 0.7, y: 5.4, w: 9, h: 0.5, fontSize: 14, color: "333333" });
  const buf = await pptx.write({ outputType: "nodebuffer" });
  // 给第一个矩形注入 gradFill（红→蓝，45°）
  const zip = await JSZip.loadAsync(buf);
  const path = Object.keys(zip.files).find((p) => /ppt\/slides\/slide1\.xml$/.test(p));
  if (path) {
    let xml = await zip.files[path].async("string");
    xml = xml.replace(
      /<a:solidFill><a:srgbClr val="FF0000"\/><\/a:solidFill>/,
      `<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs><a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs></a:gsLst><a:lin ang="5400000" scaled="1"/></a:gradFill>`,
    );
    zip.file(path, xml);
  }
  const out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  writeFileSync(join(OUT, "pptx-gradient.pptx"), out);
  console.log(`pptx-gradient.pptx ${(out.length / 1024).toFixed(1)} KB`);
}

// pptx-table：表格
async function genPptxTable() {
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_16x9";
  const s = pptx.addSlide();
  s.background = { color: "FFFFFF" };
  s.addText("数据表 Data Table", { x: 0.5, y: 0.3, w: 9, h: 0.7, fontSize: 24, bold: true });
  const rows = [
    [{ text: "产品", options: { bold: true, color: "FFFFFF", fill: { color: "4472C4" } } }, { text: "销量", options: { bold: true, color: "FFFFFF", fill: { color: "4472C4" } } }, { text: "占比", options: { bold: true, color: "FFFFFF", fill: { color: "4472C4" } } }],
    ...Array.from({ length: 6 }, (_, i) => [
      { text: `产品-${i + 1}` },
      { text: `${1200 + i * 340}` },
      { text: `${(i + 1) * 7}%` },
    ]),
  ];
  s.addTable(rows, { x: 0.7, y: 1.3, w: 8.6, h: 3.0, border: { type: "solid", color: "999999" }, fontSize: 13 });
  await writePptx("pptx-table.pptx", pptx);
}

// pptx-43：4:3
async function genPptx43() {
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_4x3";
  const s = pptx.addSlide();
  s.background = { color: "FDEBD0" };
  s.addText("4:3 版式 Slide 1", { x: 0.5, y: 0.8, w: 7, h: 0.8, fontSize: 28, bold: true, color: "7F6000" });
  s.addText("传统宽高比 4:3 用于旧投影设备。", { x: 0.6, y: 2.0, w: 6.8, h: 1.0, fontSize: 16 });
  const s2 = pptx.addSlide();
  s2.background = { color: "FDEBD0" };
  s2.addText("4:3 版式 Slide 2", { x: 0.5, y: 0.8, w: 7, h: 0.8, fontSize: 28, bold: true, color: "7F6000" });
  await writePptx("pptx-43.pptx", pptx);
}

// pptx-long-24p：24 slides
async function genPptxLong() {
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_16x9";
  for (let i = 1; i <= 24; i++) {
    const s = pptx.addSlide();
    s.background = { color: i % 2 ? "F2F7FB" : "FFFFFF" };
    s.addText(`章节 ${i} — Section ${i}`, { x: 0.5, y: 0.4, w: 9, h: 0.8, fontSize: 28, bold: true, color: "1F4E79" });
    s.addText(
      Array.from({ length: 5 }, (_, k) => `要点 ${k + 1}：长文档渲染与懒加载 lazy render 验证`).join("\n"),
      { x: 0.7, y: 1.5, w: 8.6, h: 2.2, fontSize: 15, color: "333333" },
    );
    s.addShape(pptx.ShapeType.rect, { x: 7.0, y: 4.0, w: 2.4, h: 1.0, fill: { color: i % 2 ? "4472C4" : "ED7D31" } });
    s.addText(`Slide ${i} / 24`, { x: 0.5, y: 5.3, w: 9, h: 0.4, fontSize: 10, color: "888888" });
  }
  await writePptx("pptx-long-24p.pptx", pptx);
}

await genPptxSimple();
await genPptxMedia();
await genPptxZorder();
await genPptxGradient();
await genPptxTable();
await genPptx43();
await genPptxLong();
console.log("Wave 5D-3 PPTX fixtures 完成");
