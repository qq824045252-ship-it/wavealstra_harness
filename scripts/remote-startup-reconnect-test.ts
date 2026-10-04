import assert from 'node:assert/strict'

function storage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key) },
    setItem: (key, value) => { values.set(key, String(value)) },
  }
}
Object.defineProperty(globalThis, 'localStorage', { value: storage() })
Object.defineProperty(globalThis, 'sessionStorage', { value: storage() })
const { useRemoteStore } = await import('../app/remote/src/store/remoteStore')
const { saveCredential, loadCredential } = await import('../app/remote/src/api/credentialStore')
const credential = { baseUrl: 'https://fixture.invalid', deviceToken: 'fixture-token' }
let mode: 'offline' | 'online' | 'unauthorized' | 'forbidden' = 'offline'
let bootstrapCalls = 0
let gate: Promise<void> | undefined
globalThis.fetch = async (input, options) => {
  const url = String(input)
  if (url.endsWith('/v1/bootstrap')) { bootstrapCalls++; if (gate) await gate }
  if (mode === 'offline') throw new TypeError('Failed to fetch')
  if (mode === 'unauthorized' || mode === 'forbidden') {
    return Response.json({ error: { message: 'Device authorization rejected' } }, { status: mode === 'unauthorized' ? 401 : 403 })
  }
  if (url.endsWith('/v1/events')) {
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(': heartbeat\n\n'))
        options?.signal?.addEventListener('abort', () => controller.error(new Error('Aborted')), { once: true })
      },
    }), { headers: { 'content-type': 'text/event-stream' } })
  }
  return Response.json(url.endsWith('/v1/bootstrap') ? { server: { now: Date.now() }, tasks: [], spaces: [], projects: [], models: [] } : [])
}
const state = () => useRemoteStore.getState()
async function reset(nextMode: typeof mode) {
  await state().disconnect()
  await saveCredential(credential)
  mode = nextMode
  bootstrapCalls = 0
  gate = undefined
}
function pass(name: string) { console.log('PASS ' + name) }
try {
  await reset('offline')
  await state().initialize()
  assert.equal(state().client, null)
  assert.equal(state().connection, 'disconnected')
  assert.deepEqual(await loadCredential(), credential)
  mode = 'online'
  // No online/visibility event: this is what the existing seven-second foreground timer invokes.
  await state().resync()
  assert.equal(state().connection, 'connected')
  assert.equal(bootstrapCalls, 2)
  pass('failed cold start recovers through foreground synchronization without re-pairing')

  await reset('online')
  let release!: () => void
  gate = new Promise<void>(resolve => { release = resolve })
  const starts = [state().initialize(), state().initialize(), state().resync()]
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(bootstrapCalls, 1)
  release()
  await Promise.all(starts)
  assert.equal(state().connection, 'connected')
  pass('startup and foreground triggers share one initial connection')

  for (const rejected of ['unauthorized', 'forbidden'] as const) {
    await reset(rejected)
    await state().initialize()
    assert.equal(state().connection, 'unauthorized')
    await state().resync()
    await state().initialize()
    assert.equal(bootstrapCalls, 1)
    assert.deepEqual(await loadCredential(), credential)
    pass(rejected + ' credentials are retained but are not automatically retried')
  }

  await reset('online')
  gate = new Promise<void>(resolve => { release = resolve })
  const pending = state().initialize()
  await new Promise(resolve => setTimeout(resolve, 10))
  await state().disconnect()
  release()
  await pending
  await state().resync()
  assert.equal(state().client, null)
  assert.equal(state().connection, 'disconnected')
  assert.equal(await loadCredential(), null)
  assert.equal(bootstrapCalls, 1)
  pass('logout invalidates a pending bootstrap and prevents automatic login')

  await reset('online')
  const readingCredential = state().initialize()
  await state().disconnect()
  await readingCredential
  assert.equal(bootstrapCalls, 0)
  assert.equal(state().client, null)
  pass('logout during credential loading cannot resurrect the old connection')

  await state().resync()
  assert.equal(bootstrapCalls, 0)
  pass('an unpaired installation stays on the pairing screen without network requests')
} finally {
  await state().disconnect()
}
