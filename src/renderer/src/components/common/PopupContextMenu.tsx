import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDismissOnClickOutside } from "@/hooks/useDismissOnClickOutside";
import { layoutViewportSize, layoutZoom, placeFixedMenu } from "@/lib/placeFixedMenu";

const MENU_MIN_WIDTH = 176;
const MENU_MAX_HEIGHT = 360;

interface Props {
  x: number;
  y: number;
  onClose: () => void;
  children: ReactNode;
}

/** 右键弹出菜单：portal 到 body，按点击坐标贴边。 */
export default function PopupContextMenu({ x, y, onClose, children }: Props): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  useDismissOnClickOutside(true, onClose, menuRef);

  useLayoutEffect(() => {
    const measure = (): void => {
      const el = menuRef.current;
      const z = layoutZoom();
      const placed = placeFixedMenu({
        anchor: { top: y / z, bottom: y / z, left: x / z, right: x / z },
        menuWidth: Math.max(el?.offsetWidth ?? 0, MENU_MIN_WIDTH),
        menuHeight: Math.max(el?.scrollHeight ?? 0, 80),
        viewport: layoutViewportSize(),
        minWidth: MENU_MIN_WIDTH,
        maxHeight: MENU_MAX_HEIGHT,
        align: "start",
      });
      setPos((prev) => {
        if (
          prev &&
          prev.top === placed.top &&
          prev.left === placed.left &&
          prev.maxHeight === placed.maxHeight
        ) {
          return prev;
        }
        return { top: placed.top, left: placed.left, maxHeight: placed.maxHeight };
      });
    };
    measure();
    const raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [x, y]);

  return createPortal(
    <div
      ref={menuRef}
      className="task-context-menu task-context-menu-portal file-context-menu"
      role="menu"
      style={
        pos
          ? { top: pos.top, left: pos.left, maxHeight: pos.maxHeight }
          : { visibility: "hidden", top: 0, left: 0 }
      }
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
