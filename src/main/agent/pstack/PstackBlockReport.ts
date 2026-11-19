const oldPrefix = "pstack 工作流尚待继续。当前阻碍：";

/** Format only host-owned block notices. Backslashes in ordinary chat, code and file paths are data. */
export function formatPstackBlock(note: string): string {
  const sections: string[] = [];
  let fence = "";
  for (const line of note.trim().split(/\r?\n/)) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
    if (marker || fence) {
      sections.push(line);
      if (!fence && marker) fence = marker;
      else if (marker?.startsWith(fence)) fence = "";
      continue;
    }
    // Only repair a literal separator before a report heading or list item. For
    // example C:\new and a quoted regexp must remain byte-for-byte intact.
    const prose = line.split(/(`+[^`]*`+)/g).map((part, i) => i % 2 ? part : part.replace(
      /(?<![\w\\/])(?:\\r\\n|\\n)(?=(?:#{1,6}\s|[-*]\s|\d+[.)]\s*|[\p{Script=Han}][^：:\\`\n。]{0,28}[：:]))/gu, "\n",
    )).join("");
    for (const paragraph of prose.split("\n")) {
      const labeled = paragraph.match(/^([^\s#*>`\\][^：:\\`。；\n]{0,28})[：:]\s*(.*)$/u);
      if (labeled && /^(?:已完成|已验证|未验证|解除条件|恢复条件|具体证据|阻塞点|阻碍|原因|根因|下一步|需要确认|未授权的动作)/u.test(labeled[1])) {
        sections.push("", "### " + labeled[1], "");
        const items = labeled[2].split("；");
        if (items.length > 1 && !/[`\n]/.test(labeled[2]) && /^(?:已完成|已验证|解除条件|恢复条件)/u.test(labeled[1])) {
          sections.push(...items.map(item => item.trim()).filter(Boolean).map(item => "- " + item));
        } else if (labeled[2]) sections.push(labeled[2]);
      } else {
        sections.push(paragraph);
      }
    }
  }
  return "## 工作流暂停\n\n" + sections.join("\n").trim();
}

export function formatStoredPstackReply(text: string): string {
  return text.startsWith(oldPrefix) ? formatPstackBlock(text.slice(oldPrefix.length)) : text;
}
