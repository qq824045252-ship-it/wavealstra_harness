import GadgetSection from "@/components/gadget/GadgetSection";
import { useAppStore } from "@/store/appStore";
import ExtensionModeDropdown from "./ExtensionModeDropdown";

export default function TaskGadgetsView({ floating = false }: { floating?: boolean }): React.JSX.Element {
  const activeTaskId = useAppStore((state) => state.activeTaskId);

  const content = activeTaskId ? (
    <div className="task-gadgets-panel-scroll">
      <GadgetSection key={activeTaskId} scope={{ type: "task", taskId: activeTaskId }} includeInherited title="当前任务可用 Gadgets" />
    </div>
  ) : (
    <div className="task-gadgets-panel-empty">请先选择一个任务</div>
  );

  if (floating) return content;

  return (
    <div className="extension-body task-gadgets-view">
      <div className="extension-panel-nav task-gadgets-panel-nav">
        <ExtensionModeDropdown fixedMode="gadgets" variant="panel" />
        {content}
      </div>
    </div>
  );
}
