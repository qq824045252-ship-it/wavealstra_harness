import { useRef, useState } from "react";
import { FileBadge } from "@/components/common/FileBadge";
import ConfirmDialog from "@/components/common/ConfirmDialog";
import PopupContextMenu from "@/components/common/PopupContextMenu";
import {
  IconChevronDown,
  IconCopy,
  IconFolder,
  IconOpenExternal,
  IconTrash,
} from "@/components/common/icons";
import { canNativeDrag, resolveArtifactDragPath, startNativeFileDrag } from "@/lib/nativeFileDrag";
import {
  artifactToRefFile,
  openArtifactInSystem,
  revealArtifactInFolder,
} from "@/lib/artifactActions";
import { useAppStore } from "@/store/appStore";
import type { Artifact } from "@/types";

interface Props {
  artifacts: Artifact[];
  activeArtifactId?: string | null;
  onSelect: (artifact: Artifact) => void;
  limit?: number;
  /** 悬浮卡片 / 浏览器侧栏：与概览同一列层级 */
  variant?: "default" | "panel";
  /** 独立面板模式，无需手风琴折叠展开，直接展示列表 */
  standalone?: boolean;
}

/** CAD artifact 徽标：validation 状态 / 3D 预览 / 模型归属（capabilities 驱动，只读展示） */
function CadBadges({ artifact }: { artifact: Artifact }): React.JSX.Element | null {
  const caps = artifact.capabilities;
  if (!caps || caps.cad !== true) return null;
  const badges: string[] = [];
  if (typeof caps.modelId === "string" && caps.modelId !== "techdraw") {
    badges.push(caps.modelId.slice(0, 12));
  }
  if (badges.length === 0) return null;
  return (
    <span className="extension-artifact-badges">
      {badges.map((b) => (
        <span key={b} className={`extension-artifact-badge${b === "✗ 验证" ? " fail" : ""}`}>
          {b}
        </span>
      ))}
    </span>
  );
}

type ArtifactMenu = { x: number; y: number; artifact: Artifact };

/** 渲染单个 artifact 行（rail 复用；panel/default 共用徽标） */
function ArtifactRow({
  artifact,
  active,
  onSelect,
  onContext,
}: {
  artifact: Artifact;
  active: boolean;
  onSelect: (a: Artifact) => void;
  onContext: (e: React.MouseEvent, artifact: Artifact) => void;
}): React.JSX.Element {
  const entryPath = useAppStore((s) => {
    const taskId = s.activeTaskId;
    const d = taskId
      ? s.artifactProjection.artifactsByTask[taskId]?.find((x) => x.id === artifact.id)
      : undefined;
    if (d?.source.type === "workspace-file") return d.source.entryFile;
    if (typeof d?.capabilities?.diskPath === "string") return d.capabilities.diskPath;
    return "";
  });
  const dragPath = resolveArtifactDragPath(artifact) || entryPath;
  const dragEnabled = canNativeDrag(dragPath);
  const draggedRef = useRef(false);

  return (
    <div
      role="button"
      tabIndex={0}
      className={`extension-artifact-item ${active ? "active" : ""}${dragEnabled ? " is-draggable" : ""}`}
      onClick={() => {
        if (draggedRef.current) {
          draggedRef.current = false;
          return;
        }
        onSelect(artifact);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(artifact);
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContext(e, artifact);
      }}
      draggable={dragEnabled}
      onDragStart={(e) => {
        draggedRef.current = true;
        if (!startNativeFileDrag(e, dragPath)) e.preventDefault();
      }}
      onDragEnd={() => {
        window.setTimeout(() => {
          draggedRef.current = false;
        }, 0);
      }}
      title={
        dragEnabled
          ? `${dragPath}\n可拖到桌面或其它应用`
          : dragPath || artifact.path || artifact.name
      }
    >
      <FileBadge name={artifact.name} size={14} />
      <span className="extension-artifact-name">{artifact.name}</span>
      <CadBadges artifact={artifact} />
    </div>
  );
}

