/**
 * 扩展栏模式清单（概览/工作空间/Gadgets/终端/浏览器/变更）— ExtensionTopBar 与
 * ExtensionModeDropdown 共用，避免两处重复定义漂移。
 */
import type { PanelMode } from "@/store/appStore";

export const EXTENSION_MODES: PanelMode[] = [
  "overview",
  "artifacts",
  "changes",
  "workspace",
  "gadgets",
  "terminal",
  "browser",
];

export const EXTENSION_MODE_LABEL: Record<PanelMode, string> = {
  overview: "概览",
  artifacts: "产物",
  changes: "变更",
  workspace: "工作空间文件",
  gadgets: "工作台",
  terminal: "终端",
  browser: "浏览器",
  file: "文件预览",
};
