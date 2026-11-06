/**
 * Wave 5A/5B — 预览页入口（Golden / E2E 共用）
 *
 * 用真实生产组件渲染 fixture：CodeView（Shiki + Monaco 编辑态）、
 * MarkdownArtifactView（虚拟化文档）、ImageArtifactView（图片查看器）。
 * 查询参数：
 *   ?file=code-ts.ts&lang=typescript&theme=dark&edit=1&kind=markdown|image&zoom=100
 * 内容经 w5a-fixture:// 自定义协议获取（golden/e2e 主进程注册）。
 *
 * 暴露测试钩子：window.__w5a = { setTheme, renderImage, stats }（E2E
 * 主题切换 / 泄漏场景 / objectURL 间谍用）。
 */
import { createRoot, type Root } from "react-dom/client";
import CodeView from "@/components/artifact/CodeView";
import MarkdownArtifactView from "@/components/artifact/MarkdownArtifactView";
import ImageArtifactView from "@/components/artifact/ImageArtifactView";
import PdfViewer from "@/components/artifact/PdfViewer";
import DocxViewer from "@/components/artifact/DocxViewer";
import XlsxViewer from "@/components/artifact/XlsxViewer";
import { useAppStore } from "@/store/appStore";
import { imageViewerStats } from "@/lib/imageView";
import { pdfViewerStats } from "@/lib/pdfView";
import { docxViewerStats, decodeDataUriBytes } from "@/lib/docxView";
import { xlsxViewerStats } from "@/lib/xlsxView";
import PptxViewer from "@/components/artifact/PptxViewer";
import { pptxViewerStats } from "@/lib/pptxView";
import { ChatImageScope, MessageImages } from "@/components/chat/ChatImage";
import type { ChatMessage } from "@/types";
import type { ArtifactDescriptor } from "../src/shared/artifact-types";

declare global {
  interface Window {
    __w5a: {
      setTheme: (theme: "light" | "dark") => void;
      renderImage: (file: string | null) => Promise<void>;
      renderPdf: (file: string | null) => Promise<void>;
      renderDocx: (file: string | null) => Promise<void>;
      renderXlsx: (file: string | null) => Promise<void>;
      renderPptx: (file: string | null) => Promise<void>;
      debugDocxParse: (dataUrl: string) => Promise<string>;
      debugDocxImport: () => Promise<string>;
      debugDocxStage: (dataUrl: string, stage: string) => Promise<string>;
      stats: () => {
        active: number;
        stageListeners: number;
        observers: number;
        objectUrlCalls: number;
        viewerDom: number;
        pdf: {
          docs: number;
          workers: number;
          listeners: number;
          observers: number;
          canvasesLive: number;
          textLayersLive: number;
          canvasesRendered: number;
          textPagesExtracted: number;
        };
        pdfDom: number;
        docx: {
          docs: number;
          listeners: number;
          observers: number;
          pagesLive: number;
          renders: number;
        };
        docxDom: number;
      };
    };
  }
}

/** objectURL 间谍：ImageArtifactView 不得创建 object URL（泄漏断言） */
let objectUrlCalls = 0;
const originalCreateObjectURL = URL.createObjectURL.bind(URL);
URL.createObjectURL = (...args: Parameters<typeof URL.createObjectURL>) => {
  objectUrlCalls += 1;
  return originalCreateObjectURL(...args);
};

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

let imageRoot: Root | null = null;
let pdfRoot: Root | null = null;
let docxRoot: Root | null = null;
let xlsxRoot: Root | null = null;
let pptxRoot: Root | null = null;

