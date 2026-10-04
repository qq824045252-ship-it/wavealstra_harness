import { create } from 'zustand'
import { reconcileLiveMessagesWithHistory, type LiveRemoteMessage } from './remoteTimeline'
import { reduceRemotePatch } from './remotePatch'
export { coalesceAssistantTurnMessages, reconcileLiveMessagesWithHistory } from './remoteTimeline'
import type {
  RemoteAttachmentInput, RemoteBootstrap, RemoteConnectionState, RemoteConversationInteraction,
  RemoteConversationInteractionAnswer, RemoteEventEnvelope, RemoteHistoryMessage,
  RemoteNotification, RemoteRuntimeSnapshot, RemoteTaskHistory,
} from '@mybuddy/shared'
import { RemoteClient } from '../api/RemoteClient'
import { RemoteEventStream } from '../api/RemoteEventStream'
import { clearCredential, getInstallationId, loadCredential, saveCredential } from '../api/credentialStore'
import { loadLastActiveTaskId, saveLastActiveTaskId } from './remoteUiState'

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
  /**
   * P0 修复：三态权限，'follow' 时不传 permissionMode，服务端保持任务自身权限不变；
   * 'ask' / 'auto' 是手机端的显式覆盖（分别映射 default / auto）。
   */
  toolAccessMode: 'follow' | 'ask' | 'readonly' | 'auto'
  setToolAccessMode: (mode: 'follow' | 'ask' | 'readonly' | 'auto') => void
  selectedProjectId: string | null
  setSelectedProjectId: (id: string | null) => void
  attachments: PendingAttachment[]
  addAttachment: (att: PendingAttachment) => void
  removeAttachment: (id: string) => void
  clearAttachments: () => void
  initialize(): Promise<void>
  resync(): Promise<void>
  resume(): Promise<void>
  syncTask(taskId: string): Promise<void>
  connect(baseUrl: string, token: string): Promise<void>
  connectDiscovered(baseUrl: string): Promise<boolean>
  pair(input: { baseUrl: string; pairingId: string; secret: string; deviceName: string }): Promise<void>
  disconnect(): Promise<void>
  openTask(taskId: string): Promise<void>
  /** 回首页（返回手势 / 左上角返回按钮）；同时丢弃模型/权限的一次性覆盖，避免泄漏到下一个任务 */
  goHome(): void
  send(text: string, attachments?: PendingAttachment[]): Promise<void>
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

const REMOTE_NEW_TASK_DEFAULTS = {
  welcomeMode: 'working' as const,
  modePresetId: 'general-office',
} as const

/**
 * P0 修复：丢弃一次性（transient）的模型/权限/项目覆盖。服务端已把显式选择持久化进任务，
 * 客户端覆盖值在「发送成功 / 切换任务 / 回首页 / 重连」后必须复位为 follow，
 * 否则任务 A 里选的 Auto 会泄漏到任务 B。
 * selectedProjectId 同语义：项目归属是「下一条新消息」的一次性选择，随提交/切换清零。
 */
