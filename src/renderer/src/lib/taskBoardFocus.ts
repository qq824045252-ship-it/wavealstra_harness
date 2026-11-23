import type { BoardPage, TaskBoardRow } from "@shared/task-board";

/**
 * 「我的焦点」的分栏顺序与每栏最多渲染的卡片数。
 * 后端预览页大小固定为 4（TaskBoardRepository.preview），所以每栏最多也就拿到 4 行；
 * 这里超过 4 的数字不会再多取，只会反映「被折叠」的事实。
 */
export const focusSections = [
  { view: "attention", limit: 3 },
  { view: "review", limit: 2 },
  { view: "running", limit: 4 },
  { view: "recent", limit: 2 },
  { view: "week", limit: 1 },
  { view: "results", limit: 1 },
  { view: "frequent", limit: 1 },
  { view: "automation", limit: 1 },
] as const;

export interface FocusSectionRows {
  rows: TaskBoardRow[];
  /** 本栏没有渲染出来的项：留待「查看全部」才可见。 */
  folded: number;
  /** folded 是否就是准确总数；false 表示只能确定「还有更多」。 */
  exact: boolean;
  /** 命中本栏但已经在上方分栏渲染过的项，避免同一张卡出现两次。 */
  duplicated: number;
}

/**
 * 按分栏顺序裁剪预览行：同一事项只在前一个命中的分栏出现。
 * 折叠数 = 本栏总数 - 已渲染 - 已在上方分栏出现，因此不会把别处能看到的项算成「被折叠」。
 */
export function focusRows(pages: Array<BoardPage | undefined>): FocusSectionRows[] {
  const seen = new Set<string>();
  return focusSections.map(({ limit }, index) => {
    const page = pages[index];
    const rows: TaskBoardRow[] = [];
    let duplicated = 0;
    let truncated = 0;
    for (const row of page?.rows ?? []) {
      const key = row.jobId ? `job:${row.jobId}` : row.id;
      if (seen.has(key)) {
        duplicated += 1;
        continue;
      }
      if (rows.length === limit) {
        truncated += 1;
        continue;
      }
      seen.add(key);
      rows.push(row);
    }
    const remaining = page?.total == null ? 0 : Math.max(0, page.total - rows.length - duplicated);
    return {
      rows,
      folded: Math.max(truncated, remaining),
      exact: page?.total != null || !page?.next,
      duplicated,
    };
  });
}
