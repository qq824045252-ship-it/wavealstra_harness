import type { RemoteImageArtifact } from './remote-contract'

/** Comparison only: never turn a model-authored local path into a fetch URL. */
export function normalizeRemoteImageReference(source: string): string | null {
  let value: string
  try { value = decodeURIComponent(source.trim()) } catch { return null }
  if (!value || /[\0\r\n]/.test(value)) return null
  value = value.replace(/^file:\/\/localhost\//i, '/').replace(/^file:\/\//i, '')
    .replace(/\\/g, '/').replace(/^\/([a-z]:\/)/i, '$1')
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:\//i.test(value)) return null
  const absolute = value.startsWith('/')
  const parts: string[] = []
  for (const part of value.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length || /^[a-z]:$/i.test(parts.at(-1)!)) return null
      parts.pop()
    } else parts.push(part)
  }
  // Windows paths are case-insensitive; POSIX paths are not.
  const path = `${absolute ? '/' : ''}${parts.join('/')}`
  return /^[a-z]:\//i.test(path) ? path.toLowerCase() : path
}

export function resolveRemoteImageReference(source: string, images: readonly RemoteImageArtifact[]): RemoteImageArtifact | undefined {
  if (/^mybuddy-artifact:/i.test(source)) {
    try {
      const url = new URL(source)
      const parts = url.pathname.split('/').filter(Boolean)
      if (url.hostname !== 'local' || url.search || url.hash || parts.length !== 1) return undefined
      const id = decodeURIComponent(parts[0]!)
      return images.find(image => image.id === id)
    } catch { return undefined }
  }
  const key = normalizeRemoteImageReference(source)
  if (!key) return undefined
  const matches = images.filter(image => image.sources.some(alias => normalizeRemoteImageReference(alias) === key))
  // Ambiguous aliases must not display the wrong file.
  return matches.length === 1 ? matches[0] : undefined
}

export function remoteImageReference(id: string): string {
  return `mybuddy-artifact://local/${encodeURIComponent(id)}`
}
