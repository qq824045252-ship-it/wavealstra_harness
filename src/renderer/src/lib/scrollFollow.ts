/**
 * 消息列表「单一滚动意图」纯状态机（无 React 依赖，可独立单测）。
 *
 * 包含三部分：
 * 1) FollowState —— 是否贴底跟随；单一真源：FollowState.follow 决定 ChatView
 *    是否在内容高度变化时把滚动钉在底部。
 * 2) shouldAdjustScrollCompensation —— 是否允许 TanStack Virtualizer 对行尺寸
 *    变化做 scrollTop 补偿（纳入同一意图模型，见下）。
 * 3) keyboardIntent / shouldResetFollow —— 键盘用户意图与任务切换重置判定。
 *
 * 核心规则：distance（距底距离）本身永远不能恢复 follow；
 * 只有「明确的用户向下手势」落到底部阈值内才恢复。这修复了历史偶发抖动：
 * 小幅上滚（wheel 步长 < 阈值）→ 下一帧 scroll 事件按距离误恢复 →
 * 下一次内容增高又把用户拽回底部 → 与用户上滚互相拉扯。
 */
export const FOLLOW_BOTTOM_THRESHOLD = 48;

/** 用户滚动手势方向；null = 无手势（程序化滚动不改变任何状态）。 */
export type FollowDirection = "up" | "down" | null;

export interface FollowState {
  /** 是否贴底跟随：true 时内容增高会自动钉在底部 */
  follow: boolean;
  /** 最近一次用户滚动手势方向 */
  direction: FollowDirection;
  /** 指针拖动（滚动条/触摸）开始时的距底距离；null = 非拖动 */
  dragStartDistance: number | null;
  /** 指针拖动进行中（滚动事件暂不判定，抬起时按净位移判定） */
  pointerScrolling: boolean;
  /**
   * wheel 上滚候选：触底回弹/惯性会产生零位移 deltaY<0，不能凭 wheel 方向立即锁存。
   * true = wheel up 已发生但尚未确认实际位移；由 onScroll(scrollDelta<0) 确认锁存，
   * scrollDelta>0 清除候选，scrollDelta=0 保持候选。
   */
  wheelUpPending: boolean;
}

export function initialFollowState(): FollowState {
  return {
    follow: true,
    direction: null,
    dragStartDistance: null,
    pointerScrolling: false,
    wheelUpPending: false,
  };
}

/** 用户主动向上滚动：立即退出跟随并锁存方向（后续 scroll 事件不再按距离恢复）。 */
export function onUserScrollUp(s: FollowState): FollowState {
  return { ...s, follow: false, direction: "up", wheelUpPending: false };
}

/** 用户主动向下滚动：锁存方向；是否恢复跟随由后续 scroll 事件判定。 */
export function onUserScrollDown(s: FollowState): FollowState {
  return { ...s, direction: "down", wheelUpPending: false };
}

/**
 * wheel 上滚候选（不立即锁存）：触底回弹/惯性会产生零位移 deltaY<0，
 * 此时锁定会把贴底用户误判为“离开底部”。真正锁存由 onScroll 的
 * scrollDelta<0（实际向上位移）确认；零位移保持候选；向下位移清除候选。
 * 键盘/指针/推断等“必有实际位移”的路径仍走 onUserScrollUp 立即锁存。
 */
export function onWheelUpCandidate(s: FollowState): FollowState {
  return { ...s, wheelUpPending: true };
}

/**
 * 滚动事件：仅在存在明确手势方向时更新 follow；程序化滚动（direction=null）不改变状态。
 * - wheelUpPending（wheel 上滚候选）：scrollDelta<0 确认锁存（onUserScrollUp）；
 *   scrollDelta>0 清除候选（用户实际在向下滚）；scrollDelta=0 保持候选（回弹，不锁）。
 * - 方向为 up：保持退出跟随（即使用户只滚了 1px，也尊重其意图）。
 * - 方向为 down：落到底部阈值内才恢复跟随。
 */
export function onScroll(s: FollowState, distanceFromBottom: number, scrollDelta = 0): FollowState {
  if (s.pointerScrolling) return s;
  if (s.wheelUpPending) {
    if (scrollDelta < 0) return onUserScrollUp({ ...s, wheelUpPending: false });
    if (scrollDelta > 0) return { ...s, wheelUpPending: false };
    return s; // 零位移（触底回弹）：保持候选，不锁存
  }
  if (s.direction === "up") return { ...s, follow: false };
  if (s.direction === "down") {
    return { ...s, follow: distanceFromBottom <= FOLLOW_BOTTOM_THRESHOLD };
  }
  return s;
}

