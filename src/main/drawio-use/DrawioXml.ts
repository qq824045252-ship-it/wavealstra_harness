import { DOMParser, XMLSerializer, type Document, type Element } from "@xmldom/xmldom";
import { inflateRawSync } from "node:zlib";

export const DRAWIO_FILE_LIMIT = 32 * 1024 * 1024;

export function parseDrawioXml(xml: string): Document {
  if (Buffer.byteLength(xml) > DRAWIO_FILE_LIMIT) throw new Error("Draw.io XML 超过 32 MiB");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("Draw.io XML 不支持 DTD 或实体定义");
  return new DOMParser({ onError: (_level, detail) => { throw new Error("Draw.io XML 无效：" + detail); } })
    .parseFromString(xml, "text/xml");
}

export const drawioChildren = (parent: Element) => Array.from(parent.childNodes).filter((node): node is Element => node.nodeType === 1);
const children = drawioChildren;
export const serializeDrawioXml = (doc: Document | Element) => new XMLSerializer().serializeToString(doc);

export function readDrawioPages(xml: string) {
  const doc = parseDrawioXml(xml);
  const node = doc.documentElement;
  if (node?.tagName === "mxGraphModel") return { doc, pages: [{ id: null, name: "Page-1", node, model: node }] };
  if (node?.tagName !== "mxfile") throw new Error("需要 mxfile 或 mxGraphModel 格式的 Draw.io 图纸");
  let totalLength = 0;
  const pages = children(node).filter(page => page.tagName === "diagram").map(page => {
    let model = children(page).find(child => child.tagName === "mxGraphModel");
    if (!model) {
      const source = page.textContent?.trim();
      if (!source) throw new Error("Draw.io 页面缺少图形模型");
      const inflated = inflateRawSync(Buffer.from(source, "base64"), { maxOutputLength: DRAWIO_FILE_LIMIT - totalLength });
      totalLength += inflated.length;
      if (totalLength >= DRAWIO_FILE_LIMIT) throw new Error("Draw.io 页面解压后超过 32 MiB");
      model = parseDrawioXml(decodeURIComponent(inflated.toString("utf8"))).documentElement ?? undefined;
    }
    if (model?.tagName !== "mxGraphModel") throw new Error("Draw.io 页面缺少 mxGraphModel");
    return { id: page.getAttribute("id"), name: page.getAttribute("name"), node: page, model };
  });
  if (!pages.length) throw new Error("Draw.io 文件没有页面");
  return { doc, pages };
}

export function assertDrawioBytes(bytes: Buffer) {
  const { pages } = readDrawioPages(bytes.toString("utf8"));
  for (const { model } of pages) {
    const root = children(model).find(node => node.tagName === "root");
    if (!root || !children(root).length) throw new Error("Draw.io 页面缺少图元根节点");
  }
}

export const EMPTY_DRAWIO = '<mxGraphModel adaptiveColors="auto"><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';

export function readEmbeddedDrawioSvg(svg: string): string {
  // Read the SVG root attributes without parsing its external doctype or its rendered contents.
  const root = /<svg\b[^>]*>/.exec(svg)?.[0];
  if (!root) throw new Error("无效的 Draw.io SVG 文件");
  const xml = parseDrawioXml(root.replace(/\/?\s*>$/, "/>")).documentElement?.getAttribute("content");
  if (!xml) throw new Error("SVG 未嵌入 Draw.io 源图");
  return xml.startsWith("%3C") ? decodeURIComponent(xml) : xml;
}

export function drawioCells(model: Element) {
  const root = children(model).find(node => node.tagName === "root");
  if (!root) throw new Error("Draw.io 页面缺少图元根节点");
  return { root, cells: children(root).flatMap(node => {
    const cell = node.tagName === "mxCell" ? node : children(node).find(child => child.tagName === "mxCell");
    return cell ? [{ node, cell, id: node.getAttribute("id") || cell.getAttribute("id") }] : [];
  }) };
}

export type DrawioCellEdit =
  | { operation: "add"; xml: string }
  | { operation: "replace"; id: string; xml: string }
  | { operation: "remove"; id: string };

export function editDrawioPage(xml: string, page: number, edits: DrawioCellEdit[]): string {
  const { doc, pages } = readDrawioPages(xml);
  const selected = pages[page - 1];
  if (!selected) throw new Error("Draw.io 页码不存在");
  const { root, cells } = drawioCells(selected.model);
  const byId = new Map(cells.map(cell => [cell.id, cell.node]));
  for (const edit of edits) {
    if (edit.operation !== "add" && ["0", "1"].includes(edit.id)) throw new Error("不能修改图元根节点 0 或 1");
    const existing = edit.operation === "add" ? undefined : byId.get(edit.id);
    if (edit.operation !== "add" && !existing) throw new Error("找不到图元 " + edit.id);
    if (edit.operation === "remove") {
      root.removeChild(existing!);
      byId.delete(edit.id);
      continue;
    }
    const fragment = parseDrawioXml(edit.xml).documentElement;
    if (!fragment || (fragment.tagName !== "mxCell" && !children(fragment).some(child => child.tagName === "mxCell"))) {
      throw new Error("修改必须提供 mxCell 或包住 mxCell 的对象 XML");
    }
    const id = fragment.getAttribute("id") || children(fragment).find(child => child.tagName === "mxCell")?.getAttribute("id");
    if (!id || (edit.operation === "replace" ? id !== edit.id : byId.has(id))) throw new Error("图元 ID 必须唯一，替换时必须保持原 ID");
    const node = selected.model.ownerDocument!.importNode(fragment, true);
    if (existing) root.replaceChild(node, existing);
    else root.appendChild(node);
    byId.set(id, node);
  }
  for (const { id, cell } of drawioCells(selected.model).cells) {
    for (const key of ["parent", "source", "target"]) {
      const ref = cell.getAttribute(key);
      if (ref && !byId.has(ref)) throw new Error(`图元 ${id} 的 ${key} 引用了不存在的图元 ${ref}`);
    }
  }
  if (selected.node !== selected.model && selected.model.parentNode !== selected.node) {
    selected.node.textContent = "";
    selected.node.appendChild(doc.importNode(selected.model, true));
  }
  return serializeDrawioXml(doc);
}
