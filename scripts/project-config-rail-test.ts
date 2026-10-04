/**
 * Project Config Rail 纯逻辑测试（实施文档 §66）。
 * 覆盖：
 * - width clamp（§48）
 * - rail mode transition（collapsed/summary/detail）
 * - summary/detail transition + Detail 自动扩宽（§63）
 * - switch project resets detail（§35）
 * - persisted width restore（§16/§17/§48）
 * - responsive dock/overlay decision（§29-31）
 * - Esc 行为（§50）
 */
import assert from "node:assert/strict";
import {
  RAIL_DEFAULT_WIDTH,
  RAIL_DETAIL_TARGET_WIDTH,
  RAIL_MAX_WIDTH,
  RAIL_MIN_WIDTH,
  RAIL_OVERLAY_BREAKPOINT,
  RAIL_PREFERENCE_STORAGE_KEY,
  applyRailEscape,
  applyRailProjectSwitch,
  clampRailWidth,
  closeRailDetail,
  collapseRail,
  decideRailDockMode,
  expandRail,
  loadRailPreferences,
  openRailSection,
  railResizeEnd,
  railResizeMove,
  railResizeStart,
  railWidthForDetail,
  saveRailPreferences,
  type ProjectConfigRailState,
  type RailPreferenceStorage,
} from "../src/renderer/src/lib/projectConfigRail";

function makeState(overrides: Partial<ProjectConfigRailState> = {}): ProjectConfigRailState {
  return { mode: "summary", section: null, intent: null, width: 320, preferredWidth: 320, dock: "docked", ...overrides };
}

function makeStorage(initial: Record<string, string> = {}): RailPreferenceStorage & { data: Record<string, string> } {
  return {
    data: { ...initial },
    getItem(key) {
      return this.data[key] ?? null;
    },
    setItem(key, value) {
      this.data[key] = value;
    },
  };
}

/* ---------- §48：width clamp ---------- */
{
  assert.equal(clampRailWidth(320), 320, "in-range unchanged");
  assert.equal(clampRailWidth(100), RAIL_MIN_WIDTH, "below min clamped");
  assert.equal(clampRailWidth(9999), RAIL_MAX_WIDTH, "above max clamped");
  assert.equal(clampRailWidth(320.6), 321, "fractional rounded");
  assert.equal(clampRailWidth(Number.NaN), RAIL_DEFAULT_WIDTH, "NaN falls back to default");
  assert.equal(clampRailWidth(Number.POSITIVE_INFINITY), RAIL_DEFAULT_WIDTH, "non-finite falls back to default");
}

/* ---------- §63：Detail 自动扩宽，返回时恢复 ---------- */
{
  assert.equal(railWidthForDetail(320), RAIL_DETAIL_TARGET_WIDTH, "width < 420 expands to 460");
  assert.equal(railWidthForDetail(420), 420, "width == 420 kept");
  assert.equal(railWidthForDetail(500), 500, "width > 420 kept");
  assert.equal(railWidthForDetail(9999), RAIL_MAX_WIDTH, "never exceeds max");

  const state = makeState({ width: 320 });
  const detail = openRailSection(state, "experts", "add");
  assert.equal(detail.mode, "detail", "openSection → detail");
  assert.equal(detail.section, "experts");
  assert.equal(detail.intent, "add", "intent carried into detail (§10)");
  assert.equal(detail.width, RAIL_DETAIL_TARGET_WIDTH, "detail width auto-expanded");
  assert.equal(detail.preferredWidth, 320, "preferredWidth untouched (§63)");
  assert.equal(openRailSection(state, "skills").intent, "manage", "default intent is manage");

  const back = closeRailDetail(detail);
  assert.equal(back.mode, "summary", "closeRailDetail → summary");
  assert.equal(back.section, null);
  assert.equal(back.intent, null, "intent reset when detail closes (§28)");
  assert.equal(back.width, 320, "summary restores user width, preference not overwritten");
  assert.equal(back.preferredWidth, 320, "preferredWidth restored");
}

/* ---------- collapse / expand 三态 ---------- */
{
  const collapsed = collapseRail(makeState());
  assert.equal(collapsed.mode, "collapsed");
  assert.equal(collapsed.section, null);
  assert.equal(collapsed.intent, null, "collapse resets intent");
  assert.equal(collapsed.width, 320, "width remembered while collapsed (§64)");

  const expanded = expandRail(collapsed);
  assert.equal(expanded.mode, "summary", "expand restores summary, not fixed 320 (§64)");
  assert.equal(expanded.width, 320, "last summary width restored");

  // 用户拖到 500 后 collapse → expand，应恢复 500（§64 记忆宽度）
  const wide = expandRail(collapseRail(makeState({ width: 500, preferredWidth: 500 })));
  assert.equal(wide.width, 500, "remembered width 500 restored after collapse/expand");
}

/* ---------- §35：切换 Project 重置 Detail，保留 collapsed/width ---------- */
{
  const detailState = makeState({ mode: "detail", section: "mcp", width: 460, preferredWidth: 380, dock: "docked" });
  const switched = applyRailProjectSwitch(detailState);
  assert.equal(switched.mode, "summary", "detail resets to summary on project switch");
  assert.equal(switched.section, null, "section context not carried to other project");
  assert.equal(switched.intent, null, "intent not carried to other project");
  assert.equal(switched.width, 380, "display width restored to preference after switch");
  assert.equal(switched.preferredWidth, 380, "width preference kept");

  const collapsedState = makeState({ mode: "collapsed", width: 500 });
  assert.equal(applyRailProjectSwitch(collapsedState).mode, "collapsed", "collapsed stays collapsed");

  const summaryState = makeState({ mode: "summary", width: 380 });
  assert.equal(applyRailProjectSwitch(summaryState).mode, "summary", "summary stays summary");
}

