/** Task menu. Legacy component name retained for caller compatibility. */
import { IconBarChart } from "@/components/common/icons";
export interface TaskWriteGrantsMenuProps {
  taskId: string;
  onClose: () => void;
  onOpenDiagnostics: () => void;
}
export default function TaskWriteGrantsMenu({ onOpenDiagnostics }: TaskWriteGrantsMenuProps): React.JSX.Element {
  return <div className="task-grants-popup task-menu-popup" role="dialog" aria-label="任务菜单">
    <div className="task-grants-title">任务菜单</div>
    <div className="task-menu-list"><button type="button" className="task-menu-item" data-testid="task-menu-diagnostics" title="查看模型、工具、等待与缓存记录" onClick={onOpenDiagnostics}>
      <IconBarChart size={14} /><span className="task-menu-item-label">执行诊断</span><span className="task-menu-item-hint">模型 / 工具 / 等待 / 缓存记录</span>
    </button></div>
  </div>;
}
