/** Scheduling hints only. The existing foreground turn still resolves intent,
 * target and authority; a high rank never amends/stops a Work by itself. */
export function botRequestPriority(text: string, referenced = false): number {
  if (referenced) return 2;
  const value = text.trim();
  if (/停止|取消|暂停|终止|改为|改成|改方向|不要再|不用再|(?:这轮|这次|当前|先|现在).{0,20}(?:只|改|不动|别动)|(?:只修|只改|仅处理|仅修复)|(?:所需|缺的|需要的).{0,16}(?:信息|资料|文件).{0,12}(?:补上|在这|如下)|\b(?:stop|cancel|pause|instead|only (?:fix|change|work)|do not|don't|here (?:is|are) (?:the|your) (?:missing|requested))\b/i.test(value)) return 2;
  if (/进度|状态|做到哪|安排|发现了什么|已经确定|先告诉|现在能|\b(?:status|progress|schedule)\b/i.test(value)) return 1;
  // Reserve one interactive slot for a short new question even without a card.
  // False positives only affect queue order, never business decisions.
  return value.length <= 160 && /[?？]|(?:什么|为何|为什么|多少|几点|天气|解释|查一下)|\b(?:what|when|why|how|weather)\b/i.test(value) ? 1 : 0;
}

/** Aging gives queued ordinary requests an opportunity under sustained controls. */
export const BOT_REQUEST_AGING_MS = 30_000;

export function botRequestQueueRank(priority: number, createdAt: number, now: number): number {
  return now - createdAt >= BOT_REQUEST_AGING_MS ? 3 : priority;
}

export function botRequestCapacity(priority: number): { conversation: number; global: number } {
  return priority >= 2 ? { conversation: 4, global: 10 }
    : priority === 1 ? { conversation: 4, global: 9 } : { conversation: 3, global: 8 };
}