/* ---------- §50：Esc 行为 ---------- */
{
  const detail = applyRailEscape(makeState({ mode: "detail", section: "skills", width: 460 }));
  assert.equal(detail?.mode, "summary", "Esc in detail → summary");
  assert.equal(detail?.section, null);
  assert.equal(detail?.intent, null, "Esc resets intent");

  const overlaySummary = applyRailEscape(makeState({ mode: "summary", dock: "overlay" }));
  assert.equal(overlaySummary?.mode, "collapsed", "Esc in overlay summary → collapsed");

  const dockedSummary = applyRailEscape(makeState({ mode: "summary", dock: "docked" }));
  assert.equal(dockedSummary, null, "Esc in docked summary does nothing (§50 防误收)");

  const collapsed = applyRailEscape(makeState({ mode: "collapsed" }));
  assert.equal(collapsed, null);
}

/* ---------- §29-31：响应式 dock/overlay ---------- */
{
  assert.equal(decideRailDockMode(800), "overlay", "< 900 → overlay");
  assert.equal(decideRailDockMode(899), "overlay");
  assert.equal(decideRailDockMode(900), "docked", ">= 900 → docked");
  assert.equal(decideRailDockMode(1400), "docked");
  assert.equal(decideRailDockMode(Number.NaN), "docked", "unknown viewport stays docked");
}

/* ---------- §16/§17/§48：UI preference 持久化（注入 storage） ---------- */
{
  const storage = makeStorage();
  const saved = { width: 420, collapsed: true };
  saveRailPreferences(storage, saved);
  assert.deepEqual(loadRailPreferences(storage), saved, "round-trip");

  // 非法宽度持久化 → 读取时 clamp（§48）
  storage.data[RAIL_PREFERENCE_STORAGE_KEY] = JSON.stringify({ width: 99999, collapsed: false });
  assert.equal(loadRailPreferences(storage).width, RAIL_MAX_WIDTH, "persisted out-of-range width clamped");
  storage.data[RAIL_PREFERENCE_STORAGE_KEY] = JSON.stringify({ width: 1, collapsed: true });
  assert.equal(loadRailPreferences(storage).width, RAIL_MIN_WIDTH, "persisted too-small width clamped");
  assert.equal(loadRailPreferences(storage).collapsed, true);

  // 坏 JSON / 空 → 默认值
  storage.data[RAIL_PREFERENCE_STORAGE_KEY] = "{oops";
  assert.deepEqual(loadRailPreferences(storage), { width: RAIL_DEFAULT_WIDTH, collapsed: false }, "corrupt storage falls back");

  // 无 storage（node 环境）→ 默认
  assert.deepEqual(loadRailPreferences(undefined), { width: RAIL_DEFAULT_WIDTH, collapsed: false });
  saveRailPreferences(undefined, saved); // 不抛错

  // 保存时也 clamp（防手滑）
  saveRailPreferences(storage, { width: 50, collapsed: false });
  assert.equal(loadRailPreferences(storage).width, RAIL_MIN_WIDTH, "save path clamps too");
}

/* ---------- P2-5：Pointer Resize 事件流（组件级状态机） ---------- */
{
  // pointerdown → resizing，宽度不变
  const down = railResizeStart({ resizing: false, width: 320 });
  assert.equal(down.resizing, true, "pointerdown enters resizing");
  assert.equal(down.width, 320, "width untouched on down");

  // pointermove：railRight - clientX → clamp
  const moved = railResizeMove(down, 800, 1200); // 1200 - 800 = 400
  assert.equal(moved.width, 400, "width = right - clientX");
  const clampedLow = railResizeMove(down, 1500, 1200); // -300 → min
  assert.equal(clampedLow.width, RAIL_MIN_WIDTH, "below min clamped (§48)");
  const clampedHigh = railResizeMove(down, 300, 1200); // 900 → max
  assert.equal(clampedHigh.width, RAIL_MAX_WIDTH, "above max clamped (§48)");

  // 未进入 resizing 时 move 忽略
  const idle = railResizeMove({ resizing: false, width: 320 }, 800, 1200);
  assert.equal(idle.width, 320, "move ignored when not resizing");

  // pointerup → 退出拖拽（commit 由调用方持久化），宽度保留
  const up = railResizeEnd(moved);
  assert.equal(up.resizing, false, "pointerup exits resizing");
  assert.equal(up.width, 400, "committed width kept");

  // 双击恢复默认宽度：走 setWidthDuringResize(RAIL_DEFAULT_WIDTH) + commit
  const dbl = railResizeEnd(railResizeStart({ resizing: true, width: RAIL_DEFAULT_WIDTH }));
  assert.equal(dbl.resizing, false, "double-click reset exits resizing");

  // 小数 → clamp 取整
  const rounded = railResizeMove(down, 799.4, 1200);
  assert.equal(rounded.width, 401, "fractional width rounded (§48)");
}

console.log("project-config-rail-test: PASS");
