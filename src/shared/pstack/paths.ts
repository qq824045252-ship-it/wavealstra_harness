/** Portable lexical checks. Runtime also validates actual ancestors, file identity, and the task root. */
export function pstackDecisionLogPath(raw: unknown): string {
  if (typeof raw !== "string" || !/[^\\/]\.tsv$/i.test(raw)) {
    throw new Error("决定日志须为工作区内的相对 .tsv 文件，例如 .audit/decisions.tsv。");
  }
  return workspaceDocumentPath(raw, "决定日志");
}

export function workspaceDocumentPath(raw: string, label: string): string {
  const parts = raw.split(/[\\/]/);
  if (parts.some(part => !part || part === "." || part === ".." || /[. ]$|[\x00-\x1f:<>|?*"]/.test(part) ||
    /^(?:\.git|\.svn|\.hg)$/i.test(part) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) {
    throw new Error(label + "须使用工作区内的相对路径，包含无效的目录、文件名或路径字符。");
  }
  return parts.join("/");
}
