import { useEffect, useRef, useState } from "react";
import type { ImprovementReport } from "@shared/native-improvement";

export function useImprovementReport() {
  const api = window.api?.nativeImprovement;
  const [report, setReport] = useState<ImprovementReport>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const updateSequence = useRef(0);
  const progress = report?.progress;
  const running = Boolean(progress && progress.phase !== "idle");

  useEffect(() => {
    if (!api) return;
    let active = true;
    let timer: number;
    const refresh = async () => {
      const pendingAt = updateSequence.current;
      try {
        const next = await api.report();
        if (active && pendingAt === updateSequence.current) setReport(next);
      } catch (cause) {
        if (active && pendingAt === updateSequence.current) setError(String(cause));
      } finally {
        if (active) timer = window.setTimeout(refresh, busy || running ? 500 : 5_000);
      }
    };
    void refresh();
    return () => { active = false; window.clearTimeout(timer); };
  }, [api, busy, running]);

  async function update(action: () => Promise<ImprovementReport>) {
    updateSequence.current++;
    setBusy(true);
    setError("");
    try { setReport(await action()); }
    catch (cause) { setError(String(cause)); }
    finally { updateSequence.current++; setBusy(false); }
  }

  const status = running && progress
    ? `${progress.phase}${progress.total > 0 ? ` · ${progress.done} / ${progress.total}` : ""}`
    : busy ? "正在处理…" : "";
  return { api, report, error, busy, status, update };
}
