import { useEffect, useRef, type RefObject } from "react";

function nodeInRoot(root: HTMLElement, event: Event): boolean {
  const path = event.composedPath();
  if (path.includes(root)) return true;
  const target = event.target;
  if (target instanceof Node) return root.contains(target);
  return false;
}

/**
 * 点击锚点外区域或按 Esc 时关闭弹出层。
 */
export function useDismissOnClickOutside(
  open: boolean,
  onClose: () => void,
  anchorRef: RefObject<HTMLElement | null>,
  extraRefs?: RefObject<HTMLElement | null>[],
): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const extraRefsRef = useRef(extraRefs);
  extraRefsRef.current = extraRefs;

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent): void => {
      const roots: HTMLElement[] = [];
      const primary = anchorRef.current;
      if (primary) roots.push(primary);
      for (const ref of extraRefsRef.current ?? []) {
        const el = ref.current;
        if (el) roots.push(el);
      }

      if (roots.length === 0) {
        onCloseRef.current();
        return;
      }

      const inside = roots.some((root) => nodeInRoot(root, event));
      if (!inside) onCloseRef.current();
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onCloseRef.current();
    };

    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, anchorRef]);
}
