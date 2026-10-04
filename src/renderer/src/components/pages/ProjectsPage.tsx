import { useEffect, useState } from "react";
import { useAppStore } from "@/store/appStore";
import NewProjectModal from "./NewProjectModal";
import ProjectList from "./project/ProjectList";
import ProjectWorkspace from "./project/ProjectWorkspace";

export default function ProjectsPage(): React.JSX.Element {
  const activeProjectId = useAppStore((state) => state.activeProjectId);
  const openProjectDetails = useAppStore((state) => state.openProjectDetails);
  const refreshProjects = useAppStore((state) => state.refreshProjects);
  const [showArchived, setShowArchived] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createTemplateId, setCreateTemplateId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2800);
    return () => clearTimeout(timer);
  }, [toast]);

  return (
    <>
      {error && <div className="project-page-banner">{error}</div>}
      {toast && (
        <div className="project-page-toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
      {activeProjectId ? (
        <ProjectWorkspace
          key={activeProjectId}
          projectId={activeProjectId}
          showArchived={showArchived}
          onToast={setToast}
        />
      ) : (
        <ProjectList
          showArchived={showArchived}
          onShowArchivedChange={setShowArchived}
          onCreate={(templateId) => {
            setCreateTemplateId(templateId ?? null);
            setCreateOpen(true);
          }}
          onEnter={(projectId) => openProjectDetails(projectId)}
          onEdit={(projectId) => openProjectDetails(projectId, "settings")}
          onToast={setToast}
          onError={setError}
        />
      )}
      <NewProjectModal
        open={createOpen}
        initialTemplateId={createTemplateId ?? undefined}
        onClose={() => setCreateOpen(false)}
        onSaved={(project, notice) => {
          void refreshProjects(showArchived);
          if (notice) setToast(notice);
          openProjectDetails(project.id);
        }}
      />
    </>
  );
}
