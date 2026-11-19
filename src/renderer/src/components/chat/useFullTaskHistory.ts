import { useCallback, useLayoutEffect, useState } from "react";
import { useAppStore } from "@/store/appStore";
import type { ChatMessage, Task } from "@/types";
import { mergeFullTaskHistory, readFullTaskHistory } from "@/lib/fullTaskHistory";

const EMPTY: ChatMessage[] = [];
const identity = (task: Task | null | undefined): string => JSON.stringify([
  task?.id, task?.durable?.historyId,
]);

/** Desktop active-chat display only. The agent's bounded live projection is untouched. */
export function useFullTaskHistory(task: Task | null | undefined): {
  messages: ChatMessage[]; loading: boolean; error: string | undefined; retry: () => void;
} {
  const key = identity(task);
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<{
    taskId: string; messages: ChatMessage[]; loading: boolean; error?: string;
  }>();
  const retry = useCallback(() => setAttempt(value => value + 1), []);

  useLayoutEffect(() => {
    const initial = useAppStore.getState().tasks.find(candidate => candidate.id === task?.id);
    if (!initial?.durable || identity(initial) !== key) return;
    let cancelled = false;
    let archive = initial.messages;
    let readGeneration = 0;
    let loading = false;
    let loadError: string | undefined;
    const isCurrent = (): boolean => {
      const state = useAppStore.getState();
      return !cancelled && state.activeTaskId === initial.id
        && identity(state.tasks.find(candidate => candidate.id === initial.id)) === key;
    };
    const publish = (): void => {
      if (loading) {
        // Keep the mounted timeline while this same task rebuilds its archive.
        setView(previous => previous?.taskId === initial.id ? previous
          : { taskId: initial.id, messages: EMPTY, loading: true });
      } else {
        setView({ taskId: initial.id, messages: archive, loading: false, error: loadError });
      }
    };
    const loadArchive = (windowTask: Task): void => {
      const durable = windowTask.durable;
      if (!durable) return;
      const generation = ++readGeneration;
      const ownsRead = () => generation === readGeneration && isCurrent();
      archive = windowTask.messages;
      loading = durable.historyBefore !== undefined;
      loadError = undefined;
      publish();
      if (!loading) return;
      void readFullTaskHistory({
        before: durable.historyBefore,
        historyId: durable.historyId,
        load: before => {
          if (!window.api) throw new Error("桌面对话历史接口不可用");
          return window.api.agent.loadTaskHistory(initial.id, before);
        },
        isCurrent: ownsRead,
      }).then(older => {
        if (!older || !ownsRead()) return;
        archive = mergeFullTaskHistory(older, archive);
        loading = false;
        publish();
      }).catch((error: unknown) => {
        if (!ownsRead()) return;
        loading = false;
        loadError = error instanceof Error ? error.message : String(error);
        setView(previous => ({ taskId: initial.id, loading, error: loadError,
          messages: previous?.taskId === initial.id && previous.messages.length ? previous.messages : archive }));
      });
    };
    loadArchive(initial);
    // A reconnect can skip an entire bounded window. Fill that hole from disk
    // before publishing the new tail. Ordinary evictions need no disk read.
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (!isCurrent()) return;
      const current = state.tasks.find(candidate => candidate.id === initial.id);
      const prior = previous.tasks.find(candidate => candidate.id === initial.id);
      if (!current || current.messages === prior?.messages) return;
      const cursor = current.durable?.historyBefore;
      if (cursor !== undefined && cursor !== prior?.durable?.historyBefore
        && !prior?.messages.some(row => Number(row.entryId) >= cursor)) {
        loadArchive(current);
        return;
      }
      archive = mergeFullTaskHistory(archive, current.messages);
      if (!loading && !loadError) publish();
    });
    return () => { cancelled = true; unsubscribe(); };
    // A moving live historyBefore cursor must NOT restart or clear the archive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);

  if (!task?.durable) return { messages: task?.messages ?? EMPTY, loading: false, error: undefined, retry };
  if (view?.taskId !== task.id) return { messages: EMPTY, loading: true, error: undefined, retry };
  return { messages: view.messages, loading: view.loading, error: view.error, retry };
}
