import { IconBarChart } from "@/components/common/icons";

export interface TaskDiagnosticsButtonProps {
  open: boolean;
  labeled?: boolean;
  onClick: () => void;
}

export default function TaskDiagnosticsButton({ open, labeled, onClick }: TaskDiagnosticsButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      className={`${labeled ? "desktop-section-row" : "icon-btn"} ${open ? "toggled" : ""}`}
      title="执行诊断：模型 / 工具 / 等待 / 缓存记录"
      aria-label="执行诊断"
      aria-haspopup="dialog"
      aria-expanded={open}
      data-testid="task-diagnostics-button"
      onClick={onClick}
    >
      <IconBarChart size={15} />
      {labeled && "执行诊断"}
    </button>
  );
}
