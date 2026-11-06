import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ArtifactDescriptor } from "@shared/artifact-types";
import type { ChatMessage } from "@/types";
import { useAppStore } from "@/store/appStore";
import {
  directChatImageSource,
  isSvgArtifact,
  messageImageArtifacts,
  resolveChatImageArtifact,
  svgTextFromArtifactContent,
} from "@/lib/chatImages";

const EMPTY_IMAGES: ArtifactDescriptor[] = [];
const ImageScopeContext = createContext<string | null>(null);

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
  const openArtifact = useAppStore((s) => s.openArtifact);
  const register = useContext(ImageContext)?.register;
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
  // 内联展示优先用缩略图：解码面积比原图小一个量级，而原图解码后的位图面积
  // 才是滚动时反复 evict/重解的物理原因。原图只留给"查看原图"（openArtifact）。
  const thumbnail = useMemo(
    () => (payload && payload.artifactVersion === version ? payload.thumbnail : undefined),
    [payload, version],
  );
  // 占位尺寸：优先缩略图自身的尺寸，其次主进程读文件头得到的固有尺寸。
  // 两者都没有（任意外部 https 图）时退回改动前的行为。
  const intrinsicSize = thumbnail
    ?? (payload && payload.artifactVersion === version && payload.width && payload.height
      ? { width: payload.width, height: payload.height }
      : undefined);
  // Large data URLs must not be revalidated on every streaming text delta.
  const src = useMemo(() => {
    if (!id) return directChatImageSource(source);
    if (isSvgArtifact(resolved!)) return svgObjectUrl;
    const fresh = payload && payload.artifactVersion === version ? payload : undefined;
    const fromThumbnail = thumbnail ? directChatImageSource(thumbnail.content) : null;
    // 缩略图不可用（主进程没产出/格式不支持）→ 回落原图，行为与改动前一致
    return fromThumbnail ?? (fresh ? directChatImageSource(fresh.content) : null);
  }, [id, resolved, svgObjectUrl, thumbnail, payload, version, source]);

  useEffect(() => {
    if (id && !loading) void ensure(id);
  }, [id, version, loading, ensure]);
  useEffect(() => {
    if (id && !fallback && register) return register(id);
    return undefined;
  }, [id, fallback, register]);

  const pending = loading || Boolean(id && !src && loadState !== "error" && !(payload?.artifactVersion === version));
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
      /* 固有尺寸已知就先占好位置：加载完成不再改变行高，虚拟列表不必重测这一行 */
      width={intrinsicSize?.width}
      height={intrinsicSize?.height}
      style={{
        display: "block", maxWidth: "100%", maxHeight: 480, width: "auto", height: "auto",
        ...(intrinsicSize ? { aspectRatio: `${intrinsicSize.width} / ${intrinsicSize.height}` } : {}),
        objectFit: "contain", margin: "12px 0", cursor: id ? "zoom-in" : undefined,
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
  const { taskId, descriptors } = useImageScope();
  const counts = useContext(ImageContext)?.counts;
  const images = useMemo(() => messageImageArtifacts(message, descriptors, taskId), [message, descriptors, taskId]);
  const remaining = images.filter((image) => !counts?.[image.id]);
  if (!remaining.length) return null;
  return <div className="message-images">{remaining.map((artifact) => (
    <ChatImage key={artifact.id} artifact={artifact} alt={artifact.title ?? "生成图片"} fallback />
  ))}</div>;
}
