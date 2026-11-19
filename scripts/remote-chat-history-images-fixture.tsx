/**
 * 安卓端「聊天页」真实组件夹具：挂载真实 App（ChatPage / RemoteMarkdown / RemoteImages），
 * 用一个确定性的内存客户端替掉 HTTP，用来在 offscreen Electron 里复现两类现场：
 *
 *   1. 上拉加载更早历史（真实 wheel/touch 事件 → useHistoryPagination → 前插补偿）
 *   2. 图片归属与「查看原图」（真实 resolveImageOwnerId / RemoteImageArtifactLink / blob 流）
 *
 * 只用于 scripts/remote-chat-history-images-test.cjs。
 */
import { createRoot } from 'react-dom/client'
import { App } from '../app/remote/src/App'
import { useRemoteStore } from '../app/remote/src/store/remoteStore'
import type {
  RemoteBootstrap, RemoteHistoryMessage, RemoteImageArtifact, RemoteTaskHistory, RemoteTaskSummary,
} from '@mybuddy/shared'
import '../app/remote/src/styles/app.css'

const TASK_ID = 't-chat'
const HISTORY_ID = 'history-fixture'
const NOW = 1_760_000_000_000

/** 会话共 50 轮（entry 1..100，user=2i-1 / assistant=2i）。
 *  实时窗口 = 最后 3 轮（durable-95..durable-100），seed 游标 = 94；
 *  第一页 = entry 45..94（durable-45..durable-94），下一页游标 44；
 *  第二页 = entry 1..44，到最老。 */
const WINDOW_FROM = 95
const SEED = 94
const PAGE1_BEFORE = 44

const calls: string[] = []

function text(id: number): string {
  return `MESSAGE_${id}`
}

function turnMessages(from: number, to: number): RemoteHistoryMessage[] {
  const rows: RemoteHistoryMessage[] = []
  for (let entry = from; entry <= to; entry++) {
    const role = entry % 2 === 1 ? 'user' as const : 'assistant' as const
    const row: RemoteHistoryMessage = { id: `durable-${entry}`, role, text: text(entry), createdAt: NOW + entry * 1000 }
    // 图片挂在这条 assistant 的工具调用上（真实服务端的 createdByToolCallId）
    if (entry === 98) row.tools = [{ id: 'call_shot', tool: 'browser_exec', summary: 'screenshot', status: 'success' }]
    rows.push(row)
  }
  return rows
}

function images(): RemoteImageArtifact[] {
  return [
    // 1) 工具产物：挂在实时窗口 durable-98 的 call_shot 上，正文里用绝对路径引用
    { id: 'art-shot', name: 'shot.png', kind: 'image', version: 1, mimeType: 'image/png', createdAt: NOW + 98_200,
      sources: ['C:\\tasks\\' + TASK_ID + '\\artifacts\\shot.png'], createdByToolCallId: 'call_shot', createdByMessageId: 'durable-98' },
    // 2) 只在更早历史块里的图：createdByMessageId 直接指向 durable-60（第一页）
    { id: 'art-old', name: 'old.png', kind: 'image', version: 1, mimeType: 'image/png', createdAt: NOW - 1_000,
      sources: ['C:\\tasks\\' + TASK_ID + '\\artifacts\\old.png'], createdByMessageId: 'durable-60' },
    // 3) 归属落在 user 消息上的图：用户气泡不渲染图片，不能就此消失
    { id: 'art-user', name: 'user.png', kind: 'image', version: 1, mimeType: 'image/png', createdAt: NOW + 98_550,
      sources: ['C:\\tasks\\' + TASK_ID + '\\artifacts\\user.png'], createdByMessageId: 'durable-97' },
    // 4) 流式身份落盘：产物存的是 durable-live-*，回合结束后行变成了 durable-<entryId>
    { id: 'art-live', name: 'live.png', kind: 'image', version: 1, mimeType: 'image/png', createdAt: NOW + 98_800,
      sources: ['C:\\tasks\\' + TASK_ID + '\\artifacts\\live.png'], createdByMessageId: 'durable-live-' + TASK_ID },
  ]
}

function windowHistory(): RemoteTaskHistory {
  const messages = turnMessages(WINDOW_FROM, 100)
  const withText = messages.map(message => message.id === 'durable-98'
    ? { ...message, text: '截图如下 ![shot](C:\\tasks\\' + TASK_ID + '\\artifacts\\shot.png)' }
    : message)
  return {
    taskId: TASK_ID,
    messages: withText,
    imageArtifacts: images(),
    durable: {
      backend: 'pi-durable', epoch: 'epoch-fixture', historyId: HISTORY_ID, revision: 7,
      conversationId: 'conv-fixture', toolMode: 'native', busy: false, queued: 0,
      pendingInputs: [], compacting: false, messages: withText, historyBefore: SEED,
    },
  }
}

