import type { RemoteImageArtifact } from '@mybuddy/shared'

/**
 * 图片 → 消息 的归属解析（纯函数，可单测）。
 *
 * 三种数据形态（live 消息 / durable 快照 / 缓存回填）里 message id 会互相不一致，
 * 但**工具调用 id 是稳定的**，所以按以下优先级判定，保证同一张图稳定落在同一条回复下面：
 *   1. createdByToolCallId → 工具调用所属消息（允许 `call_x/1`、`call_x:nested:bash:0` 变体）
 *   2. createdByMessageId 直接命中 assistant 消息 id
 *   3. 创建时刻：取 createdAt <= 图片创建时刻的最近一条 assistant
 *   4. durable 序号（旧服务端没有 createdAt 时的退化）：取 max(n) <= 图片序号的那条 assistant
 * 四条都不命中才返回 null（调用方放到末尾「其他图片」，不会凭空消失）。
 *
 * 不变量：**只返回 assistant 消息 id**。用户气泡不渲染图片，归属落在用户气泡上
 * 等于图片被静默丢掉（既不在消息里，也不在「其他图片」里）。
 *
 * 这里只依赖 shared 的**类型**，不导入任何运行时代码：远端组件测试用 esbuild 打包
 * 这个组件，一旦把 `@mybuddy/shared` 的桶导入进来，Node 侧就要跑无扩展名的
 * `./activity-time` 之类相对导入，直接 ERR_MODULE_NOT_FOUND。
 */
export interface ImageOwnerMessage {
  id: string
  role: 'user' | 'assistant'
  createdAt?: number
  tools?: ReadonlyArray<{ id: string }>
}

function toolBaseCallId(raw: string): string {
  const slash = raw.indexOf('/')
  return (slash > 0 ? raw.slice(0, slash) : raw).replace(/:nested:.*$/, '')
}

function durableOrdinal(id: string): number | null {
  const match = /^durable-(\d+)$/.exec(id)
  return match ? Number(match[1]) : null
}

/** 最后一条满足 `ordinal !== null && ordinal <= limit` 的 assistant 消息（保持时间轴顺序） */
function lastAssistantByOrdinal(messages: readonly ImageOwnerMessage[], limit: number): string | null {
  let best: { id: string; ordinal: number } | null = null
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    const ordinal = durableOrdinal(message.id)
    if (ordinal === null || ordinal > limit) continue
    if (!best || ordinal > best.ordinal) best = { id: message.id, ordinal }
  }
  return best?.id ?? null
}

/** 创建时刻 <= at 的最近一条 assistant 消息；同一毫秒取时间轴上靠后的那条 */
function lastAssistantByTime(messages: readonly ImageOwnerMessage[], at: number): string | null {
  let best: { id: string; createdAt: number } | null = null
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    const createdAt = message.createdAt
    if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt > at) continue
    if (!best || createdAt >= best.createdAt) best = { id: message.id, createdAt }
  }
  return best?.id ?? null
}

export function resolveImageOwnerId(image: RemoteImageArtifact, messages: readonly ImageOwnerMessage[]): string | null {
  const toolId = image.createdByToolCallId
  if (toolId) {
    const base = toolBaseCallId(toolId)
    const holder = messages.find(message => message.role === 'assistant'
      && (message.tools ?? []).some(tool => toolBaseCallId(tool.id) === base))
    if (holder) return holder.id
  }
  const byMessage = image.createdByMessageId
  if (byMessage && messages.some(message => message.id === byMessage && message.role === 'assistant')) return byMessage
  // 创建时刻比序号可靠：产物的 createdByMessageId 可能是用户 entry、也可能是本轮流式/工具身份
  // （`durable-live-*`、`durable-tool-*`）——回合落盘后行 id 换成 durable-<entryId>，旧身份就永久对不上。
  // 唯一可信的公共坐标是两个时刻：图片创建时刻落在哪条回复的写作区间里。
  const createdAt = image.createdAt
  if (typeof createdAt === 'number' && Number.isFinite(createdAt)) {
    const byTime = lastAssistantByTime(messages, createdAt)
    if (byTime) return byTime
  }
  // 旧电脑端不传 createdAt：只能退化为 durable 序号「最近的前一条 assistant」
  const target = byMessage ? durableOrdinal(byMessage) : null
  if (target !== null) return lastAssistantByOrdinal(messages, target)
  return null
}