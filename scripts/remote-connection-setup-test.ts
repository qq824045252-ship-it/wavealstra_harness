import assert from 'node:assert/strict'
import { normalizeRemoteAddress, connectionErrorMessage } from '../app/remote/src/api/connectionSetup'
import { parsePairingUrl, saveCredential, loadCredential } from '../app/remote/src/api/credentialStore'
import { useRemoteStore } from '../app/remote/src/store/remoteStore'
import type { RemoteClient } from '../app/remote/src/api/RemoteClient'

const storage = () => { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } }
Object.defineProperty(globalThis, 'sessionStorage', { value: storage() })
Object.defineProperty(globalThis, 'localStorage', { value: storage() })
let passed = 0
const pass = (name: string) => { passed++; console.log('PASS ' + name) }
for (const address of ['http://127.0.0.1:3352', 'http://192.168.1.10:3352', 'https://computer.tailnet.ts.net', 'https://remote.example.com']) assert.equal(normalizeRemoteAddress(address), address)
assert.equal(normalizeRemoteAddress('192.168.1.10'), 'http://192.168.1.10:3352')
for (const address of ['http://8.8.8.8:3352', 'file:///etc/passwd', 'https://name:password@host.example', 'https://remote.example.com/path', 'http://192.168.1.999:3352']) assert.throws(() => normalizeRemoteAddress(address))
assert.throws(() => parsePairingUrl('192.168.1.10'), /完整配对链接/)
assert.throws(() => parsePairingUrl('https://example.com'), /不是 Mybuddy 配对链接/)
assert.throws(() => parsePairingUrl('mybuddy://pair?baseUrl=http://127.0.0.1:3352'), /不完整/)
pass('USB, LAN and HTTPS addresses accept useful input and reject unsafe or incomplete configuration')
assert.match(connectionErrorMessage(new TypeError('Failed to fetch')), /USB 配对/)
assert.match(connectionErrorMessage(new Error('配对请求已过期或不存在')), /重新点击/)
pass('network and expired-pairing failures explain the next action')

let streamAborts = 0
globalThis.fetch = async (input, options) => {
  const url = String(input)
  if (url.startsWith('https://wrong.invalid')) return Response.json({ error: { message: 'revoked' } }, { status: 403 })
  if (url.endsWith('/v1/events')) return new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(': heartbeat\n\n'))
    options?.signal?.addEventListener('abort', () => { streamAborts++; controller.error(new Error('aborted')) }, { once: true })
  } }))
  return Response.json(url.endsWith('/v1/bootstrap') ? { apiVersion: 1, server: { now: Date.now() }, tasks: [], spaces: [], projects: [], models: [] } : [])
}
const original = { baseUrl: 'https://working.invalid', deviceToken: 'fixture-token' }
await saveCredential(original)
await useRemoteStore.getState().initialize()
const workingClient = useRemoteStore.getState().client
await assert.rejects(useRemoteStore.getState().connectDiscovered('https://wrong.invalid'))
assert.equal(useRemoteStore.getState().client, workingClient)
assert.equal(useRemoteStore.getState().connection, 'connected')
assert.deepEqual(await loadCredential(), original)
assert.equal(streamAborts, 0)
pass('a rejected address switch retains the authenticated connection, event stream and saved credential')
await useRemoteStore.getState().disconnect()

const requests: Array<{ permissionMode?: string }> = []
const fake = { async prompt(_id: string, request: object) { requests.push(request); return { userMessageId: 'u', taskId: 't' } }, async runtime() { return { taskId: 't', busy: false, interactions: [] } } } as unknown as RemoteClient
for (const [mode, expected] of [['follow', undefined], ['ask', 'default'], ['readonly', 'readonly'], ['auto', 'auto']] as const) {
  useRemoteStore.setState({ client: fake, activeTaskId: 't', sending: false, toolAccessMode: mode, live: {}, histories: {}, runtimes: {} })
  await useRemoteStore.getState().send('test')
  assert.equal(requests.at(-1)?.permissionMode, expected)
  assert.equal(useRemoteStore.getState().toolAccessMode, 'follow')
}
pass('all desktop permission modes are transmitted explicitly, then reset to follow for later tasks')
useRemoteStore.setState({ client: null })
console.log(JSON.stringify({ ok: true, passed }))
