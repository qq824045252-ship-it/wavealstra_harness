import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LibraryOwnerScope } from "@shared/library-ipc";
import type { WorkspaceLibraryBindingItem, WorkspaceLibraryBindingListView } from "@shared/workspace-library-binding";
import type { ProjectUnsavedGuard } from "@/lib/projectWorkspace";
import { useAppStore } from "@/store/appStore";
import { ScopedLibraryManager } from "@/components/pages/library/ScopedLibraryManager";
import "./WorkspaceMemorySection.css";
import "./WorkspaceNotesSection.css";
import "./WorkspaceMaterialsSection.css";

interface Props {
  currentSpaceId: string | null;
  compact?: boolean;
  className?: string;
  onRegisterUnsaved?: (guard: ProjectUnsavedGuard | null) => void;
  onChanged?: () => void;
}

const bindingKey = (item: WorkspaceLibraryBindingItem): string => item.collectionId ? `collection:${item.collectionId}` : `space:${item.librarySpaceId}`;

export function ownerOfBinding(item: WorkspaceLibraryBindingItem): LibraryOwnerScope {
  if (item.projectId) return { type: "project", projectId: item.projectId };
  if (item.workspaceId) return { type: "workspace", workspaceId: item.workspaceId };
  // 旧无归属资料只能作为历史引用打开，不属于新的独立任务资料库。
  return { type: "personal" };
}

function ReferenceRow({ item, inheritedFrom, action, disabled, onAction, onOpen }: {
  item: WorkspaceLibraryBindingItem;
  inheritedFrom?: string;
  action?: string;
  disabled?: boolean;
  onAction?: () => void;
  onOpen: () => void;
}): React.JSX.Element {
  return <article className="workspace-memory-row">
    <div className="workspace-memory-row-main">
      <div className="workspace-memory-row-head">
        <strong title={item.path ?? item.name}>{item.name}</strong>
        <span className="workspace-memory-kind">{item.targetType === "collection" ? "文件夹" : item.projectId ? "项目资料" : item.workspaceId ? "空间资料" : "历史资料"}</span>
        {inheritedFrom && <span className="workspace-memory-scope-chip is-inherited">继承 · {inheritedFrom}</span>}
      </div>
      <div className="workspace-memory-scope-note">{item.path}</div>
      <div className="workspace-memory-scope-note">{item.collectionId ? "引用此文件夹及其子文件夹" : "引用此位置的资料，包括以后新增的内容"}{item.projectId ? "；仅该项目的任务可使用" : ""}</div>
    </div>
    <div className="workspace-memory-row-side">
      <button type="button" className="ws-binding-action" onClick={onOpen}>查看资料</button>
      {action && <button type="button" className="ws-binding-action" disabled={disabled} onClick={onAction}>{action}</button>}
    </div>
  </article>;
}

export default function WorkspaceMaterialsSection(props: Props): React.JSX.Element {
  // A reference mutation may finish after the user has selected another workspace.
  // Keep its lifecycle and callbacks attached to the workspace that started it.
  return <WorkspaceMaterialsBody key={props.currentSpaceId ?? "none"} {...props} />;
}

