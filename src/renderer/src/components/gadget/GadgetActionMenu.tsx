import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDismissOnClickOutside } from "@/hooks/useDismissOnClickOutside";
import { layoutRect, layoutViewportSize, placeFixedMenu } from "@/lib/placeFixedMenu";

interface Props {
  anchor: HTMLElement;
  onClose: () => void;
  children: ReactNode;
}

/** Escape list clipping while retaining the shared menu appearance and placement. */
export default function GadgetActionMenu({ anchor, onClose, children }: Props): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLElement>(anchor);
  anchorRef.current = anchor;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [position, setPosition] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  useDismissOnClickOutside(true, onClose, menuRef, [anchorRef]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const measure = (): void => {
      const placed = placeFixedMenu({
        anchor: layoutRect(anchor),
        menuWidth: menu.offsetWidth,
        menuHeight: menu.scrollHeight + menu.offsetHeight - menu.clientHeight,
        viewport: layoutViewportSize(),
        maxHeight: 360,
      });
      setPosition(previous => previous && previous.top === placed.top && previous.left === placed.left && previous.maxHeight === placed.maxHeight
        ? previous : { top: placed.top, left: placed.left, maxHeight: placed.maxHeight });
    };
    const dismissOnScroll = (event: Event): void => {
      // Scrolling a height-constrained menu must not dismiss its own actions.
      if (event.target instanceof Node && menu.contains(event.target)) return;
      closeRef.current();
    };
    const restoreFocus = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && anchor.isConnected) anchor.focus();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(menu);
    observer.observe(anchor);
    observer.observe(document.body);
    window.addEventListener("resize", measure);
    document.addEventListener("scroll", dismissOnScroll, true);
    window.addEventListener("keydown", restoreFocus);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      document.removeEventListener("scroll", dismissOnScroll, true);
      window.removeEventListener("keydown", restoreFocus);
    };
  }, [anchor]);

  return createPortal(
    <div ref={menuRef} className="gadget-action-menu-popover" role="menu"
      style={position ?? { top: 0, left: 0, visibility: "hidden" }}>
      {children}
    </div>,
    document.body,
  );
}
