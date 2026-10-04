/** 侧栏 / 输入框等 portal 到 body 的 fixed 菜单定位 */

export const FIXED_MENU_PAD = 8;
export const FIXED_MENU_GAP = 4;
export const FIXED_MENU_MIN_HEIGHT = 96;

export type RectLike = {
  top: number;
  bottom: number;
  left: number;
  right: number;
};

export type ViewportBox = {
  width: number;
  height: number;
};

export type FixedMenuPlacement = {
  top: number;
  left: number;
  maxHeight: number;
  openUp: boolean;
};

/**
 * 把菜单放进视口：下方放得下就朝下，否则朝上；maxHeight 永远不超过剩余空间。
 * 坐标与 viewport 必须同一套（CSS zoom 下用 layoutViewportSize + layoutRect，
 * 不要把 getBoundingClientRect 的视觉坐标直接写进 position:fixed）。
 */
export function placeFixedMenu(opts: {
  anchor: RectLike;
  menuWidth: number;
  menuHeight: number;
  viewport: ViewportBox;
  minWidth?: number;
  maxHeight?: number;
  pad?: number;
  gap?: number;
  /** 默认右对齐锚点（侧栏 ⋯）；输入框菜单传 "start" */
  align?: "end" | "start";
}): FixedMenuPlacement {
  const pad = opts.pad ?? FIXED_MENU_PAD;
  const gap = opts.gap ?? FIXED_MENU_GAP;
  const minW = opts.minWidth ?? 0;
  const capH = opts.maxHeight ?? Number.POSITIVE_INFINITY;
  const menuW = Math.max(opts.menuWidth, minW);
  const naturalH = Math.max(opts.menuHeight, 1);
  const vw = Math.max(opts.viewport.width, pad * 2 + 1);
  const vh = Math.max(opts.viewport.height, pad * 2 + 1);

  const spaceBelow = vh - opts.anchor.bottom - gap - pad;
  const spaceAbove = opts.anchor.top - gap - pad;
  const needed = Math.min(naturalH, capH);
  const openUp = spaceBelow < needed && spaceAbove > spaceBelow;

  const available = Math.max(FIXED_MENU_MIN_HEIGHT, openUp ? spaceAbove : spaceBelow);
  let maxHeight = Math.min(capH, available);
  const shownH = Math.min(naturalH, maxHeight);

  let top = openUp ? opts.anchor.top - gap - shownH : opts.anchor.bottom + gap;
  const minTop = pad;
  const maxTop = Math.max(minTop, vh - pad - shownH);
  top = Math.min(Math.max(minTop, top), maxTop);

  // 二次夹紧：无论朝上朝下，底边不得越过视口
  maxHeight = Math.min(maxHeight, Math.max(FIXED_MENU_MIN_HEIGHT, vh - pad - top));

  let left = opts.align === "start" ? opts.anchor.left : opts.anchor.right - menuW;
  const minLeft = pad;
  const maxLeft = Math.max(minLeft, vw - pad - menuW);
  left = Math.min(Math.max(minLeft, left), maxLeft);

  return { top, left, maxHeight, openUp };
}

/** CSS zoom 下 innerWidth/Height 会高估，与 panelWidth.ts 同一套布局尺寸 */
export function layoutViewportSize(): ViewportBox {
  const body = typeof document !== "undefined" ? document.body : null;
  const doc = typeof document !== "undefined" ? document.documentElement : null;
  return {
    width: body?.clientWidth || doc?.clientWidth || window.innerWidth,
    height: body?.clientHeight || doc?.clientHeight || window.innerHeight,
  };
}

/** body.style.zoom；position:fixed 的 top/left 走这套布局坐标 */
export function layoutZoom(): number {
  if (typeof document === "undefined") return 1;
  const z = parseFloat(getComputedStyle(document.body).zoom);
  return Number.isFinite(z) && z > 0 ? z : 1;
}

/** 把 getBoundingClientRect 的视觉坐标换成与 offsetWidth / clientWidth 同一套 */
export function toLayoutRect(rect: RectLike, zoom: number): RectLike {
  const z = zoom > 0 ? zoom : 1;
  if (z === 1) return rect;
  return {
    top: rect.top / z,
    bottom: rect.bottom / z,
    left: rect.left / z,
    right: rect.right / z,
  };
}

