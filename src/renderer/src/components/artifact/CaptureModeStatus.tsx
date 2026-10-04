import type { CaptureModeStateEvent } from "@shared/capture-mode";
import { IconMessageDashed, IconTarget, IconX } from "@/components/common/icons";
import { useAppStore } from "@/store/appStore";

function selectionLabel(d: { tagName: string; id?: string; classNames: string[] }): string {
  const classTail = d.classNames.slice(0, 2).map((c) => `.${c}`).join("");
  return `${d.tagName}${d.id ? `#${d.id}` : ""}${classTail}`;
}

export default function CaptureModeStatus({
  captureState,
}: {
  captureState: CaptureModeStateEvent;
}): React.JSX.Element {
  const selectionState = useAppStore((s) => s.selection);
  const selection = selectionState.status !== "empty" ? selectionState.descriptor : null;
  const selectionStale = selectionState.status === "stale";
  const captureActive = captureState.state === "entering" || captureState.state === "active";

  return (
    <>
      {captureState.state === "error" && (
        <div className="capture-mode-notice error" title={captureState.error}>
          抓取模式不可用：{captureState.error ?? "未知错误"}（预览不受影响）
        </div>
      )}
      {captureActive && !selection && (
        <div className="capture-mode-notice">抓取模式：悬停高亮，点击元素完成选择（Esc 取消）</div>
      )}
      {selection && (
        <div className={`capture-selection-bar${selectionStale ? " stale" : ""}`}>
          <span className="capture-selection-icon" aria-hidden>
            <IconTarget size={12} />
          </span>
          <code className="capture-selection-selector" title={selectionLabel(selection)}>
            {selectionLabel(selection)}
          </code>
          <span className="capture-selection-meta">
            {selectionStale
              ? "已失效（页面已更新）"
              : [
                  selection.text ? selection.text.slice(0, 40) : "（无文本）",
                  `${Math.round(selection.bounds.width)}×${Math.round(selection.bounds.height)}`,
                ].join(" · ")}
          </span>
          <button
            type="button"
            className="icon-btn capture-selection-clear"
            title="清除选择"
            aria-label="清除选择"
            onClick={() => window.api?.selection?.clear()}
          >
            <IconX size={13} />
          </button>
          <button type="button" className="icon-btn" disabled={selectionStale}
            title={selectionStale ? "页面已更新，请重新抓取位置后评论" : "评论到对话"}
            aria-label="评论到对话" onClick={() => window.api?.selection?.comment()}>
            <IconMessageDashed size={13} />
          </button>
        </div>
      )}
    </>
  );
}
