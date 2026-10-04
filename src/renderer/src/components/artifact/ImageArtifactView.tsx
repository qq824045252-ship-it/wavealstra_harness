import { useCallback, useEffect, useRef, useState } from "react";
import {
  clampPan,
  clampZoom,
  computeFitScale,
  degradationPolicy,
  fitWidthScale,
  formatBytes,
  imageViewerStats,
  metadataFromDataUri,
  mimeLabel,
  zoomAround,
} from "@/lib/imageView";
import { IconExpand, IconMaximize, IconMinimize, IconRotate, IconZoomIn, IconZoomOut } from "@/components/common/icons";

interface Props {
  content: string;
  name?: string;
}

type FitMode = "fit-window" | "fit-width" | "manual";

const ZOOM_STEP = 1.25;

/**
 * Wave 5B — Image Artifact 视图（§87）
 *
 * 交互模型（冻结）：首次打开 fit-to-window；双击 100%/fit 切换；Ctrl+滚轮围绕
 * 光标缩放；拖拽 pan（钳制）；Reset → fit-to-window；fit-width 按钮。
 * 透明背景棋盘格（png/webp）；超大图（≥100MP）缩放上限 3x 降级；
 * 原生 <img>（V1 不引入 canvas/tile renderer）；所有监听器随卸载清理
 * （imageViewerStats 供 E2E 泄漏断言）。
 */
