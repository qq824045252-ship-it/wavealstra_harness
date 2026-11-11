/** Direct execution-diagnostics entry in the task header.
 * The old "more" task menu only ever held this one action, so the header exposes
 * the bar-chart icon directly instead of an extra menu step. */
import { IconBarChart } from "@/components/common/icons";

export interface TaskDiagnosticsButtonProps {
  open: boolean;
  onClick: () => void;
}

export default function TaskDiagnosticsButton({ open, onClick }: TaskDiagnosticsButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      className={`icon-btn ${open ? "toggled" : ""}`}
      title="执行诊断：模型 / 工具 / 等待 / 缓存记录"
      aria-label="执行诊断"
      aria-haspopup="dialog"
      aria-expanded={open}
      data-testid="task-diagnostics-button"
      onClick={onClick}
    >
      <IconBarChart size={15} />
    </button>
  );
}
