/**
 * MdFileLink — Markdown 链接渲染（Chat/Artifact 共用）：
 * - 本地文件类链接（含 .html / file://）：命中产物 → 右侧预览；
 * - 外部 http(s)：系统浏览器（OpenDesign 裸根有 HTML 产物时右侧预览）；
 * - 锚点：文档内默认滚动行为。
 */
import { useAppStore, selectActiveTaskArtifacts } from "@/store/appStore";
import { FileBadge } from "./FileBadge";
import { canNativeDrag, startNativeFileDrag } from "@/lib/nativeFileDrag";
import { looksLikeLocalFilePath } from "@/lib/localFilePath";
import { isAnchorHref, isBareOpenDesignDaemonUrl, isExternalHref } from "@/lib/markdownDoc";
import type { Artifact } from "@/types";

function isFileLikeHref(href: string): boolean {
  if (!href || href.startsWith("http://") || href.startsWith("https://")) return false;
  if (isAnchorHref(href)) return false;
  // file:// 也按本地文件处理（basename 命中产物 → 右侧预览）
  if (/^file:/i.test(href)) return true;
  return /\.[a-z0-9]{1,6}$/i.test(href) || href.includes("/") || href.includes("\\");
}

function basenameFromHref(href: string): string {
  const stripped = href.replace(/^file:\/\//i, "").replace(/^\/([A-Za-z]:)/, "$1");
  try {
    if (/^https?:\/\//i.test(href)) {
      const u = new URL(href);
      const last = u.pathname.split("/").filter(Boolean).pop();
      if (last) return decodeURIComponent(last);
    }
  } catch {
    /* ignore */
  }
  return stripped.split(/[/\\]/).pop() ?? href;
}

/** 优先找 HTML 设计稿产物（OpenDesign 裸根链接的正确落点）。 */
function pickHtmlArtifact(artifacts: Artifact[]): Artifact | undefined {
  return artifacts.find((a) => a.kind === "html") ?? artifacts.find((a) => /\.html?$/i.test(a.name));
}

function openSystemBrowser(url: string): void {
  // 勿用 target=_blank：Electron + rel=noreferrer 常把 about:blank 交给 openExternal。
  const open = window.api?.browser?.openExternal;
  if (typeof open === "function") open(url);
}

function openHttpLink(
  url: string,
  opts?: {
    artifacts?: Artifact[];
    openArtifact?: (id: string) => void;
  },
): void {
  // OpenDesign headless 裸根无 Web UI：有 HTML 产物才右侧预览，否则系统浏览器
  if (isBareOpenDesignDaemonUrl(url)) {
    const html = opts?.artifacts ? pickHtmlArtifact(opts.artifacts) : undefined;
    if (html && opts?.openArtifact) {
      opts.openArtifact(html.id);
      return;
    }
  }
  // 所有 http(s)（含 localhost / 127.0.0.1）→ 系统浏览器
  openSystemBrowser(url);
}

export function MdFileLink({
  href,
  children,
}: {
  href?: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  // 3E：产物直读 projection 派生视图（不再读 task.artifacts）
  const artifacts = useAppStore(selectActiveTaskArtifacts);
  const openArtifact = useAppStore((s) => s.openArtifact);
  const openLocalAbsoluteFile = useAppStore((s) => s.openLocalAbsoluteFile);
  const path = href ?? "";
  const name = basenameFromHref(path);
  const artifact = artifacts.find((a) => a.name === name || path.endsWith(a.name));

  if (!isFileLikeHref(path)) {
    if (isAnchorHref(path)) {
      // 文档内锚点：保持默认行为（组件外层容器拦截处理滚动）
      return (
        <a href={path} className="md-link md-anchor">
          {children}
        </a>
      );
    }
    if (isExternalHref(path)) {
      return (
        <a
          href={path}
          className="md-link"
          onClick={(e) => {
            e.preventDefault();
            openHttpLink(path, { artifacts, openArtifact });
          }}
        >
          {children}
        </a>
      );
    }
    return (
      <a href={href} target="_blank" rel="noreferrer" className="md-link">
        {children}
      </a>
    );
  }

  const dragPath = artifact?.path || (looksLikeLocalFilePath(path) ? path : "");
  const dragEnabled = canNativeDrag(dragPath);

  // 本地文件类链接（含 .html / file://）：命中产物则右侧预览，不送系统浏览器
  return (
    <button
      type="button"
      className={`md-file-link${dragEnabled ? " is-draggable" : ""}`}
      draggable={dragEnabled}
      title={dragEnabled ? `${dragPath}\n可拖到桌面或其它应用` : path}
      onDragStart={(e) => {
        if (!startNativeFileDrag(e, dragPath)) e.preventDefault();
      }}
      onClick={() => {
        if (artifact) openArtifact(artifact.id);
        else if (looksLikeLocalFilePath(path)) void openLocalAbsoluteFile(path);
      }}
    >
      <FileBadge name={name} size={14} />
      <span>{children ?? path}</span>
    </button>
  );
}
