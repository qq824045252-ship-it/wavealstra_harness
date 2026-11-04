import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { GadgetListItem, GadgetRuntimeState, GadgetScope } from "@shared/gadget-types";
import { useTextPrompt } from "@/components/common/useTextPrompt";
import ConfirmDialog from "@/components/common/ConfirmDialog";
import { useAppStore } from "@/store/appStore";
import { IconArrowUpRight, IconPlus, IconPuzzle } from "@/components/common/icons";
import GadgetMoveDialog from "./GadgetMoveDialog";
import GadgetCreateDialog from "./GadgetCreateDialog";
import GadgetSourceDialog from "./GadgetSourceDialog";
import { openGadgetBrowser } from "@/lib/gadgetBrowser";

interface Props {
  scope: GadgetScope;
  includeInherited?: boolean;
  title?: string;
  hideHeader?: boolean;
}

function scopeKey(scope: GadgetScope): string {
  return scope.type === "global" ? "global" : scope.type === "workspace" ? `workspace:${scope.workspaceId}` : `task:${scope.taskId}`;
}

function statusLabel(state: GadgetRuntimeState): string {
  if (state.status === "running") return "运行中";
  if (state.status === "starting") return "启动中";
  if (state.status === "error") return "异常";
  return "已停止";
}

function gadgetApi(): NonNullable<typeof window.api>["gadget"] {
  const api = window.api?.gadget;
  if (!api) throw new Error("Gadget 能力尚未加载，请重启 MyBuddy");
  return api;
}

