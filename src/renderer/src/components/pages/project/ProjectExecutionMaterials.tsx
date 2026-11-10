import { useEffect, useRef, useState } from "react";
import { useAppStore } from "@/store/appStore";
import ProjectFolderRelocation from "./ProjectFolderRelocation";
import type { ProjectDetailsDto } from "@shared/project-domain";
import type { RuntimeContextSnapshotDto } from "@shared/agent-ipc";
import { projectExecutionMaterialStatus, type ProjectMaterialExecutionStatus } from "@/lib/projectMaterials";

const statusLabels = { running: "执行中", completed: "已结束", failed: "失败", aborted: "已中止" };
const materialLabels = { "file-content": "文件返回内容", "knowledge-content": "资料正文", "web-content": "网页工具原文", "search-snippet": "检索片段", metadata: "仅元数据／链接" };

export function ProjectWorkFolder({ project, onRefresh }: {
  project: ProjectDetailsDto;
  onRefresh: () => Promise<void>;
}): React.JSX.Element {
  const spaces = useAppStore((state) => state.spaces);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const saving = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const folder = spaces.find((space) => space.id === project.defaultSpaceId);
  const usable = spaces.filter((space) => space.path && !space.archived && !space.effectiveArchived && !space.pathMissing);

  const saveFolder = async (id: string): Promise<void> => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true); setError(null);
    try {
      const result = await window.api?.db?.updateProject?.({ id: project.id, defaultSpaceId: id || null });
      if (!result?.ok) throw new Error(result?.error ?? "保存项目工作目录失败");
      if (alive.current) await onRefresh();
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : "保存失败"); }
    finally { saving.current = false; if (alive.current) setBusy(false); }
  };

  return <section className="project-material-card project-material-folder" aria-label="项目工作目录">
    <div className="project-material-card-head">
      <h3 className="project-material-card-title">项目工作目录</h3>
    </div>
    <div className="project-material-folder-row">
      <select aria-label="项目工作目录" className="new-project-input" value={project.defaultSpaceId ?? ""} disabled={busy || project.archived}
        onChange={(event) => void saveFolder(event.target.value)}>
        <option value="">未指定（沿用最近任务的选择）</option>
        {project.defaultSpaceId && !usable.some((space) => space.id === project.defaultSpaceId)
          && <option value={project.defaultSpaceId}>原工作目录不可用，请重新选择</option>}
        {usable.map((space) => <option key={space.id} value={space.id}>{space.name} · {space.path}</option>)}
      </select>
      <ProjectFolderRelocation key={project.id} project={project} onRefresh={onRefresh} />
    </div>
    <p className="project-desk-hint">{folder?.path ? `${folder.path}。` : ""}作为新任务的默认工作目录；已有任务继续使用各自原目录，目录内容不会自动进入上下文。</p>
    {error && <div className="project-material-notice is-error" role="alert">{error}</div>}
  </section>;
}

