import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Artifact } from "@/types";
import { sizeLabel, useAppStore } from "@/store/appStore";
import { openArtifactInSystem } from "@/lib/artifactActions";
import { canNativeDrag, startNativeFileDrag } from "@/lib/nativeFileDrag";
import {
  IconChevronDown,
  IconChevronUp,
  IconFileArchive,
  IconFileBox,
  IconFileCode,
  IconFileGeneric,
  IconFileJson,
  IconFileSpreadsheet,
  IconFileText,
  IconImage,
  IconOpenExternal,
  IconPresentation,
} from "./icons";

/** 消息内产物芯片默认折叠行数；超出部分按需展开 */
const ARTIFACT_CHIP_COLLAPSE_ROWS = 1;

/** 文件名拆成 stem + 扩展名，芯片里扩展名始终可见，避免哈希截断后全部长得一样 */
export function splitFileLabel(name: string): { stem: string; ext: string } {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? name;
  const lastDot = base.lastIndexOf(".");
  if (lastDot <= 0 || lastDot >= base.length - 1) return { stem: base, ext: "" };
  const ext = base.slice(lastDot);
  if (ext.length > 8) return { stem: base, ext: "" };
  return { stem: base.slice(0, lastDot), ext };
}

/**
 * 按 flex-wrap 实际行布局测量：两行折叠高度 + 隐藏数量。
 * 要求容器 `position: relative`，子芯片为直接子节点。
 */
function measureChipCollapse(
  container: HTMLElement,
  maxRows: number,
): { collapsedHeight: number; hiddenCount: number } {
  const chips = Array.from(
    container.querySelectorAll<HTMLElement>(":scope > .artifact-chip"),
  );
  if (chips.length === 0) {
    return { collapsedHeight: 0, hiddenCount: 0 };
  }

  type Row = { top: number; bottom: number };
  const rows: Row[] = [];
  for (const chip of chips) {
    const top = chip.offsetTop;
    const bottom = top + chip.offsetHeight;
    const existing = rows.find((r) => Math.abs(r.top - top) < 2);
    if (existing) {
      existing.bottom = Math.max(existing.bottom, bottom);
    } else {
      rows.push({ top, bottom });
    }
  }
  rows.sort((a, b) => a.top - b.top);

  if (rows.length <= maxRows) {
    return {
      collapsedHeight: rows[rows.length - 1]?.bottom ?? 0,
      hiddenCount: 0,
    };
  }

  const lastVisible = rows[maxRows - 1];
  const hiddenCount = chips.filter((c) => c.offsetTop > lastVisible.top + 2).length;
  return {
    collapsedHeight: lastVisible.bottom,
    hiddenCount,
  };
}

interface FileTypeStyle {
  IconComponent: React.ComponentType<{ size?: number; className?: string }>;
  color: string;
  bg: string;
}

export function fileBadgeExt(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "";
  if (/\.args\.json$/i.test(base)) return "json";
  const ext = base.split(".").pop()?.toLowerCase() ?? "";
  return ext;
}

