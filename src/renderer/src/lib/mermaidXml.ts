/** mermaid 在 foreignObject 里输出 HTML 标签，HTML 允许裸 `<br>`，SVG 图片按 XML 解析时不允许。
 * 这里只补齐 HTML 空元素的自闭合，不改结构、不改命名空间。
 * 单遍扫描而不是正则：属性里的引号要整体跳过，惰性正则在这种输入上会回溯到不可用。 */
const VOID_ELEMENTS = new Set(["br", "hr", "img", "input", "wbr", "col", "area", "base", "embed", "link", "meta", "param", "source", "track"]);
const TAG_NAME = /^<([a-zA-Z][\w:-]*)/;

export function closeVoidElements(svg: string): string {
  let out = "";
  let index = 0;
  while (index < svg.length) {
    const start = svg.indexOf("<", index);
    if (start < 0) return out + svg.slice(index);
    out += svg.slice(index, start);
    const tag = TAG_NAME.exec(svg.slice(start, start + 32));
    if (!tag || !VOID_ELEMENTS.has(tag[1]!.toLowerCase())) {
      out += "<";
      index = start + 1;
      continue;
    }
    let cursor = start + tag[0].length;
    let quote = "";
    for (; cursor < svg.length; cursor++) {
      const character = svg[cursor]!;
      if (quote) { if (character === quote) quote = ""; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === ">") break;
    }
    if (cursor >= svg.length) return out + svg.slice(start);
    const attributes = svg.slice(start + tag[0].length, cursor).replace(/\s*\/\s*$/, "");
    out += "<" + tag[1] + attributes + "/>";
    index = cursor + 1;
  }
  return out;
}

/** 交给 `<img>` 的 SVG 必须是合法 XML，否则解码静默失败、只剩 alt 文本。 */
export function isValidXml(svg: string): boolean {
  if (typeof DOMParser === "undefined") return true;
  try {
    return !new DOMParser().parseFromString(svg, "image/svg+xml").querySelector("parsererror");
  } catch {
    return false;
  }
}
