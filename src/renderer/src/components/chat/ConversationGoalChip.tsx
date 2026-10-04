import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ConversationGoalDto } from "@shared/conversation-goal";
import { IconTarget } from "@/components/common/icons";

export default function ConversationGoalChip({ taskId, goal }: { taskId: string; goal?: ConversationGoalDto }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [criteria, setCriteria] = useState("");
  const [progress, setProgress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(goal?.title ?? "");
    setDescription(goal?.description ?? "");
    setCriteria(goal?.criteria.map((item) => item.text).join("\n") ?? "");
    setProgress(goal?.progressSummary ?? "");
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

  const save = async (): Promise<void> => {
    if (!title.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const api = window.api?.conversationRuntime;
      const result = goal
        ? await api?.updateGoal({
            goalId: goal.id,
            title: title.trim(),
            description: description.trim(),
            progressSummary: progress.trim(),
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
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
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
  return (
    <>
      <button type="button" className={`conversation-goal-chip${goal ? " has-goal" : ""}`} onClick={() => setOpen(true)} title={goal ? goal.description || goal.title : "为这个 Task 建立跨轮 Goal"}>
        <IconTarget size={13} strokeWidth={1.5} />
        <span className="conversation-goal-chip-label">{goal ? goal.title : "Goal"}</span>
        {goal && goal.criteria.length > 0 && <small>{met}/{goal.criteria.length}</small>}
      </button>
      {open && createPortal(
        <div className="conversation-goal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
          <section className="conversation-goal-dialog" role="dialog" aria-modal="true" aria-labelledby="conversation-goal-title">
            <header><div><span className="conversation-runtime-kicker">Task 长期目标</span><h2 id="conversation-goal-title">{goal ? "编辑 Goal" : "建立 Goal"}</h2></div><button type="button" aria-label="关闭" onClick={() => setOpen(false)}>×</button></header>
            <label>目标标题<input autoFocus value={title} maxLength={240} onChange={(event) => setTitle(event.target.value)} placeholder="这段对话最终要达成什么？" /></label>
            <label>说明（可选）<textarea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
            <label>成功标准（每行一条，最多 12 条）<textarea rows={5} value={criteria} onChange={(event) => setCriteria(event.target.value)} placeholder={"结果可以被验证\n关键交付物已完成"} /></label>
            {goal && <label>当前进展<textarea rows={3} value={progress} onChange={(event) => setProgress(event.target.value)} /></label>}
            {goal && goal.criteria.length > 0 && <div className="conversation-goal-criteria">{goal.criteria.map((item) => <div key={item.id}><span>{item.status === "met" ? "✓" : item.status === "waived" ? "−" : "○"}</span><span>{item.text}</span></div>)}</div>}
            {error && <div className="conversation-interaction-error" role="alert">{error}</div>}
            <footer>{goal && <button type="button" className="danger" disabled={busy} onClick={() => void cancelGoal()}>取消 Goal</button>}<span /><button type="button" disabled={busy} onClick={() => setOpen(false)}>返回</button><button type="button" className="primary" disabled={busy || !title.trim()} onClick={() => void save()}>{busy ? "保存中…" : "保存"}</button></footer>
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}
