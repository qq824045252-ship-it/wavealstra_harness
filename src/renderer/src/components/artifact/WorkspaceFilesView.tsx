import { useEffect, useMemo, useState } from "react";
import type { WorkspaceFileNodeDto as WorkspaceTreeNode } from "../../../../shared/agent-ipc";
import { useAppStore } from "@/store/appStore";
import { FileBadge } from "@/components/common/FileBadge";
import ConfirmDialog from "@/components/common/ConfirmDialog";
import PopupContextMenu from "@/components/common/PopupContextMenu";
import {
  IconChevronRight,
  IconCopy,
  IconFolder,
  IconGlobe,
  IconOpenExternal,
  IconPencil,
  IconPlus,
  IconSearch,
  IconTrash,
} from "@/components/common/icons";
import { canNativeDrag, startNativeFileDrag } from "@/lib/nativeFileDrag";
import {
  WORKSPACE_FILES_CHANGED_EVENT,
  beginWorkspaceFileDrag,
  endWorkspaceFileDrag,
  setWorkspaceFileDragData,
} from "@/lib/workspaceFileDrag";
import { joinWorkspaceAbs, toWorkspaceRelative } from "@/lib/workspace";
import { fileUrlForAbsolutePath } from "@/lib/browserLinks";
import ExtensionModeDropdown from "./ExtensionModeDropdown";

function filterTree(nodes: WorkspaceTreeNode[], query: string): WorkspaceTreeNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;
  return nodes
    .map((n) => {
      if (n.kind === "file") {
        return n.name.toLowerCase().includes(q) ? n : null;
      }
      const children = filterTree(n.children ?? [], query);
      if (n.name.toLowerCase().includes(q) || children.length > 0) {
        return { ...n, children };
      }
      return null;
    })
    .filter((n): n is WorkspaceTreeNode => Boolean(n));
}

function collectFolderPaths(nodes: WorkspaceTreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind !== "folder") continue;
    paths.push(node.path);
    if (node.children?.length) {
      paths.push(...collectFolderPaths(node.children));
    }
  }
  return paths;
}

function parentRel(rel: string): string {
  const norm = rel.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = norm.lastIndexOf("/");
  return idx < 0 ? "" : norm.slice(0, idx);
}

type MenuTarget =
  | { x: number; y: number; path: string; name: string; kind: "file" | "folder" }
  | { x: number; y: number; path: ""; name: ""; kind: "root" };

interface TreeRowProps {
  node: WorkspaceTreeNode;
  depth: number;
  path: string;
  root: string;
  expanded: Set<string>;
  selectedPath: string | null;
  renamingPath: string | null;
  renameDraft: string;
  dropTarget: string | null;
  draggingPath: string | null;
  onToggleFolder: (path: string) => void;
  onSelectFile: (path: string, name: string) => void;
  onContext: (target: MenuTarget) => void;
  onRenameDraft: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onDragStartPath: (path: string) => void;
  onDragEnd: () => void;
  onDropOnFolder: (destRel: string, event: React.DragEvent) => void;
  onSetDropTarget: (path: string | null) => void;
}

