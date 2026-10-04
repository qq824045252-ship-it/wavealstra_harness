import { observeResizeOnFrame } from "@/lib/observeResizeOnFrame";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useDismissOnClickOutside } from "@/hooks/useDismissOnClickOutside";
import { useAppStore } from "@/store/appStore";
import ChatMarkdown from "./ChatMarkdown";
import {
  IconChevronDown,
  IconCopy,
  IconDownload,
  IconFile,
  IconMore,
  IconCode,
} from "@/components/common/icons";

export type DetailContentKind = "markdown" | "html" | "svg";

interface Props {
  title?: string;
  content: string;
  contentKind?: DetailContentKind;
  /** 所属消息 id：用于自动登记产物 */
  messageId?: string;
  /** 自动登记产物时的文件名提示 */
  artifactName?: string;
}

function detectKind(content: string, explicit?: DetailContentKind): DetailContentKind {
  if (explicit && explicit !== "markdown") return explicit;
  const trimmed = content.trim();
  if (/^<svg[\s>]/i.test(trimmed) || /<\/svg>\s*$/i.test(trimmed)) return "svg";
  if (
    /^<!DOCTYPE\s+html/i.test(trimmed) ||
    /^<html[\s>]/i.test(trimmed) ||
    /<canvas[\s>]/i.test(trimmed)
  ) {
    return "html";
  }
  return explicit ?? "markdown";
}

const FRAME_PAD = 24; // 上下左右合计 padding 近似
const HTML_PREVIEW_HEIGHT = 480; // HTML 聊天预览固定高度，避免 iframe 自适应反复改变消息区 scrollHeight