async function renderChatSvg(file: string): Promise<void> {
  const root = document.getElementById("root");
  if (!root) throw new Error("no #root");
  const response = await fetch(`w5a-fixture:///${encodeURIComponent(file)}`);
  if (!response.ok) throw new Error(`w5a-fixture load failed: ${file}`);
  const content = await response.text();
  const taskId = "svg-chat-task";
  const artifactId = "legacy-svg-artifact";
  const toolCallId = "write-svg-call";
  // Mirror the production failure: old builds persisted .svg as kind=image and
  // the assistant's final prose contained only a file path, not ![] Markdown.
  const descriptor: ArtifactDescriptor = {
    id: artifactId,
    taskId,
    kind: "image",
    title: file,
    source: { type: "workspace-file", rootDir: "C:/task", entryFile: `C:/task/${file}` },
    version: 1,
    capabilities: { originalKind: "image" },
    createdByToolCallId: toolCallId,
    createdAt: 1,
    updatedAt: 1,
  };
  useAppStore.setState({
    tasks: [{ id: taskId, title: "Preview fixture", updatedAt: 1, messages: [], cwd: "C:/task" }],
    artifactProjection: {
      artifactsByTask: { [taskId]: [descriptor] },
      artifactRevisions: { [taskId]: 1 },
      artifactLoadState: { [taskId]: "ready" },
    },
    artifactRenderCache: {
      [artifactId]: { name: file, kind: "svg", content, path: `C:/task/${file}`, artifactVersion: 1 },
    },
    artifactRenderLoadState: { [artifactId]: "ready" },
    ensureArtifactRenderPayload: async () => useAppStore.getState().artifactRenderCache[artifactId] ?? null,
  });
  const message: ChatMessage = {
    id: "hist-asst-svg",
    role: "assistant",
    createdAt: 1,
    blocks: [{ type: "tool", toolCall: { id: toolCallId, tool: "write", summary: "写入 SVG", status: "success" } }],
  };
  root.className = "preview-chat-svg";
  createRoot(root).render(
    <ChatImageScope taskId={taskId}>
      <div style={{ width: 760, margin: "24px auto", fontFamily: "system-ui" }}>
        <p>趋势图已生成：</p>
        <code>{`C:\\task\\${file}`}</code>
        <MessageImages message={message} />
      </div>
    </ChatImageScope>,
  );
}

/** 挂载/切换/卸载图片查看器（泄漏场景：A → B → A → null） */
async function renderImage(file: string | null): Promise<void> {
  const root = document.getElementById("root");
  if (!root) throw new Error("no #root");
  if (imageRoot) {
    imageRoot.unmount();
    imageRoot = null;
  }
  if (!file) return;
  root.className = "preview-image";
  const response = await fetch(`w5a-fixture:///${encodeURIComponent(file)}`);
  if (!response.ok) throw new Error(`w5a-fixture load failed: ${file}`);
  const dataUrl = await blobToDataUrl(await response.blob());
  imageRoot = createRoot(root);
  imageRoot.render(<ImageArtifactView content={dataUrl} name={file} />);
}

/** 挂载/切换/卸载 DOCX 查看器（泄漏场景：long → simple → long → null） */
async function renderDocx(file: string | null): Promise<void> {
  const root = document.getElementById("root");
  if (!root) throw new Error("no #root");
  if (docxRoot) {
    docxRoot.unmount();
    docxRoot = null;
  }
  if (!file) return;
  root.className = "preview-docx";
  const response = await fetch(`w5a-fixture:///${encodeURIComponent(file)}`);
  if (!response.ok) throw new Error(`w5a-fixture load failed: ${file}`);
  const dataUrl = await blobToDataUrl(await response.blob());
  docxRoot = createRoot(root);
  docxRoot.render(<DocxViewer content={dataUrl} name={file} />);
}

