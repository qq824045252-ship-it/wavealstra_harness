import { useEffect, useRef, useState } from "react";
import { useAppStore } from "@/store/appStore";

/** 主内容与右侧栏之间的拖拽缩放把手（悬停/拖拽时仅变色） */
export default function PanelResizeHandle(): React.JSX.Element {
  const panelWidth = useAppStore((s) => s.panelWidth);
  const setPanelWidth = useAppStore((s) => s.setPanelWidth);
  const finishDrag = useRef<((updateActive?: boolean) => void) | null>(null);
  const [active, setActive] = useState(false);

  useEffect(() => () => finishDrag.current?.(false), []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || !e.isPrimary) return;
    e.preventDefault();
    finishDrag.current?.();
    setActive(true);
    const handle = e.currentTarget;
    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startW = panelWidth;
    const body = document.body;
    const previousCursor = body.style.cursor;
    const previousSelection = body.style.userSelect;
    const wasResizing = body.classList.contains("panel-resizing");

    const onMove = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return;
      const delta = startX - ev.clientX;
      setPanelWidth(startW + delta);
    };

    const finish = (updateActive = true): void => {
      if (finishDrag.current !== finish) return;
      finishDrag.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      window.removeEventListener("blur", onBlur);
      handle.removeEventListener("lostpointercapture", onEnd);
      body.style.cursor = previousCursor;
      body.style.userSelect = previousSelection;
      if (!wasResizing) body.classList.remove("panel-resizing");
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      if (updateActive) setActive(false);
    };
    const onEnd = (ev: PointerEvent): void => {
      if (ev.pointerId === pointerId) finish();
    };
    const onBlur = (): void => finish();

    finishDrag.current = finish;
    body.style.cursor = "col-resize";
    body.style.userSelect = "none";
    body.classList.add("panel-resizing");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    window.addEventListener("blur", onBlur);
    handle.addEventListener("lostpointercapture", onEnd);
    handle.setPointerCapture(pointerId);
  };

  return (
    <div
      className={`panel-resize-handle ${active ? "dragging" : ""}`}
      onPointerDown={onPointerDown}
      role="separator"
      aria-orientation="vertical"
      aria-label="调整侧栏宽度"
    />
  );
}
