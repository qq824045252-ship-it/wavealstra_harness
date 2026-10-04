import { useEffect, useState } from "react";
import { IconFolderKanban } from "@/components/common/icons";
import { resolveProjectTaskCrumb } from "@/lib/projectWorkspace";
import { useAppStore } from "@/store/appStore";

interface Props {
  projectId: string;
  /** 后面还有任务标题时补一条 / */
  trailingSlash?: boolean;
}

export default function ChatProjectCrumb({ projectId, trailingSlash = false }: Props): React.JSX.Element | null {
  const projects = useAppStore((state) => state.projects);
  const openProjectDetails = useAppStore((state) => state.openProjectDetails);
  const requestProjectsRoot = useAppStore((state) => state.requestProjectsRoot);
  const listed = projects.find((project) => project.id === projectId);
  const [fetchedName, setFetchedName] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId || listed) {
      setFetchedName(null);
      return;
    }
    let cancelled = false;
    void window.api?.db?.getProject?.(projectId).then((project) => {
      if (!cancelled) setFetchedName(project?.name ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, listed]);

  const crumb = resolveProjectTaskCrumb({
    projectId,
    projectName: listed?.name ?? fetchedName,
  });
  if (!crumb) return null;

  return (
    <nav className="chat-project-crumb" aria-label="项目路径">
      <button
        type="button"
        className="chat-project-crumb-link"
        title="返回项目列表"
        onClick={() => requestProjectsRoot()}
      >
        <IconFolderKanban size={14} />
        项目
      </button>
      <span className="chat-project-crumb-sep">/</span>
      <button
        type="button"
        className="chat-project-crumb-link chat-project-crumb-name"
        title={`返回「${crumb.projectName}」`}
        onClick={() => openProjectDetails(crumb.projectId)}
      >
        {crumb.projectName}
      </button>
      {trailingSlash && <span className="chat-project-crumb-sep">/</span>}
    </nav>
  );
}
