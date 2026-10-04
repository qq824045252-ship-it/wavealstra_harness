import { parse, parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, unlinkSync, realpathSync, statSync } from "node:fs";
import type { HtmlEditNode, HtmlEditPatch } from "../../shared/html-edit";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const inline = new Set("a b strong i em u s strike span font br sub sup code".split(" "));
const blocks = new Set("p h1 h2 h3 h4 h5 h6 div li td th caption blockquote label span".split(" "));
const css = new Set(["color", "background-color", "font-size", "font-weight", "font-style", "text-decoration", "text-align"]);
function isElement(n: Node): n is Element { return "tagName" in n; }
function descendants(n: Node): Element[] {
  return "childNodes" in n ? n.childNodes.flatMap(c => isElement(c) ? [c, ...descendants(c)] : []) : [];
}
function safeUrl(value: string): boolean {
  const v = value.trim().replace(/[\u0000-\u0020]/g, "");
  return !/^[a-z][a-z\d+.-]*:/i.test(v) || /^(https?:|mailto:|tel:)/i.test(v);
}
function validateInline(html: string): void {
  if (typeof html !== "string" || html.length > 30000) throw new Error("编辑内容过大");
  const fragment = parseFragment(html);
  for (const el of descendants(fragment)) {
    if (!inline.has(el.tagName) || el.namespaceURI !== "http://www.w3.org/1999/xhtml") throw new Error("仅支持文字与行内格式，不能插入脚本或结构组件");
    for (const attr of el.attrs) {
      if (["id", "class", "title", "color", "face", "size"].includes(attr.name) || attr.name.startsWith("data-")) continue;
      if (attr.name === "href" && el.tagName === "a" && safeUrl(attr.value)) continue;
      if (attr.name === "style" && attr.value.split(";").every(decl => {
        if (!decl.trim()) return true;
        const i = decl.indexOf(":");
        return css.has(decl.slice(0, i).trim().toLowerCase()) && /^[\w\s#.,%()\-]+$/.test(decl.slice(i + 1)) && !/url|expression|var\s*\(/i.test(decl);
      })) continue;
      throw new Error(`不支持的行内属性：${attr.name}`);
    }
  }
}
export function htmlHash(source: string): string { return createHash("sha256").update(source).digest("hex"); }

/** Source offsets are from the original UTF-8 file, never from the running page. */
export class HtmlSource {
  readonly nodes: HtmlEditNode[] = [];
  private ranges = new Map<string, { start: number; innerStart: number; innerEnd: number; end: number; style?: { startOffset: number; endOffset: number }; originalStyle: string; ids: string[] }>();
  constructor(readonly source: string) {
    if (Buffer.byteLength(source) > 4 * 1024 * 1024 || source.includes("\uFFFD") || /<meta[^>]+charset\s*=\s*["']?(?!utf-?8\b)[\w-]+/i.test(source)) throw new Error("仅支持 4 MB 以内的 UTF-8 HTML");
    const doc = parse(source, { sourceCodeLocationInfo: true });
    const visit = (parent: Node, path: string): void => {
      if (!("childNodes" in parent)) return;
      let index = 0;
      for (const child of parent.childNodes) {
        if (!isElement(child)) continue;
        index++;
        const selector = path ? `${path} > ${child.tagName}:nth-child(${index})` : child.tagName;
        const loc = child.sourceCodeLocation;
        const inner = loc?.startTag && loc?.endTag ? source.slice(loc.startTag.endOffset, loc.endTag.startOffset) : "";
        const children = descendants(child);
        let safe = blocks.has(child.tagName) && !!inner.trim() && inner.length <= 20000 && children.every(el => inline.has(el.tagName));
        try { validateInline(inner); } catch { safe = false; }
        if (safe && loc?.startTag && loc.endTag) {
          const key = String(this.nodes.length);
          const ids = children.flatMap(el => el.attrs.filter(a => a.name === "id").map(a => a.value)).sort();
          const deletable = ["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "span"].includes(child.tagName) && !ids.length && !child.attrs.some(a => a.name === "id" || a.name.startsWith("on") || a.name.startsWith("data-"));
          this.nodes.push({ key, selector, html: inner, deletable });
          this.ranges.set(key, { start: loc.startOffset, innerStart: loc.startTag.endOffset, innerEnd: loc.endTag.startOffset, end: loc.endOffset, style: loc.attrs?.style, originalStyle: child.attrs.find(a => a.name === "style")?.value ?? "", ids });
        } else if (!["script", "style", "template", "svg", "head", "select", "button", "textarea"].includes(child.tagName)) visit(child, selector);
      }
    };
    visit(doc, "");
  }

  apply(patches: HtmlEditPatch[]): string {
    if (!Array.isArray(patches) || patches.length > this.nodes.length) throw new Error("无效的编辑补丁");
    const edits: { start: number; end: number; text: string }[] = [];
    const seen = new Set<string>();
    for (const patch of patches) {
      const range = this.ranges.get(patch.key), node = this.nodes.find(n => n.key === patch.key);
      if (!range || !node || seen.has(patch.key)) throw new Error("编辑节点已失效");
      seen.add(patch.key);
      if (patch.deleted) {
        if (!node.deletable) throw new Error("该节点包含标识或结构关系，不能直接删除");
        edits.push({ start: range.start, end: range.end, text: "" }); continue;
      }
      validateInline(patch.html);
      const ids = descendants(parseFragment(patch.html)).flatMap(el => el.attrs.filter(a => a.name === "id").map(a => a.value)).sort();
      if (JSON.stringify(ids) !== JSON.stringify(range.ids)) throw new Error("不能移除或改变文案中的元素 ID");
      edits.push({ start: range.innerStart, end: range.innerEnd, text: patch.html });
      if (patch.align) {
        if (!["left", "center", "right", "justify"].includes(patch.align)) throw new Error("无效对齐方式");
        const value = `${range.originalStyle.replace(/;?\s*text-align\s*:[^;]*/gi, "")};text-align:${patch.align}`.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
        edits.push(range.style ? { start: range.style.startOffset, end: range.style.endOffset, text: `style="${value}"` } : { start: range.innerStart - 1, end: range.innerStart - 1, text: ` style="${value}"` });
      }
    }
    let result = this.source;
    for (const e of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, e.start) + e.text + result.slice(e.end);
    return result;
  }
}

/** Synchronous compare/write avoids interleaving saves from our two surfaces. */
export function saveHtmlFile(path: string, expected: string, next: string): string {
  const canonical = realpathSync(path);
  if (statSync(canonical).size > 4 * 1024 * 1024 || htmlHash(readFileSync(canonical, "utf8")) !== expected) throw new Error("源文件已被修改，未覆盖。请保留草稿并重新打开后合并。");
  const backup = `${canonical}.bak_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const temporary = `${canonical}.mybuddy-edit-${randomUUID()}.tmp`;
  writeFileSync(backup, readFileSync(canonical), { flag: "wx" });
  try {
    writeFileSync(temporary, next, { encoding: "utf8", flag: "wx" });
    if (htmlHash(readFileSync(canonical, "utf8")) !== expected) throw new Error("保存期间源文件发生变化，未覆盖");
    renameSync(temporary, canonical);
  } finally { try { unlinkSync(temporary); } catch { /* already renamed */ } }
  return backup;
}
