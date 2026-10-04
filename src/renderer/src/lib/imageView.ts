/**
 * Wave 5B — Image Artifact 视图纯逻辑（§87）
 *
 * 交互模型（冻结）：
 *   首次打开 → fit-to-window；双击 → 100% / fit 切换；Ctrl+滚轮 → zoom（围绕光标）；
 *   拖拽 → pan（边界钳制）；Reset → fit-to-window。
 *
 * 无 DOM 依赖，可在 node 中直接单测。渲染层用原生 <img>（V1 不引入
 * canvas/tile renderer，除非基准测试证明需要）。
 */

// ---------- 缩放 / 平移数学 ----------

export interface FitResult {
  scale: number;
  width: number;
  height: number;
}

/** fit-to-window（contain）：等比缩放到视口内 */
export function computeFitScale(
  naturalW: number,
  naturalH: number,
  viewportW: number,
  viewportH: number,
): FitResult {
  if (naturalW <= 0 || naturalH <= 0 || viewportW <= 0 || viewportH <= 0) {
    return { scale: 1, width: naturalW, height: naturalH };
  }
  const scale = Math.min(viewportW / naturalW, viewportH / naturalH);
  return { scale, width: naturalW * scale, height: naturalH * scale };
}

/** fit-width：宽度适配视口（高度可溢出，靠 pan 查看） */
export function fitWidthScale(
  naturalW: number,
  naturalH: number,
  viewportW: number,
): FitResult {
  if (naturalW <= 0 || viewportW <= 0) {
    return { scale: 1, width: naturalW, height: naturalH };
  }
  const scale = viewportW / naturalW;
  return { scale, width: naturalW * scale, height: naturalH * scale };
}

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 16;
/** 超大图（≥100MP）缩放上限（降级策略） */
export const MAX_ZOOM_LARGE_IMAGE = 3;
export const LARGE_IMAGE_PIXELS = 100_000_000;

export interface ImageDegradation {
  largeImage: boolean;
  maxZoom: number;
  hint: string | null;
}

/** 超大图降级：像素数 ≥100MP → 缩放上限 3x + 提示 */
export function degradationPolicy(pixels: number): ImageDegradation {
  const largeImage = pixels >= LARGE_IMAGE_PIXELS;
  return {
    largeImage,
    maxZoom: largeImage ? MAX_ZOOM_LARGE_IMAGE : MAX_ZOOM,
    hint: largeImage
      ? "超大图：缩放上限 300%，建议 100% / fit 查看"
      : null,
  };
}

export function clampZoom(scale: number, maxZoom: number): number {
  return Math.min(Math.max(scale, MIN_ZOOM), maxZoom);
}

/**
 * 围绕光标/中心点缩放：保持图片上的一点 (px, py) 在视口位置不变。
 * 输入当前 scale/pan + 目标 scale + 锚点视口坐标 → 输出新 pan。
 */
export function zoomAround(
  scale: number,
  panX: number,
  panY: number,
  targetScale: number,
  anchorX: number,
  anchorY: number,
): { panX: number; panY: number } {
  const px = (anchorX - panX) / scale;
  const py = (anchorY - panY) / scale;
  return { panX: anchorX - px * targetScale, panY: anchorY - py * targetScale };
}

/** 缩放并钳制 pan（pan 必须保持图片覆盖/贴边视口） */
export function clampPan(
  panX: number,
  panY: number,
  dispW: number,
  dispH: number,
  viewportW: number,
  viewportH: number,
): { panX: number; panY: number } {
  const clampAxis = (pan: number, disp: number, viewport: number): number => {
    if (disp <= viewport) return (viewport - disp) / 2; // 小于视口 → 居中
    return Math.min(0, Math.max(viewport - disp, pan)); // 大于视口 → 贴边钳制
  };
  return {
    panX: clampAxis(panX, dispW, viewportW),
    panY: clampAxis(panY, dispH, viewportH),
  };
}

// ---------- 元数据 / 策略 ----------

export interface ImageMetadata {
  mime: string | null;
  /** 解码后字节数（base64 长度换算） */
  sizeBytes: number | null;
  /** 可能带 alpha 通道的格式（透明棋盘格依据） */
  mayHaveAlpha: boolean;
}

/** 从 data URI 提取元数据（纯函数）
 *
 * 兼容现实 data URI 形态：首尾空白、DATA: 大小写、charset 等附加参数
 * （如 image/svg+xml;charset=utf-8;base64）、非 base64 载荷。
 */
export function metadataFromDataUri(content: string): ImageMetadata {
  const trimmed = content.trim();
  const comma = trimmed.indexOf(",");
  if (comma < 0) return { mime: null, sizeBytes: null, mayHaveAlpha: false };
  const header = trimmed.slice(0, comma);
  const payload = trimmed.slice(comma + 1);
  const headerMatch = /^data:([^;,\s]+)((?:;[^;,]*)*)$/i.exec(header);
  if (!headerMatch) return { mime: null, sizeBytes: null, mayHaveAlpha: false };
  const mime = headerMatch[1].toLowerCase();
  const params = (headerMatch[2] ?? "").toLowerCase();
  const isBase64 = /(?:^|;)base64(?:;|$)/.test(params);
  const sizeBytes = isBase64 && payload
    ? Math.floor((payload.length * 3) / 4) - (payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0)
    : null; // 非 base64 载荷不计字节
  const mayHaveAlpha =
    mime === "image/png" ||
    mime === "image/webp" ||
    mime === "image/svg+xml" ||
    mime === "image/avif" ||
    mime === "image/gif";
  return { mime, sizeBytes, mayHaveAlpha };
}

/** 类型显示名（data URI mime → 短名） */
export function mimeLabel(mime: string | null): string {
  if (!mime) return "未知";
  const normalized = mime.toLowerCase();
  const map: Record<string, string> = {
    "image/png": "PNG",
    "image/jpeg": "JPEG",
    "image/webp": "WebP",
    "image/gif": "GIF",
    "image/svg+xml": "SVG",
    "image/avif": "AVIF",
    "image/bmp": "BMP",
    "image/x-icon": "ICO",
    "image/vnd.microsoft.icon": "ICO",
  };
  if (map[normalized]) return map[normalized];
  // image/ico（非标准但常见）→ ICO；其余取 subtype 大写
  if (normalized === "image/ico") return "ICO";
  return normalized.replace("image/", "").toUpperCase();
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ---------- 生命周期统计（E2E 泄漏断言用，生产模块自带诊断） ----------

export const imageViewerStats = {
  /** 当前挂载中的 ImageArtifactView 实例数 */
  active: 0,
  /** 累计创建的 stage 级监听器数（挂载=1，卸载=-1） */
  stageListeners: 0,
  /** 累计创建的 ResizeObserver 数（挂载=1，卸载=-1） */
  observers: 0,
};

export function resetImageViewerStats(): void {
  imageViewerStats.active = 0;
  imageViewerStats.stageListeners = 0;
  imageViewerStats.observers = 0;
}
