import { useState } from "react";
import { FULL_ACCESS_CONFIRM } from "./permissionCopy";
import { IconAlert } from "@/components/common/icons";

interface Props {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/** 居中确认弹窗：开启「允许完全访问」前二次确认（对齐官方） */
export default function FullAccessConfirmModal({
  open,
  onCancel,
  onConfirm,
}: Props): React.JSX.Element | null {
  const [agreed, setAgreed] = useState(false);

  if (!open) return null;

  const handleCancel = (): void => {
    setAgreed(false);
    onCancel();
  };

  const handleConfirm = (): void => {
    if (!agreed) return;
    setAgreed(false);
    onConfirm();
  };

  return (
    <div
      className="modal-overlay full-access-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="full-access-title"
      onClick={handleCancel}
    >
      <div className="full-access-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="full-access-dialog-head">
          <span className="full-access-dialog-icon" aria-hidden>
            <IconAlert size={18} />
          </span>
          <h2 id="full-access-title" className="full-access-dialog-title">
            {FULL_ACCESS_CONFIRM.title}
          </h2>
        </div>
        <p className="full-access-dialog-body">
          {FULL_ACCESS_CONFIRM.body.split("\n").map((line, i) => (
            <span key={i}>
              {i > 0 && <br />}
              {line}
            </span>
          ))}
        </p>
        <label className="full-access-dialog-check">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
          />
          <span>{FULL_ACCESS_CONFIRM.checkbox}</span>
        </label>
        <div className="full-access-dialog-actions">
          <button type="button" className="full-access-btn ghost" onClick={handleCancel}>
            {FULL_ACCESS_CONFIRM.cancel}
          </button>
          <button
            type="button"
            className="full-access-btn primary"
            disabled={!agreed}
            onClick={handleConfirm}
          >
            {FULL_ACCESS_CONFIRM.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
