import { useEffect, useRef, useState } from "react";
import type { WorkProjectionDto } from "@shared/bot-work";
import { useAppStore } from "@/store/appStore";

/** Full projections live only with the open viewer, never in the summary cache. */
export function useBotWorkDetail(workId: string | null, scope: string) {
  const cursor = useAppStore(state => state.botWorkCursor);
  const watermark = JSON.stringify([cursor?.epoch, cursor?.scope, cursor?.sequence]);
  const [result, setResult] = useState<{ key: string; work: WorkProjectionDto | null; loading: boolean; error?: string }>();
  const reload = useRef<{ key: string; watermark: string; refresh: (invalidate?: boolean) => void } | null>(null);
  const key = `${scope}:${workId ?? ""}`;
  useEffect(() => {
    if (!workId) { reload.current = null; return; }
    let cancelled = false, pending = false, invalidated = false;
    const refresh = (invalidate = false) => {
      if (cancelled) return;
      if (pending) { invalidated ||= invalidate; return; }
      pending = true;
      setResult(previous => ({ key, work: previous?.key === key ? previous.work : null,
        loading: !(previous?.key === key && previous.work) }));
      const api = window.api?.botWork;
      Promise.resolve().then(() => {
        if (!api?.getWork) throw new Error("事项详情接口暂不可用，请稍后重试。");
        return api.getWork(workId);
      }).then(work => {
        if (!cancelled && !invalidated) setResult({ key, work: work?.workId === workId && !work.archive?.deletedAt ? work : null, loading: false });
      }).catch(error => {
        if (!cancelled && !invalidated) setResult({ key, work: null, loading: false, error: error instanceof Error ? error.message : String(error) });
      }).finally(() => {
        pending = false;
        if (invalidated && !cancelled) { invalidated = false; refresh(); }
      });
    };
    reload.current = { key, watermark, refresh };
    refresh();
    // Some related facts have no journal event. Only the open viewer polls, and
    // ticks coalesce while a request is pending. Keep the full view during refresh.
    const timer = setInterval(refresh, 5000);
    return () => { cancelled = true; clearInterval(timer); reload.current = null; };
  }, [workId, scope]);
  useEffect(() => {
    const current = reload.current;
    if (!current || current.key !== key || current.watermark === watermark) return;
    current.watermark = watermark;
    // A watermark arriving during a read queues exactly one fresh read rather
    // than accepting a response that may predate the new fact.
    current.refresh(true);
  }, [key, watermark]);
  return result?.key === key ? result : { work: null, loading: Boolean(workId), error: undefined };
}
