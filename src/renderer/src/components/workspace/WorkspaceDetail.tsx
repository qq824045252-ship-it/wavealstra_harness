import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceFileNodeDto } from "@shared/agent-ipc";
import type { GadgetListItem } from "@shared/gadget-types";
import { useAppStore } from "@/store/appStore";
import WorkspaceSharedContextSection from "./WorkspaceSharedContextSection";
import WorkspaceMemorySection from "./WorkspaceMemorySection";
import WorkspaceLibraryBindingsSection from "./WorkspaceLibraryBindingsSection";
import WorkspaceNotesSection from "./WorkspaceNotesSection";
import WorkspaceFilesStandalone from "./WorkspaceFilesStandalone";
import WorkspaceGadgetsSection from "./WorkspaceGadgetsSection";
import TerminalView from "@/components/artifact/TerminalView";
import BlueprintCaptureDialog from "@/components/blueprint/BlueprintCaptureDialog";
import MoveWorkspaceDialog from "./MoveWorkspaceDialog";
import { IconFolder, IconFolderOpen, IconChevronRight } from "@/components/common/icons";
import { getWorkspaceBreadcrumb } from "@/lib/workspaceDisplay";
import { useDismissOnClickOutside } from "@/hooks/useDismissOnClickOutside";

type Tab = "overview" | "notes" | "memory" | "context" | "library" | "files" | "gadgets" | "terminal";
const TAB_LABELS: Record<Tab, string> = { overview: "概览", notes: "便签", memory: "记忆", context: "上下文", library: "资料库", files: "文件", gadgets: "Gadgets", terminal: "终端" };

