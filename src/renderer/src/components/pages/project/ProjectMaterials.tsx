import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PROJECT_PINS_MAX, type ProjectContextPinDto, type ProjectDetailsDto } from "@shared/project-domain";
import type { ProjectUnsavedGuard } from "@/lib/projectWorkspace";
import ProjectBrief from "./ProjectBrief";
import { LIBRARY_NAME_MAX_CHARS, type LibraryContentDto, type LibrarySnapshotDto } from "@shared/library-ipc";
import { IconFile, IconSearch } from "@/components/common/icons";
import { formatAssetBytes, formatRelativeTime } from "@/lib/projectWorkspace";
import { projectLibraryMaterials, type ProjectMaterialDocumentStatus, type ProjectMaterialExecutionStatus, type ProjectMaterialSupplementalStatus } from "@/lib/projectMaterials";
import ProjectAssets from "./ProjectAssets";
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
  const [query, setQuery] = useState("");
  const [documentStatus, setDocumentStatus] = useState<ProjectMaterialDocumentStatus>({ loaded: false, total: 0, common: 0 });
  const [supplementalStatus, setSupplementalStatus] = useState<ProjectMaterialSupplementalStatus>(() => ({
    checked: false,
    total: project.resources.filter((item) => item.kind !== "folder").length,
    eligible: project.resources.filter((item) => item.kind !== "folder" && item.enabled).length,
    included: 0,
    includedChars: 0,
    budgetChars: project.resourceBudgetChars,
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
      budgetChars: project.resourceBudgetChars,
    });
    setExecutionStatus({ selected: false, readCount: 0, injectedCount: 0, omitted: 0 });
  }, [project.id]);
  return <div className="project-materials-flow">
    <div className="project-cap-summary project-material-status" aria-label="资料状态">
      <span><small>项目资料</small><strong>{documentStatus.loaded ? documentStatus.total : "…"}</strong><small>长期保存 · 按需读取</small></span>
      <span><small>常用</small><strong>{documentStatus.loaded ? documentStatus.common + "/" + PROJECT_PINS_MAX : "…"}</strong><small>提供引用，不代表正文已读取</small></span>
      <span><small>补充参考</small><strong>{supplementalStatus.checked ? supplementalStatus.included + "/" + supplementalStatus.eligible : "待检查"}</strong><small>{supplementalStatus.checked ? "当前可注入 " + supplementalStatus.includedChars.toLocaleString("zh-CN") + " / " + supplementalStatus.budgetChars.toLocaleString("zh-CN") + " 字" : supplementalStatus.eligible + " 项启用，等待运行口径检查"}</small></span>
      <span><small>本次使用</small><strong>{executionStatus.selected ? executionStatus.readCount + executionStatus.injectedCount : "未查看"}</strong><small>{executionStatus.selected ? "读取证据 " + executionStatus.readCount + " · 注入 " + executionStatus.injectedCount + (executionStatus.omitted ? " · 另 " + executionStatus.omitted + " 项未保留" : "") : "选择任务和执行记录后显示真实证据"}</small><small>不代表模型理解或采纳</small></span>
    </div>
    <div className="project-materials-searchbar">
      <label className="project-plan-search project-materials-search">
        <IconSearch size={14} />
        <input aria-label="搜索项目资料" placeholder="搜索全部项目资料（项目资料与补充参考）" value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      {query && <button type="button" className="btn" onClick={() => setQuery("")}>清除搜索</button>}
    </div>
    <ProjectDocuments key={`documents-${project.id}`} project={project} query={query} onStatusChange={setDocumentStatus} />
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
      <ProjectBrief key={`brief-${project.id}`} project={project} onRefresh={onRefresh} onRegisterUnsaved={onRegisterUnsaved} />
    </div>
  </div>;
}

