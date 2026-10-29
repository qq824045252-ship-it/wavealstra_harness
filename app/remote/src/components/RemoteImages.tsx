import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { RemoteImageArtifact } from '@mybuddy/shared'
import { resolveRemoteImageReference } from '../../../../shared/src/remote-images'
import { RemoteClient } from '../api/RemoteClient'
import { useRemoteStore } from '../store/remoteStore'

/**
 * 图片一律「默认链接形式」，且**渲染结果是纯函数**。
 *
 * 两条硬约束（都是踩过的坑）：
 * 1. 不内联 <img>：解码前后高度会变，长对话滚动位置被反复修正，表现为聊天记录乱跳。
 * 2. 不用「挂载时注册、卸载时注销」的计数来决定图片显示位置：那会让同一张图先出现在消息
 *    底部、下一帧再跳到正文位置（或者反过来），表现为「有时有、有时没有」。现在由
 *    (markdown 文本, 产物清单) 直接算出「正文提过哪些图」，与渲染顺序完全无关。
 */

const EMPTY_IMAGES: RemoteImageArtifact[] = []
export interface RemoteImageScopeValue { taskId: string; images: readonly RemoteImageArtifact[] }
const Scope = createContext<RemoteImageScopeValue | null>(null)
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

function formatKind(mimeType?: string): string {
  return mimeType?.split('/')[1]?.toUpperCase() ?? ''
}

/**
 * 从 markdown 源码里算出「正文引用过哪些产物图」。
 * 与 urlTransform 用的是同一个 resolveRemoteImageReference，因此判定口径完全一致。
 */
export function mentionedImageIds(text: string, images: readonly RemoteImageArtifact[]): Set<string> {
  const ids = new Set<string>()
  if (!images.length) return ids
  const pattern = /!?\[[^\]]*\]\(\s*([^)\s]+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const image = resolveRemoteImageReference(match[1]!, images)
    if (image) ids.add(image.id)
  }
  // 已经是内部引用形式（mybuddy-artifact://local/<id>）时直接取 id
  const direct = /mybuddy-artifact:\/\/local\/([^\s)"'>]+)/g
  while ((match = direct.exec(text)) !== null) {
    try { ids.add(decodeURIComponent(match[1]!)) } catch { ids.add(match[1]!) }
  }
  return ids
}

/**
 * 图片 → 消息 的归属解析（纯函数，可单测）。
 *
 * 三种数据形态（live 消息 / durable 快照 / 缓存回填）里 message id 会互相不一致，
 * 但**工具调用 id 是稳定的**，所以按以下优先级判定，保证同一张图稳定落在同一条回复下面：
 *   1. createdByToolCallId → 工具调用所属消息（允许 `call_x/1`、`call_x:nested:bash:0` 变体）
 *   2. createdByMessageId 直接命中消息 id
 *   3. durable 序号：消息 id 形如 durable-<n>，取 max(n) <= 图片所属 n 的那条 assistant
 * 三条都不命中才返回 null（调用方放到末尾「其他图片」，不会凭空消失）。
 */
export interface ImageOwnerMessage {
  id: string
  role: 'user' | 'assistant'
  tools?: ReadonlyArray<{ id: string }>
}

function toolBaseCallId(raw: string): string {
  const slash = raw.indexOf('/')
  return (slash > 0 ? raw.slice(0, slash) : raw).replace(/:nested:.*$/, '')
}

function durableOrdinal(id: string): number | null {
  const match = /^durable-(\d+)$/.exec(id)
  return match ? Number(match[1]) : null
}

export function resolveImageOwnerId(image: RemoteImageArtifact, messages: readonly ImageOwnerMessage[]): string | null {
  const toolId = image.createdByToolCallId
  if (toolId) {
    const base = toolBaseCallId(toolId)
    const holder = messages.find(message =>
      (message.tools ?? []).some(tool => toolBaseCallId(tool.id) === base))
    if (holder) return holder.id
  }
  const byMessage = image.createdByMessageId
  if (byMessage && messages.some(message => message.id === byMessage)) return byMessage
  const target = byMessage ? durableOrdinal(byMessage) : null
  if (target !== null) {
    let best: { id: string; ordinal: number } | null = null
    for (const message of messages) {
      if (message.role !== 'assistant') continue
      const ordinal = durableOrdinal(message.id)
      if (ordinal === null || ordinal > target) continue
      if (!best || ordinal > best.ordinal) best = { id: message.id, ordinal }
    }
    if (best) return best.id
  }
  return null
}

