import { useMemo, useState } from "react";
import { useActiveTaskArtifacts, useAppStore } from "@/store/appStore";
import type { FileChange } from "@/types";
import { FileBadge } from "@/components/common/FileBadge";
import { IconChevronDown } from "@/components/common/icons";
import ExtensionModeDropdown from "./ExtensionModeDropdown";

const EMPTY_CHANGES: FileChange[] = [];

export default function ChangesView({ floating = false }: { floating?: boolean }): React.JSX.Element {
  const artifacts = useActiveTaskArtifacts();
  const changes = useAppStore(
    (s) => s.tasks.find((task) => task.id === s.activeTaskId)?.fileChanges ?? EMPTY_CHANGES,
  );
  const openArtifact = useAppStore((s) => s.openArtifact);
  const [sectionOpen, setSectionOpen] = useState(true);

  const totals = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const c of changes) {
      additions += c.additions;
      deletions += c.deletions;
    }
    return { additions, deletions, count: changes.length };
  }, [changes]);

  const openFile = (name: string): void => {
    const artifact = artifacts.find(
      (a) => a.name === name || a.name.toLowerCase() === name.toLowerCase(),
    );
    if (artifact) openArtifact(artifact.id);
  };

  const section = (
    <div className="extension-panel-artifacts changes-section">
      <button
        type="button"
        className="extension-panel-header-btn changes-section-title"
        onClick={() => setSectionOpen(!sectionOpen)}
      >
        <span className="changes-section-label">
          文件变更
          {totals.count > 0 && <span className="changes-section-count">({totals.count})</span>}
        </span>
        {(totals.additions > 0 || totals.deletions > 0) && (
          <span className="changes-section-totals">
            {totals.additions > 0 && <span className="changes-add">+{totals.additions}</span>}
            {totals.deletions > 0 && <span className="changes-del">-{totals.deletions}</span>}
          </span>
        )}
        <IconChevronDown size={13} className={sectionOpen ? "" : "chevron-up"} />
      </button>
      {sectionOpen && (
        <div className="extension-panel-item-list changes-file-list">
          {changes.map((item) => (
            <button
              key={item.id}
              type="button"
              className="extension-panel-item-btn changes-file-row"
              onClick={() => openFile(item.name)}
            >
              <FileBadge name={item.name} size={14} muted />
              <span className="extension-artifact-name">{item.name}</span>
              <span className="changes-row-stats">
                {item.additions > 0 && <span className="changes-add">+{item.additions}</span>}
                {item.deletions > 0 && <span className="changes-del">-{item.deletions}</span>}
                {item.additions === 0 && item.deletions === 0 && (
                  <span className="changes-zero">0</span>
                )}
              </span>
            </button>
          ))}
          {changes.length === 0 && <div className="changes-empty">暂无文件变更</div>}
        </div>
      )}
    </div>
  );

  if (floating) {
    return (
      <div className="extension-panel-nav changes-panel-nav">
        {section}
      </div>
    );
  }

  return (
    <div className="extension-body changes-view">
      <div className="extension-panel-nav changes-panel-nav">
        <ExtensionModeDropdown fixedMode="changes" variant="panel" />
        {section}
      </div>
    </div>
  );
}
