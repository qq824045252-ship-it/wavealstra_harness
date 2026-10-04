import assert from 'node:assert/strict'
import { buildRemoteTimeline, coalesceAssistantTurnMessages, reconcileLiveMessagesWithHistory, mergeVisibleText, type LiveRemoteMessage } from '../app/remote/src/store/remoteTimeline'
import { reduceRemotePatch } from '../app/remote/src/store/remotePatch'
import { RemoteEventStream } from '../app/remote/src/api/RemoteEventStream'
import { RemoteClient } from '../app/remote/src/api/RemoteClient'
import { applyEvent, useRemoteStore } from '../app/remote/src/store/remoteStore'
import type { RemoteEventEnvelope, RemoteHistoryMessage, RemoteRuntimeSnapshot, RemoteTaskHistory } from '../shared/src/remote-contract'

let passed = 0
function check(name: string, fn: () => void) { fn(); passed++; console.log('PASS ' + name) }
const patch = (type: string, at: number, extra: object = {}): RemoteEventEnvelope => ({ apiVersion: 1, id: at, at, type: 'agent.patch', payload: { type, taskId: 't', messageId: 'a', ...extra } })
const user = (id: string, at: number, text = 'continue'): RemoteHistoryMessage => ({ id, role: 'user', text, createdAt: at })
const tool = (id: string, status = 'running') => ({ id, tool: 'read', summary: 'file.txt', status })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const runtime = (taskId: string, busy = false): RemoteRuntimeSnapshot => ({ taskId, busy, pendingActions: [], todos: [], interactions: [], activeGoal: null })

check('server timestamp beats delayed phone receipt; user always precedes reply', () => {
  let live = reduceRemotePatch({}, [], patch('assistant_start', 101))
  live = reduceRemotePatch(live, [], patch('text_delta', 102, { delta: 'answer', final: true }))
  live = reduceRemotePatch(live, [], patch('user_message', 100, { messageId: 'u', text: 'question', createdAt: 100 }))
  const result = buildRemoteTimeline([], live)
  assert.deepEqual(result.map(x => x.role), ['user', 'assistant'])
  assert.equal(result[1].createdAt, 101)
})
check('late tool update is attached to its historical owner, not a later question', () => {
  const h = [user('u1', 100), { id: 'ha', role: 'assistant' as const, text: '', createdAt: 110, tools: [tool('tool-1')] }, user('u2', 200)]
  const live = reduceRemotePatch({}, h, patch('tool_update', 300, { toolCallId: 'tool-1', status: 'success', output: 'real output' }))
  const result = buildRemoteTimeline(h, live)
  assert.equal(result[1].tools?.[0].output, 'real output')
  assert.equal(result[2].id, 'u2')
})
check('HTTP reply anchor survives local clock skew', () => {
  const result = buildRemoteTimeline([], {
    u: user('u', 1000), a: { id: 'a', role: 'assistant', text: 'reply', createdAt: 1, replyToId: 'u' },
  })
  assert.equal(result[0].role, 'user')
})
check('repeated user messages match history one-to-one, not many-to-one', () => {
  const result = buildRemoteTimeline([user('hu', 100)], { u1: user('u1', 100), u2: user('u2', 110) })
  assert.equal(result.length, 2)
})
check('assistant prose stays visible across tool loops and history/live overlaps', () => {
  const result = coalesceAssistantTurnMessages([
    user('u', 100),
    { id: 'h', role: 'assistant', text: 'first paragraph', thinking: 'reasoning', createdAt: 110, tools: [tool('x', 'success')] },
    { id: 'l', role: 'assistant', text: 'first paragraph\n\nsecond paragraph', createdAt: 120, tools: [tool('x', 'success'), tool('y')] },
  ])
  assert.equal(result[1].text, 'first paragraph\n\nsecond paragraph')
  assert.equal(result[1].thinking, 'reasoning')
  assert.equal(result[1].tools?.length, 2)
})
check('tool cycles freeze text segments rather than clearing or concatenating code fences', () => {
  let live = reduceRemotePatch({}, [], patch('text_delta', 101, { delta: 'before', final: true }))
  live = reduceRemotePatch(live, [], patch('assistant_message_start', 102))
  live = reduceRemotePatch(live, [], patch('text_delta', 103, { delta: 'after', final: true }))
  live = reduceRemotePatch(live, [], patch('text_delta', 104, { delta: 'process-only', final: false }))
  assert.equal(live.a.text, 'before\n\nafter')
  assert.equal(live.a.thinking, 'process-only')
})
check('partial tool updates retain status and expose actual output separately from args', () => {
  let live = reduceRemotePatch({}, [], patch('tool_start', 1, { toolCallId: 'x', tool: 'read', detail: '{"path":"file"}', status: 'running' }))
  live = reduceRemotePatch(live, [], patch('tool_update', 2, { toolCallId: 'x', output: 'actual content' }))
  assert.equal(live.a.tools?.[0].status, 'running')
  assert.equal(live.a.tools?.[0].output, 'actual content')
  assert.equal(live.a.tools?.[0].detail, '{"path":"file"}')
})
check('unknown non-message patches never create blank assistant bubbles', () => {
  assert.deepEqual(reduceRemotePatch({}, [], patch('context_usage', 20)), {})
})

