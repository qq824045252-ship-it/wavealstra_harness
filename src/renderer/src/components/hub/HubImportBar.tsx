import type { ReactNode } from "react";

type Props = {
  onCreate?: () => void;
  createLabel?: string;
  onImportZip?: () => void;
  onImportFolder?: () => void;
  busyId: string | null;
  hint?: string;
  rightAction?: ReactNode;
};

export function HubImportBar({ onCreate, createLabel = "创建", onImportZip, onImportFolder, busyId, hint, rightAction }: Props) {
  return (
    <div className="hub-import-bar">
      <div className="hub-import-bar-main">
        {onCreate && (
          <button type="button" className="btn primary" disabled={busyId != null} onClick={onCreate}>
            {createLabel}
          </button>
        )}
        {onImportZip && (
          <button
            type="button"
            className={`btn${onCreate ? "" : " primary"}`}
            disabled={busyId === "import-zip" || busyId === "import-drop"}
            onClick={onImportZip}
          >
            {busyId === "import-zip" ? "导入中…" : "导入 ZIP"}
          </button>
        )}
        {onImportFolder && (
          <button
            type="button"
            className={`btn${onImportZip || onCreate ? "" : " primary"}`}
            disabled={busyId === "import-folder" || busyId === "import-drop"}
            onClick={onImportFolder}
          >
            {busyId === "import-folder" ? "导入中…" : "从文件夹导入"}
          </button>
        )}
        {hint && <span className="hub-import-hint">{hint}</span>}
      </div>
      {rightAction && <div className="hub-import-bar-action">{rightAction}</div>}
    </div>
  );
}

export function HubDropOverlay({ visible, text }: { visible: boolean; text: string }) {
  if (!visible) return null;
  return <div className="hub-drop-overlay">{text}</div>;
}
