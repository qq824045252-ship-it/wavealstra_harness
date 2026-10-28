import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  Cloud,
  Edit2,
  Globe,
  LoaderCircle,
  Plus,
  Trash2,
} from 'lucide-react'
import {
  type RemoteServerNode,
} from '../api/credentialStore'
import {
  connectionErrorMessage,
  detectChannel,
} from '../api/connectionSetup'
import { useRemoteStore } from '../store/remoteStore'

interface Props {
  brand: ReactNode
  incomingLink: { id: number; url: string } | null
  onConsumed: (id: number) => void
}

export function ConnectPage({ brand }: Props) {
  const connection = useRemoteStore((s) => s.connection)
  const storeError = useRemoteStore((s) => s.error)
  const serverConfig = useRemoteStore((s) => s.serverConfig)
  const activeServer = useRemoteStore((s) => s.activeServer)
  const connected = useRemoteStore((s) => Boolean(s.client && s.bootstrap))

  const [address, setAddress] = useState('')
  const [code, setCode] = useState('')
  const [alias, setAlias] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editBaseUrl, setEditBaseUrl] = useState('')

  const alive = useRef(true)
  const operation = useRef(false)

  useEffect(() => {
    alive.current = true
    void useRemoteStore.getState().refreshServerConfig()
    return () => {
      alive.current = false
    }
  }, [])

  const perform = async (action: () => Promise<void>) => {
    if (operation.current) return
    operation.current = true
    useRemoteStore.getState().setConnectionSettingsOpen(true)
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      await action()
    } catch (cause) {
      if (alive.current) setError(connectionErrorMessage(cause))
    } finally {
      if (alive.current) {
        await useRemoteStore.getState().refreshServerConfig()
        setBusy(false)
      }
      operation.current = false
    }
  }

  const handleConnectDirect = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = address.trim()
    if (!trimmed) {
      setError('请输入电脑连接地址，例如 https://remote.vivioninst.uk')
      return
    }
    const pin = code.replace(/\D/g, '')
    if (pin.length !== 6) {
      setError('请输入电脑端「允许新设备接入」里显示的 6 位配对码')
      return
    }
    void perform(async () => {
      await useRemoteStore.getState().connectByUrl(trimmed, pin, alias.trim() || 'Android')
      useRemoteStore.getState().setConnectionSettingsOpen(false)
    })
  }

  const handleSelectServer = (server: RemoteServerNode) => {
    if (server.id === activeServer?.id && connected) {
      useRemoteStore.getState().setConnectionSettingsOpen(false)
      return
    }
    void perform(async () => {
      await useRemoteStore.getState().switchServer(server.id)
      useRemoteStore.getState().setConnectionSettingsOpen(false)
    })
  }

  const handleDeleteServer = (e: React.MouseEvent, server: RemoteServerNode) => {
    e.stopPropagation()
    if (!window.confirm(`确定要移除电脑“${server.name}”吗？`)) return
    void perform(async () => {
      await useRemoteStore.getState().removeServerNode(server.id)
    })
  }

  const handleStartEdit = (e: React.MouseEvent, server: RemoteServerNode) => {
    e.stopPropagation()
    setEditingNodeId(server.id)
    setEditName(server.name)
    setEditBaseUrl(server.baseUrl)
  }

  const handleSaveEdit = (e: React.FormEvent, serverId: string, reconnect = false) => {
    e.preventDefault()
    if (!editName.trim() || !editBaseUrl.trim()) return
    void perform(async () => {
      await useRemoteStore.getState().updateServerNode(
        serverId,
        { name: editName.trim(), baseUrl: editBaseUrl.trim() },
        reconnect
      )
      setEditingNodeId(null)
      if (reconnect) {
        useRemoteStore.getState().setConnectionSettingsOpen(false)
      }
    })
  }

  const close = () => useRemoteStore.getState().setConnectionSettingsOpen(false)
  const working = busy || connection === 'connecting'
  const hasSavedServers = serverConfig.servers.length > 0

  return (
    <main className="claude-onboard">
      <div className="onboard-content">
        {connected && (
          <button type="button" className="onboard-back" disabled={working} onClick={close}>
            <ArrowLeft size={18} /> 返回聊天
          </button>
        )}

        <div className="onboard-hero">
          {brand}
          <h1 className="onboard-title">{hasSavedServers ? '电脑设备管理' : '连接电脑端 Mybuddy'}</h1>
          <p className="onboard-sub">
            直接输入通道域名即可直连（支持 Cloudflare 域名或 Tailscale 域名）。
          </p>
        </div>

        {/* 已保存电脑列表 */}
        {hasSavedServers && (
          <section className="onboard-servers-section" aria-label="已配置电脑">
            <div className="onboard-section-head">
              <strong>我的电脑列表 ({serverConfig.servers.length})</strong>
              <span>点击切换当前连接</span>
            </div>
            <div className="onboard-server-list">
              {serverConfig.servers.map((server) => {
                const isActive = server.id === activeServer?.id
                const isEditing = editingNodeId === server.id
                return (
                  <div
                    key={server.id}
                    className={`onboard-server-card ${isActive ? 'active' : ''}`}
                    onClick={() => !isEditing && handleSelectServer(server)}
                  >
                    <div className="onboard-server-icon">
                      {server.channel === 'tailscale' ? <Globe size={20} /> : <Cloud size={20} />}
                    </div>

                    <div className="onboard-server-info">
                      {isEditing ? (
                        <form
                          className="onboard-server-edit-form"
                          onSubmit={(e) => handleSaveEdit(e, server.id, false)}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="edit-form-field">
                            <label>电脑别名</label>
                            <input
                              type="text"
                              className="edit-input-field"
                              value={editName}
                              onChange={(e) => setEditName(e.target.value)}
                              placeholder="例如：办公室工作站"
                            />
                          </div>
                          <div className="edit-form-field">
                            <label>
                              通道域名
                              <span className="channel-hint">
                                ({detectChannel(editBaseUrl) === 'tailscale' ? 'Tailscale 域名' : 'Cloudflare 域名'})
                              </span>
                            </label>
                            <input
                              type="text"
                              className="edit-input-field"
                              value={editBaseUrl}
                              onChange={(e) => setEditBaseUrl(e.target.value)}
                              placeholder="https://..."
                              autoCapitalize="none"
                              spellCheck={false}
                            />
                          </div>
                          <div className="edit-form-actions">
                            <button
                              type="submit"
                              className="onboard-rename-btn primary"
                              disabled={working || !editBaseUrl.trim()}
                            >
                              保存域名
                            </button>
                            <button
                              type="button"
                              className="onboard-rename-btn accent"
                              disabled={working || !editBaseUrl.trim()}
                              onClick={(e) => handleSaveEdit(e, server.id, true)}
                            >
                              保存并连接
                            </button>
                            <button
                              type="button"
                              className="onboard-rename-btn cancel"
                              onClick={() => setEditingNodeId(null)}
                            >
                              取消
                            </button>
                          </div>
                        </form>
                      ) : (
                        <>
                          <div className="onboard-server-title">
                            <strong>{server.name}</strong>
                            <span className={`channel-badge ${server.channel}`}>
                              {server.channel === 'tailscale' ? 'Tailscale' : 'Cloudflare'}
                            </span>
                            {isActive && <span className="active-badge">当前使用</span>}
                          </div>
                          <span className="onboard-server-url">{server.baseUrl}</span>
                        </>
                      )}
                    </div>

                    {!isEditing && (
                      <div className="onboard-server-actions">
                        <button
                          type="button"
                          className="icon-action-btn"
                          title="修改域名与别名"
                          disabled={working}
                          onClick={(e) => handleStartEdit(e, server)}
                        >
                          <Edit2 size={15} />
                        </button>
                        <button
                          type="button"
                          className="icon-action-btn danger"
                          title="移除此电脑"
                          disabled={working}
                          onClick={(e) => handleDeleteServer(e, server)}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {/* 极简直连表单：直接输入域名直连 */}
        <section className="onboard-guide" role="region" aria-label="直连电脑">
          <h2>{hasSavedServers ? '连接另一台电脑' : '直接输入电脑连接地址'}</h2>
          <form className="onboard-direct-connect-form" onSubmit={handleConnectDirect}>
            <label className="direct-input-label">
              <span>电脑连接地址</span>
              <input
                type="text"
                className="onboard-input direct-url-input"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="https://remote.vivioninst.uk"
                autoCapitalize="none"
                spellCheck={false}
              />
            </label>

            <label className="direct-input-label">
              <span>6 位配对码（在电脑端点“允许新设备接入”获取）</span>
              <input
                type="text"
                className="onboard-input direct-url-input direct-code-input"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="123456"
                inputMode="numeric"
                autoComplete="one-time-code"
                spellCheck={false}
              />
            </label>

            <div className="direct-form-actions">
              <button
                type="submit"
                className="onboard-btn-primary direct-connect-btn"
                disabled={working || !address.trim() || code.replace(/\D/g, '').length !== 6}
              >
                连接电脑
              </button>
            </div>
          </form>
        </section>

        {working && (
          <div className="onboard-progress" role="status">
            <LoaderCircle size={18} className="connection-spinner" />
            正在连接电脑，请稍候…
          </div>
        )}

        {message && <div className="onboard-message" role="status">{message}</div>}

        {(error || storeError) && (
          <div className="onboard-error-banner" role="alert">
            {error || connectionErrorMessage(new Error(storeError!))}
          </div>
        )}
      </div>
    </main>
  )
}
