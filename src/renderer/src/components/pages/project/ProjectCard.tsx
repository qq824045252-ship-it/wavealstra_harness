import { useEffect, useRef, useState } from "react";
import { IconFolderKanban, IconMore } from "@/components/common/icons";
import { useDismissOnClickOutside } from "@/hooks/useDismissOnClickOutside";
import { formatRelativeTime, resolveProjectLastActivityAt } from "@/lib/projectWorkspace";
import type { ProjectAttentionDigestDto, ProjectDto } from "@shared/project-domain";
import type { Task } from "@/types";

interface Props {
  project: ProjectDto;
  tasks: readonly Task[];
  menuOpen: boolean;
  onMenuOpen: () => void;
  onMenuClose: () => void;
  onEnter: () => void;
  onEdit: () => void;
  onArchive: () => void;
  onDelete: () => void;
}

/** 首页 Project 卡片：轻量入口，只展示 icon、名称、一行描述与最近时间，不承载元数据。 */
export default function ProjectCard({
  project,
  tasks,
  menuOpen,
  onMenuOpen,
  onMenuClose,
  onEnter,
  onEdit,
  onArchive,
  onDelete,
}: Props): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  useDismissOnClickOutside(menuOpen, onMenuClose, menuRef);
  const [attention, setAttention] = useState<ProjectAttentionDigestDto | null>(null);

  // 事件驱动注意度（不轮询）：挂载拉取 + 订阅主进程广播
  useEffect(() => {
    let cancelled = false;
    void window.api?.db?.getProjectAttention(project.id).then((digest) => {
      if (!cancelled) setAttention(digest);
    });
    const unsubscribe = window.api?.db?.onProjectAttentionChanged?.((digest) => {
      if (digest.projectId === project.id) setAttention(digest);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [project.id]);

  const hasIssues =
    attention !== null &&
    (attention.health !== "green" || attention.blockerCount > 0 || attention.atRiskCount > 0 || attention.needsConfirmation > 0);
  const counts = attention
    ? `${attention.blockerCount + attention.atRiskCount}`
    : "";

  const acknowledge = (): void => {
    void window.api?.db?.acknowledgeProjectAttention(project.id).then((digest) => {
      if (digest) setAttention(digest);
    });
  };

  return (
    <article className="project-home-card">
      <button type="button" className="project-home-card-open" onClick={onEnter}>
        <span className="project-home-card-icon" aria-hidden>
          <IconFolderKanban size={16} />
        </span>
        <span className="project-home-card-name">{project.name}</span>
        <span className="project-home-card-desc">{project.description || "暂无描述"}</span>
        {hasIssues && (
          <span
            className={`project-attention-badge ${attention!.health === "red" ? "att-red" : "att-yellow"} ${attention!.seen ? "att-seen" : "att-new"}`}
            title={`${attention!.health === "red" ? "有阻塞" : "有风险"}：阻塞/风险 ${attention!.blockerCount + attention!.atRiskCount} 项，待确认 ${attention!.needsConfirmation}`}
          >
            {attention!.health === "red" ? "🔴" : "🟡"}
            {counts}
          </span>
        )}
        <span className="project-home-card-time">
          {formatRelativeTime(resolveProjectLastActivityAt(project, tasks))}
        </span>
      </button>
      {hasIssues && !attention!.seen && (
        <button
          type="button"
          className="project-attention-ack"
          title="确认已查看（状态变化后重新提醒）"
          onClick={(e) => {
            e.stopPropagation();
            acknowledge();
          }}
        >
          ✓
        </button>
      )}
      <div className="project-home-card-menu" ref={menuRef}>
        <button
          type="button"
          className="icon-btn"
          title="更多"
          aria-label={`${project.name} 更多操作`}
          aria-expanded={menuOpen}
          onClick={(event) => {
            event.stopPropagation();
            if (menuOpen) onMenuClose();
            else onMenuOpen();
          }}
        >
          <IconMore size={16} />
        </button>
        {menuOpen && (
          <div className="project-overflow">
            <button type="button" className="workspace-popup-item" onClick={() => { onMenuClose(); onEnter(); }}>
              打开项目
            </button>
            <button type="button" className="workspace-popup-item" onClick={() => { onMenuClose(); onEdit(); }}>
              重命名
            </button>
            <button type="button" className="workspace-popup-item" onClick={() => { onMenuClose(); onArchive(); }}>
              {project.archived ? "恢复" : "归档"}
            </button>
            <button type="button" className="workspace-popup-item danger" onClick={() => { onMenuClose(); onDelete(); }}>
              删除
            </button>
          </div>
        )}
      </div>
    </article>
  );
}
