import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectContextPinDto, ProjectDetailsDto } from "@shared/project-domain";
import type { ProjectUnsavedGuard } from "@/lib/projectWorkspace";
import ProjectBrief from "./ProjectBrief";
import type { LibraryItemDto, LibraryOwnerScope, LibrarySnapshotDto } from "@shared/library-ipc";
import { IconSearch } from "@/components/common/icons";
import { type ProjectMaterialDocumentStatus, type ProjectMaterialExecutionStatus, type ProjectMaterialSupplementalStatus } from "@/lib/projectMaterials";
import ProjectAssets from "./ProjectAssets";
import ScopedLibraryManager from "../library/ScopedLibraryManager";
import { libraryOwnerOf, scopedLibrarySnapshot } from "@/lib/scopedLibrary";
import ProjectExecutionMaterials, { ProjectWorkFolder } from "./ProjectExecutionMaterials";

interface Props {
  project: ProjectDetailsDto;
  onRefresh: () => Promise<void>;
  onRegisterUnsaved?: (guard: ProjectUnsavedGuard | null) => void;
}

function libraryApi() {
  if (!window.api?.library) throw new Error("资料服务不可用，请重试");
  return window.api.library;
}

export default function ProjectMaterials({ project, onRefresh, onRegisterUnsaved }: Props): React.JSX.Element {
  const unsavedCallback = useRef(onRegisterUnsaved);
  unsavedCallback.current = onRegisterUnsaved;
  const guards = useRef(new Map<string, ProjectUnsavedGuard>());
  const register = useCallback((key: string, guard: ProjectUnsavedGuard | null): void => {
    if (guard) guards.current.set(key, guard); else guards.current.delete(key);
    const current = [...guards.current.values()];
    unsavedCallback.current?.({
      dirty: current.some((entry) => entry.dirty),
      save: async () => { for (const entry of [...guards.current.values()]) if (entry.dirty) await entry.save(); },
      discard: () => { for (const entry of [...guards.current.values()]) if (entry.dirty) entry.discard(); },
    });
  }, []);
  const registerDocument = useCallback((guard: ProjectUnsavedGuard | null) => register("document", guard), [register]);
  const registerBrief = useCallback((guard: ProjectUnsavedGuard | null) => register("brief", guard), [register]);
  const [query, setQuery] = useState("");
  const [documentStatus, setDocumentStatus] = useState<ProjectMaterialDocumentStatus>({ loaded: false, total: 0, common: 0 });
  const [supplementalStatus, setSupplementalStatus] = useState<ProjectMaterialSupplementalStatus>(() => ({
    checked: false,
    total: project.resources.filter((item) => item.kind !== "folder").length,
    eligible: project.resources.filter((item) => item.kind !== "folder" && item.enabled).length,
    included: 0,
    includedChars: 0,
  }));
  const [executionStatus, setExecutionStatus] = useState<ProjectMaterialExecutionStatus>({ selected: false, readCount: 0, injectedCount: 0, omitted: 0 });
  useEffect(() => {
    setQuery("");
    setDocumentStatus({ loaded: false, total: 0, common: 0 });
    setSupplementalStatus({
      checked: false,
      total: project.resources.filter((item) => item.kind !== "folder").length,
      eligible: project.resources.filter((item) => item.kind !== "folder" && item.enabled).length,
      included: 0,
      includedChars: 0,
    });
    setExecutionStatus({ selected: false, readCount: 0, injectedCount: 0, omitted: 0 });
  }, [project.id]);
  return <div className="project-materials-flow">
    <div className="project-cap-summary project-material-status" aria-label="资料状态">
      <span><small>项目资料</small><strong>{documentStatus.loaded ? documentStatus.total : "…"}</strong><small>长期保存 · 按需读取</small></span>
      <span><small>常用</small><strong>{documentStatus.loaded ? documentStatus.common : "…"}</strong><small>提供引用，不代表正文已读取</small></span>
      <span><small>补充参考</small><strong>{supplementalStatus.checked ? supplementalStatus.included + "/" + supplementalStatus.eligible : "待检查"}</strong><small>{supplementalStatus.checked ? "当前可注入 " + supplementalStatus.includedChars.toLocaleString("zh-CN") + " 字" : supplementalStatus.eligible + " 项启用，等待运行口径检查"}</small></span>
      <span><small>本次使用</small><strong>{executionStatus.selected ? executionStatus.readCount + executionStatus.injectedCount : "未查看"}</strong><small>{executionStatus.selected ? "读取证据 " + executionStatus.readCount + " · 注入 " + executionStatus.injectedCount + (executionStatus.omitted ? " · 另 " + executionStatus.omitted + " 项未保留" : "") : "选择任务和执行记录后显示真实证据"}</small><small>不代表模型理解或采纳</small></span>
    </div>
    <div className="project-materials-searchbar">
      <label className="project-plan-search project-materials-search">
        <IconSearch size={14} />
        <input aria-label="搜索项目资料" placeholder="搜索全部项目资料（项目资料与补充参考）" value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      {query && <button type="button" className="btn" onClick={() => setQuery("")}>清除搜索</button>}
    </div>
    <ProjectDocuments key={`documents-${project.id}`} project={project} query={query} onStatusChange={setDocumentStatus} onRegisterUnsaved={registerDocument} />
    <details className="project-material-card project-material-collapsible" open>
      <summary className="project-material-summary">
        <span className="project-material-card-title">补充参考</span>
        <span className="project-material-count">{supplementalStatus.total}</span>
        <span className="project-material-summary-hint">文件引用、短文本和链接；是否进入某次执行，以「本次实际使用资料」为准</span>
      </summary>
      <ProjectAssets key={`references-${project.id}`} project={project} onRefresh={onRefresh} query={query} hideSearch onStatusChange={setSupplementalStatus} />
    </details>
    <ProjectExecutionMaterials key={project.id} project={project} onStatusChange={setExecutionStatus} />
    <div className="project-materials-settings">
      <ProjectWorkFolder key={`folder-${project.id}`} project={project} onRefresh={onRefresh} />
      <ProjectBrief key={`brief-${project.id}`} project={project} onRefresh={onRefresh} onRegisterUnsaved={registerBrief} />
    </div>
  </div>;
}