/** 挂载/切换/卸载 XLSX 查看器（泄漏场景：10k → simple → 10k → null） */
async function renderXlsx(file: string | null): Promise<void> {
  const root = document.getElementById("root");
  if (!root) throw new Error("no #root");
  if (xlsxRoot) {
    xlsxRoot.unmount();
    xlsxRoot = null;
  }
  if (!file) return;
  root.className = "preview-xlsx";
  const response = await fetch(`w5a-fixture:///${encodeURIComponent(file)}`);
  if (!response.ok) throw new Error(`w5a-fixture load failed: ${file}`);
  const dataUrl = await blobToDataUrl(await response.blob());
  xlsxRoot = createRoot(root);
  xlsxRoot.render(<XlsxViewer content={dataUrl} name={file} />);
}

/** 挂载/切换/卸载 PPTX 查看器（泄漏场景：long → simple → long → null） */
async function renderPptx(file: string | null): Promise<void> {
  const root = document.getElementById("root");
  if (!root) throw new Error("no #root");
  if (pptxRoot) {
    pptxRoot.unmount();
    pptxRoot = null;
  }
  if (!file) return;
  root.className = "preview-pptx";
  const response = await fetch(`w5a-fixture:///${encodeURIComponent(file)}`);
  if (!response.ok) throw new Error(`w5a-fixture load failed: ${file}`);
  const dataUrl = await blobToDataUrl(await response.blob());
  pptxRoot = createRoot(root);
  pptxRoot.render(<PptxViewer content={dataUrl} name={file} />);
}

async function renderPdf(file: string | null): Promise<void> {
  const root = document.getElementById("root");
  if (!root) throw new Error("no #root");
  if (pdfRoot) {
    pdfRoot.unmount();
    pdfRoot = null;
  }
  if (!file) return;
  root.className = "preview-pdf";
  const response = await fetch(`w5a-fixture:///${encodeURIComponent(file)}`);
  if (!response.ok) throw new Error(`w5a-fixture load failed: ${file}`);
  const dataUrl = await blobToDataUrl(await response.blob());
  pdfRoot = createRoot(root);
  pdfRoot.render(<PdfViewer content={dataUrl} name={file} />);
}

