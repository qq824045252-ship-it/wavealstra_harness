/**
 * Project Config Rail 纯逻辑层（Project V2 右栏）。
 * 只放可单测的纯计算：宽度 clamp / 三态转换 / 响应式判定 / UI 偏好读写。
 * 不依赖 window / DOM；storage 由调用方注入（node 测试可传 fake）。
 */

export type ProjectConfigRailMode = "collapsed" | "summary" | "detail";

export type ProjectConfigSection = "instructions" | "experts" | "skills" | "connectors" | "mcp";

/** §10：Detail 打开意图。manage=点卡片；add=点 +（进入时 focus 搜索区）。Detail 关闭即重置。 */
export type ProjectConfigDetailIntent = "manage" | "add";

export type RailDockMode = "docked" | "overlay";

export const RAIL_MIN_WIDTH = 280;
export const RAIL_DEFAULT_WIDTH = 320;
export const RAIL_MAX_WIDTH = 520;
/** 进入 Detail 时若当前宽度低于此值，自动扩宽到 DETAIL_TARGET_WIDTH（实施文档 §63） */
export const RAIL_DETAIL_MIN_WIDTH = 420;
export const RAIL_DETAIL_TARGET_WIDTH = 460;
/** 视口窄于该值时 Rail 自动切换为 Overlay Drawer（§29-31） */
export const RAIL_OVERLAY_BREAKPOINT = 900;

export const RAIL_PREFERENCE_STORAGE_KEY = "mybuddy-project-config-rail";

export interface ProjectConfigRailState {
  mode: ProjectConfigRailMode;
  /** Detail 当前分区；null = Summary。切换 Project 时必须重置（§35）。 */
  section: ProjectConfigSection | null;
  /** Detail 打开意图；进入 Summary/Collapsed 即重置（§10/§28） */
  intent: ProjectConfigDetailIntent | null;
  /** 展示宽度（Summary/Collapsed 恒等于 preferredWidth；Detail 可能临时扩宽，§63） */
  width: number;
  /** 用户偏好宽度（持久化；Detail 自动扩宽不覆盖它，返回 Summary 时恢复，§63/§64） */
  preferredWidth: number;
  /** 运行期视图模式（由视口宽度决定，§29-31） */
  dock: RailDockMode;
}

export interface RailPreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface RailPreferences {
  width: number;
  collapsed: boolean;
}

/** 任何来源的宽度都必须 clamp 到 [MIN, MAX]，防止历史设置/窗口变化产生非法宽度（§48） */
export function clampRailWidth(width: number): number {
  if (!Number.isFinite(width)) return RAIL_DEFAULT_WIDTH;
  return Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH, Math.round(width)));
}

/**
 * Detail 自动扩宽规则（§63）：
 * width < 420 → 展示 460；否则保留用户宽度。
 * 不覆盖保存的 preference，返回 Summary 时恢复原宽。
 */
export function railWidthForDetail(currentWidth: number): number {
  const width = clampRailWidth(currentWidth);
  return width < RAIL_DETAIL_MIN_WIDTH ? RAIL_DETAIL_TARGET_WIDTH : width;
}

/** 响应式判定（§29-31）：视口 < 900px → Overlay Drawer；否则 Docked */
export function decideRailDockMode(viewportWidth: number): RailDockMode {
  return Number.isFinite(viewportWidth) && viewportWidth < RAIL_OVERLAY_BREAKPOINT ? "overlay" : "docked";
}

/** 打开某个 Detail 分区：mode → detail，section 设置，展示宽度按 §63 扩宽（不动 preferredWidth） */
export function openRailSection(
  state: ProjectConfigRailState,
  section: ProjectConfigSection,
  intent: ProjectConfigDetailIntent = "manage",
): ProjectConfigRailState {
  return { ...state, mode: "detail", section, intent, width: railWidthForDetail(state.preferredWidth) };
}

/** Detail → Summary：恢复用户偏好宽度（§63/§64），intent 重置（§28） */
export function closeRailDetail(state: ProjectConfigRailState): ProjectConfigRailState {
  return { ...state, mode: "summary", section: null, intent: null, width: state.preferredWidth };
}

