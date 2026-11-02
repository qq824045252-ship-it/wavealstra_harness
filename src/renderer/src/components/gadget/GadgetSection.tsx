import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { GadgetListItem, GadgetRuntimeState, GadgetScope } from "@shared/gadget-types";
import { useTextPrompt } from "@/components/common/useTextPrompt";
import ConfirmDialog from "@/components/common/ConfirmDialog";
import { useAppStore } from "@/store/appStore";
import GadgetMoveDialog from "./GadgetMoveDialog";
import GadgetCreateDialog from "./GadgetCreateDialog";
import GadgetSourceDialog from "./GadgetSourceDialog";

interface Props {
  scope: GadgetScope;
  includeInherited?: boolean;
  compact?: boolean;
  title?: string;
  viewOnly?: boolean;
}

function scopeKey(scope: GadgetScope): string {
  return scope.type === "global" ? "global" : scope.type === "workspace" ? `workspace:${scope.workspaceId}` : `task:${scope.taskId}`;
}

function statusLabel(state: GadgetRuntimeState): string {
  if (state.status === "running") return "Running";
  if (state.status === "starting") return "Starting";
  if (state.status === "error") return "Error";
  return "Stopped";
}

function gadgetApi(): NonNullable<typeof window.api>["gadget"] {
  const api = window.api?.gadget;
  if (!api) throw new Error("Gadget 能力尚未加载，请重启 MyBuddy");
  return api;
}

