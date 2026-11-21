/**
 * MdFileLink — Markdown 链接渲染（Chat/Artifact 共用）：
 * - 本地文件类链接（含 .html / file://）：命中产物 → 右侧预览；
 * - HTTP(S)：侧栏浏览器（OpenDesign 裸根有 HTML 产物时右侧预览）；
 * - 锚点：文档内默认滚动行为。
 */
import { useAppStore, selectActiveTaskArtifacts } from "@/store/appStore";
import { FileBadge } from "./FileBadge";
import { canNativeDrag, startNativeFileDrag } from "@/lib/nativeFileDrag";
import { fileNameFromPath, looksLikeLocalFilePath, pathFromMarkdownHref } from "@/lib/localFilePath";
import { normalizeComparePath } from "@/lib/workspace";
import { isAnchorHref, isBareOpenDesignDaemonUrl, isExternalHref } from "@/lib/markdownDoc";
import type { Artifact } from "@/types";

function isFileLikeHref(href: string): boolean {
  if (!href || isExternalHref(href)) return false;
  if (isAnchorHref(href)) return false;
  // file:// 也按本地文件处理（basename 命中产物 → 右侧预览）
  if (/^file:/i.test(href)) return true;
  return /\.[a-z0-9]{1,6}$/i.test(href) || href.includes("/") || href.includes("\\");
}

/** 优先找 HTML 设计稿产物（OpenDesign 裸根链接的正确落点）。 */
function pickHtmlArtifact(artifacts: Artifact[]): Artifact | undefined {
  return artifacts.find((a) => a.kind === "html") ?? artifacts.find((a) => /\.html?$/i.test(a.name));
}

function openHttpLink(
  url: string,
  opts?: {
    artifacts?: Artifact[];
    openArtifact?: (id: string) => void;
  },
): void {
  // OpenDesign headless 裸根无 Web UI：有 HTML 产物时直接在右侧预览
  if (isBareOpenDesignDaemonUrl(url)) {
    const html = opts?.artifacts ? pickHtmlArtifact(opts.artifacts) : undefined;
    if (html && opts?.openArtifact) {
      opts.openArtifact(html.id);
      return;
    }
  }
  // HTTP(S) links use the same task-scoped browser as tool automation.
  useAppStore.getState().setBrowserUrl(url);
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
  const openWorkspaceFile = useAppStore((s) => s.openWorkspaceFile);
  const destination = href ?? "";

  if (!isFileLikeHref(destination)) {
    if (isAnchorHref(destination)) {
      // 文档内锚点：保持默认行为（组件外层容器拦截处理滚动）
      return (
        <a href={destination} className="md-link md-anchor">
          {children}
        </a>
      );
    }
    if (isExternalHref(destination)) {
      return (
        <a
          href={destination}
          className="md-link"
          onClick={(e) => {
            e.preventDefault();
            openHttpLink(destination, { artifacts, openArtifact });
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

  const path = pathFromMarkdownHref(destination);
  if (!path) return <span title={destination}>{children ?? destination}</span>;
  const name = fileNameFromPath(path);
  const absolute = looksLikeLocalFilePath(path);
  const relative = !/^(?:[a-z][\w+.-]*:|[\\/])/i.test(path);
  const normalized = normalizeComparePath(path);
  const artifact = absolute
    ? artifacts.find((a) => a.path && normalizeComparePath(a.path) === normalized)
      ?? artifacts.find((a) => !a.path && a.name === name)
    : artifacts.find((a) => a.name === name && (!relative || !/[/\\]/.test(path) || !a.path));
  const dragPath = artifact?.path || (absolute ? path : "");
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
        else if (absolute) void openLocalAbsoluteFile(path);
        else if (relative) void openWorkspaceFile(path, name);
      }}
    >
      <FileBadge name={name} size={14} />
      <span>{children ?? path}</span>
    </button>
  );
}