/** 收起：mode → collapsed；宽度保持记忆（§64），持久化交给调用方 */
export function collapseRail(state: ProjectConfigRailState): ProjectConfigRailState {
  return { ...state, mode: "collapsed", section: null, intent: null, width: state.preferredWidth };
}

/** 展开：恢复 lastSummaryWidth（记忆宽度，§64） */
export function expandRail(state: ProjectConfigRailState): ProjectConfigRailState {
  return { ...state, mode: "summary", width: state.preferredWidth };
}

/** 切换 Project（§35）：Detail 必须重置为 Summary（展示宽度恢复偏好）；collapsed/width 保留 */
export function applyRailProjectSwitch(state: ProjectConfigRailState): ProjectConfigRailState {
  if (state.mode === "detail") {
    return { ...state, mode: "summary", section: null, intent: null, width: state.preferredWidth };
  }
  return { ...state, section: null, intent: null };
}

/** Esc 行为（§50）：Detail → Summary；Overlay + Summary → 收起。返回新状态或 null（不处理） */
export function applyRailEscape(
  state: ProjectConfigRailState,
): ProjectConfigRailState | null {
  if (state.mode === "detail") return closeRailDetail(state);
  if (state.mode === "summary" && state.dock === "overlay") return collapseRail(state);
  return null;
}

/** 读取 UI 偏好（§16/§17/§48）：clamp + 兜底默认。storage 注入以便 node 测试。 */
export function loadRailPreferences(storage: RailPreferenceStorage | null | undefined): RailPreferences {
  if (!storage) return { width: RAIL_DEFAULT_WIDTH, collapsed: false };
  try {
    const raw = storage.getItem(RAIL_PREFERENCE_STORAGE_KEY);
    if (!raw) return { width: RAIL_DEFAULT_WIDTH, collapsed: false };
    const parsed = JSON.parse(raw) as Partial<RailPreferences>;
    return {
      width: clampRailWidth(typeof parsed.width === "number" ? parsed.width : RAIL_DEFAULT_WIDTH),
      collapsed: parsed.collapsed === true,
    };
  } catch {
    return { width: RAIL_DEFAULT_WIDTH, collapsed: false };
  }
}

/** 保存 UI 偏好（§16/§17）：只存 width + collapsed，与 Project Domain 无关 */
export function saveRailPreferences(
  storage: RailPreferenceStorage | null | undefined,
  preferences: RailPreferences,
): void {
  if (!storage) return;
  try {
    storage.setItem(
      RAIL_PREFERENCE_STORAGE_KEY,
      JSON.stringify({ width: clampRailWidth(preferences.width), collapsed: preferences.collapsed }),
    );
  } catch {
    /* private mode / quota */
  }
}

/** 分区中文标题（Rail Header / Detail 标题） */
export const RAIL_SECTION_LABELS: Record<ProjectConfigSection, string> = {
  instructions: "指令",
  experts: "专家",
  skills: "技能",
  connectors: "连接器",
  mcp: "MCP",
};

/**
 * Pointer Resize 纯逻辑（P2-5 可测）：pointerdown/move/up 事件流 → width 状态机。
 * 组件只负责事件转发；clamp / commit / cleanup 语义都在这里，node 测试直接驱动。
 */
export interface RailResizeState {
  resizing: boolean;
  width: number;
}

export type RailResizeEvent =
  | { type: "down" }
  /** clientX = 指针 x；railRight = Rail 右缘 x（拖左缘，宽度 = right - clientX） */
  | { type: "move"; clientX: number; railRight: number }
  | { type: "up" };

/** pointerdown：进入拖拽态（禁用 transition，§43） */
export function railResizeStart(state: RailResizeState): RailResizeState {
  return { ...state, resizing: true };
}

/** pointermove：clamp 后实时更新展示宽度（§48） */
export function railResizeMove(
  state: RailResizeState,
  clientX: number,
  railRight: number,
): RailResizeState {
  if (!state.resizing) return state;
  return { ...state, width: clampRailWidth(railRight - clientX) };
}

/** pointerup / lostpointercapture / 双击：退出拖拽态（commit 由调用方持久化） */
export function railResizeEnd(state: RailResizeState): RailResizeState {
  return { ...state, resizing: false };
}