export default function GadgetSection({ scope, includeInherited = false, compact = false, title, viewOnly = false }: Props): React.JSX.Element {
  const spaces = useAppStore((state) => state.spaces);
  const activeTaskId = useAppStore((state) => state.activeTaskId);
  const taskWorkspaceId = useAppStore((state) => scope.type === "task" ? state.tasks.find((task) => task.id === scope.taskId)?.spaceId : undefined);
  const [items, setItems] = useState<GadgetListItem[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<GadgetListItem | null>(null);
  const [openItem, setOpenItem] = useState<GadgetListItem | null>(null);
  const [moveItem, setMoveItem] = useState<{ item: GadgetListItem; initialTarget?: "global" | "workspace" } | null>(null);
  const [openActionId, setOpenActionId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [sourceItem, setSourceItem] = useState<GadgetListItem | null>(null);
  const [viewerRevision, setViewerRevision] = useState(0);
  const [query, setQuery] = useState("");
  const { requestText, textPromptDialog } = useTextPrompt();
  const key = scopeKey(scope);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const rows = await gadgetApi().list({ scope, includeInherited });
      setItems(rows);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [key, includeInherited, taskWorkspaceId]);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    const api = window.api?.gadget;
    if (!api) return;
    return api.onChanged((event) => {
      void reload();
      if (event.type === "updated" && event.gadgetId === openItem?.id) setViewerRevision((revision) => revision + 1);
      if (event.type === "deleted" && event.gadgetId === openItem?.id) setOpenItem(null);
      // Only the active task's main strip owns Agent open requests, not its duplicate preview panel.
      if (event.type === "open-requested" && compact && scope.type === "task" && event.taskId === scope.taskId) {
        void api.get(event.gadgetId).then((item) => { if (item?.runtime.url) setOpenItem(item); })
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
      }
    });
  }, [reload, compact, key, openItem?.id]);
  useEffect(() => {
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(".gadget-action-menu")) setOpenActionId(null);
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpenActionId(null);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);
  useEffect(() => {
    if (!openItem) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpenItem(null);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [openItem]);

  const direct = useMemo(() => items.filter((item) => !item.inherited), [items]);
  const inherited = useMemo(() => items.filter((item) => item.inherited), [items]);
  const visibleDirect = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? direct.filter((item) => `${item.name} ${item.description ?? ""}`.toLowerCase().includes(needle)) : direct;
  }, [direct, query]);

  const run = async (item: GadgetListItem, action: "start" | "stop" | "restart"): Promise<void> => {
    try {
      setBusyId(item.id);
      const state = await gadgetApi()[action](item.id);
      if (state.status === "error") throw new Error(state.error || "Gadget 启动失败");
      await reload();
      if (action !== "stop") setOpenItem({ ...item, runtime: state });
      else if (openItem?.id === item.id) setOpenItem(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };

  const saveToMyGadgets = async (item: GadgetListItem): Promise<void> => {
    try {
      setBusyId(item.id);
      await gadgetApi().moveScope({ gadgetId: item.id, scope: { type: "global" } });
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };

  const edit = async (item: GadgetListItem): Promise<void> => {
    const name = await requestText({ title: "编辑 Gadget", label: "名称", initialValue: item.name, maxLength: 120 });
    if (!name?.trim()) return;
    const description = await requestText({
      title: "编辑 Gadget",
      label: "描述（可留空）",
      initialValue: item.description ?? "",
      maxLength: 2000,
      allowEmpty: true,
    });
    if (description === null) return;
    try {
      setBusyId(item.id);
      await gadgetApi().update({ gadgetId: item.id, name: name.trim(), description });
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (item: GadgetListItem): Promise<void> => {
    try {
      setBusyId(item.id);
      await gadgetApi().delete(item.id);
      if (openItem?.id === item.id) setOpenItem(null);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };

  const saveBlueprint = async (item: GadgetListItem): Promise<void> => {
    const name = await requestText({
      title: "保存为 Blueprint",
      label: "Blueprint 名称",
      initialValue: item.name,
      maxLength: 120,
      confirmLabel: "保存",
    });
    if (!name?.trim()) return;
    try {
      setBusyId(item.id);
      await gadgetApi().saveAsBlueprint({ gadgetId: item.id, name: name.trim() });
      setNotice("已保存为 Gadget Blueprint");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };

  const exportArtifact = async (item: GadgetListItem): Promise<void> => {
    if (!activeTaskId) { setError("请先打开一个任务，再把 Gadget 结果导出为 Artifact"); return; }
    try {
      setBusyId(item.id);
      await gadgetApi().exportArtifact({ gadgetId: item.id, taskId: activeTaskId, title: item.name });
      setNotice("已导出为独立 HTML Artifact");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };

  const renderCard = (item: GadgetListItem): React.JSX.Element => {
    const busy = busyId === item.id;
    const taskScoped = item.scope.type === "task";
    const workspaceScoped = item.scope.type === "workspace";
    const actionOpen = openActionId === item.id;
    const closeActions = (): void => setOpenActionId(null);
    return (
      <article key={`${item.inherited ? "inherited" : "direct"}:${item.id}`} className={`gadget-card${item.inherited ? " gadget-card--inherited" : ""}`}>
        <div className="gadget-card-main">
          <div className="gadget-card-name">{item.name}</div>
          {item.description && <div className="gadget-card-description">{item.description}</div>}
          <div className="gadget-card-meta">
            <span className={`gadget-status gadget-status--${item.runtime.status}`}>{statusLabel(item.runtime)}</span>
            {taskScoped && <span>Temporary</span>}
            {item.inherited && <span>From {item.scope.type === "global" ? "My Gadgets" : spaces.find((space) => space.id === item.inheritedFromWorkspaceId)?.name ?? "工作空间"}</span>}
          </div>
          {item.runtime.error && <div className="gadget-inline-error">{item.runtime.error}</div>}
        </div>
        <div className="gadget-card-actions">
          <button className="btn btn--primary" disabled={busy} onClick={() => void run(item, "start")}>Open</button>
          {!viewOnly && !item.inherited && taskScoped && <button className="btn" disabled={busy} onClick={() => setMoveItem({ item, initialTarget: "workspace" })}>Save to Workspace</button>}
          {!viewOnly && !item.inherited && taskScoped && <button className="btn" disabled={busy} onClick={() => void saveToMyGadgets(item)}>Save to My Gadgets</button>}
          {!viewOnly && !item.inherited && (taskScoped || workspaceScoped) && <button className="btn btn--ghost gadget-danger" disabled={busy} onClick={() => setPendingRemove(item)}>Delete</button>}
          {!viewOnly && (!item.inherited || scope.type === "task") && (
            <details className="gadget-action-menu" open={actionOpen}>
              <summary
                className="btn btn--ghost"
                aria-label={`更多操作：${item.name}`}
                aria-haspopup="menu"
                aria-expanded={actionOpen}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setOpenActionId((current) => current === item.id ? null : item.id);
                }}
              >•••</summary>
              {actionOpen && <div className="gadget-action-menu-popover" role="menu">
                {item.runtime.status === "running" && <button type="button" disabled={busy} onClick={() => { closeActions(); void run(item, "restart"); }}>重新启动</button>}
                {item.runtime.status === "running" && <button type="button" disabled={busy} onClick={() => { closeActions(); void run(item, "stop"); }}>停止</button>}
                <button type="button" disabled={busy} onClick={() => { closeActions(); void edit(item); }}>编辑名称与描述</button>
                <button type="button" disabled={busy} onClick={() => { closeActions(); setSourceItem(item); }}>编辑源码</button>
                {!item.inherited && !taskScoped && <button type="button" disabled={busy} onClick={() => { closeActions(); setMoveItem({ item }); }}>移动到…</button>}
                <button type="button" disabled={busy} onClick={() => { closeActions(); void saveBlueprint(item); }}>保存为 Blueprint</button>
                <button type="button" disabled={busy} onClick={() => { closeActions(); void exportArtifact(item); }}>导出 Artifact</button>
                {!item.inherited && item.scope.type === "global" && <button type="button" className="gadget-danger" disabled={busy} onClick={() => { closeActions(); setPendingRemove(item); }}>删除</button>}
              </div>}
            </details>
          )}
        </div>
      </article>
    );
  };

  if (compact && direct.length === 0 && inherited.length === 0 && !error) return <></>;

  return (
    <section className={`gadget-section${compact ? " gadget-section--compact" : ""}`}>
      <div className="gadget-section-head">
        <div>
          <h2>{compact ? `Gadgets ${items.length}` : title ?? (scope.type === "global" ? "My Gadgets" : "Gadgets")}</h2>
          {!compact && <p>{viewOnly ? "快速查看当前任务的 Gadget；管理操作保留在对话顶部。" : scope.type === "global" ? "可在 MyBuddy 各处重复使用的个人工具。" : scope.type === "workspace" ? "为这个工作空间持续提供帮助的工具。" : "当前任务创建和使用的临时工具；可随时保存到工作空间或 My Gadgets。"}</p>}
        </div>
        <div className="gadget-section-tools">
          {scope.type === "global" && !compact && <input className="gadget-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Gadget" aria-label="搜索 Gadget" />}
          {!compact && !viewOnly && <button className="btn btn--primary" onClick={() => { setError(null); setCreateOpen(true); }}>New Gadget</button>}
        </div>
      </div>
      {error && <div className="gadget-error" role="alert">{error}<button type="button" onClick={() => setError(null)}>×</button></div>}
      {notice && <div className="gadget-notice" role="status">{notice}<button type="button" onClick={() => setNotice(null)}>×</button></div>}
      {visibleDirect.length === 0 && inherited.length === 0 ? (
        <div className="gadget-empty">
          <strong>{query.trim() ? "没有匹配的 Gadget" : scope.type === "global" ? "还没有 Gadget" : scope.type === "workspace" ? "这个工作空间还没有 Gadget" : "这个任务还没有 Gadget"}</strong>
          {!query.trim() && <span>{scope.type === "global" ? "创建一个可重复使用的工具，或把任务 Gadget 保存到 My Gadgets。" : scope.type === "workspace" ? "为这个工作空间创建工具，或把已有 Gadget 移动到这里。" : "让 Agent 创建临时工具，随后可保存到工作空间或 My Gadgets。"}</span>}
        </div>
      ) : <div className="gadget-grid">{visibleDirect.map(renderCard)}</div>}
      {includeInherited && inherited.length > 0 && (
        <div className="gadget-inherited-group">
          <h3>{scope.type === "task" ? "工作空间与个人工具" : "Inherited"}</h3>
          <div className="gadget-grid">{inherited.map(renderCard)}</div>
        </div>
      )}
      {openItem?.runtime.url && createPortal(
        <div
          className="gadget-view-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={openItem.name}
          onPointerDown={(event) => { if (event.target === event.currentTarget) setOpenItem(null); }}
        >
          <div className="gadget-view">
            <header><strong title={openItem.name}>{openItem.name}</strong><span>{statusLabel(openItem.runtime)}</span><button className="btn btn--ghost" onClick={() => setOpenItem(null)}>关闭</button></header>
            <iframe key={`${openItem.id}:${viewerRevision}`} title={openItem.name} src={openItem.runtime.url} sandbox="allow-scripts allow-forms allow-modals allow-downloads allow-popups allow-popups-to-escape-sandbox" />
          </div>
        </div>,
        document.body,
      )}
      {sourceItem && createPortal(<GadgetSourceDialog gadget={sourceItem} onClose={() => setSourceItem(null)} />, document.body)}
      {moveItem && (
        <GadgetMoveDialog
          gadget={moveItem.item}
          initialTarget={moveItem.initialTarget}
          onClose={() => setMoveItem(null)}
          onMoved={() => { setMoveItem(null); void reload(); }}
        />
      )}
      {createOpen && (
        <GadgetCreateDialog
          scope={scope}
          onClose={() => setCreateOpen(false)}
          onCreated={(item) => {
            setCreateOpen(false);
            void reload();
            if (item.runtime.status === "error") {
              setError(item.runtime.error || "Gadget 启动失败");
              return;
            }
            if (item.runtime.url) setOpenItem(item);
          }}
        />
      )}
      <ConfirmDialog
        open={pendingRemove !== null}
        title={`删除 Gadget「${pendingRemove?.name ?? ""}」？`}
        body="源码和持久数据将一并删除；已导出的 Artifact 不受影响。"
        confirmLabel="删除"
        danger
        onCancel={() => setPendingRemove(null)}
        onConfirm={() => {
          const target = pendingRemove;
          setPendingRemove(null);
          if (target) void remove(target);
        }}
      />
      {textPromptDialog}
    </section>
  );
}
