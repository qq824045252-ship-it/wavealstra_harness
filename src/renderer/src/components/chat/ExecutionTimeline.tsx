import { nativeRunPhaseLabel } from "../../../../shared/generation-stats";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatMessage, MessageBlock } from "@/types";
import MessageBlockView from "./MessageBlockView";
import WebSearchCard from "./WebSearchCard";
import { IconChevronRight } from "@/components/common/icons";
import {
  computeFocusView,
  findActiveThinkingGroupIndex,
  shouldRenderGroup,
  type TimelineGroup,
} from "./timelineFocus";

/**
 * Thinking 文本规范化：推理草稿只按自然宽度换行，不保留上游硬换行。
 *
 * 部分 OpenAI-compatible provider 会把 reasoning token 拼成 `\n\n token`；
 * 这与正常 Markdown 段落无法可靠区分。思考区本来就是纯文本预览，因此统一折叠
 * 所有空白，避免单换行、双换行、跨 block 及混合 CRLF 再次造成逐词竖排。
 */
function normalizeThinkingText(text: string): string {
  if (!text) return text;
  return text.replace(/\s+/gu, " ").trim();
}

interface Props {
  message: ChatMessage;
}

/**
 * 思考区内部滚动：仅「当前活跃段」贴底。
 * max-height 固定，避免整页消息区被顶着往下刷。
 */
function useReasoningScroll(active: boolean): {
  containerRef: React.RefObject<HTMLDivElement | null>;
  onScroll: (e: React.UIEvent<HTMLDivElement>) => void;
  scrollToBottom: () => void;
} {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const autoScrollRef = useRef({ autoScroll: true, trust: false });
  const lastScrollTopRef = useRef(0);

  // 段重新激活时重置贴底策略（第二段思考要有自己的滚动条状态）
  useLayoutEffect(() => {
    if (!active) return;
    autoScrollRef.current = { autoScroll: true, trust: false };
    lastScrollTopRef.current = 0;
  }, [active]);

  const scrollToBottom = useCallback((): void => {
    const el = containerRef.current;
    if (!el || !autoScrollRef.current.autoScroll) return;
    autoScrollRef.current.trust = true;
    el.scrollTop = el.scrollHeight;
  }, []);

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>): void => {
    const target = e.currentTarget;
    const currentScrollTop = target.scrollTop;
    const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
    if (!autoScrollRef.current.trust) {
      autoScrollRef.current.trust = true;
      return;
    }
    const isScrollingUp = currentScrollTop < lastScrollTopRef.current;
    if (!isScrollingUp && Math.abs(distanceFromBottom) < 10) {
      autoScrollRef.current.autoScroll = true;
    } else if (isScrollingUp && distanceFromBottom > 20) {
      autoScrollRef.current.autoScroll = false;
    }
    lastScrollTopRef.current = currentScrollTop;
  }, []);

  useLayoutEffect(() => {
    if (!active) return;
    scrollToBottom();
  }, [active, scrollToBottom]);

  return { containerRef, onScroll, scrollToBottom };
}

/**
 * 单段深度思考。
 * - active：当前活跃段（工具打断后仍保持展开，直到下一段新思考开始或最终回复开始才收起）
 * - messageStreaming：整条助手消息是否仍在生成
 */
function ThinkingSection({
  blocks,
  messageId,
  active,
  messageStreaming,
}: {
  blocks: MessageBlock[];
  messageId: string;
  active: boolean;
  messageStreaming: boolean;
}): React.JSX.Element {
  // 仅活跃段默认展开；被打断 / 进入最终回复 / 整轮结束 → 收起
  const [collapsed, setCollapsed] = useState(!active);
  const live = active && messageStreaming;
  const { containerRef, onScroll, scrollToBottom } = useReasoningScroll(live && !collapsed);
  // Provider/工具边界可能把同一段活跃思考拆成多个 thinking/text block。
  // 流式态必须合并成滚动容器里的单一直接文本节点：若逐 block 渲染为 div，
  // 很短的增量会各占一行，视觉上就会退化成逐字/逐词竖排。
  const liveText = blocks.reduce((text, block) => {
    if (block.type === "thinking" || block.type === "text") return text + block.text;
    return text;
  }, "");

  useLayoutEffect(() => {
    if (active && messageStreaming) {
      // 当前段正在写入 → 展开
      setCollapsed(false);
    } else {
      // 非活跃（被新思考段取代 / 最终回复已开始 / 整轮结束）→ 收起
      setCollapsed(true);
    }
  }, [active, messageStreaming]);

  // 仅活跃段在内容增量时贴底
  useLayoutEffect(() => {
    if (live && !collapsed) scrollToBottom();
  }, [blocks, live, collapsed, scrollToBottom]);

  return (
    <section
      className={`assistant-reasoning ${collapsed ? "collapse" : ""} ${
        live ? "streaming" : "complete"
      }`}
    >
      <header
        className={`assistant-reasoning-header ${live ? "loading" : ""}`}
        onClick={() => setCollapsed((v) => !v)}
      >
        <span>Thinking</span>
        {!live && (
          <span className="assistant-reasoning-icon">
            <IconChevronRight size={12} />
          </span>
        )}
      </header>
      {!collapsed && (
        <div
          className="assistant-reasoning-content"
          ref={containerRef}
          onScroll={onScroll}
          onWheel={(e) => {
            const el = e.currentTarget;
            if (el.scrollHeight > el.clientHeight) e.stopPropagation();
          }}
        >
          {/* 无论是流式态还是定稿态、单 block 还是多 block，一律合并为单一直接
              文本节点并规范化 token 级换行。逐 block 渲染为独立 div 会在多 block
              场景下退化为竖排，长对话中最常见。 */}
          <div className="timeline-text">{normalizeThinkingText(liveText)}</div>
        </div>
      )}
    </section>
  );
}

