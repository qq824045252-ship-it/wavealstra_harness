/** 自动生成的任务标题上限（首条消息、Dots 委派等）：与侧栏任务名共用同一口径。 */
export const TASK_TITLE_MAX_CHARS = 24;

/** 超限截断并补省略号；未超限只去首尾空白。 */
export function limitTaskTitle(title: string, maxLen = TASK_TITLE_MAX_CHARS): string {
  const base = title.trim();
  if (base.length <= maxLen) return base;
  return `${base.slice(0, maxLen).trimEnd()}…`;
}
