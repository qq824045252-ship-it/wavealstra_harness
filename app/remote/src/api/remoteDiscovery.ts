import { Capacitor, registerPlugin } from '@capacitor/core'

export interface DiscoveredMyBuddy {
  name: string
  hostname: string
  host: string
  port: number
  url: string
  source: 'mdns' | 'udp'
}

interface NativeDiscoveryResult {
  devices: DiscoveredMyBuddy[]
  mdnsError?: string
  udpError?: string
}

interface RemoteDiscoveryPlugin {
  discover(options?: { timeoutMs?: number }): Promise<NativeDiscoveryResult>
}

const NativeDiscovery = registerPlugin<RemoteDiscoveryPlugin>('RemoteDiscovery')

export interface VerifiedMyBuddy extends DiscoveredMyBuddy {
  apiVersion: number
}

async function verifyCandidate(candidate: DiscoveredMyBuddy): Promise<VerifiedMyBuddy | null> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 1400)
  try {
    const response = await fetch(`${candidate.url.replace(/\/$/, '')}/healthz`, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!response.ok) return null
    const body = await response.json() as { ok?: boolean; service?: string; apiVersion?: number }
    if (body.ok !== true || body.service !== 'mybuddy-remote' || typeof body.apiVersion !== 'number') return null
    return { ...candidate, apiVersion: body.apiVersion }
  } catch {
    return null
  } finally {
    window.clearTimeout(timer)
  }
}

export async function discoverMyBuddy(timeoutMs = 3200): Promise<{ devices: VerifiedMyBuddy[]; error?: string }> {
  if (!Capacitor.isNativePlatform()) return { devices: [] }
  try {
    const result = await NativeDiscovery.discover({ timeoutMs })
    const verified = (await Promise.all((result.devices ?? []).map(verifyCandidate)))
      .filter((item): item is VerifiedMyBuddy => item !== null)
    const unique = new Map<string, VerifiedMyBuddy>()
    for (const device of verified) unique.set(device.url, device)
    const error = unique.size === 0 ? [result.mdnsError, result.udpError].filter(Boolean).join('; ') || undefined : undefined
    return { devices: [...unique.values()], error }
  } catch (error) {
    return { devices: [], error: error instanceof Error ? error.message : String(error) }
  }
}
