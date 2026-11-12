/**
 * 「更早历史」窗口拼装（纯函数，无 React / DOM 依赖，便于单测）。
 *
 * 旧实现是整页替换：把一页更早历史当成新的时间轴，点「回到底部」才回实时窗口，
 * 视觉上等于把对话翻页。现在改为**前插**（append older blocks）：
 * 每页块只追加在实时窗口之前，时间轴始终是一条连续的线。
 *
 * 契约：服务端 RemoteTaskHistory.page = { historyId, before }，顶层 messages 就是该块；
 * 块的 historyId 必须与当前 durable.historyId 一致，否则说明会话被重建/切了分支，序号已重排。
 */
import type { RemoteHistoryMessage } from '@mybuddy/shared'

/**
 * 一页更早历史块。数组顺序是「旧 → 新」：下标 0 是最旧的一块（最后一个拉到的页），
 * 越往后越接近实时窗口，因此 flat() 得到的直接是时间正序，可以整段拼到实时窗口之前。
 */
export interface OlderHistoryBlock {
  taskId: string
  historyId: string
  messages: RemoteHistoryMessage[]
}

/**
 * 消息身份：服务端投影的消息 id 是 `durable-<entryId>`（见 DurableHistoryProjection），
 * 跨页唯一且稳定，因此可以拿它做前插去重。实时冒泡（remote-*）不在块里，不需要参与。
 */
function messageKey(message: RemoteHistoryMessage): string {
  return message.id
}

/**
 * 前插一页更早历史块，返回新数组（不改入参）。
 *
 * - historyId 不一致的旧块整组丢弃：会话换世代后 entryId 会重排，混进去就是错位的时间轴；
 * - 按消息 id 去重：同一页被重复请求、或相邻两页因为块内消息被过滤（context-import）而重叠时，
 *   都不会把同一条消息渲染两遍；
 * - 新块比现有所有块都更早，所以永远插到数组首部；数组因此保持「旧 → 新」，flat 即时间正序。
 *
 * 没有新消息时原样返回入参引用，调用方可以据此跳过整次重渲染与滚动补偿。
 */
export function appendOlderBlocks(
  blocks: OlderHistoryBlock[],
  incoming: OlderHistoryBlock,
): OlderHistoryBlock[] {
  const kept = blocks.filter((block) => block.historyId === incoming.historyId && block.messages.length > 0)
  const seen = new Set<string>()
  for (const block of kept) for (const message of block.messages) seen.add(messageKey(message))
  const messages: RemoteHistoryMessage[] = []
  for (const message of incoming.messages) {
    const key = messageKey(message)
    if (seen.has(key)) continue
    seen.add(key)
    messages.push(message)
  }
  if (messages.length === 0) return kept.length === blocks.length ? blocks : kept
  return [{ ...incoming, messages }, ...kept]
}

/**
 * 前插后要恢复的 scrollTop。
 *
 * `.chat-timeline` 显式 `overflow-anchor: none`（见 styles/app.css），浏览器不会替我们锚定；
 * 内容在**上方**长高了 delta，若 scrollTop 不动，读者看到的正文就会整体下移 delta。
 * 把 scrollTop 同样加 delta，视觉锚点才停在原处。delta <= 0（尚未布局完 / 内容反而变短）
 * 时保持原位，绝不主动往回拉。
 */
export function prependScrollTop(prevTop: number, prevScrollHeight: number, nextScrollHeight: number): number {
  if (!Number.isFinite(prevTop) || prevTop < 0) return 0
  const grown = Number.isFinite(prevScrollHeight) && Number.isFinite(nextScrollHeight)
    ? nextScrollHeight - prevScrollHeight
    : 0
  if (grown <= 0) return prevTop
  return prevTop + grown
}

/**
 * 首条消息是否真的换了人：只有「列表头变了」才说明这一轮发生的是前插，
 * 才允许执行滚动补偿。首条 id 缺失（空时间轴）或没变化（只是尾部追加）都不算前插。
 */
export function isPrependOnly(prevFirstId: string | undefined, nextFirstId: string | undefined): boolean {
  if (prevFirstId === undefined || nextFirstId === undefined) return false
  return prevFirstId !== nextFirstId
}
