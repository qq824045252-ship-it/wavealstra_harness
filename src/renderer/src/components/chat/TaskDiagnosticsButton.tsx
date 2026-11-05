import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconX } from "@/components/common/icons";
import { useBlockNativeSurfaces } from "@/hooks/useBlockNativeSurfaces";
import TaskDiagnosticsPanel from "./TaskDiagnosticsPanel";

export default function TaskDiagnosticsButton({ taskId }: { taskId: string }) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useBlockNativeSurfaces(open);
  useEffect(() => setOpen(false), [taskId]);
  useEffect(() => {
    if (!open) return;
    close.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setOpen(false); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); opener.current?.focus(); };
  }, [open]);
  return <>
    <button ref={opener} type="button" className="icon-btn task-diagnostics-open" title="查看模型、工具、等待与缓存记录"
      aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} data-testid="task-diagnostics-open">执行诊断</button>
    {open && createPortal(<div className="modal-overlay runtime-inspector-overlay" onClick={() => setOpen(false)}>
      <section className="runtime-inspector" role="dialog" aria-modal="true" aria-label="任务执行诊断" onClick={event => event.stopPropagation()}>
        <header className="runtime-inspector-head"><div>
          <h2 className="runtime-inspector-title">任务执行诊断</h2>
          <div className="runtime-inspector-sub">查看主代理、子代理和辅助请求的实际执行记录。</div>
        </div><button ref={close} className="icon-btn" type="button" aria-label="关闭执行诊断" onClick={() => setOpen(false)}><IconX size={16} /></button></header>
        <div className="runtime-inspector-body"><TaskDiagnosticsPanel taskId={taskId} /></div>
      </section>
    </div>, document.body)}
  </>;
}
