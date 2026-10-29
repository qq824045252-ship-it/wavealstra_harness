import { Capacitor, registerPlugin } from '@capacitor/core'
import { detectChannel, normalizeRemoteAddress, type RemoteChannel } from './connectionSetup'

interface CredentialPlugin {
  saveToken(options: { baseUrl: string; deviceToken: string }): Promise<void>
  loadToken(): Promise<{ baseUrl?: string; deviceToken?: string }>
  clearToken(): Promise<void>
  saveConfig(options: { configJson: string }): Promise<void>
  loadConfig(): Promise<{ configJson?: string; legacyBaseUrl?: string; legacyDeviceToken?: string }>
  getInstallationId(): Promise<{ installationId: string }>
}

const NativeCredentials = registerPlugin<CredentialPlugin>('RemoteCredential')
const CONFIG_STORAGE_KEY = 'mybuddy-remote-servers-config'
const DEV_KEY = 'mybuddy-remote-dev-credential'
const DEV_INSTALLATION_KEY = 'mybuddy-remote-installation-id'

export interface RemoteServerNode {
  id: string
  name: string
  baseUrl: string
  deviceToken: string
  channel: RemoteChannel
  lastConnectedAt?: number
}

export interface RemoteServerConfig {
  activeServerId: string | null
  servers: RemoteServerNode[]
}

export interface RemoteCredential {
  baseUrl: string
  deviceToken: string
}

function createLegacyNode(baseUrl: string, deviceToken: string): RemoteServerNode {
  return {
    id: crypto.randomUUID(),
    name: '默认电脑',
    baseUrl,
    deviceToken,
    channel: detectChannel(baseUrl),
    lastConnectedAt: Date.now(),
  }
}

export async function loadServerConfig(): Promise<RemoteServerConfig> {
  if (Capacitor.isNativePlatform()) {
    try {
      const res = await NativeCredentials.loadConfig()
      if (res.configJson) {
        const parsed = JSON.parse(res.configJson) as RemoteServerConfig
        if (Array.isArray(parsed.servers)) return parsed
      }
      // 平滑兼容旧版本单条凭据
      if (res.legacyBaseUrl && res.legacyDeviceToken) {
        const legacyNode = createLegacyNode(res.legacyBaseUrl, res.legacyDeviceToken)
        const initialConfig: RemoteServerConfig = {
          activeServerId: legacyNode.id,
          servers: [legacyNode],
        }
        await saveServerConfig(initialConfig)
        return initialConfig
      }
    } catch {
      // 容错降级
    }
  } else {
    const raw = localStorage.getItem(CONFIG_STORAGE_KEY)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as RemoteServerConfig
        if (Array.isArray(parsed.servers)) return parsed
      } catch {
        // ignore
      }
    }
    // Web 开发态兼容
    const devRaw = sessionStorage.getItem(DEV_KEY)
    if (devRaw) {
      try {
        const legacy = JSON.parse(devRaw) as RemoteCredential
        if (legacy.baseUrl && legacy.deviceToken) {
          const legacyNode = createLegacyNode(legacy.baseUrl, legacy.deviceToken)
          const initialConfig: RemoteServerConfig = {
            activeServerId: legacyNode.id,
            servers: [legacyNode],
          }
          await saveServerConfig(initialConfig)
          return initialConfig
        }
      } catch {
        // ignore
      }
    }
  }

  return { activeServerId: null, servers: [] }
}

