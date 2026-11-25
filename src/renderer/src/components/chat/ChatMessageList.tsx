import { memo, useCallback, useEffect, useLayoutEffect, useState, type RefObject } from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { DOTS_TASK_ID, isDotsAutomaticInput, type DotsDelegation, type DotsLiveReport, type DotsTaskDelivery } from "@shared/dots";
import type { ConversationGoalDto } from "@shared/conversation-goal";
import type { Artifact, ChatMessage } from "@/types";
import { useAppStore } from "@/store/appStore";
import { isQuietDotsReply } from "@/lib/botMessagePresentation";
import { estimateMessageHeight } from "@/lib/messageSizeEstimate";
import ChatMarkdown from "./ChatMarkdown";
import { DotsDeliveryFiles, DotsResult } from "./DotsResult";
import MessageItem from "./MessageItem";

function DotsProgressHistory({ entries }: { entries: readonly ChatMessage[] }) {
  const [open, setOpen] = useState(false);
  return <details className="dots-progress-history" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>阶段进展 · {entries.length} 条</summary>
    {open && entries.map(({ dotsDelivery: delivery }) => delivery && <div key={delivery.deliveryKey} className="dots-progress-history-item">
      <strong>{delivery.title}</strong>
      {delivery.text && <ChatMarkdown text={delivery.text} streaming={false} resolveTaskFiles={false} />}
      {delivery.artifacts.length > 0 && <DotsDeliveryFiles row={delivery} />}
    </div>)}
  </details>;
}

function DotsStreamingReport({ messages }: { messages: readonly ChatMessage[] }) {
  const conversationId = useAppStore(state => state.tasks.find(task => task.id === DOTS_TASK_ID)?.durable?.conversationId);
  const [draft, setDraft] = useState<DotsLiveReport | null>(null);
  useEffect(() => {
    const api = window.api?.dots;
    if (!api?.onReport) return;
    let received = false;
    let mounted = true;
    const remove = api.onReport(report => { received = true; setDraft(report); });
    void api.report().then(report => { if (mounted && !received) setDraft(report); }).catch(() => {});
    return () => { mounted = false; remove(); };
  }, []);
  if (!draft || (draft.origin && String(draft.origin.conversationId) !== conversationId)
    || messages.some(message => message.dotsDelivery?.deliveryKey === draft.deliveryKey)) return null;
  const message: ChatMessage = {
    id: draft.deliveryKey, role: "assistant", createdAt: 0, blocks: [], streaming: true,
    finalBlocks: [{ type: "text", text: draft.text }],
    dotsDelivery: { ...draft, presentation: "report", artifacts: [] },
  };
  return <div data-dots-live-report={draft.operationId}>
    <MessageItem message={message} taskId={DOTS_TASK_ID} />
  </div>;
}

type MessageRow = {
  key: string;
  message: ChatMessage;
  progress?: ChatMessage[];
  sourceQuestion?: ChatMessage;
  deliveryQuestion?: ChatMessage;
  deliveryKey?: string;
  delegations?: DotsDelegation[];
  hideMessage?: boolean;
};

/** Group before taking the window so an offscreen question can still own a visible reply. */
export function buildChatMessageRows(taskId: string | undefined, messages: readonly ChatMessage[],
  delegations: DotsDelegation[], taskDelivery?: DotsTaskDelivery): MessageRow[] {
  const grouped = new Map<string, typeof delegations>();
  if (delegations.length) {
    const anchors = new Map<string, string>();
    let question: ChatMessage | undefined;
    const delivered = new Set<string>();
    for (const msg of messages) {
      if (msg.dotsDelivery?.kind === "progress") continue;
      if (msg.dotsDelivery) delivered.add(msg.dotsDelivery.operationId);
      if (msg.role === "user") question = msg;
      else if (question && !msg.dotsDelivery) {
        anchors.set(question.id, msg.id);
        if (question.inputRequestId) anchors.set(question.inputRequestId, msg.id);
      }
      anchors.set(msg.id, msg.id);
      if (msg.inputRequestId) anchors.set(msg.inputRequestId, msg.id);
      for (const id of msg.sourceMessageIds ?? []) anchors.set(id, msg.id);
    }
    for (const entry of delegations) {
      if (entry.status === "pending" || entry.status === "running" || entry.status === "superseded") continue;
      if (delivered.has(entry.id)) continue;
      const key = anchors.get(entry.sourceMessageId);
      if (key) grouped.set(key, [...grouped.get(key) ?? [], entry]);
    }
  }
  const progressBySource = new Map<string, ChatMessage[]>();
  const dotsQuestions = new Map<string, ChatMessage>();
  if (taskId === DOTS_TASK_ID) for (const message of messages) {
    if (message.role === "user") {
      dotsQuestions.set(message.id, message);
      if (message.inputRequestId) dotsQuestions.set(message.inputRequestId, message);
    }
    const delivery = message.dotsDelivery;
    if (delivery?.kind !== "progress" || delivery.presentation === "report") continue;
    const entries = progressBySource.get(delivery.sourceMessageId) ?? [];
    entries.push(message);
    progressBySource.set(delivery.sourceMessageId, entries);
  }
  const rows: MessageRow[] = [];
  let precedingUser: ChatMessage | undefined;
  for (const message of messages) {
    const delivery = taskId === DOTS_TASK_ID ? message.dotsDelivery : undefined;
    if (delivery?.kind === "progress" && delivery.presentation !== "report") {
      const progress = progressBySource.get(delivery.sourceMessageId);
      if (progress?.at(-1) === message) rows.push({ key: `dots-progress:${delivery.sourceMessageId}`, message, progress });
      continue;
    }
    if (message.role === "user") precedingUser = message;
    const automatic = taskId === DOTS_TASK_ID && isDotsAutomaticInput(precedingUser?.inputRequestId ?? "");
    const hideMessage = !message.dotsDelivery && ((automatic && message.role === "user") || isQuietDotsReply(message, automatic));
    const deliveries = grouped.get(message.id);
    if (hideMessage && !deliveries) continue;
    rows.push({
      key: message.presentationKey ?? message.id,
      message,
      hideMessage,
      sourceQuestion: !automatic && !delivery && !message.dotsProactive && message.role === "assistant" ? precedingUser : undefined,
      deliveryQuestion: delivery?.kind === "conclusion" ? dotsQuestions.get(delivery.sourceMessageId) : undefined,
      deliveryKey: taskDelivery && message.role === "assistant" && !message.streaming
        && precedingUser?.inputRequestId === taskDelivery.operationId ? taskDelivery.deliveryKey : undefined,
      delegations: deliveries,
    });
  }
  return rows;
}

