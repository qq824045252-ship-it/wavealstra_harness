import { useEffect, useRef, useState } from "react";
import { useAppStore } from "@/store/appStore";
import type { TaskCompactionStatusDto } from "@shared/compaction";
import { resolveCompactionPolicy } from "@shared/compaction-policy";
import { formatTokenCount } from "@shared/token-format";

/**
 * 状态对象本身来自 TaskCompactionStatusDto；`code` 在 result 上（如 NOTHING_TO_COMPRESS），
 * 展示前折叠到状态里，旧主进程没有 code 时由 message 兜底。
 */
type CompactionStatusView = TaskCompactionStatusDto & { code?: string };

/** 「没有可整理内容」可能来自 code 或 message（两种主进程口径都认）。 */
function meansNothingToCompress(state: CompactionStatusView): boolean {
  if (state.code === "NOTHING_TO_COMPRESS") return true;
  return /没有可(整理|压缩)/.test(state.message ?? "");
}

/** 缺失的测量值显示「未测量」，不用「—」冒充 0；估算值标注「约」。 */
function measuredLabel(value: number | undefined, estimated: boolean): string {
  if (value == null || !Number.isFinite(value)) return "未测量";
  return (estimated ? "约 " : "") + formatTokenCount(value);
}

/** completed 优先用 tokensAfter；`estimated` 为真或回退 estimatedTokensAfter 时标注「约」。 */
function completedLabel(state: CompactionStatusView): string {
  const estimated = state.estimated === true;
  const after = state.tokensAfter != null
    ? measuredLabel(state.tokensAfter, estimated)
    : measuredLabel(state.estimatedTokensAfter, true);
  return "已整理：" + measuredLabel(state.tokensBefore, estimated) + " → " + after;
}

/** 手动操作判定：reason 优先；旧主进程只带 automatic 时按 automatic === false 认手动。 */
function isManualState(state: CompactionStatusView | undefined): boolean {
  return state?.reason === "manual" || state?.automatic === false;
}

/** running 文案按引擎区分：billion-context 是「整理上下文」，Pi 路径是「压缩」。 */
function runningLabel(state: CompactionStatusView): string {
  const manual = isManualState(state);
  if (state.engine === "billion-context") {
    return (manual ? "正在手动整理上下文…" : "正在自动整理上下文…") + "（billion-context）";
  }
  return manual ? "Pi 正在压缩上下文…" : "Pi 原生压缩…";
}

function resultLabel(state: CompactionStatusView | undefined): string {
  if (!state) return "";
  if (state.status === "completed") return completedLabel(state);
  if (state.status === "running") return runningLabel(state);
  if (state.status === "skipped") return meansNothingToCompress(state) ? "没有可整理的历史" : state.message ?? "本次未整理";
  return state.message ?? "";
}

export default function ManualCompactionControl({ taskId, executing, contextWindow }: { taskId: string; executing: boolean; contextWindow: number }): React.JSX.Element {
  const api = window.api?.agent;
  const rawState = useAppStore(s => s.compactionByTask[taskId]);
  const state = rawState as CompactionStatusView | undefined;
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
      // 结果码在 result 上，状态对象也可能带 code：合并后按统一口径展示，避免「已整理：— → —」。
      const merged: CompactionStatusView = { ...result.state, code: result.code };
      if (active.current)
        setNotice(merged.status === "completed" || merged.status === "skipped" ? resultLabel(merged) : merged.message ?? "");
      if (result.ok) useAppStore.setState(s => ({ compactionByTask: { ...s.compactionByTask, [taskId]: merged } }));
    } catch (e) { if (active.current) setNotice(e instanceof Error ? e.message : String(e)); }
    finally { submitted.current = false; if (active.current) setPending(false); }
  };
  const running = state?.status === "running";
  return <div className="manual-compaction-control">
    <div className="settings-row-desc">设置触发线：{threshold == null ? "—" : formatTokenCount(threshold)}</div>
    {(notice || resultLabel(state)) && <div role={state?.status === "failed" ? "alert" : "status"} className="compaction-result">{notice || resultLabel(state)}</div>}
    <div className="compaction-actions"><button type="button" className="btn btn--primary" disabled={executing || running || pending}
      onClick={() => void compact()}>{running || pending ? "正在整理…" : executing ? "执行结束后可整理" : "立即整理上下文"}</button>
      {running && isManualState(state) && <button type="button" className="btn" onClick={() => { void api?.abortCompaction(taskId).catch(e => setNotice(String(e))); }}>取消整理</button>}</div>
  </div>;
}