export function formatDuration(ms?: number): string | undefined {
  if (ms == null) return undefined;
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

export function relativeTime(ts: number, opts?: { compact?: boolean }): string {
  const diff = Date.now() - ts;
  const MIN = 60_000;
  // compact：去掉「前」字的短格式（侧栏任务行右侧标签），完整格式用于表格/tooltip
  const suffix = opts?.compact ? "" : "前";
  if (diff < MIN) return "刚刚";
  if (diff < 60 * MIN) return `${Math.floor(diff / MIN)}分钟${suffix}`;
  if (diff < 24 * 60 * MIN)
    return `${Math.floor(diff / (60 * MIN))}小时${suffix}`;
  return `${Math.floor(diff / (24 * 60 * MIN))}天${suffix}`;
}

export function clockTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function sizeLabel(content: string): string {
  // 未打开的 workspace-file 产物 content 为空（内容在 renderCache）；勿显示误导性的「0 B」
  if (!content) return "—";
  // data URI：按 base64 有效载荷估算真实字节，避免把整段 URI 当 UTF-8 文本量
  const dataUri = /^data:[^;]*;base64,([\s\S]+)$/i.exec(content);
  if (dataUri) {
    const b64 = dataUri[1]!.replace(/\s+/g, "");
    const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
    const bytes = Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  const bytes = new TextEncoder().encode(content).length;
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
