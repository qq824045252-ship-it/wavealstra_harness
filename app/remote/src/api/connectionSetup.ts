import { Capacitor, registerPlugin } from '@capacitor/core'

export type RemoteChannel = 'cloudflare' | 'tailscale' | 'custom'

export function detectChannel(baseUrl: string): RemoteChannel {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    if (host.includes('ts.net') || host.includes('tailscale')) return 'tailscale'
    return 'cloudflare'
  } catch {
    return 'cloudflare'
  }
}

export function normalizeRemoteAddress(input: string): string {
  const value = input.trim()
  if (!value) throw new Error('请填写电脑端显示的访问地址。')
  let url: URL
  try {
    const explicitProtocol = value.includes('://')
    url = new URL(explicitProtocol ? value : `https://${value}`)
  } catch {
    throw new Error('地址格式不正确，请填写标准的域名或访问地址。')
  }

  // 严格禁用 127.0.0.1 / localhost 及私有内网 IP
  const host = url.hostname.toLowerCase()
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
    throw new Error('安卓版已移除 USB 本地模式，请使用电脑端的 Cloudflare 域名或 Tailscale 域名。')
  }

  const parts = host.split('.').map(Number)
  const isPrivateIp = parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
    && (parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168))
  if (isPrivateIp || url.protocol === 'http:') {
    throw new Error('安卓版已移除局域网与 HTTP 直连，请使用 Cloudflare 域名或 Tailscale HTTPS 地址。')
  }

  if (url.protocol !== 'https:') {
    throw new Error('远程连接必须使用安全的 HTTPS 地址。')
  }

  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('请填写纯净的域名访问地址，不要附带路径或配对参数。')
  }

  return url.origin
}

export async function checkRemoteService(baseUrl: string): Promise<void> {
  const response = await fetch(`${baseUrl}/healthz`, { cache: 'no-store', signal: AbortSignal.timeout(5000) })
  const body = await response.json() as { ok?: boolean; service?: string; apiVersion?: number }
  if (!response.ok || !body.ok || body.service !== 'mybuddy-remote') throw new Error('这个地址没有运行 Mybuddy 远程服务。')
  if (body.apiVersion !== 1) throw new Error('电脑端远程协议版本不兼容，请更新电脑端 Mybuddy。')
}

export function connectionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const status = (error as { status?: number } | null)?.status
  if (status === 404 || /not_found|Not Found/i.test(message)) return '电脑端版本过旧，缺少域名直连接口。请把电脑端 MyBuddy 升级到最新版本后重试。'
  if (/pair_not_allowed/.test(message)) return '接入窗口没开或配对码不对。请在电脑端「设置 → 远程连接 → 已配对设备」点『允许新设备接入』，把它显示的 6 位配对码填到这里（60 秒内有效）。'
  if (status === 401 || status === 403) return '电脑端拒绝了这次接入。请在电脑端点『允许新设备接入』后重新输入配对码。'
  if (/Failed to fetch|fetch failed|NetworkError|Load failed|timeout|aborted/i.test(message)) {
    return '连接不到电脑。请检查 Cloudflare 域名或 Tailscale 隧道是否在线，并确认电脑端远程服务已开启。'
  }
  return message
}

const NativeClipboard = registerPlugin<{ readText(): Promise<{ text: string }> }>('RemoteClipboard')
export async function readPairingClipboard(): Promise<string> {
  return Capacitor.isNativePlatform() ? (await NativeClipboard.readText()).text : navigator.clipboard.readText()
}
