import { DOMParser, XMLSerializer, type Document, type Element } from "@xmldom/xmldom";
import JSZip from "jszip";
import { posix } from "node:path";
import type { OfficeKind } from "./OfficeFile";
import { Package, children, linkedRelation, office, one, relationPath, rels, requirePart, root, targetOf, type NamedElement } from "./OfficePackage";

const drawing = "http://schemas.openxmlformats.org/drawingml/2006/main";
const chart = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const presentation = "http://schemas.openxmlformats.org/presentationml/2006/main";
const types = "http://schemas.openxmlformats.org/package/2006/content-types";
const workbookType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

interface ChartShape { slide: number; name: string; geometry: number[]; part: string }
function sameChartFrame(source: ChartShape, candidate: ChartShape): boolean {
  return candidate.name === source.name &&
    candidate.geometry.every((value, index) => Math.abs(value - source.geometry[index]) <= 1000);
}

async function chartShapes(pkg: Package): Promise<ChartShape[]> {
  const part = "ppt/presentation.xml";
  const [body, links] = await Promise.all([pkg.xml(part), pkg.xml(relationPath(part))]);
  const slides = one(root(body, presentation, "presentation"), presentation, "sldIdLst");
  const shapes: ChartShape[] = [];
  const slideIds = children(slides, presentation, "sldId");
  for (const [slide, id] of slideIds.entries()) {
    const path = targetOf(linkedRelation(links, id.getAttributeNS(office, "id")), part, "slide", "ppt/slides");
    const document = root(await pkg.xml(path), presentation, "sld");
    let slideLinks: Document | undefined;
    for (const frame of Array.from(document.getElementsByTagNameNS(presentation, "graphicFrame"))) {
      const graphic = one(one(frame, drawing, "graphic"), drawing, "graphicData");
      if (graphic.getAttribute("uri") !== chart) continue;
      // Group transformations change the meaning of local geometry. Preserve only top-level chart frames.
      const parent = frame.parentNode as Element;
      if (parent.localName !== "spTree" || parent.namespaceURI !== presentation) continue;
      const name = one(one(frame, presentation, "nvGraphicFramePr"), presentation, "cNvPr").getAttribute("name");
      if (!name) continue;
      const transform = one(frame, presentation, "xfrm");
      const offset = one(transform, drawing, "off");
      const extent = one(transform, drawing, "ext");
      const coordinates = [offset.getAttribute("x"), offset.getAttribute("y"), extent.getAttribute("cx"), extent.getAttribute("cy")];
      if (!coordinates.every((item) => item && /^-?\d+$/.test(item) && Number.isSafeInteger(Number(item)))) continue;
      slideLinks ??= await pkg.xml(relationPath(path));
      const link = linkedRelation(slideLinks, one(graphic, chart, "chart").getAttributeNS(office, "id"));
      shapes.push({ slide, name, geometry: coordinates.map(Number), part: targetOf(link, path, "chart", "ppt/charts") });
    }
  }
  return shapes;
}

const cacheKinds: Record<string, string> = {
  strRef: "strCache", numRef: "numCache", multiLvlStrRef: "multiLvlStrCache",
};
const dataRoles = new Set(["tx", "cat", "val", "xVal", "yVal", "bubbleSize"]);
interface ChartReference { reference: NamedElement; formula: Element }
function chartData(document: Document): { signature: string; references: ChartReference[] } {
  const references: ChartReference[] = [];
  const plot = one(one(root(document, chart, "chartSpace"), chart, "chart"), chart, "plotArea");
  const charts = children(plot, chart).filter((kind) => children(kind, chart, "ser").length > 0);
  requirePart(charts.length > 0, "嵌入图表缺少可验证的系列缓存");
  const signature = charts.map((kind) => ({
    type: kind.localName,
    settings: ["barDir", "grouping", "scatterStyle", "radarStyle"].map((setting) =>
      children(kind, chart, setting)[0]?.getAttribute("val") ?? ""),
    series: children(kind, chart, "ser").map((series) => {
      const roles = children(series, chart).filter((field) => dataRoles.has(field.localName));
      requirePart(roles.length > 0 && new Set(roles.map((field) => field.localName)).size === roles.length,
        "无法验证图表系列引用");
      roles.sort((a, b) => a.localName.localeCompare(b.localName));
      return roles.map((field) => {
        const parts = children(field, chart);
        requirePart(parts.length === 1 && Object.hasOwn(cacheKinds, parts[0].localName),
          "图表使用暂不支持的内联或未知引用");
        const reference = parts[0];
        const formula = one(reference, chart, "f");
        const cache = one(reference, chart, cacheKinds[reference.localName]);
        const count = one(cache, chart, "ptCount").getAttribute("val");
        requirePart(count && /^\d+$/.test(count) && Number.isSafeInteger(Number(count)), "图表缓存长度无效");
        const multiLevel = reference.localName === "multiLvlStrRef";
        const numeric = reference.localName === "numRef";
        const levels = multiLevel ? children(cache, chart, "lvl") : [cache];
        requirePart(levels.length > 0, "图表多级分类缓存为空");
        const points = levels.map((level) => {
          const indices = new Set<number>();
          return children(level, chart, "pt").map((point) => {
            const index = point.getAttribute("idx");
            const position = Number(index);
            requirePart(index && /^\d+$/.test(index) && position < Number(count) && !indices.has(position),
              "图表缓存索引无效");
            indices.add(position);
            const value = one(point, chart, "v").textContent ?? "";
            if (numeric) requirePart(value.trim() && Number.isFinite(Number(value)), "图表缓存数值无法验证");
            return [position, numeric ? Number(value) : value] as const;
          }).sort((a, b) => a[0] - b[0]);
        });
        references.push({ reference, formula });
        return [field.localName, numeric, Number(count), points];
      });
    })
  }));
  const restoredFormulas = new Set(references.map(({ formula }) => formula));
  requirePart(Array.from(document.getElementsByTagNameNS(chart, "f")).every((formula) =>
    restoredFormulas.has(formula)), "图表包含暂不支持的工作簿公式引用");
  return { signature: JSON.stringify(signature), references };
}

