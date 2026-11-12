import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskUserQuestionsDto } from "@shared/agent-ipc";

export function useHistoryQuestions(taskId: string | undefined, historyId: string | undefined) {
  const [page, setPage] = useState<TaskUserQuestionsDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const pending = useRef(false);

  const load = useCallback(async (previous: TaskUserQuestionsDto | null) => {
    if (!taskId || pending.current) return;
    const token = generation.current;
    pending.current = true;
    setLoading(true);
    setError(undefined);
    try {
      const api = window.api?.agent?.listTaskUserQuestions;
      if (!api) throw new Error("主进程 Agent API 未就绪");
      const next = await api(taskId, { beforeEntryId: previous?.nextBefore, historyId: previous?.historyId ?? historyId });
      if (generation.current !== token) return;
      if (historyId && next.historyId !== historyId || previous?.historyId && next.historyId !== previous.historyId)
        throw new Error("历史分支已变化，请重新打开提问列表");
      if (next.nextBefore !== undefined && previous?.nextBefore !== undefined && next.nextBefore >= previous.nextBefore)
        throw new Error("历史提问游标未推进，请重试");
      setPage({ ...next, questions: [...next.questions, ...(previous?.questions ?? [])] });
    } catch (error) {
      if (generation.current === token) setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation.current === token) { pending.current = false; setLoading(false); }
    }
  }, [taskId, historyId]);

  useEffect(() => {
    generation.current++;
    pending.current = false;
    setPage(null);
    void load(null);
    return () => { generation.current++; };
  }, [load]);

  return { index: page?.questions ?? null, hasMore: page?.nextBefore !== undefined, loading, error,
    loadMore: () => { void load(page); } };
}