function pageHistory(before: number): RemoteTaskHistory {
  if (before === SEED) {
    const messages = turnMessages(45, 94)
    return { taskId: TASK_ID, messages, imageArtifacts: images(), page: { historyId: HISTORY_ID, before: PAGE1_BEFORE } }
  }
  if (before === PAGE1_BEFORE) {
    const messages = turnMessages(1, 44)
    return { taskId: TASK_ID, messages, imageArtifacts: images(), page: { historyId: HISTORY_ID, before: undefined } }
  }
  return { taskId: TASK_ID, messages: [], imageArtifacts: images(), page: { historyId: HISTORY_ID, before: undefined } }
}

/** 可见的样例图：图廊截图要能看清内容，所以按 artifactId 生成一张带标签的彩色 PNG */
async function samplePng(label: string): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = 160
  canvas.height = 100
  const ctx = canvas.getContext('2d')!
  const hue = [...label].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) % 360, 17)
  ctx.fillStyle = `hsl(${hue} 65% 55%)`
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#fff'
  ctx.font = '18px sans-serif'
  ctx.fillText(label, 10, 56)
  return await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), 'image/png'))
}

let pageDelayMs = 0

const fakeClient = {
  bootstrap: async () => bootstrapSnapshot(),
  notifications: async () => [],
  history: async (taskId: string, before?: number) => {
    calls.push(before === undefined ? 'window' : `page:${before}`)
    if (before !== undefined && pageDelayMs > 0) await new Promise(resolve => setTimeout(resolve, pageDelayMs))
    return before === undefined ? windowHistory() : pageHistory(before)
  },
  runtime: async (taskId: string) => ({ taskId, busy: false, pendingActions: [], interactions: [], activeGoal: null }),
  image: async (taskId: string, artifactId: string, version: number) => {
    calls.push(`image:${artifactId}@${version}`)
    return samplePng(artifactId)
  },
  ackDone: async () => ({ ok: true }),
  eventStream: () => new Promise<void>(() => {}),
} as never

function bootstrapSnapshot(): RemoteBootstrap {
  const task: RemoteTaskSummary = {
    id: TASK_ID, title: 'CHAT_FIXTURE', spaceId: null, projectId: null, status: 'completed',
    updatedAt: NOW, archived: false, modePresetId: null, startAt: null, dueAt: null,
    isFavorited: false, doneAckedAt: NOW, busy: false, pendingActionCount: 0,
  }
  return {
    apiVersion: 1,
    server: { apiVersion: 1, service: 'mybuddy-remote', name: 'MyBuddy', now: Date.now() },
    spaces: [], projects: [], tasks: [task],
    unreadNotificationCount: 0,
    device: { id: 'fixture', name: 'Fixture Phone', createdAt: 1, lastSeenAt: 1, capabilities: [] },
    models: [], defaultModelId: null, defaultPermissionMode: 'default',
  } as RemoteBootstrap
}

useRemoteStore.setState({
  client: fakeClient,
  bootstrap: bootstrapSnapshot(),
  connection: 'connected',
  activeTaskId: TASK_ID,
  histories: { [TASK_ID]: windowHistory() },
  runtimes: { [TASK_ID]: { taskId: TASK_ID, busy: false, pendingActions: [], interactions: [], activeGoal: null } },
  live: { [TASK_ID]: {} },
})

createRoot(document.getElementById('root')!).render(<App />)

const timeline = () => document.querySelector<HTMLElement>('.chat-timeline')
const labels = (root: ParentNode) => [...root.querySelectorAll('.remote-image-chip-label')].map(el => el.textContent)

function firstOffset(): number | null {
  const el = timeline(); if (!el) return null
  const first = el.querySelector<HTMLElement>('[data-message-id]')
  if (!first) return null
  return first.getBoundingClientRect().top - el.getBoundingClientRect().top
}

