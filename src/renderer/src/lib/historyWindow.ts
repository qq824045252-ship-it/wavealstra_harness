import type { ChatMessage } from "@/types";

/**
 * 前插后要恢复的 scrollTop：内容在**上方**长高了 delta，scrollTop 同步加 delta，
 * 读者看到的正文才停在原处。delta <= 0（尚未布局完 / 内容反而变短）时保持原位。
 */
export function prependScrollTop(prevTop: number, prevScrollHeight: number, nextScrollHeight: number): number {
  const clamp = (value: number): number => Number.isFinite(value) ? Math.max(0, value) : 0;
  return clamp(prevTop) + Math.max(0, clamp(nextScrollHeight) - clamp(prevScrollHeight));
}

/**
 * 把历史块平铺到实时消息之前。
 *
 * 调用方保证 blocks 的顺序是「更旧的块在前」——分页只朝更早方向推进，
 * 新读取的块永远是最旧的一块，因此拼好后整条列表天然是时间正序。
 * 同 id 一律以实时窗口为准：实时行是同一 entry 的最新投影。
 */
export function mergeHistoryWindow(blocks: ChatMessage[][], live: ChatMessage[]): ChatMessage[] {
  const liveIds = new Set(live.map(message => message.id));
  const seen = new Set<string>();
  const merged: ChatMessage[] = [];
  for (const message of blocks.flat()) {
    if (liveIds.has(message.id) || seen.has(message.id)) continue;
    seen.add(message.id);
    merged.push(message);
  }
  for (const message of live) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    merged.push(message);
  }
  return merged;
}

/**
 * 本轮列表变化是否「纯前插」：新增行全部排在原首行之前，且原列表作为后缀原样保留。
 *
 * 只比较 id 序列，不看新增行的角色分布：更早历史块里本来就可能含用户消息，
 * 若要求「用户消息数不变」，前插会被误判成新回合、把读者的视口拉回底部。
 */
export function isPrependOnly(prevMessages: ChatMessage[], nextMessages: ChatMessage[]): boolean {
  const added = nextMessages.length - prevMessages.length;
  if (added <= 0 || prevMessages.length === 0) return false;
  return prevMessages.every((message, index) => message.id === nextMessages[added + index]?.id);
}
