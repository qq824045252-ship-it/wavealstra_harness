import { activityTimeOrUndefined } from "../../../../../shared/src/activity-time";

export function formatDuration(ms?: number): string | undefined {
  if (ms == null) return undefined;
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * 相对时间。
 *
 * 未知（缺失 / 0 / NaN / 非数值）必须渲染成「—」而不是算出来的天数：
 * 历史事故里 epoch 0 被显示为「20774 天」，让人去查格式化，而真正的问题在写入端。
 * 时间落在未来时（时钟偏差）与「刚刚」同属 diff < 1 分钟，自然归为「刚刚」。
 *
 * compact：去掉「前」字的短格式（侧栏任务行右侧标签），完整格式用于表格/tooltip。
 */
export function relativeTime(
  ts: number | null | undefined,
  opts?: { compact?: boolean },
): string {
  const at = activityTimeOrUndefined(ts);
  if (at === undefined) return "—";
  const suffix = opts?.compact ? "" : "前";
  const diff = Date.now() - at;
  if (diff < MINUTE_MS) return "刚刚";
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)}分钟${suffix}`;
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)}小时${suffix}`;
  return `${Math.floor(diff / DAY_MS)}天${suffix}`;
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
