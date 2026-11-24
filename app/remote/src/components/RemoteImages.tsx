import { UiIcon } from "@mybuddy/shared/icons";
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { RemoteImageArtifact } from '@mybuddy/shared'
import { RemoteClient } from '../api/RemoteClient'
import { useRemoteStore } from '../store/remoteStore'

/**
 * 图片一律「默认链接形式」，且**渲染结果是纯函数**。
 *
 * 两条硬约束（都是踩过的坑）：
 * 1. 不内联 <img>：解码前后高度会变，长对话滚动位置被反复修正，表现为聊天记录乱跳。
 * 2. 一条回复最多只占**一行**图片 UI：一条图一张时显示名字，多张时只显示「N 张图片」，
 *    点开看图廊。逐张挂在气泡里会把同一条回复撞得很高，也让正文里的引用和末尾列表
 *    变成两套口径。
 */

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

/** 一批图的格式摘要：PNG / PNG·JPEG，只占一个小标签 */
function kindSummary(images: readonly RemoteImageArtifact[]): string {
  const kinds = [...new Set(images.map(image => formatKind(image.mimeType)).filter(Boolean))]
  return kinds.join('·')
}

// 归属解析搬去 lib/imageOwner.ts：它只依赖 shared 的类型，组件测试用 esbuild 打包时不会
// 顺着 @mybuddy/shared 桶导入去解析无扩展名的相对模块。这里保留再导出，App 的导入不变。
export { resolveImageOwnerId, type ImageOwnerMessage } from '../lib/imageOwner'
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
    <span className="remote-image-chip-icon" aria-hidden="true"><UiIcon name="image" size="1em" /></span>
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
    // 依赖到 id/version 而不是整个对象：后台同步会重建同一张图的描述对象，
    // 拿对象当依赖会让开着的大图每 7 秒重拉一次、闪一帧。
  }, [open, client, taskId, image.id, image.version, retry])

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

/**
 * 一条回复的图片汇总：**永远只有一行**。
 *   1 张 → 直接显示名字与格式（点开看原图）；
 *   2 张以上 → 只显示「N 张图片」，点开看图廊（一次加载整批，关闭即释放）。
 * 图片落在哪条回复由 App 的稳定规则算好传进来；本组件不知道也不猜归属。
 */
export function RemoteImageSummary({ taskId, images }: { taskId: string; images: readonly RemoteImageArtifact[] }) {
  // 打开时把清单快照下来：后台同步会重建图片描述对象，拿实时数组当依赖会让图廊反复重拉、闪帧
  const [gallery, setGallery] = useState<readonly RemoteImageArtifact[] | null>(null)
  if (!images.length) return null
  const single = images.length === 1 ? images[0] : undefined
  if (single) return <RemoteArtifactImageLink image={single} taskId={taskId} />
  return <>
    <ImageChip label={`${images.length} 张图片`} detail={kindSummary(images)} onOpen={() => setGallery([...images])} />
    {gallery && <ImageGallery taskId={taskId} images={gallery} onClose={() => setGallery(null)} />}
  </>
}

interface LoadedImage { url: string | null; error: string | null }

function ImageGallery({ taskId, images, onClose }: {
  taskId: string; images: readonly RemoteImageArtifact[]; onClose: () => void
}) {
  const client = useRemoteStore(state => state.client)
  const [loaded, setLoaded] = useState<ReadonlyMap<string, LoadedImage>>(new Map())
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [onClose])
  useEffect(() => {
    if (!client) return
    let alive = true
    const created: string[] = []
    void Promise.all(images.map(async (image): Promise<[string, LoadedImage]> => {
      try {
        const blob = await loadRemoteImage(client, taskId, image)
        if (!alive) return [image.id, { url: null, error: null }]
        const url = URL.createObjectURL(blob)
        created.push(url)
        return [image.id, { url, error: null }]
      } catch (cause) {
        return [image.id, { url: null, error: cause instanceof Error ? cause.message : '图片读取失败' }]
      }
    })).then(entries => { if (alive) setLoaded(new Map(entries)) })
    return () => { alive = false; for (const url of created) URL.revokeObjectURL(url) }
  }, [client, taskId, images])
  return createPortal(
    <div className="remote-image-viewer remote-image-gallery" role="dialog" aria-modal="true" aria-label={`本回复的 ${images.length} 张图片`} onClick={onClose}>
      <button type="button" autoFocus aria-label="关闭图片汇总" onClick={onClose}>关闭</button>
      <div className="remote-image-gallery-list" onClick={event => event.stopPropagation()}>
        {images.map(image => {
          const item = loaded.get(image.id)
          return <figure key={image.id} className="remote-image-gallery-item">
            {item?.url ? <img src={item.url} alt={image.name} />
              : <span className="remote-image-status" role="status">{item?.error ? `图片无法显示：${item.error}` : '图片加载中…'}</span>}
            <figcaption>{image.name}</figcaption>
          </figure>
        })}
      </div>
    </div>,
    document.body,
  )
}

function RemoteExternalImageLink({ src, alt, title }: { src: string; alt?: string; title?: string }) {
  const [open, setOpen] = useState(false)
  const label = alt || title || '网络图片'
  return <>
    <ImageChip label={label} detail="链接" onOpen={() => setOpen(true)} />
    {open && <ImageViewer label={label} src={src} onClose={() => setOpen(false)} />}
  </>
}

/** markdown 里的图片：产物图归给本回复的图片汇总（这里不渲染），外链图仍然只给一条链接 */
export function RemoteMarkdownImage({ src = '', alt, title }: { src?: string; alt?: string; title?: string }) {
  // 已解析的产物图：正文位置不再插一张卡片，整条回复的图由 RemoteImageSummary 统一给出
  if (/^mybuddy-artifact:/i.test(src)) return null

  const external = /^https:\/\//i.test(src) ? src
    : /^data:image\/(?:png|jpeg|jpg|gif|webp|bmp|avif);base64,/i.test(src) ? src
      : ''
  if (!external) return <span className="remote-image-status" role="status">图片尚不可用：{alt || '请同步或更新电脑端'}</span>
  return <RemoteExternalImageLink src={external} alt={alt} title={title} />
}
