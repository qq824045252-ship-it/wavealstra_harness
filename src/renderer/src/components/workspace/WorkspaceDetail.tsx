import { useBotWorkspaceNavigation, selectedWorkspaceRequest, clearWorkspaceRequest, openWorkspaceRequest, foregroundStatus } from "@/hooks/useBotWorkspaceNavigation";
import type { BotWorkspaceRequestDto } from "@shared/bot-workspace-navigation";
import { WorkspaceForegroundConversation } from "./WorkspaceForegroundConversation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceFileNodeDto } from "@shared/agent-ipc";
import type { GadgetListItem } from "@shared/gadget-types";
import { useActiveTerminalTabs, useAppStore } from "@/store/appStore";
import WorkspaceSharedContextSection from "./WorkspaceSharedContextSection";
import WorkspaceMemorySection from "./WorkspaceMemorySection";
import WorkspaceLibraryBindingsSection from "./WorkspaceLibraryBindingsSection";
import WorkspaceNotesSection from "./WorkspaceNotesSection";
import WorkspaceFilesStandalone from "./WorkspaceFilesStandalone";
import WorkspaceGadgetsSection from "./WorkspaceGadgetsSection";
import TerminalView from "@/components/artifact/TerminalView";
import TerminalTabsBar from "@/components/artifact/TerminalTabsBar";
import BlueprintCaptureDialog from "@/components/blueprint/BlueprintCaptureDialog";
import MoveWorkspaceDialog from "./MoveWorkspaceDialog";
import { IconFolder, IconFolderOpen, IconChevronRight } from "@/components/common/icons";
import { getWorkspaceBreadcrumb } from "@/lib/workspaceDisplay";
import { useDismissOnClickOutside } from "@/hooks/useDismissOnClickOutside";
import type { ProjectUnsavedGuard } from "@/lib/projectWorkspace";
import UnsavedChangesDialog from "@/components/pages/project/UnsavedChangesDialog";