function fileType(name: string): FileTypeStyle {
  const ext = fileBadgeExt(name);
  switch (ext) {
    case "md":
    case "txt":
      return { IconComponent: IconFileText, color: "#2563eb", bg: "rgba(37, 99, 235, 0.12)" };
    case "xlsx":
    case "xls":
    case "csv":
      return { IconComponent: IconFileSpreadsheet, color: "#16a34a", bg: "rgba(22, 163, 74, 0.12)" };
    case "docx":
    case "doc":
      return { IconComponent: IconFileText, color: "#1d4ed8", bg: "rgba(29, 78, 216, 0.12)" };
    case "pptx":
    case "ppt":
      return { IconComponent: IconPresentation, color: "#ea580c", bg: "rgba(234, 88, 12, 0.12)" };
    case "pdf":
      return { IconComponent: IconFileText, color: "#dc2626", bg: "rgba(220, 38, 38, 0.12)" };
    case "xml":
    case "html":
    case "py":
    case "js":
    case "ts":
    case "tsx":
    case "jsx":
      return { IconComponent: IconFileCode, color: "#ca8a04", bg: "rgba(202, 138, 4, 0.12)" };
    case "json":
      return { IconComponent: IconFileJson, color: "#ea580c", bg: "rgba(234, 88, 12, 0.12)" };
    case "png":
    case "jpg":
    case "jpeg":
    case "webp":
    case "svg":
    case "gif":
      return { IconComponent: IconImage, color: "#0284c7", bg: "rgba(2, 132, 199, 0.12)" };
    case "zip":
    case "rar":
    case "7z":
    case "tar":
    case "gz":
      return { IconComponent: IconFileArchive, color: "#9333ea", bg: "rgba(147, 51, 234, 0.12)" };
    case "fcstd":
    case "step":
    case "stp":
    case "stl":
    case "glb":
    case "gltf":
    case "iges":
    case "igs":
    case "brep":
    case "blend":
    case "blend1":
    case "obj":
      return { IconComponent: IconFileBox, color: "#0d9488", bg: "rgba(13, 148, 136, 0.12)" };
    default:
      return { IconComponent: IconFileGeneric, color: "#64748b", bg: "rgba(100, 116, 139, 0.12)" };
  }
}

export function FileBadge({
  name,
  size = 20,
  muted = false,
}: {
  name: string;
  size?: number;
  muted?: boolean;
}): React.JSX.Element {
  const t = fileType(name);
  const IconComp = t.IconComponent;
  return (
    <span
      className={`file-badge ${muted ? "muted" : ""}`}
      draggable={false}
      onDragStart={(e) => e.preventDefault()}
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(4, size * 0.2),
        background: muted ? undefined : t.bg,
        color: muted ? "var(--fg-muted)" : t.color,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <IconComp size={Math.round(size * 0.7)} />
    </span>
  );
}

/** 消息内的产物文件卡片：紧凑单行；预览 + 系统默认应用打开 + 拖出到系统 */
/** 对话表格/行内绝对路径：拖出磁盘文件 + 点击打开 */
export function LocalFileChip({ path }: { path: string }): React.JSX.Element {
  const openArtifact = useAppStore((s) => s.openArtifact);
  const openLocalAbsoluteFile = useAppStore((s) => s.openLocalAbsoluteFile);
  const artifacts = useAppStore((s) => s.artifactProjection.artifactsByTask[s.activeTaskId ?? ""] ?? []);
  const name = path.replace(/[\\/]+$/, "").split(/[/\\]/).pop() || path;
  const norm = path.replace(/\\/g, "/").toLowerCase();
  const match = artifacts.find((d) => {
    if (d.source.type === "workspace-file") {
      return d.source.entryFile.replace(/\\/g, "/").toLowerCase() === norm;
    }
    return typeof d.capabilities?.diskPath === "string" && d.capabilities.diskPath.replace(/\\/g, "/").toLowerCase() === norm;
  });
  const dragPath = match?.source.type === "workspace-file" ? match.source.entryFile : path;
  const dragEnabled = canNativeDrag(dragPath);

  return (
    <span
      className={`md-file-link local-file-chip${dragEnabled ? " is-draggable" : ""}`}
      draggable={dragEnabled}
      title={dragEnabled ? `${dragPath}\n可拖到桌面或其它应用` : path}
      onDragStart={(e) => {
        if (!startNativeFileDrag(e, dragPath)) e.preventDefault();
      }}
      onClick={() => {
        if (match) openArtifact(match.id);
        else void openLocalAbsoluteFile(path);
      }}
    >
      <FileBadge name={name} size={14} />
      <span>{path}</span>
    </span>
  );
}

