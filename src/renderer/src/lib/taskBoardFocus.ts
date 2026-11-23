import type { BoardPage, TaskBoardRow } from "@shared/task-board";

/**
 * 每栏固定渲染 4 张卡片。这个数字必须与后端预览页大小一致
 * （TaskBoardRepository.preview 的 `size = q.preview ? 4 : …`），超过 4 行这里也拿不到。
 */
export const FOCUS_COLUMN_LIMIT = 4;

/** 「我的焦点」的分栏顺序。每栏都显示 4 张，多出来的用「被折叠」提示交代。 */
export const focusSections = [
  { view: "attention", limit: FOCUS_COLUMN_LIMIT },
  { view: "review", limit: FOCUS_COLUMN_LIMIT },
  { view: "running", limit: FOCUS_COLUMN_LIMIT },
  { view: "recent", limit: FOCUS_COLUMN_LIMIT },
  { view: "week", limit: FOCUS_COLUMN_LIMIT },
  { view: "results", limit: FOCUS_COLUMN_LIMIT },
  { view: "frequent", limit: FOCUS_COLUMN_LIMIT },
  { view: "automation", limit: FOCUS_COLUMN_LIMIT },
] as const;

export interface FocusSectionRows {
  rows: TaskBoardRow[];
  /** 本栏没有渲染出来的项：留待「查看全部」才可见。总数未知时为 0。 */
  folded: number;
  /** folded 是否就是准确总数；false 表示只能确定「还有更多」。 */
  exact: boolean;
  /** 是否还有没显示出来的项（含总数未知、只能确认取回页里还有后续的情况）。 */
  more: boolean;
}

/**
 * 按分栏上限裁剪预览行。每一栏只对自己命中的事项负责：同一个事项可以同时出现在
 * 「待审查的改动」和「正在执行」，这样栏目标题上的数字与渲染出的卡片数始终对得上。
 */
export function focusRows(pages: Array<BoardPage | undefined>): FocusSectionRows[] {
  return focusSections.map(({ limit }, index) => {
    const page = pages[index];
    const rows = (page?.rows ?? []).slice(0, limit);
    const remaining = page?.total == null ? 0 : Math.max(0, page.total - rows.length);
    const folded = Math.max((page?.rows.length ?? 0) - rows.length, remaining);
    return {
      rows,
      folded,
      exact: page?.total != null || !page?.next,
      more: folded > 0 || Boolean(page?.next),
    };
  });
}
