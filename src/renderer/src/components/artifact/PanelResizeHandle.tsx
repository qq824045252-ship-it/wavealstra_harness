import { useRef, useState } from "react";
import { useAppStore } from "@/store/appStore";

/** 主内容与右侧栏之间的拖拽缩放把手（悬停/拖拽时仅变色） */
export default function PanelResizeHandle(): React.JSX.Element {
  const panelWidth = useAppStore((s) => s.panelWidth);
  const setPanelWidth = useAppStore((s) => s.setPanelWidth);
  const dragging = useRef(false);
  const [active, setActive] = useState(false);

  const onMouseDown = (e: React.MouseEvent): void => {
    e.preventDefault();
    dragging.current = true;
    setActive(true);
    const startX = e.clientX;
    const startW = panelWidth;

    const onMove = (ev: MouseEvent): void => {
      if (!dragging.current) return;
      const delta = startX - ev.clientX;
      setPanelWidth(startW + delta);
    };

    const onUp = (): void => {
      dragging.current = false;
      setActive(false);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.body.classList.remove("panel-resizing");
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.body.classList.add("panel-resizing");
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  return (
    <div
      className={`panel-resize-handle ${active ? "dragging" : ""}`}
      onMouseDown={onMouseDown}
      role="separator"
      aria-orientation="vertical"
      aria-label="调整侧栏宽度"
    />
  );
}
