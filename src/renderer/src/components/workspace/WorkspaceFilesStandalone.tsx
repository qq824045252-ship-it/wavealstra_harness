import { useState } from "react";
import { useAppStore } from "@/store/appStore";
import WorkspaceFilesView from "@/components/artifact/WorkspaceFilesView";
import "./WorkspaceFilesStandalone.css";

export default function WorkspaceFilesStandalone({ spaceId }: { spaceId: string }): React.JSX.Element {
  const spaces = useAppStore((s) => s.spaces);
  const space = spaces.find((item) => item.id === spaceId);
  const root = space?.path;
  const [query, setQuery] = useState("");

  // 优先级：missing-space > archived > path-missing > unbound > normal
  const filesUnavailableReason: "missing-space" | "archived" | "path-missing" | "unbound" | null =
    !space
      ? "missing-space"
      : space.archived
        ? "archived"
        : space.pathMissing
          ? "path-missing"
          : !root
            ? "unbound"
            : null;

  if (filesUnavailableReason === "missing-space") {
    return <div className="workspace-files-empty">工作空间不存在</div>;
  }
  if (filesUnavailableReason === "archived") {
    return (
      <div className="workspace-files-empty">
        <div>该工作空间已归档</div>
        <div style={{ marginTop: 6, opacity: 0.7, fontSize: 12 }}>归档空间暂不加载工作区文件。</div>
      </div>
    );
  }
  if (filesUnavailableReason === "path-missing") {
    return (
      <div className="workspace-files-empty">
        <div>工作区文件夹不可用</div>
        <div style={{ marginTop: 6, opacity: 0.7, fontSize: 12 }}>文件夹可能已被移动、重命名或删除。</div>
      </div>
    );
  }
  if (filesUnavailableReason === "unbound") {
    return <div className="workspace-files-empty">该工作空间尚未绑定文件夹</div>;
  }

  // 复用 artifact 侧「工作空间文件」树（折叠/右键/重命名/删除/拖拽全套能力），以空间文件夹为根
  return (
    <div className="workspace-files-standalone">
      <div className="workspace-files-path" title={root}>
        {root}
      </div>
      <div className="workspace-files-search-row">
        <input
          className="workspace-files-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索项目文件夹"
          aria-label="搜索项目文件夹"
        />
      </div>
      <WorkspaceFilesView spaceId={spaceId} query={query} />
    </div>
  );
}
