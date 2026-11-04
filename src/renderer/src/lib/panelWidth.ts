import type { ArtifactKind } from "@/types";

/** 侧栏默认宽度（默认 390px） */
export const PANEL_RAIL_WIDTH = 390;

/**
 * 聊天区最小保留宽度（含输入框 gutter）。
 * 360 可容纳工具栏 compact 图标行（+ / 权限 / 上下文 / 模型 / 语音 / 发送）。
 */
export const PANEL_CHAT_MIN = 360;

/** 右栏极端情况下的硬下限（窗口过窄时优先保证聊天区，但仍不让右栏完全消失） */
const PANEL_HARD_MIN = 200;

/** 主内容与右栏之间的拖拽把手宽度（.panel-resize-handle） */
const PANEL_HANDLE_WIDTH = 3;

/** 左侧任务栏真实宽度（global.css 中 .sidebar 设定为 264px） */
const PANEL_SIDEBAR_WIDTH = 264;

/** 需要更宽预览区的类型（网页 / 文档 / 表格 / 图） */
const WIDE_KINDS = new Set<ArtifactKind>([
  "html",
  "svg",
  "pdf",
  "docx",
  "xlsx",
  "pptx",
  "image",
]);

function mainAreaWidth(sidebarCollapsed: boolean): number {
  if (typeof window === "undefined") return 960;
  // 测量真实 DOM 中的侧边栏宽度
  let sidebarWidth = 0;
  if (!sidebarCollapsed) {
    const sidebarEl = typeof document !== "undefined" ? document.querySelector(".sidebar") : null;
    sidebarWidth = sidebarEl ? sidebarEl.getBoundingClientRect().width : PANEL_SIDEBAR_WIDTH;
  }
  const layoutWidth = document.body?.clientWidth || window.innerWidth;
  return Math.max(1, layoutWidth - sidebarWidth);
}

/** 拖拽与自动宽度共用夹紧：最大约 72% 主区，且优先留给聊天区 PANEL_CHAT_MIN（预留安全余量避免超出视口） */
export function clampPanelWidth(width: number, sidebarCollapsed: boolean): number {
  const main = mainAreaWidth(sidebarCollapsed);
  const maxByRatio = Math.floor(main * 0.72);
  // 保证聊天区至少 PANEL_CHAT_MIN（再扣掉把手、边框和 20px 安全余量）
  const maxByChat = main - PANEL_CHAT_MIN - PANEL_HANDLE_WIDTH - 20;
  const max = Math.max(PANEL_HARD_MIN, Math.min(maxByRatio, maxByChat));
  const min = Math.min(PANEL_RAIL_WIDTH, max);
  return Math.round(Math.min(Math.max(width, min), max));
}

/**
 * 自适应右侧栏宽度（对齐官方 MyBuddy）：
 * - 无文件 / 概览轨：窄
 * - 打开 html 等：约主区 58%（半屏偏右，聊天仍可见）
 * - md / code：约主区 48%
 */
export function adaptivePanelWidth(
  kind: ArtifactKind | null | undefined,
  sidebarCollapsed: boolean,
): number {
  if (!kind) return PANEL_RAIL_WIDTH;
  const main = mainAreaWidth(sidebarCollapsed);
  const ratio = WIDE_KINDS.has(kind) ? 0.58 : 0.48;
  return clampPanelWidth(main * ratio, sidebarCollapsed);
}

/**
 * 外部网页 / 终端 / Ardot 画布的夹紧：
 * 适度宽屏展示（主区约 76%），严格保证聊天区与把手安全余量，绝对避免侧栏超出视口被裁切。
 */
export function clampCanvasPanelWidth(width: number, sidebarCollapsed: boolean): number {
  const main = mainAreaWidth(sidebarCollapsed);
  const maxByRatio = Math.floor(main * 0.76);
  const maxByChat = main - PANEL_CHAT_MIN - PANEL_HANDLE_WIDTH - 24;
  const max = Math.max(PANEL_HARD_MIN, Math.min(maxByRatio, maxByChat));
  const min = Math.min(PANEL_RAIL_WIDTH, max);
  return Math.round(Math.min(Math.max(width, min), max));
}

/** 画布默认宽度 = 当前窗口下允许的最大画布宽 */
export function canvasPanelWidth(sidebarCollapsed: boolean): number {
  return clampCanvasPanelWidth(Number.MAX_SAFE_INTEGER, sidebarCollapsed);
}