function WorkspaceMaterialsBody({ currentSpaceId, compact = false, className = "", onRegisterUnsaved, onChanged }: Props): React.JSX.Element {
  const space = useAppStore((state) => state.spaces.find((item) => item.id === currentSpaceId));
  const [view, setView] = useState<WorkspaceLibraryBindingListView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<WorkspaceLibraryBindingItem | null>(null);
  const mounted = useRef(false);
  const request = useRef(0);
  const mutation = useRef(false);
  const readOnly = Boolean(space?.archived || space?.effectiveArchived);
  const scope = useMemo<LibraryOwnerScope>(() => ({ type: "workspace", workspaceId: currentSpaceId ?? "" }), [currentSpaceId]);

  const reload = useCallback(async (): Promise<void> => {
    const ticket = ++request.current;
    if (!currentSpaceId) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const api = window.api?.workspace?.libraryBindings;
      if (!api) throw new Error("资料服务不可用，请重启应用");
      const next = await api.list(currentSpaceId);
      if (mounted.current && ticket === request.current) setView(next);
    } catch (cause) {
      if (mounted.current && ticket === request.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current && ticket === request.current) setLoading(false);
    }
  }, [currentSpaceId]);
  useEffect(() => {
    mounted.current = true;
    setView(null); setSelected(null); setNotice(null); setQuery("");
    void reload();
    return () => { mounted.current = false; request.current += 1; };
  }, [reload]);

  const changeReference = async (item: WorkspaceLibraryBindingItem, remove: boolean): Promise<void> => {
    if (!currentSpaceId || readOnly || mutation.current) return;
    mutation.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      const api = window.api?.workspace?.libraryBindings;
      if (!api) throw new Error("资料服务不可用，请重启应用");
      const req = { workspaceId: currentSpaceId, librarySpaceId: item.librarySpaceId, collectionId: item.collectionId };
      const result = await (remove ? api.unbind(req) : api.bind(req));
      if (!result.ok) throw new Error(result.error);
      if (!mounted.current) return;
      if (remove) setSelected(null);
      setNotice(remove ? "已取消引用，原资料仍保留在所属位置" : "已添加引用，按需读取，不复制原资料");
      onChanged?.();
      await reload();
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      mutation.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  if (!currentSpaceId) return <section className="workspace-memory-section"><h2>资料</h2><p>选择工作空间后，在这里管理它的资料。</p></section>;
  const addable = (view?.addable ?? []).filter((item) => !query.trim() || `${item.name} ${item.path ?? ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const direct = view?.direct ?? [];
  const inherited = view?.inherited ?? [];

  return <section className={`workspace-materials ${compact ? "compact" : ""} ${className}`}>
    <header className="workspace-memory-header">
      <div><h2>空间资料</h2><p>{space?.name ?? view?.workspaceName} · 在本处新建和导入，资料归这个工作空间所有。</p></div>
      <button type="button" className="btn" disabled={loading || busy} onClick={() => void reload()}>刷新引用</button>
    </header>
    <p className="workspace-materials-hint">磁盘上的工作文件在「文件」页管理；导入资料会保存一份受管副本，不会自动导入整个本地文件夹。</p>
    {readOnly && <p className="workspace-materials-hint">此工作空间已归档，这里保留历史资料供你查看；任务不再自动使用本空间及父级引用。已附加到任务或设为项目常用的资料仍按其权限回看。</p>}
    <ScopedLibraryManager scope={scope} name="本空间资料" readOnly={readOnly} onChanged={() => { void reload(); onChanged?.(); }} onRegisterUnsaved={onRegisterUnsaved} />
    <section className="workspace-materials-references" aria-label="引用资料">
      <h3>引用资料</h3>
      <p className="workspace-materials-hint">父级资料自动继承；其他位置须显式引用。这里查看引用，编辑和删除原文请到它的所属位置。</p>
      {error && <div className="workspace-memory-error" role="alert">{error}<button className="btn" onClick={() => void reload()}>重试</button></div>}
      {notice && <div className="ws-context-notice" role="status">{notice}</div>}
      {loading && !view && <p role="status">正在加载引用…</p>}
      <div className="ws-context-group"><div className="ws-context-group-head"><span className="ws-context-group-title">本空间引用</span><span>{direct.length}</span></div>
        {direct.length ? <div className="workspace-memory-list">{direct.map((item) => <ReferenceRow key={bindingKey(item)} item={item} action="取消引用" disabled={busy || readOnly} onAction={() => void changeReference(item, true)} onOpen={() => setSelected(item)} />)}</div> : <div className="ws-binding-empty">尚未引用其他位置的资料</div>}
      </div>
      <div className="ws-context-group"><div className="ws-context-group-head"><span className="ws-context-group-title">继承自父级</span><span>{inherited.length}</span></div>
        {inherited.length ? <div className="workspace-memory-list">{inherited.map((item) => <ReferenceRow key={`${item.sourceWorkspaceId}:${bindingKey(item)}`} item={item} inheritedFrom={item.sourceWorkspaceName ?? item.sourceWorkspaceId} onOpen={() => setSelected(item)} />)}</div> : <div className="ws-binding-empty">没有继承资料</div>}
      </div>
      {!readOnly && <details className="workspace-materials-add"><summary>添加已有资料引用</summary>
        <label className="workspace-materials-reference-search"><span>查找资料位置</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="按名称或所属位置查找" /></label>
        <p className="workspace-materials-hint">引用项目资料不会扩大任务的项目范围，其他项目的任务仍不可使用。</p>
        {addable.length ? <div className="workspace-memory-list">{addable.map((item) => <ReferenceRow key={bindingKey(item)} item={item} action="添加引用" disabled={busy} onAction={() => void changeReference(item, false)} onOpen={() => setSelected(item)} />)}</div> : <div className="ws-binding-empty">没有匹配的资料位置；可在所属位置先创建资料或文件夹。</div>}
      </details>}
      {selected && <div className="workspace-materials-reference-preview"><div className="workspace-materials-preview-head"><h4>查看：{selected.path ?? selected.name}</h4><button type="button" className="btn" onClick={() => setSelected(null)}>收起</button></div>
        <ScopedLibraryManager key={bindingKey(selected)} scope={ownerOfBinding(selected)} name={selected.name} readOnly reference={{ spaceId: selected.librarySpaceId, collectionId: selected.collectionId }} initialSpaceId={selected.librarySpaceId} initialCollectionId={selected.collectionId ?? null} />
      </div>}
    </section>
  </section>;
}
