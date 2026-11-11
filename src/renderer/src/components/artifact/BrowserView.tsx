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
import { browserTabKey, type BrowserTabInfo, type BrowserTabsState } from "@shared/browser-tabs";
import type { CaptureModeStateEvent } from "@shared/capture-mode";
import { HOME_BROWSER_KEY, normalizeBrowserUrl } from "@/lib/browserLinks";
import { useAppStore } from "@/store/appStore";
import BrowserNavBar from "./BrowserNavBar";
import CaptureModeStatus from "./CaptureModeStatus";
import BrowserConsolePanel from "./BrowserConsolePanel";

export default function BrowserView(): React.JSX.Element {
  const modelId = useAppStore((s) => s.activeModelId);
  const activeTaskId = useAppStore((s) => s.activeTaskId);
  const sessionKey = activeTaskId ?? HOME_BROWSER_KEY;
  const browserUrl = useAppStore((s) => s.browserUrlByTask[sessionKey]);
  const browserFrameKey = useAppStore((s) => s.browserFrameKey);
  const setBrowserUrl = useAppStore((s) => s.setBrowserUrl);
  const browserNavigationVersion = useAppStore((s) => s.browserNavigationVersion);
  const browserGadget = useAppStore((s) => s.browserGadgetByTask[sessionKey]);
  const refreshBrowser = useAppStore((s) => s.refreshBrowser);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const requestRef = useRef<{ sessionKey: string; url: string; version: number; frame: number } | null>(null);
  const pendingOpen = useRef<{ key: string; url: string; loading: boolean } | null>(null);
  const [tabsState, setTabsState] = useState<BrowserTabsState>({ activeTabId: null, tabs: [] });
  const openErrorTimer = useRef<number | null>(null);
  const [captureState, setCaptureState] = useState<CaptureModeStateEvent>({ state: "idle" });
  const [openBrowserError, setOpenBrowserError] = useState<string | null>(null);

  const tabs = tabsState.tabs.filter((tab) => tab.taskId === (activeTaskId ?? undefined) && tab.key !== "legacy");
  const selectedTab = tabs.find((tab) => tab.id === tabsState.activeTabId);
  const activeUrl = selectedTab?.url ?? browserUrl ?? null;
  const tabsAvailable = typeof window.api?.browser?.getTabs === "function";

  // Native navigation and selection update display state, never create a new
  // navigation intent or erase the Gadget identity of the retained document.
  const rememberTab = useCallback((tab: BrowserTabInfo): void => {
    const store = useAppStore.getState();
    if (tab.taskId !== (store.activeTaskId ?? undefined)) return;
    const key = store.activeTaskId ?? HOME_BROWSER_KEY;
    requestRef.current = { sessionKey: key, url: tab.url, version: store.browserNavigationVersion, frame: store.browserFrameKey };
    useAppStore.setState((state) => {
      const bindings = { ...state.browserGadgetByTask };
      if (tab.gadgetId) bindings[key] = { gadgetId: tab.gadgetId, url: tab.url };
      else delete bindings[key];
      return { browserTabByTask: { ...state.browserTabByTask, [key]: { id: tab.id, key: tab.key, url: tab.url } },
        browserUrlByTask: { ...state.browserUrlByTask, [key]: tab.url },
        browserGadgetByTask: bindings, browserUrlInput: tab.url };
    });
  }, []);

  useEffect(() => {
    const browser = window.api?.browser;
    if (!browser?.getTabs || !browser.onTabsChanged) return;
    let disposed = false;
    let receivedEvent = false;
    const receive = (state: BrowserTabsState): void => {
      if (disposed) return;
      setTabsState(state);
      const current = useAppStore.getState();
      if (requestRef.current && requestRef.current.version !== current.browserNavigationVersion) return;
      const tab = state.tabs.find((candidate) => candidate.id === state.activeTabId);
      if (!tab) {
        const store = useAppStore.getState();
        const key = store.activeTaskId ?? HOME_BROWSER_KEY;
        requestRef.current = { sessionKey: key, url: "", version: store.browserNavigationVersion, frame: store.browserFrameKey };
        useAppStore.setState((current) => {
          const urls = { ...current.browserUrlByTask }, bindings = { ...current.browserGadgetByTask }, tabs = { ...current.browserTabByTask };
          delete urls[key]; delete bindings[key]; delete tabs[key];
          return { browserTabByTask: tabs, browserUrlByTask: urls, browserGadgetByTask: bindings, browserUrlInput: "" };
        });
        return;
      }
      const pending = pendingOpen.current;
      if (pending) {
        if (tab.key !== pending.key) return;
        pending.loading ||= tab.loading;
        if (tab.url !== pending.url && !(pending.loading && !tab.loading)) return;
        pendingOpen.current = null;
      }
      rememberTab(tab);
    };
    const off = browser.onTabsChanged((state) => { receivedEvent = true; receive(state); });
    void browser.getTabs().then((state) => { if (!receivedEvent) receive(state); }).catch(console.error);
    return () => { disposed = true; off(); };
  }, [rememberTab]);
  // 与 HtmlArtifactView 一致：preload 缺 API 时禁用并提示重启
  const openExternalAvailable = typeof window.api?.browser?.openExternal === "function";
  const hardReloadAvailable = typeof window.api?.browser?.hardReload === "function";

  useEffect(() => {
    const browser = window.api?.browser;
    if (!browser) return;
    const next = browserUrl ?? "";
    const prev = requestRef.current;
    if (prev?.sessionKey === sessionKey && prev.url === next
      && prev.version === browserNavigationVersion && prev.frame === browserFrameKey) return;
    const reload = Boolean(prev && prev.sessionKey === sessionKey && prev.frame !== browserFrameKey);
    requestRef.current = { sessionKey, url: next, version: browserNavigationVersion, frame: browserFrameKey };
    if (!next) { browser.hide(); return; }
    const retained = useAppStore.getState().browserTabByTask[sessionKey];
    const key = retained?.key ?? browserTabKey(next, browserGadget?.gadgetId);
    pendingOpen.current = { key, url: next, loading: false };
    const open = (): void => browser.open(next, { key, taskId: activeTaskId ?? undefined, gadgetId: browserGadget?.gadgetId, reload });
    if (retained && retained.url === next && !reload && browser.getTabs) {
      // While the panel was hidden, the real document may have followed a link
      // or automation navigation. Restore its identity, never replay an old URL.
      void browser.getTabs().then((state) => {
        const current = useAppStore.getState();
        if ((current.activeTaskId ?? HOME_BROWSER_KEY) !== sessionKey
          || current.browserNavigationVersion !== browserNavigationVersion) return;
        const tab = state.tabs.find((candidate) => candidate.id === retained.id);
        if (!tab) { open(); return; }
        pendingOpen.current = null;
        rememberTab(tab);
        browser.selectTab(tab.id);
      }).catch(console.error);
    } else open();
  }, [browserUrl, browserFrameKey, browserNavigationVersion, sessionKey, activeTaskId, browserGadget?.gadgetId, rememberTab]);

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
    window.api?.browser?.hide();
    requestRef.current = null;
    if (openErrorTimer.current !== null) window.clearTimeout(openErrorTimer.current);
  }, []);


  const reportRect = useCallback(() => {
    const browser = window.api?.browser;
    const host = hostRef.current;
    if (!browser || !host || !activeUrl) return;
    const rect = host.getBoundingClientRect();
    browser.setRect({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
  }, [activeUrl, selectedTab?.id]);

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
    window.api?.browser?.hide();
    const store = useAppStore.getState();
    const prevMode = store.browserPreviousPanelMode ?? "gadgets";
    if (prevMode === "gadgets") {
      store.showGadgets();
    } else if (prevMode === "overview") {
      store.showOverview();
    } else if (prevMode === "artifacts") {
      store.showArtifacts();
    } else if (prevMode === "workspace") {
      store.showWorkspace();
    } else if (prevMode === "terminal") {
      store.showTerminal();
    } else if (prevMode === "changes") {
      store.showChanges();
    } else {
      store.showGadgets();
    }
  };

  const navigateTo = useCallback(
    (raw: string): void => {
      const url = normalizeBrowserUrl(raw) ?? raw.trim();
      if (!url) return;
      window.api?.captureMode?.exit();
      if (url === activeUrl) refreshBrowser();
      else if (selectedTab && tabsAvailable) {
        pendingOpen.current = { key: selectedTab.key, url, loading: false };
        window.api?.browser?.navigate(url);
      } else setBrowserUrl(url);
    },
    [activeUrl, refreshBrowser, setBrowserUrl, selectedTab, tabsAvailable],
  );

  return (
    <div className="browser-view">
      {tabsAvailable && (
        <div className="browser-tabs" role="tablist" aria-label="浏览器标签页">
          {tabs.map((tab) => (
            <div key={tab.id} className={`browser-tab${tab.id === selectedTab?.id ? " active" : ""}`}>
              <button type="button" role="tab" aria-selected={tab.id === selectedTab?.id}
                title={tab.url || "新标签页"} onClick={() => {
                  pendingOpen.current = null;
                  rememberTab(tab);
                  window.api?.browser?.selectTab(tab.id);
                }}>{tab.loading ? "◌ " : ""}{tab.title || tab.url || "新标签页"}</button>
              <button type="button" className="browser-tab-close" aria-label={`关闭标签：${tab.title || tab.url || "新标签页"}`}
                onClick={() => window.api?.browser?.closeTab(tab.id)}>×</button>
            </div>
          ))}
          <button type="button" className="browser-tab-new" aria-label="新建标签页" title="新建标签页"
            onClick={() => {
              pendingOpen.current = null;
              void window.api?.browser?.ensureTab({ key: `new:${Array.from(crypto.getRandomValues(new Uint32Array(4)), (part) => part.toString(16)).join("-")}`, taskId: activeTaskId ?? undefined })
                .then(rememberTab).catch(console.error);
            }}>+</button>
        </div>
      )}
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
        closeLabel="收起浏览器（保留标签页）"
        captureMode={{
          active: captureActive,
          busy: captureBusy,
          error: captureError,
          disabledReason: activeUrl ? undefined : "请先打开网页再使用抓取模式",
          onToggle: toggleCapture,
        }}
      />
      {!tabsAvailable && (
        <div className="artifact-browser-notice" role="status">多标签功能需要重启 MyBuddy 后使用</div>
      )}
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
