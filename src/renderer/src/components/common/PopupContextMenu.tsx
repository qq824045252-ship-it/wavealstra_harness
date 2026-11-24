import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useDismissOnClickOutside } from "@/hooks/useDismissOnClickOutside";
import { layoutRect, layoutViewportSize, layoutZoom, placeFixedMenu } from "@/lib/placeFixedMenu";
import ContextMenuSurface, { type ContextMenuHeading } from "./ContextMenuSurface";

const MENU_MIN_WIDTH = 176;
const MENU_MAX_HEIGHT = 360;

type Props = (
  | { x: number; y: number; anchorRef?: never }
  | { x?: never; y?: never; anchorRef: RefObject<HTMLElement | null> }
) & {
  heading?: ContextMenuHeading;
  onClose: () => void;
  children: ReactNode;
};

export default function PopupContextMenu({ x, y, anchorRef, heading, onClose, children }: Props): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  useDismissOnClickOutside(true, onClose, menuRef, anchorRef ? [anchorRef] : undefined);

  useLayoutEffect(() => {
    const measure = (): void => {
      const el = menuRef.current;
      if (!el) return;
      const anchorElement = anchorRef?.current;
      const z = layoutZoom();
      const left = (x ?? 0) / z;
      const top = (y ?? 0) / z;
      const placed = placeFixedMenu({
        anchor: anchorElement ? layoutRect(anchorElement) : { top, bottom: top, left, right: left },
        menuWidth: Math.max(el.offsetWidth, MENU_MIN_WIDTH),
        menuHeight: el.scrollHeight + el.offsetHeight - el.clientHeight,
        viewport: layoutViewportSize(),
        minWidth: MENU_MIN_WIDTH,
        maxHeight: MENU_MAX_HEIGHT,
        align: anchorElement ? "end" : "start",
      });
      setPos((prev) => {
        if (prev?.top === placed.top && prev.left === placed.left && prev.maxHeight === placed.maxHeight) {
          return prev;
        }
        return { top: placed.top, left: placed.left, maxHeight: placed.maxHeight };
      });
    };
    measure();
    const raf = requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, [x, y, anchorRef]);

  return createPortal(
    <ContextMenuSurface
      menuRef={menuRef}
      className="file-context-menu"
      heading={heading}
      style={pos ?? { visibility: "hidden", top: 0, left: 0 }}
      onClose={onClose}
    >
      {children}
    </ContextMenuSurface>,
    document.body,
  );
}
