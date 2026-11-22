import { useEffect, useId, useRef, type ReactNode } from "react";
import { useBlockNativeSurfaces } from "@/hooks/useBlockNativeSurfaces";

interface Props {
  title: string;
  className?: string;
  onCancel: () => void;
  children: ReactNode;
}

export function ReviewDialog({ title, className = "", onCancel, children }: Props): React.JSX.Element {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  useBlockNativeSurfaces(true);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  return <dialog ref={dialog} className={`code-review-dialog ${className}`} aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); onCancel(); }}>
    <h2 id={titleId}>{title}</h2>
    {children}
  </dialog>;
}
