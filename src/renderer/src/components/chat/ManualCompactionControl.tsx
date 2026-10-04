import { useEffect, useRef, useState } from "react";
import { useAppStore } from "@/store/appStore";
import type { TaskCompactionStatusDto } from "@shared/compaction";
import { resolveCompactionPolicy } from "@shared/compaction-policy";

export default function ManualCompactionControl({ taskId, executing, contextWindow }: { taskId: string; executing: boolean; contextWindow: number }): React.JSX.Element {
  const api = window.api?.agent;
  const state = useAppStore(s => s.compactionByTask[taskId]);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [threshold, setThreshold] = useState<number | null>(null);
  const active = useRef(true);
  const submitted = useRef(false);
  useEffect(() => {
    if (!api) { setNotice("桌面服务未连接。"); return; }
    active.current = true;
    const before = useAppStore.getState().compactionByTask[taskId];
    void api.getCompactionStatus(taskId).then(current => {
      if (active.current && useAppStore.getState().compactionByTask[taskId] === before)
        useAppStore.setState(s => ({ compactionByTask: { ...s.compactionByTask, [taskId]: current } }));
    }).catch(e => { if (active.current) setNotice(String(e)); });
    void api.getAppSettings().then(s => {
      if (active.current) setThreshold(resolveCompactionPolicy(contextWindow, s.compactionTriggerRatio, s.compactionTriggerTokens)?.triggerTokens ?? null);
    }).catch(() => {});
    return () => { active.current = false; };
  }, [api, taskId, contextWindow]);
  const compact = async (): Promise<void> => {
    if (!api) { setNotice("桌面服务未连接。"); return; }
    if (submitted.current || executing || state?.status === "running") return;
    submitted.current = true; setPending(true); setNotice("");
    try {
      const result = await api.compact(taskId);
      if (active.current) setNotice(result.state.message ?? "");
      if (result.ok) useAppStore.setState(s => ({ compactionByTask: { ...s.compactionByTask, [taskId]: result.state } }));
    } catch (e) { if (active.current) setNotice(e instanceof Error ? e.message : String(e)); }
    finally { submitted.current = false; if (active.current) setPending(false); }
  };
  const running = state?.status === "running";
  const resultLabel = (s: TaskCompactionStatusDto | undefined): string => {
    if (s?.status === "completed") return "已压缩：" + (s.tokensBefore == null ? "—" : (s.tokensBefore / 1000).toFixed(1) + "K") + " → " + (s.estimatedTokensAfter == null ? "—" : "约 " + (s.estimatedTokensAfter / 1000).toFixed(1) + "K");
    if (s?.status === "running") return s.reason === "manual" ? "正在手动压缩…" : "Pi 正在自动整理上下文…";
    return s?.message ?? "";
  };
  return <div className="manual-compaction-control">
    <div className="settings-row-desc">设置触发线：{threshold == null ? "—" : (threshold / 1000).toLocaleString("zh-CN") + "K"}</div>
    <p className="settings-row-desc">将较早消息整理为摘要，保留最近上下文。完整聊天记录仍可查看；会调用当前会话模型。</p>
    {(notice || resultLabel(state)) && <div role={state?.status === "failed" ? "alert" : "status"} className="compaction-result">{notice || resultLabel(state)}</div>}
    <div className="compaction-actions"><button type="button" className="btn btn--primary" disabled={executing || running || pending}
      onClick={() => void compact()}>{running || pending ? "正在压缩…" : executing ? "执行结束后可压缩" : "立即压缩"}</button>
      {running && state.reason === "manual" && <button type="button" className="btn" onClick={() => { void api?.abortCompaction(taskId).catch(e => setNotice(String(e))); }}>取消压缩</button>}</div>
  </div>;
}
