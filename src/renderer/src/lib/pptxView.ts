/**
 * Wave 5D-3 — PPTX 视图纯逻辑（§88 / 1H spike：自研 OOXML slide 渲染器）
 *
 * 1H spike 冻结的 PPTX V1 = jszip 解包 + 文本提取预览；full-fidelity 渲染列入
 * Wave 5 重评。5D-3 即重评点：无成熟浏览器 PPTX 渲染库（spike 已调研），
 * 故自研 OOXML 解析 + HTML 渲染（slide 坐标系 = sldSz EMU → px @96dpi）。
 *
 * 纯逻辑无 DOM 依赖（jszip 可在 node 运行），可 node 直测。
 */

// ---------- XML lite parser（tokenizer，容错 well-formed OOXML） ----------

export interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const TAG_RE = /<(\/?)([A-Za-z0-9_:.-]+)((?:\s+[^<>]*?)?)(\/?)>/g;

/** 解析 XML 字符串为节点树（忽略注释/声明；实体解码） */
export function parseXmlLite(xml: string): XmlNode | null {
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(xml)) !== null) {
    const [full, closing, tag, attrsRaw, selfClose] = m;
    if (closing) {
      // 关闭标签前的文本归入父节点
      if (stack.length > 0) {
        stack[stack.length - 1].text += decodeXmlEntities(xml.slice(lastIndex, m.index));
      }
      const node = stack.pop();
      if (node && stack.length > 0) {
        stack[stack.length - 1].children.push(node);
      } else if (node && !root) {
        root = node;
      }
      lastIndex = TAG_RE.lastIndex;
      continue;
    }
    // 文本（上一个标签结束到当前标签开始）
    const textStart = lastIndex;
    const text = xml.slice(textStart, m.index);
    if (stack.length > 0 && text.trim()) {
      stack[stack.length - 1].text += decodeXmlEntities(text);
    }
    const attrs: Record<string, string> = {};
    const attrRe = /([A-Za-z0-9_:.-]+)="([^"]*)"/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(attrsRaw)) !== null) {
      attrs[am[1]!] = decodeXmlEntities(am[2]!);
    }
    const node: XmlNode = { tag, attrs, children: [], text: "" };
    if (selfClose) {
      if (stack.length > 0) stack[stack.length - 1].children.push(node);
      else if (!root) root = node;
    } else {
      stack.push(node);
    }
    lastIndex = TAG_RE.lastIndex;
  }
  // 收尾文本
  if (stack.length === 0 && root) {
    root.text += decodeXmlEntities(xml.slice(lastIndex));
  } else if (stack.length === 1 && !root) {
    root = stack[0];
  }
  return root;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** 按标签名找子节点（含命名空间前缀） */
export function findChild(node: XmlNode | null | undefined, tag: string): XmlNode | null {
  if (!node) return null;
  for (const child of node.children) {
    if (child.tag === tag) return child;
  }
  return null;
}

export function findChildBySuffix(node: XmlNode | null | undefined, suffix: string): XmlNode | null {
  if (!node) return null;
  for (const child of node.children) {
    if (child.tag.endsWith(suffix)) return child;
  }
  return null;
}

export function findDescendantBySuffix(node: XmlNode | null | undefined, suffix: string): XmlNode | null {
  if (!node) return null;
  for (const child of node.children) {
    if (child.tag.endsWith(suffix)) return child;
    const found = findDescendantBySuffix(child, suffix);
    if (found) return found;
  }
  return null;
}

export function childrenBySuffix(node: XmlNode | null | undefined, suffix: string): XmlNode[] {
  if (!node) return [];
  return node.children.filter((c) => c.tag.endsWith(suffix));
}

export function attrInt(attrs: Record<string, string>, key: string, def = 0): number {
  const v = attrs[key];
  return v === undefined ? def : parseInt(v, 10) || def;
}

// ---------- EMU / 单位 ----------

export const EMU_PER_INCH = 914400;
export const PX_PER_INCH = 96;

export function emuToPx(emu: number): number {
  return Math.round((emu * PX_PER_INCH) / EMU_PER_INCH);
}

export function emuToPxFloat(emu: number): number {
  return (emu * PX_PER_INCH) / EMU_PER_INCH;
}

/** 1/100 pt → px */
export function halfPointToPx(value: number): number {
  return value / 100;
}

