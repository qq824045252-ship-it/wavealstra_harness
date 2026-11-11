import { useEffect, useRef, useState } from "react";
import type { WorkQueryRequest, WorkQueryResult } from "@shared/bot-work-query";
import { useAppStore } from "@/store/appStore";

/** One bounded, transactional server page. A late response belongs to its request,
 * never the next Bot, filter or page. Keep the current page visible during refresh. */
export function useWorkQueryPage(request: WorkQueryRequest, enabled = true) {
  const epoch = useAppStore(state => state.botWorkCursor?.epoch);
  const sequence = useAppStore(state => state.botWorkCursor?.sequence);
  const hostOnline = useAppStore(state => state.botHostStatus?.online);
  const key = JSON.stringify(request);
  const scopeReady = request.scope.kind !== "personal" || Boolean(request.scope.botId);
  const [state, setState] = useState<{ key: string; result?: WorkQueryResult; error?: string }>({ key: "" });
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    if (!enabled || !scopeReady) return;
    const api = window.api?.botWork;
    if (!api?.queryWorks) {
      setState({ key, error: "事项分页接口不可用，请重新打开最新版应用。" });
      return;
    }
    let inFlight = false;
    const refresh = () => {
      if (inFlight) return;
      inFlight = true;
      void api.queryWorks(JSON.parse(key) as WorkQueryRequest).then(result => {
        if (generation.current === current) setState({ key, result });
      }).catch(error => {
        if (generation.current === current) setState(previous => ({ key,
          result: previous.key === key ? previous.result : undefined,
          error: error instanceof Error ? error.message : "事项列表暂时无法读取。",
        }));
      }).finally(() => { inFlight = false; });
    };
    refresh();
    // The durable stream is a wakeup, not an exhaustive index of every source
    // table. Read the current transactional page to reconcile external changes.
    const timer = setInterval(refresh, 5000);
    return () => { generation.current++; clearInterval(timer); };

  }, [key, epoch, sequence, hostOnline, enabled, scopeReady, retry]);
  const current = state.key === key ? state : undefined;
  return { result: current?.result, error: current?.error,
    loading: enabled && !current?.result && !current?.error,
    retry: () => setRetry(value => value + 1) };
}
