/**
 * 扩展栏浏览器（外链 / Penpot / 任意 http(s)）
 *
 * 与 HtmlArtifactView（HTML 产物预览）的关系：
 * - 两套独立 WebContentsView 宿主，共用同一套 BrowserNavBar + CaptureModeStatus UI
 * - 本视图 → BrowserHost（persist:extension-browser，可导航 http(s)）
 * - 产物预览 → ArtifactPreviewHost（mybuddy-artifact://，沙箱产物）
 * - 抓取模式 / 在系统浏览器打开 语义对齐产物预览，但 IPC 走 browser 通道
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { CaptureModeStateEvent } from "@shared/capture-mode";
import { HOME_BROWSER_KEY, normalizeBrowserUrl } from "@/lib/browserLinks";
import { useAppStore } from "@/store/appStore";
import BrowserNavBar from "./BrowserNavBar";
import CaptureModeStatus from "./CaptureModeStatus";
import BrowserConsolePanel from "./BrowserConsolePanel";
import ExtensionModeDropdown from "./ExtensionModeDropdown";

export default function BrowserView(): React.JSX.Element {
  const modelId = useAppStore((s) => s.activeModelId);
  const activeTaskId = useAppStore((s) => s.activeTaskId);
  const sessionKey = activeTaskId ?? HOME_BROWSER_KEY;
  const browserUrl = useAppStore((s) => s.browserUrlByTask[sessionKey]);
  const browserFrameKey = useAppStore((s) => s.browserFrameKey);
  const setBrowserUrl = useAppStore((s) => s.setBrowserUrl);
  const closePanel = useAppStore((s) => s.closePanel);
  const refreshBrowser = useAppStore((s) => s.refreshBrowser);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const openErrorTimer = useRef<number | null>(null);
  const [captureState, setCaptureState] = useState<CaptureModeStateEvent>({ state: "idle" });
  const [openBrowserError, setOpenBrowserError] = useState<string | null>(null);

  const activeUrl = browserUrl ?? null;
  // 与 HtmlArtifactView 一致：preload 缺 API 时禁用并提示重启
  const openExternalAvailable = typeof window.api?.browser?.openExternal === "function";
  const hardReloadAvailable = typeof window.api?.browser?.hardReload === "function";

  useEffect(() => {
    const browser = window.api?.browser;
    if (!browser) return;
    const next = activeUrl ?? "";
    const prev = urlRef.current ?? "";
    urlRef.current = next;
    if (!next) {
      browser.close();
      return;
    }
    if (next !== prev) browser.open(next);
    else browser.hardReload();
  }, [activeUrl, browserFrameKey]);

  useEffect(() => {
    const capture = window.api?.captureMode;
    if (!capture) return;
    const off = capture.onState((event) => setCaptureState(event));
    return () => {
      off();
      capture.exit();
    };
  }, []);

  useEffect(() => () => {
    window.api?.browser?.close();
    urlRef.current = null;
    if (openErrorTimer.current !== null) window.clearTimeout(openErrorTimer.current);
  }, []);

  useEffect(() => {
    const browser = window.api?.browser;
    if (!browser) return;
    return browser.onUrlChanged((url) => {
      if (url && url !== useAppStore.getState().browserUrlByTask[sessionKey]) {
        setBrowserUrl(url);
      }
    });
  }, [sessionKey, setBrowserUrl]);

  const reportRect = useCallback(() => {
    const browser = window.api?.browser;
    const host = hostRef.current;
    if (!browser || !host || !activeUrl) return;
    const rect = host.getBoundingClientRect();
    browser.setRect({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
  }, [activeUrl]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !activeUrl) return;
    reportRect();
    const observer = new ResizeObserver(reportRect);
    observer.observe(host);
    window.addEventListener("resize", reportRect);
    const onTransitionEnd = (event: TransitionEvent): void => {
      if (["width", "min-width", "max-width"].includes(event.propertyName)) reportRect();
    };
    document.addEventListener("transitionend", onTransitionEnd);
    const lateSync = window.setTimeout(reportRect, 220);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", reportRect);
      document.removeEventListener("transitionend", onTransitionEnd);
      window.clearTimeout(lateSync);
    };
  }, [activeUrl, reportRect]);

  const captureActive = captureState.state === "entering" || captureState.state === "active";
  const captureBusy = captureState.state === "entering";
  const captureError = captureState.state === "error" ? captureState.error : undefined;

  const toggleCapture = useCallback(() => {
    const capture = window.api?.captureMode;
    if (!capture) return;
    if (!activeUrl) return;
    if (captureActive) capture.exit();
    else void capture.enter({ target: "browser" });
  }, [activeUrl, captureActive]);

  const showOpenBrowserError = useCallback((message: string): void => {
    setOpenBrowserError(message);
    if (openErrorTimer.current !== null) window.clearTimeout(openErrorTimer.current);
    openErrorTimer.current = window.setTimeout(() => {
      setOpenBrowserError(null);
      openErrorTimer.current = null;
    }, 6000);
  }, []);

  /** 对齐 HtmlArtifactView：系统浏览器打开 + 能力守卫 + 错误提示 */
  const handleOpenInSystemBrowser = useCallback((): void => {
    const open = window.api?.browser?.openExternal;
    if (typeof open !== "function") {
      showOpenBrowserError("系统浏览器功能尚未加载，请重启 MyBuddy 后重试");
      return;
    }
    if (!activeUrl || !/^https?:/i.test(activeUrl)) {
      showOpenBrowserError("当前没有可打开的网页地址");
      return;
    }
    try {
      open();
      setOpenBrowserError(null);
    } catch (err) {
      showOpenBrowserError(
        `系统浏览器打开失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [activeUrl, showOpenBrowserError]);

  const closeBrowserPreview = (): void => {
    window.api?.captureMode?.exit();
    window.api?.browser?.close();
    setBrowserUrl(null);
    closePanel();
  };

  const navigateTo = useCallback(
    (raw: string): void => {
      const url = normalizeBrowserUrl(raw) ?? raw.trim();
      if (!url) return;
      window.api?.captureMode?.exit();
      if (url === activeUrl) refreshBrowser();
      else setBrowserUrl(url);
    },
    [activeUrl, refreshBrowser, setBrowserUrl],
  );

  return (
    <div className="browser-view">
      <ExtensionModeDropdown />
      <BrowserNavBar
        htmlEdit={{ target: "browser", modelId }}
        url={activeUrl ?? ""}
        editable
        onNavigate={navigateTo}
        onBack={() => window.api?.browser?.back()}
        onForward={() => window.api?.browser?.forward()}
        onHardRefresh={
          activeUrl
            ? () => {
                if (typeof window.api?.browser?.hardReload !== "function") return;
                window.api?.captureMode?.exit();
                window.api.browser.hardReload();
              }
            : undefined
        }
        hardDisabled={!hardReloadAvailable}
        onOpenInBrowser={handleOpenInSystemBrowser}
        openDisabled={!openExternalAvailable || !activeUrl}
        onClose={closeBrowserPreview}
        captureMode={{
          active: captureActive,
          busy: captureBusy,
          error: captureError,
          disabledReason: activeUrl ? undefined : "请先打开网页再使用抓取模式",
          onToggle: toggleCapture,
        }}
      />
      {!openExternalAvailable && (
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
      <div ref={hostRef} className="browser-wcv-host" />
      <BrowserConsolePanel target="browser" pageUrl={activeUrl ?? undefined} sourceLabel="MyBuddy 内置浏览器" />
    </div>
  );
}
