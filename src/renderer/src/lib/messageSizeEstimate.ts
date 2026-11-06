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
/** 单张内联图片的预估占位高度（P1）：含 12px×2 margin，与 ChatImage 骨架同量级 */
const INLINE_IMAGE_ESTIMATED_HEIGHT = 240;
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g;
const HTML_IMAGE_RE = /<img\b[^>]*>/gi;

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

/**
 * 数正文里的 markdown / HTML 图片引用（P1）。
 * 图片语法本身只有几十个字符，纯文本行数估算会严重低估一条 38 图的消息，
 * 首测 delta 会把整条虚拟列表往下推。按每张固定高度累加，不受文本 clamp 截断。
 */
function inlineImages(blocks: MessageBlock[] | undefined): number {
  if (!blocks) return 0;
  let count = 0;
  for (const b of blocks) {
    if (b.type !== "text" || typeof b.text !== "string") continue;
    count += (b.text.match(MARKDOWN_IMAGE_RE) ?? []).length;
    count += (b.text.match(HTML_IMAGE_RE) ?? []).length;
  }
  return count;
}

export function estimateMessageHeight(message: ChatMessage): number {
  if (message.role === "user") {
    const lines = textLines(message.blocks);
    const images = inlineImages(message.blocks);
    return clamp(44 + lines * LINE_HEIGHT, 44, 800) + images * INLINE_IMAGE_ESTIMATED_HEIGHT;
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
  // 图片高度不进文本 clamp：38 张图的消息不能被 6000px 上限截断
  const images = inlineImages(message.finalBlocks);
  return clamp(h, 90, 6000) + images * INLINE_IMAGE_ESTIMATED_HEIGHT;
}
