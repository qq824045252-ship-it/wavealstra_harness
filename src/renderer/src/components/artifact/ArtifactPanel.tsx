import { useEffect, useMemo, useState } from "react";
import { useActiveTaskArtifacts, useAppStore } from "@/store/appStore";
import CodeView from "./CodeView";
import MarkdownArtifactView from "./MarkdownArtifactView";
import ImageArtifactView from "./ImageArtifactView";
import MediaArtifactView from "./MediaArtifactView";
import BrowserView from "./BrowserView";
import ChangesView from "./ChangesView";
import ExtensionTopBar from "./ExtensionTopBar";
import HtmlArtifactView from "./HtmlArtifactView";
import OverviewView from "./OverviewView";
import TerminalView from "./TerminalView";
import WorkspaceFilesView from "./WorkspaceFilesView";
import TaskGadgetsView from "./TaskGadgetsView";
import FileActionBar from "./FileActionBar";
import type { Artifact } from "@/types";
import PdfViewer from "./PdfViewer";
import DocxViewer from "./DocxViewer";
import XlsxViewer from "./XlsxViewer";
import PptxViewer from "./PptxViewer";
import { ensureHtmlDocument } from "@/components/chat/DetailCard";
import { canNativeDrag, startNativeFileDrag } from "@/lib/nativeFileDrag";

function ArtifactBody({
  artifact,
  renderLoadState,
  renderLoadError,
}: {
  artifact: Artifact;
  renderLoadState: "unloaded" | "loading" | "ready" | "error" | undefined;
  renderLoadError: string | undefined;
}): React.JSX.Element {
  // content 未 hydration 时禁止挂载任何 Viewer。
  // 代码/Markdown 缺内容会变成「text 1行」+ 行号 1，看起来像空文件。
  if (!artifact.content) {
    if (renderLoadState === "error") {
      const dragEnabled = canNativeDrag(artifact.path);
      return (
        <div className="artifact-render-load" data-testid="artifact-render-error">
          <div className="artifact-render-load-icon">⚠️</div>
          <div className="artifact-render-load-title">{artifact.name} 加载失败</div>
          <div className="artifact-render-load-detail">{renderLoadError ?? "内容读取失败或为空"}</div>
          {dragEnabled && (
            <button
              type="button"
              className="artifact-render-drag is-draggable"
              draggable
              title={`${artifact.path}\n可拖到桌面或其它应用`}
              onDragStart={(e) => {
                if (!startNativeFileDrag(e, artifact.path)) e.preventDefault();
              }}
            >
              拖出文件
            </button>
          )}
        </div>
      );
    }
    return (
      <div className="artifact-render-load" data-testid="artifact-render-loading">
        <div className="artifact-render-load-spinner" />
        <div className="artifact-render-load-title">正在加载 {artifact.name}…</div>
      </div>
    );
  }
  switch (artifact.kind) {
    case "markdown":
    case "table":
      return <MarkdownArtifactView key={artifact.id} content={artifact.content} />;
    case "code":
      return <CodeView key={artifact.id} content={artifact.content} language={artifact.language} />;
    case "image":
      return <ImageArtifactView key={artifact.id} content={artifact.content} name={artifact.name} />;
    case "video":
    case "audio":
      return <MediaArtifactView key={artifact.id} kind={artifact.kind} content={artifact.content} name={artifact.name} />;
    case "html":
      return (
        <iframe
          title={artifact.name}
          className="browser-iframe document-preview-frame"
          srcDoc={ensureHtmlDocument(artifact.content)}
          sandbox="allow-scripts allow-same-origin"
        />
      );
    case "svg": {
      const srcDoc = /^<!DOCTYPE|^<html[\s>]/i.test(artifact.content.trim())
        ? artifact.content
        : `<!DOCTYPE html><html><head><meta charset="UTF-8"/><style>
            html,body{margin:0;padding:16px;background:transparent}
            svg{display:block;max-width:100%;height:auto;margin:0 auto}
          </style></head><body>${artifact.content}</body></html>`;
      return (
        <iframe
          title={artifact.name}
          className="browser-iframe document-preview-frame"
          srcDoc={srcDoc}
          sandbox="allow-scripts allow-same-origin"
        />
      );
    }
    case "pdf":
      return <PdfViewer key={artifact.id} content={artifact.content} name={artifact.name} />;
    case "docx":
      return <DocxViewer key={artifact.id} content={artifact.content} name={artifact.name} />;
    case "xlsx":
      return <XlsxViewer key={artifact.id} content={artifact.content} name={artifact.name} />;
    case "pptx":
      return <PptxViewer key={artifact.id} content={artifact.content} name={artifact.name} />;
    case "cad":
      // Mechanical CAD 二进制产物（FCStd/STL）：P0 不渲染 3D，按代码/文本回退显示说明
      return <CodeView key={artifact.id} content={artifact.content} language="text" />;
  }
}