/** 从源码解析 SVG 固有宽高（不依赖 iframe 渲染结果） */
function parseSvgIntrinsicSize(source: string): { w: number; h: number } | null {
  const vb = /viewBox\s*=\s*["']?\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)/i.exec(
    source,
  );
  if (vb) {
    const w = Math.abs(Number(vb[3]));
    const h = Math.abs(Number(vb[4]));
    if (w > 0 && h > 0) return { w, h };
  }
  const openTag = /<svg\b([^>]*)>/i.exec(source)?.[1] ?? "";
  const wMatch = /\bwidth\s*=\s*["']?([\d.]+)/i.exec(openTag);
  const hMatch = /\bheight\s*=\s*["']?([\d.]+)/i.exec(openTag);
  const w = wMatch ? Number(wMatch[1]) : NaN;
  const h = hMatch ? Number(hMatch[1]) : NaN;
  if (w > 0 && h > 0) return { w, h };
  return null;
}

/** 按容器宽度把固有尺寸换算为 iframe 高度（SVG 用 width:100% 铺满） */
function heightFromIntrinsic(
  intrinsic: { w: number; h: number },
  containerWidth: number,
  pad = FRAME_PAD,
): number {
  const contentW = Math.max(40, containerWidth - pad);
  // 与 CSS width:100% 一致：按容器宽度等比，完整显示不裁切
  return Math.ceil((intrinsic.h / intrinsic.w) * contentW + pad);
}

function wrapSvgDocument(svg: string): string {
  const trimmed = svg.trim();
  if (/^<!DOCTYPE|^<html[\s>]/i.test(trimmed)) return trimmed;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  html, body {
    margin: 0;
    padding: 12px;
    background: transparent;
    overflow: visible;
    height: auto;
  }
  svg {
    display: block;
    width: 100%;
    max-width: 100%;
    height: auto;
    margin: 0 auto;
  }
</style>
</head>
<body>${trimmed}</body>
</html>`;
}

/**
 * 注入到预览文档：
 * 1) roundRect 兼容
 * 2) 声明式 canvas：<canvas><data>{"dpr","bg","el":[…]}</data></canvas>
 *    支持扁平 el、嵌套 el 分组、以及 bar+data 系列柱图（纯 2D API，无 eval）
 */
const PREVIEW_BOOT_SCRIPT = `
<script>
(function(){
  if (typeof CanvasRenderingContext2D !== 'undefined' && !CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function(x,y,w,h,r){
      var rad = r;
      if (typeof r === 'number') rad = {tl:r,tr:r,br:r,bl:r};
      else rad = Object.assign({tl:0,tr:0,br:0,bl:0}, r||{});
      this.beginPath();
      this.moveTo(x+rad.tl, y);
      this.lineTo(x+w-rad.tr, y);
      this.quadraticCurveTo(x+w, y, x+w, y+rad.tr);
      this.lineTo(x+w, y+h-rad.br);
      this.quadraticCurveTo(x+w, y+h, x+w-rad.br, y+h);
      this.lineTo(x+rad.bl, y+h);
      this.quadraticCurveTo(x, y+h, x, y+h-rad.bl);
      this.lineTo(x, y+rad.tl);
      this.quadraticCurveTo(x, y, x+rad.tl, y);
      this.closePath();
      return this;
    };
  }

  function num(v, d) {
    var n = Number(v);
    return isFinite(n) ? n : d;
  }

  function flattenEls(input, out) {
    if (!out) out = [];
    if (input == null) return out;
    if (Array.isArray(input)) {
      for (var i = 0; i < input.length; i++) flattenEls(input[i], out);
      return out;
    }
    if (typeof input === 'object') out.push(input);
    return out;
  }

  function readData(canvas) {
    var node = canvas.querySelector('data');
    var raw = node && (node.textContent || '').trim();
    if (!raw) raw = (canvas.getAttribute('data-canvas') || '').trim();
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) {
      var a = raw.indexOf('{'), b = raw.lastIndexOf('}');
      if (a >= 0 && b > a) {
        try { return JSON.parse(raw.slice(a, b + 1)); } catch (e2) { return null; }
      }
      return null;
    }
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    var rr = Math.max(0, num(r, 0));
    if (rr <= 0) { ctx.rect(x, y, w, h); return; }
    if (typeof ctx.roundRect === 'function') { ctx.roundRect(x, y, w, h, rr); return; }
    var rad = Math.min(rr, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }

  function fillRound(ctx, x, y, w, h, r, color) {
    if (!(w > 0) || !(h > 0)) return;
    ctx.beginPath();
    roundRectPath(ctx, x, y, w, h, r);
    ctx.fillStyle = color;
    ctx.fill();
  }

  /** {"t":"bar","x","y","w","h","data":[{label,value,color},…]} */
  function drawBarSeries(ctx, el) {
    var series = el.data || el.series || el.items;
    if (!Array.isArray(series) || !series.length) return false;
    var bx = num(el.x, 0), by = num(el.y, 0);
    var bw = num(el.w != null ? el.w : el.width, 0);
    var bh = num(el.h != null ? el.h : el.height, 0);
    if (!(bw > 0) || !(bh > 0)) return true;

    var maxV = 0;
    for (var i = 0; i < series.length; i++) {
      var it = series[i];
      var vv = Array.isArray(it) ? num(it[1], 0) : num(it.value != null ? it.value : it.v, 0);
      if (vv > maxV) maxV = vv;
    }
    if (maxV <= 0) maxV = 1;

    var labelSpace = 22, valueSpace = 14;
    var plotH = Math.max(8, bh - labelSpace);
    var n = series.length;
    var slotW = bw / n;
    var barW = Math.min(28, Math.max(8, slotW * 0.55));
    var baseY = by + plotH;
    var radius = el.r != null ? el.r : 3;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (var j = 0; j < n; j++) {
      var item = series[j];
      var label, val, color;
      if (Array.isArray(item)) {
        label = String(item[0] != null ? item[0] : '');
        val = num(item[1], 0);
        color = item[2] || '#38bdf8';
      } else {
        label = String(item.label != null ? item.label : (item.name || ''));
        val = num(item.value != null ? item.value : item.v, 0);
        color = item.color || item.fill || '#38bdf8';
      }
      var h = (val / maxV) * Math.max(4, plotH - valueSpace);
      var x = bx + j * slotW + (slotW - barW) / 2;
      var y = baseY - h;
      fillRound(ctx, x, y, barW, h, radius, color);

      ctx.fillStyle = '#e2e8f0';
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillText(String(val), x + barW / 2, y - 10);

      ctx.fillStyle = '#94a3b8';
      ctx.font = (label.length > 9 ? 9 : 10) + 'px system-ui, sans-serif';
      ctx.fillText(label, x + barW / 2, baseY + 12);
    }
    return true;
  }

  function drawEl(ctx, el) {
    if (!el || typeof el !== 'object' || Array.isArray(el)) return;
    var t = String(el.t || el.type || '').toLowerCase();
    if (!t) return;

    if ((t === 'bar' || t === 'bars' || t === 'barchart') && (el.data || el.series || el.items)) {
      if (drawBarSeries(ctx, el)) return;
    }

    if (t === 'rect' || t === 'bar' || t === 'box') {
      var x = num(el.x, 0), y = num(el.y, 0);
      var w = num(el.w != null ? el.w : el.width, 0);
      var h = num(el.h != null ? el.h : el.height, 0);
      var r = el.r != null ? el.r : (el.radius != null ? el.radius : 0);
      var color = el.color || el.fill;
      if (color) fillRound(ctx, x, y, w, h, r, color);
      if (el.stroke || el.border) {
        ctx.beginPath();
        roundRectPath(ctx, x, y, w, h, r);
        ctx.strokeStyle = el.stroke || el.border;
        ctx.lineWidth = num(el.sw != null ? el.sw : el.strokeWidth, 1);
        ctx.stroke();
      }
      return;
    }

    if (t === 'text' || t === 'label') {
      var text = el.text != null ? String(el.text) : (el.label != null ? String(el.label) : '');
      if (!text) return;
      var size = num(el.size != null ? el.size : el.fontSize, 14);
      var bold = el.bold || el.weight === 'bold' || el.fontWeight === 'bold';
      ctx.font = (bold ? 'bold ' : '') + size + 'px system-ui, -apple-system, Segoe UI, sans-serif';
      ctx.fillStyle = el.color || el.fill || '#e2e8f0';
      ctx.textAlign = el.align || el.textAlign || 'left';
      ctx.textBaseline = el.baseline || el.textBaseline || 'middle';
      ctx.fillText(text, num(el.x, 0), num(el.y, 0));
      return;
    }

    if (t === 'line') {
      ctx.beginPath();
      ctx.moveTo(num(el.x1 != null ? el.x1 : el.x, 0), num(el.y1 != null ? el.y1 : el.y, 0));
      ctx.lineTo(
        num(el.x2 != null ? el.x2 : num(el.x, 0) + num(el.w, 0), 0),
        num(el.y2 != null ? el.y2 : num(el.y, 0) + num(el.h, 0), 0)
      );
      ctx.strokeStyle = el.color || el.stroke || '#334155';
      // 有 x1/x2 时 w 表示线宽（模型常见写法）
      if (el.x1 != null || el.x2 != null) {
        ctx.lineWidth = num(el.w != null ? el.w : (el.sw != null ? el.sw : 1), 1);
      } else {
        ctx.lineWidth = num(el.sw != null ? el.sw : 1, 1);
      }
      ctx.lineCap = 'round';
      ctx.stroke();
      return;
    }

    if (t === 'circle' || t === 'ellipse') {
      var cx = num(el.cx != null ? el.cx : el.x, 0);
      var cy = num(el.cy != null ? el.cy : el.y, 0);
      var rx = num(el.rx != null ? el.rx : (el.r != null ? el.r : el.radius), 0);
      var ry = num(el.ry != null ? el.ry : rx, rx);
      ctx.beginPath();
      if (rx === ry) ctx.arc(cx, cy, rx, 0, Math.PI * 2);
      else {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(1, ry / (rx || 1));
        ctx.arc(0, 0, rx, 0, Math.PI * 2);
        ctx.restore();
      }
      if (el.color || el.fill) { ctx.fillStyle = el.color || el.fill; ctx.fill(); }
      if (el.stroke) { ctx.strokeStyle = el.stroke; ctx.lineWidth = num(el.sw, 1); ctx.stroke(); }
    }
  }

  function paint(canvas) {
    if (!canvas || canvas.__wbDataPainted) return;
    var data = readData(canvas);
    if (!data) return;

    var logicalW = num(canvas.getAttribute('width'), 0) || num(data.w != null ? data.w : data.width, 760);
    var logicalH = num(canvas.getAttribute('height'), 0) || num(data.h != null ? data.h : data.height, 430);
    if (logicalW > 4000 || logicalH > 4000) {
      logicalW = num(data.w != null ? data.w : data.width, 760);
      logicalH = num(data.h != null ? data.h : data.height, 430);
    }
    var dpr = num(data.dpr, (window.devicePixelRatio || 1));
    if (dpr < 1) dpr = 1;
    if (dpr > 3) dpr = 3;
    var bg = data.bg || data.background || data.backgroundColor;

    canvas.setAttribute('data-logical-w', String(logicalW));
    canvas.setAttribute('data-logical-h', String(logicalH));
    canvas.width = Math.max(1, Math.round(logicalW * dpr));
    canvas.height = Math.max(1, Math.round(logicalH * dpr));
    canvas.style.width = '100%';
    canvas.style.maxWidth = logicalW + 'px';
    canvas.style.height = 'auto';
    canvas.style.aspectRatio = logicalW + ' / ' + logicalH;
    canvas.style.display = 'block';
    canvas.style.margin = '0 auto';
    if (bg) canvas.style.borderRadius = '8px';

    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (bg) {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, logicalW, logicalH);
    } else {
      ctx.clearRect(0, 0, logicalW, logicalH);
    }

    var els = flattenEls(data.el || data.elements || data.items || []);
    for (var i = 0; i < els.length; i++) drawEl(ctx, els[i]);
    canvas.__wbDataPainted = true;
  }

  function paintAll() {
    var list = document.querySelectorAll('canvas');
    for (var i = 0; i < list.length; i++) paint(list[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', paintAll);
  } else {
    paintAll();
  }
  setTimeout(paintAll, 0);
  setTimeout(paintAll, 50);
  setTimeout(paintAll, 200);
})();
<\/script>`;

/**
 * 将片段或完整 HTML 规范为可预览文档。
 * 注意：父页 CSP 已允许 unsafe-inline，否则 iframe 内联 script 会被拦。
 */
export function ensureHtmlDocument(html: string): string {
  const trimmed = html.trim();
  if (/^<!DOCTYPE|^<html[\s>]/i.test(trimmed)) {
    if (/<\/head>/i.test(trimmed)) {
      return trimmed.replace(/<\/head>/i, `${PREVIEW_BOOT_SCRIPT}</head>`);
    }
    if (/<body[\s>]/i.test(trimmed)) {
      return trimmed.replace(/<body([^>]*)>/i, `<body$1>${PREVIEW_BOOT_SCRIPT}`);
    }
    return PREVIEW_BOOT_SCRIPT + trimmed;
  }
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  html, body {
    margin: 0;
    padding: 12px;
    background: transparent;
    color: inherit;
    font-family: system-ui, sans-serif;
    overflow: auto;
  }
  canvas {
    display: block;
    max-width: 100%;
    height: auto;
    margin: 0 auto;
  }
</style>
${PREVIEW_BOOT_SCRIPT}
</head>
<body>${trimmed}</body>
</html>`;
}

function downloadText(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadDataUrl(filename: string, dataUrl: string): void {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  a.click();
}

async function svgToPngDataUrl(svgText: string): Promise<string> {
  const blob = new Blob([svgText], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("SVG 加载失败"));
      el.src = url;
    });
    const canvas = document.createElement("canvas");
    const width = Math.max(img.naturalWidth || 800, 1);
    const height = Math.max(img.naturalHeight || 400, 1);
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建画布");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0);
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * 测量 iframe 内容高度。
 * 注意：不能在 iframe 仍被压得很矮时用 scrollHeight（会量到裁切后的值）。
 * SVG 优先用源码 viewBox 比例 + 容器宽度计算。
 */
function measureFrameContentHeight(
  frame: HTMLIFrameElement,
  source: string,
  kind: DetailContentKind,
): number {
  const frameW = frame.clientWidth || frame.parentElement?.clientWidth || 600;

  // 1) SVG：源码解析（最稳）
  if (kind === "svg" || /<svg[\s>]/i.test(source)) {
    const intrinsic = parseSvgIntrinsicSize(source);
    if (intrinsic) return heightFromIntrinsic(intrinsic, frameW);
  }

  const doc = frame.contentDocument;
  if (!doc?.body) return 0;
  const body = doc.body;
  const html = doc.documentElement;

  // 2) 已渲染的 SVG DOM
  const svg = body.querySelector("svg");
  if (svg) {
    const rect = svg.getBoundingClientRect();
    if (rect.height > 8) return Math.ceil(rect.height + FRAME_PAD);

    const vb = svg.viewBox?.baseVal;
    if (vb && vb.width > 0 && vb.height > 0) {
      return heightFromIntrinsic({ w: vb.width, h: vb.height }, frameW);
    }
    try {
      const bbox = svg.getBBox();
      if (bbox.height > 0) {
        return heightFromIntrinsic(
          { w: Math.max(bbox.width, 1), h: bbox.height + Math.max(0, bbox.y) },
          frameW,
        );
      }
    } catch {
      /* ignore */
    }
  }

  // 3) Canvas
  const canvas = body.querySelector("canvas");
  if (canvas) {
    const attrW = Number(canvas.getAttribute("width")) || 0;
    const attrH = Number(canvas.getAttribute("height")) || 0;
    if (attrW > 0 && attrH > 0 && attrW < 4000 && attrH < 4000) {
      return heightFromIntrinsic({ w: attrW, h: attrH }, frameW);
    }
    const cssH = canvas.clientHeight || canvas.height;
    const cssW = canvas.clientWidth || canvas.width;
    if (cssH > 0 && cssW > 0) {
      const scale = Math.min(1, (frameW - FRAME_PAD) / cssW);
      return Math.ceil(cssH * scale + FRAME_PAD);
    }
    if (cssH > 0) return Math.ceil(cssH + FRAME_PAD);
  }

  // 4) 通用兜底：只读 DOM 高度，绝不修改 live iframe 高度。
  // HTML 预览不会进入本函数；它在聊天中使用固定高度并在 iframe 内滚动。
  const scrollH = Math.max(body.scrollHeight, html?.scrollHeight ?? 0, body.offsetHeight);
  return Math.ceil(Math.max(scrollH + 8, 80));
}

export default function DetailCard({
  title = "展示详情",
  content,
  contentKind,
  messageId,
  artifactName,
}: Props): React.JSX.Element {
  const kind = useMemo(() => detectKind(content, contentKind), [content, contentKind]);
  const ensureCanvasArtifact = useAppStore((s) => s.ensureCanvasArtifact);
  const [open, setOpen] = useState(true);
  const [viewMode, setViewMode] = useState<"preview" | "code">("preview");
  const [menuOpen, setMenuOpen] = useState(false);
  const [frameHeight, setFrameHeight] = useState<number | null>(null);
  const menuAnchorRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const registeredKeyRef = useRef<string | null>(null);

  useDismissOnClickOutside(menuOpen, () => setMenuOpen(false), menuAnchorRef);

  const srcDoc = useMemo(() => {
    if (kind === "svg") return wrapSvgDocument(content);
    if (kind === "html") return ensureHtmlDocument(content);
    return "";
  }, [content, kind]);

  const fileExt = kind === "svg" ? "svg" : kind === "html" ? "html" : "md";
  const mime =
    kind === "svg"
      ? "image/svg+xml;charset=utf-8"
      : kind === "html"
        ? "text/html;charset=utf-8"
        : "text/markdown;charset=utf-8";

  /** HTML/SVG/Canvas：iframe 预览；Markdown：GFM 文档预览（canvas 改造后曾误退回纯 <pre>） */
  const isIframePreview = kind === "html" || kind === "svg";
  const isMarkdownPreview = kind === "markdown";
  const isRenderable = isIframePreview || isMarkdownPreview;

  // 有 viewBox / canvas 宽高时先估算高度，避免首帧裁切
  const estimatedHeight = useMemo(() => {
    if (!isIframePreview) return null;
    if (kind === "html") return HTML_PREVIEW_HEIGHT;
    const intrinsic = parseSvgIntrinsicSize(content);
    if (intrinsic) return heightFromIntrinsic(intrinsic, 560);
    return null;
  }, [content, isIframePreview, kind]);

  const resizeFrame = useCallback((): void => {
    if (kind !== "svg") return;
    const frame = frameRef.current;
    if (!frame) return;
    const h = measureFrameContentHeight(frame, content, kind);
    if (h > 0) {
      setFrameHeight((prev) => (prev !== null && Math.abs(prev - h) < 2 ? prev : h));
    }
  }, [content, kind]);

  const onFrameLoad = useCallback((): void => {
    if (kind === "svg") resizeFrame();
  }, [kind, resizeFrame]);

  useLayoutEffect(() => {
    if (kind !== "svg" || viewMode !== "preview") return;
    if (estimatedHeight != null) setFrameHeight(estimatedHeight);
    const id = window.requestAnimationFrame(() => {
      resizeFrame();
      requestAnimationFrame(resizeFrame);
    });
    return () => window.cancelAnimationFrame(id);
  }, [srcDoc, isIframePreview, viewMode, estimatedHeight, resizeFrame]);

  useEffect(() => {
    if (kind !== "svg" || viewMode !== "preview") return;
    const frame = frameRef.current;
    if (!frame || typeof ResizeObserver === "undefined") return;
    // Updating the iframe height synchronously inside ResizeObserver creates a
    // layout feedback loop. Measure/update once on the next frame instead.
    return observeResizeOnFrame(
      frame.parentElement ? [frame, frame.parentElement] : [frame],
      resizeFrame,
    );
  }, [srcDoc, isIframePreview, viewMode, resizeFrame]);

  useEffect(() => {
    if (kind !== "svg" || viewMode !== "preview") return;
    const frame = frameRef.current;
    const doc = frame?.contentDocument;
    // With intrinsic dimensions the height depends only on the outer width.
    // Watching animated iframe descendants adds no sizing information and feeds
    // cross-document resize notifications back into React on every animation.
    if (parseSvgIntrinsicSize(content)) return;
    if (!frame || !doc?.body || typeof ResizeObserver === "undefined") return;
    const svg = doc.querySelector("svg");
    return observeResizeOnFrame(svg ? [doc.body, svg] : [doc.body], resizeFrame);
  }, [srcDoc, content, isIframePreview, viewMode, frameHeight, resizeFrame]);

  // 自动登记产物（幂等）：仅 HTML/SVG/Canvas 进产物索引，markdown 不登记为画布
  useEffect(() => {
    if (!isIframePreview || !messageId) return;
    const key = `${messageId}:${kind}:${content.length}:${content.slice(0, 64)}`;
    if (registeredKeyRef.current === key) return;
    registeredKeyRef.current = key;
    ensureCanvasArtifact({
      messageId,
      content,
      kind,
      preferredName: artifactName,
      open: false,
    });
  }, [artifactName, content, ensureCanvasArtifact, isIframePreview, kind, messageId]);

  const copyCode = useCallback((): void => {
    void navigator.clipboard.writeText(content);
    setMenuOpen(false);
  }, [content]);

  const downloadLocal = useCallback((): void => {
    const name =
      artifactName && !artifactName.includes(".")
        ? `${artifactName}.${fileExt}`
        : artifactName || `canvas.${fileExt}`;
    downloadText(name, content, mime);
    setMenuOpen(false);
  }, [artifactName, content, fileExt, mime]);

  const downloadImage = useCallback(async (): Promise<void> => {
    setMenuOpen(false);
    try {
      if (kind === "svg") {
        const dataUrl = await svgToPngDataUrl(content.trim());
        downloadDataUrl("canvas.png", dataUrl);
        return;
      }
      const doc = frameRef.current?.contentDocument;
      if (doc) {
        const canvasEl = doc.querySelector("canvas");
        if (canvasEl) {
          downloadDataUrl("canvas.png", canvasEl.toDataURL("image/png"));
          return;
        }
        const svgEl = doc.querySelector("svg");
        if (svgEl) {
          const dataUrl = await svgToPngDataUrl(new XMLSerializer().serializeToString(svgEl));
          downloadDataUrl("canvas.png", dataUrl);
          return;
        }
      }
      downloadText(`canvas.${fileExt}`, content, mime);
    } catch {
      downloadText(`canvas.${fileExt}`, content, mime);
    }
  }, [content, fileExt, kind, mime]);

  const showCode = useCallback((): void => {
    setViewMode("code");
    setMenuOpen(false);
  }, []);

  const showPreview = useCallback((): void => {
    setViewMode("preview");
    setMenuOpen(false);
  }, []);

  return (
    <div className="msg-detail-card">
      <div className="msg-detail-head">
        <button type="button" className="msg-detail-toggle" onClick={() => setOpen(!open)}>
          <span className={`msg-detail-chevron ${open ? "open" : ""}`}>
            <IconChevronDown size={14} />
          </span>
          {title}
        </button>
        <div className="msg-detail-menu-anchor" ref={menuAnchorRef}>
          <button
            type="button"
            className="icon-btn"
            title="更多"
            onClick={() => setMenuOpen(!menuOpen)}
          >
            <IconMore size={14} />
          </button>
          {menuOpen && (
            <div className="msg-detail-menu" onClick={(e) => e.stopPropagation()}>
              <button type="button" className="msg-detail-menu-item" onClick={downloadLocal}>
                <IconDownload size={14} /> 下载到本地
              </button>
              <button
                type="button"
                className="msg-detail-menu-item"
                onClick={() => void downloadImage()}
              >
                <IconFile size={14} /> 下载为图片
              </button>
              <button type="button" className="msg-detail-menu-item" onClick={copyCode}>
                <IconCopy size={14} /> 复制代码
              </button>
              {isRenderable && viewMode === "preview" ? (
                <button type="button" className="msg-detail-menu-item" onClick={showCode}>
                  <IconCode size={14} /> 查看代码
                </button>
              ) : isRenderable ? (
                <button type="button" className="msg-detail-menu-item" onClick={showPreview}>
                  <IconFile size={14} /> 预览效果
                </button>
              ) : (
                <button type="button" className="msg-detail-menu-item" onClick={copyCode}>
                  <IconCode size={14} /> 查看代码
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      {open && (
        <div
          className={`msg-detail-body ${
            isRenderable && viewMode === "preview"
              ? isMarkdownPreview
                ? "md-preview"
                : "preview"
              : "code"
          }`}
        >
          {isIframePreview && viewMode === "preview" ? (
            <iframe
              ref={frameRef}
              title={title}
              className="msg-detail-frame"
              srcDoc={srcDoc}
              sandbox="allow-scripts allow-same-origin"
              onLoad={kind === "svg" ? onFrameLoad : undefined}
              style={{
                height: kind === "html" ? HTML_PREVIEW_HEIGHT : frameHeight ?? estimatedHeight ?? 200,
                minHeight:
                  kind === "html" ? HTML_PREVIEW_HEIGHT : frameHeight ?? estimatedHeight ?? 200,
              }}
            />
          ) : isMarkdownPreview && viewMode === "preview" ? (
            <div className="msg-detail-md">
              <ChatMarkdown text={content} streaming={false} variant="document" />
            </div>
          ) : (
            <pre className="msg-detail-code">{content}</pre>
          )}
        </div>
      )}
    </div>
  );
}

/** 是否为可预览的 canvas 片段（含可选后续 script） */
export function isCanvasSnippet(code: string): boolean {
  const t = code.trim();
  if (!/<canvas[\s>/]/i.test(t)) return false;
  // 配对闭合 或 自闭合
  return /<\/canvas\s*>/i.test(t) || /<canvas\b[^>]*\/>/i.test(t);
}

/** 判断代码块是否应按 Canvas/HTML/SVG 详情卡渲染 */
export function isRenderableCanvasCode(language: string | undefined, code: string): boolean {
  const lang = (language ?? "").toLowerCase().trim();
  const trimmed = code.trim();
  if (!trimmed) return false;

  // 完整 HTML 文档
  if (/^<!DOCTYPE\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) return true;
  // 独立 SVG
  if (/^<svg[\s>]/i.test(trimmed) && /<\/svg\s*>/i.test(trimmed)) return true;
  // 裸 <canvas>…</canvas> + 可选 <script>（模型最常见的输出形态）
  if (isCanvasSnippet(trimmed)) return true;
  // 带 style+body 的页面片段
  if (/<style[\s>]/i.test(trimmed) && /<body[\s>]/i.test(trimmed)) return true;

  // 显式语言：html/svg/canvas；js 里若含 canvas 标签也按画布预览
  if (["html", "htm", "svg", "xml", "canvas", "xhtml"].includes(lang)) {
    if (lang === "svg" || lang === "canvas") return true;
    if (trimmed.length > 200 && /<\/(div|section|svg|canvas)>/i.test(trimmed)) return true;
  }
  if ((lang === "javascript" || lang === "js") && isCanvasSnippet(trimmed)) return true;

  return false;
}

export function canvasKindFromCode(language: string | undefined, code: string): DetailContentKind {
  const lang = (language ?? "").toLowerCase();
  if (lang === "svg" || /^<svg[\s>]/i.test(code.trim())) return "svg";
  return "html";
}