;(window as unknown as { harness: unknown }).harness = {
  store: useRemoteStore,
  calls: () => [...calls],
  imageCalls: () => calls.filter(call => call.startsWith('image:')).length,
  ids: () => [...document.querySelectorAll('[data-message-id]')].map(el => (el as HTMLElement).dataset.messageId),
  firstOffset,
  offsetOf: (id: string) => {
    const el = timeline(); if (!el) return null
    const node = el.querySelector<HTMLElement>(`[data-message-id="${id}"]`)
    if (!node) return null
    return node.getBoundingClientRect().top - el.getBoundingClientRect().top
  },
  /** 模拟 7 秒同步拿到「窗口多了新消息、seed 游标不变」的快照 */
  appendWindow: (extra: RemoteHistoryMessage[]) => {
    const state = useRemoteStore.getState()
    const current = state.histories[TASK_ID]!
    if (current.durable?.epoch === undefined) throw Error("expected live fixture");
    const messages = [...current.messages, ...extra]
    useRemoteStore.setState({ histories: { ...state.histories, [TASK_ID]: { ...current, messages,
      durable: { ...current.durable!, messages, revision: current.durable!.revision + 1 } } } })
  },
  /** 模拟实时窗口前滚：historyBefore 变了，客户端应当丢弃已加载块 */
  rollWindow: (nextHistoryBefore: number) => {
    const state = useRemoteStore.getState()
    const current = state.histories[TASK_ID]!
    if (current.durable?.epoch === undefined) throw Error("expected live fixture");
    useRemoteStore.setState({ histories: { ...state.histories, [TASK_ID]: { ...current,
      durable: { ...current.durable!, historyBefore: nextHistoryBefore, revision: current.durable!.revision + 1 } } } })
  },
  scroll: () => { const el = timeline(); return el ? { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight } : null },
  // offscreen 窗口不会为用户程序化的 scrollTop 写入派发原生 scroll 事件，
  // 而真机上会（isNearBottomRef 就靠它更新）。这里补一次，让夹具与真机同语义。
  setScroll: (value: number) => {
    const el = timeline(); if (!el) return
    el.scrollTop = value
    el.dispatchEvent(new Event('scroll'))
  },
  wheel: (deltaY: number) => { const el = timeline(); if (el) el.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true })) },
  /** 「回到底部」按钮是否可见 = 读者已离开底部 */
  showScrollBottom: () => Boolean(document.querySelector('.scroll-bottom-btn')),
  touch: (fromY: number, toY: number) => {
    const el = timeline(); if (!el) return
    const list = (y: number) => [new Touch({ identifier: 1, target: el, clientX: 10, clientY: y, pageX: 10, pageY: y, screenX: 10, screenY: y })]
    el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: list(fromY), targetTouches: list(fromY), changedTouches: list(fromY) }))
    el.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, cancelable: true, touches: list(toY), targetTouches: list(toY), changedTouches: list(toY) }))
  },
  chipsByMessage: () => Object.fromEntries([...document.querySelectorAll<HTMLElement>('[data-message-id]')]
    .map(el => [el.dataset.messageId!, labels(el)])),
  /** 时间轴里是否还存在「任务末尾图片区」（新口径下必须消失） */
  hasTaskImageBlock: () => Boolean(document.querySelector('.timeline-image-links')),
  /** 图廊里的条目（名称 + 是否解码成功） */
  gallery: () => [...document.querySelectorAll('.remote-image-gallery-item')].map(item => ({
    name: item.querySelector('figcaption')?.textContent ?? null,
    loaded: (() => { const img = item.querySelector('img'); return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0 })(),
    status: item.querySelector('.remote-image-status')?.textContent ?? null,
  })),
  chipIndex: (label: string) => [...document.querySelectorAll<HTMLElement>('.remote-image-chip')]
    .findIndex(el => el.querySelector('.remote-image-chip-label')?.textContent === label),
  openChip: (label: string) => {
    const chip = [...document.querySelectorAll<HTMLElement>('.remote-image-chip')]
      .find(el => el.querySelector('.remote-image-chip-label')?.textContent === label)
    chip?.click(); return Boolean(chip)
  },
  viewer: () => {
    const root = document.querySelector('.remote-image-viewer')
    if (!root) return null
    const img = root.querySelector('img')
    return { status: root.querySelector('.remote-image-status')?.textContent ?? null, src: img?.getAttribute('src') ?? null,
      loaded: img instanceof HTMLImageElement ? img.complete && img.naturalWidth > 0 : false }
  },
  closeViewer: () => { (document.querySelector('.remote-image-viewer > button') as HTMLElement | null)?.click() },
  syncTask: () => useRemoteStore.getState().syncTask(TASK_ID),
  setPageDelay: (ms: number) => { pageDelayMs = ms },
  resetWindow: () => useRemoteStore.setState({ histories: { [TASK_ID]: windowHistory() }, live: { [TASK_ID]: {} } }),
}
