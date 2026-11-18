import { useCallback, useLayoutEffect, useState } from "react";
import { useAppStore } from "@/store/appStore";
import type { ChatMessage, Task } from "@/types";
import { mergeFullTaskHistory, readFullTaskHistory } from "@/lib/fullTaskHistory";

const EMPTY: ChatMessage[] = [];
const identity = (task: Task | null | undefined): string => JSON.stringify([
  task?.id, task?.durable?.epoch, task?.durable?.historyId,
]);

/** Desktop active-chat display only. The agent's bounded live projection is untouched. */
export function useFullTaskHistory(task: Task | null | undefined): {
  messages: ChatMessage[]; loading: boolean; error: string | undefined; retry: () => void;
} {
  const key = identity(task);
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<{
    key: string; messages: ChatMessage[]; loading: boolean; error?: string;
  }>();
  const retry = useCallback(() => setAttempt(value => value + 1), []);

  useLayoutEffect(() => {
    const initial = useAppStore.getState().tasks.find(candidate => candidate.id === task?.id);
    if (!initial?.durable || identity(initial) !== key) return;
    let cancelled = false;
    let archive = initial.messages;
    let loading = initial.durable.historyBefore !== undefined;
    let loadError: string | undefined;
    const isCurrent = (): boolean => {
      const state = useAppStore.getState();
      return !cancelled && state.activeTaskId === initial.id
        && identity(state.tasks.find(candidate => candidate.id === initial.id)) === key;
    };
    const publish = (): void => setView({ key, messages: archive, loading, error: loadError });
    publish();
    // Observe every store update, including multiple snapshots in one React batch:
    // a live-window eviction must not remove an already displayed history row.
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (!isCurrent()) return;
      const current = state.tasks.find(candidate => candidate.id === initial.id);
      const prior = previous.tasks.find(candidate => candidate.id === initial.id);
      if (!current || current.messages === prior?.messages) return;
      archive = mergeFullTaskHistory(archive, current.messages);
      publish();
    });
    if (loading) {
      void readFullTaskHistory({
        before: initial.durable.historyBefore,
        historyId: initial.durable.historyId,
        load: async before => {
          if (!window.api) throw new Error("桌面对话历史接口不可用");
          return window.api.agent.loadTaskHistory(initial.id, before);
        },
        isCurrent,
      }).then(older => {
        if (!older || !isCurrent()) return;
        archive = mergeFullTaskHistory(older, archive);
        loading = false;
        publish();
      }).catch((error: unknown) => {
        if (!isCurrent()) return;
        loading = false;
        loadError = error instanceof Error ? error.message : String(error);
        publish();
      });
    }
    return () => { cancelled = true; unsubscribe(); };
    // A moving live historyBefore cursor must NOT restart or clear the archive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);

  if (!task?.durable) return { messages: task?.messages ?? EMPTY, loading: false, error: undefined, retry };
  if (view?.key !== key) return { messages: EMPTY, loading: true, error: undefined, retry };
  return { messages: view.loading ? EMPTY : view.messages, loading: view.loading, error: view.error, retry };
}
