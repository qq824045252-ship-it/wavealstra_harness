import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useBlockNativeSurfaces } from "@/hooks/useBlockNativeSurfaces";
import "./ChatReadability.css";

export default function ChatReadingDialog({ title, onClose, children, actions }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  useBlockNativeSurfaces(true);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return createPortal(<dialog ref={dialog} className="chat-reading-dialog" aria-labelledby={id}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><strong id={id}>{title}</strong>{actions}
      <button type="button" className="chat-reading-button" onClick={onClose} autoFocus>关闭</button>
    </header>
    <div className="chat-reading-dialog-body">{children}</div>
  </dialog>, document.body);
}
