import { useEffect, useRef, useState, type TouchEvent as ReactTouchEvent, type WheelEvent as ReactWheelEvent } from 'react'
import { useRemoteStore } from '../store/remoteStore'
import { appendOlderBlocks, isPrependOnly, type OlderHistoryBlock } from './historyWindow'

/**
 * 一次性前插补偿现场：插入前的 scrollTop / scrollHeight，以及插入前时间轴首条消息 id。
 * App 在 useLayoutEffect 里把 scrollTop 换成 prependScrollTop(...)，读者视觉位置不动。
 */
export interface PrependAnchor {
  /** 插入前的 scrollTop */
  top: number
  /** 插入前的 scrollHeight */
  scrollHeight: number
  /** 插入前时间轴首条消息 id；undefined = 插入前是空时间轴 */
  prevFirstId?: string
  /** 插入前该首条消息在容器内的偏移：异步增高之后用它把视口拉回去 */
  prevFirstOffset: number
  /** 新块里所有消息 id：只有块真的上屏（首条变成块内消息）时才补偿 */
  blockIds: Set<string>
}

interface HistoryPaginationOptions {
  activeTaskId: string
  /** 当前实时窗口所属的持久会话世代（durable.historyId）；块响应 page.historyId 必须与它一致 */
  historyId: string | undefined
  /** 第一页更早历史的游标（实时窗口给出）；undefined = 没有更早历史可加载 */
  seedCursor: number | undefined
  timelineRef: { current: HTMLDivElement | null }
}

/** 距顶部剩余可滚动距离小于该值且用户继续上拉 = 请求更早一页 */
const EARLIER_EDGE_PX = 48
/** 惯性冷却：一次上拉手势会打出几十个 wheel/touch 事件 */
const GESTURE_COOLDOWN_MS = 250

function firstMessageId(element: HTMLElement): string | undefined {
  return element.querySelector<HTMLElement>('[data-message-id]')?.dataset.messageId
}

/**
 * 远程端「更早历史」分页：**前插**，不再整页替换。
 *
 * - 游标：第一页由实时窗口给出（seedCursor），之后严格取上一块响应的 `page.before`；
 * - 世代：响应的 `page.historyId` 必须与当前 durable.historyId 一致，不一致整块丢弃（重建/切分支后序号重排）；
 * - 请求串行：loadingEarlierRef 防重入，一页落地才有下一页游标；
 * - 滚动：不再把 scrollTop 归零。插入前记录现场，交给 App 的 useLayoutEffect 一次性补偿。
 */
