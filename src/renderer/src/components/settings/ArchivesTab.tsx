import { useEffect, useMemo, useRef, useState } from "react";
import { buildSpaceEffectiveMap, isTaskEffectiveArchived, isSpaceDescendant } from "@shared/workspace-tree";
import { useAppStore } from "@/store/appStore";
import ConfirmDialog from "@/components/common/ConfirmDialog";
import { IconArchive, IconFile, IconFolder, IconRotate, IconTrash } from "@/components/common/icons";
import "./RecordManagement.css";

const PAGE_SIZE = 8;
type Category = "spaces" | "tasks";
type DeleteTarget = { spaceIds: string[]; taskIds: string[] };
type Status = { tone: "pending" | "success" | "error"; text: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(timestamp);
}

export function ArchivesTab(): React.JSX.Element {
  const spaces = useAppStore((s) => s.spaces);
  const tasks = useAppStore((s) => s.tasks);
  const restoreSpace = useAppStore((s) => s.restoreSpace);
  const restoreTask = useAppStore((s) => s.restoreTask);
  const purgeArchivedContent = useAppStore((s) => s.purgeArchivedContent);
  const effectiveSpaceArchiveMap = useMemo(() => buildSpaceEffectiveMap(spaces), [spaces]);
  const archivedSpaces = useMemo(() => spaces.filter((space) => space.archived), [spaces]);
  const archivedTasks = useMemo(
    () => tasks.filter((task) => isTaskEffectiveArchived(task, effectiveSpaceArchiveMap)),
    [tasks, effectiveSpaceArchiveMap],
  );
  const spaceById = useMemo(() => new Map(spaces.map((space) => [space.id, space])), [spaces]);
  const [category, setCategory] = useState<Category>("spaces");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState<DeleteTarget | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [status, setStatus] = useState<Status | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pageSelectionRef = useRef<HTMLInputElement>(null);
  const needle = query.trim().toLocaleLowerCase();
  const filteredSpaces = useMemo(
    () => archivedSpaces.filter((space) => `${space.name} ${space.path ?? ""}`.toLocaleLowerCase().includes(needle)),
    [archivedSpaces, needle],
  );
  const filteredTasks = useMemo(
    () => archivedTasks.filter((task) => `${task.title} ${spaceById.get(task.spaceId ?? "")?.name ?? ""}`.toLocaleLowerCase().includes(needle)),
    [archivedTasks, spaceById, needle],
  );
  const filteredRecords = category === "spaces" ? filteredSpaces : filteredTasks;
  const total = filteredRecords.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(page, pages);
  const offset = (currentPage - 1) * PAGE_SIZE;
  const pageIds = filteredRecords.slice(offset, offset + PAGE_SIZE).map((record) => record.id);
  const pageSelectedCount = pageIds.filter((id) => selectedIds.has(id)).length;
  const allPageSelected = pageIds.length > 0 && pageSelectedCount === pageIds.length;
  const allFilteredSelected = total > 0 && filteredRecords.every((record) => selectedIds.has(record.id));

  useEffect(() => { setPage(currentPage); }, [currentPage]);
  useEffect(() => { listRef.current?.scrollTo(0, 0); }, [currentPage, category, query]);
  useEffect(() => {
    if (pageSelectionRef.current) pageSelectionRef.current.indeterminate = pageSelectedCount > 0 && !allPageSelected;
  }, [pageSelectedCount, allPageSelected]);
  useEffect(() => {
    const eligibleIds = new Set((category === "spaces" ? archivedSpaces : archivedTasks).map((record) => record.id));
    setSelectedIds((previous) => {
      const next = new Set([...previous].filter((id) => eligibleIds.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [category, archivedSpaces, archivedTasks]);

  const changeCategory = (next: Category): void => {
    if (pendingRef.current || next === category) return;
    setCategory(next);
    setPage(1);
    setSelectedIds(new Set());
    setStatus(null);
  };
  const changeQuery = (next: string): void => {
    if (pendingRef.current) return;
    setQuery(next);
    setPage(1);
    setSelectedIds(new Set());
    setStatus(null);
  };
  const toggleSelection = (id: string): void => {
    if (pendingRef.current) return;
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const togglePageSelection = (): void => {
    if (pendingRef.current) return;
    setSelectedIds((previous) => {
      const next = new Set(previous);
      for (const id of pageIds) {
        if (allPageSelected) next.delete(id); else next.add(id);
      }
      return next;
    });
  };
  const beginDelete = (target: DeleteTarget): void => {
    if (!pendingRef.current) setConfirmDelete(target);
  };
  const restore = async (kind: "space" | "task", id: string): Promise<void> => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setStatus({ tone: "pending", text: "正在恢复归档内容…" });
    try {
      await (kind === "space" ? restoreSpace(id) : restoreTask(id));
      setSelectedIds((previous) => new Set([...previous].filter((selectedId) => selectedId !== id)));
      setStatus({ tone: "success", text: "已恢复归档内容。" });
    } catch (error) {
      setStatus({ tone: "error", text: `恢复失败：${errorMessage(error)}` });
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  const deleteConfirmed = async (): Promise<void> => {
    if (pendingRef.current || !confirmDelete) return;
    const target = confirmDelete;
    const names = new Map([
      ...spaces.map((space) => [space.id, space.name] as const),
      ...tasks.map((task) => [task.id, task.title] as const),
    ]);
    pendingRef.current = true;
    setPending(true);
    setConfirmDelete(null);
    setStatus({ tone: "pending", text: "正在彻底删除归档内容，请稍候…" });
    try {
      const result = await purgeArchivedContent(target);
      const deletedIds = new Set([...result.deletedSpaceIds, ...result.deletedTaskIds]);
      const remainingFailures = result.failures.filter((failure) => !(failure.kind === "space" ? result.deletedSpaceIds : result.deletedTaskIds).includes(failure.id));
      const cleanupWarnings = result.failures.filter((failure) => (failure.kind === "space" ? result.deletedSpaceIds : result.deletedTaskIds).includes(failure.id));
      const failedIds = remainingFailures.filter((failure) => failure.kind === (category === "spaces" ? "space" : "task")).map((failure) => failure.id);
      setSelectedIds((previous) => new Set([...previous, ...failedIds].filter((id) => !deletedIds.has(id))));
      const deletedSummary = `已${result.failures.length === 0 ? "彻底" : ""}删除 ${result.deletedSpaceIds.length} 个空间、${result.deletedTaskIds.length} 个任务。`;
      if (result.failures.length > 0) {
        const describe = (failures: typeof result.failures): string => failures.slice(0, 5).map((failure) => `「${names.get(failure.id) ?? failure.id}」：${failure.error}`).join("；") + (failures.length > 5 ? `；另有 ${failures.length - 5} 项` : "");
        const remainingText = remainingFailures.length ? ` ${remainingFailures.length} 项未删除：${describe(remainingFailures)}。未删除的失败项已保留选择，可重试。` : "";
        const cleanupText = cleanupWarnings.length ? ` ${cleanupWarnings.length} 项记录已删除，但关联内容清理失败：${describe(cleanupWarnings)}。` : "";
        setStatus({ tone: "error", text: `${deletedSummary}${remainingText}${cleanupText}` });
      } else {
        setStatus({ tone: "success", text: deletedSummary });
      }
    } catch (error) {
      setSelectedIds((previous) => new Set([...previous, ...(category === "spaces" ? target.spaceIds : target.taskIds)]));
      setStatus({ tone: "error", text: `删除失败：${errorMessage(error)}。请查看归档列表后重试。` });
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  const deleteSummary = useMemo(() => {
    if (!confirmDelete) return null;
    const subtreeIds = new Set(spaces.filter((space) => confirmDelete.spaceIds.some((id) => isSpaceDescendant(spaces, id, space.id))).map((space) => space.id));
    const taskIds = new Set([...confirmDelete.taskIds, ...tasks.filter((task) => task.spaceId && subtreeIds.has(task.spaceId)).map((task) => task.id)]);
    const singleName = confirmDelete.spaceIds.length + confirmDelete.taskIds.length === 1
      ? (spaceById.get(confirmDelete.spaceIds[0] ?? "")?.name ?? tasks.find((task) => task.id === confirmDelete.taskIds[0])?.title)
      : null;
    return { spaceCount: subtreeIds.size, taskCount: taskIds.size, singleName };
  }, [confirmDelete, spaces, tasks, spaceById]);

  return (
    <div className="record-management archive-management" aria-busy={pending}>
      <div className="record-intro">归档内容完整保留，恢复后回到侧栏。选择可跨页保留，切换分类或搜索会清空选择。</div>
      <div className="record-toolbar">
        <div className="record-tabs" role="group" aria-label="归档分类">
          <button type="button" disabled={pending} aria-pressed={category === "spaces"} onClick={() => changeCategory("spaces")}>空间 <span>{archivedSpaces.length}</span></button>
          <button type="button" disabled={pending} aria-pressed={category === "tasks"} onClick={() => changeCategory("tasks")}>任务 <span>{archivedTasks.length}</span></button>
        </div>
        <input className="record-search" type="search" disabled={pending} aria-label="搜索归档" placeholder={category === "spaces" ? "搜索空间名称或路径" : "搜索任务或所属空间"} value={query} onChange={(event) => changeQuery(event.target.value)} />
      </div>
      <div className="archive-selection-toolbar" role="group" aria-label="归档批量操作">
        <label className="archive-page-selection">
          <input ref={pageSelectionRef} type="checkbox" checked={allPageSelected} disabled={pending || pageIds.length === 0} onChange={togglePageSelection} />
          选择本页
        </label>
        <button type="button" className="btn" disabled={pending || total === 0 || allFilteredSelected} onClick={() => setSelectedIds(new Set(filteredRecords.map((record) => record.id)))}>选择全部匹配项（{total}）</button>
        <button type="button" className="btn" disabled={pending || selectedIds.size === 0} onClick={() => setSelectedIds(new Set())}>清空选择</button>
        <span className="archive-selection-count" aria-live="polite">已选 {selectedIds.size} 项</span>
        <button type="button" className="btn danger" disabled={pending || selectedIds.size === 0} onClick={() => beginDelete({ spaceIds: category === "spaces" ? [...selectedIds] : [], taskIds: category === "tasks" ? [...selectedIds] : [] })}>
          <IconTrash size={13} /> {pending ? "处理中…" : "批量彻底删除"}
        </button>
      </div>
      {status && <div className={`record-status archive-operation-status ${status.tone}`} role={status.tone === "error" ? "alert" : "status"}>{status.text}</div>}
      <div className="record-list" ref={listRef}>
        {total === 0 && <div className="record-empty"><IconArchive size={28} /><b>{needle ? "没有匹配的归档" : category === "spaces" ? "暂无归档空间" : "暂无归档任务"}</b><span>{needle ? "试试其他关键词，或清空搜索。" : "在侧栏归档的内容会显示在这里。"}</span></div>}
        {category === "spaces" && filteredSpaces.slice(offset, offset + PAGE_SIZE).map((space) => {
          const subtreeIds = new Set(spaces.filter((candidate) => isSpaceDescendant(spaces, space.id, candidate.id)).map((candidate) => candidate.id));
          const taskCount = tasks.filter((task) => task.spaceId && subtreeIds.has(task.spaceId)).length;
          return (
            <div key={space.id} className={`archive-card${selectedIds.has(space.id) ? " selected" : ""}`}>
              <div className="archive-card-head">
                <input className="archive-record-checkbox" type="checkbox" aria-label={`选择空间「${space.name}」`} checked={selectedIds.has(space.id)} disabled={pending} onChange={() => toggleSelection(space.id)} />
                <span className="archive-card-icon"><IconFolder size={15} /></span>
                <div className="archive-card-title"><span className="archive-card-name" title={space.name}>{space.name}</span><span className="archive-card-badge">已归档</span></div>
                <div className="archive-card-actions">
                  <button type="button" className="btn" disabled={pending} title="恢复后重新出现在空间列表" onClick={() => void restore("space", space.id)}><IconRotate size={13} /> 恢复</button>
                  <button type="button" className="btn danger" disabled={pending} title="彻底删除空间、全部子空间、任务及记忆，不可恢复" onClick={() => beginDelete({ spaceIds: [space.id], taskIds: [] })}><IconTrash size={13} /> 彻底删除</button>
                </div>
              </div>
              {space.path && <div className="archive-card-path" title={space.path}><IconFolder size={12} /> {space.path}</div>}
              <div className="archive-card-meta">{subtreeIds.size > 1 ? `${subtreeIds.size - 1} 个子空间 · ` : ""}{taskCount > 0 ? `${taskCount} 个任务（含子空间）` : "无任务"}</div>
            </div>
          );
        })}
        {category === "tasks" && filteredTasks.slice(offset, offset + PAGE_SIZE).map((task) => {
          const inheritedArchive = Boolean(task.spaceId && effectiveSpaceArchiveMap.get(task.spaceId));
          const spaceName = spaceById.get(task.spaceId ?? "")?.name;
          return (
            <div key={task.id} className={`archive-card${selectedIds.has(task.id) ? " selected" : ""}`}>
              <div className="archive-card-head">
                <input className="archive-record-checkbox" type="checkbox" aria-label={`选择任务「${task.title}」`} checked={selectedIds.has(task.id)} disabled={pending} onChange={() => toggleSelection(task.id)} />
                <span className="archive-card-icon"><IconFile size={15} /></span>
                <div className="archive-card-title"><span className="archive-card-name" title={task.title}>{task.title}</span><span className="archive-card-badge">{task.archived ? "已归档" : "随空间归档"}</span></div>
                <div className="archive-card-actions">
                  <button type="button" className="btn" disabled={pending || inheritedArchive} title={inheritedArchive ? "请先恢复所属归档空间" : "恢复后重新出现在侧栏任务列表"} onClick={() => void restore("task", task.id)}><IconRotate size={13} /> 恢复</button>
                  <button type="button" className="btn danger" disabled={pending} title="彻底删除任务及应用管理的产物，不可恢复" onClick={() => beginDelete({ spaceIds: [], taskIds: [task.id] })}><IconTrash size={13} /> 彻底删除</button>
                </div>
              </div>
              <div className="archive-card-meta">{spaceName ? `所属空间：${spaceName}` : "普通任务"} · {formatTime(task.updatedAt)}</div>
            </div>
          );
        })}
      </div>
      <nav className="record-pager" aria-label="归档分页">
        <span>{total ? `共 ${total} 条 · ${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} 条` : "共 0 条"}</span>
        <div>
          <button type="button" className="btn" disabled={pending || currentPage <= 1} onClick={() => setPage(currentPage - 1)}>上一页</button>
          <span aria-live="polite">{currentPage} / {pages}</span>
          <button type="button" className="btn" disabled={pending || currentPage >= pages} onClick={() => setPage(currentPage + 1)}>下一页</button>
        </div>
      </nav>
      <ConfirmDialog
        open={confirmDelete !== null}
        title={deleteSummary?.singleName ? "彻底删除归档内容？" : "批量彻底删除归档？"}
        body={confirmDelete && deleteSummary ? <>
          {deleteSummary.singleName ? `确定要彻底删除「${deleteSummary.singleName}」吗？` : `确定要彻底删除已选择的 ${confirmDelete.spaceIds.length + confirmDelete.taskIds.length} 项归档内容吗？`}
          <br />
          {confirmDelete.spaceIds.length > 0 ? `将删除所选空间及其全部子空间（共 ${deleteSummary.spaceCount} 个空间）、${deleteSummary.taskCount} 个任务，以及空间记忆。` : `将删除 ${deleteSummary.taskCount} 个任务。`}
          <br />会话记录和应用管理的产物将一并清理。关联的本地文件夹及其中用户文件会保留，此操作不可恢复。
        </> : null}
        confirmLabel="彻底删除"
        danger
        onCancel={() => { if (!pendingRef.current) setConfirmDelete(null); }}
        onConfirm={() => void deleteConfirmed()}
      />
    </div>
  );
}

export default ArchivesTab;