type Tab = "overview" | "notes" | "memory" | "context" | "library" | "files" | "gadgets" | "terminal";
const TAB_LABELS: Record<Tab, string> = { overview: "概览", notes: "便签", memory: "记忆", context: "上下文", library: "资料", files: "文件", gadgets: "Gadgets", terminal: "终端" };

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
  const { requests: foregroundRequests, conversations: foregroundConversations, error: foregroundError } = useBotWorkspaceNavigation();
  const [foreground, setForeground] = useState<BotWorkspaceRequestDto | null>(null);
  const tasks = useAppStore((state) => state.tasks);
  const projection = useAppStore((state) => state.artifactProjection);
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId);
  const openWorkspaceDetail = useAppStore((state) => state.openWorkspaceDetail);
  useEffect(() => {
    const requested = selectedWorkspaceRequest(activeWorkspaceId);
    // StrictMode replays mount effects after the transient selection is consumed.
    // Preserve that exact request on replay, but never carry it to another space.
    setForeground(current => requested ?? (current?.spaceId === activeWorkspaceId ? current : null));
    if (requested) clearWorkspaceRequest();
    const open = (event: Event) => { const request = (event as CustomEvent<BotWorkspaceRequestDto>).detail; if (request.spaceId === activeWorkspaceId) { setForeground(request); clearWorkspaceRequest(); } };
    window.addEventListener('mybuddy:workspace-request', open);
    return () => window.removeEventListener('mybuddy:workspace-request', open);
  }, [activeWorkspaceId]);
  const [foregroundLimits, setForegroundLimits] = useState<Record<string, number>>({});
  const spaceConversations = foregroundConversations.filter(conversation => conversation.spaceId === activeWorkspaceId);
  const spaceRequests = foregroundRequests.filter(request => request.spaceId === activeWorkspaceId);
  const newTask = useAppStore((state) => state.newTask);
  const setActiveTask = useAppStore((state) => state.setActiveTask);
  const [tab, setTabNow] = useState<Tab>("overview");
  const materialGuard = useRef<ProjectUnsavedGuard | null>(null);
  const [pendingTab, setPendingTab] = useState<Tab | null>(null);
  const [guardBusy, setGuardBusy] = useState(false);
  const [guardError, setGuardError] = useState<string | null>(null);
  const setTab = (next: Tab): void => {
    if (next === tab || guardBusy) return;
    if (tab === "library" && materialGuard.current?.dirty) { setPendingTab(next); return; }
    setTabNow(next);
  };
  const finishTabChange = async (save: boolean): Promise<void> => {
    const next = pendingTab;
    if (!next || guardBusy) return;
    const ownerId = activeWorkspaceId;
    setGuardBusy(true); setGuardError(null);
    try {
      if (save) await materialGuard.current?.save();
      else materialGuard.current?.discard();
      if (useAppStore.getState().activeWorkspaceId === ownerId) { setTabNow(next); setPendingTab(null); }
    } catch (cause) {
      setGuardError(cause instanceof Error ? cause.message : "保存失败，请重试");
      setPendingTab(null);
    } finally { setGuardBusy(false); }
  };
  useEffect(() => { materialGuard.current = null; setPendingTab(null); setGuardError(null); }, [activeWorkspaceId]);
  const [moreOpen, setMoreOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameVal, setRenameVal] = useState("");
  const [renameErr, setRenameErr] = useState<string | null>(null);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [fileCount, setFileCount] = useState<number | null>(null);
  const [gadgets, setGadgets] = useState<GadgetListItem[]>([]);
  const { tabs: terminalTabs } = useActiveTerminalTabs();
  const [contextCounts, setContextCounts] = useState({ local: 0, inherited: 0 });
  const [libraryCounts, setLibraryCounts] = useState({ owned: 0, direct: 0, inherited: 0 });
  const [memoryCounts, setMemoryCounts] = useState({ direct: 0, inherited: 0 });
  const [memoryVersion, setMemoryVersion] = useState(0);
  const [materialsVersion, setMaterialsVersion] = useState(0);
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
      if (libraryResult.status === "fulfilled" && libraryResult.value) setLibraryCounts({ owned: libraryResult.value.ownedItemCount, direct: libraryResult.value.direct.length, inherited: libraryResult.value.inherited.length });
      if (memoryResult.status === "fulfilled" && memoryResult.value) {
        const hits = memoryResult.value;
        const direct = hits.filter((hit) => hit.memory.scopes.some((scope) => scope.scopeType === "workspace" && scope.scopeId === space.id)).length;
        setMemoryCounts({ direct, inherited: hits.length - direct });
      }
    });
    return () => { cancelled = true; };
  }, [space?.id, space?.path, space?.pathMissing, spaceTasks.map((task) => task.id).join("|"), memoryVersion, materialsVersion]);

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

  if (foreground?.spaceId === space.id) return <WorkspaceForegroundConversation key={foreground.id} request={foreground} conversationTitle={foregroundConversations.find(conversation => conversation.conversationId === foreground.conversationId)?.title} spaceName={space.name} onBack={() => { clearWorkspaceRequest(); setForeground(null); }} />;
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
          <button className="workspace-detail-more-item workspace-detail-more-item--danger" onClick={() => { setMoreOpen(false); void useAppStore.getState().deleteSpace(space.id).catch((error) => setGuardError(error instanceof Error ? error.message : "删除失败")); }}>删除</button>
        </div>}</div></div>
      </div>
    </header>

    <nav className="workspace-detail-tabs">
      {(Object.keys(TAB_LABELS) as Tab[]).map((key) => {
        const isTerminal = key === "terminal";
        const terminalCount = isTerminal ? terminalTabs.length : 0;
        return (
          <button
            key={key}
            className={`workspace-detail-tab ${tab === key ? "active" : ""}`}
            onClick={() => setTab(key)}
          >
            <span>{TAB_LABELS[key]}</span>
            {isTerminal && terminalCount > 0 && (
              <span className="workspace-tab-count-badge">
                {terminalCount > 99 ? "99+" : terminalCount}
              </span>
            )}
          </button>
        );
      })}
    </nav>
    <div className={`workspace-detail-body${tab === "terminal" ? " workspace-detail-body--terminal" : ""}`}>
      {tab === "overview" && <div className="workspace-overview">
        {foregroundError && <p role="alert">前台任务暂时无法加载：{foregroundError}</p>}
        {spaceConversations.length > 0 && <section className="workspace-overview-section"><div className="workspace-overview-section-head"><h2>前台对话</h2><span>{spaceConversations.length} 个对话 · {spaceRequests.length} 个任务</span></div>{spaceConversations.map(conversation => {
          const requests = spaceRequests.filter(request => request.conversationId === conversation.conversationId);
          const limit = foregroundLimits[conversation.conversationId] ?? 30;
          return <details key={conversation.conversationId} className="workspace-conversation-group" data-conversation-id={conversation.conversationId}><summary><span>{conversation.title}</span><small>{conversation.archived ? '历史对话 · ' : ''}{requests.length} 个任务</small></summary><div className="workspace-overview-flat-list">{requests.slice(0,limit).map(request => <button type="button" key={request.id} className="workspace-overview-task-row" onClick={()=>openWorkspaceRequest(request)}><span className={`ws-task-dot ${request.status === 'running' ? 'on' : ''}`} /><span className="ws-task-name">{request.title}</span><span className="ws-task-time">{foregroundStatus(request.status)}</span></button>)}</div>{requests.length===0 && <p>此对话还没有前台任务。</p>}{requests.length>limit && <button type="button" className="btn btn--ghost" onClick={()=>setForegroundLimits(current=>({...current,[conversation.conversationId]:limit+30}))}>再看 30 条 · 共 {requests.length} 条</button>}</details>;
        })}</section>}
        <section className="workspace-overview-section"><div className="workspace-overview-section-head"><h2>当前工作</h2><span>{spaceTasks.length}</span></div>{shownTasks.length ? <div className="workspace-overview-flat-list">{shownTasks.map((task) => <button key={task.id} className="workspace-overview-task-row" onClick={() => setActiveTask(task.id)}><span className={`ws-task-dot ${task.status === "in_progress" ? "on" : ""}`} /><span className="ws-task-name">{task.title || "未命名任务"}</span><span className="ws-task-time">{relativeTimeLabel(task.updatedAt)}</span></button>)}</div> : <div className="workspace-overview-empty"><strong>还没有任务</strong><span>从这个工作空间创建第一项任务。</span><button className="btn btn--primary" onClick={() => newTask(space.id)}>新建任务</button></div>}</section>
        <section className="workspace-overview-section"><div className="workspace-overview-section-head"><h2>子工作空间</h2><span>{children.length}</span></div>{children.length ? <div className="workspace-overview-flat-list">{children.map((child) => <button key={child.id} className="workspace-overview-child-row" onClick={() => openWorkspaceDetail(child.id)}><span><IconFolder size={15} />{child.name}</span><small>{tasks.filter((task) => task.spaceId === child.id && !task.archived).length} 个任务</small></button>)}</div> : <div className="workspace-overview-empty workspace-overview-empty--compact">暂无子工作空间</div>}</section>
        <section className="workspace-overview-section"><div className="workspace-overview-section-head"><h2>最近产物</h2><span>{recentArtifacts.length}</span></div>{recentArtifacts.length ? <div className="workspace-overview-flat-list">{recentArtifacts.map((artifact) => <button key={artifact.id} className="workspace-overview-artifact-row" onClick={() => openArtifact(artifact.taskId, artifact.id)}><span>{artifact.title || "未命名产物"}</span><small>{artifact.kind} · {relativeTimeLabel(artifact.updatedAt)}</small></button>)}</div> : <div className="workspace-overview-empty workspace-overview-empty--compact">工作空间任务产生的文件与产物会显示在这里。</div>}</section>
        <section className="workspace-overview-section"><div className="workspace-overview-section-head"><h2>Gadgets</h2><button className="workspace-overview-link" onClick={() => setTab("gadgets")}>查看全部</button></div>{directGadgets.length ? <div className="workspace-overview-flat-list">{directGadgets.slice(0, 3).map((gadget) => <button key={gadget.id} className="workspace-overview-gadget-row" onClick={() => setTab("gadgets")}><span>{gadget.name}</span><small>{gadget.runtime.status}</small></button>)}</div> : <div className="workspace-overview-empty workspace-overview-empty--compact">暂无工作空间 Gadget。</div>}</section>
        <section className="workspace-overview-section workspace-overview-section--summaries"><button className="workspace-overview-summary-row" onClick={() => setTab("memory")}><span><strong>记忆</strong><small>{memoryCounts.direct} 当前 · {memoryCounts.inherited} 继承</small></span><b>打开 →</b></button><button className="workspace-overview-summary-row" onClick={() => setTab("context")}><span><strong>上下文</strong><small>{contextCounts.local} 当前 · {contextCounts.inherited} 继承</small></span><b>打开 →</b></button><button className="workspace-overview-summary-row" onClick={() => setTab("library")}><span><strong>资料</strong><small>{libraryCounts.owned} 本空间文档 · {libraryCounts.direct} 引用 · {libraryCounts.inherited} 继承位置</small></span><b>打开 →</b></button></section>
      </div>}
      {tab === "memory" && <WorkspaceMemorySection workspaceId={space.id} />}
      {tab === "notes" && <WorkspaceNotesSection key={space.id} workspaceId={space.id} />}
      {tab === "context" && <WorkspaceSharedContextSection currentSpaceId={space.id} />}
      {guardError && <div className="workspace-memory-error" role="alert">{guardError}</div>}
      {tab === "library" && <WorkspaceLibraryBindingsSection key={space.id} currentSpaceId={space.id} onRegisterUnsaved={(guard) => { materialGuard.current = guard; }} onChanged={() => setMaterialsVersion((version) => version + 1)} />}
      {tab === "files" && <WorkspaceFilesStandalone spaceId={space.id} />}
      {tab === "gadgets" && <WorkspaceGadgetsSection workspaceId={space.id} />}
      {tab === "terminal" && (
        <div className="workspace-terminal-pane">
          <TerminalTabsBar />
          <TerminalView />
        </div>
      )}
    </div>
    {renameOpen && <div className="workspace-rename-overlay"><div className="workspace-rename-card"><div className="workspace-rename-title">重命名工作空间</div><input className="workspace-rename-input" value={renameVal} onChange={(event) => { setRenameVal(event.target.value); setRenameErr(null); }} autoFocus />{renameErr && <div className="workspace-rename-error">{renameErr}</div>}<div className="workspace-rename-actions"><button className="btn" onClick={() => setRenameOpen(false)}>取消</button><button className="btn btn--primary" onClick={() => void handleRename()}>保存</button></div></div></div>}
    {captureOpen && <BlueprintCaptureDialog workspaceId={space.id} workspaceName={space.name} onClose={() => setCaptureOpen(false)} onSaved={() => setCaptureOpen(false)} />}
    {moveOpen && <MoveWorkspaceDialog workspaceId={space.id} workspaceName={space.name} onClose={() => setMoveOpen(false)} onMoved={() => setMoveOpen(false)} />}
    <UnsavedChangesDialog open={pendingTab !== null} busy={guardBusy} onCancel={() => setPendingTab(null)} onDiscard={() => void finishTabChange(false)} onSave={() => void finishTabChange(true)} />
  </div>;
}