export function useHistoryPagination(options: HistoryPaginationOptions) {
  const { activeTaskId, historyId, seedCursor, timelineRef } = options
  const [olderBlocks, setOlderBlocks] = useState<OlderHistoryBlock[]>([])
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  /** 与 olderBlocks 同步的镜像：手势回调里要读最新值，不能等 React 渲染 */
  const blocksRef = useRef<OlderHistoryBlock[]>([])
  const loadingEarlierRef = useRef(false)
  const gestureCooldownRef = useRef(0)
  const pendingAnchorRef = useRef<PrependAnchor | null>(null)
  const touchYRef = useRef(0)
  /** 已加载块的作废令牌：clear / 换任务 / 换世代 +1，飞行中的请求回来时据此丢弃 */
  const discardTokenRef = useRef(0)
  /**
   * 下一页游标。不能靠“数组首块的 before”推导：整页重复、最后一页为空时也要能前进/停下，
   * 否则会在同一位置反复请求同一页。primed=false 时才用实时窗口给的 seedCursor。
   */
  const cursorRef = useRef<number | undefined>(undefined)
  const cursorPrimedRef = useRef(false)
  /**
   * 作废边界：任务、世代、或实时窗口游标（seedCursor）变了都要丢掉已加载块。
   * seedCursor 变了说明实时窗口已前滚驱逐，块与窗口之间不再保证衔接（中间消息被逐出），
   * 继续拼下去就是静默缺消息；宁可重新从新游标加载。
   */
  const generationKey = `${activeTaskId}:${historyId ?? ''}:${seedCursor ?? ''}`

  const commitBlocks = (next: OlderHistoryBlock[]): void => {
    blocksRef.current = next
    setOlderBlocks(next)
  }

  // 换任务 / 换世代：累积块、游标与待补偿现场一起作废（游标随之回到 seedCursor）
  useEffect(() => {
    discardTokenRef.current += 1
    cursorPrimedRef.current = false
    cursorRef.current = undefined
    pendingAnchorRef.current = null
    if (!blocksRef.current.length) return
    blocksRef.current = []
    setOlderBlocks([])
  }, [generationKey])

  /** 下一页游标：还没拉过块时用实时窗口给的 seedCursor，之后取上一块响应的 page.before */
  const currentCursor = (): number | undefined => (cursorPrimedRef.current ? cursorRef.current : seedCursor)

  const loadEarlierPage = async (): Promise<void> => {
    if (loadingEarlierRef.current) return
    const target = currentCursor()
    if (target === undefined) return
    const client = useRemoteStore.getState().client
    if (!client) return
    const taskId = activeTaskId
    const element = timelineRef.current
    const token = discardTokenRef.current
    loadingEarlierRef.current = true
    // 上一块若因首条永远不匹配而留下现场，这里先作废：过期现场绝不能用于下一次渲染
    pendingAnchorRef.current = null
    setLoadingEarlier(true)
    try {
      const history = await client.history(taskId, target)
      // 请求飞行期间已经离开这个任务 / 点过「回到底部」：块属于旧的现场，丢弃
      if (discardTokenRef.current !== token || useRemoteStore.getState().activeTaskId !== taskId) return
      const page = history.page
      const liveHistoryId = useRemoteStore.getState().histories[taskId]?.durable?.historyId ?? historyId
      // 游标只认 page.before：没有 page = 服务端没按块返回（旧实现返回整段历史），拼进来就是重复
      if (!page) {
        console.warn('[remote] 更早历史响应缺少 page 元数据，已丢弃', taskId)
        return
      }
      if (liveHistoryId === undefined || page.historyId !== liveHistoryId) {
        console.warn('[remote] 更早历史块世代不一致，已丢弃', { pageHistoryId: page.historyId, liveHistoryId })
        return
      }
      const next = appendOlderBlocks(blocksRef.current, {
        taskId,
        historyId: page.historyId,
        messages: history.messages ?? [],
      })
      // 游标必须朝更早方向前进：服务端回同一条游标 = 已经到底（或分页坏了），停在这里别再重复请求
      cursorRef.current = page.before === target ? undefined : page.before
      cursorPrimedRef.current = true
      // 整页都是已有消息：不重渲染，也不预留补偿现场（但游标已经推进）
      if (next === blocksRef.current) return
      // 传的是同一页 DOM（没被卸载重建）时才记录滚动现场，否则补偿会打在新容器上
      const first = element && timelineRef.current === element
        ? element.querySelector<HTMLElement>('[data-message-id]')
        : null
      pendingAnchorRef.current = element && timelineRef.current === element
        ? {
            top: element.scrollTop,
            scrollHeight: element.scrollHeight,
            prevFirstId: first?.dataset.messageId,
            prevFirstOffset: first
              ? first.getBoundingClientRect().top - element.getBoundingClientRect().top
              : 0,
            blockIds: new Set(next[0].messages.map((message) => message.id)),
          }
        : null
      commitBlocks(next)
    } catch (error) {
      console.warn('[remote] 加载更早消息失败', error)
    } finally {
      loadingEarlierRef.current = false
      setLoadingEarlier(false)
    }
  }

  /** 回到实时窗口：丢弃全部更早块，游标回到第一页（下次上拉重新按页加载） */
  const clearOlderBlocks = (): void => {
    discardTokenRef.current += 1
    cursorPrimedRef.current = false
    cursorRef.current = undefined
    pendingAnchorRef.current = null
    if (!blocksRef.current.length) return
    commitBlocks([])
  }

  /**
   * 一次性取出前插补偿现场。只有「新块真的渲染到了时间轴最前面」时才返回并清空：
   * 流式 token 抢先触发的那一次 layout effect 不应该把补偿提前用掉。
   */
  const consumePrependAnchor = (nextFirstId: string | undefined): PrependAnchor | undefined => {
    const anchor = pendingAnchorRef.current
    if (!anchor) return undefined
    if (nextFirstId === undefined || !anchor.blockIds.has(nextFirstId)) return undefined
    pendingAnchorRef.current = null
    return isPrependOnly(anchor.prevFirstId, nextFirstId) ? anchor : undefined
  }

  /** 上拉手势的公共判定：还没到顶就不要打请求，游标没了也不要 */
  const maybeLoadEarlier = (): void => {
    const el = timelineRef.current
    if (!el) return
    // 距顶部剩余可滚动距离：< 48 说明窗口已经拉到最上面，继续上拉就是看更早的消息
    if (el.scrollTop >= EARLIER_EDGE_PX) return
    if (currentCursor() === undefined) return
    if (Date.now() < gestureCooldownRef.current) return
    gestureCooldownRef.current = Date.now() + GESTURE_COOLDOWN_MS
    void loadEarlierPage()
  }

  /** 滚轮（桌面浏览器 / 自动化）：deltaY < 0 = 向上拉 */
  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>): void => {
    if (event.deltaY >= 0) return
    maybeLoadEarlier()
  }

  /** 手机 WebView 没有 wheel 事件：把同一判定挂到触摸手势上 */
  const handleTouchStart = (event: ReactTouchEvent<HTMLDivElement>): void => {
    touchYRef.current = event.touches[0]?.clientY ?? 0
  }

  const handleTouchMove = (event: ReactTouchEvent<HTMLDivElement>): void => {
    const y = event.touches[0]?.clientY
    if (y === undefined) return
    const previous = touchYRef.current
    touchYRef.current = y
    // 手指向下拖 = 内容向上滚 = 用户在往更早的消息方向拉
    if (y <= previous) return
    maybeLoadEarlier()
  }

  return {
    /** 已加载的更早块（旧 → 新，flat 后直接拼在实时窗口之前） */
    olderBlocks,
    loadingEarlier,
    loadEarlierPage,
    handleWheel,
    handleTouchStart,
    handleTouchMove,
    consumePrependAnchor,
    clearOlderBlocks,
  }
}
