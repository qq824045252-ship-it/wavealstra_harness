import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { App } from '../app/remote/src/App'
import { ConnectPage } from '../app/remote/src/components/ConnectPage'
import { useRemoteStore } from '../app/remote/src/store/remoteStore'
import { saveCredential } from '../app/remote/src/api/credentialStore'

const bootstrap = { apiVersion: 1, server: { now: Date.now() }, tasks: [], spaces: [], projects: [{ id: 'project-one', name: '测试项目', archived: false }], models: [{ id: 'm', name: 'DeepSeek V4.1 Flash' }], defaultModelId: 'm', defaultPermissionMode: 'readonly', device: { id: 'fixture' }, unreadNotificationCount: 0 } as never
let clipboard = '', pairFailures = 0, pairCalls = 0
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => clipboard } })
useRemoteStore.setState({ initialize: async () => undefined, resync: async () => undefined, resume: async () => undefined, pair: async () => { pairCalls++; if (pairFailures-- > 0) throw new TypeError('Failed to fetch'); useRemoteStore.setState({ client: {} as never, bootstrap, connection: 'connected' }); await saveCredential({ baseUrl: 'https://fixture.invalid', deviceToken: 'fixture-token' }) } })
function Root() {
  const [mode, setMode] = useState<'connect' | 'app'>('connect')
  const [link, setLink] = useState<{ id: number; url: string } | null>(null)
  Object.assign(window as any, { harness: {
    app() { useRemoteStore.setState({ client: {} as never, bootstrap, connection: 'connected', activeTaskId: null, isConnectionSettingsOpen: false }); setMode('app') },
    connect() { sessionStorage.clear(); useRemoteStore.setState({ client: null, bootstrap: null, error: null, connection: 'disconnected' }); setMode('connect') },
    incoming(url: string, failures = 0) { pairFailures = failures; setLink({ id: Date.now(), url }) },
    paste(text: string) { clipboard = text },
    state() { const s = useRemoteStore.getState(); return { permission: s.toolAccessMode, project: s.selectedProjectId, pairCalls } },
  } })
  return mode === 'app' ? <App /> : <ConnectPage brand={<span>Mybuddy</span>} incomingLink={link} onConsumed={() => setLink(null)} />
}
createRoot(document.getElementById('root')!).render(<Root />)
