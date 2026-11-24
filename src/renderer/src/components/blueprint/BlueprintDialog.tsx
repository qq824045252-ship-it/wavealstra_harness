import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconFolderKanban, IconPuzzle, IconX } from "@/components/common/icons";
import { useBlockNativeSurfaces } from "@/hooks/useBlockNativeSurfaces";
import "./BlueprintDialog.css";

interface Props {
  title: string;
  sourceName: string;
  kind: "workspace" | "gadget";
  busy: boolean;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}

export default function BlueprintDialog({ title, sourceName, kind, busy, onClose, children, footer }: Props): React.JSX.Element {
  const titleId = useId();
  const sourceId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const SourceIcon = kind === "workspace" ? IconFolderKanban : IconPuzzle;

  useBlockNativeSurfaces(true);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    element.querySelector<HTMLElement>("[data-blueprint-initial-focus]")?.focus();
    return () => element.close();
  }, []);

  return createPortal(
    <dialog
      ref={dialog}
      className={`blueprint-dialog blueprint-dialog--${kind}`}
      aria-labelledby={titleId}
      aria-describedby={sourceId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header className="blueprint-dialog-header">
        <span className="blueprint-dialog-source-icon"><SourceIcon size={21} /></span>
        <div className="blueprint-dialog-source">
          <h2 id={titleId}>{title}</h2>
          <p id={sourceId} title={sourceName}>{sourceName}</p>
        </div>
        <button type="button" className="icon-btn blueprint-dialog-close" aria-label="关闭 Blueprint" disabled={busy} onClick={onClose}>
          <IconX size={17} />
        </button>
      </header>
      {children}
      <footer className="blueprint-dialog-footer">{footer}</footer>
    </dialog>,
    document.body,
  );
}