export function layoutRect(el: Element): RectLike {
  return toLayoutRect(el.getBoundingClientRect(), layoutZoom());
}

export type FixedSideFlyoutPlacement = {
  top: number;
  left: number;
};

/**
 * 把侧向 flyout 放到 avoid 矩形外侧（优先左），保证不与 avoid 重叠。
 * 左右都放不下时改放到 avoid 上方/下方。坐标必须与 viewport 同一套。
 */
export function placeFixedSideFlyout(opts: {
  row: RectLike;
  avoid: RectLike;
  flyoutWidth: number;
  flyoutHeight: number;
  viewport: ViewportBox;
  pad?: number;
  gap?: number;
  /** 让 flyout 内部某行与 row.top 对齐：flyoutTop = row.top - alignOffset */
  alignOffset?: number;
}): FixedSideFlyoutPlacement {
  const pad = opts.pad ?? FIXED_MENU_PAD;
  const gap = opts.gap ?? 6;
  const alignOffset = opts.alignOffset ?? 0;
  const w = Math.max(opts.flyoutWidth, 1);
  const h = Math.max(opts.flyoutHeight, 1);
  const vw = Math.max(opts.viewport.width, pad * 2 + 1);
  const vh = Math.max(opts.viewport.height, pad * 2 + 1);
  const clampLeft = (left: number): number =>
    Math.min(Math.max(pad, left), Math.max(pad, vw - pad - w));
  const clampTop = (top: number): number =>
    Math.min(Math.max(pad, top), Math.max(pad, vh - pad - h));

  const spaceLeft = opts.avoid.left - pad - gap;
  const spaceRight = vw - opts.avoid.right - pad - gap;
  const spaceAbove = opts.avoid.top - pad - gap;
  const spaceBelow = vh - opts.avoid.bottom - pad - gap;
  const alignedTop = opts.row.top - alignOffset;

  if (spaceLeft >= w) {
    return { top: clampTop(alignedTop), left: opts.avoid.left - gap - w };
  }
  if (spaceRight >= w) {
    return { top: clampTop(alignedTop), left: opts.avoid.right + gap };
  }

  // 左右都不够：放到列表上方或下方，避免盖住模型行
  const placeAbove = spaceAbove >= h || spaceAbove >= spaceBelow;
  const top = placeAbove ? opts.avoid.top - gap - h : opts.avoid.bottom + gap;
  return { top: clampTop(top), left: clampLeft(opts.avoid.left - w) };
}

/**
 * 把第二张卡贴在预览卡外侧，绝不与预览卡重叠：
 * 1) 正下方、左对齐
 * 2) 预览卡左侧、顶对齐
 * 3) 正上方、左对齐
 */
export function placeStackOrSide(opts: {
  preview: { top: number; left: number; width: number; height: number };
  menuWidth: number;
  menuHeight: number;
  viewport: ViewportBox;
  pad?: number;
  gap?: number;
}): FixedSideFlyoutPlacement {
  const pad = opts.pad ?? FIXED_MENU_PAD;
  const gap = opts.gap ?? 6;
  const w = Math.max(opts.menuWidth, 1);
  const h = Math.max(opts.menuHeight, 1);
  const vw = Math.max(opts.viewport.width, pad * 2 + 1);
  const vh = Math.max(opts.viewport.height, pad * 2 + 1);
  const clampLeft = (left: number): number =>
    Math.min(Math.max(pad, left), Math.max(pad, vw - pad - w));
  const clampTop = (top: number): number =>
    Math.min(Math.max(pad, top), Math.max(pad, vh - pad - h));

  const previewRight = opts.preview.left + opts.preview.width;
  const previewBottom = opts.preview.top + opts.preview.height;
  const belowTop = previewBottom + gap;
  if (vh - pad - belowTop >= h) {
    return { top: belowTop, left: clampLeft(opts.preview.left) };
  }

  const left = opts.preview.left - gap - w;
  if (left >= pad) {
    return { top: clampTop(opts.preview.top), left };
  }

  const right = previewRight + gap;
  if (right + w <= vw - pad) {
    return { top: clampTop(opts.preview.top), left: right };
  }

  return { top: clampTop(opts.preview.top - gap - h), left: clampLeft(opts.preview.left) };
}