async function main(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const file = params.get("file") ?? "code-ts.ts";
  const lang = params.get("lang") ?? undefined;
  const kind = params.get("kind") ?? (file.endsWith(".md") ? "markdown" : "code");
  const theme = params.get("theme") === "dark" ? "dark" : "light";
  const edit = params.get("edit") === "1";
  const zoom100 = params.get("zoom") === "100";

  useAppStore.setState({ theme });
  document.documentElement.dataset.theme = theme;

  window.__w5a = {
    setTheme: (next) => {
      useAppStore.setState({ theme: next });
      document.documentElement.dataset.theme = next;
    },
    renderImage,
    renderPdf,
    renderDocx,
    renderXlsx,
    renderPptx,
    debugDocxImport: async (): Promise<string> => {
      const mod = await import("docx-preview");
      return "import ok: " + typeof mod.parseAsync;
    },
    debugDocxStage: async (dataUrl: string, stage: string): Promise<string> => {
      const mod = await import("docx-preview");
      const bytes = decodeDataUriBytes(dataUrl);
      const blob = new Blob([bytes as BlobPart], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
      if (stage === "parse") {
        const parsed = await mod.parseAsync(blob, { breakPages: true, renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true, inWrapper: true, className: "docx" });
        return "parse ok";
      }
      if (stage === "render") {
        const parsed = await mod.parseAsync(blob, { breakPages: true, renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true, inWrapper: true, className: "docx" });
        const nodes = await mod.renderDocument(parsed, { breakPages: true, renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true, inWrapper: true, className: "docx" });
        const wrapper = nodes.find((n): n is HTMLElement => n instanceof HTMLElement && n.className.includes("docx-wrapper"));
        const sections = wrapper ? wrapper.querySelectorAll("section.docx").length : -1;
        return "render ok nodes=" + nodes.length + " sections=" + sections + " kids=" + (wrapper ? wrapper.children.length : -1);
      }
      return "unknown stage";
    },
    debugDocxParse: async (dataUrl: string): Promise<string> => {
      const log: string[] = [];
      try {
        const mod = await import("docx-preview");
        log.push("import ok");
        const bytes = decodeDataUriBytes(dataUrl);
        const blob = new Blob([bytes as BlobPart], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
        log.push("blob " + blob.size);
        const parsed = await mod.parseAsync(blob, { breakPages: true, renderHeaders: true, renderFooters: true, inWrapper: true, className: "docx" });
        log.push("parse ok");
        const nodes = await mod.renderDocument(parsed, { breakPages: true, renderHeaders: true, renderFooters: true, inWrapper: true, className: "docx" });
        log.push("render ok nodes=" + nodes.length);
      } catch (e) {
        log.push("ERR " + String(e).slice(0, 200));
      }
      return log.join(" | ");
    },
    stats: () => ({
      active: imageViewerStats.active,
      stageListeners: imageViewerStats.stageListeners,
      observers: imageViewerStats.observers,
      objectUrlCalls,
      viewerDom: document.querySelectorAll(".image-viewer").length,
      pdf: { ...pdfViewerStats },
      pdfDom: document.querySelectorAll(".pdf-viewer").length,
      docx: { ...docxViewerStats },
      docxDom: document.querySelectorAll(".docx-viewer").length,
      xlsx: { ...xlsxViewerStats },
      xlsxDom: document.querySelectorAll(".xlsx-viewer").length,
      pptx: { ...pptxViewerStats },
      pptxDom: document.querySelectorAll(".pptx-viewer").length,
    }),
  };

  const root = document.getElementById("root");
  if (!root) throw new Error("no #root");

  if (kind === "chat-svg") {
    await renderChatSvg(file);
    return;
  }

  if (kind === "image") {
    await renderImage(file);
    if (zoom100) {
      // 等 fit 首帧后切 100%（Golden zoom 场景）
      window.setTimeout(() => {
        document.querySelector<HTMLButtonElement>('[data-action="zoom-100"]')?.click();
      }, 900);
    }
    return;
  }

  if (kind === "pdf") {
    await renderPdf(file);
    if (params.get("pdfzoom") === "100") {
      const tryZoom = (): void => {
        const btn = document.querySelector<HTMLButtonElement>('[data-action="zoom-100"]');
        if (btn) {
          btn.click();
          return;
        }
        window.setTimeout(tryZoom, 300);
      };
      window.setTimeout(tryZoom, 600);
    }
    return;
  }

  if (kind === "xlsx") {
    await renderXlsx(file);
    return;
  }

  if (kind === "pptx") {
    await renderPptx(file);
    return;
  }

  if (kind === "docx") {
    await renderDocx(file);
    if (params.get("docxzoom") === "100") {
      const tryZoom = (): void => {
        const btn = document.querySelector<HTMLButtonElement>('[data-action="zoom-100"]');
        if (btn) {
          btn.click();
          return;
        }
        window.setTimeout(tryZoom, 300);
      };
      window.setTimeout(tryZoom, 600);
    }
    return;
  }

  const response = await fetch(`w5a-fixture:///${encodeURIComponent(file)}`);
  if (!response.ok) throw new Error(`w5a-fixture load failed: ${file}`);
  const content = await response.text();
  root.className = kind === "markdown" ? "preview-md" : "preview-code";

  if (kind === "markdown") {
    createRoot(root).render(<MarkdownArtifactView content={content} />);
    return;
  }

  createRoot(root).render(<CodeView content={content} language={lang} />);

  if (edit) {
    // 等待编辑按钮出现后进入编辑态（Monaco lazy load 路径与生产一致）
    const tryEnter = (): void => {
      const button = document.querySelector<HTMLButtonElement>('.code-view-btn[data-action="edit"]');
      if (button && !button.disabled) {
        button.click();
        return;
      }
      window.setTimeout(tryEnter, 200);
    };
    window.setTimeout(tryEnter, 400);
  }
}

void main();
