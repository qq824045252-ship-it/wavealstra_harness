import { createRoot } from 'react-dom/client'
import { App, handleBackNavigation } from '../app/remote/src/App'
import { applyEvent, useRemoteStore } from '../app/remote/src/store/remoteStore'
import type { RemoteBootstrap, RemoteConversationInteraction, RemoteEventEnvelope, RemoteHistoryMessage } from '../shared/src/remote-contract'

const task = { id: 'fixture-task', title: 'Android rendering regression', spaceId: null, projectId: null, status: 'in_progress', updatedAt: 10000, welcomeMode: 'working', modelId: 'test-model', permissionMode: 'readonly', archived: false, expertId: null, modePresetId: null, startAt: null, dueAt: null, isFavorited: false, busy: true, pendingActionCount: 0 }
const bootstrap = { apiVersion: 1, server: { apiVersion: 1, name: 'Fixture', service: 'mybuddy-remote', now: Date.now() }, tasks: [task], spaces: [], projects: [], models: [{ id: 'test-model', name: 'DeepSeek V4.1 Flash', vendor: 'test', supportsReasoning: true, supportsImages: false }], defaultModelId: 'test-model', defaultPermissionMode: 'readonly', device: { id: 'fixture', name: 'Fixture', capabilities: [], createdAt: 1, lastSeenAt: 1 }, unreadNotificationCount: 0 } as RemoteBootstrap
const history: RemoteHistoryMessage[] = []
for (let i = 0; i < 5; i++) {
  history.push({ id: 'u' + i, role: 'user', text: 'Previous question ' + i, createdAt: i * 1000 })
  history.push({ id: 'h' + i, role: 'assistant', text: ('Historical readable paragraph ' + i + '. ').repeat(25), createdAt: i * 1000 + 1 })
}
history.push({ id: 'current-user', role: 'user', text: 'CURRENT_USER: render an SVG and keep tools collapsed.', createdAt: 10000 })
let refreshes = 0, resumes = 0, id = 0
useRemoteStore.setState({
  client: {} as never, bootstrap, activeTaskId: task.id, connection: 'connected', notifications: [], live: {},
  histories: { [task.id]: { taskId: task.id, messages: history } }, runtimes: { [task.id]: { taskId: task.id, busy: true, pendingActions: [], todos: [], interactions: [], activeGoal: null } },
  initialize: async () => undefined, resync: async () => { refreshes++ }, resume: async () => { resumes++ },
})
const event = (type: string, payload: object = {}) => applyEvent({ apiVersion: 1, id: ++id, at: 10000 + id, type: 'agent.patch', payload: { type, taskId: task.id, messageId: 'live-assistant', ...payload } } as RemoteEventEnvelope)
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 120"><rect width="400" height="120" fill="#ddeeff"/><text x="20" y="65" font-size="22">SVG regression PASS</text></svg>'
;(window as any).remoteFixture = {
  navigation(screen: 'home' | 'first' | 'second') {
    const second = { ...task, id: 'second-task', title: 'Second conversation' }
    useRemoteStore.setState({ client: {} as never, bootstrap: { ...bootstrap, tasks: [task, second] },
      activeTaskId: screen === 'home' ? null : screen === 'first' ? task.id : second.id,
      isDrawerOpen: false, isModelSheetOpen: false, isAddToChatOpen: false, isNotificationsOpen: false,
      histories: { [task.id]: { taskId: task.id, messages: history }, [second.id]: { taskId: second.id, messages: [{ id: 'second-answer', role: 'assistant', text: 'SECOND_TASK_ONLY', createdAt: 1 }] } }, live: {},
    })
  },
  panel(panel: 'drawer' | 'model' | 'add' | 'notifications', open: boolean) {
    const s = useRemoteStore.getState()
    const setters = { drawer: s.setDrawerOpen, model: s.setModelSheetOpen, add: s.setAddToChatOpen, notifications: s.setNotificationsOpen }
    setters[panel](open)
  },
  back: handleBackNavigation,
  raster(mode = 'inline', version = 1) {
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII='), c => c.charCodeAt(0))
    const current = (window as any).rasterProbe = { reads: 0, fail: false }
    const rasterClient = { image: async () => { current.reads++; if (current.fail) { current.fail = false; throw new Error('模拟图片暂不可用') }; return new Blob([png], { type: 'image/png' }) } }
    const metadata = { id: 'registered-image', name: '计划图', kind: 'image' as const, version, sources: ['C:\\tasks\\generated\\plan.png', 'generated/plan.png'] }
    const text = mode === 'inline' ? '![Plan](C:\\tasks\\generated\\plan.png)' : mode === 'forward' ? '![Plan](<C:/tasks/generated/plan.png>)' : mode === 'link' ? '[下载图片](C:/tasks/generated/plan.png)' : mode === 'unknown' ? '![Unknown](C:/private/secret.png)' : '图片已生成'
    useRemoteStore.setState({ client: rasterClient as never, activeTaskId: 'raster-task', live: {},
      bootstrap: { ...bootstrap, tasks: [{ ...task, id: 'raster-task', busy: false }] },
      histories: { 'raster-task': { taskId: 'raster-task', imageArtifacts: mode === 'unknown' ? [] : [metadata], messages: [
        { id: 'raster-user', role: 'user', text: '帮我生图', createdAt: 1 },
        { id: 'raster-assistant', role: 'assistant', text, createdAt: 2, artifacts: mode === 'unknown' ? [] : [{ id: metadata.id, name: metadata.name, kind: 'image' }] },
      ] } }, runtimes: { 'raster-task': { taskId: 'raster-task', busy: false, pendingActions: [], todos: [], interactions: [], activeGoal: null } },
    })
  },
  rasterRefresh() { const s = useRemoteStore.getState(); useRemoteStore.setState({ histories: structuredClone(s.histories) }) },
  rasterFailNext() {
    (window as any).rasterProbe.fail = true
    const s = useRemoteStore.getState(); const h = structuredClone(s.histories); h['raster-task'].imageArtifacts![0].version++
    useRemoteStore.setState({ histories: h })
  },

  interaction(kind: RemoteConversationInteraction['kind']) {
    const options = kind === 'confirm'
      ? [{ id: 'yes', label: '确认', recommended: true }, { id: 'no', label: '取消' }]
      : kind === 'single_select' || kind === 'multi_select'
        ? [
            { id: 'balanced', label: '平衡方案', description: '兼顾稳定性与开发量', recommended: true },
            { id: 'stable', label: '稳定优先', description: '优先保持现有链路不变' },
            { id: 'fast', label: '快速推进', description: '接受更大的改动范围' },
          ]
        : []
    const interaction: RemoteConversationInteraction = {
      id: 'fixture-interaction-' + kind,
      taskId: task.id,
      executionId: 'fixture-execution',
      assistantMessageId: 'interaction-assistant',
      kind,
      title: kind === 'confirm' ? '确认继续执行吗？' : kind === 'multi_select' ? '请选择多个处理项' : kind === 'short_text' ? '请输入简短回答' : kind === 'long_text' ? '请补充详细说明' : '请选择处理方式',
      description: '这是 Android request_user_input 结构化回答卡片。',
      options,
      minSelections: kind === 'multi_select' ? 1 : undefined,
      maxSelections: kind === 'multi_select' ? 2 : undefined,
      allowCustom: kind === 'single_select',
      customPlaceholder: kind === 'long_text' ? '详细说明' : kind === 'short_text' ? '简短回答' : kind === 'single_select' ? '其他方案' : undefined,
      status: 'pending',
      version: 1,
      createdAt: Date.now(),
    }
    const probe = (window as any).interactionProbe = { answers: [] as unknown[], cancels: 0 }
    const interactionClient = {
      async respondInteraction(_taskId: string, _interactionId: string, answer: unknown) {
        probe.answers.push(answer)
        return { ok: true, interaction: { ...interaction, status: 'resolved', answer, version: 2, resolvedAt: Date.now() } }
      },
      async cancelInteraction() {
        probe.cancels++
        return { ok: true, interaction: { ...interaction, status: 'cancelled', version: 2, resolvedAt: Date.now() } }
      },
    }
    useRemoteStore.setState({
      client: interactionClient as never,
      bootstrap: { ...bootstrap, tasks: [{ ...task, title: 'Interaction regression', busy: true }] },
      activeTaskId: task.id,
      live: {},
      histories: { [task.id]: { taskId: task.id, messages: [
        { id: 'interaction-user', role: 'user', text: '需要你让我选择后再继续。', createdAt: 1 },
        { id: 'interaction-assistant', role: 'assistant', text: '继续前需要你的决定。', createdAt: 2 },
      ] } },
      runtimes: { [task.id]: { taskId: task.id, busy: true, pendingActions: [], todos: [], interactions: [interaction], activeGoal: null } },
    })
  },

  tableHistory() {
    const compact = [
      '| 时间 | 动作 | 要点 |',
      '| --- | --- | --- |',
      '| 06:50 | 起床，温水 300 ml | 不要把准备时间压到最后 10 分钟 |',
      '| 07:10 | 早餐 | 蛋白质 + 主食 + 一份水果 |',
      '| 12:10 | 午餐 | 先蔬菜，再蛋白质，最后主食 |',
    ].join('\n')
    const wide = [
      '| 指标 | 周一 | 周二 | 周三 | 周四 | 周五 | 周六 | 周日 |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
      '| 训练 | 力量 A | 快走 | 休息 | 力量 B | 间歇 | 长走 | 拉伸 |',
      '| 步数 | 8000 | 9000 | 8000 | 9000 | 10000 | 12000 | 8000 |',
    ].join('\n')
    useRemoteStore.setState({
      bootstrap: { ...bootstrap, tasks: [{ ...task, title: 'Table regression', busy: false }] },
      activeTaskId: task.id,
      live: {},
      histories: { [task.id]: { taskId: task.id, messages: [
        { id: 'table-user', role: 'user', text: '请给我一个表格', createdAt: 1 },
        { id: 'table-assistant', role: 'assistant', text: compact + '\n\n' + wide, createdAt: 2 },
      ] } },
      runtimes: { [task.id]: { taskId: task.id, busy: false, pendingActions: [], todos: [], interactions: [], activeGoal: null } },
    })
  },

  event, svg,
  refreshUnchanged() {
    const state = useRemoteStore.getState()
    // Foreground snapshots contain new objects but the same visible content.
    useRemoteStore.setState({
      bootstrap: structuredClone(state.bootstrap),
      histories: structuredClone(state.histories),
      runtimes: structuredClone(state.runtimes),
    })
  },
  longSvgHistory() {
    const messages: RemoteHistoryMessage[] = []
    for (let i = 0; i < 7; i++) {
      messages.push({ id: 'svg-u' + i, role: 'user', text: 'Historical SVG question ' + i, createdAt: i * 1000 })
      messages.push({ id: 'svg-a' + i, role: 'assistant', text: 'Historical SVG ' + i + '\n\n```svg\n' + svg + '\n```\n\n' + 'Readable history. '.repeat(50), createdAt: i * 1000 + 1 })
    }
    messages.push({ id: 'current-user', role: 'user', text: 'CURRENT_USER: keep my reading position.', createdAt: 10000 })
    useRemoteStore.setState({ histories: { [task.id]: { taskId: task.id, messages } }, live: {} })
  },
  svgReply() { event('assistant_start'); event('thinking_delta', { delta: 'Visible reasoning details.' }); event('text_delta', { delta: 'BEFORE_SVG\n\n```svg\n' + svg + '\n```\n\nAFTER_SVG', final: true }) },
  rawSvg() { event('assistant_message_start'); event('text_delta', { delta: '\n' + svg + '\n', final: true }) },
  toolStart() { event('tool_start', { toolCallId: 'tool-1', tool: 'read', summary: 'fixture.txt', detail: '{"path":"fixture.txt"}', status: 'running' }) },
  toolUpdate() { event('tool_update', { toolCallId: 'tool-1', status: 'success', output: 'ACTUAL_TOOL_OUTPUT' }) },
  tail() { event('text_delta', { delta: '\n\nLIVE_TAIL: new visible reply.', final: true }) },
  counters() { return { refreshes, resumes } },
  failSvg() { event('assistant_message_start'); event('text_delta', { delta: '\n```svg\n<svg xmlns="http://www.w3.org/2000/svg"><script>window.bad=true</script></svg>\n```', final: true }) },
}
createRoot(document.getElementById('root')!).render(<App />)
