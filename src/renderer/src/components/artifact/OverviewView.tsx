import RuntimeObservatory from "./overview/RuntimeObservatory";

export default function OverviewView({ floating = false }: { floating?: boolean }): React.JSX.Element {
  return (
    <div className={`extension-body overview-view ${floating ? "floating" : ""}`}>
      <div className="extension-panel-nav">
        {/* Runtime Observatory：当前任务运行态总览（主 Agent / 子代理 / 后台任务） */}
        <RuntimeObservatory />
      </div>
    </div>
  );
}