/** 连续 thinking/过程 text 合成一段；工具等打断后开启下一段 */
function groupTimelineBlocks(blocks: MessageBlock[]): TimelineGroup[] {
  const groups: TimelineGroup[] = [];
  let thinkingBuf: MessageBlock[] = [];
  let thinkingSeq = 0;

  const flushThinking = (): void => {
    if (thinkingBuf.length === 0) return;
    // 用段序号做稳定 key，避免工具插入后整表 remount 丢折叠态
    groups.push({ kind: "thinking", blocks: thinkingBuf, key: `thinking-seg-${thinkingSeq}` });
    thinkingSeq += 1;
    thinkingBuf = [];
  };

  blocks.forEach((block, index) => {
    if (block.type === "thinking" || block.type === "text") {
      thinkingBuf.push(block);
      return;
    }
    flushThinking();
    groups.push({ kind: "other", block, index, key: `other-${index}-${block.type}` });
  });
  flushThinking();
  return groups;
}

function messageHasFinalOutput(message: ChatMessage): boolean {
  const finals = message.finalBlocks ?? [];
  for (const b of finals) {
    if (b.type === "text" && b.text.trim().length > 0) return true;
    if (b.type === "thinking" && b.text.trim().length > 0) return true;
    if (b.type !== "text" && b.type !== "thinking") return true;
  }
  return false;
}

/** 执行过程时间线：默认折叠为「已完成 xx」；展开可见多段思考与工具。
 *  流式期间启用「聚焦最新」：只显示最新活跃思考 + 当前运行工具，旧内容退入
 *  可展开历史摘要（historyOpen）；assistant_end 后沿用整体折叠。 */
