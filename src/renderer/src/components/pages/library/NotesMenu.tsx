import { useRef, useState, type ReactNode } from "react";
import { useBlockNativeSurfaces } from "@/hooks/useBlockNativeSurfaces";

interface Props {
  label: string;
  ariaLabel?: string;
  tree?: boolean;
  children: ReactNode;
}

export function closeNotesMenu(menu: HTMLDetailsElement | null): void {
  if (!menu?.open) return;
  const restoreFocus = menu.contains(document.activeElement);
  menu.open = false;
  if (restoreFocus) menu.querySelector("summary")?.focus({ preventScroll: true });
}

export default function NotesMenu({ label, ariaLabel, tree, children }: Props): React.JSX.Element {
  const menuRef = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  useBlockNativeSurfaces(open);

  return <details ref={menuRef} name="mybuddy-notes-menu" className={tree ? "notes-menu notes-tree-menu" : "notes-menu"}
    onToggle={(event) => {
      if (event.currentTarget === event.target) setOpen(event.currentTarget.open);
    }}>
    <summary aria-label={ariaLabel}>{label}</summary>
    <div onClick={(event) => {
      if (event.target instanceof Element && event.target.closest("button")) closeNotesMenu(menuRef.current);
    }}>{children}</div>
  </details>;
}
