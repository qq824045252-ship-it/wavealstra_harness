import { useCallback, useEffect, useRef, useState } from "react";
import type { Artifact } from "@/types";
import type { CaptureModeStateEvent } from "@shared/capture-mode";
import { useTextPrompt } from "@/components/common/useTextPrompt";
import { useAppStore } from "@/store/appStore";
import BrowserNavBar from "./BrowserNavBar";
import CaptureModeStatus from "./CaptureModeStatus";
import BrowserConsolePanel from "./BrowserConsolePanel";

/** Wave 4A：与主进程 NativeSurfaceCoordinator 的默认 surface 对齐（§75） */
const SURFACE_MAIN = "artifact-main";
const BLOCKER_MODAL = "modal";

interface Props {
  artifact: Artifact;
  /** 面板内有覆盖层（ExtensionFlyout 等）时隐藏原生视图（原生视图盖在 DOM 之上） */
  overlayOpen?: boolean;
}

/**
 * HTML 产物预览：主进程 WebContentsView 承载（mybuddy-artifact:// 协议），
 * 面板 UI 留在 renderer。Wave 4C：Capture Mode 入口（hover/click 检查元素 →
 * SelectionDescriptor；MVP 不做 SelectionStore/PromptContext）。
 */
export default function HtmlArtifactView({ artifact, overlayOpen = false }: Props): React.JSX.Element {
  const modelId = useAppStore((s) => s.activeModelId);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [captureState, setCaptureState] = useState<CaptureModeStateEvent>({ state: "idle" });
  // 在系统浏览器打开：openInBrowser 是 fa0174e 新增的 preload/main IPC 能力；
  // 运行中的 Electron preload 不会随 renderer HMR 更新，缺失时禁用按钮并提示重启（stale preload）。
  const openBrowserAvailable = typeof window.api?.artifact?.openInBrowser === "function";
  const [openBrowserError, setOpenBrowserError] = useState<string | null>(null);
  const openBrowserErrorTimer = useRef<number | null>(null);
  // Wave 4D：Selection 唯一 truth 在 main SelectionStore；这里只读投影（R14：组件不私存 descriptor）
  const closeArtifactTab = useAppStore((s) => s.closeArtifactTab);
  const activeTaskId = useAppStore((s) => s.activeTaskId);
  const [convertMessage, setConvertMessage] = useState<string | null>(null);
  const { requestText, textPromptDialog, promptOpen } = useTextPrompt();
  const blocksNativeSurface = overlayOpen || promptOpen;

  // 打开：加载产物（内容由主进程按 artifactId 从 Artifact Domain 解析）；卸载时关闭。
  // content/path 变化（版本刷新）时重新加载，保持旧自动刷新行为。
  // Wave 4A：显示意图经 surface.requestVisible（挂载即显式可见）；加载期间
  // 由 Coordinator 的 artifact-switch blocker 隐藏，避免闪旧 surface。
  // Wave 4C：artifact 切换时先退出 Capture Mode（主进程侧还有 generation 防御）。
  useEffect(() => {
    const api = window.api?.artifact;
    if (!api) return;
    window.api?.captureMode?.exit(); // 幂等；切换产物时退出旧 Capture Mode session
    void api.preview({ id: artifact.id });
    api.surface.requestVisible(SURFACE_MAIN, true);
    return () => {
      window.api?.captureMode?.exit();
      api.close();
    };
  }, [artifact.id, artifact.content, artifact.path]);

  // Capture Mode 状态事件订阅（MVP：仅本地展示）；Selection 走 appStore 投影（4D）
  useEffect(() => {
    const api = window.api?.captureMode;
    if (!api) return;
    const offState = api.onState((ev) => setCaptureState(ev));
    return () => offState();
  }, []);

  // 宿主区域上报（DIP），WebContentsView 跟随布局（Coordinator 记录 bounds 并合成可见性）
  const reportRect = useCallback(() => {
    const api = window.api?.artifact;
    const host = hostRef.current;
    if (!api || !host) return;
    const rect = host.getBoundingClientRect();
    api.surface.requestBounds(SURFACE_MAIN, {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    });
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    reportRect();
    const observer = new ResizeObserver(reportRect);
    observer.observe(host);
    window.addEventListener("resize", reportRect);
    // 面板宽度过渡结束后再同步一次，避免右缘被裁
    const onTransitionEnd = (e: TransitionEvent): void => {
      if (
        e.propertyName === "width" ||
        e.propertyName === "min-width" ||
        e.propertyName === "max-width"
      ) {
        reportRect();
      }
    };
    document.addEventListener("transitionend", onTransitionEnd);
    const lateSync = window.setTimeout(reportRect, 220);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", reportRect);
      document.removeEventListener("transitionend", onTransitionEnd);
      window.clearTimeout(lateSync);
    };
  }, [reportRect, artifact.id]);

  // 覆盖层（flyout）打开时隐藏原生视图，关闭后恢复：
  // Wave 4A：blocker token（modal），多来源隐藏叠加时删一个不误显示（§76）
  useEffect(() => {
    const api = window.api?.artifact;
    if (!api) return;
    if (blocksNativeSurface) api.surface.addBlocker(SURFACE_MAIN, BLOCKER_MODAL);
    else api.surface.removeBlocker(SURFACE_MAIN, BLOCKER_MODAL);
    return () => {
      if (blocksNativeSurface) api.surface.removeBlocker(SURFACE_MAIN, BLOCKER_MODAL);
    };
  }, [blocksNativeSurface]);

  const captureActive = captureState.state === "entering" || captureState.state === "active";
  const toggleCapture = useCallback(() => {
    const api = window.api?.captureMode;
    if (!api) return;
    if (captureActive) api.exit();
    else void api.enter({ artifactId: artifact.id });
  }, [captureActive, artifact.id]);

  // 打开失败提示短暂展示后自动消失（非侵入式；成功无需提示）
  const showOpenBrowserError = useCallback((message: string): void => {
    setOpenBrowserError(message);
    if (openBrowserErrorTimer.current !== null) window.clearTimeout(openBrowserErrorTimer.current);
    openBrowserErrorTimer.current = window.setTimeout(() => {
      setOpenBrowserError(null);
      openBrowserErrorTimer.current = null;
    }, 6000);
  }, []);

  useEffect(() => {
    return () => {
      if (openBrowserErrorTimer.current !== null) window.clearTimeout(openBrowserErrorTimer.current);
    };
  }, []);

  const handleOpenInBrowser = useCallback(() => {
    // 防御 stale preload：能力缺失时不调用、不抛 TypeError，明确告知用户原因
    const open = window.api?.artifact?.openInBrowser;
    if (typeof open !== "function") {
      showOpenBrowserError("系统浏览器功能尚未加载，请重启 MyBuddy 后重试");
      return;
    }
    open({ id: artifact.id })
      .then((result) => {
        if (result && !result.ok) {
          showOpenBrowserError(`系统浏览器打开失败：${result.error ?? "未知错误"}`);
        } else {
          setOpenBrowserError(null);
        }
      })
      .catch((err: unknown) => {
        showOpenBrowserError(`系统浏览器打开失败：${err instanceof Error ? err.message : String(err)}`);
      });
  }, [artifact.id, showOpenBrowserError]);

  // 与主进程 artifactUrl() 一致的展示 URL（host 固定 ASCII，id 编码在 path）
  const url = `mybuddy-artifact://local/${encodeURIComponent(artifact.id)}/`;

  const convertToGadget = useCallback(async (): Promise<void> => {
    if (!activeTaskId) { setConvertMessage("请先打开所属任务"); return; }
    const name = await requestText({
      title: "Convert to Gadget",
      label: "Gadget 名称",
      initialValue: artifact.name,
      maxLength: 120,
      confirmLabel: "转换",
    });
    if (!name?.trim()) return;
    try {
      const api = window.api?.gadget;
      if (!api) throw new Error("Gadget 能力尚未加载，请重启 MyBuddy");
      const gadget = await api.convertFromArtifact({
        artifactId: artifact.id,
        scope: { type: "task", taskId: activeTaskId },
        name: name.trim(),
      });
      setConvertMessage(`已创建 Task Gadget：${gadget.name}`);
    } catch (error) {
      setConvertMessage(error instanceof Error ? error.message : String(error));
    }
  }, [activeTaskId, artifact.id, artifact.name, requestText]);

  return (
    <div className="artifact-browser-view">
      <div className="artifact-gadget-convert">
        <button type="button" className="btn" disabled={!activeTaskId} onClick={() => void convertToGadget()}>Convert to Gadget</button>
        {convertMessage && <span>{convertMessage}</span>}
      </div>
      <BrowserNavBar
        htmlEdit={{ target: "artifact", artifactId: artifact.id, modelId }}
        url={url}
        onHardRefresh={() => {
          if (typeof window.api?.artifact?.hardReload !== "function") return;
          window.api?.artifact?.hardReload();
        }}
        hardDisabled={typeof window.api?.artifact?.hardReload !== "function"}
        onOpenInBrowser={handleOpenInBrowser}
        openDisabled={!openBrowserAvailable}
        onClose={() => closeArtifactTab(artifact.id)}
        captureMode={{
          active: captureActive,
          busy: captureState.state === "entering",
          error: captureState.state === "error" ? captureState.error : undefined,
          onToggle: toggleCapture,
        }}
      />
      {!openBrowserAvailable && (
        <div className="artifact-browser-notice" role="status">
          系统浏览器功能尚未加载，请重启 MyBuddy 后重试
        </div>
      )}
      {openBrowserError && (
        <div className="artifact-browser-notice error" role="alert">
          {openBrowserError}
        </div>
      )}
      <CaptureModeStatus captureState={captureState} />
      {/* WebContentsView 承载区域：真实页面在主进程原生视图中渲染 */}
      <div ref={hostRef} className="browser-wcv-host" />
      <BrowserConsolePanel target="artifact" pageUrl={url} sourceLabel="MyBuddy HTML 产物预览" />
      {textPromptDialog}
    </div>
  );
}
