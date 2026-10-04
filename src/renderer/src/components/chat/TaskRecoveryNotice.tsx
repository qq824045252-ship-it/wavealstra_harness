import { useEffect, useState } from "react";
import { useAppStore } from "@/store/appStore";
import type { ExecutionFailureDto } from "@shared/execution-recovery";

const labels = { retryable: "可重试", recoverable: "需要恢复", "requires-user-action": "需要处理", terminal: "无法继续" };

export default function TaskRecoveryNotice({ taskId, projectId, refreshKey }: { taskId: string; projectId?: string; refreshKey: string }): React.JSX.Element | null {
  const openProjectDetails = useAppStore((state) => state.openProjectDetails);
  const [failure, setFailure] = useState<ExecutionFailureDto | null>(null);
  const [error, setError] = useState("");
  const [dismissing, setDismissing] = useState(false);
  useEffect(() => {
    let active = true;
    setFailure(null); setError("");
    const request = window.api?.db?.listExecutionFailures?.(taskId);
    if (!request) return;
    void request.then((records) => {
      if (active) setFailure(records.find((item) => item.taskId === taskId && !item.resolvedAt) ?? null);
    }).catch(() => { if (active) setError("无法读取任务恢复状态，请重新打开此任务。"); });
    return () => { active = false; };
  }, [taskId, refreshKey]);
  // 用户关闭只隐藏这条提示，不会把故障伪装成已解决；同类故障再次发生会生成新提示。
  const dismiss = async (): Promise<void> => {
    if (!failure || dismissing) return;
    setDismissing(true);
    try {
      await window.api?.db?.dismissExecutionFailure?.(taskId, failure.id);
      setFailure(null);
    } catch { setError("关闭失败，请重试。"); }
    finally { setDismissing(false); }
  };
  if (!failure && !error) return null;
  return <section className="conversation-runtime-card interaction-card task-recovery-notice" aria-label="任务恢复" role="status">
    {error ? <p>{error}</p> : failure && <>
      <div className="task-recovery-head">
        <h3>{labels[failure.recovery] ?? "需要恢复"}</h3>
        <button className="task-recovery-dismiss" type="button" title="隐藏此提示（不代表故障已解决）" aria-label="隐藏提示" onClick={() => void dismiss()} disabled={dismissing}>×</button>
      </div>
      <p>{failure.message}</p>
      <p>{failure.nextAction}</p>
      {projectId && failure.causeCode.startsWith("workspace-") && <button className="btn" onClick={() => openProjectDetails(projectId, "assets")}>打开项目资料</button>}
      <details><summary>故障详情</summary><p>阶段：{failure.phase} · 原因：{failure.causeCode}</p><p>副作用：{failure.sideEffects === "none" ? "执行尚未开始" : failure.sideEffects === "known" ? "已有变更" : "结果未知，需先核对"}</p></details>
    </>}
  </section>;
}
