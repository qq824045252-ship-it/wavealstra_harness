import { Capacitor, registerPlugin } from '@capacitor/core'
import { normalizeRemoteAddress } from './connectionSetup'

interface CredentialPlugin {
  saveToken(options: { baseUrl: string; deviceToken: string }): Promise<void>
  loadToken(): Promise<{ baseUrl?: string; deviceToken?: string }>
  clearToken(): Promise<void>
  getInstallationId(): Promise<{ installationId: string }>
}

const NativeCredentials = registerPlugin<CredentialPlugin>('RemoteCredential')
const DEV_KEY = 'mybuddy-remote-dev-credential'
const DEV_INSTALLATION_KEY = 'mybuddy-remote-installation-id'

export interface RemoteCredential { baseUrl: string; deviceToken: string }

export async function saveCredential(value: RemoteCredential): Promise<void> {
  if (Capacitor.isNativePlatform()) return NativeCredentials.saveToken(value)
  sessionStorage.setItem(DEV_KEY, JSON.stringify(value))
}

export async function loadCredential(): Promise<RemoteCredential | null> {
  if (Capacitor.isNativePlatform()) {
    const value = await NativeCredentials.loadToken()
    return value.baseUrl && value.deviceToken ? { baseUrl: value.baseUrl, deviceToken: value.deviceToken } : null
  }
  const raw = sessionStorage.getItem(DEV_KEY)
  if (!raw) return null
  try { return JSON.parse(raw) as RemoteCredential } catch { return null }
}

export async function clearCredential(): Promise<void> {
  if (Capacitor.isNativePlatform()) return NativeCredentials.clearToken()
  sessionStorage.removeItem(DEV_KEY)
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