/** 指针按下（滚动条拖动 / 触摸滚动）：立即退出跟随并记录起始距离。 */
export function onPointerDown(s: FollowState, distanceFromBottom: number): FollowState {
  return {
    ...s,
    follow: false,
    direction: null,
    dragStartDistance: distanceFromBottom,
    pointerScrolling: true,
    wheelUpPending: false,
  };
}

/** 指针抬起：净位移向下且落到底部阈值内才恢复跟随（拖上/停在半途都不恢复）。 */
export function onPointerUp(s: FollowState, distanceFromBottom: number): FollowState {
  if (!s.pointerScrolling) return s;
  const netDown =
    s.dragStartDistance !== null && distanceFromBottom < s.dragStartDistance;
  return {
    ...s,
    follow:
      netDown && distanceFromBottom <= FOLLOW_BOTTOM_THRESHOLD ? true : s.follow,
    pointerScrolling: false,
    dragStartDistance: null,
  };
}

/** 指针手势取消（pointercancel）：不恢复跟随。 */
export function onPointerCancel(s: FollowState): FollowState {
  return { ...s, pointerScrolling: false, dragStartDistance: null };
}

/** 任务切换 / 历史恢复 / 新一轮发送 / 点击「回到底部」：重置为贴底并清除手势方向。 */
export function onResetForTask(s: FollowState): FollowState {
  return {
    ...s,
    follow: true,
    direction: null,
    dragStartDistance: null,
    pointerScrolling: false,
    wheelUpPending: false,
  };
}

/** 历史提问跳转：退出跟随并清除手势方向（随后是程序化滚动，不得改状态）。 */
export function onHistoryJump(s: FollowState): FollowState {
  return {
    ...s,
    follow: false,
    direction: null,
    dragStartDistance: null,
    pointerScrolling: false,
    wheelUpPending: false,
  };
}

/**
 * 无手势 scroll 事件是否应按位移方向推断用户意图（滚动条拖动等）。
 *
 * 排除「贴底时的负位移」：virtualizer 首滚用估算高度定位到末尾，随后真实测量
 * 收缩 / 卡片折叠会让 scrollHeight 变小，浏览器把 scrollTop clamp 回新的
 * maxScrollTop——此时距底距离仍 ≤ FOLLOW_BOTTOM_THRESHOLD。这不是用户上滚
 * （真上滚会让距底距离变大），若按位移推断会把 direction 锁成 "up"、
 * follow 置 false 且永不恢复，导致后续新一轮发送的置顶被 shouldPinOnNewTurn
 * 门控跳过——用户刚发的消息被顶出可视区（#回归：消息消失）。
 *
 * wheel 上滚候选不走此推断（由 onScroll(scrollDelta) 统一确认），故不受影响。
 */
export function shouldInferUserScroll(delta: number, distanceFromBottom: number): boolean {
  // 贴底附近的无手势负位移通常来自内容收缩 / virtualizer 重测 clamp。
  // 真正的 wheel 上滚由 wheelUpPending + scrollDelta 确认；滚动条拖动由 pointer 状态确认。
  if (delta < 0 && distanceFromBottom <= FOLLOW_BOTTOM_THRESHOLD) return false;
  return true;
}

/* ---------------------------------------------------------------------------
 * 虚拟化行尺寸变化时的滚动补偿决策
 * ------------------------------------------------------------------------- */

export interface CompensationContext {
  /** 行顶部相对列表的偏移（virtualizer item.start） */
  itemStart: number;
  /** 补偿前缓存的行高（首测 = estimateSize，重测 = 上次实测） */
  cachedSize: number;
  /** 本次尺寸变化量（新实测 - cachedSize） */
  delta: number;
  /** 当前滚动偏移 + 未决补偿（virtualizer getScrollOffset() + scrollAdjustments） */
  scrollOffset: number;
  /** virtualizer 最近一次滚动方向；null = 空闲 / 程序化滚动 */
  scrollDirection: "forward" | "backward" | null;
  /** 是否贴底跟随 */
  follow: boolean;
  /**
   * 视口位置由外部写入者独占（前插补偿等）：禁止虚拟器再补一次。
   * 与 follow 的区别是 follow 表达「贴底跟随」，这里表达「这一次位移不是内容变高引起的」。
   */
  compensationOwned?: boolean;
}

