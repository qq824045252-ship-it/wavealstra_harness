/**
 * PromptEnhanceControl：Prompt Enhance 展示组件。
 * 不持有业务状态，状态与回调全部来自 props。
 *
 * 渲染规则（状态机）：
 * - 无文本且不在增强中、无 notice → 整组不渲染（默认隐藏，不占工具栏）；
 * - idle → ✨ 图标（tooltip：增强提示词）；
 * - enhancing → 禁用 ✨ + pulse（文案只进 title/aria）；
 * - applied + canUndo → 同一位置换成恢复图标，点击恢复；「恢复原文」仅 hover/focus 出现；
 * - applied 后用户已改字 → 回到 ✨，可再次增强；
 * - error / cancelled → 只展示 notice。
 * 挂载位置：ChatInput 工具栏、语音输入左侧。工具栏只放一个图标。
 */
import "./prompt-enhance.css";
import { IconRotate, IconSparkles } from "@/components/common/icons";
import {
  ENHANCE_ENHANCING_LABEL,
  ENHANCE_LABEL,
  ENHANCE_RESTORE_LABEL,
  type EnhanceStatus,
  type EnhanceSurface,
} from "./types";

export interface PromptEnhanceControlProps {
  status: EnhanceStatus;
  notice: string | null;
  /** currentText === applied（用户未在增强后编辑）时才可恢复 */
  canUndo: boolean;
  surface: EnhanceSurface;
  /** 门控未通过（canTriggerEnhance 为 false）时禁用 */
  disabled?: boolean;
  /** 输入框无有效文本：默认隐藏 ✨，不占位 */
  empty?: boolean;
  onEnhance: () => void;
  onUndo: () => void;
}

export function PromptEnhanceControl({
  status,
  notice,
  canUndo,
  surface,
  disabled = false,
  empty = false,
  onEnhance,
  onUndo,
}: PromptEnhanceControlProps): React.JSX.Element | null {
  const enhancing = status === "enhancing";
  const canRestore = status === "applied" && canUndo;
  // error/cancelled → 只展示 notice；可恢复时同一槽位换成恢复图标
  const showEnhance =
    (status === "idle" || status === "applied" || status === "enhancing") &&
    (!empty || enhancing) &&
    !canRestore;
  const showNotice = notice != null;
  if (!showEnhance && !canRestore && !showNotice) return null;

  const tip = canRestore
    ? ENHANCE_RESTORE_LABEL
    : enhancing
      ? ENHANCE_ENHANCING_LABEL
      : ENHANCE_LABEL;

  return (
    <div className="prompt-enhance-control" data-surface={surface}>
      {showNotice && (
        <div className="prompt-enhance-float">
          <div
            className={`prompt-enhance-notice${status === "error" ? " error" : ""}`}
            role="status"
          >
            {notice}
          </div>
        </div>
      )}
      {(showEnhance || canRestore) && (
        <button
          type="button"
          className={`prompt-enhance-trigger${enhancing ? " busy" : ""}${canRestore ? " restore" : ""}`}
          disabled={!canRestore && (enhancing || disabled)}
          aria-label={tip}
          aria-busy={enhancing}
          onClick={canRestore ? onUndo : onEnhance}
        >
          {canRestore ? (
            <IconRotate size={16} />
          ) : (
            <IconSparkles size={16} className={enhancing ? "prompt-enhance-pulse" : ""} />
          )}
          <span className="prompt-enhance-tip" role="tooltip">
            {tip}
          </span>
        </button>
      )}
    </div>
  );
}
