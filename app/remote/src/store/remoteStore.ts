import { create } from 'zustand'
import { applyDurableDelta, replayDurableDeltas } from '@mybuddy/shared'
import { reconcileLiveMessagesWithHistory, type LiveRemoteMessage } from './remoteTimeline'
import { reduceRemotePatch } from './remotePatch'
export { coalesceAssistantTurnMessages, reconcileLiveMessagesWithHistory } from './remoteTimeline'
import type {
  RemoteAcpPermissionPolicy, RemoteAttachmentInput, RemoteBootstrap, RemoteConnectionState, RemoteConversationInteraction,
  RemoteConversationInteractionAnswer, RemoteEventEnvelope, RemoteHistoryMessage,
  RemoteNotification, RemoteRuntimeSnapshot, RemoteTaskHistory, RemoteTaskSummary,
  RemoteWelcomeMode,
  RemoteDurableSnapshot, RemoteDurableDelta, RemoteDurableState,
} from '@mybuddy/shared'
import { RemoteApiError, RemoteClient } from '../api/RemoteClient'
import { useRemoteWorkStore } from './remoteWork'
import { checkRemoteService, normalizeRemoteAddress } from '../api/connectionSetup'
import { RemoteEventStream } from '../api/RemoteEventStream'
import {
  clearCredential,
  getActiveServer,
  getInstallationId,
  loadCredential,
  loadServerConfig,
  removeServer,
  renameServer,
  saveCredential,
  setActiveServerId,
  updateServerNode,
  upsertServer,
  type RemoteServerConfig,
  type RemoteServerNode,
} from '../api/credentialStore'
import { loadLastActiveTaskId, saveLastActiveTaskId } from './remoteUiState'
import {
  clearAll as clearAllCached,
  deleteHistory as deleteCachedHistory,
  loadHistory as loadCachedHistory,
  loadTaskList,
  saveHistory as saveCachedHistory,
  saveTaskList,
  serverCacheKey,
  type CachedTaskList,
} from './remoteDb'

export interface PendingAttachment {
  id: string
  name: string
  size: number
  dataUrl?: string
}

/** dataUrl → 契约附件输入（base64 不带前缀 + mimeType） */
function toAttachmentInput(att: PendingAttachment): RemoteAttachmentInput | null {
  if (!att.dataUrl) return null
  const match = /^data:([^;]+);base64,(.+)$/.exec(att.dataUrl)
  if (!match) return null
  return { name: att.name, data: match[2], mimeType: match[1] }
}

interface State {
  connection: RemoteConnectionState
  client: RemoteClient | null
  bootstrap: RemoteBootstrap | null
  serverConfig: RemoteServerConfig
  activeServer: RemoteServerNode | null
  notifications: RemoteNotification[]
  activeTaskId: string | null
  histories: Record<string, RemoteTaskHistory>
  runtimes: Record<string, RemoteRuntimeSnapshot>
  live: Record<string, Record<string, LiveRemoteMessage>>
  error: string | null
  sending: boolean
  creating: boolean
  isDrawerOpen: boolean
  isConnectionSettingsOpen: boolean
  setConnectionSettingsOpen: (open: boolean) => void
  setDrawerOpen: (open: boolean) => void
  isNotificationsOpen: boolean
  setNotificationsOpen: (open: boolean) => void
  isAddToChatOpen: boolean
  setAddToChatOpen: (open: boolean) => void
  isModelSheetOpen: boolean
  isPermissionSheetOpen: boolean
  setPermissionSheetOpen: (open: boolean) => void
  setModelSheetOpen: (open: boolean) => void
  /** null = 跟随电脑端默认模型 */
  selectedModelId: string | null
  setSelectedModelId: (id: string | null) => void
  refreshModels: () => Promise<{ errors: Array<{ providerId: string; message: string }> }>
  /**
   * P0 修复：三态权限，'follow' 时不传 permissionMode，服务端保持任务自身权限不变；
   * 'ask' / 'auto' 是手机端的显式覆盖（分别映射 default / auto）。
   */
  toolAccessMode: 'follow' | 'ask' | 'readonly' | 'auto'
  setToolAccessMode: (mode: 'follow' | 'ask' | 'readonly' | 'auto') => void
  selectedProjectId: string | null
  setSelectedProjectId: (id: string | null) => void
  selectedSpaceId: string | null
  setSelectedSpaceId: (id: string | null) => void
  selectedWelcomeMode: RemoteWelcomeMode | null
  selectedModePresetId: string | null
  setSelectedWelcomeMode: (mode: RemoteWelcomeMode | null) => void
  setSelectedModePresetId: (id: string | null) => void
  /** ACP 外部 Agent：null = 内置 Pi；非空 = 本轮委托给电脑端该 Agent */
  selectedAcpAgentId: string | null
  setSelectedAcpAgentId: (id: string | null) => void
  /**
   * 下一轮是否强制开新 ACP 会话（丢弃上下文）。默认 false = 自动续接同任务同 Agent
   * 最近一次可恢复 session；发送成功后复位，避免一直清空上下文。
   */
  acpNewSession: boolean
  setAcpNewSession: (value: boolean) => void
  isAcpSheetOpen: boolean
  setAcpSheetOpen: (open: boolean) => void
  /** 修改某 Agent 的权限策略（写电脑端设置）：解决「每次都要手动点允许」 */
  setAcpAgentPolicy: (agentId: string, policy: RemoteAcpPermissionPolicy) => Promise<void>
  refreshAcpAgents: () => Promise<void>
  taskSetupSection: 'location' | 'project' | 'mode' | 'tag' | null
  setTaskSetupSection: (section: State['taskSetupSection']) => void
  attachments: PendingAttachment[]
  addAttachment: (att: PendingAttachment) => void
  removeAttachment: (id: string) => void
  clearAttachments: () => void
  initialize(): Promise<void>
  resync(): Promise<void>
  resume(): Promise<void>
  syncTask(taskId: string, beforeEntryId?: number): Promise<void>
  connect(baseUrl: string, token: string): Promise<void>
  connectDiscovered(baseUrl: string): Promise<boolean>
  connectByUrl(rawUrl: string, code: string, deviceName?: string): Promise<void>
  pair(input: { baseUrl: string; pairingId: string; secret: string; deviceName: string }): Promise<void>
  disconnect(): Promise<void>
  switchServer(serverId: string): Promise<void>
  removeServerNode(serverId: string): Promise<void>
  renameServerNode(serverId: string, newName: string): Promise<void>
  updateServerNode(serverId: string, patch: { name?: string; baseUrl?: string }, reconnect?: boolean): Promise<void>
  refreshServerConfig(): Promise<void>
  openTask(taskId: string): Promise<void>
  /**
   * 「已结束」绿点确认（打开任务即已查看）：本机乐观清除 + POST /v1/tasks/:id/ackDone。
   * 电脑端不可用（旧版本/请求失败）时退回本机 localStorage 水位，保证「点开就消失、刷新不复活」。
   */
  markTaskDoneSeen(taskId: string): Promise<void>
  /** 回首页（返回手势 / 左上角返回按钮）；同时丢弃模型/权限的一次性覆盖，避免泄漏到下一个任务 */
  goHome(): void
  /**
   * 删除任务（服务端进入安全回收，可在电脑端回收站恢复）。
   * 成功后本地立即摘除该任务并回到首页，不等 SSE 回环。
   */
  deleteTask(taskId: string): Promise<void>
  startNewTask(spaceId?: string): void
  send(text: string, attachments?: PendingAttachment[]): Promise<void>
  sendAcp(text: string, attachments?: PendingAttachment[], continueFromRunId?: string): Promise<void>
  /** 新建任务并直接交给 ACP Agent（首页选中 Agent 的第一轮） */
  createAcp(text: string, attachments?: PendingAttachment[]): Promise<void>
  resolveAcpPermission(toolCallId: string, optionId: string): Promise<void>
  create(text: string, attachments?: PendingAttachment[]): Promise<void>
  abort(): Promise<void>
  approve(toolCallId: string, decision: 'deny' | 'allow-once' | 'allow-task-dir'): Promise<void>
  respondInteraction(interactionId: string, answer: RemoteConversationInteractionAnswer): Promise<void>
  cancelInteraction(interactionId: string): Promise<void>
  readNotification(id: string): Promise<void>
  readAllNotifications(): Promise<void>
  clearAllNotifications(): Promise<void>
}

