import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconAlert } from "@/components/common/icons";

interface Props {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  /** 危险操作（删除等）时确认按钮用红色样式 */
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/** 通用居中确认弹窗（复用 full-access-dialog 样式） */
export default function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = "确认",
  danger = false,
  onCancel,
  onConfirm,
}: Props): React.JSX.Element | null {
  if (!open) return null;
  // portal 到 body：避免被任何祖先容器的 overflow/裁剪/层叠上下文遮挡
  return createPortal(
    <div
      className="modal-overlay full-access-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      onClick={onCancel}
    >
      <div className="full-access-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="full-access-dialog-head">
          <span className="full-access-dialog-icon" aria-hidden>
            <IconAlert size={18} />
          </span>
          <h2 id="confirm-dialog-title" className="full-access-dialog-title">
            {title}
          </h2>
        </div>
        <div className="full-access-dialog-body">{body}</div>
        <div className="full-access-dialog-actions">
          <button type="button" className="btn" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className={`btn ${danger ? "danger" : "primary"}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
