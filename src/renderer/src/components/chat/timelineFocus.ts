/**
 * 流式"聚焦最新"视图的纯函数模型（无 React 依赖，可独立单测）。
 *
 * 目标交互（用户确认版）：
 *  - 仅 assistant 消息 message.streaming===true 时启用聚焦视图；
 *  - 流式期间只显示最新活跃 thinking 段与当前 running 工具；
 *  - 旧 thinking 段与已完成 success 工具退入紧凑历史摘要（段数/工具数计数）；
 *  - pending_approval / running 工具强制可见，不得进历史；
 *  - success / error / denied 均视为已结束，统一进入历史；
 *  - dangerous 仅在尚无明确状态时兜底保持可见；
 *  - callout / plan / file_table / detail 等非 thinking/tool 块永不隐藏；
 *  - 用户展开历史（historyOpen）后恢复完整时间线，直到本轮流式结束；
 *  - 活跃思考段 = 最后一段包含 thinking 块的段；其后的工具 / 过程文本不使其失活
 *    （工具打断时思考保持展开），直到下一段新思考开始或最终回复开始才收起。
 */
import type { MessageBlock } from "@/types";

export type TimelineGroup =
  | { kind: "thinking"; blocks: MessageBlock[]; key: string }
  | { kind: "other"; block: MessageBlock; index: number; key: string };

/** 强制可见（豁免）的工具状态。 */
export const TOOL_STATUS_EXEMPT: ReadonlySet<string> = new Set([
  "pending_approval",
  "running",
]);

export interface FocusView {
  /** 聚焦视图应展开的活跃段下标；-1 = 无活跃段 */
  liveIdx: number;
  /** 被收进历史的思考段数 */
  hiddenThinking: number;
  /** 被收进历史的工具数 */
  hiddenTools: number;
}

/** 工具是否豁免于历史过滤（仅审批/运行中，或尚无明确状态的危险操作）。 */
export function isToolExempt(
  status: string | undefined,
  dangerous: boolean | undefined,
): boolean {
  if (status != null) return TOOL_STATUS_EXEMPT.has(status);
  return dangerous === true;
}

/** 单个组在聚焦视图中是否应被隐藏（退入历史）。 */
export function isGroupHiddenInFocus(group: TimelineGroup): boolean {
  if (group.kind === "thinking") return true; // 非活跃思考段 → 历史
  if (group.block.type !== "tool") return false; // callout/plan/file_table/detail 永不隐藏
  return !isToolExempt(group.block.toolCall.status, group.block.toolCall.dangerous);
}

/**
 * 当前应展开并贴底的思考段下标；无活跃段返回 -1。
 *
 * 活跃段 = 流式期间、尚未开始最终回复时，消息中「最后一组包含真正 thinking 块」的
 * 思考段。思考段之后的工具调用 / 过程文本不使其失活（工具打断时思考保持展开），
 * 直到下一段新思考段开始（活跃段前移，旧段收起）或最终回复开始（全部收起）。
 *
 * 不活跃（应收起）的情况：
 * - 整轮已结束（messageStreaming=false，历史深度思考默认折叠）
 * - 已开始输出最终回复 finalBlocks（hasFinalOutput=true）
 * - 消息中没有任何包含 thinking 块的思考段（仅过程文本 / 工具）
 */
export function findActiveThinkingGroupIndex(
  groups: TimelineGroup[],
  messageStreaming: boolean,
  hasFinalOutput: boolean,
): number {
  if (!messageStreaming || hasFinalOutput || groups.length === 0) return -1;
  // 从后往前找最后一段包含 thinking 块的思考段；
  // 末组是工具 / 过程文本时仍返回该思考段（工具打断不收起）。
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    const g = groups[i];
    if (g.kind === "thinking" && g.blocks.some((b) => b.type === "thinking")) return i;
  }
  return -1;
}

/**
 * 计算聚焦视图：
 *  - liveIdx：优先 findActiveThinkingGroupIndex 的活跃段；无思考块但末组是过程文本时，
 *    仍把末组当作"最新正在产生的思考内容"（避免文本独占时聚焦视图空窗）。
 *  - 隐藏计数：除 liveIdx 外的思考段 + 非豁免工具。
 */
export function computeFocusView(
  groups: TimelineGroup[],
  activeIdx: number,
  streaming: boolean,
): FocusView {
  if (!streaming || groups.length === 0) {
    return { liveIdx: -1, hiddenThinking: 0, hiddenTools: 0 };
  }
  const last = groups[groups.length - 1];
  const liveIdx = activeIdx >= 0 ? activeIdx : last.kind === "thinking" ? groups.length - 1 : -1;
  let hiddenThinking = 0;
  let hiddenTools = 0;
  for (let i = 0; i < groups.length; i += 1) {
    if (i === liveIdx) continue;
    const g = groups[i];
    if (!isGroupHiddenInFocus(g)) continue;
    if (g.kind === "thinking") hiddenThinking += 1;
    else if (g.block.type === "tool") hiddenTools += 1;
  }
  return { liveIdx, hiddenThinking, hiddenTools };
}

/**
 * 单个组是否应渲染：
 *  - focusActive=false（非流式 / 用户已展开历史）→ 全部渲染（保持原行为）；
 *  - focusActive=true → 仅活跃段 + 豁免项。
 */
export function shouldRenderGroup(
  group: TimelineGroup,
  index: number,
  focusActive: boolean,
  liveIdx: number,
): boolean {
  if (!focusActive) return true;
  return index === liveIdx || !isGroupHiddenInFocus(group);
}
