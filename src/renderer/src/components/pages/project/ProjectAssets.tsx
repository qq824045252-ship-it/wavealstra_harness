import { useEffect, useMemo, useRef, useState } from "react";
import ConfirmDialog from "@/components/common/ConfirmDialog";
import {
  IconChevronRight,
  IconFile,
  IconFileGeneric,
  IconFileSpreadsheet,
  IconFolder,
  IconImage,
  IconLink,
  IconPresentation,
  IconSearch,
  IconTrash,
} from "@/components/common/icons";
import {
  collectDroppedLocalFiles,
  dataTransferHasFiles,
  dataTransferHasProjectAssets,
  decodeProjectAssetDrag,
  encodeProjectAssetDrag,
  filterProjectAssets,
  formatAssetBytes,
  formatAssetQuota,
  formatRelativeTime,
  movableProjectAssetIds,
  PROJECT_ASSET_DRAG_TYPE,
  projectAssetDisplayKind,
  projectAssetDragIds,
  projectAssetTypeLabel,
  sortProjectAssets,
  type ProjectAssetKindFilter,
  type ProjectAssetSortKey,
} from "@/lib/projectWorkspace";
import { useAppStore } from "@/store/appStore";
import type { ProjectMaterialSupplementalStatus } from "@/lib/projectMaterials";
import type {
  ProjectDetailsDto,
  ProjectResourceDto,
  ProjectResourceInspectionDto,
  ProjectResourceKind,
} from "@shared/project-domain";

interface Props {
  project: ProjectDetailsDto;
  onRefresh: () => Promise<void>;
  query?: string;
  hideSearch?: boolean;
  onStatusChange?: (status: ProjectMaterialSupplementalStatus) => void;
}

const KIND_FILTERS: Array<{ id: ProjectAssetKindFilter; label: string }> = [
  { id: "all", label: "全部类型" },
  { id: "folder", label: "文件夹" },
  { id: "file", label: "文件" },
  { id: "text", label: "文档" },
  { id: "url", label: "链接" },
];

type ComposeKind = "folder" | "text" | "url";

