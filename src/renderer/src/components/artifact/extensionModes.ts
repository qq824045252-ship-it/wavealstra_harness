/**
 * 扩展栏模式清单（概览/工作空间/Gadgets/终端/浏览器/变更）— ExtensionTopBar 与
 * ExtensionModeDropdown 共用，避免两处重复定义漂移。
 */
import type { PanelMode } from "@/store/appStore";

export const EXTENSION_MODES: PanelMode[] = [
  "overview",
  "workspace",
  "gadgets",
  "terminal",
  "browser",
  "changes",
];

export const EXTENSION_MODE_LABEL: Record<PanelMode, string> = {
  overview: "概览",
  workspace: "工作空间文件",
  gadgets: "Gadgets",
  terminal: "终端",
  browser: "浏览器",
  changes: "变更",
  file: "概览",
};
