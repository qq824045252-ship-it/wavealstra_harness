import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ConversationGoalContinuationDto, ConversationGoalDto } from "@shared/conversation-goal";
import { IconTarget } from "@/components/common/icons";

const DEFER_LABEL: Record<NonNullable<ConversationGoalContinuationDto["deferReason"]>, string> = {
  user_interrupt: "用户中断",
  turn_aborted: "本轮中止",
  run_failed: "本轮失败",
  restart: "应用重启",
  no_progress: "连续无进展",
  manual_stop: "手动停止",
  attempts: "自动轮次用尽",
  budget: "token 预算用尽",
};

function continuationSummary(continuation: ConversationGoalContinuationDto | undefined): string | null {
  if (!continuation) return null;
  if (continuation.state === "deferred") return `已暂停（${DEFER_LABEL[continuation.deferReason ?? "manual_stop"]}）`;
  if (continuation.state === "exhausted") return `续跑已停止（${DEFER_LABEL[continuation.deferReason ?? "attempts"]}）`;
  if (continuation.state === "igniting") return "自动续跑中";
  return null;
}

export default function ConversationGoalChip({ taskId, goal }: { taskId: string; goal?: ConversationGoalDto }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [criteria, setCriteria] = useState("");
  const [progress, setProgress] = useState("");
  const [budget, setBudget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Seed the form only when the dialog opens (or the edited Goal changes).
   * A host continuation patch updates the goal prop while the user is typing;
   * resetting every field on each patch would discard their edits. */
  const seeded = useRef<string | null>(null);

  useEffect(() => {
    if (!open) { seeded.current = null; return; }
    const key = goal?.id ?? "new";
    if (seeded.current === key) return;
    seeded.current = key;
    setTitle(goal?.title ?? "");
    setDescription(goal?.description ?? "");
    setCriteria(goal?.criteria.map((item) => item.text).join("\n") ?? "");
    setProgress(goal?.progressSummary ?? "");
    setBudget(goal?.continuation?.tokenBudget != null ? String(goal.continuation.tokenBudget) : "");
    setError(null);
  }, [open, goal]);

  useEffect(() => {
    const surface = window.api?.artifact?.surface;
    if (!surface) return;
    const token = "conversation-goal-modal";
    if (open) surface.addBlocker("artifact-main", token);
    else surface.removeBlocker("artifact-main", token);
    return () => {
      if (open) surface.removeBlocker("artifact-main", token);
    };
  }, [open]);

  const budgetValue = (): number | null => {
    if (!budget.trim()) return null;
    const value = Number(budget);
    if (!Number.isFinite(value) || value < 1) throw new Error("token 预算必须是正整数，或留空表示不限");
    return Math.round(value);
  };

  const save = async (): Promise<void> => {
    if (!title.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const api = window.api?.conversationRuntime;
      const tokenBudget = budgetValue();
      const result = goal
        ? await api?.updateGoal({
            goalId: goal.id,
            title: title.trim(),
            description: description.trim(),
            progressSummary: progress.trim(),
            tokenBudget,
            criteria: criteria.split(/\r?\n/).map((text, index) => ({
              id: goal.criteria[index]?.id,
              text: text.trim(),
              status: goal.criteria[index]?.status,
              evidence: goal.criteria[index]?.evidence,
            })).filter((item) => item.text),
          })
        : await api?.createGoal({
            taskId,
            title: title.trim(),
            description: description.trim(),
            criteria: criteria.split(/\r?\n/).map((text) => text.trim()).filter(Boolean).map((text) => ({ text })),
          });
      if (!result?.ok) throw new Error(result?.message ?? "保存 Goal 失败");
      // Creation cannot carry scheduling configuration; apply it as a second,
      // independent write so the create request keeps its single authority.
      if (!goal && tokenBudget !== null) await api?.updateGoal({ goalId: result.goal.id, tokenBudget });
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (status: "paused" | "active"): Promise<void> => {
    if (!goal || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.api?.conversationRuntime?.updateGoal({ goalId: goal.id, status });
      if (!result?.ok) throw new Error(result?.message ?? "更新 Goal 状态失败");
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };

  const continueGoal = async (): Promise<void> => {
    if (!goal || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.api?.conversationRuntime?.resumeGoalContinuation(goal.id);
      if (!result?.ok) throw new Error(result?.message ?? "继续 Goal 失败");
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };

  const cancelGoal = async (): Promise<void> => {
    if (!goal || busy) return;
    setBusy(true);
    try {
      const result = await window.api?.conversationRuntime?.cancelGoal(goal.id);
      if (!result?.ok) throw new Error(result?.message ?? "取消 Goal 失败");
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };

  const met = goal?.criteria.filter((item) => item.status === "met" || item.status === "waived").length ?? 0;
  const continuation = goal?.continuation;
  const continuationLabel = continuation
    ? `${continuation.attempts}/${continuation.maxAttempts}${continuation.state === "deferred" ? " · 暂停" : continuation.state === "exhausted" ? " · 用尽" : ""}`
    : null;
  const stopSummary = continuationSummary(continuation);
  const canContinue = goal?.status === "active" && (continuation?.state === "deferred" || continuation?.state === "exhausted");
  return (
    <>
      <button type="button" className={`conversation-goal-chip${goal ? " has-goal" : ""}`} onClick={() => setOpen(true)} title={goal ? goal.description || goal.title : "为这个 Task 建立跨轮 Goal"}>
        <IconTarget size={13} strokeWidth={1.5} />
        <span className="conversation-goal-chip-label">{goal ? goal.title : "Goal"}</span>
        {goal && goal.criteria.length > 0 && <small>{met}/{goal.criteria.length}</small>}
        {continuationLabel && <small title={stopSummary ?? "宿主自动续跑"}>{continuationLabel}</small>}
      </button>
      {open && createPortal(
        <div className="conversation-goal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
          <section className="conversation-goal-dialog" role="dialog" aria-modal="true" aria-labelledby="conversation-goal-title">
            <header><div><span className="conversation-runtime-kicker">Task 长期目标</span><h2 id="conversation-goal-title">{goal ? "编辑 Goal" : "建立 Goal"}</h2></div><button type="button" aria-label="关闭" onClick={() => setOpen(false)}>×</button></header>
            <label>目标标题<input autoFocus value={title} maxLength={240} onChange={(event) => setTitle(event.target.value)} placeholder="这段对话最终要达成什么？" /></label>
            <label>说明（可选）<textarea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
            <label>成功标准（每行一条，最多 12 条）<textarea rows={5} value={criteria} onChange={(event) => setCriteria(event.target.value)} placeholder={"结果可以被验证\n关键交付物已完成"} /></label>
            {goal && <label>当前进展<textarea rows={3} value={progress} onChange={(event) => setProgress(event.target.value)} /></label>}
            {goal && <label>自动续跑 token 预算（留空 = 跟随全局设置）<input inputMode="numeric" value={budget} onChange={(event) => setBudget(event.target.value)} placeholder="例如 50000" /></label>}
            {goal && continuation && continuation.attempts > 0 && (
              <div className="conversation-goal-continuation" aria-live="polite">
                <span>{`宿主自动续跑 ${continuation.attempts}/${continuation.maxAttempts} 次`}</span>
                {continuation.tokensUsed > 0 && <span>{`已用 ${continuation.tokensUsed.toLocaleString()} token`}</span>}
                {stopSummary && <span className="conversation-goal-continuation-stop">{stopSummary}</span>}
              </div>
            )}
            {goal && goal.criteria.length > 0 && <div className="conversation-goal-criteria">{goal.criteria.map((item) => <div key={item.id}><span>{item.status === "met" ? "✓" : item.status === "waived" ? "−" : "○"}</span><span>{item.text}</span></div>)}</div>}
            {error && <div className="conversation-interaction-error" role="alert">{error}</div>}
            <footer>
              <div className="conversation-goal-actions">
                {goal && <button type="button" className="danger" disabled={busy} onClick={() => void cancelGoal()}>取消 Goal</button>}
                {goal?.status === "active" && <button type="button" disabled={busy} onClick={() => void setStatus("paused")}>暂停</button>}
                {goal?.status === "paused" && <button type="button" disabled={busy} onClick={() => void setStatus("active")}>恢复</button>}
                {canContinue && <button type="button" className="primary" disabled={busy} onClick={() => void continueGoal()}>继续</button>}
              </div>
              <div className="conversation-goal-save">
                <button type="button" disabled={busy} onClick={() => setOpen(false)}>返回</button>
                <button type="button" className="primary" disabled={busy || !title.trim()} onClick={() => void save()}>{busy ? "保存中…" : "保存"}</button>
              </div>
            </footer>
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}