/** 60000ths of a degree → degrees */
export function rotToDeg(rot: number): number {
  return rot / 60000;
}

// ---------- 模型 ----------

export type ShapeType = "text" | "image" | "table" | "shape" | "group" | "connector";

export interface FillStyle {
  type: "solid" | "gradient" | "none" | "blip";
  color?: string;
  /** gradient stops（16 进制 RGB） */
  colors?: string[];
  angle?: number;
  /** 透明度 0-100 */
  alpha?: number;
  /** blip 图片 media 路径 */
  mediaPath?: string;
}

export interface TextStyle {
  paragraphs: Array<{
    align?: string;
    runs: Array<{
      text: string;
      size?: number; // px
      bold?: boolean;
      italic?: boolean;
      color?: string;
      font?: string;
      underline?: boolean;
    }>;
  }>;
}

export interface TableModel {
  rows: number;
  cols: number;
  cells: Array<{
    text: string;
    fill?: string;
    bold?: boolean;
    color?: string;
    size?: number;
    colspan?: number;
    rowspan?: number;
  }>;
  colWidths?: number[]; // EMU
}

export interface ShapeModel {
  id: string;
  type: ShapeType;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 旋转（度） */
  rotation: number;
  zIndex: number;
  fill?: FillStyle;
  line?: { color?: string; width?: number };
  text?: TextStyle;
  image?: { mediaPath: string };
  table?: TableModel;
  children?: ShapeModel[];
  name?: string;
  hidden?: boolean;
  /** group 子坐标系（EMU） */
  chOff?: { x: number; y: number };
  chExt?: { x: number; y: number };
}

export interface SlideModel {
  index: number;
  name: string;
  width: number; // px
  height: number; // px
  background?: FillStyle;
  shapes: ShapeModel[];
  textAll: string;
}

export interface PptxModel {
  slides: SlideModel[];
  media: Map<string, Uint8Array>;
  /** slideIndex → rels media map */
  slideMedia: Array<Map<string, string>>;
}

export const DEFAULT_SLIDE_W = 960;
export const DEFAULT_SLIDE_H = 540;

/**
 * OOXML relationship Target → zip 内路径。
 * OfficeCLI 写包绝对路径 `/ppt/slides/slide1.xml`；PowerPoint/pptxgenjs 写相对路径 `slides/slide1.xml`。
 */