export function ArtifactChip({ artifact }: { artifact: Artifact }): React.JSX.Element {
  const openArtifact = useAppStore((s) => s.openArtifact);
  const hasPath = Boolean(artifact.path?.trim());
  const dragEnabled = canNativeDrag(artifact.path);
  const size = sizeLabel(artifact.content);

  const handleSystemOpen = (e: React.MouseEvent): void => {
    e.stopPropagation();
    e.preventDefault();
    if (!hasPath) return;
    void openArtifactInSystem(artifact);
  };

  const handleDragStart = (e: React.DragEvent): void => {
    if (!startNativeFileDrag(e, artifact.path)) {
      e.preventDefault();
    }
  };

  const { stem, ext } = splitFileLabel(artifact.name);
  const sizeHint = size !== "—" ? ` · ${size}` : "";

  return (
    <div
      className={`artifact-chip${dragEnabled ? " is-draggable" : ""}`}
      title={
        dragEnabled
          ? `${artifact.path}${sizeHint}\n可拖到桌面或其它应用`
          : `${artifact.path || artifact.name}${sizeHint}`
      }
      draggable={dragEnabled}
      onDragStart={handleDragStart}
    >
      <button
        type="button"
        className="artifact-chip-main"
        onClick={() => openArtifact(artifact.id)}
        title={`在产物面板打开：${artifact.name}${sizeHint}`}
      >
        <FileBadge name={artifact.name} size={16} />
        <span className="artifact-chip-meta">
          <span className="artifact-chip-name">
            <span className="artifact-chip-stem">{stem}</span>
            {ext ? <span className="artifact-chip-ext">{ext}</span> : null}
          </span>
        </span>
      </button>
      <button
        type="button"
        className="artifact-chip-system"
        onClick={handleSystemOpen}
        disabled={!hasPath}
        title={
          hasPath
            ? `用系统默认应用打开\n${artifact.path}`
            : "无磁盘路径，无法用系统应用打开"
        }
        aria-label="用系统默认应用打开"
        // 系统打开按钮不参与拖出，避免误拖
        draggable={false}
        onDragStart={(e) => e.preventDefault()}
      >
        <IconOpenExternal size={13} />
      </button>
    </div>
  );
}

export function ArtifactChipRow({
  ids,
  allArtifacts,
}: {
  ids: string[];
  allArtifacts: Artifact[];
}): React.JSX.Element | null {
  const artifacts = useMemo(
    () =>
      ids
        .map((id) => allArtifacts.find((artifact) => artifact.id === id))
        .filter((a): a is Artifact => Boolean(a)),
    [ids, allArtifacts],
  );

  const chipsRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [hiddenCount, setHiddenCount] = useState(0);
  const [collapsedHeight, setCollapsedHeight] = useState<number | null>(null);

  // 产物列表变化时默认重新折叠（避免换消息后仍保持展开）
  const artifactKey = artifacts.map((a) => a.id).join("\0");
  useLayoutEffect(() => {
    setExpanded(false);
  }, [artifactKey]);

  useLayoutEffect(() => {
    const el = chipsRef.current;
    if (!el) return;

    const update = (): void => {
      // overflow:hidden 只裁切绘制，不改变子项布局；offsetTop 可直接用来分行
      const { collapsedHeight: h, hiddenCount: n } = measureChipCollapse(
        el,
        ARTIFACT_CHIP_COLLAPSE_ROWS,
      );
      setCollapsedHeight((prev) => (prev === h ? prev : h));
      setHiddenCount((prev) => (prev === n ? prev : n));
    };

    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [artifactKey]);

  if (artifacts.length === 0) return null;

  const canCollapse = hiddenCount > 0;
  const isCollapsed = canCollapse && !expanded;

  return (
    <div className="artifact-chips-wrap">
      <div
        ref={chipsRef}
        className={`artifact-chips${isCollapsed ? " is-collapsed" : ""}`}
        style={
          isCollapsed && collapsedHeight != null
            ? { maxHeight: collapsedHeight }
            : undefined
        }
      >
        {artifacts.map((a) => (
          <ArtifactChip key={a.id} artifact={a} />
        ))}
      </div>
      {canCollapse && (
        <button
          type="button"
          className="artifact-chips-toggle"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? (
            <>
              <IconChevronUp size={13} />
              收起
            </>
          ) : (
            <>
              <IconChevronDown size={13} />
              展开剩余 {hiddenCount} 个
            </>
          )}
        </button>
      )}
    </div>
  );
}