function ImageViewer({ label, src, fallback, onClose }: { label: string; src: string | null; fallback?: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [onClose])
  return createPortal(
    <div className="remote-image-viewer" role="dialog" aria-modal="true" aria-label={label} onClick={onClose}>
      <button type="button" autoFocus aria-label="关闭原图" onClick={onClose}>关闭</button>
      {src ? <img src={src} alt={label} onClick={event => event.stopPropagation()} /> : fallback}
    </div>,
    document.body,
  )
}

function ImageChip({ label, detail, onOpen }: { label: string; detail?: string; onOpen: () => void }) {
  return <button type="button" className="remote-image-chip" onClick={onOpen} title="点击查看原图">
    <span className="remote-image-chip-icon" aria-hidden="true">🖼</span>
    <span className="remote-image-chip-label">{label}</span>
    {detail ? <span className="remote-image-chip-detail">{detail}</span> : null}
    <span className="remote-image-chip-action">查看</span>
  </button>
}

/** 任务产物图（走鉴权接口取流）：默认只显示链接，点开后才加载 */
export function RemoteArtifactImageLink({ image, taskId, alt }: { image: RemoteImageArtifact; taskId: string; alt?: string }) {
  const client = useRemoteStore(state => state.client)
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const urlRef = useRef<string | null>(null)
  const label = alt || image.name || '图片'

  useEffect(() => {
    if (!open || !client) return
    let alive = true
    setError(null)
    void loadRemoteImage(client, taskId, image).then(blob => {
      if (!alive) return
      const next = URL.createObjectURL(blob)
      const previous = urlRef.current
      urlRef.current = next
      setUrl(next)
      if (previous) URL.revokeObjectURL(previous)
    }).catch(cause => { if (alive) setError(cause instanceof Error ? cause.message : '图片读取失败') })
    return () => { alive = false }
  }, [open, client, taskId, image, retry])

  useEffect(() => () => {
    if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null }
  }, [])

  return <>
    <ImageChip label={label} detail={formatKind(image.mimeType)} onOpen={() => setOpen(true)} />
    {open && <ImageViewer label={label} src={url} onClose={() => setOpen(false)} fallback={
      <span className="remote-image-status" role="status">
        {error
          ? <>图片无法显示：{error} <button type="button" onClick={() => { setUrl(null); setRetry(n => n + 1) }}>重试</button></>
          : '图片加载中…'}
      </span>
    } />}
  </>
}

export function RemoteMessageImageScope({ taskId, images = EMPTY_IMAGES, children }: {
  taskId: string; images?: readonly RemoteImageArtifact[]; children: ReactNode
}) {
  return <Scope.Provider value={{ taskId, images }}>{children}</Scope.Provider>
}

/** 正文没有引用到的产物图，统一在消息末尾补一条链接 */
export function RemoteImageChipList({ taskId, images }: { taskId: string; images: readonly RemoteImageArtifact[] }) {
  if (!images.length) return null
  return <div className="remote-message-image-links">
    {images.map(image => <RemoteArtifactImageLink key={image.id} image={image} taskId={taskId} />)}
  </div>
}

function RemoteExternalImageLink({ src, alt, title }: { src: string; alt?: string; title?: string }) {
  const [open, setOpen] = useState(false)
  const label = alt || title || '网络图片'
  return <>
    <ImageChip label={label} detail="链接" onOpen={() => setOpen(true)} />
    {open && <ImageViewer label={label} src={src} onClose={() => setOpen(false)} />}
  </>
}

/** markdown 里的图片：默认渲染成链接条，绝不内联撑开高度 */
export function RemoteMarkdownImage({ src = '', alt, title }: { src?: string; alt?: string; title?: string }) {
  const scope = useContext(Scope)
  const image = scope ? resolveRemoteImageReference(src, scope.images) : undefined
  if (image && scope) return <RemoteArtifactImageLink image={image} taskId={scope.taskId} alt={alt} />

  const external = /^https:\/\//i.test(src) ? src
    : /^data:image\/(?:png|jpeg|jpg|gif|webp|bmp|avif);base64,/i.test(src) ? src
      : ''
  if (!external) return <span className="remote-image-status" role="status">图片尚不可用：{alt || '请同步或更新电脑端'}</span>
  return <RemoteExternalImageLink src={external} alt={alt} title={title} />
}
