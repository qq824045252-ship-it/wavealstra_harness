import { useMemo, useState } from "react";
import { useVisibleTaskArtifacts, useAppStore } from "@/store/appStore";
import ArtifactRail from "./ArtifactRail";
import { IconSearch } from "@/components/common/icons";

interface Props {
  floating?: boolean;
}

export default function ArtifactsView({ floating = false }: Props): React.JSX.Element {
  const artifacts = useVisibleTaskArtifacts();
  const openArtifact = useAppStore((s) => s.openArtifact);
  const activeArtifactId = useAppStore((s) => s.activeArtifactId);
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return artifacts;
    return artifacts.filter((a) => a.name.toLowerCase().includes(q));
  }, [artifacts, filter]);

  const rail = (
    <ArtifactRail
      artifacts={filtered}
      activeArtifactId={activeArtifactId}
      onSelect={(a) => openArtifact(a.id)}
      variant="panel"
      standalone={!floating}
    />
  );

  if (floating) {
    return rail;
  }

  return (
    <div className="extension-body artifacts-view">
      <div className="artifacts-view-header">
        <div className="artifacts-view-stats">
          <span className="artifacts-count-label">任务产物</span>
          <span className="artifacts-count-badge">{artifacts.length}</span>
        </div>
        {artifacts.length > 4 && (
          <div className="artifacts-search-box">
            <IconSearch size={13} className="artifacts-search-icon" />
            <input
              type="text"
              className="artifacts-search-input"
              placeholder="搜索产物..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
        )}
      </div>
      <div className="extension-panel-nav artifacts-panel-content">
        {rail}
      </div>
    </div>
  );
}
