import { useLayoutEffect, useRef, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { useBlockNativeSurfaces } from "@/hooks/useBlockNativeSurfaces";
import "./ContextMenuSurface.css";

export interface ContextMenuHeading {
  title: string;
  icon: ReactNode;
}

interface Props {
  menuRef: RefObject<HTMLDivElement | null>;
  style: CSSProperties;
  heading?: ContextMenuHeading;
  className?: string;
  onClose: () => void;
  children: ReactNode;
}

function enabledActions(menu: HTMLDivElement): HTMLButtonElement[] {
  return Array.from(menu.querySelectorAll<HTMLButtonElement>("button[role=menuitem]:not(:disabled)"));
}

export default function ContextMenuSurface({
  menuRef, style, heading, className, onClose, children,
}: Props): React.JSX.Element {
  const opener = useRef<HTMLElement | null>(null);
  const isActionMenu = Boolean(heading);
  const placed = style.visibility !== "hidden";

  useBlockNativeSurfaces(true);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!isActionMenu || !placed || !menu) return;
    const active = menu.ownerDocument.activeElement;
    opener.current = active instanceof HTMLElement && !menu.contains(active) ? active : null;
    (enabledActions(menu)[0] ?? menu).focus({ preventScroll: true });
  }, [isActionMenu, menuRef, placed]);

  const handleKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    // Portal keyboard events still bubble through their React row.
    event.stopPropagation();
    if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") event.preventDefault();
      onClose();
      if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = enabledActions(event.currentTarget);
    if (items.length === 0) return;

    const active = items.findIndex((item) => item === event.currentTarget.ownerDocument.activeElement);
    let next: number;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else if (event.key === "ArrowDown") next = (active + 1) % items.length;
    else next = active <= 0 ? items.length - 1 : active - 1;
    items[next]?.focus();
  };

  return (
    <div
      ref={menuRef}
      className={["task-context-menu", "task-context-menu-portal", "context-action-menu", className].filter(Boolean).join(" ")}
      role={isActionMenu ? "menu" : undefined}
      aria-label={heading?.title}
      tabIndex={isActionMenu ? -1 : undefined}
      style={style}
      onKeyDown={isActionMenu ? handleKey : undefined}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {heading && (
        <div className="context-action-menu-header" aria-hidden="true">
          <span className="context-action-menu-target-icon">{heading.icon}</span>
          <span className="context-action-menu-title" title={heading.title}>{heading.title}</span>
        </div>
      )}
      {children}
    </div>
  );
}
