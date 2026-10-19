import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { RemoteArtifactMetadata, RemoteImageArtifact } from '@mybuddy/shared'
import { resolveRemoteImageReference } from '../../../../shared/src/remote-images'
import { RemoteClient } from '../api/RemoteClient'
import { useRemoteStore } from '../store/remoteStore'

const EMPTY_IMAGES: RemoteImageArtifact[] = []
const Scope = createContext<{ taskId: string; images: readonly RemoteImageArtifact[]; register: (id: string) => () => void } | null>(null)
type CacheEntry = { promise: Promise<Blob>; bytes: number }
const caches = new WeakMap<RemoteClient, Map<string, CacheEntry>>()
/** Memory-only, session-scoped, bounded cache. Never put bearer tokens in URLs/storage. */
export function loadRemoteImage(client: RemoteClient, taskId: string, image: RemoteImageArtifact): Promise<Blob> {
  let cache = caches.get(client)
  if (!cache) { cache = new Map(); caches.set(client, cache) }
  const key = JSON.stringify([taskId, image.id, image.version])
  const existing = cache.get(key)
  if (existing) { cache.delete(key); cache.set(key, existing); return existing.promise }
  const entries = cache
  const entry: CacheEntry = { bytes: 0, promise: Promise.resolve(new Blob()) }
  entry.promise = client.image(taskId, image.id, image.version).then(blob => {
    entry.bytes = blob.size
    let bytes = [...entries.values()].reduce((n, e) => n + e.bytes, 0)
    for (const [id, row] of entries) {
      if (entries.size <= 24 && bytes <= 32 * 1024 * 1024) break
      if (id === key) continue
      entries.delete(id); bytes -= row.bytes
    }
    return blob
  }).catch(error => { if (entries.get(key) === entry) entries.delete(key); throw error })
  entries.set(key, entry)
  return entry.promise
}

export function RemoteMessageImageScope({ taskId, images = EMPTY_IMAGES, artifacts, children }: {
  taskId: string; images?: readonly RemoteImageArtifact[]; artifacts?: readonly RemoteArtifactMetadata[]; children: ReactNode
}) {
  const [counts, setCounts] = useState<Record<string, number>>({})
  const register = useCallback((id: string) => {
    setCounts(current => ({ ...current, [id]: (current[id] ?? 0) + 1 }))
    return () => setCounts(current => {
      const next = { ...current }
      if ((next[id] ?? 0) <= 1) delete next[id]; else next[id]--
      return next
    })
  }, [])
  const value = useMemo(() => ({ taskId, images, register }), [taskId, images, register])
  const ids = new Set(artifacts?.filter(a => a.kind === 'image').map(a => a.id))
  const fallback = images.filter(image => ids.has(image.id) && !counts[image.id])
  return <Scope.Provider value={value}>{children}
    {fallback.length > 0 && <div className="remote-message-images">{fallback.map(image => <RemoteArtifactImage key={image.id} image={image} taskId={taskId} />)}</div>}
  </Scope.Provider>
}

function RemoteArtifactImage({ image, taskId, alt }: { image: RemoteImageArtifact; taskId: string; alt?: string }) {
  const client = useRemoteStore(state => state.client)
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const urlRef = useRef<string | null>(null)
  useEffect(() => {
    let alive = true
    setError(null)
    if (!client) return
    void loadRemoteImage(client, taskId, image).then(blob => {
      if (!alive) return
      const next = URL.createObjectURL(blob)
      const previous = urlRef.current
      urlRef.current = next
      setUrl(next)
      // 新图已挂上后再释放旧 URL，避免中途闪成「加载中」。
      if (previous) URL.revokeObjectURL(previous)
    }).catch(cause => { if (alive) setError(cause instanceof Error ? cause.message : '图片读取失败') })
    return () => { alive = false }
  }, [client, taskId, image.id, image.version, retry])
  // object URL 随组件卸载回收；展开态在 id/version 切换时复位。
  useEffect(() => () => {
    if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null }
  }, [])
  useEffect(() => { setExpanded(false) }, [image.id, image.version])
  useEffect(() => {
    if (!expanded) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setExpanded(false) }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [expanded])
  const label = alt || image.name || '生成图片'
  return <span className="remote-image-frame" data-artifact-id={image.id}>
    {error ? <span className="remote-image-status" role="status">图片无法显示：{error} <button type="button" onClick={() => setRetry(n => n + 1)}>重试</button></span>
      : url ? <><img className="remote-artifact-image" src={url} alt={label} decoding="async" referrerPolicy="no-referrer"
        onError={() => setError('图片解码失败')} role="button" tabIndex={0} onClick={() => setExpanded(true)}
        onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setExpanded(true) } }} />
        <button className="remote-image-open" type="button" onClick={() => setExpanded(true)}>查看原图</button></>
      : <span className="remote-image-status" role="status">图片加载中…</span>}
    {expanded && url && createPortal(<div className="remote-image-viewer" role="dialog" aria-modal="true" aria-label={label} onClick={() => setExpanded(false)}>
      <button type="button" autoFocus aria-label="关闭原图" onClick={() => setExpanded(false)}>关闭</button>
      <img src={url} alt={label} onClick={event => event.stopPropagation()} />
    </div>, document.body)}
  </span>
}

export function RemoteMarkdownImage({ src = '', alt, title }: { src?: string; alt?: string; title?: string }) {
  const scope = useContext(Scope)
  const image = scope ? resolveRemoteImageReference(src, scope.images) : undefined
  const id = image?.id
  // 必须在绘制前登记：useEffect 的异步登记会让 fallback 先渲染一次、下一帧再让位给内联图，
  // 表现为「同一张图反复卸载重建」。
  useLayoutEffect(() => { if (scope && id) return scope.register(id) }, [scope?.register, id])
  if (image && scope) return <RemoteArtifactImage image={image} taskId={scope.taskId} alt={alt} />
  // Only safe network/data images reach this component via the URL transform.
  if (/^https:\/\//i.test(src) || /^data:image\/(?:png|jpeg|jpg|gif|webp|bmp|avif);base64,/i.test(src)) {
    return <img className="remote-direct-image" src={src} alt={alt || '图片'} title={title} referrerPolicy="no-referrer" loading="lazy" />
  }
  return <span className="remote-image-status" role="status">图片尚不可用：{alt || '请同步或更新电脑端'}</span>
}