function resetTransientOverrides(): Partial<State> {
  return { selectedModelId: null, toolAccessMode: 'follow', selectedProjectId: null }
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
let refreshTimer: ReturnType<typeof setTimeout> | undefined

export const useRemoteStore = create<State>((set, get) => ({
  connection: 'disconnected', client: null, bootstrap: null, notifications: [], activeTaskId: null,
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
  toolAccessMode: 'follow',
  setToolAccessMode: (toolAccessMode) => set({ toolAccessMode }),
  selectedProjectId: null,
  setSelectedProjectId: (selectedProjectId) => set({ selectedProjectId }),
  attachments: [],
  addAttachment: (att) => set((s) => ({ attachments: [...s.attachments, att] })),
  removeAttachment: (id) => set((s) => ({ attachments: s.attachments.filter((a) => a.id !== id) })),
  clearAttachments: () => set({ attachments: [] }),
  async initialize() {
    if (get().client || get().connection === 'unauthorized') return
    if (initializationPromise) return initializationPromise
    const revision = connectionRevision
    const attempt = (async () => {
      let credential
      try {
        credential = await loadCredential()
      } catch (error) {
        if (revision === connectionRevision) set({ error: error instanceof Error ? error.message : String(error) })
        return
      }
      // Logout or an explicit connection supersedes a pending credential read.
      if (revision !== connectionRevision || !credential) return
      try {
        await get().connect(credential.baseUrl, credential.deviceToken)
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
    await Promise.all([refresh(), taskId ? syncTaskHistory(taskId) : Promise.resolve()])
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
    const client = new RemoteClient(baseUrl.replace(/\/$/, ''), token)
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
        if (connected) scheduleRemoteSync()
      })
      set({
        client, bootstrap, notifications, connection: 'connected', histories: {}, runtimes: {}, live: {},
        activeTaskId: bootstrap.tasks.some(task => task.id === get().activeTaskId && !task.archived) ? get().activeTaskId : null,
        // P0：默认 'follow'（不传 permissionMode，服务端跟随任务/设置），不再从默认权限推断覆盖值
        // 连接新会话（配对 / 切换服务器 / 重新连接）时清空上个会话遗留的 transient 覆盖
        ...resetTransientOverrides(),
      })
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
      if (status === 401 || status === 403) { stream?.stop(); stream = null; set({ client: null, bootstrap: null }) }
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
  async pair(input) {
    const installationId = await getInstallationId()
    const response = await RemoteClient.pair(input.baseUrl, {
      pairingId: input.pairingId,
      secret: input.secret,
      deviceName: input.deviceName,
      installationId,
    })
    await saveCredential({ baseUrl: input.baseUrl, deviceToken: response.deviceToken })
    await get().connect(input.baseUrl, response.deviceToken)
  },
  async disconnect() {
    ++connectionRevision; ++navigationRevision
    clearTimeout(refreshTimer); refreshTimer = undefined
    stream?.stop(); stream = null
    await clearCredential()
    saveLastActiveTaskId(null)
    set({ connection: 'disconnected', client: null, bootstrap: null, activeTaskId: null, sending: false, creating: false, ...resetTransientOverrides() })
  },
  async openTask(taskId) {
    if (!get().client) return
    ++navigationRevision
    saveLastActiveTaskId(taskId)
    set(state => ({ activeTaskId: taskId, ...(state.activeTaskId !== taskId ? resetTransientOverrides() : {}) }))
    await syncTaskHistory(taskId)
  },
  goHome() {
    ++navigationRevision
    saveLastActiveTaskId(null)
    set({ activeTaskId: null, ...resetTransientOverrides() })
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
  async create(text, pendingAttachments = []) {
    const { client, creating, selectedModelId, toolAccessMode, selectedProjectId } = get()
    if (!client || creating) return
    const attachments = pendingAttachments.map(toAttachmentInput).filter(Boolean) as RemoteAttachmentInput[]
    const submittedAt = Date.now() + serverOffsetMs
    set({ creating: true })
    try {
      const result = await client.createTask({
        text,
        projectId: selectedProjectId ?? undefined,
        // Android 新任务默认进入「日常办公 / 通用办公」；已有任务继续沿用自身 mode/tag。
        welcomeMode: REMOTE_NEW_TASK_DEFAULTS.welcomeMode,
        modePresetId: REMOTE_NEW_TASK_DEFAULTS.modePresetId,
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
async function syncTaskHistory(taskId: string): Promise<void> {
  const client = useRemoteStore.getState().client
  if (!client) return
  const revision = (taskSyncRevisions.get(taskId) ?? 0) + 1
  taskSyncRevisions.set(taskId, revision)
  const eventRevision = taskEventRevisions.get(taskId) ?? 0
  const [history, runtime] = await Promise.all([client.history(taskId), client.runtime(taskId)])
  if (useRemoteStore.getState().client !== client || taskSyncRevisions.get(taskId) !== revision) return
  useRemoteStore.setState(state => {
    const newer = (taskEventRevisions.get(taskId) ?? 0) !== eventRevision
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

export function applyEvent(event: RemoteEventEnvelope): void {
  const state = useRemoteStore.getState()
  if (event.type === 'resync_required' || event.type === 'notification.changed' || event.type === 'task.changed') {
    scheduleRemoteSync()
    return
  }
  if (event.type === 'pending_action.changed') {
    const payload = event.payload as { taskId: string; pendingActions: RemoteRuntimeSnapshot['pendingActions'] }
    useRemoteStore.setState(current => ({
      runtimes: { ...current.runtimes, [payload.taskId]: {
        ...(current.runtimes[payload.taskId] ?? { taskId: payload.taskId, busy: true, interactions: [], activeGoal: null }),
        pendingActions: payload.pendingActions,
      } },
    }))
    return
  }
  if (event.type !== 'agent.patch') return
  const patch = event.payload as Record<string, unknown>
  const taskId = String(patch.taskId ?? '')
  if (!taskId) return
  taskEventRevisions.set(taskId, (taskEventRevisions.get(taskId) ?? 0) + 1)
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