const CLEARED_NOTICES_KEY = 'mybuddy_remote_cleared_notices'
/** 本机「已结束绿点」确认水位：电脑端 ack 不可用时的兜底（键 = taskId，值 = 电脑端时间轴 ms） */
const DONE_ACK_OVERRIDES_KEY = 'mybuddy_remote_done_acks'
/**
 * 每个任务选过的 ACP Agent（taskId → agentId）。
 * 只放内存会导致「杀进程/重装后静默回到内置 MyBuddy」——用户以为还在用 OpenCode，
 * 实际已经把消息发给了内置 Pi，所以必须持久化到本机。
 */
const ACP_AGENT_BY_TASK_KEY = 'mybuddy_remote_acp_agent_by_task'

function readAcpAgentByTask(): Record<string, string> {
  try {
    const raw = localStorage.getItem(ACP_AGENT_BY_TASK_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {}
  } catch {
    return {}
  }
}

let acpAgentByTask: Record<string, string> = readAcpAgentByTask()

function rememberAcpAgentForTask(taskId: string | null, agentId: string | null): void {
  if (!taskId) return
  const next = { ...acpAgentByTask }
  if (agentId) next[taskId] = agentId
  else delete next[taskId]
  // 只保留最近 200 个任务，避免无限增长
  acpAgentByTask = Object.fromEntries(Object.entries(next).slice(-200))
  try {
    localStorage.setItem(ACP_AGENT_BY_TASK_KEY, JSON.stringify(acpAgentByTask))
  } catch {
    // ignore：写不进去只影响下次启动的默认值
  }
}

export function rememberedAcpAgentForTask(taskId: string | null): string | null {
  if (!taskId) return null
  return acpAgentByTask[taskId] ?? null
}

function readDoneAckOverrides(): Record<string, number> {
  try {
    const raw = localStorage.getItem(DONE_ACK_OVERRIDES_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? parsed as Record<string, number> : {}
  } catch {
    return {}
  }
}

let doneAckOverrides: Record<string, number> = readDoneAckOverrides()

/** 任务的本机确认水位（0 = 本机没确认过）；UI 用 max(服务端水位, 本机水位) 判定绿点 */
export function localDoneAckAt(taskId: string): number {
  return doneAckOverrides[taskId] ?? 0
}

function recordLocalDoneAck(taskId: string, at: number): void {
  if ((doneAckOverrides[taskId] ?? 0) >= at) return
  doneAckOverrides = { ...doneAckOverrides, [taskId]: at }
  try {
    const entries = Object.entries(doneAckOverrides).sort((a, b) => b[1] - a[1]).slice(0, 500)
    doneAckOverrides = Object.fromEntries(entries)
    localStorage.setItem(DONE_ACK_OVERRIDES_KEY, JSON.stringify(doneAckOverrides))
  } catch {
    // ignore：本地兜底写不进去也不影响服务端已确认的情况
  }
}

/**
 * P0 修复：丢弃一次性（transient）的模型/权限/项目覆盖。服务端已把显式选择持久化进任务，
 * 客户端覆盖值在「发送成功 / 切换任务 / 回首页 / 重连」后必须复位为 follow，
 * 否则任务 A 里选的 Auto 会泄漏到任务 B。
 * selectedProjectId 同语义：项目归属是「下一条新消息」的一次性选择，随提交/切换清零。
 */
function resetTransientOverrides(): Partial<State> {
  return { selectedModelId: null, toolAccessMode: 'follow', selectedProjectId: null, selectedSpaceId: null,
    selectedWelcomeMode: null, selectedModePresetId: null, taskSetupSection: null }
}
/**
 * ACP 选择是「粘性」的：用户选了某个外部 Agent，后续每轮都还给它，直到手动切回内置 Pi。
 * 只随「切换任务 / 回首页」清理，避免任务 A 选的 Agent 泄漏到任务 B（两个 Agent 共用同一 cwd 会互相踩）。
 */
function resetAcpSelection(): Pick<State, 'selectedAcpAgentId' | 'isAcpSheetOpen' | 'acpNewSession'> {
  return { selectedAcpAgentId: null, isAcpSheetOpen: false, acpNewSession: false }
}
function getClearedNoticeIds(): Set<string> {
  try {
    const raw = localStorage.getItem(CLEARED_NOTICES_KEY)
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch {
    return new Set()
  }
}

function saveClearedNoticeIds(ids: Set<string>): void {
  try {
    localStorage.setItem(CLEARED_NOTICES_KEY, JSON.stringify(Array.from(ids).slice(-500)))
  } catch {
    // ignore
  }
}

let stream: RemoteEventStream | null = null
let initializationPromise: Promise<void> | null = null

let connectionRevision = 0
let navigationRevision = 0
let bootstrapRevision = 0
let serverOffsetMs = 0
let lastResumeAt = 0
const taskSyncRevisions = new Map<string, number>()
const taskEventRevisions = new Map<string, number>()
const durableResyncs = new Map<string, { client: RemoteClient; buffered: RemoteDurableDelta[] }>()
/** 最近一次成功拉取历史的时刻（ms）与当时的事件序号；用于判断缓存是否仍可信 */
const historyFetchedAt = new Map<string, number>()
const historyFetchedEventRevision = new Map<string, number>()
/**
 * 已加载历史的 LRU 顺序（最近使用在末尾）。手机端没有本地数据库，
 * 历史只能靠内存缓存避免「每次切任务都全量重拉」；同时必须修剪，否则越用越卡。
 */
const HISTORY_CACHE_LIMIT = 5
const historyLru: string[] = []
/** 缓存被认为是新鲜的窗口：窗口内切回不重新拉取，仅后台静默刷新 */
const HISTORY_FRESH_MS = 30_000
/** 超过该时长后，切回时顺带后台补拉一次（不阻塞渲染） */
const HISTORY_REVALIDATE_MS = 10_000

/** 按 baseUrl 模糊查找缓存（deviceId 未知时用）；找到任意一条即认为属于该服务器。 */
async function loadTaskListLoose(baseUrl: string): Promise<CachedTaskList | null> {
  // deviceId 在 bootstrap 返回前未知，先用空 deviceId 的键试；失败则由 commit 后的写入补齐。
  return loadTaskList(serverCacheKey(baseUrl, null))
}

/** 冷启动回填：用本地快照把任务列表先渲染出来，不触碰已有的历史缓存。 */
function applyCachedTaskList(tasks: RemoteTaskSummary[]): void {
  const state = useRemoteStore.getState()
  if (state.bootstrap) return
  // 快照缺少 server/device 等字段，只在渲染层面使用；联网成功后会被真实 bootstrap 覆盖。
  // 用目标类型断言构造成完整形状，避免消费方读到 undefined。
  const placeholder = {
    apiVersion: 1,
    tasks,
    spaces: [],
    projects: [],
    server: { now: Date.now() },
    unreadNotificationCount: 0,
    device: { id: '', name: '', pairedAt: 0 },
    models: [],
    defaultModelId: null,
    defaultPermissionMode: 'default',
  } as unknown as RemoteBootstrap
  useRemoteStore.setState({ bootstrap: placeholder, connection: 'reconnecting' })
}

function touchHistoryLru(taskId: string): void {
  const index = historyLru.indexOf(taskId)
  if (index >= 0) historyLru.splice(index, 1)
  historyLru.push(taskId)
}

/**
 * 把超出上限的、且不是当前活跃任务的历史从内存里丢掉。
 * 只丢前端投影，不影响电脑端数据；切回时会重新拉一次（走后台静默刷新）。
 */
/**
 * 返回修剪后的局部 state 补丁（不含变动时返回 null，避免无谓重渲染）。
 * 只丢前端投影，不影响电脑端数据；切回时会重新拉一次。
 */
function pruneHistories(histories: Record<string, RemoteTaskHistory>, runtimes: Record<string, RemoteRuntimeSnapshot>,
  live: Record<string, Record<string, LiveRemoteMessage>>, keep: string | null, nextActive: string | null): {
    histories: Record<string, RemoteTaskHistory>
    runtimes: Record<string, RemoteRuntimeSnapshot>
    live: Record<string, Record<string, LiveRemoteMessage>>
  } | null {
  const victims: string[] = []
  while (historyLru.length > HISTORY_CACHE_LIMIT) {
    const victim = historyLru.find((id) => id !== keep && id !== nextActive && histories[id] !== undefined)
    if (!victim) break
    historyLru.splice(historyLru.indexOf(victim), 1)
    victims.push(victim)
  }
  if (!victims.length) return null
  const nextHistories = { ...histories }
  const nextRuntimes = { ...runtimes }
  const nextLive = { ...live }
  for (const victim of victims) {
    historyFetchedAt.delete(victim)
    historyFetchedEventRevision.delete(victim)
    delete nextHistories[victim]
    delete nextRuntimes[victim]
    delete nextLive[victim]
  }
  return { histories: nextHistories, runtimes: nextRuntimes, live: nextLive }
}
let refreshTimer: ReturnType<typeof setTimeout> | undefined
/** 当前连接的服务器缓存键（baseUrl + deviceId）；历史读写都用它做命名空间 */
let activeServerKey: string | null = null

export const useRemoteStore = create<State>((set, get) => ({
  connection: 'disconnected', client: null, bootstrap: null,
  serverConfig: { activeServerId: null, servers: [] },
  activeServer: null,
  notifications: [], activeTaskId: null,
  histories: {}, runtimes: {}, live: {}, error: null, sending: false, creating: false,
  isDrawerOpen: false,
  isConnectionSettingsOpen: false,
  setConnectionSettingsOpen: (isConnectionSettingsOpen) => set({ isConnectionSettingsOpen }),
  isPermissionSheetOpen: false,
  setPermissionSheetOpen: (isPermissionSheetOpen) => set({ isPermissionSheetOpen }),
  setDrawerOpen: (isDrawerOpen) => set({ isDrawerOpen }),
  isNotificationsOpen: false,
  setNotificationsOpen: (isNotificationsOpen) => set({ isNotificationsOpen }),
  isAddToChatOpen: false,
  setAddToChatOpen: (isAddToChatOpen) => set({ isAddToChatOpen }),
  isModelSheetOpen: false,
  setModelSheetOpen: (isModelSheetOpen) => set({ isModelSheetOpen }),
  selectedModelId: null,
  setSelectedModelId: (selectedModelId) => set({ selectedModelId }),
  async refreshModels() {
    const client = get().client
    if (!client) throw new Error('未连接到电脑端')
    const result = await client.refreshModels()
    set(state => state.bootstrap ? { bootstrap: { ...state.bootstrap, models: result.models } } : state)
    return { errors: result.errors }
  },
  toolAccessMode: 'follow',
  setToolAccessMode: (toolAccessMode) => set({ toolAccessMode }),
  selectedProjectId: null,
  setSelectedProjectId: (selectedProjectId) => set({ selectedProjectId }),
  selectedSpaceId: null,
  setSelectedSpaceId: (selectedSpaceId) => set({ selectedSpaceId }),
  selectedWelcomeMode: null,
  selectedModePresetId: null,
  /**
   * ACP 外部 Agent 选择：null = 用内置 Pi（默认）；
   * 选择后当前任务的发送会走电脑端真实 ACP 进程（/v1/tasks/:id/acp）。
   */
  selectedAcpAgentId: null,
  setSelectedAcpAgentId: (selectedAcpAgentId) => {
    rememberAcpAgentForTask(get().activeTaskId, selectedAcpAgentId)
    set({ selectedAcpAgentId })
  },
  acpNewSession: false,
  setAcpNewSession: (acpNewSession) => set({ acpNewSession }),
  isAcpSheetOpen: false,
  setAcpSheetOpen: (isAcpSheetOpen) => set({ isAcpSheetOpen }),
  async setAcpAgentPolicy(agentId, policy) {
    const client = get().client
    if (!client) return
    const acpAgents = await client.setAcpPermission(agentId, policy)
    const bootstrap = get().bootstrap
    if (bootstrap) set({ bootstrap: { ...bootstrap, acpAgents } })
  },
  /** ACP 目录刷新（电脑端装/卸载 CLI 后手动重探） */
  async refreshAcpAgents() {
    const client = get().client
    if (!client) return
    try {
      const acpAgents = await client.acpAgents(true)
      const bootstrap = get().bootstrap
      if (bootstrap) set({ bootstrap: { ...bootstrap, acpAgents } })
    } catch (error) {
      console.warn('refresh acp agents failed', error)
    }
  },
  setSelectedWelcomeMode: (selectedWelcomeMode) => set({ selectedWelcomeMode, selectedModePresetId: null,
    ...(selectedWelcomeMode === 'general' ? { toolAccessMode: 'follow' as const, isPermissionSheetOpen: false } : {}) }),
  setSelectedModePresetId: (selectedModePresetId) => set({ selectedModePresetId }),
  taskSetupSection: null,
  setTaskSetupSection: (taskSetupSection) => set({ taskSetupSection }),
  attachments: [],
  addAttachment: (att) => set((s) => ({ attachments: [...s.attachments, att] })),
  removeAttachment: (id) => set((s) => ({ attachments: s.attachments.filter((a) => a.id !== id) })),
  clearAttachments: () => set({ attachments: [] }),
  async initialize() {
    if (get().client || get().connection === 'unauthorized') return
    if (initializationPromise) return initializationPromise
    const revision = connectionRevision
    const attempt = (async () => {
      let config: RemoteServerConfig
      try {
        config = await loadServerConfig()
        set({ serverConfig: config })
      } catch (error) {
        if (revision === connectionRevision) set({ error: error instanceof Error ? error.message : String(error) })
        return
      }
      const active = getActiveServer(config)
      set({ activeServer: active })
      // Logout or an explicit connection supersedes a pending credential read.
      if (revision !== connectionRevision || !active) return
      try {
        await get().connect(active.baseUrl, active.deviceToken)
      } catch { /* connect owns the error; foreground synchronization retries transient failures. */ }
    })()
    initializationPromise = attempt
    try { await attempt }
    finally { if (initializationPromise === attempt) initializationPromise = null }
  },
  async resync() {
    // The existing foreground sync loop also recovers a failed first connection.
    if (!get().client) { await get().initialize(); return }
    const taskId = get().activeTaskId
    const client = get().client!
    await Promise.all([refresh(), useRemoteWorkStore.getState().refresh(client),
      taskId ? syncTaskHistory(taskId) : Promise.resolve()])
  },
  async resume() {
    if (Date.now() - lastResumeAt < 500) return
    lastResumeAt = Date.now()
    if (!get().client) { await get().initialize(); return }
    stream?.restart()
    await get().resync()
  },
  syncTask: syncTaskHistory,
  async connect(baseUrl, token) {
    const revision = ++connectionRevision
    const navigation = navigationRevision
    const previousClient = get().client
    const previousConnection = get().connection
    set({ connection: 'connecting', error: null })
    const normalizedBase = baseUrl.replace(/\/$/, '')
    const client = new RemoteClient(normalizedBase, token)
    // 冷启动先用本地数据库里的快照渲染，网络成功后再覆盖（stale-while-revalidate）。
    // 只有当前没有任何 bootstrap 时才回填，避免覆盖正在使用的新数据。
    if (!get().bootstrap) {
      const cachedKey = serverCacheKey(normalizedBase, null)
      const cached = await loadTaskList(cachedKey) ?? await loadTaskListLoose(normalizedBase)
      if (cached && revision === connectionRevision && !get().bootstrap) {
        applyCachedTaskList(cached.tasks)
      }
    }
    try {
      const [bootstrap, rawNotifications] = await Promise.all([client.bootstrap(), client.notifications()])
      if (revision !== connectionRevision) return
      serverOffsetMs = Number.isFinite(bootstrap.server?.now) ? bootstrap.server.now - Date.now() : 0
      const cleared = getClearedNoticeIds()
      const notifications = rawNotifications.filter((n) => !cleared.has(n.id))
      clearTimeout(refreshTimer); refreshTimer = undefined
      stream?.stop()
      stream = new RemoteEventStream(client, applyEvent, connected => {
        if (get().client !== client) return
        set({ connection: connected ? 'connected' : 'reconnecting', ...(connected ? { error: null } : {}) })
        if (connected) {
          scheduleRemoteSync()
          void useRemoteWorkStore.getState().refresh(client)
        }
      })
      const nextServerKey = serverCacheKey(normalizedBase, bootstrap.device?.id)
      activeServerKey = nextServerKey
      useRemoteWorkStore.getState().setClient(client)
      set({
        client, bootstrap, notifications, connection: 'connected', histories: get().histories, runtimes: get().runtimes, live: get().live,
        activeTaskId: bootstrap.tasks.some(task => task.id === get().activeTaskId && !task.archived) ? get().activeTaskId : null,
        // P0：默认 'follow'（不传 permissionMode，服务端跟随任务/设置），不再从默认权限推断覆盖值
        // 连接新会话（配对 / 切换服务器 / 重新连接）时清空上个会话遗留的 transient 覆盖
        ...resetTransientOverrides(),
      })
      // 落本地数据库：任务列表快照供下次冷启动使用
      void saveTaskList(nextServerKey, bootstrap).catch(() => undefined)
      stream.start()
      const lastTaskId = navigation === navigationRevision ? loadLastActiveTaskId() : null
      if (lastTaskId) {
        const restorable = bootstrap.tasks.some((task) => task.id === lastTaskId && !task.archived)
        if (restorable) {
          try {
            await get().openTask(lastTaskId)
          } catch {
            saveLastActiveTaskId(null)
          }
        } else {
          saveLastActiveTaskId(null)
        }
      }
    } catch (error) {
      if (revision !== connectionRevision) return
      const status = (error as { status?: number }).status
      // Trying a new address must not destroy the working connection on failure.
      if (previousClient && get().client === previousClient && previousClient.baseUrl !== client.baseUrl) {
        set({ connection: previousConnection, error: error instanceof Error ? error.message : String(error) })
        throw error
      }
      // 401/403 不要拆掉当前界面：调用方（自动重连、7 秒 resync）拿到的失效令牌不该把
      // 正在看的对话整屏换掉。保留 client/bootstrap，让缓存历史继续显示，只在顶部报错提示。
      if (status === 401 || status === 403) {
        stream?.stop(); stream = null
        useRemoteWorkStore.getState().setClient(null)
      }
      set({ connection: status === 401 || status === 403 ? 'unauthorized' : 'disconnected', error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  },
  async connectDiscovered(baseUrl) {
    const credential = await loadCredential()
    if (!credential) return false
    await get().connect(baseUrl, credential.deviceToken)
    if (get().client?.baseUrl !== baseUrl.replace(/\/$/, '')) return false
    await saveCredential({ baseUrl, deviceToken: credential.deviceToken })
    return true
  },
  async connectByUrl(rawUrl, code, deviceName = 'Android') {
    const baseUrl = normalizeRemoteAddress(rawUrl)
    await checkRemoteService(baseUrl)
    const installationId = await getInstallationId()
    const response = await RemoteClient.pairDirect(baseUrl, {
      deviceName,
      installationId,
      code,
    })
    const defaultName = response.server?.name || '我的电脑'
    const { config, active } = await upsertServer({
      name: defaultName,
      baseUrl,
      deviceToken: response.deviceToken,
    })
    set({ serverConfig: config, activeServer: active })
    await get().connect(baseUrl, response.deviceToken)
  },
  async pair(input) {
    const installationId = await getInstallationId()
    const response = await RemoteClient.pair(input.baseUrl, {
      pairingId: input.pairingId,
      secret: input.secret,
      deviceName: input.deviceName,
      installationId,
    })
    const defaultName = response.server?.name || input.deviceName || '我的电脑'
    const { config, active } = await upsertServer({
      name: defaultName,
      baseUrl: input.baseUrl,
      deviceToken: response.deviceToken,
    })
    set({ serverConfig: config, activeServer: active })
    await get().connect(input.baseUrl, response.deviceToken)
  },
  async disconnect() {
    ++connectionRevision; ++navigationRevision
    useRemoteWorkStore.getState().setClient(null)
    clearTimeout(refreshTimer); refreshTimer = undefined
    stream?.stop(); stream = null
    await clearCredential()
    const newConfig = await loadServerConfig()
    const nextActive = getActiveServer(newConfig)
    activeServerKey = null
    void clearAllCached().catch(() => undefined)
    saveLastActiveTaskId(null)
    set({
      connection: 'disconnected',
      client: null,
      bootstrap: null,
      serverConfig: newConfig,
      activeServer: nextActive,
      activeTaskId: null,
      sending: false,
      creating: false,
      ...resetTransientOverrides()
    })
  },
  async switchServer(serverId: string) {
    if (get().serverConfig.activeServerId === serverId && get().client && get().connection === 'connected') return
    ++connectionRevision
    ++navigationRevision
    useRemoteWorkStore.getState().setClient(null)
    clearTimeout(refreshTimer); refreshTimer = undefined
    stream?.stop(); stream = null
    const newConfig = await setActiveServerId(serverId)
    const target = getActiveServer(newConfig)
    if (!target) return
    set({
      serverConfig: newConfig,
      activeServer: target,
      client: null,
      bootstrap: null,
      activeTaskId: null,
      sending: false,
      creating: false,
      error: null,
      ...resetTransientOverrides()
    })
    saveLastActiveTaskId(null)
    await get().connect(target.baseUrl, target.deviceToken)
  },
  async removeServerNode(serverId: string) {
    const wasActive = get().serverConfig.activeServerId === serverId
    const newConfig = await removeServer(serverId)
    set({ serverConfig: newConfig })
    if (wasActive) {
      const next = getActiveServer(newConfig)
      if (next) {
        await get().switchServer(next.id)
      } else {
        await get().disconnect()
      }
    }
  },
  async renameServerNode(serverId: string, newName: string) {
    const newConfig = await renameServer(serverId, newName)
    const active = getActiveServer(newConfig)
    set({ serverConfig: newConfig, activeServer: active })
  },
  async updateServerNode(serverId: string, patch: { name?: string; baseUrl?: string }, reconnect = false) {
    const newConfig = await updateServerNode(serverId, patch)
    const active = getActiveServer(newConfig)
    set({ serverConfig: newConfig, activeServer: active })
    if (reconnect || (newConfig.activeServerId === serverId && get().client)) {
      if (active) {
        await get().connect(active.baseUrl, active.deviceToken)
      }
    }
  },
  async refreshServerConfig() {
    const config = await loadServerConfig()
    const active = getActiveServer(config)
    set({ serverConfig: config, activeServer: active })
  },
  async openTask(taskId) {
    // 不再要求必须有 client：离线时仍可从本地数据库读出已缓存的对话。
    if (!get().client && !activeServerKey) return
    ++navigationRevision
    saveLastActiveTaskId(taskId)
    const previousTaskId = get().activeTaskId
    // 恢复该任务上次选过的 ACP Agent（杀进程/重装后不能静默退回内置 MyBuddy）
    const rememberedAcpAgent = rememberedAcpAgentForTask(taskId)
    set(state => ({
      activeTaskId: taskId,
      ...(state.activeTaskId !== taskId ? { ...resetTransientOverrides(), ...resetAcpSelection() } : {}),
      // 放在 spread 之后：即使触发 resetAcpSelection，也要恢复该任务记住的 Agent
      selectedAcpAgentId: rememberedAcpAgent,
    }))
    // 打开任务 = 已查看结果：先清绿点（本地即时生效），再落库给所有设备共享
    void get().markTaskDoneSeen(taskId)

    // 本地数据库命中：内存里没有（冷启动 / 已被修剪），但本机存过这份历史——
    // 先渲染出来，再后台向电脑端校正。离线时这就是唯一的数据来源。
    if (get().histories[taskId] === undefined && activeServerKey) {
      const local = await loadCachedHistory(activeServerKey, taskId)
      // 期间用户可能已切走：本次打开作废
      if (get().activeTaskId !== taskId) return
      if (local?.history && get().histories[taskId] === undefined) {
        touchHistoryLru(taskId)
        historyFetchedAt.set(taskId, local.at)
        historyFetchedEventRevision.set(taskId, taskEventRevisions.get(taskId) ?? 0)
        const state = get()
        set({
          histories: { ...state.histories, [taskId]: local.history },
          ...(local.runtime ? { runtimes: { ...state.runtimes, [taskId]: local.runtime } } : {}),
        })
        const patch = pruneHistories(get().histories, get().runtimes, get().live, previousTaskId, taskId)
        if (patch) set(patch)
        // 后台校正：网络失败（离线）时保持本地内容，不报错
        void syncTaskHistory(taskId).catch(() => undefined)
        return
      }
    }

    // 缓存命中：已加载过该任务且事件序号未推进、且仍在新鲜窗口内，
    // 直接渲染内存里的历史，不阻塞 UI；同时在后台静默刷新以纠正漂移。
    const cached = get().histories[taskId]
    const fetchedAt = historyFetchedAt.get(taskId) ?? 0
    const fetchedRevision = historyFetchedEventRevision.get(taskId) ?? -1
    const revisionUnchanged = fetchedRevision === (taskEventRevisions.get(taskId) ?? 0)
    const fresh = cached !== undefined && revisionUnchanged && Date.now() - fetchedAt < HISTORY_FRESH_MS
    if (fresh) {
      touchHistoryLru(taskId)
      const state = get()
      const patch = pruneHistories(state.histories, state.runtimes, state.live, previousTaskId, taskId)
      if (patch) set(patch)
      // 后台静默刷新：事件序号未变说明期间没有新流量，只在缓存已偏旧时才补拉；
      // 失败不影响已经显示的缓存内容。
      if (Date.now() - fetchedAt > HISTORY_REVALIDATE_MS) void syncTaskHistory(taskId).catch(() => undefined)
      return
    }
    await syncTaskHistory(taskId)
    const state = get()
    const patch = pruneHistories(state.histories, state.runtimes, state.live, previousTaskId, taskId)
    if (patch) set(patch)
  },
  async markTaskDoneSeen(taskId) {
    const at = Date.now() + serverOffsetMs // 用电脑端时间轴，和 task.updatedAt 可比
    recordLocalDoneAck(taskId, at)
    set(state => state.bootstrap ? {
      bootstrap: {
        ...state.bootstrap,
        // bootstrap.tasks 可能缺失（部分测试夹具/裁剪快照）：此时只保留本机水位，不构造残缺状态
        tasks: Array.isArray(state.bootstrap.tasks)
          ? state.bootstrap.tasks.map(task => task.id === taskId ? { ...task, doneAckedAt: Math.max(task.doneAckedAt ?? 0, at) } : task)
          : state.bootstrap.tasks,
      },
    } : {})
    const client = get().client
    if (!client) return
    try {
      await client.ackDone(taskId)
    } catch (error) {
      // 旧版本电脑端没有该路由（404）或临时失败：本机水位已生效，不打扰用户
      console.warn('ackDone failed; kept local done-ack watermark', error)
    }
  },
  goHome() {
    ++navigationRevision
    saveLastActiveTaskId(null)
    set({ activeTaskId: null, ...resetTransientOverrides(), ...resetAcpSelection() })
  },
  async deleteTask(taskId) {
    const { client, bootstrap, histories, runtimes, live } = get()
    if (!client) throw new Error('尚未连接电脑端')
    try {
      await client.deleteTask(taskId)
    } catch (error) {
      // 电脑端已在回收区/任务正忙（409）时，仍把本地视图对齐：不再显示该任务。
      if (!(error instanceof RemoteApiError) || error.status !== 409) throw error
    }
    const nextHistories = { ...histories }
    const nextRuntimes = { ...runtimes }
    const nextLive = { ...live }
    delete nextHistories[taskId]; delete nextRuntimes[taskId]; delete nextLive[taskId]
    // 本地数据库同步清理：否则回收后仍能从缓存读到旧对话
    if (activeServerKey) void deleteCachedHistory(activeServerKey, taskId).catch(() => undefined)
    rememberAcpAgentForTask(taskId, null)
    const removedEntry = (bootstrap?.tasks ?? []).find((task) => task.id === taskId)
    const nextTasks = (bootstrap?.tasks ?? []).filter((task) => task.id !== taskId)
    // 模型/权限覆盖来自被删任务时一并丢弃，避免泄漏到下一个任务。
    const activeDeleted = get().activeTaskId === taskId
    ++navigationRevision
    if (activeDeleted) saveLastActiveTaskId(null)
    set({
      bootstrap: bootstrap ? { ...bootstrap, tasks: nextTasks } : bootstrap,
      histories: nextHistories, runtimes: nextRuntimes, live: nextLive,
      ...(activeDeleted ? { activeTaskId: null, ...resetTransientOverrides(), ...resetAcpSelection() } : {}),
    })
    // 与桌面端一致：从任务所属空间/项目的计数里移除
    if (removedEntry) void refresh().catch(() => undefined)
  },
  startNewTask(spaceId) {
    ++navigationRevision
    saveLastActiveTaskId(null)
    set({ activeTaskId: null, ...resetTransientOverrides(), ...resetAcpSelection(), selectedSpaceId: spaceId ?? null,
      attachments: [], isDrawerOpen: false, isAddToChatOpen: false, isModelSheetOpen: false, isPermissionSheetOpen: false })
  },
  async send(text, pendingAttachments = []) {
    const { client, activeTaskId, sending, selectedModelId, toolAccessMode } = get()
    if (!client || !activeTaskId || sending) return
    const attachments = pendingAttachments.map(toAttachmentInput).filter(Boolean) as RemoteAttachmentInput[]
    const submittedAt = Date.now() + serverOffsetMs
    set({ sending: true })
    try {
      const result = await client.prompt(activeTaskId, {
        text,
        modelId: selectedModelId ?? undefined,
        // P0：仅用户显式切换过（ask/auto）才下发 permissionMode；follow 保持任务原权限
        permissionMode: toolAccessMode === 'follow' ? undefined : toolAccessMode === 'ask' ? 'default' : toolAccessMode,
        attachments: attachments.length ? attachments : undefined,
      })
      // SSE 正常时 user_message 已先到；这里作为断流时的 fallback 按 id 幂等补齐。
      // P1 修复：SSE 的 user_message 只带 text 不带 attachments——SSE 先到时这里必须 merge
      // 补上附件，否则「拍照直接发送」在 AI 回答的几秒内显示空白用户气泡。
      set((state) => {
        if (result.receipt) return resetTransientOverrides()
        const fallback: RemoteHistoryMessage = {
          id: result.userMessageId,
          role: 'user',
          text,
          createdAt: submittedAt,
          attachments: pendingAttachments.length ? pendingAttachments.map((a) => ({ name: a.name })) : undefined,
        }
        const existing = state.live[activeTaskId]?.[result.userMessageId]
        return {
          live: {
            ...state.live,
            [activeTaskId]: {
              ...(state.live[activeTaskId] ?? {}),
              [result.assistantMessageId]: {
                ...(state.live[activeTaskId]?.[result.assistantMessageId] ?? {
                  id: result.assistantMessageId, role: 'assistant' as const, text: '', createdAt: submittedAt + 0.01, streaming: true,
                }), replyToId: result.userMessageId,
              },
              [result.userMessageId]: existing
                ? { ...existing, text: existing.text || text, attachments: existing.attachments ?? fallback.attachments }
                : fallback,
            },
          },
          // P0：显式覆盖已随本条消息下发并被服务端持久化到任务，之后复位为 follow，避免泄漏到其它任务
          ...resetTransientOverrides(),
        }
      })
      const runtime = await client.runtime(activeTaskId).catch((error) => {
        // P1 修复：prompt 已成功（消息已提交主机）。runtime 刷新属于 best-effort 同步，
        // 瞬时失败不得向 composer 抛「发送失败」恢复草稿（会造成重复发送）；由 SSE 重连 / resync 补齐。
        console.warn('runtime refresh after prompt failed', error)
        return null
      })
      if (runtime) set((state) => ({ runtimes: { ...state.runtimes, [activeTaskId]: runtime } }))
    } finally {
      set({ sending: false })
    }
  },
  /**
   * ACP 委托发送：与内置 send() 同一套「POST 成功即提交」语义。
   * 电脑端会起真实 ACP 进程；手机端先乐观落用户/助手气泡，流式输出由 SSE agent.patch 补齐，
   * runtime 随后刷新出 running/blocked 与权限卡片。
   */
  async sendAcp(text, pendingAttachments = [], continueFromRunId) {
    const { client, activeTaskId, sending, selectedAcpAgentId, acpNewSession } = get()
    const agentId = selectedAcpAgentId
    if (!client || !activeTaskId || sending) return
    if (!agentId) throw new Error('请先选择 ACP Agent')
    const attachments = pendingAttachments.map(toAttachmentInput).filter(Boolean) as RemoteAttachmentInput[]
    const submittedAt = Date.now() + serverOffsetMs
    set({ sending: true })
    try {
      const result = await client.acpPrompt(activeTaskId, {
        agentId,
        text,
        continueFromRunId,
        // 显式 continueFromRunId 优先；否则按 acpNewSession 决定「强制新会话 / 自动续接」
        ...(continueFromRunId ? {} : { newSession: acpNewSession || undefined }),
        attachments: attachments.length ? attachments : undefined,
      })
      set((state) => {
        const fallback: RemoteHistoryMessage = {
          id: result.userMessageId,
          role: 'user',
          text,
          createdAt: submittedAt,
          attachments: pendingAttachments.length ? pendingAttachments.map((a) => ({ name: a.name })) : undefined,
        }
        const existing = state.live[activeTaskId]?.[result.userMessageId]
        const assistant = state.live[activeTaskId]?.[result.assistantMessageId] ?? {
          id: result.assistantMessageId, role: 'assistant' as const, text: '', createdAt: submittedAt + 0.01, streaming: true,
        }
        return {
          live: {
            ...state.live,
            [activeTaskId]: {
              ...(state.live[activeTaskId] ?? {}),
              [result.assistantMessageId]: { ...assistant, replyToId: result.userMessageId, acp: result.run },
              [result.userMessageId]: existing
                ? { ...existing, text: existing.text || text, attachments: existing.attachments ?? fallback.attachments }
                : fallback,
            },
          },
        }
      })
      // 立即拉一次 runtime：ACP 启动后马上就要显示「Agent 执行中 / 待授权」，不能等 7 秒轮询
      const runtime = await client.runtime(activeTaskId).catch((error) => {
        console.warn('runtime refresh after acp prompt failed', error)
        return null
      })
      if (runtime) set((state) => ({ runtimes: { ...state.runtimes, [activeTaskId]: runtime } }))
      // 「强制新会话」是一次性动作：本轮已用掉，下一轮回到自动续接
      if (acpNewSession) set({ acpNewSession: false })
    } finally {
      set({ sending: false })
    }
  },
  /**
   * ACP 权限应答：必须回传 Agent 声明的 optionId（allow_once/allow_always/reject_*），
   * 不是内置工具的 allow-once/deny 布尔语义。
   */
  async resolveAcpPermission(toolCallId, optionId) {
    const { client, activeTaskId } = get()
    if (!client || !activeTaskId) return
    await client.approve(activeTaskId, toolCallId, { decision: 'allow-once', optionId })
    await syncTaskHistory(activeTaskId)
  },
  /**
   * 新建任务并直接交给 ACP Agent：任务行由电脑端落库，手机端拿到 task + run 后立即进入该任务。
   * 失败（Agent 不可用/校验失败）由调用方恢复草稿；任务不会被半创建（电脑端回滚）。
   */
  async createAcp(text, pendingAttachments = []) {
    const { client, creating, selectedProjectId, selectedSpaceId, selectedWelcomeMode, selectedModePresetId, selectedAcpAgentId, bootstrap } = get()
    if (!client || creating) return
    if (!selectedAcpAgentId) throw new Error('请先选择 ACP Agent')
    const mode = bootstrap?.taskModes?.find(item => item.id === selectedWelcomeMode)
    if (!mode || !selectedModePresetId || !mode.tags.some(tag => tag.id === selectedModePresetId)) {
      throw new Error('请先选择模式和 Tag；若选项不可用，请更新电脑端并刷新连接')
    }
    if (selectedSpaceId) {
      const space = bootstrap?.spaces.find(item => item.id === selectedSpaceId)
      if (!space || space.effectiveArchived || space.archived || space.pathMissing) throw new Error('所选空间文件夹已不可用，请重新选择或在电脑端修复')
    }
    if (selectedProjectId && !bootstrap?.projects.some(project => project.id === selectedProjectId && !project.archived)) {
      throw new Error('所选项目已不可用，请重新选择')
    }
    const attachments = pendingAttachments.map(toAttachmentInput).filter(Boolean) as RemoteAttachmentInput[]
    const submittedAt = Date.now() + serverOffsetMs
    set({ creating: true })
    try {
      const result = await client.createAcpTask({
        agentId: selectedAcpAgentId,
        text,
        spaceId: selectedSpaceId ?? undefined,
        projectId: selectedProjectId ?? undefined,
        welcomeMode: mode.id,
        modePresetId: selectedModePresetId,
        attachments: attachments.length ? attachments : undefined,
      })
      await refresh().catch((error) => console.warn('bootstrap refresh after acp create failed', error))
      saveLastActiveTaskId(result.task.id)
      rememberAcpAgentForTask(result.task.id, selectedAcpAgentId)
      set((state) => {
        const fallback: RemoteHistoryMessage = {
          id: result.userMessageId,
          role: 'user',
          text,
          createdAt: submittedAt,
          attachments: pendingAttachments.length ? pendingAttachments.map(a => ({ name: a.name })) : undefined,
        }
        const existing = state.live[result.task.id]?.[result.userMessageId]
        return {
          activeTaskId: result.task.id,
          live: {
            ...state.live,
            [result.task.id]: {
              ...(state.live[result.task.id] ?? {}),
              [result.assistantMessageId]: {
                id: result.assistantMessageId, role: 'assistant' as const, text: '', createdAt: submittedAt + 0.01,
                streaming: true, replyToId: result.userMessageId, acp: result.run,
              },
              [result.userMessageId]: existing
                ? { ...existing, text: existing.text || text, attachments: existing.attachments ?? fallback.attachments }
                : fallback,
            },
          },
          // 新任务已提交：空间/项目/Tag 一次性选择复位；ACP Agent 保持粘性（下一轮还是它）
          ...resetTransientOverrides(),
        }
      })
      const runtime = await client.runtime(result.task.id).catch(() => null)
      if (runtime) set((state) => ({ runtimes: { ...state.runtimes, [result.task.id]: runtime } }))
    } finally {
      set({ creating: false })
    }
  },
  async create(text, pendingAttachments = []) {
    const { client, creating, selectedModelId, toolAccessMode, selectedProjectId, selectedSpaceId, selectedWelcomeMode, selectedModePresetId, bootstrap } = get()
    if (!client || creating) return
    const mode = bootstrap?.taskModes?.find(mode => mode.id === selectedWelcomeMode)
    if (!mode || !selectedModePresetId || !mode.tags.some(tag => tag.id === selectedModePresetId)) {
      throw new Error('请先选择模式和 Tag；若选项不可用，请更新电脑端并刷新连接')
    }
    if (selectedSpaceId) {
      const space = bootstrap?.spaces.find(space => space.id === selectedSpaceId)
      if (!space || space.effectiveArchived || space.archived || space.pathMissing) throw new Error('所选空间文件夹已不可用，请重新选择或在电脑端修复')
    }
    if (selectedProjectId && !bootstrap?.projects.some(project => project.id === selectedProjectId && !project.archived)) {
      throw new Error('所选项目已不可用，请重新选择')
    }
    const attachments = pendingAttachments.map(toAttachmentInput).filter(Boolean) as RemoteAttachmentInput[]
    const submittedAt = Date.now() + serverOffsetMs
    set({ creating: true })
    try {
      const result = await client.createTask({
        text,
        spaceId: selectedSpaceId ?? undefined,
        projectId: selectedProjectId ?? undefined,
        welcomeMode: mode.id,
        modePresetId: selectedModePresetId,
        modelId: selectedModelId ?? undefined,
        // P0：仅用户显式切换过（ask/auto）才下发；新任务 follow = 跟随电脑端设置
        permissionMode: toolAccessMode === 'follow' ? undefined : toolAccessMode === 'ask' ? 'default' : toolAccessMode,
        attachments: attachments.length ? attachments : undefined,
      })
      // P1 修复：createTask 已成功 = 任务已创建并接受消息。后续 refresh/openTask 属于
      // best-effort 同步，瞬时失败不得向 composer 抛「创建失败」恢复草稿（重发会创建第二个任务）；
      // activeTaskId 与 live 气泡已在上面落地，SSE 重连 / resync 会补齐 history 与 runtime。
      await refresh().catch((error) => console.warn('bootstrap refresh after create failed', error))
      saveLastActiveTaskId(result.task.id)
      // P1 修复：同 send() —— SSE user_message 不带 attachments，这里 merge 补齐而非整体 ?? 覆盖
      set((state) => {
        if (result.receipt) return { activeTaskId: result.task.id, ...resetTransientOverrides() }
        const fallback: RemoteHistoryMessage = {
          id: result.userMessageId,
          role: 'user',
          text,
          createdAt: submittedAt,
          attachments: pendingAttachments.length ? pendingAttachments.map((a) => ({ name: a.name })) : undefined,
        }
        const existing = state.live[result.task.id]?.[result.userMessageId]
        return {
          activeTaskId: result.task.id,
          live: {
            ...state.live,
            [result.task.id]: {
              ...(state.live[result.task.id] ?? {}),
              [result.assistantMessageId]: {
                ...(state.live[result.task.id]?.[result.assistantMessageId] ?? {
                  id: result.assistantMessageId, role: 'assistant' as const, text: '', createdAt: submittedAt + 0.01, streaming: true,
                }), replyToId: result.userMessageId,
              },
              [result.userMessageId]: existing
                ? { ...existing, text: existing.text || text, attachments: existing.attachments ?? fallback.attachments }
                : fallback,
            },
          },
          // P0：显式覆盖已随本条消息下发并被服务端持久化到任务，之后复位为 follow
          ...resetTransientOverrides(),
        }
      })
      await get().openTask(result.task.id).catch((error) => console.warn('openTask after create failed', error))
    } finally {
      set({ creating: false })
    }
  },
  async abort() {
    const { client, activeTaskId } = get()
    if (client && activeTaskId) await client.abort(activeTaskId)
  },
  async approve(toolCallId, decision) {
    const { client, activeTaskId } = get()
    if (!client || !activeTaskId) return
    await client.approve(activeTaskId, toolCallId, { decision })
    await syncTaskHistory(activeTaskId)
  },
  async respondInteraction(interactionId, answer) {
    const { client, activeTaskId } = get()
    if (!client || !activeTaskId) return
    const result = await client.respondInteraction(activeTaskId, interactionId, answer)
    if (!result.ok) throw new Error(result.message)
    taskEventRevisions.set(activeTaskId, (taskEventRevisions.get(activeTaskId) ?? 0) + 1)
    set(state => projectInteraction(state, activeTaskId, result.interaction))
  },
  async cancelInteraction(interactionId) {
    const { client, activeTaskId } = get()
    if (!client || !activeTaskId) return
    const result = await client.cancelInteraction(activeTaskId, interactionId)
    if (!result.ok) throw new Error(result.message)
    taskEventRevisions.set(activeTaskId, (taskEventRevisions.get(activeTaskId) ?? 0) + 1)
    set(state => projectInteraction(state, activeTaskId, result.interaction))
  },
  async readNotification(id) {
    const client = get().client
    if (!client) return
    await client.readNotification(id)
    await refresh()
  },
  async readAllNotifications() {
    const client = get().client
    if (!client) return
    await client.readAllNotifications()
    await refresh()
  },
  async clearAllNotifications() {
    const client = get().client
    if (!client) return
    const currentNotices = get().notifications
    const cleared = getClearedNoticeIds()
    for (const n of currentNotices) {
      cleared.add(n.id)
    }
    saveClearedNoticeIds(cleared)
    set({ notifications: [] })
    try {
      await client.clearAllNotifications()
    } catch (err) {
      console.warn('clearAllNotifications error', err)
      try {
        await client.readAllNotifications()
      } catch {
        // ignore
      }
    }
    await refresh()
  },
}))

/** Read-side synchronization must never navigate or reset composer selections. */
async function syncTaskHistory(taskId: string, beforeEntryId?: number): Promise<void> {
  const client = useRemoteStore.getState().client
  if (!client) return
  const revision = (taskSyncRevisions.get(taskId) ?? 0) + 1
  taskSyncRevisions.set(taskId, revision)
  const eventRevision = taskEventRevisions.get(taskId) ?? 0
  const initialEpoch = useRemoteStore.getState().histories[taskId]?.durable?.epoch
  const [history, runtime] = await Promise.all([client.history(taskId, beforeEntryId), client.runtime(taskId)])
  if (useRemoteStore.getState().client !== client || taskSyncRevisions.get(taskId) !== revision) return
  historyFetchedAt.set(taskId, Date.now())
  historyFetchedEventRevision.set(taskId, taskEventRevisions.get(taskId) ?? 0)
  touchHistoryLru(taskId)
  // 落本地数据库：下次冷启动/切回可直接读取，离线也可看历史
  if (activeServerKey) void saveCachedHistory(activeServerKey, taskId, history, runtime).catch(() => undefined)
  useRemoteStore.setState(state => {
    const newer = (taskEventRevisions.get(taskId) ?? 0) !== eventRevision
    if (history.durable) {
      const current = state.histories[taskId]?.durable;
      if (current && current.epoch !== initialEpoch && current.epoch !== history.durable.epoch) return state;
      if (current?.epoch === history.durable.epoch && current.revision > history.durable.revision) return state;
      return {
        histories: { ...state.histories, [taskId]: history },
        live: { ...state.live, [taskId]: {} },
        runtimes: { ...state.runtimes, [taskId]: { ...(newer ? state.runtimes[taskId] ?? runtime : runtime), busy: history.durable.busy } },
      };
    }
    const settled = { ...(state.live[taskId] ?? {}) }
    if (!runtime.busy && !newer) {
      for (const [id, message] of Object.entries(settled)) {
        if (message.role !== 'assistant') continue
        const historicalTools = new Map(history.messages.flatMap(m => m.tools ?? []).map(t => [t.id, t]))
        settled[id] = { ...message, streaming: false, tools: message.tools?.map(t => historicalTools.get(t.id) ?? t) }
      }
    }
    const live = reconcileLiveMessagesWithHistory(settled, history)
    return {
      histories: { ...state.histories, [taskId]: history },
      runtimes: { ...state.runtimes, [taskId]: newer && state.runtimes[taskId] ? state.runtimes[taskId] : runtime },
      live: { ...state.live, [taskId]: live },
    }
  })
}

async function refresh(): Promise<void> {
  const client = useRemoteStore.getState().client
  if (!client) return
  const revision = ++bootstrapRevision
  const [bootstrap, rawNotifications] = await Promise.all([client.bootstrap(), client.notifications()])
  if (useRemoteStore.getState().client !== client || revision !== bootstrapRevision) return
  serverOffsetMs = Number.isFinite(bootstrap.server?.now) ? bootstrap.server.now - Date.now() : 0
  const cleared = getClearedNoticeIds()
  const notifications = rawNotifications.filter(n => !cleared.has(n.id))
  useRemoteStore.setState({ bootstrap, notifications })
  // 每次刷新都把最新任务列表落到本地数据库，保证冷启动快照尽量新
  if (activeServerKey) void saveTaskList(activeServerKey, bootstrap).catch(() => undefined)
}

function projectInteraction(state: State, taskId: string, interaction: RemoteConversationInteraction): Partial<State> {
  const current = state.runtimes[taskId] ?? {
    taskId,
    busy: true,
    pendingActions: [],
    interactions: [],
    activeGoal: null,
  }
  const interactions = current.interactions.some(item => item.id === interaction.id)
    ? current.interactions.map(item => item.id === interaction.id ? interaction : item)
    : [...current.interactions, interaction]
  return { runtimes: { ...state.runtimes, [taskId]: { ...current, interactions } } }
}

function scheduleRemoteSync(): void {
  if (refreshTimer) return
  const client = useRemoteStore.getState().client
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined
    if (client !== useRemoteStore.getState().client) return
    void useRemoteStore.getState().resync().catch(() => {
      // Preserve messages and credentials; foreground polling/reconnect retries reads only.
    })
  }, 150)
}

function projectDurableSnapshot(taskId: string, snapshot: RemoteDurableSnapshot): void {
  useRemoteStore.setState(current => {
    const previous = current.histories[taskId]?.durable;
    if (previous?.epoch === snapshot.epoch && previous.revision >= snapshot.revision) return current;
    const previousHistory = current.histories[taskId];
    return {
      histories: { ...current.histories, [taskId]: { ...previousHistory, taskId, messages: snapshot.messages, durable: snapshot, historyError: undefined } },
      live: { ...current.live, [taskId]: {} },
      runtimes: { ...current.runtimes, [taskId]: { ...(current.runtimes[taskId] ?? { taskId, pendingActions: [], interactions: [], activeGoal: null }), busy: snapshot.busy } },
    };
  });
}

function receiveDurableDelta(taskId: string, delta: RemoteDurableDelta): void {
  const state = useRemoteStore.getState();
  const queue = durableResyncs.get(taskId);
  if (queue?.client === state.client) { queue.buffered.push(delta); if (queue.buffered.length > 256) queue.buffered.shift(); return; }
  const applied = applyDurableDelta<RemoteHistoryMessage, RemoteDurableState>(state.histories[taskId]?.durable, delta);
  if (applied.kind === 'applied') { projectDurableSnapshot(taskId, applied.snapshot); return; }
  if (applied.kind === 'stale' || !state.client) return;
  const request = { client: state.client, buffered: [delta] };
  const initialEpoch = state.histories[taskId]?.durable?.epoch;
  durableResyncs.set(taskId, request);
  void (async () => {
    try {
      const [history, runtime] = await Promise.all([request.client.history(taskId), request.client.runtime(taskId)]);
      if (useRemoteStore.getState().client !== request.client || durableResyncs.get(taskId) !== request) return;
      if (!history.durable) throw new Error('未取得持久会话的完整状态');
      const currentEpoch = useRemoteStore.getState().histories[taskId]?.durable?.epoch;
      if (currentEpoch === initialEpoch || currentEpoch === history.durable.epoch) projectDurableSnapshot(taskId, history.durable);
      useRemoteStore.setState(current => {
        const existing = current.runtimes[taskId];
        const interactions = new Map(runtime.interactions.map(interaction => [interaction.id, interaction]));
        for (const interaction of existing?.interactions ?? []) if ((interactions.get(interaction.id)?.version ?? 0) < interaction.version) interactions.set(interaction.id, interaction);
        return { runtimes: { ...current.runtimes, [taskId]: { ...runtime, ...existing, interactions: [...interactions.values()] } } };
      });
      durableResyncs.delete(taskId);
      const accepted = useRemoteStore.getState().histories[taskId]?.durable;
      if (accepted) {
        const replay = replayDurableDeltas<RemoteHistoryMessage, RemoteDurableState>(accepted, request.buffered);
        projectDurableSnapshot(taskId, replay.snapshot);
        if (replay.gap) throw new Error('增量仍有缺口，请重新打开会话');
      }
    } catch (error) {
      if (useRemoteStore.getState().client === request.client) useRemoteStore.setState({ error: `会话同步失败：${error instanceof Error ? error.message : String(error)}` });
    } finally { if (durableResyncs.get(taskId) === request) durableResyncs.delete(taskId); }
  })();
}

export function applyEvent(event: RemoteEventEnvelope): void {
  const state = useRemoteStore.getState()
  if (event.type === 'resync_required' || event.type === 'notification.changed' || event.type === 'task.changed') {
    scheduleRemoteSync()
    return
  }
  if (event.type === 'pending_action.changed') {
    const payload = event.payload as {
      taskId: string
      pendingActions: RemoteRuntimeSnapshot['pendingActions']
      acpRun?: RemoteRuntimeSnapshot['acpRun']
    }
    useRemoteStore.setState(current => ({
      runtimes: { ...current.runtimes, [payload.taskId]: {
        ...(current.runtimes[payload.taskId] ?? { taskId: payload.taskId, busy: true, interactions: [], activeGoal: null }),
        pendingActions: payload.pendingActions,
        ...(payload.acpRun !== undefined ? { acpRun: payload.acpRun } : {}),
      } },
    }))
    return
  }
  if (event.type !== 'agent.patch') return
  const patch = event.payload as Record<string, unknown>
  // A Work projection is only a wakeup: the device then reads the durable journal, so an
  // SSE id can never act as the Work cursor.
  if (patch.type === 'work_projection_snapshot') {
    const client = useRemoteStore.getState().client
    if (client) void useRemoteWorkStore.getState().refresh(client)
    return
  }
  const taskId = String(patch.taskId ?? '')
  if (!taskId) return
  taskEventRevisions.set(taskId, (taskEventRevisions.get(taskId) ?? 0) + 1)
  if (patch.type === 'durable_snapshot' && patch.snapshot) {
    const snapshot = patch.snapshot as import('@mybuddy/shared').RemoteDurableSnapshot;
    projectDurableSnapshot(taskId, snapshot);
    return;
  }
  if (patch.type === 'durable_delta' && patch.delta) {
    receiveDurableDelta(taskId, patch.delta as RemoteDurableDelta);
    return;
  }
  if (patch.type === 'conversation_interaction_snapshot' && patch.interaction && typeof patch.interaction === 'object') {
    useRemoteStore.setState(current => projectInteraction(current, taskId, patch.interaction as RemoteConversationInteraction))
    return
  }
  useRemoteStore.setState(current => {
    const live = reduceRemotePatch(current.live[taskId] ?? {}, current.histories[taskId]?.messages ?? [], event)
    const lifecycle = patch.type === 'assistant_start' || patch.type === 'assistant_end'
    const busy = patch.type === 'assistant_start'
    return {
      live: { ...current.live, [taskId]: live },
      ...(lifecycle ? { runtimes: { ...current.runtimes, [taskId]: {
        ...(current.runtimes[taskId] ?? { taskId, pendingActions: [], interactions: [], activeGoal: null }), busy,
      } } } : {}),
    }
  })
  if (patch.type === 'assistant_end' || patch.type === 'user_message' || patch.type === 'artifact_ref') scheduleRemoteSync()
}
