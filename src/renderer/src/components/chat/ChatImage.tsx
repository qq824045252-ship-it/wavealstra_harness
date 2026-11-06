import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { artifactImageUrl } from "@shared/artifact-ipc";
import type { ArtifactDescriptor } from "@shared/artifact-types";
import type { ChatMessage } from "@/types";
import { useAppStore } from "@/store/appStore";
import {
  directChatImageSource,
  isSvgArtifact,
  markdownImageSources,
  messageImageArtifacts,
  resolveChatImageArtifact,
  svgTextFromArtifactContent,
} from "@/lib/chatImages";

const EMPTY_IMAGES: ArtifactDescriptor[] = [];
const ImageScopeContext = createContext<string | null>(null);

/** 单条消息内联图片数阈值（P4）：超出折叠成网格 + "查看全部 n 张" */
const MAX_INLINE_IMAGES = 12;

/** Explicit message scope: Gateway/BTW never borrow the task left active in the sidebar. */
export function ChatImageScope({ taskId, children }: { taskId: string | null; children: React.ReactNode }): React.JSX.Element {
  return <ImageScopeContext.Provider value={taskId}>{children}</ImageScopeContext.Provider>;
}

function useImageScope() {
  const taskId = useContext(ImageScopeContext);
  const descriptors = useAppStore((s) => taskId ? s.artifactProjection.artifactsByTask[taskId] ?? EMPTY_IMAGES : EMPTY_IMAGES);
  const cwd = useAppStore((s) => s.tasks.find((t) => t.id === taskId)?.cwd);
  return { taskId, descriptors, cwd };
}

/**
 * 离开视口回收（P0）：虚拟列表会把滚出 overscan 的行卸载，卸载即"离开视口"。
 * 引用计数避免同一张图被多条气泡共享时互相清缓存；延迟释放避免快速来回滚动
 * 反复 hydration。缓存里现在只有协议 URL 与尺寸元数据，回收代价极低。
 */
const IMAGE_CACHE_EVICT_DELAY_MS = 1500;
const mountedImages = new Map<string, number>();
const evictionTimers = new Map<string, ReturnType<typeof setTimeout>>();

function retainRenderCache(id: string): void {
  mountedImages.set(id, (mountedImages.get(id) ?? 0) + 1);
  const timer = evictionTimers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    evictionTimers.delete(id);
  }
}

function scheduleRenderCacheEviction(id: string, release: (artifactId: string) => void): void {
  const count = (mountedImages.get(id) ?? 1) - 1;
  if (count > 0) {
    mountedImages.set(id, count);
    return;
  }
  mountedImages.delete(id);
  if (evictionTimers.has(id)) return;
  const timer = setTimeout(() => {
    evictionTimers.delete(id);
    if ((mountedImages.get(id) ?? 0) === 0) release(id);
  }, IMAGE_CACHE_EVICT_DELAY_MS);
  evictionTimers.set(id, timer);
}

