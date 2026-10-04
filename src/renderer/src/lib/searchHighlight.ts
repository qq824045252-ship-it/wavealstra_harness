/**
 * Wave 5D-1 — 搜索高亮（DOM 文本层标记，PDF/DOCX 复用）
 *
 * 从 pdfRuntime.ts 迁出的通用实现：累积文本节点偏移 → 对每个匹配区间
 * 跨节点切分并包 <mark>。区间有序不重叠；每次调用重建。
 */

export interface TextMatch {
  start: number;
  end: number;
}

const MARK_CLASS = "pdf-match";
const ACTIVE_CLASS = "pdf-match--active";

interface TextNodeEntry {
  node: Text;
  start: number;
  end: number;
}

/** 收集文本节点 + 累积偏移（快照，后续 splitText 用 splice 维护不变量） */
function collectTextNodes(container: HTMLElement): { entries: TextNodeEntry[]; total: number } {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const entries: TextNodeEntry[] = [];
  let offset = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue ?? "";
    if (text.length === 0) continue;
    entries.push({ node: node as Text, start: offset, end: offset + text.length });
    offset += text.length;
  }
  return { entries, total: offset };
}

/** 在容器内应用/更新匹配高亮（跨文本节点切分并包 <mark>）。返回标记数量。 */
export function applySearchHighlights(
  container: HTMLElement,
  ranges: TextMatch[],
  activeIndex: number,
): number {
  container.querySelectorAll(`mark.${MARK_CLASS}`).forEach((el) => el.remove());
  if (ranges.length === 0) return 0;

  const { entries, total } = collectTextNodes(container);
  if (total === 0) return 0;

  let marked = 0;
  let nodeIdx = 0;
  for (const range of ranges) {
    if (range.start >= total) break;
    while (nodeIdx < entries.length && entries[nodeIdx].end <= range.start) nodeIdx += 1;
    let cursor = range.start;
    let idx = nodeIdx;
    while (idx < entries.length && cursor < range.end) {
      const entry = entries[idx];
      const from = Math.max(cursor, entry.start);
      const to = Math.min(range.end, entry.end);
      if (to > from) {
        const node = entry.node;
        const relFrom = from - entry.start;
        const relTo = to - entry.start;
        const oldEnd = entry.end;
        const rest = node.splitText(relTo); // node=[0,relTo) rest=[relTo,..)
        const mid = node.splitText(relFrom); // node=[0,relFrom) mid=[relFrom,relTo)
        const parent = node.parentElement;
        if (parent) {
          const mark = document.createElement("mark");
          mark.className = MARK_CLASS + (marked === activeIndex ? ` ${ACTIVE_CLASS}` : "");
          parent.replaceChild(mark, mid);
          mark.appendChild(mid);
          marked += 1;
        }
        // 维护 entries 不变量：node 收窄、mid/rest 按序插入
        entry.end = from;
        entries.splice(idx + 1, 0, { node: mid, start: from, end: to });
        if (to < oldEnd) entries.splice(idx + 2, 0, { node: rest, start: to, end: oldEnd });
        idx += 2;
        cursor = to;
      } else {
        idx += 1;
      }
    }
  }
  return marked;
}

/** 移除全部高亮（还原文本节点） */
export function clearSearchHighlights(container: HTMLElement): void {
  container.querySelectorAll(`mark.${MARK_CLASS}`).forEach((el) => {
    const parent = el.parentElement;
    if (parent) {
      const text = document.createTextNode(el.textContent ?? "");
      parent.replaceChild(text, el);
    }
  });
}

/** 测试钩子：当前 mark 数 */
export function countSearchMarks(container: HTMLElement): number {
  return container.querySelectorAll(`mark.${MARK_CLASS}`).length;
}