export default function ArtifactPanel(): React.JSX.Element | null {
  const page = useAppStore((s) => s.page);
  const activeTaskId = useAppStore((s) => s.activeTaskId);
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId);
  const draftSpaceId = useAppStore((s) => s.draft?.spaceId);
  const taskSpaceId = useAppStore((s) => s.tasks.find((t) => t.id === s.activeTaskId)?.spaceId);
  const workspaceContextId =
    (page === "workspace" ? activeWorkspaceId : null) || taskSpaceId || draftSpaceId || null;
  const artifacts = useActiveTaskArtifacts();
  const panelMode = useAppStore((s) => s.panelMode);
  const panelWidth = useAppStore((s) => s.panelWidth);
  const panelExpanded = useAppStore((s) => s.panelExpanded);
  const togglePanelExpanded = useAppStore((s) => s.togglePanelExpanded);
  const artifactTabs = useAppStore((s) => s.artifactTabs);
  const activeArtifactId = useAppStore((s) => s.activeArtifactId);
  const openArtifact = useAppStore((s) => s.openArtifact);
  const closeArtifactTab = useAppStore((s) => s.closeArtifactTab);
  const extensionFlyoutOpen = useAppStore((s) => s.extensionFlyoutOpen);
  const extensionFlyoutPinned = useAppStore((s) => s.extensionFlyoutPinned);
  const closeExtensionFlyout = useAppStore((s) => s.closeExtensionFlyout);
  const ensureArtifactRenderPayload = useAppStore((s) => s.ensureArtifactRenderPayload);
  const renderLoadState = useAppStore((s) =>
    activeArtifactId ? s.artifactRenderLoadState[activeArtifactId] : undefined,
  );
  const renderLoadError = useAppStore((s) =>
    activeArtifactId ? s.artifactRenderErrors[activeArtifactId] : undefined,
  );

  // tab 恢复 / 自动激活等非 openArtifact 路径：任意缺内容的产物都补一次 hydration
  useEffect(() => {
    const current = panelMode === "file" ? artifacts.find((a) => a.id === activeArtifactId) : undefined;
    if (
      current &&
      !current.content &&
      renderLoadState !== "loading" &&
      renderLoadState !== "error"
    ) {
      void ensureArtifactRenderPayload(current.id);
    }
  }, [panelMode, artifacts, activeArtifactId, renderLoadState, ensureArtifactRenderPayload]);

  const [wsSearch] = useState("");

  // 原生 WebContentsView 不在 DOM 树内：非产物预览关 artifact host；非浏览器关 browser host。
  useEffect(() => {
    if (panelMode !== "file") window.api?.artifact?.close();
    if (panelMode !== "browser") window.api?.browser?.close();
  }, [panelMode]);

  // 首页无任务也可打开扩展栏浏览器；空间页/空间任务可开终端与空间文件夹；其它视图仍要求有任务
  if (
    !activeTaskId &&
    !workspaceContextId &&
    panelMode !== "browser" &&
    panelMode !== "terminal"
  ) {
    return null;
  }

  const tabs = artifactTabs
    .map((id) => artifacts.find((artifact) => artifact.id === id))
    .filter((a): a is Artifact => Boolean(a));
  const current =
    panelMode === "file"
      ? artifacts.find((artifact) => artifact.id === (activeArtifactId ?? ""))
      : undefined;

  const widen = (): void => {
    togglePanelExpanded();
  };

  const showFilePreview = panelMode === "file" && current;
  const isHtmlPreview = showFilePreview && current.kind === "html";
  const isSvgPreview = showFilePreview && current.kind === "svg";

  return (
    <div
      className={`artifact-panel extension-panel ${panelExpanded ? "expanded" : ""}`}
      style={
        panelExpanded
          ? undefined
          : { width: panelWidth, minWidth: panelWidth, maxWidth: panelWidth }
      }
    >
      <ExtensionTopBar
        tabs={tabs}
        activeId={current?.id}
        onWiden={widen}
        onOpenTab={openArtifact}
        onCloseTab={closeArtifactTab}
        wsSearch={wsSearch}
      />

      {showFilePreview && !isHtmlPreview && <FileActionBar artifact={current} />}

      {showFilePreview ? (
        <div
          className={`artifact-body artifact-body-with-flyout ${current.kind === "markdown" || current.kind === "table" ? "doc-mode" : ""} ${isHtmlPreview || isSvgPreview || ["pdf", "docx", "xlsx", "pptx"].includes(current.kind) ? "html-mode" : ""}`}
        >
          {isHtmlPreview ? (
            <HtmlArtifactView artifact={current} />
          ) : (
            <ArtifactBody
              artifact={current}
              renderLoadState={renderLoadState}
              renderLoadError={renderLoadError}
            />
          )}
          {extensionFlyoutOpen && !extensionFlyoutPinned && (
            <button
              type="button"
              className="extension-workspace-backdrop"
              aria-label="关闭扩展菜单"
              onClick={closeExtensionFlyout}
            />
          )}
        </div>
      ) : panelMode === "overview" || panelMode === "file" ? (
        <OverviewView />
      ) : panelMode === "workspace" ? (
        <WorkspaceFilesView query={wsSearch} />
      ) : panelMode === "gadgets" ? (
        <TaskGadgetsView />
      ) : panelMode === "terminal" ? (
        <TerminalView />
      ) : panelMode === "browser" ? (
        <BrowserView />
      ) : panelMode === "changes" ? (
        <ChangesView />
      ) : (
        <OverviewView />
      )}
    </div>
  );
}