export function ChatImage({
  source = "", alt = "图片", title, artifact, fallback = false, loading = false,
}: {
  source?: string;
  alt?: string;
  title?: string;
  artifact?: ArtifactDescriptor;
  fallback?: boolean;
  loading?: boolean;
}): React.JSX.Element {
  const { taskId, descriptors, cwd } = useImageScope();
  const resolved = useMemo(
    () => artifact?.taskId === taskId ? artifact : resolveChatImageArtifact(source, descriptors, taskId, cwd),
    [artifact, source, descriptors, taskId, cwd],
  );
  const id = resolved?.id;
  const version = resolved?.version;
  const payload = useAppStore((s) => id ? s.artifactRenderCache[id] : undefined);
  const loadState = useAppStore((s) => id ? s.artifactRenderLoadState[id] : undefined);
  const ensure = useAppStore((s) => s.ensureArtifactRenderPayload);
  const release = useAppStore((s) => s.releaseArtifactRender);
  const openArtifact = useAppStore((s) => s.openArtifact);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const svgText = useMemo(() => {
    if (!resolved || !isSvgArtifact(resolved) || !payload || payload.artifactVersion !== version) return null;
    return svgTextFromArtifactContent(payload.content);
  }, [resolved, payload, version]);
  const [svgObjectUrl, setSvgObjectUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!svgText) {
      setSvgObjectUrl(null);
      return undefined;
    }
    // Blob-backed <img> puts SVG in the browser's static image context: scripts
    // do not execute, while vector text/shapes remain crisp in the bubble.
    const url = URL.createObjectURL(new Blob([svgText], { type: "image/svg+xml;charset=utf-8" }));
    setSvgObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [svgText]);

  // 内联展示只拿协议 URL：字节由主进程 mybuddy-artifact:// 投递，renderer 不碰 base64。
  // hydration 尚未回来时也能直接加载 thumb（协议层在缩略图不可用/超时时回落原图字节）。
  const isSvg = resolved ? isSvgArtifact(resolved) : false;
  const fresh = payload && payload.artifactVersion === version ? payload : undefined;
  const thumbnail = fresh?.thumbnail;
  // 占位尺寸：优先缩略图自身尺寸，其次主进程读文件头得到的原图固有尺寸。
  // 未知尺寸（外部 https 图 / hydration 未完成）用 4:3 + min-height 骨架。
  const intrinsicSize = thumbnail
    ?? (fresh?.width && fresh.height ? { width: fresh.width, height: fresh.height } : undefined);
  const src = useMemo(() => {
    if (!id) return directChatImageSource(source);
    if (isSvg) return svgObjectUrl;
    return thumbnail?.url ?? artifactImageUrl(id, "thumb");
  }, [id, isSvg, svgObjectUrl, thumbnail, source]);

  useEffect(() => {
    // 只为元数据/SVG 文本做 hydration：图片字节不经过这条 IPC。
    if (id && !loading) void ensure(id);
  }, [id, version, loading, ensure]);

  useEffect(() => {
    if (!id) return undefined;
    retainRenderCache(id);
    return () => scheduleRenderCacheEviction(id, release);
  }, [id, release]);

  // fallback（回复尾部补图）不占用正文的"已渲染"计数，也不参与滚动回收的重复保留。
  void fallback;
  const pending = loading || Boolean(id && !src && loadState !== "error" && !fresh);
  if (!src || src === failedSource) {
    return (
      <span className="chat-image-status" role="status" style={{ display: "block", padding: "12px 0" }}>
        {pending ? "图片加载中…" : `图片无法显示：${alt || "未找到图片"}`}
        {!pending && id && <button type="button" className="md-file-link" onClick={() => openArtifact(id)}>打开产物</button>}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      title={title ?? (id ? "点击查看原图" : alt)}
      className="chat-inline-image"
      decoding="async"
      loading="lazy"
      referrerPolicy="no-referrer"
      /* 已知尺寸：HTML width/height + aspect-ratio 在解码前就钉住行高，加载完成不重测 */
      width={intrinsicSize?.width}
      height={intrinsicSize?.height}
      style={{
        display: "block",
        maxWidth: "100%",
        maxHeight: 480,
        // 不覆盖 HTML width 属性：未解码时元素就有确定宽度，高度由 aspect-ratio 给出。
        height: "auto",
        aspectRatio: intrinsicSize ? `${intrinsicSize.width} / ${intrinsicSize.height}` : "4 / 3",
        // 未知尺寸：固定骨架，加载完成后保持同一行高。
        ...(intrinsicSize ? {} : { width: "100%", minHeight: 160 }),
        objectFit: "contain",
        margin: "12px 0",
        cursor: id ? "zoom-in" : undefined,
      }}
      onError={() => setFailedSource(src)}
      onClick={id ? () => openArtifact(id) : undefined}
      role={id ? "button" : undefined}
      tabIndex={id ? 0 : undefined}
      onKeyDown={id ? (event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openArtifact(id); }
      } : undefined}
    />
  );
}

/** Show generated images in their reply even if the model only emits a download link. */
export function MessageImages({ message }: { message: ChatMessage }): React.JSX.Element | null {
  const { taskId, descriptors, cwd } = useImageScope();
  const [showAll, setShowAll] = useState(false);
  const images = useMemo(
    () => messageImageArtifacts(message, descriptors, taskId),
    [message, descriptors, taskId],
  );
  /** P3：渲染期纯计算，取代 register/setCounts 的挂载期引用计数。 */
  const renderedIds = useMemo(() => {
    const ids = new Set<string>();
    const texts: string[] = [];
    for (const block of message.finalBlocks ?? []) {
      if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
    }
    for (const block of message.blocks ?? []) {
      if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
    }
    for (const text of texts) {
      for (const source of markdownImageSources(text)) {
        const artifact = resolveChatImageArtifact(source, descriptors, taskId, cwd);
        if (artifact) ids.add(artifact.id);
      }
    }
    return ids;
  }, [message, descriptors, taskId, cwd]);
  const remaining = images.filter((image) => !renderedIds.has(image.id));
  if (!remaining.length) return null;
  const collapsed = remaining.length > MAX_INLINE_IMAGES && !showAll;
  const shown = collapsed ? remaining.slice(0, MAX_INLINE_IMAGES) : remaining;
  return (
    <div
      className="message-images"
      style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 8, margin: "8px 0" }}
    >
      {shown.map((artifact) => (
        <ChatImage key={artifact.id} artifact={artifact} alt={artifact.title ?? "生成图片"} fallback />
      ))}
      {collapsed && (
        <button
          type="button"
          className="md-file-link"
          style={{ gridColumn: "1 / -1", justifySelf: "start" }}
          onClick={() => setShowAll(true)}
        >
          查看全部 {remaining.length} 张
        </button>
      )}
    </div>
  );
}