const serializer = new XMLSerializer();
function serialize(document: Document): string { return serializer.serializeToString(document); }

async function repairDeck(original: Package, exported: Package, bytes: Buffer): Promise<Buffer> {
  const requiredCharts = new Set<string>();
  for (const path of original.entries.keys()) {
    const match = /^ppt\/charts\/_rels\/([^/]+\.xml)\.rels$/i.exec(path);
    if (!match) continue;
    const document = root(await original.xml(path), rels, "Relationships");
    const hasPackage = children(document, rels, "Relationship").some((link) =>
      link.getAttribute("Type") === office + "/package" && link.getAttribute("TargetMode") !== "External");
    if (hasPackage) requiredCharts.add("ppt/charts/" + match[1]);
  }
  if (!requiredCharts.size) return bytes;
  const [sourceShapes, targetShapes] = await Promise.all([chartShapes(original), chartShapes(exported)]);
  const changes = new Map<string, string | Buffer>();
  const matched = new Set<string>();
  const content = await exported.xml("[Content_Types].xml");
  const typeRoot = root(content, types, "Types");
  let updatedTypes = false;

  for (const source of sourceShapes) {
    if (!requiredCharts.delete(source.part)) continue;
    const sourceDoc = await original.xml(source.part);
    const sourceData = children(root(sourceDoc, chart, "chartSpace"), chart, "externalData");
    requirePart(sourceData.length === 1, "嵌入图表数据关系不唯一");
    const sourceLink = linkedRelation(await original.xml(relationPath(source.part)), sourceData[0].getAttributeNS(office, "id"));

    const workbook = targetOf(sourceLink, source.part, "package", "ppt/embeddings");
    requirePart(workbook.toLowerCase().endsWith(".xlsx"), "嵌入图表工作簿格式不受支持");
    const workbookBytes = await original.read(workbook, 40 * 1024 * 1024);
    const embedded = await Package.open(workbookBytes);
    try {
      requirePart(embedded.entries.has("[Content_Types].xml") && embedded.entries.has("xl/workbook.xml"),
        "嵌入图表工作簿 ZIP 内容缺少必要部件");
    } finally {
      embedded.zip.close();
    }
    const candidates = targetShapes.filter((target) => sameChartFrame(source, target));
    requirePart(sourceShapes.filter((shape) => shape.part === source.part || sameChartFrame(source, shape)).length === 1 &&
      candidates.length === 1 && candidates[0].slide === source.slide && !matched.has(candidates[0].part),
    "无法唯一对应嵌入图表所在幻灯片与形状");
    const target = candidates[0];
    matched.add(target.part);
    const targetDoc = await exported.xml(target.part);
    const before = chartData(sourceDoc);
    const after = chartData(targetDoc);
    requirePart(before.signature === after.signature, "图表系列或数据已变化，无法安全保留原嵌入工作簿");
    const targetRoot = root(targetDoc, chart, "chartSpace");
    const targetData = children(targetRoot, chart, "externalData");
    const relPath = relationPath(target.part);
    if (targetData.length) {
      requirePart(targetData.length === 1, "导出图表数据关系不唯一");
      const rel = linkedRelation(await exported.xml(relPath), targetData[0].getAttributeNS(office, "id"));
      const existing = targetOf(rel, target.part, "package", "ppt/embeddings");
      requirePart((await exported.read(existing, 40 * 1024 * 1024)).equals(workbookBytes) &&
        before.references.every(({ formula }, index) => formula.textContent === after.references[index].formula.textContent),
      "导出图表已使用不同工作簿或单元格引用");
      continue;
    }

    const addedWorkbook = changes.get(workbook);
    if (addedWorkbook || exported.entries.has(workbook)) {
      const existing = addedWorkbook ?? await exported.read(workbook, 40 * 1024 * 1024);
      requirePart(Buffer.isBuffer(existing) && existing.equals(workbookBytes), "嵌入工作簿部件名称发生冲突");
    } else {
      changes.set(workbook, workbookBytes);
    }

    const relations = exported.entries.has(relPath)
      ? await exported.xml(relPath)
      : new DOMParser().parseFromString('<Relationships xmlns="' + rels + '"/>', "application/xml");
    const relationsRoot = root(relations, rels, "Relationships");
    const relationId = sourceLink.getAttribute("Id");
    requirePart(!children(relationsRoot, rels, "Relationship").some((link) => link.getAttribute("Id") === relationId),
      "嵌入图表关系 ID 发生冲突");
    const restored = relations.importNode(sourceLink, true) as Element;
    restored.setAttribute("Target", posix.relative(posix.dirname(target.part), workbook));
    relationsRoot.appendChild(restored);
    changes.set(relPath, serialize(relations));

    for (const [index, { reference, formula }] of before.references.entries()) {
      requirePart(formula.textContent?.trim(), "嵌入图表源数据缺少工作簿单元格引用");
      const output = after.references[index];
      if (output.reference.localName === reference.localName) {
        output.formula.textContent = formula.textContent;
      } else {
        output.reference.parentNode?.replaceChild(targetDoc.importNode(reference, true), output.reference);
      }
    }
    const following = children(targetRoot, chart).find((element) => ["printSettings", "userShapes", "extLst"].includes(element.localName));
    targetRoot.insertBefore(targetDoc.importNode(sourceData[0], true), following ?? null);
    changes.set(target.part, serialize(targetDoc));

    const partName = "/" + workbook;
    const override = children(typeRoot, types, "Override").filter((element) => element.getAttribute("PartName") === partName);
    requirePart(override.length <= 1 && (!override.length || override[0].getAttribute("ContentType") === workbookType),
      "嵌入工作簿内容类型发生冲突");
    const defaultType = children(typeRoot, types, "Default").find((element) => element.getAttribute("Extension")?.toLowerCase() === "xlsx");
    if (!override.length && defaultType?.getAttribute("ContentType") !== workbookType) {
      const restoredType = content.createElementNS(types, "Override");
      restoredType.setAttribute("PartName", partName);
      restoredType.setAttribute("ContentType", workbookType);
      typeRoot.appendChild(restoredType);
      updatedTypes = true;
    }
  }
  requirePart(!requiredCharts.size, "无法定位某些嵌入数据图表所属的幻灯片");
  if (updatedTypes) changes.set("[Content_Types].xml", serialize(content));
  if (!changes.size) return bytes;
  const expandedSize = [...exported.entries.values()].reduce((total, entry) => total + entry.uncompressedSize, 0);
  requirePart(bytes.length <= 256 * 1024 * 1024 && expandedSize <= 512 * 1024 * 1024,
    "演示稿过大，无法安全重写嵌入图表数据");
  const archive = await JSZip.loadAsync(bytes);
  for (const [path, data] of changes) archive.file(path, data);
  return archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE", streamFiles: true });
}

export async function prepareOfficeRoundTrip(original: Buffer, exported: Buffer, kind: OfficeKind): Promise<Buffer> {
  if (kind !== "ppt") return exported;
  let source: Package | undefined;
  let target: Package | undefined;
  try {
    source = await Package.open(original);
    const hasEmbeddedWorkbook = [...source.entries.keys()].some((name) => /^ppt\/embeddings\/.+\.xls[xmb]?$/i.test(name));
    if (!hasEmbeddedWorkbook) return exported;
    target = await Package.open(exported);
    return await repairDeck(source, target, exported);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error("无法安全保存带嵌入图表工作簿的演示稿，原文件未覆盖。可另存副本。 " + detail);
  } finally {
    source?.zip.close();
    target?.zip.close();
  }
}
