import { Children, isValidElement, memo, useMemo, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from 'react-markdown'
import type { RemoteArtifactMetadata, RemoteImageArtifact } from '@mybuddy/shared'
import { remoteImageReference, resolveRemoteImageReference } from '../../../../shared/src/remote-images'
import { RemoteMessageImageScope, RemoteMarkdownImage } from './RemoteImages'
import remarkGfm from 'remark-gfm'
// Intentionally the SAME component and validation path as desktop ChatMarkdown.
import SvgFencePreview, { isSvgFenceLanguage, normalizeStandaloneSvgBlocks } from '../../../../src/renderer/src/components/common/SvgFencePreview'

function CodeFence({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false)
  return <div className="code-block-container">
    <div className="code-block-header"><span>{language || 'code'}</span>
      <button type="button" onClick={() => void navigator.clipboard.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }).catch(() => undefined)}>{copied ? '已复制' : '复制'}</button>
    </div><pre><code>{code}</code></pre>
  </div>
}

// ReactMarkdown uses this function as an element type, not a render callback.
// Defining it inside RemoteMarkdown remounts EVERY fence on every snapshot/token:
// SVG blob images briefly have zero height, reducing scrollHeight and letting the
// browser clamp a reader away from the bottom of a long thread. Stable identity
// preserves decoded images AND the user's preview/source/copy state.
function MarkdownPre({ children }: { children?: ReactNode }) {
  const child = Children.toArray(children)[0]
  if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) return <pre>{children}</pre>
  const language = /language-([^\s]+)/.exec(child.props.className ?? '')?.[1] ?? ''
  const code = String(child.props.children ?? '').replace(/\n$/, '')
  if (isSvgFenceLanguage(language)) return <SvgFencePreview code={code} />
  return <CodeFence language={language} code={code} />
}

type MarkdownTableProps = ComponentPropsWithoutRef<'table'> & { node?: unknown }

function MarkdownTable({ children, node: _node, ...props }: MarkdownTableProps) {
  return <div className="markdown-table-frame">
    <div className="markdown-table-scroll" tabIndex={0}>
      <table {...props}>{children}</table>
    </div>
  </div>
}

const MARKDOWN_COMPONENTS: Components = { pre: MarkdownPre, img: RemoteMarkdownImage, table: MarkdownTable }
const EMPTY_IMAGES: RemoteImageArtifact[] = []
const REMARK_PLUGINS = [remarkGfm]

// Snapshot objects change frequently; unchanged historical text need not reparse.
// Stable MarkdownPre identity is still required when the current reply streams.
export const RemoteMarkdown = memo(function RemoteMarkdown({ text, taskId = '', images = EMPTY_IMAGES, artifacts }: {
  text: string; taskId?: string; images?: readonly RemoteImageArtifact[]; artifacts?: readonly RemoteArtifactMetadata[]
}) {
  const source = useMemo(() => normalizeStandaloneSvgBlocks(text), [text])
  const transform = useMemo<UrlTransform>(() => (url, key, node) => {
    if (node.tagName === 'img' && key === 'src') {
      const image = resolveRemoteImageReference(url, images)
      if (image) return remoteImageReference(image.id)
      if (/^https:\/\//i.test(url)) return defaultUrlTransform(url)
      if (url.length < 24 * 1024 * 1024 && /^data:image\/(?:png|jpeg|jpg|gif|webp|bmp|avif);base64,[a-z\d+/=\s]+$/i.test(url)) return url
      return ''
    }
    return defaultUrlTransform(url)
  }, [images])
  return <RemoteMessageImageScope taskId={taskId} images={images} artifacts={artifacts}>
    <div className="assistant-markdown-content">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS} urlTransform={transform}>{source}</ReactMarkdown>
    </div>
  </RemoteMessageImageScope>
})