function ExecutionTimeline({ message }: Props): React.JSX.Element | null {
  const hasPendingApproval = message.blocks.some(
    (b) => b.type === "tool" && b.toolCall.status === "pending_approval",
  );
  const [open, setOpen] = useState(Boolean(message.streaming) || hasPendingApproval);
  const wasStreamingRef = useRef(Boolean(message.streaming));
  const [bodyMounted, setBodyMounted] = useState(Boolean(message.streaming) || hasPendingApproval);
  // 流式中用户展开历史后，本轮流式期间保持展开，允许再次收起；结束后重置
  const [historyOpen, setHistoryOpen] = useState(false);
  // assistant_end 首帧同步收起，避免先解析长 Markdown 再折叠造成卡顿
  const visibleOpen =
    !message.streaming && wasStreamingRef.current && !hasPendingApproval ? false : open;

  useEffect(() => {
    const streaming = Boolean(message.streaming);
    if (!wasStreamingRef.current && streaming) setOpen(true);
    if (wasStreamingRef.current && !streaming && !hasPendingApproval) setOpen(false);
    if (hasPendingApproval) setOpen(true);
    if (wasStreamingRef.current && !streaming) setHistoryOpen(false);
    wasStreamingRef.current = streaming;
  }, [message.streaming, hasPendingApproval]);

  // Keep the body mounted just long enough for the close animation, then remove
  // its potentially large Markdown/tool subtree while the timeline is collapsed.
  useEffect(() => {
    if (visibleOpen) {
      setBodyMounted(true);
      return;
    }
    if (!bodyMounted) return;
    const timer = window.setTimeout(() => setBodyMounted(false), 180);
    return () => window.clearTimeout(timer);
  }, [visibleOpen, bodyMounted]);

  const hasFinalOutput = messageHasFinalOutput(message);
  const completionLabel = message.generationStats?.outcome === "aborted" ? "已停止"
    : message.generationStats?.outcome === "error" ? "执行失败" : "已完成";

  if (message.streaming && message.pendingBehavior) {
    return (
      <div className="execution-timeline timeline-preparing" role="status" aria-live="polite">
        <div className="timeline-header timeline-header-static">
          <span>{message.pendingBehavior === "followUp" ? "已排队，等待当前执行结束" : "引导已提交，等待当前步骤结束"}</span>
        </div>
      </div>
    );
  }

  // The renderer creates a streaming assistant shell before AgentService has
  // finished first-turn setup. Render a stable status immediately instead of a
  // blank assistant card that looks as if the send was missed.
  if (message.blocks.length === 0) {
    if (message.generationStats) {
      return <div className="execution-timeline timeline-preparing" role="status" aria-live="polite">
        <div className="timeline-header timeline-header-static">
          {message.streaming && <span className="streaming-dot" />}
          <span>{message.streaming ? nativeRunPhaseLabel(message.generationStats.phase, [], hasFinalOutput)
            : `${completionLabel}${message.durationLabel ? ` ${message.durationLabel}` : ""}`}</span>
        </div>
      </div>;
    }
    // 正文一出现，准备态立即退出；没有过程块时正文自身就是唯一进度反馈。
    if (!message.streaming || hasFinalOutput) return null;
    return (
      <div
        className="execution-timeline timeline-preparing"
        role="status"
        aria-live="polite"
        aria-label="正在准备回复"
      >
        <div className="timeline-header timeline-header-static">
          <span className="streaming-dot" />
          <span>正在准备回复…</span>
        </div>
      </div>
    );
  }

  const thinkingLive =
    Boolean(message.streaming) && !hasPendingApproval && !hasFinalOutput;
  const running = Boolean(message.streaming) && !hasPendingApproval;
  const activeToolNames = message.blocks.flatMap((block) => block.type === "tool" && block.toolCall.status === "running" ? [block.toolCall.tool] : []);
  const runningLabel = nativeRunPhaseLabel(message.generationStats?.phase, activeToolNames, hasFinalOutput);
  const isResultCard = (block: MessageBlock): boolean => block.type === "tool" && (block.toolCall.tool === "multi_model_consult" || Boolean(block.toolCall.webSearch));
  const resultBlocks = message.blocks.filter(isResultCard);
  const searchCalls = resultBlocks.flatMap(block => block.type === "tool" && block.toolCall.webSearch ? [block.toolCall] : []);
  const groups = groupTimelineBlocks(message.blocks.filter(block => !isResultCard(block)));
  const activeThinkingIdx = findActiveThinkingGroupIndex(
    groups,
    Boolean(message.streaming),
    hasFinalOutput,
  );
  // 聚焦最新：流式且用户未展开历史时，过滤旧思考段与已完成工具
  const focusActive = Boolean(message.streaming) && !historyOpen;
  const focus = computeFocusView(groups, activeThinkingIdx, Boolean(message.streaming));
  const hasHidden = focus.hiddenThinking > 0 || focus.hiddenTools > 0;

  return (
    <>
    <div className="execution-timeline">
      <button type="button" className="timeline-header" onClick={() => setOpen(!open)}>
        {running && <span className="streaming-dot" />}
        <span>
          {running
            ? runningLabel
            : hasPendingApproval
              ? "等待授权"
              : `${completionLabel}${message.durationLabel ? ` ${message.durationLabel}` : ""}`}
        </span>
        <span className={`chev ${visibleOpen ? "open" : ""}`}>
          <IconChevronRight size={12} />
        </span>
      </button>

      {(visibleOpen || bodyMounted) && (
        <div
          className={`timeline-body-shell${visibleOpen ? " is-open" : " is-closed"}`}
          aria-hidden={!visibleOpen}
        >
          <div className="timeline-body-clip">
            <div className="timeline-body">
              {Boolean(message.streaming) && hasHidden && (
                <button
                  type="button"
                  className={`history-toggle${historyOpen ? " open" : ""}`}
                  onClick={() => setHistoryOpen((v) => !v)}
                >
                  <span className="chev">
                    <IconChevronRight size={12} />
                  </span>
                  {historyOpen
                    ? "收起过程"
                    : `查看过程 · ${focus.hiddenThinking} 段思考 · ${focus.hiddenTools} 个工具`}
                </button>
              )}
              {groups.map((group, i) => {
                if (focusActive && !shouldRenderGroup(group, i, focusActive, focus.liveIdx)) {
                  return null;
                }
                if (group.kind === "thinking") {
                  // 聚焦视图下末段过程文本（无 thinking 块）也算活跃段，避免空窗
                  const isFocusLive = focusActive && i === focus.liveIdx;
                  return (
                    <ThinkingSection
                      key={group.key}
                      blocks={group.blocks}
                      messageId={message.id}
                      active={i === activeThinkingIdx || isFocusLive}
                      messageStreaming={Boolean(message.streaming)}
                    />
                  );
                }
                return (
                  <MessageBlockView
                    key={group.key}
                    block={group.block}
                    index={group.index}
                    messageId={message.id}
                    streaming={message.streaming}
                  />
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
    {/* One stable search card per reply, including rounds separated by other tools or reasoning. */}
    {resultBlocks.map((block, index) => {
      if (block.type === "tool" && block.toolCall.webSearch) {
        return block.toolCall.id === searchCalls[0]?.id
          ? <WebSearchCard key={block.toolCall.id} toolCall={block.toolCall} toolCalls={searchCalls} /> : null;
      }
      return <MessageBlockView key={block.type === "tool" ? block.toolCall.id : index} block={block} index={index} messageId={message.id} streaming={message.streaming} />;
    })}
    </>
  );
}

export default memo(ExecutionTimeline);