export default function ArtifactRail({
  artifacts,
  activeArtifactId,
  onSelect,
  limit = 8,
  variant = "default",
  standalone = false,
}: Props): React.JSX.Element {
  const [sectionOpen, setSectionOpen] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [menu, setMenu] = useState<ArtifactMenu | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Artifact | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const removeArtifact = useAppStore((s) => s.removeArtifact);
  const attachArtifactToChat = useAppStore((s) => s.attachArtifactToChat);

  const isPanel = variant === "panel";
  // 概览/悬浮面板列表可滚动：直接展示全部产物，不再折叠「展开更多」
  const visible = isPanel || expanded ? artifacts : artifacts.slice(0, limit);
  const hidden = Math.max(0, artifacts.length - limit);

  const flash = (text: string): void => {
    setNotice(text);
    window.setTimeout(() => setNotice((cur) => (cur === text ? null : cur)), 2000);
  };

  const closeMenu = (): void => setMenu(null);

  const confirmDelete = async (): Promise<void> => {
    const artifact = pendingDelete;
    setPendingDelete(null);
    if (!artifact) return;
    const ok = await removeArtifact(artifact.id);
    if (!ok) flash("删除失败");
  };

  const menuNode = menu ? (
    <PopupContextMenu x={menu.x} y={menu.y} onClose={closeMenu}>
      <button
        type="button"
        className="task-context-item"
        onClick={() => {
          closeMenu();
          onSelect(menu.artifact);
        }}
      >
        打开
      </button>
      <button
        type="button"
        className="task-context-item"
        disabled={!menu.artifact.path}
        onClick={() => {
          closeMenu();
          void openArtifactInSystem(menu.artifact);
        }}
      >
        <IconOpenExternal size={14} /> 用系统应用打开
      </button>
      <button
        type="button"
        className="task-context-item"
        disabled={!menu.artifact.path}
        onClick={() => {
          closeMenu();
          void revealArtifactInFolder(menu.artifact);
        }}
      >
        <IconFolder size={14} /> 在资源管理器中显示
      </button>
      <button
        type="button"
        className="task-context-item"
        disabled={!menu.artifact.path}
        onClick={() => {
          closeMenu();
          if (menu.artifact.path) {
            void navigator.clipboard.writeText(menu.artifact.path);
            flash("已复制路径");
          }
        }}
      >
        <IconCopy size={14} /> 复制路径
      </button>
      <button
        type="button"
        className="task-context-item"
        onClick={() => {
          closeMenu();
          attachArtifactToChat(artifactToRefFile(menu.artifact));
        }}
      >
        发送到对话
      </button>
      <div className="task-context-sep" />
      <button
        type="button"
        className="task-context-item danger"
        onClick={() => {
          closeMenu();
          setPendingDelete(menu.artifact);
        }}
      >
        <IconTrash size={14} /> 删除
      </button>
    </PopupContextMenu>
  ) : null;

  const confirmNode = (
    <ConfirmDialog
      open={pendingDelete !== null}
      title="删除产物"
      danger
      confirmLabel="删除"
      body={
        pendingDelete?.path
          ? `确定删除「${pendingDelete.name}」？磁盘文件将移入回收站。`
          : `确定从产物列表移除「${pendingDelete?.name ?? ""}」？`
      }
      onCancel={() => setPendingDelete(null)}
      onConfirm={() => void confirmDelete()}
    />
  );

  const rows = visible.map((a) => (
    <ArtifactRow
      key={a.id}
      artifact={a}
      active={activeArtifactId === a.id}
      onSelect={onSelect}
      onContext={(e, artifact) => setMenu({ x: e.clientX, y: e.clientY, artifact })}
    />
  ));

  if (standalone) {
    return (
      <div className="extension-panel-artifacts extension-artifacts-standalone">
        {notice && <div className="ws-tree-notice">{notice}</div>}
        <div className="extension-panel-item-list">
          {rows.length > 0 ? rows : <div className="artifact-overview-empty">这次还没有产物</div>}
        </div>
        {menuNode}
        {confirmNode}
      </div>
    );
  }

  if (isPanel) {
    return (
      <div className="extension-panel-artifacts">
        <button
          type="button"
          className="extension-panel-header-btn"
          onClick={() => setSectionOpen(!sectionOpen)}
        >
          产物
          <IconChevronDown size={13} className={sectionOpen ? "" : "chevron-up"} />
        </button>
        {notice && <div className="ws-tree-notice">{notice}</div>}
        {sectionOpen && (
          <div className="extension-panel-item-list">
            {rows.length > 0 ? rows : <div className="artifact-overview-empty">这次还没有产物</div>}
          </div>
        )}
        {menuNode}
        {confirmNode}
      </div>
    );
  }

  return (
    <div className="extension-artifact-section">
      <button
        type="button"
        className="extension-section-toggle"
        onClick={() => setSectionOpen(!sectionOpen)}
      >
        产物
        <IconChevronDown size={13} className={sectionOpen ? "" : "chevron-up"} />
      </button>
      {notice && <div className="ws-tree-notice">{notice}</div>}
      {sectionOpen && (
        <div className="extension-artifact-list">
          {rows}
          {!expanded && hidden > 0 && (
            <button type="button" className="extension-artifact-more" onClick={() => setExpanded(true)}>
              展开更多 ({hidden})
            </button>
          )}
        </div>
      )}
      {menuNode}
      {confirmNode}
    </div>
  );
}