check('request_user_input interaction patch reaches Android runtime immediately without creating a blank message', () => {
  const interaction = {
    id: 'interaction-1', taskId: 't', executionId: 'e', assistantMessageId: 'a',
    kind: 'single_select' as const, title: '请选择', options: [{ id: 'one', label: '一' }, { id: 'two', label: '二' }],
    status: 'pending' as const, version: 1, createdAt: 20,
  }
  useRemoteStore.setState({ activeTaskId: 't', histories: {}, live: {}, runtimes: { t: runtime('t', true) } })
  applyEvent({
    apiVersion: 1, id: 21, at: 21, type: 'agent.patch',
    payload: { type: 'conversation_interaction_snapshot', taskId: 't', messageId: 'a', executionId: 'e', interaction },
  })
  const first = useRemoteStore.getState()
  assert.equal(first.runtimes.t.interactions[0]?.id, 'interaction-1')
  assert.deepEqual(first.live, {}, 'structured interaction must not manufacture an assistant text bubble')

  applyEvent({
    apiVersion: 1, id: 22, at: 22, type: 'agent.patch',
    payload: {
      type: 'conversation_interaction_snapshot', taskId: 't', messageId: 'a', executionId: 'e',
      interaction: { ...interaction, status: 'resolved', answer: 'two', version: 2, resolvedAt: 22 },
    },
  })
  const updated = useRemoteStore.getState().runtimes.t.interactions
  assert.equal(updated.length, 1, 'interaction updates replace by id rather than duplicate')
  assert.equal(updated[0]?.status, 'resolved')
  assert.equal(updated[0]?.answer, 'two')
})
check('history cannot delete unmatched buffered output merely because a new question arrived', () => {
  const live: Record<string, LiveRemoteMessage> = { a: { id: 'a', role: 'assistant', text: 'not persisted yet', createdAt: 110 } }
  assert.ok(reconcileLiveMessagesWithHistory(live, { taskId: 't', messages: [user('u1', 100), user('u2', 200)] }).a)
})
check('ended live data is removed only after the history snapshot covers it', () => {
  const live: Record<string, LiveRemoteMessage> = { a: { id: 'a', role: 'assistant', text: 'answer', createdAt: 110, tools: [tool('x', 'success')], streaming: false } }
  assert.equal(Object.keys(reconcileLiveMessagesWithHistory(live, { taskId: 't', messages: [{ ...live.a, id: 'ha' }] })).length, 0)
})
check('overlap merge is exact for partial snapshots and long source', () => {
  assert.equal(mergeVisibleText('abcdef', 'defghi'), 'abcdefghi')
  assert.equal(mergeVisibleText('a'.repeat(8000) + 'tail', 'tail' + 'b'.repeat(8000)).length, 16004)
})