function ProjectDocuments({ project, query, onStatusChange, onRegisterUnsaved }: {
  project: ProjectDetailsDto;
  query: string;
  onStatusChange: (status: ProjectMaterialDocumentStatus) => void;
  onRegisterUnsaved: (guard: ProjectUnsavedGuard | null) => void;
}): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<LibrarySnapshotDto | null>(null);
  const [pins, setPins] = useState<ProjectContextPinDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [itemRequest, setItemRequest] = useState<{ itemId: string; token: number }>();
  const [externalPin, setExternalPin] = useState<{ scope: LibraryOwnerScope; item: LibraryItemDto } | null>(null);
  const alive = useRef(true);
  const pinSequence = useRef(0);
  const operation = useRef(false);

  const reloadPins = useCallback(async () => {
    const ticket = ++pinSequence.current;
    try {
      if (!window.api?.db?.listProjectPins) throw new Error("常用资料服务不可用，请重启应用");
      const next = await window.api.db.listProjectPins(project.id);
      if (alive.current && ticket === pinSequence.current) setPins(next.filter((pin) => pin.projectId === project.id));
    } catch (cause) { if (alive.current && ticket === pinSequence.current) setError(cause instanceof Error ? cause.message : "常用资料加载失败"); }
  }, [project.id]);
  useEffect(() => {
    alive.current = true;
    void reloadPins();
    return () => { alive.current = false; pinSequence.current += 1; };
  }, [reloadPins]);
  useEffect(() => {
    onStatusChange({ loaded: snapshot !== null, total: snapshot?.items.length ?? 0, common: pins.length });
  }, [snapshot, pins.length, onStatusChange]);

  const setPinned = async (itemId: string, pinned: boolean): Promise<void> => {
    if (operation.current || project.archived) return;
    operation.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      const api = window.api?.db;
      if (!api?.pinProjectItem || !api.unpinProjectItem) throw new Error("常用资料服务不可用，请重启应用");
      if (pinned) {
        const fresh = scopedLibrarySnapshot(await libraryApi().snapshot(), { type: "project", projectId: project.id });
        if (!fresh.items.some((item) => item.id === itemId)) throw new Error("这份资料已不属于当前项目");
        await api.pinProjectItem({ projectId: project.id, itemId });
      } else await api.unpinProjectItem({ projectId: project.id, itemId });
      if (alive.current) { await reloadPins(); setNotice(pinned ? "已设为常用资料" : "已取消常用，原文档保留"); }
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : "更新常用资料失败"); }
    finally { operation.current = false; if (alive.current) setBusy(false); }
  };
  const itemActions = (item: LibraryItemDto): React.JSX.Element | null => pins.some((pin) => pin.itemId === item.id) ? null
    : <button type="button" className="btn" disabled={busy || project.archived}
        onClick={() => void setPinned(item.id, true)}>设为常用资料</button>;
  const openPin = async (itemId: string): Promise<void> => {
    if (snapshot?.items.some((item) => item.id === itemId)) {
      setExternalPin(null);
      setItemRequest((current) => ({ itemId, token: (current?.token ?? 0) + 1 }));
      return;
    }
    try {
      const fresh = await libraryApi().snapshot();
      if (!alive.current) return;
      const item = fresh.items.find((entry) => entry.id === itemId);
      const space = fresh.spaces.find((entry) => entry.id === item?.spaceId);
      if (!item || !space) throw new Error("这份常用资料已不存在，请取消失效引用");
      setExternalPin({ scope: libraryOwnerOf(space), item });
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : "资料读取失败"); }
  };

  return <section className="project-material-card" aria-label="项目资料">
    <div className="project-material-pins" aria-label="常用资料">
      <span className="project-material-pins-label">常用资料 · {pins.length}</span>
      {!pins.length && <span className="project-desk-hint">打开资料后可设为常用，提供引用，正文按需读取。</span>}
      {pins.map((pin) => <span className="project-material-pin" key={pin.id}>
        <button type="button" className="project-material-pin-title" disabled={busy} title={pin.note ?? pin.itemTitle}
          onClick={() => void openPin(pin.itemId)}>{pin.itemTitle ?? "资料引用"}</button>
        <button type="button" className="project-material-pin-remove" disabled={busy || project.archived} onClick={() => void setPinned(pin.itemId, false)}>取消常用</button>
      </span>)}
    </div>
    {error && <div className="project-material-notice is-error" role="alert">{error}</div>}
    {notice && <div className="project-material-notice" role="status">{notice}</div>}
    {externalPin && <div className="project-material-pin-reader"><button type="button" className="btn" onClick={() => setExternalPin(null)}>关闭常用资料</button>
      <ScopedLibraryManager scope={externalPin.scope} name="常用资料引用" readOnly
        reference={{ spaceId: externalPin.item.spaceId, itemId: externalPin.item.id }} initialItemId={externalPin.item.id} />
    </div>}
    <ScopedLibraryManager scope={{ type: "project", projectId: project.id }} name="项目资料" readOnly={Boolean(project.archived)}
      searchQuery={query} onSnapshot={setSnapshot} onChanged={() => void reloadPins()} renderItemActions={itemActions}
      itemRequest={itemRequest} onRegisterUnsaved={onRegisterUnsaved} />
  </section>;
}