function TreeRow({
  node,
  depth,
  path,
  root,
  expanded,
  selectedPath,
  renamingPath,
  renameDraft,
  dropTarget,
  draggingPath,
  onToggleFolder,
  onSelectFile,
  onContext,
  onRenameDraft,
  onCommitRename,
  onCancelRename,
  onDragStartPath,
  onDragEnd,
  onDropOnFolder,
  onSetDropTarget,
}: TreeRowProps): React.JSX.Element {
  const abs = joinWorkspaceAbs(root, path);
  const dragEnabled = canNativeDrag(abs);
  const isRenaming = renamingPath === path;
  const isDragging = draggingPath === path;

  const startDrag = (e: React.DragEvent): void => {
    if (!dragEnabled) {
      e.preventDefault();
      return;
    }
    onDragStartPath(path);
    beginWorkspaceFileDrag([abs]);
    setWorkspaceFileDragData(e, [abs]);
    if (!startNativeFileDrag(e, abs)) {
      /* 系统拖出失败时仍走 HTML5，侧栏/输入框可读 dataTransfer */
    }
  };

  const renameInput = (
    <input
      className="ws-tree-rename"
      autoFocus
      value={renameDraft}
      onChange={(e) => onRenameDraft(e.target.value)}
      onBlur={onCommitRename}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommitRename();
        }
        if (e.key === "Escape") {
          e.preventDefault();
          onCancelRename();
        }
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );

  if (node.kind === "file") {
    return (
      <button
        type="button"
        className={`ws-tree-row file ${selectedPath === path ? "active" : ""}${dragEnabled ? " is-draggable" : ""}${isDragging ? " is-dragging" : ""}`}
        style={{ paddingLeft: `${10 + depth * 16}px` }}
        onClick={() => onSelectFile(path, node.name)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onContext({ x: e.clientX, y: e.clientY, path, name: node.name, kind: "file" });
        }}
        draggable={dragEnabled && !isRenaming}
        onDragStart={startDrag}
        onDragEnd={onDragEnd}
        title={dragEnabled ? `${abs}\n可拖到左侧任务、输入框、桌面或其他应用` : abs}
      >
        <FileBadge name={node.name} size={14} />
        {isRenaming ? renameInput : <span className="ws-tree-name">{node.name}</span>}
      </button>
    );
  }

  const isExpanded = expanded.has(path);
  const isDrop = dropTarget === path;
  return (
    <>
      <button
        type="button"
        className={`ws-tree-row folder ${isExpanded ? "expanded" : ""}${dragEnabled ? " is-draggable" : ""}${isDrop ? " drop-target" : ""}${isDragging ? " is-dragging" : ""}`}
        style={{ paddingLeft: `${10 + depth * 16}px` }}
        onClick={() => onToggleFolder(path)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onContext({ x: e.clientX, y: e.clientY, path, name: node.name, kind: "folder" });
        }}
        draggable={dragEnabled && !isRenaming}
        onDragStart={startDrag}
        onDragEnd={onDragEnd}
        onDragEnter={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onSetDropTarget(path);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "move";
          onSetDropTarget(path);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node)) return;
          onSetDropTarget(null);
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onSetDropTarget(null);
          onDropOnFolder(path, e);
        }}
        title={dragEnabled ? `${abs}\n可拖到左侧任务、输入框、桌面或其他应用` : abs}
      >
        <IconFolder size={14} className="ws-tree-folder-icon" />
        {isRenaming ? renameInput : <span className="ws-tree-name">{node.name}</span>}
        <IconChevronRight size={14} className={`ws-tree-chevron ${isExpanded ? "open" : ""}`} />
      </button>
      {isExpanded &&
        (node.children ?? []).map((child) => {
          const childPath = child.path;
          return (
            <TreeRow
              key={childPath}
              node={child}
              depth={depth + 1}
              path={childPath}
              root={root}
              expanded={expanded}
              selectedPath={selectedPath}
              renamingPath={renamingPath}
              renameDraft={renameDraft}
              dropTarget={dropTarget}
              draggingPath={draggingPath}
              onToggleFolder={onToggleFolder}
              onSelectFile={onSelectFile}
              onContext={onContext}
              onRenameDraft={onRenameDraft}
              onCommitRename={onCommitRename}
              onCancelRename={onCancelRename}
              onDragStartPath={onDragStartPath}
              onDragEnd={onDragEnd}
              onDropOnFolder={onDropOnFolder}
              onSetDropTarget={onSetDropTarget}
            />
          );
        })}
    </>
  );
}

