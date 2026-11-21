import { useEffect, useRef, useState } from "react";
import { dateInputToMs, msToDateInput } from "@/lib/projectPlanSchedule";
import type { TaskBoardRow } from "@shared/task-board";
import { useAppStore } from "@/store/appStore";

export default function TaskBoardDueDate({ card, onClose }: { card: TaskBoardRow; onClose: () => void }): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState(() => msToDateInput(card.dueAt));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const saveDate = useAppStore(state => state.setTaskDueDate);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);

  async function save(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await saveDate(card.id, dateInputToMs(value) ?? null);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败，请重试");
      setBusy(false);
    }
  }

  return <dialog ref={dialog} className="task-board-date-dialog" aria-labelledby="board-date-heading"
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <h2 id="board-date-heading">任务截止日期</h2>
      <p>{card.title}</p>
      <label>截止日期<input autoFocus type="date" value={value} min={msToDateInput(card.startAt)} disabled={busy}
        onChange={event => setValue(event.target.value)} /></label>
      {error && <p role="alert">{error}</p>}
      <footer>
        <button className="btn" type="button" disabled={!value || busy} onClick={() => setValue("")}>清除日期</button>
        <button className="btn" type="button" disabled={busy} onClick={onClose}>取消</button>
        <button className="btn primary" type="submit" disabled={busy}>{busy ? "保存中…" : "保存"}</button>
      </footer>
    </form>
  </dialog>;
}
