/** 历史提问索引与实时窗口的合并规则（历史弹窗列表用）。 */
export interface HistoryQuestion {
  id: string;
  text: string;
}

/**
 * 完整索引按时间升序返回（旧 → 新），实时窗口按时间倒序（新 → 旧）。
 * 合并后整体保持「最新在上」：索引里没有的窗口提问（尚未提交/刚落库）排最前，
 * 其余用完整索引倒序，并按 id 去重。
 * 索引未返回（null）时退回窗口列表，保证弹窗至少显示当前可见的提问。
 */
export function mergeHistoryQuestions(windowQuestions: HistoryQuestion[], index: HistoryQuestion[] | null): HistoryQuestion[] {
  if (!index) return windowQuestions;
  const known = new Set(index.map(question => question.id));
  return [...windowQuestions.filter(question => !known.has(question.id)), ...index.slice().reverse()];
}