export function resolveRelTarget(target: string, baseDir: string): string {
  const normalized = target.trim().replace(/\\/g, "/");
  if (!normalized) return "";
  if (normalized.startsWith("/")) return normalized.replace(/^\/+/, "");
  if (normalized.startsWith("ppt/")) return normalized;
  const base = baseDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = [...(base ? base.split("/") : []), ...normalized.split("/")];
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

// ---------- OOXML 解析 ----------

/** 解析 pptx 字节为模型（jszip 解包 + slide XML 解析） */
export async function parsePptxModel(bytes: Uint8Array): Promise<PptxModel> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(bytes);

  const media = new Map<string, Uint8Array>();
  for (const [path, entry] of Object.entries(zip.files)) {
    if (path.startsWith("ppt/media/") && !entry.dir) {
      media.set(path, new Uint8Array(await entry.async("uint8array")));
    }
  }

  // presentation.xml：sldSz + sldIdLst 顺序
  const presXml = await zip.file("ppt/presentation.xml")?.async("string");
  const pres = presXml ? parseXmlLite(presXml) : null;
  const sldSz = findChildBySuffix(pres, "sldSz");
  const width = sldSz ? emuToPx(attrInt(sldSz.attrs, "cx", DEFAULT_SLIDE_W * EMU_PER_INCH / PX_PER_INCH)) : DEFAULT_SLIDE_W;
  const height = sldSz ? emuToPx(attrInt(sldSz.attrs, "cy", DEFAULT_SLIDE_H * EMU_PER_INCH / PX_PER_INCH)) : DEFAULT_SLIDE_H;

  const sldIdLst = findChildBySuffix(pres, "sldIdLst");
  const slideIds: string[] = [];
  if (sldIdLst) {
    for (const child of childrenBySuffix(sldIdLst, "sldId")) {
      const rid = child.attrs["r:id"] ?? child.attrs["id"];
      if (rid) slideIds.push(rid);
    }
  }
  // presentation.xml.rels → rId → slideN.xml
  const presRels = await zip.file("ppt/_rels/presentation.xml.rels")?.async("string");
  const relMap = new Map<string, string>();
  if (presRels) {
    const relsNode = parseXmlLite(presRels);
    for (const rel of childrenBySuffix(relsNode, "Relationship")) {
      const id = rel.attrs["Id"];
      const target = rel.attrs["Target"] ?? "";
      if (id && /slides\/slide\d+\.xml$/i.test(target)) relMap.set(id, resolveRelTarget(target, "ppt"));
    }
  }
  const slideFiles = slideIds
    .map((rid) => relMap.get(rid))
    .filter((p): p is string => typeof p === "string" && Boolean(zip.files[p]));
  if (slideFiles.length === 0) {
    // 关系路径对不上时按文件名扫（避免错误 Target 挡住兜底）
    for (const [path, entry] of Object.entries(zip.files)) {
      if (/ppt\/slides\/slide\d+\.xml$/i.test(path) && !entry.dir) slideFiles.push(path);
    }
    slideFiles.sort((a, b) => parseInt(/\d+/.exec(a)?.[0] ?? "0", 10) - parseInt(/\d+/.exec(b)?.[0] ?? "0", 10));
  }

  const slides: SlideModel[] = [];
  const slideMedia: Array<Map<string, string>> = [];
  for (let i = 0; i < slideFiles.length; i += 1) {
    const path = slideFiles[i]!;
    const xml = await zip.file(path)?.async("string");
    if (!xml) continue;
    const root = parseXmlLite(xml);
    // slide rels：rId → media 路径
    const relsPath = path.replace("ppt/slides/", "ppt/slides/_rels/") + ".rels";
    const relsXml = await zip.file(relsPath)?.async("string");
    const mediaRels = new Map<string, string>();
    if (relsXml) {
      const relsNode = parseXmlLite(relsXml);
      for (const rel of childrenBySuffix(relsNode, "Relationship")) {
        const target = rel.attrs["Target"] ?? "";
        if (/media\//.test(target) || /\.(png|jpg|jpeg|gif|webp|svg|emf|wmf)$/i.test(target)) {
          mediaRels.set(rel.attrs["Id"] ?? "", resolveRelTarget(target, "ppt/slides"));
        }
      }
    }
    slideMedia.push(mediaRels);

    const slide = parseSlide(root, i, width, height, mediaRels);
    slides.push(slide);
  }

  return { slides, media, slideMedia };
}

function parseSlide(root: XmlNode | null, index: number, width: number, height: number, mediaRels: Map<string, string>): SlideModel {
  const name = root?.attrs["name"] ?? `slide-${index + 1}`;
  let background: FillStyle | undefined;
  const bg = root ? findDescendantBySuffix(root, "bg") : null;
  if (bg) background = parseFill(findChildBySuffix(bg, "bgPr") ?? bg, mediaRels);

  const shapes: ShapeModel[] = [];
  const spTree = root ? findDescendantBySuffix(root, "spTree") : null;
  if (spTree) {
    let z = 0;
    for (const child of spTree.children) {
      const shape = parseShape(child, mediaRels, z);
      if (shape) {
        shapes.push(shape);
        z += 1;
      }
    }
  }

  const textAll = collectText(shapes);
  return { index, name, width, height, background, shapes, textAll };
}

function parseShape(node: XmlNode, mediaRels: Map<string, string>, zIndex: number): ShapeModel | null {
  const tag = node.tag;
  if (tag.endsWith(":sp")) return parseSp(node, mediaRels, zIndex);
  if (tag.endsWith(":pic")) return parsePic(node, mediaRels, zIndex);
  if (tag.endsWith(":graphicFrame")) return parseGraphicFrame(node, zIndex);
  if (tag.endsWith(":grpSp")) return parseGrpSp(node, mediaRels, zIndex);
  if (tag.endsWith(":cxnSp")) return parseCxnSp(node, mediaRels, zIndex);
  return null;
}

function parseXfrm(node: XmlNode | null): { x: number; y: number; w: number; h: number; rot: number } | null {
  const xfrm = node ? findChildBySuffix(node, "xfrm") : null;
  if (!xfrm) return null;
  const off = findChildBySuffix(xfrm, "off");
  const ext = findChildBySuffix(xfrm, "ext");
  if (!ext) return null;
  return {
    x: off ? emuToPx(attrInt(off.attrs, "x")) : 0,
    y: off ? emuToPx(attrInt(off.attrs, "y")) : 0,
    w: emuToPx(attrInt(ext.attrs, "cx")),
    h: emuToPx(attrInt(ext.attrs, "cy")),
    rot: rotToDeg(attrInt(xfrm.attrs, "rot")),
  };
}

