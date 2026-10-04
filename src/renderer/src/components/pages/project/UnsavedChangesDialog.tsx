import { createPortal } from "react-dom";
import { IconAlert } from "@/components/common/icons";

interface Props {
  open: boolean;
  busy?: boolean;
  onCancel: () => void;
  onDiscard: () => void;
  onSave: () => void;
}

export default function UnsavedChangesDialog({
  open,
  busy = false,
  onCancel,
  onDiscard,
  onSave,
}: Props): React.JSX.Element | null {
  if (!open) return null;
  return createPortal(
    <div
      className="modal-overlay full-access-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="unsaved-changes-title"
      onClick={() => !busy && onCancel()}
    >
      <div className="full-access-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="full-access-dialog-head">
          <span className="full-access-dialog-icon" aria-hidden>
            <IconAlert size={18} />
          </span>
          <h2 id="unsaved-changes-title" className="full-access-dialog-title">
            有未保存的更改
          </h2>
        </div>
        <div className="full-access-dialog-body">你在当前页面的修改尚未保存。</div>
        <div className="full-access-dialog-actions">
          <button type="button" className="btn" disabled={busy} onClick={onCancel}>取消</button>
          <button type="button" className="btn" disabled={busy} onClick={onDiscard}>放弃更改</button>
          <button type="button" className="btn primary" disabled={busy} onClick={onSave}>
            {busy ? "保存中…" : "保存并继续"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
