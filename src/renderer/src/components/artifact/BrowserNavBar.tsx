import { useEffect, useRef, useState } from "react";
import { IconArrowUpRight, IconGlobe, IconRefresh, IconTarget, IconX } from "@/components/common/icons";
import HtmlEditButton from "./HtmlEditButton";

interface Props {
  htmlEdit?: { target: "browser" | "artifact"; artifactId?: string; modelId?: string };
  url: string;
  onBack?: () => void;
  onForward?: () => void;
  /** 唯一刷新入口：绕过缓存；无页面时点击提示原因。 */
  onHardRefresh?: () => void;
  /** preload 缺 hardReload（stale preload）时禁用并提示重启 */
  hardDisabled?: boolean;
  onOpenInBrowser?: () => void;
  onClose?: () => void;
  /** 可编辑地址栏（扩展栏浏览器）；产物预览保持只读展示 */
  editable?: boolean;
  /** 地址栏提交（Enter 或失焦有变更时）；仅 editable 时有效 */
  onNavigate?: (url: string) => void;
  /** preload 未提供 openInBrowser（stale preload，需重启 MyBuddy）时禁用并提示 */
  openDisabled?: boolean;
  /** Wave 4C：Capture Mode 切换（HTML 产物预览 / 扩展栏浏览器） */
  captureMode?: {
    active: boolean;
    busy: boolean;
    error?: string;
    /** 禁用原因（如尚未打开网页）；有值时按钮 disabled 并显示该 title */
    disabledReason?: string;
    onToggle: () => void;
  };
}

/**
 * 统一地址栏：产物预览展示 mybuddy-artifact://；扩展栏浏览器可编辑并导航。
 */
export default function BrowserNavBar({
  url,
  onBack,
  onForward,
  onHardRefresh,
  hardDisabled = false,
  onOpenInBrowser,
  onClose,
  editable = false,
  onNavigate,
  openDisabled = false,
  captureMode,
  htmlEdit,
}: Props): React.JSX.Element {
  const [draft, setDraft] = useState(url);
  /** 瞬时反馈：点击刷新后显示“正在刷新…”，1.2s 自动消失；无页面时提示原因 */
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<number | null>(null);

  useEffect(() => {
    setDraft(url);
  }, [url]);

  useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    },
    [],
  );

  const triggerFlash = (message: string): void => {
    setFlash(message);
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => {
      setFlash((cur) => (cur === message ? null : cur));
      flashTimer.current = null;
    }, 1200);
  };

  /** 刷新点击统一入口：无 handler（无页面）时明确提示，不静默吞点击 */
  const fireRefresh = (fn: (() => void) | undefined): void => {
    if (typeof fn !== "function") {
      triggerFlash("没有可刷新的页面");
      return;
    }
    triggerFlash("正在刷新…");
    fn();
  };

  const submit = (): void => {
    const next = draft.trim();
    if (!next || !onNavigate) return;
    onNavigate(next);
  };

  return (
    <div className="extension-browser-nav">
      <button
        type="button"
        className="extension-nav-arrow"
        title="后退"
        disabled={!onBack}
        onClick={onBack}
      >
        ‹
      </button>
      <button
        type="button"
        className="extension-nav-arrow"
        title="前进"
        disabled={!onForward}
        onClick={onForward}
      >
        ›
      </button>
      {editable ? (
        <form
          className="extension-url-bar"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <IconGlobe size={14} className="extension-url-globe" />
          <input
            className="extension-url-input"
            value={draft}
            placeholder="输入网址，回车打开…"
            aria-label="浏览器地址"
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              // 失焦时若与当前 url 不同且非空则导航（便于点选后提交）
              if (draft.trim() && draft.trim() !== url) submit();
            }}
          />
          <button
            type="button"
            className="icon-btn extension-url-refresh extension-url-hard-refresh"
            title={hardDisabled ? "硬刷新功能尚未加载，请重启 MyBuddy 后使用" : "硬刷新（忽略缓存）"}
            aria-label="硬刷新（忽略缓存）"
            disabled={hardDisabled}
            onClick={() => fireRefresh(onHardRefresh)}
          >
            <IconRefresh size={14} />
          </button>
          {flash && (
            <span className="extension-nav-flash" role="status">
              {flash}
            </span>
          )}
        </form>
      ) : (
        <div className="extension-url-bar">
          <IconGlobe size={14} className="extension-url-globe" />
          <span className="extension-url-text" title={url}>
            {url}
          </span>
          <button
            type="button"
            className="icon-btn extension-url-refresh extension-url-hard-refresh"
            title={hardDisabled ? "硬刷新功能尚未加载，请重启 MyBuddy 后使用" : "硬刷新（忽略缓存）"}
            aria-label="硬刷新（忽略缓存）"
            disabled={hardDisabled}
            onClick={() => fireRefresh(onHardRefresh)}
          >
            <IconRefresh size={14} />
          </button>
          {flash && (
            <span className="extension-nav-flash" role="status">
              {flash}
            </span>
          )}
        </div>
      )}
      {htmlEdit && <HtmlEditButton {...htmlEdit} />}
      {captureMode && (
        <button
          type="button"
          className={`icon-btn capture-mode-toggle${captureMode.active ? " active" : ""}`}
          title={
            captureMode.disabledReason ??
            captureMode.error ??
            (captureMode.active ? "退出抓取模式" : "抓取模式：检查元素")
          }
          aria-label={
            captureMode.disabledReason ??
            captureMode.error ??
            (captureMode.active ? "退出抓取模式" : "抓取模式：检查元素")
          }
          disabled={captureMode.busy || Boolean(captureMode.disabledReason)}
          onClick={captureMode.onToggle}
        >
          <IconTarget size={15} />
        </button>
      )}
      <button
        type="button"
        className="icon-btn"
        title={openDisabled ? "在系统浏览器打开（需重启 MyBuddy 后使用）" : "在系统浏览器打开"}
        aria-label="在系统浏览器打开"
        disabled={openDisabled}
        onClick={onOpenInBrowser}
      >
        <IconArrowUpRight size={15} />
      </button>
      <button
        type="button"
        className="icon-btn"
        title="关闭网页"
        aria-label="关闭网页"
        onClick={onClose}
      >
        <IconX size={15} />
      </button>
    </div>
  );
}
