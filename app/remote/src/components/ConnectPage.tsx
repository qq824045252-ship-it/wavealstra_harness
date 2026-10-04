import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Clipboard, LoaderCircle, RefreshCw, Usb, Wifi, Globe, ArrowLeft } from 'lucide-react'
import { loadCredential, parsePairingUrl, type RemoteCredential } from '../api/credentialStore'
import { checkRemoteService, connectionErrorMessage, DEFAULT_REMOTE_PORT, isUsbAddress, normalizeRemoteAddress, readPairingClipboard } from '../api/connectionSetup'
import { discoverMyBuddy, type VerifiedMyBuddy } from '../api/remoteDiscovery'
import { useRemoteStore } from '../store/remoteStore'

type Method = 'usb' | 'lan' | 'tailscale'
interface Props {
  brand: ReactNode
  incomingLink: { id: number; url: string } | null
  onConsumed: (id: number) => void
}

export function ConnectPage({ brand, incomingLink, onConsumed }: Props) {
  const connection = useRemoteStore(s => s.connection)
  const storeError = useRemoteStore(s => s.error)
  const connected = useRemoteStore(s => Boolean(s.client && s.bootstrap))
  const [method, setMethod] = useState<Method>('usb')
  const [credential, setCredential] = useState<RemoteCredential | null>(null)
  const [link, setLink] = useState('')
  const [address, setAddress] = useState('')
  const [deviceName, setDeviceName] = useState('Android')
  const [showLink, setShowLink] = useState(false)
  const [showAddress, setShowAddress] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [discovering, setDiscovering] = useState(false)
  const [searched, setSearched] = useState(false)
  const [devices, setDevices] = useState<VerifiedMyBuddy[]>([])
  const alive = useRef(true)
  const operation = useRef(false)
  const searchRevision = useRef(0)
  const handledLink = useRef<number | null>(null)
  const usbAddress = credential && isUsbAddress(credential.baseUrl) ? credential.baseUrl : `http://127.0.0.1:${DEFAULT_REMOTE_PORT}`

  useEffect(() => {
    alive.current = true
    void loadCredential().then(value => {
      if (!alive.current) return
      setCredential(value)
      setAddress(value?.baseUrl ?? '')
      if (value) setMethod(isUsbAddress(value.baseUrl) ? 'usb' : value.baseUrl.startsWith('https:') ? 'tailscale' : 'lan')
    }).catch(cause => { if (alive.current) setError(connectionErrorMessage(cause)) })
    return () => { alive.current = false; ++searchRevision.current }
  }, [])

  const perform = async (action: () => Promise<void>) => {
    if (operation.current) return
    operation.current = true
    useRemoteStore.getState().setConnectionSettingsOpen(true)
    setBusy(true); setError(null); setMessage(null)
    try { await action() }
    catch (cause) { if (alive.current) setError(connectionErrorMessage(cause)) }
    finally {
      const saved = await loadCredential().catch(() => null)
      if (alive.current) { setCredential(saved); setBusy(false) }
      operation.current = false
    }
  }

  const pairLink = async (value: string) => {
    const parsed = parsePairingUrl(value)
    await useRemoteStore.getState().pair({ ...parsed, deviceName: deviceName.trim() || 'Android' })
    useRemoteStore.getState().setConnectionSettingsOpen(false)
  }

  useEffect(() => {
    if (!incomingLink || busy || handledLink.current === incomingLink.id) return
    handledLink.current = incomingLink.id
    void perform(() => pairLink(incomingLink.url)).finally(() => onConsumed(incomingLink.id))
    // The URL event is owned by App, so changing screens never loses a USB pairing request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingLink?.id, busy])

  const reconnect = async (value: string) => {
    const baseUrl = normalizeRemoteAddress(value)
    await checkRemoteService(baseUrl)
    if (!await useRemoteStore.getState().connectDiscovered(baseUrl)) throw new Error('首次连接需要配对，请先在电脑端点击“USB 配对”或“添加设备”。')
    useRemoteStore.getState().setConnectionSettingsOpen(false)
  }

  const checkUsb = () => perform(async () => {
    await checkRemoteService(usbAddress)
    if (credential) await reconnect(usbAddress)
    else setMessage('USB 通道已就绪。请在电脑端点击这台手机旁的“USB 配对”，手机会自动进入首页。')
  })

  const search = async () => {
    const revision = ++searchRevision.current
    setDiscovering(true); setSearched(false)
    try {
      const result = await discoverMyBuddy()
      if (alive.current && revision === searchRevision.current) { setDevices(result.devices); setSearched(true) }
    } finally { if (alive.current && revision === searchRevision.current) setDiscovering(false) }
  }

  const paste = () => perform(async () => {
    setShowLink(true)
    const value = (await readPairingClipboard()).trim()
    if (!value) throw new Error('剪贴板为空。请将电脑端生成的配对链接发送到手机并复制，或长按下方输入框粘贴。')
    setLink(value)
    await pairLink(value)
  })

  const close = () => useRemoteStore.getState().setConnectionSettingsOpen(false)
  const working = busy || connection === 'connecting'
  return <main className="claude-onboard">
    <div className="onboard-content">
      {connected && <button type="button" className="onboard-back" disabled={working} onClick={close}><ArrowLeft size={18} /> 返回聊天</button>}
      <div className="onboard-hero">{brand}<h1 className="onboard-title">{connected ? '连接设置' : '连接电脑端 Mybuddy'}</h1>
        <p className="onboard-sub">手机使用电脑端的模型、项目和任务。首次配对后，配置会自动同步。</p>
      </div>
      {credential && <div className="onboard-saved"><span>{connection === 'connected' ? '已连接' : '已保存配对'} · {credential.baseUrl}</span>
        <button type="button" disabled={working} onClick={() => void perform(() => reconnect(credential.baseUrl))}>重新连接</button></div>}
      <div className="onboard-methods" role="tablist" aria-label="连接方式">
        {([['usb', Usb, 'USB'], ['lan', Wifi, '局域网'], ['tailscale', Globe, 'HTTPS 远程']] as const).map(([id, Icon, title]) =>
          <button key={id} role="tab" aria-selected={method === id} disabled={working} onClick={() => { setMethod(id); setError(null); setMessage(null) }}><Icon size={17} />{title}</button>)}
      </div>
      <section className="onboard-guide" role="tabpanel" aria-label={`${method === 'usb' ? 'USB' : method === 'lan' ? '局域网' : 'Tailscale'}连接步骤`}>
        <h2>{method === 'usb' ? 'USB 数据线连接' : method === 'lan' ? '同一 Wi-Fi 下连接' : 'HTTPS 远程连接'}</h2>
        <p className="onboard-desktop-path">电脑端：设置 → 远程连接</p>
        <ol>
          <li>打开电脑端的“远程连接”服务开关。</li>
          {method === 'usb' ? <>
            <li>用数据线连接手机，开启“USB 调试”，并允许这台电脑调试。</li>
            <li>在电脑端“USB 数据线”中找到这台手机，点击“USB 配对”。手机会自动连接。</li>
          </> : method === 'lan' ? <>
            <li>手机与电脑连接同一 Wi-Fi，电脑端“访问范围”选择“局域网”。</li>
            <li>电脑端点击“添加设备”，复制生成的完整配对链接到手机，在下方粘贴。</li>
          </> : <>
            <li>电脑端“Tailscale 远程入口”保存可用的 HTTPS 地址。如果使用 Tailscale，两端需登录同一网络并开启 Serve。</li>
            <li>电脑端点击“添加设备”，复制生成的完整配对链接到手机，在下方粘贴。已配置的其他 HTTPS 入口也可使用。</li>
          </>}
        </ol>
        {method === 'usb' ? <>
          <button type="button" className="onboard-btn-primary" disabled={working} onClick={() => void checkUsb()}><RefreshCw size={18} />检查 USB 并连接</button>
          <p className="onboard-note">USB 拔线后无法连接；重新插线后，在电脑端再点“USB 配对”恢复通道。无需填写 IP 或密钥。</p>
        </> : <>
          <button type="button" className="onboard-btn-primary" disabled={working} onClick={() => void paste()}><Clipboard size={19} />粘贴配对链接</button>
          <div className="onboard-link-actions"><button disabled={working} onClick={() => setShowLink(v => !v)}>手动输入配对链接</button></div>
          {method === 'tailscale' && <p className="onboard-note">访问地址来自电脑端，手机无需配置模型、API Key 或 Serve 命令。已配对时可在下方切换到电脑端的 HTTPS 地址。</p>}
        </>}
      </section>
      {working && <div className="onboard-progress" role="status"><LoaderCircle size={18} className="connection-spinner" />正在连接电脑，请稍候…</div>}
      {message && <div className="onboard-message" role="status">{message}</div>}
      {(error || storeError) && <div className="onboard-error-banner" role="alert">{error || connectionErrorMessage(new Error(storeError!))}</div>}
      {showLink && <form className="onboard-advanced-box" onSubmit={e => { e.preventDefault(); void perform(() => pairLink(link)) }}>
        <label>电脑端生成的完整配对链接<textarea className="onboard-textarea" value={link} onChange={e => setLink(e.target.value)} placeholder="在这里粘贴配对链接，无需手动填写参数" autoCapitalize="none" spellCheck={false} /></label>
        <label>手机名称（可选）<input className="onboard-input" value={deviceName} maxLength={80} onChange={e => setDeviceName(e.target.value)} /></label>
        <button className="onboard-btn-primary" disabled={working || !link.trim()}>使用链接配对</button>
      </form>}
      {method === 'lan' && <section className="onboard-discovery">
        <div className="onboard-discovery-head"><div><strong>查找局域网电脑</strong><span>电脑端必须已选择“局域网”</span></div><button className="onboard-discovery-refresh" disabled={discovering || working} onClick={() => void search()}>{discovering ? '查找中…' : '查找电脑'}</button></div>
        {devices.map(device => <div className="onboard-found-device" key={device.url}><div className="onboard-found-copy"><strong>{device.hostname || device.name}</strong><span>{device.host}:{device.port}</span></div><button className="onboard-found-connect" disabled={working} onClick={() => credential ? void perform(() => reconnect(device.url)) : setShowLink(true)}>{credential ? '连接' : '粘贴链接配对'}</button></div>)}
        {searched && !devices.length && <p className="onboard-note">未找到电脑。请确认同一 Wi-Fi、电脑端已开启局域网访问；也可直接粘贴电脑端生成的配对链接。</p>}
      </section>}
      {credential && <>
        <button className="onboard-advanced-toggle" aria-expanded={showAddress} onClick={() => setShowAddress(v => !v)}>修改连接地址 / 自定义端口</button>
        {showAddress && <form className="onboard-advanced-box" onSubmit={e => { e.preventDefault(); void perform(() => reconnect(address)) }}>
          <label>电脑端显示的访问地址<input className="onboard-input" value={address} onChange={e => setAddress(e.target.value)} placeholder={method === 'tailscale' ? 'https://电脑名称.ts.net' : 'http://192.168.1.10:3352'} autoCapitalize="none" spellCheck={false} /></label>
          <p className="onboard-note">用于同一台电脑切换 USB、局域网或 Tailscale。端口与电脑端“监听端口”一致，更换电脑请重新配对。</p>
          <button className="onboard-btn-secondary" disabled={working || !address.trim()}>验证地址并连接</button>
        </form>}
      </>}
    </div>
  </main>
}
