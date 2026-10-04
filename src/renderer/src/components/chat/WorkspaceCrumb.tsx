import { useMemo } from "react";
import { IconFolder } from "@/components/common/icons";
import { useAppStore } from "@/store/appStore";
import { getWorkspaceDisplayPath, getWorkspaceBreadcrumb, COPY } from "@/lib/workspaceDisplay";

type Props = {
  spaceId?: string | null;
  onChange?: (next: string | null) => void;
};

export default function WorkspaceCrumb({ spaceId, onChange }: Props): React.JSX.Element {
  const spaces = useAppStore((s) => s.spaces);
  const openWorkspaceDetail = useAppStore((s) => s.openWorkspaceDetail);
  const draftSpaceId = useAppStore((s) => s.draft?.spaceId);
  const activeSpaceId = spaceId ?? draftSpaceId ?? null;
  const breadcrumb = useMemo(() => {
    if (!activeSpaceId) return [];
    return getWorkspaceBreadcrumb(spaces as any, activeSpaceId);
  }, [spaces, activeSpaceId]);

  if (!activeSpaceId) {
    return (
      <span className="workspace-crumb workspace-crumb--independent" title={COPY.independentTask}>
        <IconFolder size={12} /> {COPY.independentTask}
        {onChange && <button type="button" className="workspace-crumb-change" onClick={() => onChange(activeSpaceId)}>{COPY.saveToWorkspace}</button>}
      </span>
    );
  }
  const missing = !spaces.some((s) => s.id === activeSpaceId);
  const fullPath = missing ? "" : getWorkspaceDisplayPath(spaces as any, activeSpaceId);
  const label = missing ? "工作空间不可用" : breadcrumb[breadcrumb.length - 1]?.name ?? fullPath;
  const title = missing ? "所属空间不存在或已被归档" : fullPath;
  return (
    <span className={`workspace-crumb ${missing ? "workspace-crumb--missing" : "workspace-crumb--linked"}`} title={title}>
      <button
        type="button"
        className="workspace-crumb-link"
        disabled={missing}
        onClick={() => !missing && openWorkspaceDetail(activeSpaceId)}
        title={missing ? title : `${label} · 点击进入工作空间`}
      >
        <IconFolder size={12} />
        <span className="workspace-crumb-path">{label}</span>
      </button>
      {missing && <span className="workspace-crumb-missing">（已归档/丢失）</span>}
      {onChange && !missing && <button type="button" className="workspace-crumb-change" onClick={() => onChange(activeSpaceId)}>{COPY.changeWorkspace}</button>}
      {onChange && missing && <button type="button" className="workspace-crumb-change" onClick={() => onChange(activeSpaceId)}>更改</button>}
    </span>
  );
}