check('live user reconciliation preserves assistant causal identity', () => {
  const history = { taskId: 't', messages: [user('hist-u', 105), { id: 'hist-a', role: 'assistant' as const, text: 'answer', createdAt: 120, tools: [tool('x', 'success')] }] }
  const live = reconcileLiveMessagesWithHistory({
    'live-u': user('live-u', 100),
    a: { id: 'a', role: 'assistant', text: 'answer', createdAt: 101, replyToId: 'live-u', streaming: true, tools: [tool('x')] },
  }, history)
  assert.equal(live.a.replyToId, 'hist-u')
  const result = buildRemoteTimeline(history.messages, live)
  assert.deepEqual(result.map(x => x.role), ['user', 'assistant'])
  assert.equal(result[1].tools?.[0].status, 'running')
})
check('persisted timestamps newer than agent_start do not reverse or duplicate replies', () => {
  const h = [user('hist-u', 105), { id: 'hist-a', role: 'assistant' as const, text: 'answer', createdAt: 120, tools: [tool('x', 'success')] }]
  const result = buildRemoteTimeline(h, { a: { id: 'a', role: 'assistant', text: 'answer', createdAt: 101, replyToId: 'removed-live-user', tools: [tool('x')] } })
  assert.deepEqual(result.map(x => x.role), ['user', 'assistant'])
  assert.equal(result[1].text, 'answer')
})
check('late events bound to an old turn cannot jump below a newer user', () => {
  const result = buildRemoteTimeline([user('u1', 100), user('u2', 200)], {
    a: { id: 'a', role: 'assistant', text: 'old-turn update', createdAt: 300, replyToId: 'u1' },
  })
  assert.deepEqual(result.map(x => x.id), ['u1', 'a', 'u2'])
})

// Restarted servers have smaller event IDs. Reproduce using the actual reconnect loop.
{
  const calls: number[] = [], received: number[] = []
  let stream: RemoteEventStream
  const client = { async eventStream(last: number, signal: AbortSignal, onEvent: (e: RemoteEventEnvelope) => void, onOpen: () => void) {
    calls.push(last); onOpen()
    if (calls.length === 1) {
      onEvent(patch('text_delta', 100, { delta: 'old' }))
      onEvent({ ...patch('noop', 100), type: 'resync_required' })
      return
    }
    onEvent(patch('text_delta', 1, { delta: 'new' }))
    await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }) })
  } } as unknown as RemoteClient
  stream = new RemoteEventStream(client, e => { if (e.type !== 'resync_required') received.push(e.id) }, () => undefined)
  stream.start(); stream.start()
  await sleep(30)
  stream.stop()
  check('server restart resets obsolete SSE cursor and duplicate start creates no second loop', () => {
    assert.deepEqual(calls, [0, 0]); assert.deepEqual(received, [100, 1])
  })
}

