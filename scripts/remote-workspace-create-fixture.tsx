import { createRoot } from 'react-dom/client'
import { App } from '../app/remote/src/App'
import { useRemoteStore } from '../app/remote/src/store/remoteStore'
import type { RemoteBootstrap, RemotePromptRequest, RemoteTaskSummary } from '../shared/src/remote-contract'

const spaces = [
  { id: 'root', name: '公司空间', parentId: null },
  { id: 'child', name: '项目文件夹', parentId: 'root' },
  { id: 'empty', name: '空文件夹', parentId: 'root' },
  { id: 'missing', name: '路径失效', parentId: null, pathMissing: true },
  { id: 'archived', name: '已归档', parentId: null, archived: true, effectiveArchived: true },
].map(space => ({ archived: false, effectiveArchived: false, pathMissing: false, sortOrder: 0, ...space }))
let bootstrap = { apiVersion: 1, server: { apiVersion: 1, service: 'mybuddy-remote', name: 'Fixture', now: Date.now() },
  spaces, projects: [{ id: 'project', name: '共享项目记忆', updatedAt: 1, archived: false }], tasks: [], models: [],
  unreadNotificationCount: 0, defaultPermissionMode: 'default', defaultModelId: null,
  taskModes: [
    { id: 'working', label: '日常办公', tags: [{ id: 'general-office', label: '通用办公' }, { id: 'web-prototype', label: 'Penpot' }] },
    { id: 'coding', label: '代码开发', tags: [{ id: 'minimal', label: '极简' }, { id: 'custom-dev', label: '自定义开发' }] },
    { id: 'bot', label: 'Bot', tags: [{ id: 'native', label: '原生模式' }, { id: 'codemode', label: 'Code Mode' }] },
  ],
  device: { id: 'fixture', name: 'Fixture', capabilities: [], createdAt: 1, lastSeenAt: 1 } } as RemoteBootstrap
const requests: RemotePromptRequest[] = [], alerts: string[] = []
let failNext = false
const client = {
  bootstrap: async () => structuredClone(bootstrap), notifications: async () => [],
  history: async (taskId: string) => ({ taskId, messages: [] }),
  runtime: async (taskId: string) => ({ taskId, busy: false, pendingActions: [], todos: [], interactions: [], activeGoal: null }),
  createTask: async (request: RemotePromptRequest) => {
    requests.push(request)
    if (failNext) { failNext = false; throw new Error('fixture network unavailable') }
    const task: RemoteTaskSummary = { id: 'created-' + requests.length, title: request.text, spaceId: request.spaceId ?? null,
      projectId: request.projectId ?? null, updatedAt: Date.now(), welcomeMode: request.welcomeMode, archived: false,
      modePresetId: request.modePresetId ?? null, startAt: null, dueAt: null, isFavorited: false, doneAckedAt: null, busy: false, pendingActionCount: 0 }
    bootstrap = { ...bootstrap, tasks: [...bootstrap.tasks, task] }
    return { task, userMessageId: 'u-' + task.id, assistantMessageId: 'a-' + task.id, queued: true }
  },
}
window.alert = value => { alerts.push(String(value)) }
useRemoteStore.setState({ client: client as never, bootstrap, connection: 'connected', activeTaskId: null,
  initialize: async () => {}, resync: async () => {}, resume: async () => {} })
;(window as any).workspaceFixture = {
  inspect: () => { const s = useRemoteStore.getState(); return { requests, alerts, selectedSpaceId: s.selectedSpaceId,
    selectedProjectId: s.selectedProjectId, selectedWelcomeMode: s.selectedWelcomeMode, selectedModePresetId: s.selectedModePresetId,
    activeTaskId: s.activeTaskId, tasks: s.bootstrap?.tasks, creating: s.creating } },
  submit: () => useRemoteStore.getState().create('必须显式选择'),
  removeTag: () => { bootstrap = { ...bootstrap, taskModes: bootstrap.taskModes?.map(mode => ({ ...mode, tags: [] })) }; useRemoteStore.setState({ bootstrap }) },
  oldHost: () => { bootstrap = { ...bootstrap, taskModes: undefined }; useRemoteStore.setState({ bootstrap }) },
  failNext: () => { failNext = true },
  invalidate: () => { bootstrap = { ...bootstrap, spaces: bootstrap.spaces.filter(space => space.id !== 'child') }; useRemoteStore.setState({ bootstrap }) },
}
createRoot(document.getElementById('root')!).render(<App />)