export default function ProjectExecutionMaterials({ project, onStatusChange }: {
  project: ProjectDetailsDto;
  onStatusChange?: (status: ProjectMaterialExecutionStatus) => void;
}): React.JSX.Element {
  const tasks = useAppStore((state) => state.tasks);
  const [error, setError] = useState<string | null>(null);
  const [taskId, setTaskId] = useState("");
  const [records, setRecords] = useState<RuntimeContextSnapshotDto[]>([]);
  const [executionId, setExecutionId] = useState("");
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const projectTasks = tasks.filter((task) => task.projectId === project.id);
  const selectedTask = projectTasks.find((task) => task.id === taskId);
  const record = records.find((item) => item.executionId === executionId);
  useEffect(() => { onStatusChange?.(projectExecutionMaterialStatus(record)); }, [record, onStatusChange]);

  useEffect(() => {
    let alive = true;
    setRecords([]); setExecutionId(""); setError(null);
    if (!selectedTask) { setLoading(false); return; }
    setLoading(true);
    void (async () => {
      try {
        const api = window.api?.agent?.listRuntimeContextSnapshots;
        if (!api) throw new Error("执行记录服务不可用，请重启应用");
        const result = await api(taskId, 30);
        if (!alive) return;
        const scoped = result.filter((item) => item.taskId === taskId && item.projectId === project.id);
        setRecords(scoped); setExecutionId(scoped[0]?.executionId ?? "");
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : "执行记录加载失败");
      } finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [taskId, selectedTask?.id, project.id, revision]);

  return <details className="project-material-card project-material-collapsible project-execution-materials">
    <summary className="project-material-summary">本次实际使用资料</summary>
    <p className="project-desk-hint">按任务和执行记录查看实际读取与注入的项目内容；配置了资料不代表已被使用。</p>
    <div className="project-desk-toolbar">
      <select aria-label="查看资料使用的任务" className="new-project-input" value={taskId} onChange={(event) => {
        setTaskId(event.target.value); setRecords([]); setExecutionId("");
      }}>
        <option value="">选择项目任务</option>
        {projectTasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
      </select>
      <button type="button" className="btn" disabled={!selectedTask || loading} onClick={() => setRevision((value) => value + 1)}>刷新记录</button>
    </div>
    {loading ? <p className="project-material-empty">正在加载执行记录…</p> : !selectedTask ? <p className="project-material-empty">选择任务后查看执行时记录的资料。</p> : !records.length ? <p className="project-material-empty">暂无该项目下的执行记录；当前配置不能证明资料已被使用。</p> : <>
      <select aria-label="选择执行记录" className="new-project-input" value={executionId} onChange={(event) => setExecutionId(event.target.value)}>
        {records.map((item) => <option key={item.executionId} value={item.executionId}>{new Date(item.startedAt).toLocaleString()} · {statusLabels[item.status]}</option>)}
      </select>
      {record && <div className="project-execution-record">
        <p>实际执行目录：{record.workingDirectory ?? "该历史记录未保存目录"}</p>
        <h4>执行中读取</h4>
        <p className="new-project-foot-hint">记录文件读取和项目知识工具返回的内容，不能证明模型已采纳。文件显示请求路径，相对路径以本次执行目录为基准；其他工具内部读取暂不覆盖。</p>
        {!record.materialUsage ? <p>该历史记录未启用读取证据。</p> : <>
          {record.materialUsage.items.length === 0 && <p>本次暂无已记录的成功读取返回。</p>}
          {record.materialUsage.items.map((item, index) => <details key={`${item.toolCallId}:${index}`}>
            <summary>{materialLabels[item.kind]} · {item.title}{item.partial ? "（片段／部分返回）" : ""}</summary>
            <p>{item.target}</p>
            <p>{new Date(item.at).toLocaleTimeString()} · {item.returnedChars} 字符{item.images ? ` · ${item.images} 张图片` : ""}
              {item.offset ? ` · 起始行 ${item.offset}` : ""}{item.limit ? ` · 请求最多 ${item.limit} 行` : ""}</p>
            <small>工具：{item.toolName} · 返回指纹：{item.outputHash}</small>
          </details>)}
          {record.materialUsage.omitted > 0 && <p>记录达到上限，另有 {record.materialUsage.omitted} 项未保留。</p>}
        </>}
        <h4>执行时注入</h4>
        <p className="new-project-foot-hint">以下为该次执行装配的项目内容。固定引用仅代表引用已提供，不代表正文已读取。</p>
        {record.resolvedInstructions.filter((item) => item.source === "project" && item.chars > 0).map((item) => <details key={item.id}>
          <summary>{item.title} · {item.chars} 字符{item.storage === "excerpt" ? "（记录仅保留节选）" : ""}</summary>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{item.content}</pre>
        </details>)}
        {!record.resolvedInstructions.some((item) => item.source === "project" && item.chars > 0) && <p>本次没有记录到项目内容注入。</p>}
        {record.warnings.length > 0 && <details><summary>装配提示（{record.warnings.length}）</summary>{record.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details>}
        <small>执行记录：{record.executionId}</small>
      </div>}
    </>}
    {error && <p className="project-material-notice is-error" role="alert">{error}</p>}
  </details>;
}
