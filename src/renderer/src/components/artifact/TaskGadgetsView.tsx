import GadgetSection from "@/components/gadget/GadgetSection";
import { useAppStore } from "@/store/appStore";

export default function TaskGadgetsView({ floating = false }: { floating?: boolean }): React.JSX.Element {
  const activeTaskId = useAppStore((state) => state.activeTaskId);

  if (!activeTaskId) {
    return (
      <div className="extension-body task-gadgets-view">
        <div className="gadgets-view-header">
          <div className="gadgets-view-stats">
            <span className="gadgets-count-label">工作台</span>
            <span className="gadgets-count-badge">0</span>
          </div>
        </div>
        <div className="task-gadgets-panel-empty">请先选择一个任务</div>
      </div>
    );
  }

  const content = (
    <GadgetSection key={activeTaskId} scope={{ type: "task", taskId: activeTaskId }} includeInherited />
  );

  if (floating) {
    return <div className="task-gadgets-panel-floating">{content}</div>;
  }

  return (
    <div className="extension-body task-gadgets-view">
      {content}
    </div>
  );
}