export default function ProjectAssets({ project, onRefresh, query: sharedQuery, hideSearch = false, onStatusChange }: Props): React.JSX.Element {
  const soul = useAppStore((state) => state.soul);
  const updater = soul.alias.trim() || "我";
  const [localQuery, setLocalQuery] = useState("");
  const query = sharedQuery ?? localQuery;
  const [kind, setKind] = useState<ProjectAssetKindFilter>("all");
  const [sortKey, setSortKey] = useState<ProjectAssetSortKey>("name");
  const [sortDesc, setSortDesc] = useState(false);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<ProjectResourceDto[] | null>(null);
  const [compose, setCompose] = useState<ComposeKind | null>(null);
  const [composeTitle, setComposeTitle] = useState("");
  const [composeValue, setComposeValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inspection, setInspection] = useState<ProjectResourceInspectionDto | null>(null);
  const [dropTarget, setDropTarget] = useState<"files" | "root" | string | null>(null);
  const [draggingIds, setDraggingIds] = useState<string[]>([]);
  const draggingIdsRef = useRef<string[]>([]);

  useEffect(() => {
    setFolderId(null);
    setSelected(new Set());
    setLocalQuery("");
  }, [project.id]);

  useEffect(() => {
    let cancelled = false;
    setInspection(null);
    void window.api?.db?.inspectProjectResources?.(project.id).then((next) => {
      if (!cancelled) setInspection(next ?? null);
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : "补充参考检查失败");
    });
    return () => { cancelled = true; };
  }, [project.id, project.updatedAt, project.resources.length]);

  useEffect(() => {
    const materialResources = project.resources.filter((item) => item.kind !== "folder");
    onStatusChange?.({
      checked: inspection !== null,
      total: materialResources.length,
      eligible: materialResources.filter((item) => item.enabled).length,
      included: inspection?.items.filter((item) => item.included).length ?? 0,
      includedChars: inspection?.includedChars ?? 0,
      budgetChars: inspection?.budgetChars ?? project.resourceBudgetChars,
    });
  }, [inspection, project.resources, project.resourceBudgetChars, onStatusChange]);

  const healthById = useMemo(
    () => new Map(inspection?.items.map((item) => [item.resourceId, item]) ?? []),
    [inspection],
  );
  const folder = folderId ? project.resources.find((item) => item.id === folderId) : undefined;
  const visible = useMemo(() => {
    const filtered = filterProjectAssets(project.resources, {
      query,
      kind,
      folderId: query.trim() ? undefined : folderId,
    });
    return sortProjectAssets(filtered, { key: sortKey, desc: sortDesc }, (item) => healthById.get(item.id)?.bytes ?? 0);
  }, [project.resources, query, kind, folderId, sortKey, sortDesc, healthById]);

  const toggleSort = (key: ProjectAssetSortKey): void => {
    if (sortKey === key) setSortDesc((value) => !value);
    else {
      setSortKey(key);
      setSortDesc(key === "updatedAt" || key === "size");
    }
  };

  const addLocalFiles = async (
    files: Array<{ name: string; path: string }>,
    parent?: string | null,
  ): Promise<void> => {
    if (!files.length) {
      setError("无法读取拖入的文件路径");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const parentId = parent === undefined ? folderId : parent;
      for (const file of files) {
        await window.api?.db?.createProjectResource?.({
          projectId: project.id,
          kind: "file",
          title: file.name,
          value: file.path,
          parentId: parentId ?? undefined,
        });
      }
      await onRefresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const uploadFile = async (): Promise<void> => {
    const file = await window.api?.pickLocalFile?.();
    if (!file) return;
    await addLocalFiles([{ name: file.name, path: file.path }]);
  };

  const moveAssets = async (ids: string[], parentId: string | null): Promise<void> => {
    const movable = movableProjectAssetIds({
      ids,
      targetParentId: parentId,
      resources: project.resources,
    });
    if (!movable.length) return;
    setBusy(true);
    setError(null);
    try {
      for (const id of movable) {
        await window.api?.db?.updateProjectResource?.({ id, parentId });
      }
      setSelected(new Set());
      await onRefresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const filesFromDrop = (list: FileList | File[]): Array<{ name: string; path: string }> =>
    collectDroppedLocalFiles(list, (file) => window.api?.getPathForFile?.(file as File) || "");

  const clearDrop = (event: React.DragEvent<HTMLElement>): void => {
    if (event.currentTarget.contains(event.relatedTarget as Node)) return;
    setDropTarget(null);
  };

  const acceptDrop = (event: React.DragEvent<HTMLElement>, target: "files" | "root" | string): boolean => {
    if (busy) return false;
    const files = dataTransferHasFiles(event.dataTransfer.types);
    const assets = dataTransferHasProjectAssets(event.dataTransfer.types);
    if (!files && !assets) return false;
    if (assets && target === "files") return false;
    if (assets) {
      const parentId = target === "root" ? null : target;
      const ids = draggingIdsRef.current;
      const preview = movableProjectAssetIds({
        ids,
        targetParentId: parentId,
        resources: project.resources,
      });
      if (!preview.length && ids.length > 0) return false;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = files ? "copy" : "move";
    setDropTarget(target);
    return true;
  };

  const handleDrop = (event: React.DragEvent<HTMLElement>, target: "files" | "root" | string): void => {
    event.preventDefault();
    event.stopPropagation();
    setDropTarget(null);
    if (busy) return;
    const parentId = target === "files" ? folderId : target === "root" ? null : target;
    if (event.dataTransfer.files?.length) {
      void addLocalFiles(filesFromDrop(event.dataTransfer.files), parentId);
      return;
    }
    const ids = decodeProjectAssetDrag(event.dataTransfer.getData(PROJECT_ASSET_DRAG_TYPE));
    if (!ids.length || target === "files") return;
    void moveAssets(ids, parentId);
  };

  const submitCompose = async (): Promise<void> => {
    if (!compose) return;
    setBusy(true);
    setError(null);
    try {
      const kindValue: ProjectResourceKind = compose;
      await window.api?.db?.createProjectResource?.({
        projectId: project.id,
        kind: kindValue,
        title: composeTitle.trim() || (compose === "folder" ? "未命名文件夹" : "未命名资料"),
        value: compose === "folder" ? composeTitle.trim() : composeValue.trim(),
        parentId: folderId ?? undefined,
      });
      setCompose(null);
      setComposeTitle("");
      setComposeValue("");
      await onRefresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (items: ProjectResourceDto[]): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      for (const item of items) {
        await window.api?.db?.deleteProjectResource?.(item.id);
      }
      setPendingDelete(null);
      setSelected(new Set());
      if (folderId && items.some((item) => item.id === folderId)) setFolderId(null);
      await onRefresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const allChecked = visible.length > 0 && visible.every((item) => selected.has(item.id));
  const fileBytes = inspection?.items.reduce((sum, item) => sum + (item.bytes ?? 0), 0) ?? 0;

  return (
    <div
      className={`project-desk-pane project-assets ${dropTarget === "files" ? "drag-over" : ""}`}
      onDragEnter={(event) => { acceptDrop(event, "files"); }}
      onDragOver={(event) => { acceptDrop(event, "files"); }}
      onDragLeave={clearDrop}
      onDrop={(event) => handleDrop(event, "files")}
    >
      <div className="project-desk-toolbar">
        <button type="button" className="btn" disabled={busy} onClick={() => { setCompose("folder"); setComposeTitle(""); setComposeValue(""); }}>
          新建文件夹
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          title="选择或拖入本地文件"
          onClick={() => void uploadFile()}
        >
          添加文件引用
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => { setCompose("text"); setComposeTitle(""); setComposeValue(""); }}>
          添加文档
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => { setCompose("url"); setComposeTitle(""); setComposeValue(""); }}>
          添加链接
        </button>
        <span className="project-asset-quota" title="补充参考进入任务上下文的字符预算，不是云盘容量">
          {formatAssetQuota(inspection?.includedChars ?? 0, inspection?.budgetChars ?? project.resourceBudgetChars)}
          {fileBytes > 0 ? ` · 文件 ${formatAssetBytes(fileBytes)}` : ""}
        </span>
        <span className="input-spacer" />
        <select className="project-inline-select" value={kind} onChange={(event) => setKind(event.target.value as ProjectAssetKindFilter)}>
          {KIND_FILTERS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
        {!hideSearch && <label className="project-plan-search">
          <IconSearch size={14} />
          <input
            value={localQuery}
            placeholder="搜索文件或文件夹"
            aria-label="搜索文件或文件夹"
            onChange={(event) => setLocalQuery(event.target.value)}
          />
        </label>}
      </div>
      <p className="project-desk-hint">
        可直接拖入本地文件作为引用；长期文档请在上方「项目资料」导入和管理。
      </p>

      {folder && !query.trim() && (
        <div className="project-asset-path">
          <button
            type="button"
            className={`project-desk-crumb-link ${dropTarget === "root" ? "drop-target" : ""}`}
            onClick={() => setFolderId(null)}
            onDragEnter={(event) => { acceptDrop(event, "root"); }}
            onDragOver={(event) => { acceptDrop(event, "root"); }}
            onDragLeave={clearDrop}
            onDrop={(event) => handleDrop(event, "root")}
          >
            补充参考
          </button>
          <span className="project-desk-crumb-sep">/</span>
          <span className="project-desk-crumb-name">{folder.title}</span>
        </div>
      )}

      {dropTarget === "files" && (
        <div className="project-asset-drop-hint">松开以添加文件</div>
      )}

      {error && <div className="project-material-notice is-error" role="alert">{error}</div>}

      {selected.size > 0 && (
        <div className="project-asset-batch">
          <span>已选 {selected.size} 项</span>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => setPendingDelete(project.resources.filter((item) => selected.has(item.id)))}
          >
            <IconTrash size={13} /> 删除
          </button>
        </div>
      )}

      <div className="project-sheet project-asset-sheet">
        <div className="project-asset-head">
          <label className="project-asset-check">
            <input
              type="checkbox"
              checked={allChecked}
              onChange={() => {
                setSelected(allChecked ? new Set() : new Set(visible.map((item) => item.id)));
              }}
            />
          </label>
          <button type="button" className="project-asset-sort" onClick={() => toggleSort("name")}>
            名称{sortKey === "name" ? (sortDesc ? " ↓" : " ↑") : ""}
          </button>
          <span>类型</span>
          <span>更新人</span>
          <button type="button" className="project-asset-sort" onClick={() => toggleSort("updatedAt")}>
            更新时间{sortKey === "updatedAt" ? (sortDesc ? " ↓" : " ↑") : ""}
          </button>
          <button type="button" className="project-asset-sort" onClick={() => toggleSort("size")}>
            大小{sortKey === "size" ? (sortDesc ? " ↓" : " ↑") : ""}
          </button>
          <span />
        </div>
        {visible.length === 0 ? (
          <div className="project-material-empty">
            {project.resources.length === 0
              ? "还没有补充参考。可拖入文件引用，或添加短文档 / 链接；长期文档直接在上方「项目资料」导入。"
              : "没有匹配资料"}
          </div>
        ) : (
          visible.map((resource) => {
            const health = healthById.get(resource.id);
            return (
              <div
                className={`project-asset-row ${selected.has(resource.id) ? "selected" : ""}${draggingIds.includes(resource.id) ? " is-dragging" : ""}${dropTarget === resource.id ? " drop-target" : ""}`}
                key={resource.id}
                draggable={!busy}
                onDragStart={(event) => {
                  const target = event.target as HTMLElement;
                  if (target.closest("input, label.project-asset-check, button.btn")) {
                    event.preventDefault();
                    return;
                  }
                  const ids = projectAssetDragIds(resource.id, selected);
                  event.dataTransfer.setData(PROJECT_ASSET_DRAG_TYPE, encodeProjectAssetDrag(ids));
                  event.dataTransfer.effectAllowed = "move";
                  draggingIdsRef.current = ids;
                  setDraggingIds(ids);
                }}
                onDragEnd={() => {
                  draggingIdsRef.current = [];
                  setDraggingIds([]);
                  setDropTarget(null);
                }}
                onDragEnter={(event) => {
                  if (resource.kind === "folder") acceptDrop(event, resource.id);
                }}
                onDragOver={(event) => {
                  if (resource.kind === "folder") acceptDrop(event, resource.id);
                }}
                onDrop={(event) => {
                  if (resource.kind === "folder") handleDrop(event, resource.id);
                }}
                onDoubleClick={() => {
                  if (resource.kind === "folder") {
                    setFolderId(resource.id);
                    setSelected(new Set());
                    setLocalQuery("");
                  }
                }}
              >
                <label
                  className="project-asset-check"
                  onClick={(event) => event.stopPropagation()}
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(resource.id)}
                    onChange={() => {
                      setSelected((current) => {
                        const next = new Set(current);
                        if (next.has(resource.id)) next.delete(resource.id);
                        else next.add(resource.id);
                        return next;
                      });
                    }}
                  />
                </label>
                <span
                  className="project-asset-name"
                  role={resource.kind === "folder" ? "button" : undefined}
                  tabIndex={resource.kind === "folder" ? 0 : undefined}
                  title={resource.value}
                  onClick={() => {
                    if (resource.kind === "folder") {
                      setFolderId(resource.id);
                      setSelected(new Set());
                      setLocalQuery("");
                    }
                  }}
                  onKeyDown={(event) => {
                    if (resource.kind !== "folder") return;
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    setFolderId(resource.id);
                    setSelected(new Set());
                    setLocalQuery("");
                  }}
                >
                  <AssetIcon kind={resource.kind} title={resource.title} />
                  <span className="project-asset-name-text">{resource.title}</span>
                  {resource.kind === "folder" && <IconChevronRight size={12} />}
                  {health?.reason && health.status !== "binary" && health.status !== "ready" && (
                    <span className="project-asset-health">{health.reason}</span>
                  )}
                </span>
                <span>{projectAssetTypeLabel(resource.kind, resource.title)}</span>
                <span>{updater}</span>
                <span>{formatRelativeTime(resource.updatedAt)}</span>
                <span>{resource.kind === "folder" ? "—" : formatAssetBytes(health?.bytes ?? (resource.kind === "text" ? resource.value.length : undefined))}</span>
                <button
                  type="button"
                  className="btn"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => setPendingDelete([resource])}
                >
                  删除
                </button>
              </div>
            );
          })
        )}
      </div>

      {compose && (
        <div className="modal-overlay" onClick={() => !busy && setCompose(null)}>
          <div className="new-project-modal project-task-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="new-project-modal-head">
              <div className="new-project-modal-title">
                {compose === "folder" ? "新建文件夹" : compose === "url" ? "添加链接" : "添加文档"}
              </div>
            </div>
            <div className="new-project-modal-body">
              <label className="new-project-field">
                <span className="new-project-label">名称</span>
                <input
                  className="new-project-input"
                  value={composeTitle}
                  autoFocus
                  placeholder={compose === "folder" ? "文件夹名称" : "资料名称"}
                  onChange={(event) => setComposeTitle(event.target.value)}
                />
              </label>
              {compose !== "folder" && (
                <label className="new-project-field">
                  <span className="new-project-label">{compose === "url" ? "网址" : "内容"}</span>
                  {compose === "url" ? (
                    <input
                      className="new-project-input"
                      value={composeValue}
                      placeholder="https://"
                      onChange={(event) => setComposeValue(event.target.value)}
                    />
                  ) : (
                    <textarea
                      className="new-project-input"
                      rows={6}
                      value={composeValue}
                      placeholder="写入给项目任务的补充文本"
                      onChange={(event) => setComposeValue(event.target.value)}
                    />
                  )}
                </label>
              )}
            </div>
            <div className="new-project-modal-foot">
              <div className="new-project-foot-actions">
                <button type="button" className="btn" disabled={busy} onClick={() => setCompose(null)}>取消</button>
                <button type="button" className="btn primary" disabled={busy} onClick={() => void submitCompose()}>创建</button>
              </div>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={pendingDelete?.some((item) => item.kind === "folder") ? "删除文件夹？" : "删除补充参考？"}
        body={
          pendingDelete?.some((item) => item.kind === "folder")
            ? "文件夹里的资料会一起删除，并且不再作为项目上下文提供给任务。此操作无法撤销。"
            : "删除后该资料将不再作为项目上下文提供给任务。此操作无法撤销。"
        }
        confirmLabel="删除"
        danger
        onCancel={() => !busy && setPendingDelete(null)}
        onConfirm={() => pendingDelete && void remove(pendingDelete)}
      />
    </div>
  );
}

function AssetIcon({ kind, title }: { kind: string; title: string }): React.JSX.Element {
  const display = projectAssetDisplayKind({ kind, title });
  if (display === "folder") return <IconFolder size={16} />;
  if (display === "pdf") return <IconFile size={16} />;
  if (display === "image") return <IconImage size={16} />;
  if (display === "sheet") return <IconFileSpreadsheet size={16} />;
  if (display === "slide") return <IconPresentation size={16} />;
  if (display === "link") return <IconLink size={16} />;
  if (display === "text") return <IconFile size={16} />;
  return <IconFileGeneric size={16} />;
}
