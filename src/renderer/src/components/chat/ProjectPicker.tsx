import { useEffect, useMemo, useRef, useState } from "react";
import { useDismissOnClickOutside } from "@/hooks/useDismissOnClickOutside";
import { useAppStore } from "@/store/appStore";
import {
  IconCheck,
  IconChevronDown,
  IconFolderKanban,
  IconArrowUpRight,
  IconSearch,
} from "@/components/common/icons";

interface Props {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}

export default function ProjectPicker({ open, onToggle, onClose }: Props): React.JSX.Element {
  const projects = useAppStore((state) => state.projects);
  const tasks = useAppStore((state) => state.tasks);
  const activeTaskId = useAppStore((state) => state.activeTaskId);
  const draft = useAppStore((state) => state.draft);
  const bindProjectContext = useAppStore((state) => state.bindProjectContext);
  const setDraftProject = useAppStore((state) => state.setDraftProject);
  const openProjectDetails = useAppStore((state) => state.openProjectDetails);
  const [query, setQuery] = useState("");
  const [boundProjectName, setBoundProjectName] = useState<string | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);

  useDismissOnClickOutside(open, onClose, anchorRef);

  const task = tasks.find((item) => item.id === activeTaskId);
  const projectId = task?.projectId ?? draft?.projectId ?? null;
  const selected = projects.find((project) => project.id === projectId);
  useEffect(() => {
    if (!projectId || selected) {
      setBoundProjectName(null);
      return;
    }
    void window.api?.db?.getProject?.(projectId).then((project) => setBoundProjectName(project?.name ?? null));
  }, [projectId, selected]);
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return projects
      .filter((project) => !project.archived)
      .filter(
        (project) =>
          !normalized ||
          project.name.toLowerCase().includes(normalized) ||
          project.description?.toLowerCase().includes(normalized),
      );
  }, [projects, query]);

  const pick = (id: string | null): void => {
    if (activeTaskId) bindProjectContext(activeTaskId, id);
    else setDraftProject(id);
    onClose();
  };

  return (
    <div className="input-popup-anchor workspace-picker-anchor" ref={anchorRef}>
      <button type="button" className="pill-select as-btn workspace-trigger" onClick={onToggle}>
        <IconFolderKanban size={13} />
        {selected?.name ?? boundProjectName ?? "选择项目"}
        <IconChevronDown size={12} className={open ? "chevron-up" : ""} />
      </button>
      {open && (
        <div className="workspace-popup" onClick={(event) => event.stopPropagation()}>
          <div className="workspace-popup-search">
            <IconSearch size={14} />
            <input
              placeholder="搜索项目"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="workspace-popup-list">
            {projectId && (
              <button type="button" className="workspace-popup-item" onClick={() => { onClose(); openProjectDetails(projectId); }}>
                <IconArrowUpRight size={14} />
                <span className="workspace-popup-name">打开当前 Project</span>
              </button>
            )}
            <button
              type="button"
              className={`workspace-popup-item ${projectId === null ? "active" : ""}`}
              onClick={() => pick(null)}
            >
              <span className="workspace-none-icon">—</span>
              <span className="workspace-popup-name">不使用项目上下文</span>
              {projectId === null && <IconCheck size={14} />}
            </button>
            {visible.map((project) => (
              <button
                key={project.id}
                type="button"
                className={`workspace-popup-item ${projectId === project.id ? "active" : ""}`}
                onClick={() => pick(project.id)}
                title={project.description ?? project.name}
              >
                <IconFolderKanban size={15} />
                <span className="workspace-popup-main">
                  <span className="workspace-popup-name">{project.name}</span>
                  {project.description && (
                    <span className="workspace-popup-path">{project.description}</span>
                  )}
                </span>
                {projectId === project.id && <IconCheck size={14} />}
              </button>
            ))}
            {visible.length === 0 && <div className="workspace-popup-empty">无匹配项目</div>}
          </div>
        </div>
      )}
    </div>
  );
}
