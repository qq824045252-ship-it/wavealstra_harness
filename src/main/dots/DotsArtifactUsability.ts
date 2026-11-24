import { lstat } from "node:fs/promises";
import { basename, dirname, extname } from "node:path";
import type { Element } from "@xmldom/xmldom";
import { readOfficeEvidenceFile } from "../office-use/OfficeEvidenceFile";
import { Package, children, linkedRelation, office, one, rels, requirePart, root, targetOf } from "../office-use/OfficePackage";

const spreadsheet = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const word = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const ppt = "http://schemas.openxmlformats.org/presentationml/2006/main";
const contentTypes = "http://schemas.openxmlformats.org/package/2006/content-types";
const workbook = "xl/workbook.xml";

function richText(element: Element) {
  return [...children(element, spreadsheet, "t"),
    ...children(element, spreadsheet, "r").flatMap(run => children(run, spreadsheet, "t"))]
    .map(text => text.textContent ?? "").join("");
}

type WorksheetRequirement = { sheet?: string; headers?: readonly string[] };

async function validateWorkbook(bytes: Buffer, requirements: readonly WorksheetRequirement[], allowEmpty: boolean) {
  const archive = await Package.open(bytes);
  try {
    root(await archive.xml("[Content_Types].xml"), contentTypes, "Types");
    const book = root(await archive.xml(workbook), spreadsheet, "workbook");
    const links = await archive.xml("xl/_rels/workbook.xml.rels");
    const worksheets = children(one(book, spreadsheet, "sheets"), spreadsheet, "sheet")
      .map(entry => ({ name: entry.getAttribute("name"), link: linkedRelation(links, entry.getAttributeNS(office, "id")) }))
      .filter(({ link }) => link.getAttribute("Type") === office + "/worksheet");
    const strings = requirements.some(({ headers }) => headers?.length) ? children(root(links, rels, "Relationships"), rels, "Relationship")
      .find(link => link.getAttribute("Type") === office + "/sharedStrings") : undefined;
    const shared = strings ? children(root(await archive.xml(targetOf(strings, workbook, "sharedStrings", "xl")),
      spreadsheet, "sst"), spreadsheet, "si") : [];
    const sheetData = new Map<Element, Element>();
    for (const { sheet, headers = [] } of requirements.length ? requirements : [{}]) {
      const requested = worksheets.filter(item => !sheet || item.name === sheet);
      requirePart(requested.length > 0, sheet ? "找不到指定工作表「" + sheet + "」" : "工作簿没有可打开的工作表");
      let matched = false;
      for (const { link } of requested) {
        let data = sheetData.get(link);
        if (!data) {
          const xml = root(await archive.xml(targetOf(link, workbook, "worksheet", "xl")), spreadsheet, "worksheet");
          data = one(xml, spreadsheet, "sheetData");
          sheetData.set(link, data);
        }
        const rows = children(data, spreadsheet, "row");
        matched = !headers.length ? allowEmpty || rows.some(row => children(row, spreadsheet, "c").some(cell =>
          children(cell, spreadsheet, "v").some(value => Boolean(value.textContent?.trim())) ||
          children(cell, spreadsheet, "f").some(formula => Boolean(formula.textContent?.trim())) ||
          children(cell, spreadsheet, "is").some(inline => Boolean(richText(inline).trim()))))
          : rows.slice(0, 30).some(row => {
          const values = new Set(children(row, spreadsheet, "c").map(cell => {
            const value = children(cell, spreadsheet, "v")[0]?.textContent ?? "";
            if (cell.getAttribute("t") === "s") {
              const text = /^\d+$/u.test(value) ? shared[Number(value)] : undefined;
              return text ? richText(text).trim() : "";
            }
            const inline = children(cell, spreadsheet, "is")[0];
            return (inline ? richText(inline) : value).trim();
          }));
          return headers.every(header => values.has(header));
        });
        if (matched) break;
      }
      requirePart(matched, headers.length ? "工作表缺少要求的表头：" + headers.join("、") : "工作表没有内容");
    }
  } finally {
    archive.zip.close();
  }
}

async function validateOfficeDocument(bytes: Buffer, format: ".docx" | ".pptx") {
  const archive = await Package.open(bytes);
  try {
    root(await archive.xml("[Content_Types].xml"), contentTypes, "Types");
    if (format === ".docx") {
      one(root(await archive.xml("word/document.xml"), word, "document"), word, "body");
      return;
    }
    const part = "ppt/presentation.xml";
    const presentation = root(await archive.xml(part), ppt, "presentation");
    const slides = children(presentation, ppt, "sldIdLst").flatMap(list => children(list, ppt, "sldId"));
    if (!slides.length) return;
    const links = await archive.xml("ppt/_rels/presentation.xml.rels");
    const firstSlide = linkedRelation(links, slides[0].getAttributeNS(office, "id"));
    root(await archive.xml(targetOf(firstSlide, part, "slide", "ppt/slides")), ppt, "sld");
  } finally {
    archive.zip.close();
  }
}

/** Check the saved version used for delivery. Never inspect the mutable source file. */
export async function checkDotsDeliveryFile(path: string, name: string, requirements: readonly WorksheetRequirement[], allowEmpty = false): Promise<string | undefined> {
  const stat = await lstat(path).catch(() => undefined);
  if (!stat?.isFile() || !stat.size) return "快照不是非空的普通文件";
  const format = extname(name).toLowerCase();
  if (format !== ".xlsx" && format !== ".docx" && format !== ".pptx") return;
  try {
    const saved = await readOfficeEvidenceFile(dirname(path), path, format);
    const recordedDigest = /^([a-f0-9]{64})\.[a-z0-9]+$/u.exec(basename(path))?.[1];
    if (recordedDigest && recordedDigest !== saved.sha256) return "快照内容与登记版本不一致";
    if (format === ".xlsx") await validateWorkbook(saved.bytes, requirements, allowEmpty);
    else await validateOfficeDocument(saved.bytes, format);
  } catch (error) {
    const label = format === ".xlsx" ? "工作簿" : format === ".docx" ? "Word 文档" : "PowerPoint 文稿";
    return "无法核验" + label + (error instanceof Error ? "（" + error.message + "）" : "");
  }
}