/**
 * 是否允许 virtualizer 对该行尺寸变化做 scrollTop 补偿（纳入单一滚动意图）。
 *
 * 语义：
 * - follow=true：一律禁止补偿 —— 视口位置归 ChatView 贴底 pin 独占，
 *   消除「补偿把视口从底部拉走、下一帧 pin 拉回」的同帧/跨帧竞争；
 * - 用户向上滚动中（backward）：禁止补偿 —— 避免「往上滚经过长卡时
 *   补偿把滚动手势抵消掉」的拉扯感（virtualizer 默认规则同样抑制 backward）；
 * - 其余（空闲 / 向下滚）：仅当该行「真实下边缘」完全位于当前折叠线上方时
 *   才补偿。此时补偿量 delta 恰好把折叠线下的内容维持在原阅读位置
 *   （真正的锚点保持）；而「首测跨折叠线的超长卡」（估算 160 vs 实测数千，
 *   折叠线落在卡的真实内容内）会被此规则排除，不会把视口向下拖入卡片。
 */
export function shouldAdjustScrollCompensation(ctx: CompensationContext): boolean {
  if (ctx.compensationOwned || ctx.follow) return false;
  if (ctx.scrollDirection === "backward") return false;
  if (ctx.delta === 0) return false;
  // 行真实下边缘 = 缓存高 + 本次增量；必须完全在折叠线上方（含边界）才补偿
  return ctx.itemStart + ctx.cachedSize + ctx.delta <= ctx.scrollOffset;
}

/* ---------------------------------------------------------------------------
 * 键盘滚动意图（document 级 keydown 使用；输入框/按钮等不产生滚动意图）
 * ------------------------------------------------------------------------- */

export type ScrollIntentKey = "up" | "down" | null;

const SCROLL_UP_KEYS: ReadonlySet<string> = new Set(["ArrowUp", "PageUp", "Home"]);
const SCROLL_DOWN_KEYS: ReadonlySet<string> = new Set(["ArrowDown", "PageDown", "End"]);

/**
 * 键盘滚动意图分类：
 * - PageUp / ArrowUp / Home / Space+Shift → up；
 * - PageDown / ArrowDown / End / Space → down；
 * - 输入框/可编辑区（targetIsEditable）一律不算（打字/光标移动不产生滚动意图）；
 * - Space 落在「空格激活」的控件（按钮/链接/select，targetActivatesOnSpace）上
 *   不算 —— 该键会被控件消费，不会滚动容器。
 */
export function keyboardIntent(
  key: string,
  shiftKey: boolean,
  targetIsEditable: boolean,
  targetActivatesOnSpace: boolean,
): ScrollIntentKey {
  if (targetIsEditable) return null;
  if (SCROLL_UP_KEYS.has(key) || (key === " " && shiftKey)) return "up";
  if (key === " " && targetActivatesOnSpace) return null;
  if (SCROLL_DOWN_KEYS.has(key) || key === " ") return "down";
  return null;
}

/* ---------------------------------------------------------------------------
 * 任务切换 / 历史恢复 / 新一轮发送 的重置判定
 * ------------------------------------------------------------------------- */

export interface ResetTriggerContext {
  taskChanged: boolean;
  historyRestored: boolean;
  messageAdded: boolean;
  lastMessageStreaming: boolean;
}

/** 以上任一条件成立即应重置为贴底并取消上一任务待执行的滚动。 */
export function shouldResetFollow(ctx: ResetTriggerContext): boolean {
  return (
    ctx.taskChanged || ctx.historyRestored || (ctx.messageAdded && ctx.lastMessageStreaming)
  );
}

/**
 * 新一轮消息（用户发送 / 新 assistant 消息开始流式）是否应触发置顶：
 * 仅当用户未接管滚动（follow=true）时 pin；用户正在阅读历史（follow=false）
 * 时新消息不得覆盖其显式滚动接管（需求：不把阅读中的视口拉回）。
 */
export function shouldPinOnNewTurn(follow: boolean, newTurn: boolean): boolean {
  return follow && newTurn;
}
