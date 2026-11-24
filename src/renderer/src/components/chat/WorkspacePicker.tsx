import { useMemo, useRef, useState } from "react";
import { useDismissOnClickOutside } from "@/hooks/useDismissOnClickOutside";
import { useAppStore } from "@/store/appStore";
import WorkspaceIcon from "@/components/workspace/WorkspaceIcon";
import { getWorkspaceDisplayPath, COPY } from "@/lib/workspaceDisplay";
import { createTaskWorktreeId } from "@shared/task-worktree";
import {
  IconCheck,
  IconChevronDown,
  IconFolder,
  IconPlus,
  IconSearch,
} from "@/components/common/icons";

type PickerMode = "default-workspace" | "task-workspace" | "draft-workspace" | "selection";

interface Props {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  mode?: PickerMode;
  taskId?: string;
  compact?: boolean;
  selectedSpaceId?: string | null;
  onSelectSpace?: (spaceId: string | null) => void;
  allowIndependent?: boolean;
  showCreateActions?: boolean;
  excludedSpaceIds?: readonly string[];
}

export default function WorkspacePicker({
  open,
  onToggle,
  onClose,
  mode,
  taskId,
  compact,
  selectedSpaceId,
  onSelectSpace,
  allowIndependent = true,
  showCreateActions = true,
  excludedSpaceIds = [],
}: Props): React.JSX.Element {
  const spaces = useAppStore((s) => s.spaces);
  const homeSpaceId = useAppStore((s) => s.homeSpaceId);
  const setHomeSpaceId = useAppStore((s) => s.setHomeSpaceId);
  const draftSpaceId = useAppStore((s) => s.draft?.spaceId ?? null);
  const activeTaskId = useAppStore((s) => s.activeTaskId);
  const tasks = useAppStore((s) => s.tasks);
  const addSpace = useAppStore((s) => s.addSpace);
  const openLocalFolder = useAppStore((s) => s.openLocalFolder);
  const bindTaskSpace = useAppStore((s) => s.bindTaskSpace);

  // 为兼容旧调用：无 mode 时首页视为 default-workspace（仅改 homeSpaceId）
  const displayMode: PickerMode = mode ?? (taskId ? "task-workspace" : activeTaskId ? "task-workspace" : "default-workspace");

  const [query, setQuery] = useState("");
  const anchorRef = useRef<HTMLDivElement>(null);

  useDismissOnClickOutside(open, onClose, anchorRef);

  const visibleSpaces = useMemo(() => {
    const q = query.trim().toLowerCase();
    return spaces
      .filter((s) => !(s.effectiveArchived ?? s.archived))
      .filter((s) => !excludedSpaceIds.includes(s.id))
      .filter((s) => q === "" || s.name.toLowerCase().includes(q));
  }, [spaces, query, excludedSpaceIds]);

  const selectedId = (() => {
    if (displayMode === "selection") return selectedSpaceId ?? null;
    if (displayMode === "task-workspace") {
      const tid = taskId ?? activeTaskId;
      const t = tid ? tasks.find((x) => x.id === tid) : null;
      return t?.spaceId ?? null;
    }
    if (displayMode === "draft-workspace") return draftSpaceId ?? null;
    return homeSpaceId;
  })();
  const selected = spaces.find((s) => s.id === selectedId);

  const triggerLabel = (() => {
    if (displayMode === "selection") return selected ? getWorkspaceDisplayPath(spaces as any, selected.id) : "选择工作空间";
    if (compact) return selected?.name ?? (selectedId == null ? "独立任务" : "工作空间");
    if (displayMode === "task-workspace") return selected ? getWorkspaceDisplayPath(spaces as any, selected.id) : "独立任务";
    if (displayMode === "draft-workspace") return selected ? getWorkspaceDisplayPath(spaces as any, selected.id) : "独立任务";
    return selected ? getWorkspaceDisplayPath(spaces as any, selected.id) : "选择工作空间";
  })();

  const pick = (id: string | null): void => {
    const currentTaskId = taskId ?? activeTaskId;
    if (displayMode === "selection") {
      onSelectSpace?.(id);
    } else if (displayMode === "default-workspace") {
      setHomeSpaceId(id);
    } else if (displayMode === "task-workspace" && currentTaskId) {
      bindTaskSpace(currentTaskId, id);
    } else {
      useAppStore.setState(({ draft }) => {
        const spaceId = id ?? undefined;
        const worktreeTaskId = draft?.worktreeTaskId;
        // Provisioning receipts belong to one target. Keep the switch on with a fresh id for a new target.
        return { draft: { ...draft, spaceId, worktreeTaskId: worktreeTaskId && spaceId !== draft?.spaceId
          ? createTaskWorktreeId() : worktreeTaskId } };
      });
    }
    onClose();
  };

  return (
    <div className="input-popup-anchor workspace-picker-anchor" ref={anchorRef}>
      <button type="button" className="pill-select as-btn workspace-trigger" onClick={onToggle} title={displayMode === "selection" ? "选择目标工作空间" : displayMode === "default-workspace" ? "默认工作空间" : displayMode === "task-workspace" ? "此任务的工作空间" : "新任务工作空间"}>
        {triggerLabel}
        <IconChevronDown size={12} className={open ? "chevron-up" : ""} />
      </button>
      {open && (
        <div className="workspace-popup" onClick={(e) => e.stopPropagation()}>
          <div className="workspace-popup-search">
            <IconSearch size={14} />
            <input
              placeholder="搜索工作空间"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="workspace-popup-list">
            {allowIndependent && (
              <button
                type="button"
                className={`workspace-popup-item ${selectedId === null ? "active" : ""}`}
                onClick={() => pick(null)}
              >
                <span className="workspace-none-icon">—</span>
                <span className="workspace-popup-name">{COPY.independentTask}</span>
                {selectedId === null && <IconCheck size={14} />}
              </button>
            )}
            {visibleSpaces.map((space) => (
              <button
                key={space.id}
                type="button"
                className={`workspace-popup-item ${selectedId === space.id ? "active" : ""}`}
                onClick={() => pick(space.id)}
                title={getWorkspaceDisplayPath(spaces as any, space.id)}
              >
                <WorkspaceIcon icon={space.icon} size={15} />
                <span className="workspace-popup-main">
                  <span className="workspace-popup-name">{getWorkspaceDisplayPath(spaces as any, space.id)}</span>
                  {space.pathMissing ? (
                    <span className="workspace-popup-path missing">文件夹已移动，打开新位置可找回任务</span>
                  ) : space.path ? (
                    <span className="workspace-popup-path">{space.path}</span>
                  ) : null}
                </span>
                {selectedId === space.id && <IconCheck size={14} />}
              </button>
            ))}
            {visibleSpaces.length === 0 && (
              <div className="workspace-popup-empty">无匹配工作空间</div>
            )}
          </div>
          {showCreateActions && <div className="workspace-popup-footer">
            <button
              type="button"
              className="workspace-popup-action"
              onClick={() => {
                addSpace();
                onClose();
              }}
            >
              <IconPlus size={14} /> 新建工作空间
            </button>
            <button
              type="button"
              className="workspace-popup-action"
              onClick={() => {
                onClose();
                void openLocalFolder();
              }}
            >
              <IconFolder size={14} /> 打开本地文件夹
            </button>
          </div>}
        </div>
      )}
    </div>
  );
}
