/**
 * Project Config Rail UI store（Project V2 右栏）。
 * 状态归属：renderer UI store（实施文档 §47），不入 Project Domain。
 * - preferredWidth / collapsed 持久化到 localStorage（UI preference，§16/§17）
 * - section 不持久化（切换 Project 时重置，§35）
 * - width 为展示宽度（Detail 临时扩宽用），preferredWidth 为用户偏好（§63）
 * 核心转换全部委托 lib/projectConfigRail 纯函数（可单测）。
 */
import { create } from "zustand";
import {
  applyRailEscape,
  applyRailProjectSwitch,
  clampRailWidth,
  closeRailDetail,
  collapseRail,
  decideRailDockMode,
  expandRail,
  loadRailPreferences,
  openRailSection,
  RAIL_DEFAULT_WIDTH,
  railResizeEnd,
  saveRailPreferences,
  type ProjectConfigDetailIntent,
  type ProjectConfigRailMode,
  type ProjectConfigSection,
  type RailDockMode,
} from "@/lib/projectConfigRail";

interface ProjectConfigRailStore {
  mode: ProjectConfigRailMode;
  section: ProjectConfigSection | null;
  /** Detail 打开意图：manage（点卡片）/ add（点 +），进入时定位到搜索区（§10） */
  intent: ProjectConfigDetailIntent | null;
  /** 展示宽度（Summary/Collapsed 恒等于 preferredWidth；Detail 可能临时扩宽） */
  width: number;
  /** 用户偏好宽度（持久化；resize 实时更新，松手持久化） */
  preferredWidth: number;
  dock: RailDockMode;
  /** resize 拖拽中（禁用 transition，§43） */
  resizing: boolean;

  setDock: (dock: RailDockMode) => void;
  openSection: (section: ProjectConfigSection, intent?: ProjectConfigDetailIntent) => void;
  backToSummary: () => void;
  collapse: () => void;
  expand: () => void;
  /** resize 拖动中（不持久化） */
  setWidthDuringResize: (width: number) => void;
  /** resize 结束（持久化偏好） */
  commitWidth: () => void;
  /** 切换 Project：Detail 重置为 Summary，collapsed/width 保留（§35） */
  resetForProject: () => void;
  /** 键盘 Esc（§50）：Detail → Summary；Overlay + Summary → 收起 */
  handleEscape: () => void;
}

function persist(state: { preferredWidth: number; mode: ProjectConfigRailMode }): void {
  if (typeof window === "undefined") return;
  saveRailPreferences(window.localStorage, {
    width: state.preferredWidth,
    collapsed: state.mode === "collapsed",
  });
}

function initialPrefs(): { width: number; collapsed: boolean } {
  if (typeof window === "undefined") return { width: RAIL_DEFAULT_WIDTH, collapsed: false };
  return loadRailPreferences(window.localStorage);
}

export const useProjectConfigRailStore = create<ProjectConfigRailStore>((set, get) => ({
  mode: initialPrefs().collapsed ? "collapsed" : "summary",
  section: null,
  intent: null,
  width: initialPrefs().width,
  preferredWidth: initialPrefs().width,
  dock: "docked",
  resizing: false,

  setDock: (dock) => set({ dock }),

  openSection: (section, intent = "manage") =>
    set((state) => ({ ...openRailSection(state, section, intent), resizing: false })),

  backToSummary: () =>
    set((state) => {
      const next = closeRailDetail(state);
      persist(next);
      return { ...next, resizing: false };
    }),

  collapse: () =>
    set((state) => {
      const next = collapseRail(state);
      persist(next);
      return { ...next, resizing: false };
    }),

  expand: () =>
    set((state) => {
      const next = expandRail(state);
      persist(next);
      return { ...next, resizing: false };
    }),

  setWidthDuringResize: (width) =>
    set({ width: clampRailWidth(width), preferredWidth: clampRailWidth(width) }),

  commitWidth: () => {
    const state = get();
    persist(state);
    set(railResizeEnd(state));
  },

  resetForProject: () =>
    set((state) => ({ ...applyRailProjectSwitch(state), resizing: false })),

  handleEscape: () => {
    const next = applyRailEscape(get());
    if (!next) return;
    persist(next);
    set({ ...next, resizing: false });
  },
}));

/** 初始化/窗口变化时同步 dock 判定（视口 < 900px → overlay，§29-31） */
export function syncRailDockFromViewport(): void {
  if (typeof window === "undefined") return;
  useProjectConfigRailStore.getState().setDock(decideRailDockMode(window.innerWidth));
}