export default function GadgetSection({ scope, includeInherited = false, title, hideHeader = false }: Props): React.JSX.Element {
  const spaces = useAppStore((state) => state.spaces);
  const activeTaskId = useAppStore((state) => state.activeTaskId);
  const taskWorkspaceId = useAppStore((state) => scope.type === "task" ? state.tasks.find((task) => task.id === scope.taskId)?.spaceId : undefined);
  const [items, setItems] = useState<GadgetListItem[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<GadgetListItem | null>(null);
  const [moveItem, setMoveItem] = useState<{ item: GadgetListItem; initialTarget?: "global" | "workspace" } | null>(null);
  const [openActionId, setOpenActionId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [sourceItem, setSourceItem] = useState<GadgetListItem | null>(null);
  const [query, setQuery] = useState("");
  const { requestText, textPromptDialog } = useTextPrompt();
  const key = scopeKey(scope);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const rows = await gadgetApi().list({ scope, includeInherited });
      setItems(rows);
      useAppStore.getState().setGadgetsCount(rows.length);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [key, includeInherited, taskWorkspaceId]);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    const api = window.api?.gadget;
    if (!api) return;
    return api.onChanged(() => { void reload(); });
  }, [reload]);
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
      if (action !== "stop" && state.url) openGadgetBrowser(state.url);
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
    const actionOpen = openActionId === item.id;
    const closeActions = (): void => setOpenActionId(null);
    const originName =
      item.scope.type === "global"
        ? "我的工作台"
        : spaces.find((space) => space.id === item.inheritedFromWorkspaceId)?.name ?? "工作空间";

    return (
      <article
        key={`${item.inherited ? "inherited" : "direct"}:${item.id}`}
        className={`gadget-card${item.inherited ? " gadget-card--inherited" : ""}`}
      >
        <div className="gadget-card-top">
          <div className="gadget-card-title-row">
            <span className="gadget-card-icon">
              <IconPuzzle size={14} />
            </span>
            <span className="gadget-card-name" title={item.name}>
              {item.name}
            </span>
          </div>
          <div className="gadget-card-actions">
            <button
              type="button"
              className="btn btn--primary btn--sm gadget-open-btn"
              disabled={busy}
              onClick={() => void run(item, "start")}
              title="在侧栏浏览器中打开"
            >
              <IconArrowUpRight size={12} />
              <span>打开</span>
            </button>
            {(!item.inherited || scope.type === "task") && (
              <details className="gadget-action-menu" open={actionOpen}>
                <summary
                  className="icon-btn gadget-more-btn"
                  aria-label={`更多操作：${item.name}`}
                  aria-haspopup="menu"
                  aria-expanded={actionOpen}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setOpenActionId((current) => (current === item.id ? null : item.id));
                  }}
                >
                  •••
                </summary>
                {actionOpen && (
                  <div className="gadget-action-menu-popover" role="menu">
                    {item.runtime.status === "running" && (
                      <button type="button" disabled={busy} onClick={() => { closeActions(); void run(item, "restart"); }}>
                        重新启动
                      </button>
                    )}
                    {item.runtime.status === "running" && (
                      <button type="button" disabled={busy} onClick={() => { closeActions(); void run(item, "stop"); }}>
                        停止
                      </button>
                    )}
                    <button type="button" disabled={busy} onClick={() => { closeActions(); void edit(item); }}>
                      编辑名称与描述
                    </button>
                    <button type="button" disabled={busy} onClick={() => { closeActions(); setSourceItem(item); }}>
                      编辑源码
                    </button>
                    {!item.inherited && taskScoped && (
                      <button type="button" disabled={busy} onClick={() => { closeActions(); setMoveItem({ item, initialTarget: "workspace" }); }}>
                        保存到工作空间
                      </button>
                    )}
                    {!item.inherited && taskScoped && (
                      <button type="button" disabled={busy} onClick={() => { closeActions(); void saveToMyGadgets(item); }}>
                        保存到我的工作台
                      </button>
                    )}
                    {!item.inherited && !taskScoped && (
                      <button type="button" disabled={busy} onClick={() => { closeActions(); setMoveItem({ item }); }}>
                        移动到…
                      </button>
                    )}
                    <button type="button" disabled={busy} onClick={() => { closeActions(); void saveBlueprint(item); }}>
                      保存为 Blueprint
                    </button>
                    <button type="button" disabled={busy} onClick={() => { closeActions(); void exportArtifact(item); }}>
                      导出 Artifact
                    </button>
                    {!item.inherited && (
                      <button type="button" className="gadget-danger" disabled={busy} onClick={() => { closeActions(); setPendingRemove(item); }}>
                        删除
                      </button>
                    )}
                  </div>
                )}
              </details>
            )}
          </div>
        </div>

        <div className="gadget-card-meta">
          <span className={`gadget-status-badge status--${item.runtime.status}`}>
            <span className="gadget-status-dot" />
            {statusLabel(item.runtime)}
          </span>
          {item.inherited && (
            <span className="gadget-origin-tag" title={`来自 ${originName}`}>
              来自 {originName}
            </span>
          )}
          {!item.inherited && taskScoped && (
            <span className="gadget-origin-tag temporary">当前任务临时</span>
          )}
        </div>

        {item.description && <div className="gadget-card-description">{item.description}</div>}
        {item.runtime.error && <div className="gadget-inline-error">{item.runtime.error}</div>}
      </article>
    );
  };

  return (
    <section className="gadget-section">
      {scope.type === "task" || hideHeader ? (
        <div className="gadgets-view-header">
          <div className="gadgets-view-stats">
            <span className="gadgets-count-label">工作台</span>
            <span className="gadgets-count-badge">{items.length}</span>
          </div>
          <button
            type="button"
            className="extension-tab-add-btn gadgets-header-add-btn"
            title="新建工具"
            onClick={() => {
              setError(null);
              setCreateOpen(true);
            }}
          >
            <IconPlus size={12} />
            <span>新建工具</span>
          </button>
        </div>
      ) : (
        <div className="gadget-section-head">
          <div>
            <h2>{title ?? (scope.type === "global" ? "我的工作台" : "工作台")}</h2>
            <p>{scope.type === "global" ? "可在 MyBuddy 各处重复使用的个人工具。" : "为这个工作空间持续提供帮助的工具。"}</p>
          </div>
          <div className="gadget-section-tools">
            {scope.type === "global" && (
              <input
                className="gadget-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索工具"
                aria-label="搜索工具"
              />
            )}
            <button className="btn btn--primary" onClick={() => { setError(null); setCreateOpen(true); }}>新建工具</button>
          </div>
        </div>
      )}

      {error && <div className="gadget-error" role="alert">{error}<button type="button" onClick={() => setError(null)}>×</button></div>}
      {notice && <div className="gadget-notice" role="status">{notice}<button type="button" onClick={() => setNotice(null)}>×</button></div>}

      <div className="gadgets-panel-content">
        {visibleDirect.length === 0 && inherited.length === 0 ? (
          <div className="gadget-empty-state">
            <IconPuzzle size={36} className="gadget-empty-icon" />
            <h4 className="gadget-empty-title">当前任务暂无工作台工具</h4>
            <p className="gadget-empty-desc">随时点击上方「新建工具」为当前任务创建轻量独立工具</p>
          </div>
        ) : (
          <div className="gadget-groups-wrapper">
            {visibleDirect.length > 0 && (
              <div className="gadget-group">
                <div className="gadget-group-header">
                  <span className="gadget-group-title">当前任务</span>
                  <span className="gadget-group-badge">{visibleDirect.length}</span>
                </div>
                <div className="gadget-grid">{visibleDirect.map(renderCard)}</div>
              </div>
            )}
            {includeInherited && inherited.length > 0 && (
              <div className="gadget-group">
                <div className="gadget-group-header">
                  <span className="gadget-group-title">空间与个人工具</span>
                  <span className="gadget-group-badge">{inherited.length}</span>
                </div>
                <div className="gadget-grid">{inherited.map(renderCard)}</div>
              </div>
            )}
          </div>
        )}
      </div>
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
            if (item.runtime.url) openGadgetBrowser(item.runtime.url);
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