export default function ImageArtifactView({ content, name }: Props): React.JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [fitMode, setFitMode] = useState<FitMode>("fit-window");
  const dragRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);

  const meta = metadataFromDataUri(content);
  const degrade = degradationPolicy(natural.w * natural.h);

  // 生命周期统计（E2E 泄漏断言）
  useEffect(() => {
    imageViewerStats.active += 1;
    return () => {
      imageViewerStats.active -= 1;
    };
  }, []);

  // stage 尺寸观测（ResizeObserver，卸载释放）
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    imageViewerStats.observers += 1;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setStageSize({ w: rect.width, h: rect.height });
    });
    observer.observe(stage);
    const rect = stage.getBoundingClientRect();
    setStageSize({ w: rect.width, h: rect.height });
    return () => {
      observer.disconnect();
      imageViewerStats.observers -= 1;
    };
  }, []);

  // 图片解码：失败时进入 error 态（此前无 onerror，无限停留在“解码中…”）
  useEffect(() => {
    setLoaded(false);
    setLoadError(null);
    setNatural({ w: 0, h: 0 });
    if (!content || !content.trim()) {
      setLoadError("图片内容为空（可能尚未加载完成）");
      return;
    }
    const img = new Image();
    img.onload = () => {
      if (img.naturalWidth <= 0 || img.naturalHeight <= 0) {
        setLoadError("图片解码失败：无法识别尺寸（文件可能已损坏）");
        return;
      }
      setNatural({ w: img.naturalWidth, h: img.naturalHeight });
      setLoaded(true);
    };
    img.onerror = () => {
      setLoadError("图片解码失败：文件可能已损坏或格式不受支持");
    };
    img.src = content;
    return () => {
      img.onload = null;
      img.onerror = null;
      img.src = "";
    };
  }, [content, retryKey]);

  // 内容/尺寸变化 → fit-window（首次打开与切换 artifact 的统一入口）
  useEffect(() => {
    if (!loaded || stageSize.w <= 0 || stageSize.h <= 0) return;
    const fit = computeFitScale(natural.w, natural.h, stageSize.w, stageSize.h);
    setScale(fit.scale);
    const centered = clampPan(
      (stageSize.w - fit.width) / 2,
      (stageSize.h - fit.height) / 2,
      fit.width,
      fit.height,
      stageSize.w,
      stageSize.h,
    );
    setPan({ x: centered.panX, y: centered.panY });
    setFitMode("fit-window");
  }, [loaded, natural.w, natural.h, stageSize.w, stageSize.h]);

  const dispW = natural.w * scale;
  const dispH = natural.h * scale;

  const applyPan = useCallback(
    (nextPan: { x: number; y: number }): void => {
      const clamped = clampPan(nextPan.x, nextPan.y, dispW, dispH, stageSize.w, stageSize.h);
      setPan({ x: clamped.panX, y: clamped.panY });
    },
    [dispW, dispH, stageSize.w, stageSize.h],
  );

  const zoomTo = useCallback(
    (nextScale: number, anchorX: number, anchorY: number): void => {
      const clamped = clampZoom(nextScale, degrade.maxZoom);
      const nextPan = zoomAround(scale, pan.x, pan.y, clamped, anchorX, anchorY);
      setScale(clamped);
      setFitMode("manual");
      applyPan({ x: nextPan.panX, y: nextPan.panY });
    },
    [scale, pan, degrade.maxZoom, applyPan],
  );

  const zoomBy = useCallback(
    (factor: number): void => {
      zoomTo(scale * factor, stageSize.w / 2, stageSize.h / 2);
    },
    [scale, zoomTo, stageSize.w, stageSize.h],
  );

  const setMode = useCallback(
    (mode: "fit-window" | "fit-width" | "100%"): void => {
      if (!loaded || stageSize.w <= 0) return;
      if (mode === "100%") {
        const nextPan = zoomAround(scale, pan.x, pan.y, 1, stageSize.w / 2, stageSize.h / 2);
        setScale(1);
        setFitMode("manual");
        applyPan({ x: nextPan.panX, y: nextPan.panY });
        return;
      }
      const fit = mode === "fit-width" ? fitWidthScale(natural.w, natural.h, stageSize.w) : computeFitScale(natural.w, natural.h, stageSize.w, stageSize.h);
      setScale(fit.scale);
      // 水平居中；垂直：fit-width 且溢出时贴顶，否则由 clampPan 自动居中
      const centered = clampPan((stageSize.w - fit.width) / 2, 0, fit.width, fit.height, stageSize.w, stageSize.h);
      setPan({ x: centered.panX, y: centered.panY });
      setFitMode(mode);
    },
    [loaded, natural.w, natural.h, scale, pan, stageSize.w, stageSize.h, applyPan],
  );

  const reset = useCallback((): void => {
    setMode("fit-window");
  }, [setMode]);

  // ---- 交互事件（全部随卸载清理） ----

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    imageViewerStats.stageListeners += 1;

    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const rect = stage.getBoundingClientRect();
      const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      zoomTo(scale * factor, e.clientX - rect.left, e.clientY - rect.top);
    };

    const onMouseDown = (e: MouseEvent): void => {
      if (e.button !== 0) return;
      dragRef.current = { startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y };
      stage.classList.add("image-viewer-stage--dragging");
    };

    const onMouseMove = (e: MouseEvent): void => {
      const drag = dragRef.current;
      if (!drag) return;
      applyPan({ x: drag.panX + (e.clientX - drag.startX), y: drag.panY + (e.clientY - drag.startY) });
    };

    const onMouseUp = (): void => {
      if (!dragRef.current) return;
      dragRef.current = null;
      stage.classList.remove("image-viewer-stage--dragging");
    };

    const onDoubleClick = (): void => {
      if (fitMode === "manual" && Math.abs(scale - 1) < 0.001) {
        setMode("fit-window");
      } else {
        setMode("100%");
      }
    };

    stage.addEventListener("wheel", onWheel, { passive: false });
    stage.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    stage.addEventListener("dblclick", onDoubleClick);
    return () => {
      stage.removeEventListener("wheel", onWheel);
      stage.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      stage.removeEventListener("dblclick", onDoubleClick);
      imageViewerStats.stageListeners -= 1;
    };
  }, [scale, pan, zoomTo, applyPan, fitMode, setMode]);

  const scalePercent = Math.round(scale * 100);

  return (
    <div className="image-viewer" data-testid="image-viewer">
      <div className="image-viewer-toolbar">
        <span className="image-viewer-title" title={name}>
          {name ?? "图片"}
        </span>
        <span className="image-viewer-meta">
          {loadError
            ? `解析失败 · ${mimeLabel(meta.mime)}`
            : loaded
              ? `${natural.w} × ${natural.h}px · ${mimeLabel(meta.mime)} · ${formatBytes(meta.sizeBytes)}`
              : "解码中…"}
        </span>
        <div className="image-viewer-actions">
          <button type="button" className="image-viewer-btn" data-action="fit-window" onClick={() => setMode("fit-window")} title="fit-to-window">
            <IconExpand size={13} /> fit
          </button>
          <button type="button" className="image-viewer-btn" data-action="fit-width" onClick={() => setMode("fit-width")} title="fit-width">
            <IconMaximize size={13} /> 宽度
          </button>
          <button type="button" className="image-viewer-btn" data-action="zoom-100" onClick={() => setMode("100%")} title="100%（1:1 像素）">
            <IconMinimize size={13} /> 100%
          </button>
          <button type="button" className="image-viewer-btn" data-action="zoom-out" onClick={() => zoomBy(1 / ZOOM_STEP)} title="缩小">
            <IconZoomOut size={13} />
          </button>
          <button type="button" className="image-viewer-btn" data-action="zoom-in" onClick={() => zoomBy(ZOOM_STEP)} title="放大">
            <IconZoomIn size={13} />
          </button>
          <button type="button" className="image-viewer-btn" data-action="reset" onClick={reset} title="Reset → fit-to-window">
            <IconRotate size={13} /> 重置
          </button>
        </div>
        <span className="image-viewer-scale" data-testid="image-scale">
          {loaded ? `${scalePercent}%` : ""}
        </span>
      </div>
      {degrade.largeImage && loaded && (
        <div className="image-viewer-degrade" title={degrade.hint ?? undefined}>
          ⚠ 超大图（{Math.round((natural.w * natural.h) / 1_000_000)}MP）：缩放上限 300%
        </div>
      )}
      <div
        ref={stageRef}
        className="image-viewer-stage"
        style={{ cursor: dragRef.current ? "grabbing" : "grab" }}
        data-testid="image-stage"
      >
        {loadError ? (
          <div className="image-viewer-loading" data-testid="image-error">
            <div>⚠️ {loadError}</div>
            <div className="image-viewer-meta">{name ?? "图片"} · {mimeLabel(meta.mime)}</div>
            <button
              type="button"
              className="image-viewer-btn"
              data-action="retry"
              onClick={() => setRetryKey((k) => k + 1)}
            >
              重试
            </button>
          </div>
        ) : !loaded ? (
          <div className="image-viewer-loading">正在解码图片…</div>
        ) : (
          <img
            key={`${content.length}-${content.slice(22, 86)}-${retryKey}`}
            src={content}
            alt={name ?? "image artifact"}
            draggable={false}
            className={`image-viewer-img${meta.mayHaveAlpha ? " image-viewer-img--alpha" : ""}`}
            style={{
              width: dispW,
              height: dispH,
              transform: `translate(${pan.x}px, ${pan.y}px)`,
            }}
            onError={() => setLoadError("图片渲染失败：文件可能已损坏或格式不受支持")}
          />
        )}
      </div>
      <div className="image-viewer-hint">双击 100%/fit 切换 · Ctrl+滚轮缩放 · 拖拽平移 · 重置回 fit</div>
    </div>
  );
}