function parseFill(node: XmlNode, mediaRels: Map<string, string>): FillStyle | undefined {
  const solid = findChildBySuffix(node, "solidFill");
  if (solid) {
    const color = parseColor(solid);
    const alpha = parseAlpha(solid);
    return { type: "solid", color, alpha };
  }
  const grad = findChildBySuffix(node, "gradFill");
  if (grad) {
    const gsLst = findChildBySuffix(grad, "gsLst");
    const colors: string[] = [];
    if (gsLst) {
      for (const gs of childrenBySuffix(gsLst, "gs")) {
        const c = parseColor(gs);
        if (c) colors.push(c);
      }
    }
    const lin = findChildBySuffix(grad, "lin");
    const angle = lin ? rotToDeg(attrInt(lin.attrs, "ang")) : undefined;
    return { type: "gradient", colors: colors.length > 0 ? colors : undefined, angle };
  }
  const blip = findChildBySuffix(node, "blipFill");
  if (blip) {
    const blipNode = findChildBySuffix(blip, "blip");
    const embed = blipNode?.attrs["r:embed"];
    if (embed && mediaRels.has(embed)) {
      return { type: "blip", mediaPath: mediaRels.get(embed) };
    }
  }
  const noFill = findChildBySuffix(node, "noFill");
  if (noFill) return { type: "none" };
  return undefined;
}

function parseColor(node: XmlNode): string | undefined {
  const srgb = findChildBySuffix(node, "srgbClr");
  if (srgb) return `#${srgb.attrs["val"]?.toLowerCase() ?? "000000"}`;
  const scheme = findChildBySuffix(node, "schemeClr");
  if (scheme) {
    const val = scheme.attrs["val"];
    const map: Record<string, string> = {
      tx1: "#000000",
      tx2: "#444444",
      bg1: "#ffffff",
      bg2: "#f2f2f2",
      accent1: "#4472c4",
      accent2: "#ed7d31",
      accent3: "#a5a5a5",
      accent4: "#ffc000",
      accent5: "#5b9bd5",
      accent6: "#70ad47",
      dk1: "#000000",
      dk2: "#44546a",
      lt1: "#ffffff",
      lt2: "#f2f2f2",
    };
    return map[val] ?? "#000000";
  }
  const sysClr = findChildBySuffix(node, "sysClr");
  if (sysClr) return `#${sysClr.attrs["lastClr"]?.toLowerCase() ?? "000000"}`;
  return undefined;
}

function parseAlpha(node: XmlNode): number | undefined {
  const alpha = findDescendantBySuffix(node, "alpha");
  if (!alpha) return undefined;
  return 100 - (attrInt(alpha.attrs, "val", 100000) / 1000);
}

function parseLine(node: XmlNode): { color?: string; width?: number } | undefined {
  const ln = findChildBySuffix(node, "ln");
  if (!ln) return undefined;
  const width = Math.max(0.5, emuToPxFloat(attrInt(ln.attrs, "w")) * (PX_PER_INCH / 96));
  const solid = findChildBySuffix(ln, "solidFill");
  const color = solid ? parseColor(solid) : undefined;
  return { color, width: width > 0 ? width : undefined };
}

function parseTextBody(node: XmlNode): TextStyle | undefined {
  const txBody = findChildBySuffix(node, "txBody");
  if (!txBody) return undefined;
  const paragraphs: TextStyle["paragraphs"] = [];
  for (const p of childrenBySuffix(txBody, "p")) {
    const pPr = findChildBySuffix(p, "pPr");
    const align = pPr?.attrs["algn"];
    const runs: TextStyle["paragraphs"][number]["runs"] = [];
    for (const child of p.children) {
      if (child.tag.endsWith(":r")) {
        const rPr = findChildBySuffix(child, "rPr");
        const t = findChildBySuffix(child, "t");
        if (!t) continue;
        const text = t.text;
        if (!text) continue;
        const sz = rPr ? attrInt(rPr.attrs, "sz", 1800) : 1800;
        const color = rPr ? parseColor(rPr) : undefined;
        const font = rPr?.attrs["latin"] ?? rPr?.attrs["ea"];
        runs.push({
          text,
          size: halfPointToPx(sz),
          bold: rPr?.attrs["b"] === "1",
          italic: rPr?.attrs["i"] === "1",
          underline: rPr?.attrs["u"] === "sng",
          color,
          font,
        });
      } else if (child.tag.endsWith(":br")) {
        runs.push({ text: "\n" });
      }
    }
    paragraphs.push({ align, runs });
  }
  return { paragraphs };
}