function relativeTimeLabel(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

function countFiles(nodes: WorkspaceFileNodeDto[]): number {
  return nodes.reduce((count, node) => count + (node.kind === "file" ? 1 : 0) + countFiles(node.children ?? []), 0);
}

export default function WorkspaceDetail(): React.JSX.Element | null {
  const spaces = useAppStore((state) => state.spaces);
  const tasks = useAppStore((state) => state.tasks);
  const projection = useAppStore((state) => state.artifactProjection);
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId);
  const openWorkspaceDetail = useAppStore((state) => state.openWorkspaceDetail);
  const newTask = useAppStore((state) => state.newTask);
  const setActiveTask = useAppStore((state) => state.setActiveTask);
  const [tab, setTab] = useState<Tab>("overview");
  const [moreOpen, setMoreOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameVal, setRenameVal] = useState("");
  const [renameErr, setRenameErr] = useState<string | null>(null);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [fileCount, setFileCount] = useState<number | null>(null);
  const [gadgets, setGadgets] = useState<GadgetListItem[]>([]);
  const [contextCounts, setContextCounts] = useState({ local: 0, inherited: 0 });
  const [libraryCounts, setLibraryCounts] = useState({ direct: 0, inherited: 0 });
  const [memoryCounts, setMemoryCounts] = useState({ direct: 0, inherited: 0 });
  const [memoryVersion, setMemoryVersion] = useState(0);
  const moreRef = useRef<HTMLDivElement>(null);
  useDismissOnClickOutside(moreOpen, () => setMoreOpen(false), moreRef);

  const space = useMemo(() => spaces.find((item) => item.id === activeWorkspaceId) ?? null, [spaces, activeWorkspaceId]);
  const children = useMemo(() => spaces.filter((item) => (item.parentId ?? null) === activeWorkspaceId && !item.effectiveArchived), [spaces, activeWorkspaceId]);
  const spaceTasks = useMemo(() => tasks.filter((task) => task.spaceId === activeWorkspaceId && !task.archived), [tasks, activeWorkspaceId]);
  const activeTasks = useMemo(() => spaceTasks.filter((task) => task.status === "in_progress" || task.status === "planning"), [spaceTasks]);
  const shownTasks = useMemo(() => [...(activeTasks.length ? activeTasks : spaceTasks)].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6), [activeTasks, spaceTasks]);
  const recentArtifacts = useMemo(() => spaceTasks.flatMap((task) => projection.artifactsByTask[task.id] ?? []).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5), [spaceTasks, projection.artifactsByTask]);

  useEffect(() => {
    const unsubscribe = window.api?.db?.onMemoryChanged?.(() => setMemoryVersion((version) => version + 1));
    return () => {
      try { unsubscribe?.(); } catch {}
    };
  }, []);

  useEffect(() => {
    if (!space) return;
    let cancelled = false;
    setFileCount(space.path ? null : 0);
    for (const task of spaceTasks) void useAppStore.getState().hydrateArtifacts(task.id);
    void Promise.allSettled([
      space.path && !space.pathMissing ? window.api?.listWorkspaceFiles?.(space.path) ?? Promise.resolve([]) : Promise.resolve([]),
      window.api?.gadget?.list({ scope: { type: "workspace", workspaceId: space.id }, includeInherited: true }) ?? Promise.resolve([]),
      window.api?.workspace?.getSharedContextView({ currentSpaceId: space.id, taskId: null }),
      window.api?.workspace?.libraryBindings?.list(space.id),
      window.api?.memory?.search({ workspaceId: space.id, scopeTypes: ["workspace"], statuses: ["active"], includeInherited: true, limit: 100 }) ?? Promise.resolve([]),
    ]).then(([filesResult, gadgetResult, contextResult, libraryResult, memoryResult]) => {
      if (cancelled) return;
      setFileCount(filesResult.status === "fulfilled" ? countFiles(filesResult.value as WorkspaceFileNodeDto[]) : 0);
      setGadgets(gadgetResult.status === "fulfilled" ? gadgetResult.value as GadgetListItem[] : []);
      if (contextResult.status === "fulfilled" && contextResult.value) setContextCounts({ local: contextResult.value.grouped.local.length, inherited: contextResult.value.grouped.inherited.length });
      if (libraryResult.status === "fulfilled" && libraryResult.value) setLibraryCounts({ direct: libraryResult.value.direct.length, inherited: libraryResult.value.inherited.length });
      if (memoryResult.status === "fulfilled" && memoryResult.value) {
        const hits = memoryResult.value;
        const direct = hits.filter((hit) => hit.memory.scopes.some((scope) => scope.scopeType === "workspace" && scope.scopeId === space.id)).length;
        setMemoryCounts({ direct, inherited: hits.length - direct });
      }
    });
    return () => { cancelled = true; };
  }, [space?.id, space?.path, space?.pathMissing, spaceTasks.map((task) => task.id).join("|"), memoryVersion]);

  if (!space) return null;
  const breadcrumb = getWorkspaceBreadcrumb(spaces as any, space.id);
  const directGadgets = gadgets.filter((item) => !item.inherited);
  const description = space.path ? "长期工作空间 · 已连接本地文件夹" : "长期工作空间 · 汇总任务、记忆、上下文、资料与工具";

  const handleRename = async (): Promise<void> => {
    const value = renameVal.trim();
    if (!value) { setRenameErr("名称不能为空"); return; }
    if (!await useAppStore.getState().renameSpace(space.id, value)) { setRenameErr("重命名失败：名称可能已被占用"); return; }
    setRenameOpen(false); setRenameErr(null);
  };
  const openArtifact = (taskId: string, artifactId: string): void => {
    setActiveTask(taskId);
    queueMicrotask(() => useAppStore.getState().openArtifact(artifactId));
  };

  return <div className="workspace-detail">
    <header className="workspace-detail-header">
      {breadcrumb.length > 1 && <div className="workspace-detail-breadcrumb" aria-label="工作空间路径">{breadcrumb.slice(0, -1).map((segment, index, parents) => <span key={segment.id} className="workspace-breadcrumb-seg"><button className="workspace-breadcrumb-btn" onClick={() => openWorkspaceDetail(segment.id)}>{segment.name}</button>{index < parents.length - 1 && <IconChevronRight size={12} />}</span>)}</div>}
      <div className="workspace-detail-title-row"><div className="workspace-detail-identity"><div className="workspace-detail-name-row"><span className={`workspace-detail-icon${space.pathMissing ? " workspace-detail-icon--warn" : ""}`} aria-hidden="true">{space.pathMissing ? <IconFolder size={20} strokeWidth={1.8} /> : <IconFolderOpen size={20} strokeWidth={1.8} />}</span><div className="workspace-detail-heading"><h1>{space.name}</h1></div>{space.archived && <span className="workspace-detail-badge">已归档</span>}{space.pathMissing && <span className="workspace-detail-badge workspace-detail-badge--warn">文件夹丢失</span>}</div><div className="workspace-detail-meta"><p>{description}</p><div className="workspace-detail-summary">{activeTasks.length} 个进行中任务 · {memoryCounts.direct + memoryCounts.inherited} 条记忆 · {fileCount ?? "…"} 个文件 · {directGadgets.length} 个 Gadget</div></div></div>
        <div className="workspace-detail-actions"><button className="btn btn--primary" onClick={() => newTask(space.id)}>新建任务</button><div className="workspace-detail-more-anchor" ref={moreRef}><button className="btn btn--ghost workspace-kebab" aria-label="Workspace actions" onClick={() => setMoreOpen((value) => !value)}>•••</button>{moreOpen && <div className="workspace-detail-more-menu">
          <button className="workspace-detail-more-item" onClick={() => { setMoreOpen(false); setTab("terminal"); }}>打开终端</button>
          <button className="workspace-detail-more-item" onClick={async () => { setMoreOpen(false); const id = await useAppStore.getState().addSpace(space.id); if (id) openWorkspaceDetail(id); }}>新建子工作空间</button>
          <button className="workspace-detail-more-item" onClick={() => { setMoreOpen(false); void useAppStore.getState().relocateSpace(space.id); }}>绑定 / 重新定位文件夹</button>
          <button className="workspace-detail-more-item" onClick={() => { setMoreOpen(false); setRenameVal(space.name); setRenameOpen(true); }}>重命名</button>
          <button className="workspace-detail-more-item" onClick={() => { setMoreOpen(false); setMoveOpen(true); }}>移动</button>
          <button className="workspace-detail-more-item" onClick={() => { setMoreOpen(false); setCaptureOpen(true); }}>保存为 Blueprint</button>
          <button className="workspace-detail-more-item" onClick={() => { setMoreOpen(false); void useAppStore.getState().archiveSpace(space.id); }}>归档</button>
          <button className="workspace-detail-more-item workspace-detail-more-item--danger" onClick={() => { setMoreOpen(false); void useAppStore.getState().deleteSpace(space.id).catch(() => undefined); }}>删除</button>
        </div>}</div></div>
      </div>
    </header>

    <nav className="workspace-detail-tabs">{(Object.keys(TAB_LABELS) as Tab[]).map((key) => <button key={key} className={`workspace-detail-tab ${tab === key ? "active" : ""}`} onClick={() => setTab(key)}>{TAB_LABELS[key]}</button>)}</nav>
    <div className={`workspace-detail-body${tab === "terminal" ? " workspace-detail-body--terminal" : ""}`}>
      {tab === "overview" && <div className="workspace-overview">
        <section className="workspace-overview-section"><div className="workspace-overview-section-head"><h2>当前工作</h2><span>{spaceTasks.length}</span></div>{shownTasks.length ? <div className="workspace-overview-flat-list">{shownTasks.map((task) => <button key={task.id} className="workspace-overview-task-row" onClick={() => setActiveTask(task.id)}><span className={`ws-task-dot ${task.status === "in_progress" ? "on" : ""}`} /><span className="ws-task-name">{task.title || "未命名任务"}</span><span className="ws-task-time">{relativeTimeLabel(task.updatedAt)}</span></button>)}</div> : <div className="workspace-overview-empty"><strong>还没有任务</strong><span>从这个工作空间创建第一项任务。</span><button className="btn btn--primary" onClick={() => newTask(space.id)}>新建任务</button></div>}</section>
        <section className="workspace-overview-section"><div className="workspace-overview-section-head"><h2>子工作空间</h2><span>{children.length}</span></div>{children.length ? <div className="workspace-overview-flat-list">{children.map((child) => <button key={child.id} className="workspace-overview-child-row" onClick={() => openWorkspaceDetail(child.id)}><span><IconFolder size={15} />{child.name}</span><small>{tasks.filter((task) => task.spaceId === child.id && !task.archived).length} 个任务</small></button>)}</div> : <div className="workspace-overview-empty workspace-overview-empty--compact">暂无子工作空间</div>}</section>
        <section className="workspace-overview-section"><div className="workspace-overview-section-head"><h2>最近产物</h2><span>{recentArtifacts.length}</span></div>{recentArtifacts.length ? <div className="workspace-overview-flat-list">{recentArtifacts.map((artifact) => <button key={artifact.id} className="workspace-overview-artifact-row" onClick={() => openArtifact(artifact.taskId, artifact.id)}><span>{artifact.title || "未命名产物"}</span><small>{artifact.kind} · {relativeTimeLabel(artifact.updatedAt)}</small></button>)}</div> : <div className="workspace-overview-empty workspace-overview-empty--compact">工作空间任务产生的文件与产物会显示在这里。</div>}</section>
        <section className="workspace-overview-section"><div className="workspace-overview-section-head"><h2>Gadgets</h2><button className="workspace-overview-link" onClick={() => setTab("gadgets")}>查看全部</button></div>{directGadgets.length ? <div className="workspace-overview-flat-list">{directGadgets.slice(0, 3).map((gadget) => <button key={gadget.id} className="workspace-overview-gadget-row" onClick={() => setTab("gadgets")}><span>{gadget.name}</span><small>{gadget.runtime.status}</small></button>)}</div> : <div className="workspace-overview-empty workspace-overview-empty--compact">暂无工作空间 Gadget。</div>}</section>
        <section className="workspace-overview-section workspace-overview-section--summaries"><button className="workspace-overview-summary-row" onClick={() => setTab("memory")}><span><strong>记忆</strong><small>{memoryCounts.direct} 当前 · {memoryCounts.inherited} 继承</small></span><b>打开 →</b></button><button className="workspace-overview-summary-row" onClick={() => setTab("context")}><span><strong>上下文</strong><small>{contextCounts.local} 当前 · {contextCounts.inherited} 继承</small></span><b>打开 →</b></button><button className="workspace-overview-summary-row" onClick={() => setTab("library")}><span><strong>资料库</strong><small>{libraryCounts.direct} 当前 · {libraryCounts.inherited} 继承</small></span><b>打开 →</b></button></section>
      </div>}
      {tab === "memory" && <WorkspaceMemorySection workspaceId={space.id} />}
      {tab === "notes" && <WorkspaceNotesSection key={space.id} workspaceId={space.id} />}
      {tab === "context" && <WorkspaceSharedContextSection currentSpaceId={space.id} />}
      {tab === "library" && <WorkspaceLibraryBindingsSection key={space.id} currentSpaceId={space.id} />}
      {tab === "files" && <WorkspaceFilesStandalone spaceId={space.id} />}
      {tab === "gadgets" && <WorkspaceGadgetsSection workspaceId={space.id} />}
      {tab === "terminal" && <TerminalView />}
    </div>
    {renameOpen && <div className="workspace-rename-overlay"><div className="workspace-rename-card"><div className="workspace-rename-title">重命名工作空间</div><input className="workspace-rename-input" value={renameVal} onChange={(event) => { setRenameVal(event.target.value); setRenameErr(null); }} autoFocus />{renameErr && <div className="workspace-rename-error">{renameErr}</div>}<div className="workspace-rename-actions"><button className="btn" onClick={() => setRenameOpen(false)}>取消</button><button className="btn btn--primary" onClick={() => void handleRename()}>保存</button></div></div></div>}
    {captureOpen && <BlueprintCaptureDialog workspaceId={space.id} workspaceName={space.name} onClose={() => setCaptureOpen(false)} onSaved={() => setCaptureOpen(false)} />}
    {moveOpen && <MoveWorkspaceDialog workspaceId={space.id} workspaceName={space.name} onClose={() => setMoveOpen(false)} onMoved={() => setMoveOpen(false)} />}
  </div>;
}
