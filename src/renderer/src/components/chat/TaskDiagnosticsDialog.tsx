import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { IconX } from "@/components/common/icons";
import { useBlockNativeSurfaces } from "@/hooks/useBlockNativeSurfaces";
import TaskDiagnosticsPanel from "./TaskDiagnosticsPanel";

/**
 * 任务执行诊断弹窗（任务菜单「执行诊断」入口）。
 *
 * 只负责弹窗本身：挂载即打开、卸载即关闭，开关状态由调用方持有。
 * 读数是只读的多类执行记录，含原生 surface 的页面必须持有 blocker（见 useBlockNativeSurfaces）。
 */
export function ExecutionDiagnosticsDialog({ title, subtitle, children, onClose }: { title: string; subtitle: string; children: React.ReactNode; onClose: () => void }): React.JSX.Element {
  const close = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useBlockNativeSurfaces(true);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    close.current?.focus();
    return () => element?.close();
  }, []);
  return createPortal(
    <dialog ref={dialog} className="modal-overlay runtime-inspector-overlay execution-diagnostics-dialog" aria-label={title} onClose={event => event.stopPropagation()} onCancel={event => {event.preventDefault();event.stopPropagation();onClose();}} onClick={onClose} style={{maxWidth:"none",maxHeight:"none",width:"100vw",height:"100dvh",margin:0,border:0,color:"inherit"}}>
      <section
        className="runtime-inspector"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="runtime-inspector-head">
          <div>
            <h2 className="runtime-inspector-title">{title}</h2>
            <div className="runtime-inspector-sub">{subtitle}</div>
          </div>
          <button ref={close} className="icon-btn" type="button" aria-label="关闭执行诊断" onClick={onClose}>
            <IconX size={16} />
          </button>
        </header>
        <div className="runtime-inspector-body">
          {children}
        </div>
      </section>
    </dialog>,
    document.body,
  );
}

export default function TaskDiagnosticsDialog({taskId,onClose}:{taskId:string;onClose:()=>void}) {
 return <ExecutionDiagnosticsDialog title="任务执行诊断" subtitle="查看主代理、子代理和辅助请求的实际执行记录。" onClose={onClose}><TaskDiagnosticsPanel taskId={taskId}/></ExecutionDiagnosticsDialog>;
}
