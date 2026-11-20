import { useEffect, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import type { ScopedLibraryOperations } from "@/lib/scopedLibraryOperations";
import { useAppStore } from "@/store/appStore";
import { libraryLinkedVersion } from "@/lib/scopedLibrary";

interface Props {
  content: string;
  itemId: string;
  access: ScopedLibraryOperations;
  onOpenItem: (id: string, version?: number) => void;
  onError: (message: string) => void;
  notes?: boolean;
  revision?: number;
}

export function ScopedImage({ src, alt, itemId, access, notes, revision }: {
  src?: string; alt?: string; itemId: string; access: ScopedLibraryOperations; notes?: boolean; revision?: number;
}): React.JSX.Element {
  const [resolved, setResolved] = useState<{ source: string; url: string } | null>(null);
  const external = src && /^(https?:\/\/|data:image\/|blob:)/i.test(src);
  useEffect(() => {
    let cancelled = false;
    if (!src || external) return;
    void access.resolveLink(itemId, src).then((id) => `mybuddy-library://local/${encodeURIComponent(id)}/`)
      .catch(() => notes && access.reference ? access.note({ type: "noteImage", id: itemId, href: src, version: revision }) : undefined)
      .then((url) => {
      if (!cancelled && url) setResolved({ source: src, url });
    }, () => { if (!cancelled) setResolved(null); });
    return () => { cancelled = true; };
  }, [src, external, itemId, access, notes, revision]);
  const url = external ? src : resolved && resolved.source === src ? resolved.url : undefined;
  return url ? <img key={url} src={url} alt={alt ?? ""} loading="lazy"
    onError={(event) => { event.currentTarget.alt = (alt ? alt + " · " : "") + "图片不可用"; }} />
    : <span className="scoped-library-image-placeholder">{alt || "图片不在当前资料范围"}</span>;
}

function NoteMermaid({ source }: { source: string }): React.JSX.Element {
  const [rendered, setRendered] = useState<{ source: string; svg?: string }>();
  useEffect(() => {
    let active = true;
    void import("mermaid").then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", maxTextSize: 50_000, suppressErrorRendering: true });
      const id = "note-mermaid-" + crypto.randomUUID();
      const { svg } = await mermaid.render(id, source);
      if (active) setRendered({ source, svg });
    }).catch(() => { if (active) setRendered({ source }); });
    return () => { active = false; };
  }, [source]);
  return rendered?.source === source && rendered.svg ? <img className="note-diagram" alt="Mermaid 图表" src={"data:image/svg+xml," + encodeURIComponent(rendered.svg)} />
    : <pre><code>{source}</code>{rendered?.source === source && <small>无法渲染此 Mermaid 图表</small>}</pre>;
}

/** Library links never inherit the chat renderer's task-artifact navigation. */
export default function ScopedLibraryMarkdown({ content, itemId, access, onOpenItem, onError, notes, revision }: Props): React.JSX.Element {
  return <div className="md md-doc"><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex, rehypeHighlight]}
    urlTransform={(url, key) => key === "href" && /^mybuddy-library:\/\/local\//i.test(url) ? url
      : key === "src" && /^(mybuddy-library:\/\/local\/|data:image\/|blob:)/i.test(url) ? url : defaultUrlTransform(url)}
    components={{
      a: ({ href, children }) => <a className="md-link" href={href} onClick={(event) => {
        if (href?.startsWith("#")) return;
        event.preventDefault();
        if (!href) return;
        if (/^https?:\/\//i.test(href)) {
          if (notes) void access.note({ type: "openLink", url: href }).catch((error: unknown) => onError(String(error)));
          else useAppStore.getState().setBrowserUrl(href);
          return;
        }
        void access.resolveLink(itemId, href).then((id) => onOpenItem(id, libraryLinkedVersion(href)),
          (error: unknown) => onError(error instanceof Error ? error.message : "无法打开资料链接"));
      }}>{children}</a>,
      img: ({ src, alt }) => <ScopedImage src={src} alt={alt} itemId={itemId} access={access} notes={notes} revision={revision} />,
      pre: ({ node, children }) => {
        const code = node?.children[0];
        if (notes && code?.type === "element" && String(code.properties.className ?? "").includes("language-mermaid")) {
          const source = code.children.map((child) => child.type === "text" ? child.value : "").join("");
          return <NoteMermaid source={source} />;
        }
        return <pre>{children}</pre>;
      },
    }}>{content || "暂无正文。"}</ReactMarkdown></div>;
}