function parseSp(node: XmlNode, mediaRels: Map<string, string>, zIndex: number): ShapeModel | null {
  const spPr = findChildBySuffix(node, "spPr");
  const xfrm = spPr ? parseXfrm(spPr) : null;
  const fill = spPr ? parseFill(spPr, mediaRels) : undefined;
  const line = spPr ? parseLine(spPr) : undefined;
  const text = parseTextBody(node);
  const nvSpPr = findChildBySuffix(node, "nvSpPr");
  const cNvPr = nvSpPr ? findChildBySuffix(nvSpPr, "cNvPr") : null;
  const name = cNvPr?.attrs["name"];
  const hidden = cNvPr?.attrs["hidden"] === "1";
  return {
    id: cNvPr?.attrs["id"] ?? String(zIndex),
    type: "shape",
    x: xfrm?.x ?? 0,
    y: xfrm?.y ?? 0,
    w: xfrm?.w ?? 0,
    h: xfrm?.h ?? 0,
    rotation: xfrm?.rot ?? 0,
    zIndex,
    fill: fill ?? { type: "none" },
    line,
    text,
    name,
    hidden,
  };
}

function parsePic(node: XmlNode, mediaRels: Map<string, string>, zIndex: number): ShapeModel | null {
  const spPr = findChildBySuffix(node, "spPr");
  const xfrm = spPr ? parseXfrm(spPr) : null;
  const blipFill = findChildBySuffix(node, "blipFill") ?? findChildBySuffix(spPr ?? node, "blipFill");
  const blip = blipFill ? findChildBySuffix(blipFill, "blip") : null;
  const embed = blip?.attrs["r:embed"];
  const mediaPath = embed ? mediaRels.get(embed) : undefined;
  const cNvPr = findChildBySuffix(findChildBySuffix(node, "nvPicPr") ?? node, "cNvPr");
  return {
    id: cNvPr?.attrs["id"] ?? String(zIndex),
    type: "image",
    x: xfrm?.x ?? 0,
    y: xfrm?.y ?? 0,
    w: xfrm?.w ?? 0,
    h: xfrm?.h ?? 0,
    rotation: xfrm?.rot ?? 0,
    zIndex,
    fill: { type: "none" },
    image: mediaPath ? { mediaPath } : undefined,
    name: cNvPr?.attrs["name"],
  };
}

function parseGraphicFrame(node: XmlNode, zIndex: number): ShapeModel | null {
  const xfrm = parseXfrm(node);
  const graphic = findChildBySuffix(node, "graphic");
  const graphicData = graphic ? findChildBySuffix(graphic, "graphicData") : null;
  const tbl = graphicData ? findChildBySuffix(graphicData, "tbl") : null;
  if (!tbl) return null;
  const rows: Array<{
    cells: Array<{
      text: string;
      fill?: string;
      bold?: boolean;
      color?: string;
      size?: number;
      colspan?: number;
      rowspan?: number;
    }>;
  }> = [];
  for (const tr of childrenBySuffix(tbl, "tr")) {
    const cells: TableModel["cells"] = [];
    for (const tc of childrenBySuffix(tr, "tc")) {
      const tcPr = findChildBySuffix(tc, "tcPr");
      const fill = tcPr ? parseFill(tcPr, new Map()) : undefined;
      const text = collectTextNodes(tc);
      cells.push({
        text: text.trim(),
        fill: fill?.type === "solid" ? fill.color : undefined,
        bold: false,
        colspan: tcPr ? attrInt(tcPr.attrs, "gridSpan", 1) : 1,
        rowspan: tcPr ? attrInt(tcPr.attrs, "rowSpan", 1) : 1,
      });
    }
    rows.push({ cells });
  }
  const tblGrid = findChildBySuffix(tbl, "tblGrid");
  const colWidths = tblGrid ? childrenBySuffix(tblGrid, "gridCol").map((g) => attrInt(g.attrs, "w")) : undefined;
  return {
    id: String(zIndex),
    type: "table",
    x: xfrm?.x ?? 0,
    y: xfrm?.y ?? 0,
    w: xfrm?.w ?? 0,
    h: xfrm?.h ?? 0,
    rotation: xfrm?.rot ?? 0,
    zIndex,
    table: { rows: rows.length, cols: rows[0]?.cells.length ?? 0, cells: rows.flatMap((r) => r.cells), colWidths },
  };
}

