import { useMemo, useState } from "react";
import { useActiveTaskArtifacts, useAppStore } from "@/store/appStore";
import type { FileChange } from "@/types";
import { FileBadge } from "@/components/common/FileBadge";
import { IconSearch } from "@/components/common/icons";
import { resolveTaskFileChanges } from "@/lib/taskFileChanges";

export default function ChangesView({ floating = false }: { floating?: boolean }): React.JSX.Element {
  const artifacts = useActiveTaskArtifacts();
  const currentTask = useAppStore((s) => s.tasks.find((task) => task.id === s.activeTaskId));
  const rawChanges = currentTask?.fileChanges;
  const changes = useMemo(
    () => resolveTaskFileChanges(rawChanges, artifacts, currentTask?.messages),
    [rawChanges, artifacts, currentTask?.messages],
  );
  const openArtifact = useAppStore((s) => s.openArtifact);
  const openWorkspaceFile = useAppStore((s) => s.openWorkspaceFile);
  const [filter, setFilter] = useState("");

  const totals = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const c of changes) {
      additions += c.additions;
      deletions += c.deletions;
    }
    return { additions, deletions, count: changes.length };
  }, [changes]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return changes;
    return changes.filter(
      (c) => c.name.toLowerCase().includes(q) || (c.path && c.path.toLowerCase().includes(q)),
    );
  }, [changes, filter]);

  const openFile = (item: FileChange): void => {
    const artifact = artifacts.find(
      (a) =>
        a.name === item.name ||
        a.name.toLowerCase() === item.name.toLowerCase() ||
        (item.path && (a.path === item.path || a.path?.toLowerCase() === item.path.toLowerCase())),
    );
    if (artifact) {
      openArtifact(artifact.id);
    } else {
      void openWorkspaceFile(item.path || item.name, item.name);
    }
  };

  const listNode = (
    <div className="extension-panel-item-list changes-file-list">
      {filtered.map((item) => (
        <button
          key={item.id}
          type="button"
          className="extension-panel-item-btn changes-file-row"
          onClick={() => openFile(item)}
          title={`${item.path || item.name}\n+${item.additions} -${item.deletions}`}
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
      {changes.length === 0 && <div className="changes-empty">当前任务暂无代码变更</div>}
      {changes.length > 0 && filtered.length === 0 && (
        <div className="changes-empty">未找到匹配的文件变更</div>
      )}
    </div>
  );

  if (floating) {
    return (
      <div className="extension-panel-nav changes-panel-nav">
        {listNode}
      </div>
    );
  }

  return (
    <div className="extension-body changes-view">
      <div className="changes-view-header">
        <div className="changes-view-stats">
          <span className="changes-count-label">代码变更</span>
          <span className="changes-count-badge">{totals.count}</span>
          {(totals.additions > 0 || totals.deletions > 0) && (
            <span className="changes-totals-pill">
              {totals.additions > 0 && <span className="changes-add">+{totals.additions}</span>}
              {totals.deletions > 0 && <span className="changes-del">-{totals.deletions}</span>}
            </span>
          )}
        </div>
        {changes.length > 5 && (
          <div className="artifacts-search-box">
            <IconSearch size={13} className="artifacts-search-icon" />
            <input
              type="text"
              className="artifacts-search-input"
              placeholder="过滤变更文件..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
        )}
      </div>
      <div className="extension-panel-nav changes-panel-content">
        {listNode}
      </div>
    </div>
  );
}