export default function WorkspaceFilesView({
  query = "",
  floating = false,
  spaceId,
}: {
  query?: string;
  floating?: boolean;
  /** 传入后以该工作空间文件夹为根（工作空间详情「文件」Tab 嵌入模式），不再跟随活动任务 */
  spaceId?: string;
}): React.JSX.Element {
  const openWorkspaceFile = useAppStore((s) => s.openWorkspaceFile);
  const openWorkspaceFolder = useAppStore((s) => s.openWorkspaceFolder);
  const setBrowserUrl = useAppStore((s) => s.setBrowserUrl);
  const removeArtifactsForWorkspacePath = useAppStore((s) => s.removeArtifactsForWorkspacePath);
  const taskCwd = useAppStore(
    (s) => s.tasks.find((task) => task.id === s.activeTaskId)?.cwd,
  );
  const taskSpaceId = useAppStore(
    (s) => s.tasks.find((task) => task.id === s.activeTaskId)?.spaceId,
  );
  const page = useAppStore((s) => s.page);
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId);
  const draftSpaceId = useAppStore((s) => s.draft?.spaceId);
  const spaces = useAppStore((s) => s.spaces);
  const spaceRoot = useAppStore((s) =>
    spaceId ? s.spaces.find((space) => space.id === spaceId)?.path : undefined,
  );
  const contextSpaceId =
    spaceId || (page === "workspace" ? activeWorkspaceId : null) || taskSpaceId || draftSpaceId || null;
  const contextSpacePath = contextSpaceId
    ? spaces.find((space) => space.id === contextSpaceId)?.path
    : undefined;
  // 嵌入模式（spaceId）以空间文件夹为根。扩展面板：有空间上下文则用空间绑定文件夹，
  // 独立任务才退回 task.cwd。不要用隔离任务目录冒充空间文件夹。
  const root = spaceId ? spaceRoot : (contextSpacePath ?? taskCwd);
  const [tree, setTree] = useState<WorkspaceTreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [pendingDelete, setPendingDelete] = useState<{
    path: string;
    name: string;
    kind: "file" | "folder";
  } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [draggingPath, setDraggingPath] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [localFilter, setLocalFilter] = useState("");

  const reload = (): void => {
    if (!root) {
      setTree([]);
      useAppStore.getState().setWorkspaceFilesCount(0);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    void window.api
      ?.listWorkspaceFiles(root)
      .then((nodes) => {
        setTree(nodes);
        useAppStore.getState().setWorkspaceFilesCount(nodes.length);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError("");
    if (!root) {
      setTree([]);
      useAppStore.getState().setWorkspaceFilesCount(0);
      setLoading(false);
      return;
    }
    void window.api
      ?.listWorkspaceFiles(root)
      .then((nodes) => {
        if (!disposed) {
          setTree(nodes);
          useAppStore.getState().setWorkspaceFilesCount(nodes.length);
        }
      })
      .catch((reason: unknown) => {
        if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    const onChanged = (): void => {
      if (disposed || !root) return;
      void window.api
        ?.listWorkspaceFiles(root)
        .then((nodes) => {
          if (!disposed) {
            setTree(nodes);
            useAppStore.getState().setWorkspaceFilesCount(nodes.length);
          }
        })
        .catch(() => {
          /* 刷新失败保持当前树 */
        });
    };
    window.addEventListener(WORKSPACE_FILES_CHANGED_EVENT, onChanged);
    return () => {
      disposed = true;
      window.removeEventListener(WORKSPACE_FILES_CHANGED_EVENT, onChanged);
    };
  }, [root]);

  const activeQuery = query || localFilter;
  const filteredTree = useMemo(() => filterTree(tree, activeQuery), [tree, activeQuery]);

  const visibleExpanded = useMemo(() => {
    if (!activeQuery.trim()) return expanded;
    return new Set(collectFolderPaths(filteredTree));
  }, [activeQuery, filteredTree, expanded]);

  const flash = (text: string): void => {
    setNotice(text);
    window.setTimeout(() => setNotice((cur) => (cur === text ? null : cur)), 2200);
  };

  const toggleFolder = (path: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const openWithSystem = (rel: string): void => {
    if (!root) return;
    const abs = rel ? joinWorkspaceAbs(root, rel) : root;
    void window.api?.openFolder?.(abs).catch(() => {
      flash("打开失败，文件可能已被移动或删除");
    });
  };

  /** 本地 HTML → 应用内扩展栏浏览器（BrowserHost）渲染 */
  const openHtmlInBrowser = (rel: string): void => {
    if (!root) return;
    const abs = joinWorkspaceAbs(root, rel);
    // 盘符冒号保留原文（C: 编成 C%3A 会被 Chromium 拒载 ERR_ABORTED），其余段编码
    const fileUrl = fileUrlForAbsolutePath(abs);
    window.api?.browser?.open(fileUrl); // 主进程 BrowserHost 立即 loadURL
    setBrowserUrl(fileUrl); // 切面板到扩展栏浏览器并记录 URL（幂等）
  };

  const selectFile = (path: string, name: string): void => {
    setSelectedPath(path);
    if (spaceId) {
      // 空间嵌入模式：详情页没有活动任务 artifact 上下文，交给系统默认应用打开
      openWithSystem(path);
      return;
    }
    void openWorkspaceFile(path, name);
  };

  const openMenu = (target: MenuTarget): void => setMenu(target);

  const closeMenu = (): void => setMenu(null);

  const commitRename = (): void => {
    const path = renamingPath;
    const name = renameDraft.trim();
    setRenamingPath(null);
    if (!root || !path || !name) return;
    void window.api?.renameWorkspacePath?.(root, path, name).then((result) => {
      if (!result?.ok) {
        flash(result?.error || "重命名失败");
        return;
      }
      if (selectedPath === path) setSelectedPath(result.relativePath);
      reload();
    });
  };

  const startRename = (path: string, name: string): void => {
    closeMenu();
    setRenamingPath(path);
    setRenameDraft(name);
  };

  const createEntry = async (parentRelPath: string, kind: "file" | "folder"): Promise<void> => {
    closeMenu();
    if (!root) return;
    const name = kind === "folder" ? "新建文件夹" : "未命名.md";
    const result = await window.api?.createWorkspacePath?.(root, parentRelPath, name, kind);
    if (!result?.ok) {
      flash(result?.error || "创建失败");
      return;
    }
    if (parentRelPath) {
      setExpanded((prev) => new Set(prev).add(parentRelPath));
    }
    const createdName = result.relativePath.split("/").pop() ?? name;
    setRenamingPath(result.relativePath);
    setRenameDraft(createdName);
    reload();
  };

  const confirmDelete = async (): Promise<void> => {
    if (!root || !pendingDelete) return;
    const target = pendingDelete;
    setPendingDelete(null);
    const result = await window.api?.trashWorkspacePath?.(root, target.path);
    if (!result?.ok) {
      flash(result?.error || "删除失败");
      return;
    }
    await removeArtifactsForWorkspacePath(root, target.path);
    if (selectedPath === target.path || selectedPath?.startsWith(`${target.path}/`)) {
      setSelectedPath(null);
    }
    reload();
  };

  const pathsFromDrop = (event: React.DragEvent): string[] => {
    const files = event.dataTransfer.files;
    if (!files?.length) return [];
    return Array.from(files)
      .map((file) => window.api?.getPathForFile?.(file) || "")
      .filter(Boolean);
  };

  const dropOnFolder = (destRel: string, event?: React.DragEvent): void => {
    if (!root) return;
    const dropped = event ? pathsFromDrop(event) : [];
    const sources = dropped.length
      ? dropped
          .map((abs) => toWorkspaceRelative(root, abs))
          .filter(Boolean)
      : draggingPath
        ? [draggingPath]
        : [];
    if (!sources.length) return;
    void (async () => {
      for (const src of sources) {
        if (src === destRel || destRel.startsWith(`${src}/`)) continue;
        if (parentRel(src) === destRel) continue;
        const result = await window.api?.moveWorkspacePath?.(root, src, destRel);
        if (!result?.ok) flash(result?.error || "移动失败");
      }
      setDraggingPath(null);
      reload();
    })();
  };

  const reveal = (rel: string): void => {
    if (!root) return;
    const abs = joinWorkspaceAbs(root, rel);
    void window.api?.showItemInFolder?.(abs);
  };

  const copyPath = (rel: string): void => {
    if (!root) return;
    void navigator.clipboard.writeText(joinWorkspaceAbs(root, rel));
    flash("已复制路径");
  };

  return (
    <div
      className={`extension-body workspace-files-view ${floating ? "workspace-files-floating" : ""}`}
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest(".ws-tree-row")) return;
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY, path: "", name: "", kind: "root" });
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (!(e.target as HTMLElement).closest(".ws-tree-row.folder")) setDropTarget("");
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setDropTarget(null);
      }}
      onDrop={(e) => {
        if ((e.target as HTMLElement).closest(".ws-tree-row.folder")) return;
        e.preventDefault();
        setDropTarget(null);
        dropOnFolder("", e);
      }}
    >
      <div className="workspace-view-header">
        <div className="workspace-view-stats">
          <span className="workspace-count-label">工作空间文件</span>
          <span className="workspace-count-badge">{filteredTree.length}</span>
        </div>
        {tree.length > 5 && (
          <div className="artifacts-search-box">
            <IconSearch size={13} className="artifacts-search-icon" />
            <input
              type="text"
              className="artifacts-search-input"
              placeholder="过滤文件..."
              value={localFilter}
              onChange={(e) => setLocalFilter(e.target.value)}
            />
          </div>
        )}
      </div>
      {notice && <div className="ws-tree-notice">{notice}</div>}
      <div className={`ws-tree-list${dropTarget === "" ? " drop-target-root" : ""}`}>
        {filteredTree.map((node) => {
          const path = node.path;
          return (
            <TreeRow
              key={path}
              node={node}
              depth={0}
              path={path}
              root={root ?? ""}
              expanded={visibleExpanded}
              selectedPath={selectedPath}
              renamingPath={renamingPath}
              renameDraft={renameDraft}
              dropTarget={dropTarget}
              draggingPath={draggingPath}
              onToggleFolder={toggleFolder}
              onSelectFile={selectFile}
              onContext={openMenu}
              onRenameDraft={setRenameDraft}
              onCommitRename={commitRename}
              onCancelRename={() => setRenamingPath(null)}
              onDragStartPath={setDraggingPath}
              onDragEnd={() => {
                setDraggingPath(null);
                setDropTarget(null);
                endWorkspaceFileDrag();
              }}
              onDropOnFolder={(dest, event) => dropOnFolder(dest, event)}
              onSetDropTarget={setDropTarget}
            />
          );
        })}
        {loading && <div className="extension-empty">正在读取工作空间…</div>}
        {!loading && error && <div className="extension-empty">{error}</div>}
        {!loading && !error && filteredTree.length === 0 && (
          <div className="extension-empty">{query.trim() ? "无匹配文件，右键可新建" : "暂无文件，右键可新建"}</div>
        )}
      </div>

      {menu && (
        <PopupContextMenu x={menu.x} y={menu.y} onClose={closeMenu}>
          {menu.kind === "file" && (
            <button
              type="button"
              className="task-context-item"
              onClick={() => {
                closeMenu();
                selectFile(menu.path, menu.name);
              }}
            >
              打开
            </button>
          )}
          {menu.kind === "file" && /\.html?$/i.test(menu.name) && (
            <button
              type="button"
              className="task-context-item"
              onClick={() => {
                closeMenu();
                openHtmlInBrowser(menu.path);
              }}
            >
              <IconGlobe size={14} /> 在扩展浏览器打开
            </button>
          )}
          {menu.kind === "folder" && (
            <button
              type="button"
              className="task-context-item"
              onClick={() => {
                closeMenu();
                if (spaceId) {
                  openWithSystem(menu.path);
                  return;
                }
                void openWorkspaceFolder(menu.path);
              }}
            >
              <IconOpenExternal size={14} /> 打开文件夹
            </button>
          )}
          {menu.kind !== "root" && (
            <>
              <button
                type="button"
                className="task-context-item"
                onClick={() => {
                  closeMenu();
                  reveal(menu.path);
                }}
              >
                <IconFolder size={14} /> 在资源管理器中显示
              </button>
              <button
                type="button"
                className="task-context-item"
                onClick={() => {
                  closeMenu();
                  copyPath(menu.path);
                }}
              >
                <IconCopy size={14} /> 复制路径
              </button>
              <button
                type="button"
                className="task-context-item"
                onClick={() => startRename(menu.path, menu.name)}
              >
                <IconPencil size={14} /> 重命名
              </button>
              <div className="task-context-sep" />
            </>
          )}
          {(menu.kind === "folder" || menu.kind === "root") && (
            <>
              <button
                type="button"
                className="task-context-item"
                onClick={() => void createEntry(menu.path, "file")}
              >
                <IconPlus size={14} /> 新建文件
              </button>
              <button
                type="button"
                className="task-context-item"
                onClick={() => void createEntry(menu.path, "folder")}
              >
                <IconPlus size={14} /> 新建文件夹
              </button>
            </>
          )}
          {menu.kind !== "root" && (
            <>
              <div className="task-context-sep" />
              <button
                type="button"
                className="task-context-item danger"
                onClick={() => {
                  closeMenu();
                  setPendingDelete({ path: menu.path, name: menu.name, kind: menu.kind });
                }}
              >
                <IconTrash size={14} /> 删除
              </button>
            </>
          )}
        </PopupContextMenu>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={pendingDelete?.kind === "folder" ? "删除文件夹" : "删除文件"}
        danger
        confirmLabel="删除"
        body={
          pendingDelete?.kind === "folder"
            ? `确定删除「${pendingDelete.name}」及其全部内容？文件将移入回收站。`
            : `确定删除「${pendingDelete?.name ?? ""}」？文件将移入回收站。`
        }
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