function ProjectDocuments({ project, query, onStatusChange }: { project: ProjectDetailsDto; query: string; onStatusChange: (status: ProjectMaterialDocumentStatus) => void }): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<LibrarySnapshotDto | null>(null);
  const [pins, setPins] = useState<ProjectContextPinDto[]>([]);
  const [destination, setDestination] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [document, setDocument] = useState<LibraryContentDto | null>(null);
  const alive = useRef(false);
  const request = useRef(0);
  const operation = useRef(false);

  const reload = useCallback(async () => {
    const ticket = ++request.current;
    setLoading(true);
    setError(null);
    try {
      if (!window.api?.db?.listProjectPins) throw new Error("常用资料服务不可用，请重启应用");
      const [next, pinned] = await Promise.all([libraryApi().snapshot(), window.api.db.listProjectPins(project.id)]);
      if (alive.current && ticket === request.current) { setSnapshot(next); setPins(pinned.filter((pin) => pin.projectId === project.id)); }
    } catch (cause) {
      if (alive.current && ticket === request.current) setError(cause instanceof Error ? cause.message : "资料加载失败");
    } finally {
      if (alive.current && ticket === request.current) setLoading(false);
    }
  }, [project.id]);

  useEffect(() => {
    alive.current = true;
    void reload();
    return () => { alive.current = false; request.current += 1; };
  }, [reload]);

  const material = snapshot ? projectLibraryMaterials(snapshot, project.id, query) : { spaces: [], items: [] };
  const allItems = snapshot ? projectLibraryMaterials(snapshot, project.id).items : [];
  useEffect(() => {
    onStatusChange({ loaded: !loading && snapshot !== null, total: allItems.length, common: pins.length });
  }, [loading, snapshot, allItems.length, pins.length, onStatusChange]);
  const setPinned = async (itemId: string, pinned: boolean): Promise<void> => {
    if (operation.current || project.archived) return;
    operation.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      const api = window.api?.db;
      if (!api?.pinProjectItem || !api.unpinProjectItem) throw new Error("常用资料服务不可用，请重启应用");
      if (pinned) await api.pinProjectItem({ projectId: project.id, itemId });
      else await api.unpinProjectItem({ projectId: project.id, itemId });
      if (alive.current) { await reload(); if (alive.current) setNotice(pinned ? "已设为常用资料" : "已取消常用，原文档保留"); }
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : "更新常用资料失败"); }
    finally { operation.current = false; if (alive.current) setBusy(false); }
  };

  const importDocuments = async (): Promise<void> => {
    if (operation.current || project.archived) return;
    operation.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const fresh = await libraryApi().snapshot();
      if (!alive.current) return;
      const { spaces } = projectLibraryMaterials(fresh, project.id);
      let spaceId = spaces.length === 1 ? spaces[0].id : spaces.find((space) => space.id === destination)?.id;
      if (spaces.length > 1 && !spaceId) {
        setSnapshot(fresh);
        throw new Error("请选择本项目的导入位置");
      }
      if (spaces.length === 0) {
        const created = await libraryApi().createSpace({ projectId: project.id, name: project.name.slice(0, LIBRARY_NAME_MAX_CHARS) });
        if (!created.ok) throw new Error(created.error);
        if (created.value.projectId !== project.id) throw new Error("导入位置不属于当前项目");
        spaceId = created.value.id;
      }
      if (!alive.current || !spaceId) return;
      const imported = await libraryApi().pickAndImport({ spaceId });
      if (!imported.ok) throw new Error(imported.error);
      if (!alive.current) return;
      await reload();
      if (alive.current) setNotice(imported.value.length ? `已导入 ${imported.value.length} 个文档` : "已取消导入");
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : "导入失败");
    } finally {
      operation.current = false;
      if (alive.current) setBusy(false);
    }
  };

  const openDocument = async (id: string): Promise<void> => {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setError(null);
    try {
      // Revalidate ownership against fresh authoritative metadata before reading.
      const fresh = await libraryApi().snapshot();
      if (!alive.current) return;
      if (!projectLibraryMaterials(fresh, project.id).items.some((item) => item.id === id)) throw new Error("文档已移出当前项目或已被删除");
      const result = await libraryApi().readContent(id);
      if (!result.ok) throw new Error(result.error);
      if (!projectLibraryMaterials(fresh, project.id).spaces.some((space) => space.id === result.value.item.spaceId)) throw new Error("文档不属于当前项目");
      if (alive.current) setDocument(result.value);
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : "无法读取文档");
    } finally {
      operation.current = false;
      if (alive.current) setBusy(false);
    }
  };

  return <section className="project-material-card" aria-label="项目资料">
    <div className="project-material-card-head">
      <div className="project-material-card-heading">
        <h3 className="project-material-card-title">项目资料{snapshot && <span className="project-material-count">{allItems.length}</span>}</h3>
        <p className="project-desk-hint">长期文档在这里导入、阅读和检索；设为常用后会向项目任务提供引用，正文仍按需读取。</p>
      </div>
      <div className="project-material-card-actions">
        {document ? <button type="button" className="btn" onClick={() => setDocument(null)}>返回文档列表</button> : <>
          {material.spaces.length > 1 && <select className="project-inline-select" aria-label="导入位置" value={destination}
            disabled={busy} onChange={(event) => setDestination(event.target.value)}>
            <option value="">选择导入位置</option>
            {material.spaces.map((space) => <option key={space.id} value={space.id}>{space.name}</option>)}
          </select>}
          <button type="button" className="btn" disabled={busy || loading} onClick={() => void reload()}>刷新</button>
          <button type="button" className="btn primary" disabled={busy || loading || Boolean(project.archived)} onClick={() => void importDocuments()}>导入文档</button>
        </>}
      </div>
    </div>
    {!loading && <div className="project-material-pins" aria-label="常用资料">
      <span className="project-material-pins-label">常用资料 · {pins.length}/{PROJECT_PINS_MAX}</span>
      {!pins.length && <span className="project-desk-hint">打开资料后可设为常用，无需复制文件。</span>}
      {pins.map((pin) => <span className="project-material-pin" key={pin.id}>
        {allItems.some((item) => item.id === pin.itemId)
          ? <button type="button" className="project-material-pin-title" disabled={busy} title={pin.note ?? pin.itemTitle} onClick={() => void openDocument(pin.itemId)}>{pin.itemTitle ?? "资料引用"}</button>
          : <span className="project-material-pin-title" title={pin.note ?? pin.itemTitle}>{pin.itemTitle ?? "资料引用"}</span>}
        <button type="button" className="project-material-pin-remove" disabled={busy || project.archived} onClick={() => void setPinned(pin.itemId, false)}>取消常用</button>
      </span>)}
    </div>}
    {error && <div className="project-material-notice is-error" role="alert">{error}</div>}
    {notice && <div className="project-material-notice" role="status">{notice}</div>}
    {loading && <div className="project-material-empty">正在加载项目资料…</div>}
    {document ? <div className="project-material-doc">
      <div className="project-material-doc-head">
        <h4>{document.item.title}</h4>
        {!pins.some((pin) => pin.itemId === document.item.id) && <button className="btn" disabled={busy || loading || project.archived || pins.length >= PROJECT_PINS_MAX}
          onClick={() => void setPinned(document.item.id, true)}>设为常用资料</button>}
      </div>
      {document.requiresFileAccess ? <>
        <p>此文件需使用对应应用查看；导入不代表已理解文件内容。</p>
        <button type="button" className="btn" onClick={() => {
          void libraryApi().showInFolder(document.item.id).then((result) => {
            if (!result.ok && alive.current) setError(result.error);
          }).catch((cause: unknown) => {
            if (alive.current) setError(cause instanceof Error ? cause.message : "打开失败");
          });
        }}>打开文件位置</button>
      </> : document.item.kind === "markdown"
        ? <div className="md md-doc"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
          a: ({ href, children }) => <a className="md-link" href={href} onClick={(event) => {
            event.preventDefault();
            if (href && /^https?:\/\//i.test(href)) void window.api?.browser.openExternal(href);
            else setNotice("相对链接请从对应文档的文件位置查看");
          }}>{children}</a>,
        }}>{document.content}</ReactMarkdown></div>
        : <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{document.content}</pre>}
    </div> : !loading && snapshot && <div className="project-sheet project-asset-sheet">
      <div className="project-asset-head"><span /><span>名称</span><span>类型</span><span>位置</span><span>更新时间</span><span>大小</span><span /></div>
      {material.items.length === 0 ? <div className="project-material-empty">{query ? "没有匹配的项目资料" : "还没有项目资料。点击「导入文档」后，可在这里阅读，并供本项目任务检索。"}</div>
        : material.items.map((item) => <div className="project-asset-row" key={item.id}>
          <span><IconFile size={15} /></span>
          <button type="button" className="project-desk-crumb-link project-asset-name" disabled={busy} onClick={() => void openDocument(item.id)} title={item.title}>{item.title}</button>
          <span>{item.kind === "markdown" ? "文档" : item.kind === "office" ? "办公文档" : item.kind.toUpperCase()}</span>
          <span>{material.spaces.find((space) => space.id === item.spaceId)?.name}</span>
          <span>{formatRelativeTime(item.updatedAt)}</span><span>{formatAssetBytes(item.sizeBytes)}</span>
          <button type="button" className="btn" disabled={busy} onClick={() => void openDocument(item.id)}>查看</button>
        </div>)}
    </div>}
  </section>;
}