function parseGrpSp(node: XmlNode, mediaRels: Map<string, string>, zIndex: number): ShapeModel | null {
  const grpSpPr = findChildBySuffix(node, "grpSpPr");
  const xfrm = grpSpPr ? parseXfrm(grpSpPr) : null;
  const chOff = grpSpPr ? findChildBySuffix(grpSpPr, "chOff") : null;
  const chExt = grpSpPr ? findChildBySuffix(grpSpPr, "chExt") : null;
  const children: ShapeModel[] = [];
  const spTree = findChildBySuffix(node, "spTree");
  if (spTree) {
    let z = 0;
    for (const child of spTree.children) {
      const shape = parseShape(child, mediaRels, z);
      if (shape) {
        children.push(shape);
        z += 1;
      }
    }
  }
  return {
    id: String(zIndex),
    type: "group",
    x: xfrm?.x ?? 0,
    y: xfrm?.y ?? 0,
    w: xfrm?.w ?? 0,
    h: xfrm?.h ?? 0,
    rotation: xfrm?.rot ?? 0,
    zIndex,
    children,
    chOff: chOff ? { x: attrInt(chOff.attrs, "x"), y: attrInt(chOff.attrs, "y") } : undefined,
    chExt: chExt ? { x: attrInt(chExt.attrs, "cx"), y: attrInt(chExt.attrs, "cy") } : undefined,
  };
}

function parseCxnSp(node: XmlNode, mediaRels: Map<string, string>, zIndex: number): ShapeModel | null {
  const spPr = findChildBySuffix(node, "spPr");
  const xfrm = spPr ? parseXfrm(spPr) : null;
  const line = spPr ? parseLine(spPr) : undefined;
  return {
    id: String(zIndex),
    type: "connector",
    x: xfrm?.x ?? 0,
    y: xfrm?.y ?? 0,
    w: xfrm?.w ?? 0,
    h: xfrm?.h ?? 0,
    rotation: xfrm?.rot ?? 0,
    zIndex,
    line,
    fill: { type: "none" },
  };
}

function collectTextNodes(node: XmlNode): string {
  let out = node.text ?? "";
  for (const child of node.children) out += collectTextNodes(child);
  return out;
}

function collectText(shapes: ShapeModel[]): string {
  let out = "";
  const walk = (s: ShapeModel): void => {
    if (s.text) {
      for (const p of s.text.paragraphs) {
        for (const r of p.runs) out += r.text + " ";
        out += "\n";
      }
    }
    if (s.children) for (const c of s.children) walk(c);
  };
  for (const s of shapes) walk(s);
  return out;
}

// ---------- 搜索 ----------

export interface SlideMatch {
  slideIndex: number;
  text: string;
}

export function searchSlides(slides: SlideModel[], query: string, limit = 100): { matches: SlideMatch[]; total: number } {
  if (!query) return { matches: [], total: 0 };
  const needle = query.toLowerCase();
  const matches: SlideMatch[] = [];
  let total = 0;
  for (let i = 0; i < slides.length; i += 1) {
    if (slides[i]!.textAll.toLowerCase().includes(needle)) {
      total += 1;
      if (matches.length < limit) matches.push({ slideIndex: i, text: slides[i]!.textAll.slice(0, 120) });
    }
  }
  return { matches, total };
}

// ---------- 生命周期统计 ----------

export const pptxViewerStats = {
  docs: 0,
  listeners: 0,
  observers: 0,
  /** 主区挂载中的 slide 数 */
  slidesLive: 0,
  /** 缩略图挂载数 */
  thumbsLive: 0,
};

export function resetPptxViewerStats(): void {
  pptxViewerStats.docs = 0;
  pptxViewerStats.listeners = 0;
  pptxViewerStats.observers = 0;
  pptxViewerStats.slidesLive = 0;
  pptxViewerStats.thumbsLive = 0;
}