/** 直接读已落盘配置（不经过 loadServerConfig，避免“迁移 → 保存 → 再迁移”的递归） */
async function readRawConfig(): Promise<RemoteServerConfig | null> {
  try {
    if (Capacitor.isNativePlatform()) {
      const res = await NativeCredentials.loadConfig()
      if (!res.configJson) return null
      const parsed = JSON.parse(res.configJson) as RemoteServerConfig
      return Array.isArray(parsed.servers) ? parsed : null
    }
    const raw = localStorage.getItem(CONFIG_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as RemoteServerConfig
    return Array.isArray(parsed.servers) ? parsed : null
  } catch {
    return null
  }
}

/**
 * 落盘多电脑配置。
 *
 * 不变量：**任何一次保存都不允许“静默变少”** —— 除非调用方显式声明 allowShrink（只有
 * removeServer 会这么做）。历史上正是“保存整份配置 + 顺手写一条镜像”共用键位，把两台
 * 电脑覆盖成一台，表现为切到另一台后再也切不回来。这里加一道合并兜底。
 */
export async function saveServerConfig(config: RemoteServerConfig, options: { allowShrink?: boolean } = {}): Promise<void> {
  let next = config
  if (!options.allowShrink) {
    const persisted = await readRawConfig()
    if (persisted && persisted.servers.length > config.servers.length) {
      const known = new Set(config.servers.map((server) => server.id))
      const survivors = persisted.servers.filter((server) => !known.has(server.id))
      next = { ...config, servers: [...config.servers, ...survivors] }
    }
  }
  const json = JSON.stringify(next)
  if (Capacitor.isNativePlatform()) {
    // 只写配置本身。以前这里还会 saveToken 一个“镜像”，而它和 saveConfig 共用同一个
    // SharedPreferences 键位，结果每次保存都把整份多电脑列表覆盖成单条凭据 —— 切换过一次
    // 电脑再刷新就只剩一台。镜像备份已彻底移除。
    await NativeCredentials.saveConfig({ configJson: json })
    return
  }
  localStorage.setItem(CONFIG_STORAGE_KEY, json)
}

export function getActiveServer(config: RemoteServerConfig): RemoteServerNode | null {
  if (!config.servers.length) return null
  if (config.activeServerId) {
    const found = config.servers.find(s => s.id === config.activeServerId)
    if (found) return found
  }
  return config.servers[0] ?? null
}

export async function upsertServer(node: { id?: string; name: string; baseUrl: string; deviceToken: string }): Promise<{ config: RemoteServerConfig; active: RemoteServerNode }> {
  const current = await loadServerConfig()
  const channel = detectChannel(node.baseUrl)
  const existingIndex = node.id
    ? current.servers.findIndex(s => s.id === node.id)
    : current.servers.findIndex(s => s.baseUrl === node.baseUrl)

  let activeNode: RemoteServerNode
  if (existingIndex >= 0) {
    activeNode = {
      ...current.servers[existingIndex],
      name: node.name || current.servers[existingIndex].name,
      baseUrl: node.baseUrl,
      deviceToken: node.deviceToken,
      channel,
      lastConnectedAt: Date.now(),
    }
    current.servers[existingIndex] = activeNode
  } else {
    activeNode = {
      id: node.id || crypto.randomUUID(),
      name: node.name || '我的电脑',
      baseUrl: node.baseUrl,
      deviceToken: node.deviceToken,
      channel,
      lastConnectedAt: Date.now(),
    }
    current.servers.push(activeNode)
  }

  current.activeServerId = activeNode.id
  await saveServerConfig(current)
  return { config: current, active: activeNode }
}

export async function removeServer(serverId: string): Promise<RemoteServerConfig> {
  const current = await loadServerConfig()
  current.servers = current.servers.filter(s => s.id !== serverId)
  if (current.activeServerId === serverId) {
    current.activeServerId = current.servers[0]?.id ?? null
  }
  // 显式删除才允许列表变短
  await saveServerConfig(current, { allowShrink: true })
  return current
}

export async function updateServerNode(serverId: string, patch: { name?: string; baseUrl?: string }): Promise<RemoteServerConfig> {
  const current = await loadServerConfig()
  const target = current.servers.find(s => s.id === serverId)
  if (target) {
    if (patch.name !== undefined) {
      target.name = patch.name.trim() || target.name
    }
    if (patch.baseUrl !== undefined) {
      const normalized = normalizeRemoteAddress(patch.baseUrl)
      target.baseUrl = normalized
      target.channel = detectChannel(normalized)
    }
    await saveServerConfig(current)
  }
  return current
}

export async function renameServer(serverId: string, newName: string): Promise<RemoteServerConfig> {
  return updateServerNode(serverId, { name: newName })
}

export async function setActiveServerId(serverId: string): Promise<RemoteServerConfig> {
  const current = await loadServerConfig()
  const target = current.servers.find(s => s.id === serverId)
  if (target) {
    current.activeServerId = serverId
    target.lastConnectedAt = Date.now()
    await saveServerConfig(current)
  }
  return current
}

/** 兼容旧代码调用 */
export async function saveCredential(value: RemoteCredential): Promise<void> {
  await upsertServer({
    name: '我的电脑',
    baseUrl: value.baseUrl,
    deviceToken: value.deviceToken,
  })
}

export async function loadCredential(): Promise<RemoteCredential | null> {
  const config = await loadServerConfig()
  const active = getActiveServer(config)
  return active ? { baseUrl: active.baseUrl, deviceToken: active.deviceToken } : null
}

export async function clearCredential(): Promise<void> {
  const config = await loadServerConfig()
  if (config.activeServerId) {
    await removeServer(config.activeServerId)
  }
}

export async function getInstallationId(): Promise<string> {
  if (Capacitor.isNativePlatform()) {
    const value = await NativeCredentials.getInstallationId()
    return value.installationId
  }
  const existing = localStorage.getItem(DEV_INSTALLATION_KEY)
  if (existing) return existing
  const created = crypto.randomUUID()
  localStorage.setItem(DEV_INSTALLATION_KEY, created)
  return created
}

export function parsePairingUrl(input: string): { baseUrl: string; pairingId: string; secret: string } {
  let url: URL
  try { url = new URL(input.trim()) } catch { throw new Error('请粘贴电脑端“添加设备”生成的完整配对链接。') }
  if (url.protocol !== 'mybuddy:' || url.hostname !== 'pair') throw new Error('这不是 Mybuddy 配对链接，请使用电脑端“添加设备”生成的链接。')
  const baseUrl = url.searchParams.get('baseUrl')?.replace(/\/$/, '')
  const pairingId = url.searchParams.get('pairingId')
  const secret = url.searchParams.get('secret')
  if (!baseUrl || !pairingId || !secret) throw new Error('配对链接不完整，请从电脑端重新复制，不要手动填写参数。')
  return { baseUrl: normalizeRemoteAddress(baseUrl), pairingId, secret }
}
