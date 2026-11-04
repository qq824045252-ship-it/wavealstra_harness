import { useEffect, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import type { ScopedLibraryOperations } from "@/lib/scopedLibraryOperations";

interface Props {
  content: string;
  itemId: string;
  access: ScopedLibraryOperations;
  onOpenItem: (id: string) => void;
  onError: (message: string) => void;
}

function ScopedImage({ src, alt, itemId, access }: { src?: string; alt?: string; itemId: string; access: ScopedLibraryOperations }): React.JSX.Element {
  const [resolved, setResolved] = useState<{ source: string; url: string } | null>(null);
  const external = src && /^(https?:\/\/|data:image\/|blob:)/i.test(src);
  useEffect(() => {
    let cancelled = false;
    if (!src || external) return;
    void access.resolveLink(itemId, src).then((id) => {
      if (!cancelled) setResolved({ source: src, url: `mybuddy-library://local/${encodeURIComponent(id)}/` });
    }, () => { if (!cancelled) setResolved(null); });
    return () => { cancelled = true; };
  }, [src, external, itemId, access]);
  const url = external ? src : resolved && resolved.source === src ? resolved.url : undefined;
  return url ? <img src={url} alt={alt ?? ""} /> : <span className="scoped-library-image-placeholder">{alt || "图片不在当前资料范围"}</span>;
}

/** Library links never inherit the chat renderer's task-artifact navigation. */
export default function ScopedLibraryMarkdown({ content, itemId, access, onOpenItem, onError }: Props): React.JSX.Element {
  return <div className="md md-doc"><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex, rehypeHighlight]}
    urlTransform={(url, key) => key === "href" && /^mybuddy-library:\/\/local\//i.test(url) ? url
      : key === "src" && /^(mybuddy-library:\/\/local\/|data:image\/|blob:)/i.test(url) ? url : defaultUrlTransform(url)}
    components={{
      a: ({ href, children }) => <a className="md-link" href={href} onClick={(event) => {
        if (href?.startsWith("#")) return;
        event.preventDefault();
        if (!href) return;
        if (/^https?:\/\//i.test(href)) { void window.api?.browser.openExternal(href); return; }
        void access.resolveLink(itemId, href).then(onOpenItem, (error: unknown) => onError(error instanceof Error ? error.message : "无法打开资料链接"));
      }}>{children}</a>,
      img: ({ src, alt }) => <ScopedImage src={src} alt={alt} itemId={itemId} access={access} />,
    }}>{content || "暂无正文。"}</ReactMarkdown></div>;
}