// Read-side races exercise the real store, not a substitute implementation.
{
  const pending: Array<{ id: string; resolve: (h: RemoteTaskHistory) => void }> = []
  const fake = {
    history(id: string) { return new Promise<RemoteTaskHistory>(resolve => pending.push({ id, resolve })) },
    async runtime(id: string) { return runtime(id) },
  } as unknown as RemoteClient
  useRemoteStore.setState({ client: fake, activeTaskId: null, histories: {}, live: {}, runtimes: {} })
  const a = useRemoteStore.getState().openTask('A')
  const b = useRemoteStore.getState().openTask('B')
  pending.find(x => x.id === 'B')!.resolve({ taskId: 'B', messages: [user('b', 100)] }); await b
  pending.find(x => x.id === 'A')!.resolve({ taskId: 'A', messages: [user('a', 90)] }); await a
  check('slow A history cannot steal selection from B', () => assert.equal(useRemoteStore.getState().activeTaskId, 'B'))
  const old = useRemoteStore.getState().syncTask('B')
  const newer = useRemoteStore.getState().syncTask('B')
  pending.at(-1)!.resolve({ taskId: 'B', messages: [user('new', 300)] }); await newer
  pending.at(-2)!.resolve({ taskId: 'B', messages: [user('old', 200)] }); await old
  check('late stale snapshots cannot overwrite newer history', () => assert.equal(useRemoteStore.getState().histories.B.messages[0].id, 'new'))
  const homeRead = useRemoteStore.getState().syncTask('B')
  useRemoteStore.getState().goHome()
  pending.at(-1)!.resolve({ taskId: 'B', messages: [] }); await homeRead
  check('background synchronization never reopens a task after Home', () => assert.equal(useRemoteStore.getState().activeTaskId, null))
}
{
  const pendingInteraction = {
    id: 'interaction-race', taskId: 't', executionId: 'e', assistantMessageId: 'a',
    kind: 'single_select' as const, title: '请选择', options: [{ id: 'one', label: '一' }, { id: 'two', label: '二' }],
    status: 'pending' as const, version: 1, createdAt: 1,
  }
  let resolveRuntime!: (value: RemoteRuntimeSnapshot) => void
  const fake = {
    async history() { return { taskId: 't', messages: [] } as RemoteTaskHistory },
    runtime() { return new Promise<RemoteRuntimeSnapshot>(resolve => { resolveRuntime = resolve }) },
    async respondInteraction() {
      return { ok: true as const, interaction: { ...pendingInteraction, status: 'resolved' as const, answer: 'two', version: 2, resolvedAt: 2 } }
    },
  } as unknown as RemoteClient
  useRemoteStore.setState({
    client: fake, activeTaskId: 't', histories: {}, live: {},
    runtimes: { t: { ...runtime('t', true), interactions: [pendingInteraction] } },
  })
  const staleRead = useRemoteStore.getState().syncTask('t')
  await useRemoteStore.getState().respondInteraction('interaction-race', 'two')
  resolveRuntime({ ...runtime('t', true), interactions: [pendingInteraction] })
  await staleRead
  check('a stale runtime snapshot cannot roll a submitted Android answer back to pending', () => {
    assert.equal(useRemoteStore.getState().runtimes.t.interactions[0]?.status, 'resolved')
    assert.equal(useRemoteStore.getState().runtimes.t.interactions[0]?.answer, 'two')
  })
}
{
  const now = Date.now()
  const h: RemoteTaskHistory = { taskId: 't', messages: [user('u', now - 30), { id: 'ha', role: 'assistant', text: 'finished', createdAt: now - 20, tools: [tool('x', 'success')] }] }
  const fake = { async history() { return h }, async runtime() { return runtime('t') } } as unknown as RemoteClient
  useRemoteStore.setState({ client: fake, activeTaskId: 't', histories: {}, runtimes: {}, live: { t: { a: { id: 'a', role: 'assistant', text: 'finished', createdAt: now - 20, tools: [tool('x')], streaming: true } } } })
  await useRemoteStore.getState().syncTask('t')
  check('polling recovers a missed assistant_end without permanent running status', () => {
    assert.equal(useRemoteStore.getState().runtimes.t.busy, false)
    assert.equal(Object.keys(useRemoteStore.getState().live.t).length, 0)
  })
}
{
  let resolve!: (h: RemoteTaskHistory) => void
  const fake = { history() { return new Promise<RemoteTaskHistory>(r => { resolve = r }) }, async runtime() { return runtime('t', false) } } as unknown as RemoteClient
  useRemoteStore.setState({ client: fake, activeTaskId: 't', live: {}, histories: {}, runtimes: {} })
  const read = useRemoteStore.getState().syncTask('t')
  applyEvent(patch('assistant_start', Date.now()))
  resolve({ taskId: 't', messages: [] }); await read
  check('a stale idle snapshot cannot erase a newer running event', () => assert.equal(useRemoteStore.getState().runtimes.t.busy, true))
}
useRemoteStore.setState({ client: null })
console.log(JSON.stringify({ ok: true, passed }))
