import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useAppStore } from "@/store/appStore";
import type { ChatMessage, Task } from "@/types";
import { mergeFullTaskHistory, readFullTaskHistory, readTaskHistoryPage } from "@/lib/fullTaskHistory";

const EMPTY: ChatMessage[] = [];
const identity = (task: Task | null | undefined): string => JSON.stringify([task?.id, task?.durable?.historyId]);
type HistoryMatch = (message: ChatMessage) => boolean;

type HistoryView = {
  key: string;
  messages: ChatMessage[];
  before: number | undefined;
  error?: string;
};

/** Older pages belong to the reader. Live snapshots never replace that archive. */
export function useChatHistory(task: Task | null | undefined) {
  const key = identity(task);
  const [view, setView] = useState<HistoryView>();
  const read = useRef<(match?: HistoryMatch) => Promise<boolean>>(null);
  const retryGap = useRef<() => void>(null);
  const loadEarlier = useCallback((match?: HistoryMatch) => read.current?.(match) ?? Promise.resolve(false), []);
  const retry = useCallback(() => retryGap.current?.(), []);

  useLayoutEffect(() => {
    const currentTask = () => useAppStore.getState().tasks.find(candidate => candidate.id === task?.id);
    const initial = currentTask();
    if (!initial?.durable || identity(initial) !== key) return;
    const historyId = initial.durable.historyId;
    let messages = initial.messages;
    let before = initial.durable.historyBefore;
    let closed = false;
    let pending: Promise<boolean> | undefined;
    let live = initial;
    let recoverTo: number | undefined;
    let recovery: Promise<void> | undefined;
    let error: string | undefined;
    const isCurrent = () => !closed && useAppStore.getState().activeTaskId === initial.id && identity(currentTask()) === key;
    const publish = () => setView({ key, messages, before, error });
    const load = (cursor: number) => {
      const agent = window.api?.agent;
      if (!agent) throw new Error("桌面对话历史接口不可用");
      return agent.loadTaskHistory(initial.id, cursor);
    };

    const recoverGap = () => {
      if (recovery || recoverTo === undefined || !isCurrent()) return;
      const target = recoverTo;
      const lastKnown = messages.reduce((newest, row) => Math.max(newest, Number(row.entryId) || 0), 0);
      recovery = readFullTaskHistory({ before: target, historyId, load, isCurrent,
        stop: cursor => cursor <= lastKnown,
      }).then(gap => {
        if (!gap || !isCurrent() || recoverTo !== target) return;
        const missing = gap.filter(row => Number(row.entryId) > lastKnown);
        messages = mergeFullTaskHistory([...messages, ...missing], live.messages);
        recoverTo = undefined;
        error = undefined;
        publish();
      }).catch((cause: unknown) => {
        if (!isCurrent()) return;
        error = cause instanceof Error ? cause.message : String(cause);
        publish();
      }).finally(() => {
        recovery = undefined;
        if (recoverTo !== target) recoverGap();
      });
    };
    retryGap.current = recoverGap;
    const requestEarlier = async (match?: HistoryMatch): Promise<boolean> => {
      if (!isCurrent()) return false;
      if (match && messages.some(match)) return true;
      if (pending) {
        const loaded = await pending;
        return match && loaded && isCurrent() ? requestEarlier(match) : loaded && isCurrent();
      }
      if (before === undefined) return false;
      pending = (async () => {
        const pages: ChatMessage[][] = [];
        let cursor: number | undefined = before;
        let found = false;
        try {
          while (cursor !== undefined && isCurrent()) {
            const page = await readTaskHistoryPage(cursor, historyId, load, isCurrent);
            if (!page) return false;
            cursor = page.before;
            pages.push(page.messages);
            found = match ? page.messages.some(match) : page.messages.length > 0;
            if (found) break;
          }
          if (!isCurrent()) return false;
          before = cursor;
          messages = mergeFullTaskHistory(pages.reverse().flat(), messages);
          publish();
          return found;
        } catch (cause) {
          if (isCurrent()) console.warn("[ChatView] 加载更早消息失败", cause);
          return false;
        }
      })().finally(() => { pending = undefined; });
      return pending;
    };

    read.current = requestEarlier;
    publish();
    const unsubscribe = useAppStore.subscribe(() => {
      if (!isCurrent()) return;
      const next = currentTask();
      if (!next || next.messages === live.messages) return;
      const cursor = next.durable?.historyBefore;
      if (cursor !== undefined && cursor !== live.durable?.historyBefore
        && !live.messages.some(row => Number(row.entryId) >= cursor)) recoverTo = cursor;
      live = next;
      if (recoverTo !== undefined) {
        recoverGap();
        return;
      }
      messages = mergeFullTaskHistory(messages, live.messages);
      publish();
    });
    return () => {
      closed = true;
      read.current = null;
      retryGap.current = null;
      unsubscribe();
    };
  }, [key]);

  if (!task?.durable) return { messages: task?.messages ?? EMPTY, loading: false, before: undefined, error: undefined, retry, loadEarlier };
  if (view?.key !== key) return { messages: EMPTY, loading: true, before: undefined, error: undefined, retry, loadEarlier };
  return { ...view, loading: false, retry, loadEarlier };
}
