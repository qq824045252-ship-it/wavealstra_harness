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
export default function TaskDiagnosticsDialog({
  taskId,
  onClose,
}: {
  taskId: string;
  onClose: () => void;
}): React.JSX.Element {
  const close = useRef<HTMLButtonElement>(null);
  useBlockNativeSurfaces(true);
  useEffect(() => {
    close.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="modal-overlay runtime-inspector-overlay" onClick={onClose}>
      <section
        className="runtime-inspector"
        role="dialog"
        aria-modal="true"
        aria-label="任务执行诊断"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="runtime-inspector-head">
          <div>
            <h2 className="runtime-inspector-title">任务执行诊断</h2>
            <div className="runtime-inspector-sub">查看主代理、子代理和辅助请求的实际执行记录。</div>
          </div>
          <button ref={close} className="icon-btn" type="button" aria-label="关闭执行诊断" onClick={onClose}>
            <IconX size={16} />
          </button>
        </header>
        <div className="runtime-inspector-body">
          <TaskDiagnosticsPanel taskId={taskId} />
        </div>
      </section>
    </div>,
    document.body,
  );
}
