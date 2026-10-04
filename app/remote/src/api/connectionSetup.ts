import { Capacitor, registerPlugin } from '@capacitor/core'

export const DEFAULT_REMOTE_PORT = 3352

export function normalizeRemoteAddress(input: string): string {
  const value = input.trim()
  if (!value) throw new Error('请填写电脑端显示的访问地址。')
  let url: URL
  try {
    const explicitProtocol = value.includes('://')
    url = new URL(explicitProtocol ? value : `http://${value}`)
    if (!explicitProtocol && !url.port) url.port = String(DEFAULT_REMOTE_PORT)
  } catch { throw new Error('地址格式不正确，请复制电脑端的完整访问地址。') }
  const parts = url.hostname.split('.').map(Number)
  const privateIp = parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
    && (parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168))
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (isUsbAddress(url.origin) || privateIp))) {
    throw new Error('局域网请使用电脑的内网 IP；远程连接请使用 HTTPS 地址。')
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('请填写访问地址，不要附带账号、路径或配对参数。')
  }
  return url.origin
}

export function isUsbAddress(address: string): boolean {
  try { return ['127.0.0.1', 'localhost'].includes(new URL(address).hostname) } catch { return false }
}

export async function checkRemoteService(baseUrl: string): Promise<void> {
  const response = await fetch(`${baseUrl}/healthz`, { cache: 'no-store', signal: AbortSignal.timeout(3000) })
  const body = await response.json() as { ok?: boolean; service?: string; apiVersion?: number }
  if (!response.ok || !body.ok || body.service !== 'mybuddy-remote') throw new Error('这个地址没有运行 Mybuddy 安卓远程服务。')
  if (body.apiVersion !== 1) throw new Error('电脑端远程协议版本不兼容，请更新电脑端 Mybuddy。')
}

export function connectionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const status = (error as { status?: number } | null)?.status
  if (/过期|不存在|密钥无效/.test(message)) return '配对链接已失效，请在电脑端重新点击“USB 配对”或“添加设备”。'
  if (status === 401 || status === 403) return '电脑端已撤销这台手机的授权，请重新配对。'
  if (/Failed to fetch|fetch failed|NetworkError|Load failed|timeout|aborted/i.test(message)) {
    return '连接不到电脑。USB 请在电脑端重新点击“USB 配对”；局域网请确认同一 Wi-Fi 且电脑端选择了“局域网”；Tailscale 请确认两端在线。'
  }
  return message
}

const NativeClipboard = registerPlugin<{ readText(): Promise<{ text: string }> }>('RemoteClipboard')
export async function readPairingClipboard(): Promise<string> {
  return Capacitor.isNativePlatform() ? (await NativeClipboard.readText()).text : navigator.clipboard.readText()
}
