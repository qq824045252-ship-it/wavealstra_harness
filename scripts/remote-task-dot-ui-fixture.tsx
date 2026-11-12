/**
 * 安卓端状态点的真实组件夹具：挂载真实 App（HomePage 最近对话 + 抽屉任务列表），
 * 用一个内存假客户端替掉 HTTP，从而在 offscreen Electron 里断言 DOM 与确认调用。
 * 只用于 scripts/remote-task-dot-ui-test.cjs。
 */
import { createRoot } from 'react-dom/client'
import { App } from '../app/remote/src/App'
import { useRemoteStore } from '../app/remote/src/store/remoteStore'
import type { RemoteBootstrap, RemoteTaskSummary, RemoteTaskHistory } from '@mybuddy/shared'
import '../app/remote/src/styles/app.css'

const now = Date.now()
const tasks: RemoteTaskSummary[] = [
  {
    id: 't-running', title: 'DOT_RUNNING', spaceId: null, projectId: null, status: 'in_progress',
    updatedAt: now - 1_000, archived: false, modePresetId: null, startAt: null, dueAt: null,
    isFavorited: false, doneAckedAt: null, busy: true, pendingActionCount: 0,
  },
  {
    id: 't-done-unread', title: 'DOT_DONE_UNREAD', spaceId: null, projectId: null, status: 'completed',
    updatedAt: now - 60_000, archived: false, modePresetId: null, startAt: null, dueAt: null,
    isFavorited: false, doneAckedAt: null, busy: false, pendingActionCount: 0,
  },
  {
    id: 't-done-acked', title: 'DOT_DONE_ACKED', spaceId: null, projectId: null, status: 'completed',
    updatedAt: now - 120_000, archived: false, modePresetId: null, startAt: null, dueAt: null,
    isFavorited: false, doneAckedAt: now - 30_000, busy: false, pendingActionCount: 0,
  },
]

/** 假客户端只记录调用：模拟「电脑端接口不可用」的最差情况，顺带验证本机兜底水位 */
const ackCalls: string[] = []
const fakeClient = {
  ackDone: async (taskId: string) => { ackCalls.push(taskId); return { ok: true } },
  bootstrap: async () => bootstrapSnapshot(),
  notifications: async () => [],
  history: async (taskId: string, before?: number) => before === undefined ? ({ taskId, messages: [] }) : pageHistory(taskId, before),
  runtime: async (taskId: string) => ({ taskId, busy: false, pendingActions: [], interactions: [], activeGoal: null }),
  eventStream: () => new Promise<void>(() => {}),
} as never

function pageHistory(taskId: string, before: number): RemoteTaskHistory {
  const messages = Array.from({ length: 50 }, (_, index) => ({ id: `older-${before - 49 + index}`, role: 'user' as const, text: `OLDER_PAGE_${before}_${index}`, createdAt: index + 1 }))
  return { taskId, messages, durable: { backend: 'pi-durable', historyId: 'history-fixture', epoch: 'history-fixture', revision: 1, conversationId: 'fixture', toolMode: 'native', busy: false, queued: 0, pendingInputs: [], compacting: false, messages, historyBefore: before > 50 ? before - 50 : undefined } }
}
function bootstrapSnapshot(): RemoteBootstrap {
  return {
    apiVersion: 1,
    server: { apiVersion: 1, service: 'mybuddy-remote', name: 'MyBuddy', now: Date.now() },
    spaces: [], projects: [], tasks: tasks.map((task) => ({ ...task })),
    unreadNotificationCount: 0,
    device: { id: 'fixture', name: 'Fixture Phone', createdAt: 1, lastSeenAt: 1, capabilities: [] },
    models: [], defaultModelId: null, defaultPermissionMode: 'default',
  } as RemoteBootstrap
}

useRemoteStore.setState({ client: fakeClient, bootstrap: bootstrapSnapshot(), connection: 'connected' })
createRoot(document.getElementById('root')!).render(<App />)
;(window as unknown as { harness: unknown }).harness = {
  ackCalls,
  history() {
    const history = pageHistory('t-running', 500)
    history.messages = [{ id: 'latest', role: 'user', text: 'LATEST_LIVE', createdAt: 1000 }]
    history.durable!.messages = history.messages
    useRemoteStore.setState({ activeTaskId: 't-running', isDrawerOpen: false, histories: { 't-running': history }, live: {} })
  },
  advance() {
    const history = useRemoteStore.getState().histories['t-running']
    const messages = [{ id: 'latest', role: 'user' as const, text: 'LATEST_UPDATED', createdAt: 1001 }]
    useRemoteStore.setState({ histories: { 't-running': { ...history, messages, durable: { ...history.durable!, messages, revision: 2 } } } })
  },
  store: useRemoteStore,
  state: () => {
    const state = useRemoteStore.getState()
    return {
      activeTaskId: state.activeTaskId,
      isDrawerOpen: state.isDrawerOpen,
      tasks: state.bootstrap?.tasks.map((task) => ({ id: task.id, doneAckedAt: task.doneAckedAt })) ?? [],
    }
  },
}
