import type { ChatMessage, MessageBlock } from "@/types";

/**
 * 消息行高度的内容感知估算（virtualizer estimateSize）。
 *
 * 背景：固定 160px 估算对超长首卡（thinking + 多工具 + 长 Markdown，真实高度可达
 * 数千 px）误差过大，导致首测 delta 巨大、初始 totalSize 严重偏离真实值。
 * 本函数按内容给出更接近真实的估算，缩小首测 delta 与初始布局误差。
 *
 * 注意：这只是「更稳的初始布局」，滚动安全由 scrollFollow.shouldAdjustScrollCompensation
 * 保证，不依赖估算精度；也禁止仅靠调大估算掩盖根因。
 */

const LINE_HEIGHT = 24;
const CHARS_PER_LINE = 46;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function textLines(blocks: MessageBlock[] | undefined): number {
  if (!blocks) return 0;
  let chars = 0;
  for (const b of blocks) {
    if (b.type === "text" && typeof b.text === "string") chars += b.text.length;
  }
  return Math.ceil(chars / CHARS_PER_LINE);
}

export function estimateMessageHeight(message: ChatMessage): number {
  if (message.role === "user") {
    const lines = textLines(message.blocks);
    return clamp(44 + lines * LINE_HEIGHT, 44, 800);
  }
  // 头像行 + 回复卡片内边距
  let h = 72;
  // ExecutionTimeline 折叠态头部（结束态默认折叠）
  h += 34;
  // 流式中活跃思考段：200px 内容 + 头部 + 边距
  if (message.streaming) h += 226;
  // 最终回复 Markdown
  h += textLines(message.finalBlocks) * LINE_HEIGHT;
  // artifact chips 行
  if ((message.artifactIds?.length ?? 0) > 0) h += 44;
  // 未流式时的操作 footer
  if (!message.streaming) h += 34;
  return clamp(h, 90, 6000);
}
