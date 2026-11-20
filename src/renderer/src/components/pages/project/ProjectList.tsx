import { useEffect, useMemo, useState } from "react";
import { IconFolderKanban, IconPlus, IconSearch } from "@/components/common/icons";
import ConfirmDialog from "@/components/common/ConfirmDialog";
import { DesktopSectionRow, DesktopSectionSidebar, useDesktopSectionState } from "@/components/desktop/DesktopSection";
import { useAppStore } from "@/store/appStore";
import { filterProjectsByQuery, matchesArchiveFilter } from "@/lib/projectWorkspace";
import { listProjectTemplates } from "@shared/project-template";
import type { ProjectDto } from "@shared/project-domain";
import ProjectCard from "./ProjectCard";
import ProjectTemplateCard from "./ProjectTemplateCard";
import "@/styles/project-home.css";
import "@/styles/desktop-project-automation.css";

interface Props {
  desktop?: boolean;
  showArchived: boolean;
  onShowArchivedChange: (value: boolean) => void;
  onCreate: (templateId?: string) => void;
  onEnter: (projectId: string) => void;
  onEdit: (projectId: string) => void;
  onToast: (text: string) => void;
  onError: (text: string | null) => void;
}

export default function ProjectList({
  desktop = false,
  showArchived,
  onShowArchivedChange,
  onCreate,
  onEnter,
  onEdit,
  onToast,
  onError,
}: Props): React.JSX.Element {
  const projects = useAppStore((state) => state.projects);
  const tasks = useAppStore((state) => state.tasks);
  const refreshProjects = useAppStore((state) => state.refreshProjects);
  const [query, setQuery] = useDesktopSectionState(desktop ? "projects:query" : null, "");
  const [loading, setLoading] = useState(projects.length === 0);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ type: "archive" | "delete"; project: ProjectDto } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void refreshProjects(showArchived)
      .catch((cause) => {
        if (!cancelled) onError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [onError, refreshProjects, showArchived]);

  const projectsInFilter = useMemo(
    () => projects.filter((project) => matchesArchiveFilter(project.archived, showArchived ? "archived" : "active")),
    [projects, showArchived],
  );
  const visible = useMemo(() => filterProjectsByQuery(projectsInFilter, query), [projectsInFilter, query]);
  const templates = useMemo(() => listProjectTemplates(), []);

  const archiveOrRestore = async (project: ProjectDto): Promise<void> => {
    setBusy(true);
    onError(null);
    try {
      const result = await window.api?.db?.archiveProject?.(project.id, !project.archived);
      if (!result?.ok) {
        onError(result?.error ?? "操作失败");
        return;
      }
      await refreshProjects(showArchived);
      onToast(project.archived ? `已恢复「${project.name}」` : `已归档「${project.name}」`);
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const remove = async (project: ProjectDto): Promise<void> => {
    setBusy(true);
    onError(null);
    try {
      await window.api?.db?.deleteProject?.(project.id);
      useAppStore.setState((state) => ({
        tasks: state.tasks.map((task) =>
          task.projectId === project.id ? { ...task, projectId: undefined } : task,
        ),
        activeProjectId: state.activeProjectId === project.id ? null : state.activeProjectId,
      }));
      await refreshProjects(showArchived);
      onToast(`已删除「${project.name}」`);
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  return (
    <div className={`page-scroll${desktop ? " project-home-desktop" : ""}`}>
      {desktop && (
        <DesktopSectionSidebar
          title="项目"
          scrollKey="projects"
          actions={<button type="button" className="icon-btn" aria-label="新建项目" title="新建项目" onClick={() => onCreate()}><IconPlus size={16} /></button>}
        >
          <DesktopSectionRow active={!showArchived} onClick={() => onShowArchivedChange(false)}>进行中</DesktopSectionRow>
          <DesktopSectionRow active={showArchived} onClick={() => onShowArchivedChange(true)}>已归档</DesktopSectionRow>
          <div className="desktop-section-group">项目列表</div>
          {visible.map((project) => (
            <DesktopSectionRow
              key={project.id}
              icon={<IconFolderKanban size={15} />}
              title={project.name}
              onClick={() => onEnter(project.id)}
            >
              {project.name}
            </DesktopSectionRow>
          ))}
        </DesktopSectionSidebar>
      )}
      <div className="page-container">
        <div className="project-page-head project-home-head">
          <div>
            <div className="page-title">{desktop ? "项目总览" : "项目"}</div>
            {!desktop && <div className="page-sub">让 AI 围绕一个长期目标持续工作</div>}
          </div>
          {!desktop && <div className="project-home-hero-art" aria-hidden="true"><i /><i /><i /><i /></div>}
          <button type="button" className="btn primary" onClick={() => onCreate()}>
            <IconPlus size={14} /> 新建项目
          </button>
        </div>

        <section className="project-home-section">
          <div className="project-home-section-head">
            <h2 className="project-home-section-title">我的项目</h2>
            <div className="project-home-section-tools">
              {!desktop && <div className="project-home-tabs" role="group" aria-label="项目归档筛选">
                <button
                  type="button"
                  className={!showArchived ? "active" : ""}
                  onClick={() => onShowArchivedChange(false)}
                >
                  进行中
                </button>
                <button
                  type="button"
                  className={showArchived ? "active" : ""}
                  onClick={() => onShowArchivedChange(true)}
                >
                  已归档
                </button>
              </div>}
              <div className="search-input project-home-search">
                <IconSearch size={14} />
                <input
                  placeholder="搜索项目"
                  aria-label="搜索项目"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
            </div>
          </div>

          {loading && projectsInFilter.length === 0 ? (
            <div className="project-loading">正在加载项目…</div>
          ) : visible.length === 0 ? (
            <div className="project-home-empty">
              <div className="project-home-empty-title">
                {projectsInFilter.length ? "没有匹配项目" : showArchived ? "没有已归档项目" : "还没有项目"}
              </div>
              <div className="project-home-empty-sub">
                {projectsInFilter.length ? "试试其他关键词" : !showArchived && "创建一个项目，让 AI 围绕同一个目标持续工作。"}
              </div>
              {!projectsInFilter.length && !showArchived && (
                <button type="button" className="btn primary" onClick={() => onCreate()}>
                  <IconPlus size={14} /> 新建项目
                </button>
              )}
            </div>
          ) : (
            <div className="project-home-grid">
              {visible.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  tasks={tasks}
                  menuOpen={menuId === project.id}
                  onMenuOpen={() => setMenuId(project.id)}
                  onMenuClose={() => setMenuId(null)}
                  onEnter={() => onEnter(project.id)}
                  onEdit={() => onEdit(project.id)}
                  onArchive={() => setConfirm({ type: "archive", project })}
                  onDelete={() => setConfirm({ type: "delete", project })}
                />
              ))}
            </div>
          )}
        </section>

        <section className="project-home-section">
          <div className="project-home-section-head">
            <h2 className="project-home-section-title">从模板创建</h2>
          </div>
          <div className="project-template-grid">
            {templates.map((template) => (
              <ProjectTemplateCard
                key={template.id}
                template={template}
                onPick={() => onCreate(template.id)}
              />
            ))}
          </div>
        </section>
      </div>

      <ConfirmDialog
        open={confirm?.type === "archive"}
        title={confirm?.project.archived ? `恢复项目 “${confirm.project.name}”？` : `归档项目 “${confirm?.project.name ?? ""}”？`}
        body={confirm?.project.archived
          ? "恢复后项目会重新出现在默认项目列表中。"
          : "归档后项目进入只读并停用所属自动化。历史任务不会删除；恢复后自动化需手动重新启用。"}
        confirmLabel={confirm?.project.archived ? "恢复项目" : "归档项目"}
        onCancel={() => !busy && setConfirm(null)}
        onConfirm={() => confirm && void archiveOrRestore(confirm.project)}
      />
      <ConfirmDialog
        open={confirm?.type === "delete"}
        title={`删除项目 “${confirm?.project.name ?? ""}”？`}
        body="此操作不可撤销。项目计划、记忆作用域、资料库和自动化会被删除；任务不会删除，只解除项目绑定。"
        confirmLabel="删除项目"
        danger
        onCancel={() => !busy && setConfirm(null)}
        onConfirm={() => confirm && void remove(confirm.project)}
      />
    </div>
  );
}
