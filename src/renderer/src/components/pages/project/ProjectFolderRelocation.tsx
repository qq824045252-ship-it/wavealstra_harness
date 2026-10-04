import { useEffect, useRef, useState } from "react";
import { useAppStore } from "@/store/appStore";
import type { ProjectDetailsDto, ProjectFolderPreview } from "@shared/project-domain";

export default function ProjectFolderRelocation({ project, onRefresh }: { project: ProjectDetailsDto; onRefresh: () => Promise<void> }): React.JSX.Element {
  const refreshProjects = useAppStore((state) => state.refreshProjects);
  const refreshSpaces = useAppStore((state) => state.refreshSpaces);
  const [preview, setPreview] = useState<ProjectFolderPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const lock = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const run = async (commit: boolean) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setMessage("");
    try {
      const api = window.api?.db;
      if (!api?.previewProjectFolder || !api.commitProjectFolder) throw new Error("目录重新关联服务不可用，请重启应用");
      if (commit && preview) {
        await api.commitProjectFolder(preview.token);
        if (!alive.current) return;
        setPreview(null); await refreshSpaces(); await refreshProjects(); await onRefresh();
        if (alive.current) setMessage("已重新关联目录和文件引用，磁盘文件未被移动或删除");
      } else {
        setPreview(null);
        const folder = await window.api?.pickLocalFolder?.();
        if (!folder || !alive.current) return;
        const result = await api.previewProjectFolder(project.id, folder.path);
        if (alive.current) setPreview(result);
      }
    } catch (cause) { if (alive.current) { setPreview(null); setMessage(cause instanceof Error ? cause.message : "目录重新关联失败"); } }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  return <div>
    <button className="btn" disabled={busy || project.archived || !project.defaultSpaceId} onClick={() => void run(false)}>文件夹已移动？重新关联</button>
    {preview && <div role="dialog" aria-label="确认重新关联项目目录" className="project-section">
      {!!preview.affectedProjects?.length && <p>影响项目：{preview.affectedProjects.map((item) => `${item.name}${item.archived ? "（已归档）" : ""}`).join("、")}。共享绑定将一起更新。</p>}
      {!!preview.folders?.length && <details><summary>查看 {preview.folders.length} 个文件夹的位置变化</summary>{preview.folders.map((item) => <p key={item.id}>{item.name}：{item.oldPath} → {item.newPath}</p>)}</details>}
      <p>原位置：{preview.oldPath}</p><p>新位置：{preview.newPath}</p>
      <p>将更新 {preview.tasks.length} 个任务共用的目录、{preview.references.length} 个文件引用与 {preview.artifacts?.length ?? 0} 个产物及其依赖。不会移动磁盘文件；历史执行记录保留原路径。</p>
      {(preview.references.some((item) => !item.oldExists) || preview.artifacts?.some((item) => item.missingOriginal)) && <p>部分原文件已不存在，只能确认新位置文件可读；请确认这是移动后的正确目录。</p>}
      <details><summary>查看受影响任务和资料</summary>{preview.tasks.map((task) => <p key={task.id}>任务：{task.title}（{task.projectId ? preview.affectedProjects?.find((item) => item.id === task.projectId)?.name ?? "项目任务" : "独立任务"}）</p>)}{preview.references.map((item) => <p key={item.id}>{item.title} → {item.newPath}</p>)}</details>
      {!!preview.artifacts?.length && <details><summary>查看受影响产物</summary>{preview.artifacts.map((item) => <p key={item.id}>{item.title} → {item.rootDir}（核对 {item.fileCount} 个文件）</p>)}</details>}
      <button className="btn primary" disabled={busy} onClick={() => void run(true)}>确认重新关联</button>
      <button className="btn" disabled={busy} onClick={() => setPreview(null)}>取消</button>
    </div>}
    {message && <p role="status">{message}</p>}
  </div>;
}
