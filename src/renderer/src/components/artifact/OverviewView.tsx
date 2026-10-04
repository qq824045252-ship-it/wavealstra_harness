import { useVisibleTaskArtifacts, useAppStore } from "@/store/appStore";
import ExtensionModeDropdown from "./ExtensionModeDropdown";
import ArtifactRail from "./ArtifactRail";
import RuntimeObservatory from "./overview/RuntimeObservatory";

export default function OverviewView({ floating = false }: { floating?: boolean }): React.JSX.Element {
  // V3.6：产物面板列表按场景产物黑白名单过滤显示（变更显示仍全量）
  const artifacts = useVisibleTaskArtifacts();
  const openArtifact = useAppStore((s) => s.openArtifact);
  const activeArtifactId = useAppStore((s) => s.activeArtifactId);

  const rail = (
    <ArtifactRail
      artifacts={artifacts}
      activeArtifactId={activeArtifactId}
      onSelect={(a) => openArtifact(a.id)}
      variant="panel"
    />
  );

  if (floating) {
    return rail;
  }

  return (
    <div className="extension-body overview-view">
      <div className="extension-panel-nav">
        <ExtensionModeDropdown variant="panel" />
        {/* Runtime Observatory：当前任务运行态总览（主 Agent / 子代理 / 后台任务） */}
        <RuntimeObservatory />
        {rail}
      </div>
    </div>
  );
}