export const ChatMessageList = memo(function ChatMessageList({ listRef, scrollRef, rows, taskId, messages,
  mountedTargets, writeScrollTop, artifacts, visibleArtifacts, onGoalCreated, toolFocusMessageId }: {
  listRef: RefObject<HTMLDivElement | null>;
  scrollRef: RefObject<HTMLDivElement | null>;
  rows: readonly MessageRow[];
  taskId: string;
  messages: readonly ChatMessage[];
  mountedTargets: readonly (string | undefined)[];
  writeScrollTop: (top: number) => void;
  artifacts: Artifact[];
  visibleArtifacts: Artifact[];
  onGoalCreated: (goal: ConversationGoalDto) => void;
  toolFocusMessageId?: string;
}) {
  const [layout, setLayout] = useState({ margin: 0, gap: 18 });
  useLayoutEffect(() => {
    const list = listRef.current;
    const scroller = scrollRef.current;
    if (!list || !scroller) return;
    const measure = () => {
      const style = getComputedStyle(list);
      const gap = Number.parseFloat(style.rowGap) || 0;
      const margin = list.getBoundingClientRect().top - scroller.getBoundingClientRect().top
        - scroller.clientTop + scroller.scrollTop + (Number.parseFloat(style.paddingTop) || 0);
      setLayout(previous => previous.margin === margin && previous.gap === gap ? previous : { margin, gap });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    observer.observe(list);
    return () => observer.disconnect();
  }, [listRef, scrollRef]);

  const getItemKey = useCallback((index: number) => rows[index].key, [rows]);
  const estimateSize = useCallback((index: number) => rows[index].progress ? 44 : estimateMessageHeight(rows[index].message), [rows]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    getItemKey,
    estimateSize,
    initialRect: { width: 800, height: 640 },
    initialOffset: () => Number.MAX_SAFE_INTEGER,
    overscan: 3,
    gap: layout.gap,
    scrollMargin: layout.margin,
    anchorTo: "end",
    // Prepend keeps a row anchor. ChatView owns scrolling to the latest row, including its tail spacer.
    scrollEndThreshold: -1,
    useAnimationFrameWithResizeObserver: true,
    scrollToFn: (offset, { adjustments = 0 }) => writeScrollTop(offset + adjustments),
    rangeExtractor: range => {
      const indexes = defaultRangeExtractor(range);
      for (const id of mountedTargets) {
        if (!id) continue;
        const index = rows.findIndex(row => row.message.id === id);
        if (index >= 0 && !indexes.includes(index)) indexes.push(index);
      }
      return indexes.sort((a, b) => a - b);
    },
  });

  return (
    <div className="message-list" ref={listRef}>
      <div className="chat-virtual-rows" role="list" style={{ position: "relative", height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map(item => {
          const row = rows[item.index];
          const message = row.message;
          const delivery = taskId === DOTS_TASK_ID ? message.dotsDelivery : undefined;
          return (
            <div key={item.key} id={`msg-${message.id}`} data-index={item.index} ref={virtualizer.measureElement}
              role="listitem" aria-posinset={item.index + 1} aria-setsize={rows.length}
              style={{ position: "absolute", top: item.start - layout.margin, width: "100%" }}>
              {row.progress ? <DotsProgressHistory entries={row.progress} /> : <>
                {!row.hideMessage && <MessageItem message={message} taskId={taskId} sourceQuestion={row.sourceQuestion}
                  dotsDeliveryKey={row.deliveryKey} deliveryQuestion={row.deliveryQuestion}
                  deliveryFiles={delivery && delivery.artifacts.length > 0 ? <DotsDeliveryFiles row={delivery} /> : undefined}
                  artifacts={artifacts} visibleArtifacts={visibleArtifacts}
                  onGoalCreated={onGoalCreated} focusTool={toolFocusMessageId === message.id} />}
                {row.delegations?.map(entry => <DotsResult key={entry.id} row={entry} />)}
              </>}
            </div>
          );
        })}
      </div>
      {taskId === DOTS_TASK_ID && <DotsStreamingReport messages={messages} />}
    </div>
  );
});
