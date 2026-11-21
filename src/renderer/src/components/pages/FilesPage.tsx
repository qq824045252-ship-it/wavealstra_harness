import { openVisitedTask } from "@/lib/taskBoardVisits";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Artifact, Task } from "@/types";
import { relativeTime, sizeLabel, useAppStore } from "@/store/appStore";
import type { WelcomeMode } from "@shared/agent-ipc";
import type { ArtifactSnapshot } from "@shared/artifact-types";
import { artifactVisibleForDisplay } from "@shared/mode-profile";
import { toRendererArtifact } from "@/lib/artifactIngest";
import { inferArtifactKind } from "@/lib/workspace";
import { FileBadge, fileBadgeExt } from "@/components/common/FileBadge";
import { IconChevronDown, IconChevronRight, IconFolder, IconHardDrive, IconSearch } from "@/components/common/icons";
import { DesktopSectionRow, DesktopSectionSidebar, useDesktopSectionState, useDesktopShell } from "@/components/desktop/DesktopSection";
import "./desktop-secondary.css";

const KIND_LABEL = {
  markdown: "文档",
  table: "表格",
  code: "代码",
  html: "网页",
  image: "图片",
  svg: "图片",
  video: "视频",
  audio: "音频",
  pdf: "PDF",
  docx: "文档",
  xlsx: "表格",
  pptx: "演示文稿",
  drawio: "Draw.io 图纸",
  cad: "CAD",
} as const satisfies Record<Artifact["kind"], string>;

const CATEGORIES = ["全部", "文档", "表格", "演示文稿", "图片", "网页", "音视频", "代码", "压缩包", "Draw.io 图纸", "CAD"] as const;
type ResultCategory = (typeof CATEGORIES)[number];
type ResultType = (typeof KIND_LABEL)[Artifact["kind"]] | "压缩包";

const FILE_TYPES: Readonly<Partial<Record<string, ResultType>>> = {
  txt: "文档", log: "文档", doc: "文档",
  csv: "表格", tsv: "表格",
  ppt: "演示文稿",
  zip: "压缩包", rar: "压缩包", "7z": "压缩包", tar: "压缩包", gz: "压缩包", bz2: "压缩包", xz: "压缩包",
  fcstd: "CAD", step: "CAD", stp: "CAD", stl: "CAD", iges: "CAD", igs: "CAD", brep: "CAD", dwg: "CAD", dxf: "CAD",
};

function resultType(artifact: Artifact): ResultType {
  // Older registrations can use code or docx as a generic preview type.
  if (artifact.kind === "code" || artifact.kind === "docx") {
    const filename = artifact.path || artifact.name;
    if (/\.(?:zip|rar|7z)\.(?:part)?\d+$/i.test(filename)) return "压缩包";
    const extension = fileBadgeExt(filename);
    if (Object.hasOwn(FILE_TYPES, extension)) return FILE_TYPES[extension] ?? KIND_LABEL[artifact.kind];
    const inferred = inferArtifactKind(filename, "");
    if (inferred !== "code") return KIND_LABEL[inferred];
  }
  return KIND_LABEL[artifact.kind];
}

function resultCategory(type: ResultType): ResultCategory {
  if (type === "PDF") return "文档";
  if (type === "音频" || type === "视频") return "音视频";
  return type;
}

interface ArtifactTask {
  task: Task;
  artifacts: Artifact[];
}

interface Group {
  id: string;
  name: string;
  tasks: ArtifactTask[];
}

export default function FilesPage(): React.JSX.Element {
  const desktop = useDesktopShell();
  const tasks = useAppStore((s) => s.tasks);
  const spaces = useAppStore((s) => s.spaces);
  const artifactPolicies = useAppStore((s) => s.artifactPolicies);
  const refreshArtifactPolicy = useAppStore((s) => s.refreshArtifactPolicy);
  const descriptorsByTask = useAppStore((s) => s.artifactProjection.artifactsByTask);
  const renderCache = useAppStore((s) => s.artifactRenderCache);
  const [tab, setTab] = useDesktopSectionState<"artifacts" | "cloud">("results-tab", "artifacts");
  const [groupId, setGroupId] = useDesktopSectionState<string | null>("results-workspace", null);
  const [query, setQuery] = useDesktopSectionState("results-search", "");
  const [category, setCategory] = useDesktopSectionState<ResultCategory>("results-category", "全部");
  const [collapsedGroups, setCollapsedGroups] = useDesktopSectionState<string[]>("results-collapsed", []);
  const [snapshots, setSnapshots] = useState<Record<string, ArtifactSnapshot>>({});
  const [loading, setLoading] = useState(false);
  const resultsScroll = useRef<HTMLDivElement>(null);

  const taskIdKey = tasks.map((task) => task.id).join(",");
  useEffect(() => {
    const api = window.api?.artifactDomain;
    const state = useAppStore.getState();
    const missing = state.tasks.filter((task) => !state.artifactProjection.artifactsByTask[task.id]);
    if (!api || missing.length === 0) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void Promise.all(missing.map(async (task) => {
      try {
        return await api.snapshot({ taskId: task.id });
      } catch (error) {
        console.warn("[FilesPage] artifact snapshot failed", task.id, error);
        return null;
      }
    })).then((results) => {
      if (cancelled) return;
      setSnapshots((previous) => {
        const next = { ...previous };
        for (const snapshot of results) {
          if (snapshot) next[snapshot.taskId] = snapshot;
        }
        return next;
      });
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [taskIdKey]);

  const taskModeKey = [...new Set(tasks.map((task) => task.welcomeMode).filter(Boolean))].sort().join(",");
  useEffect(() => {
    for (const mode of taskModeKey.split(",")) {
      if (mode) void refreshArtifactPolicy(mode as WelcomeMode);
    }
  }, [taskModeKey, refreshArtifactPolicy]);

  const groups = useMemo(() => {
    const groupsById = new Map<string, Group>();
    for (const task of tasks) {
      const descriptors = descriptorsByTask[task.id] ?? snapshots[task.id]?.artifacts;
      if (!descriptors?.length) continue;
      const artifacts = descriptors.map((entry) => toRendererArtifact(entry, renderCache[entry.id]));
      const names = artifacts.map((item) => item.path ?? item.name);
      const policy = task.welcomeMode ? artifactPolicies[task.welcomeMode] : undefined;
      const visible = task.welcomeMode === "general"
        ? artifacts
        : artifacts.filter((artifact) => artifactVisibleForDisplay(artifact.path ?? artifact.name, policy, names));
      if (visible.length === 0) continue;
      const space = spaces.find((entry) => entry.id === task.spaceId);
      const id = space?.id ?? "none";
      const group = groupsById.get(id) ?? { id, name: space?.name ?? "独立任务", tasks: [] };
      group.tasks.push({ task, artifacts: visible });
      groupsById.set(id, group);
    }
    return [...groupsById.values()];
  }, [tasks, spaces, descriptorsByTask, renderCache, snapshots, artifactPolicies]);

  const activeGroup = groups.find((group) => group.id === groupId);
  const needle = query.trim().toLowerCase();
  const filtering = needle.length > 0 || category !== "全部";
  const visibleGroups = groups
    .filter((group) => !activeGroup || activeGroup.id === group.id)
    .map((group) => ({
      ...group,
      tasks: group.tasks.map(({ task, artifacts }) => ({
        task,
        artifacts: artifacts.filter((artifact) => {
          if (category !== "全部" && resultCategory(resultType(artifact)) !== category) return false;
          return !needle || [artifact.name, task.title, group.name].some((name) => name.toLowerCase().includes(needle));
        }),
      })).filter(({ artifacts }) => artifacts.length > 0),
    })).filter((group) => group.tasks.length > 0);

  const selectGroup = (id: string | null): void => {
    setGroupId(id);
    setTab("artifacts");
  };

  const toggleGroup = (id: string): void => {
    setCollapsedGroups((list) => list.includes(id) ? list.filter((item) => item !== id) : [...list, id]);
  };

  const openResult = (taskId: string, artifactId: string): void => {
    const state = useAppStore.getState();
    const snapshot = snapshots[taskId];
    if (!state.artifactProjection.artifactsByTask[taskId] && snapshot) {
      state.applyArtifactSnapshot(snapshot);
      state.reconcileTaskMessageArtifacts(taskId);
    }
    openVisitedTask(taskId);
    state.openArtifact(artifactId);
  };

  const tabs = (
    <>
      <DesktopSectionRow active={tab === "artifacts" && !activeGroup} icon={<IconFolder size={15} />} onClick={() => selectGroup(null)}>
        全部成果
      </DesktopSectionRow>
      <DesktopSectionRow active={tab === "cloud"} icon={<IconHardDrive size={15} />} onClick={() => setTab("cloud")}>
        云端网盘
      </DesktopSectionRow>
    </>
  );

  return (
    <div className="content-col desktop-results">
      {desktop && <DesktopSectionSidebar title="任务成果" scrollKey="results">
        {tabs}
        {groups.length > 0 && <div className="desktop-section-group">来源</div>}
        {groups.map((group) => (
          <DesktopSectionRow key={group.id} active={tab === "artifacts" && activeGroup?.id === group.id}
            icon={<IconFolder size={15} />} title={group.name} onClick={() => selectGroup(group.id)}>
            {group.name}
          </DesktopSectionRow>
        ))}
      </DesktopSectionSidebar>}
      <header className="desktop-secondary-heading">
        <h1>{tab === "cloud" ? "云端网盘" : activeGroup?.name ?? "任务成果"}</h1>
        {tab === "artifacts" && (
          <label className="desktop-secondary-search desktop-results-search">
            <IconSearch size={14} />
            <input placeholder="搜索文件、任务或工作空间" aria-label="搜索任务成果" value={query}
              onChange={(event) => setQuery(event.target.value)} />
          </label>
        )}
      </header>
      {!desktop && <div className="desktop-results-inline-tabs">{tabs}</div>}
      {tab === "artifacts" && (
        <div className="desktop-results-categories" role="group" aria-label="成果分类">
          {CATEGORIES.map((label) => (
            <button type="button" key={label} aria-pressed={category === label} onClick={() => {
              setCategory(label);
              resultsScroll.current?.scrollTo({ top: 0 });
            }}>
              {label}
            </button>
          ))}
        </div>
      )}
      <div className="page-scroll" ref={resultsScroll}>
        <div className="page-container desktop-results-container">
          {tab === "cloud" ? (
            <div className="desktop-secondary-empty">云端网盘尚未开通。</div>
          ) : visibleGroups.length === 0 ? (
            <div className="desktop-secondary-empty">
              {loading ? "正在读取任务成果…" : filtering ? "没有匹配的成果。" : "暂无任务成果。"}
            </div>
          ) : (
            <div className="files-table desktop-results-table">
              <div className="desktop-results-columns desktop-results-table-head" aria-hidden="true">
                <span>名称</span><span>类型</span><span>更新时间</span><span>大小</span>
              </div>
              {visibleGroups.map((group) => {
                const collapsed = !activeGroup && !filtering && collapsedGroups.includes(group.id);
                return (
                  <section key={group.id} aria-label={group.name}>
                    {!activeGroup && <button type="button" className="files-group-row" aria-expanded={!collapsed} disabled={filtering} onClick={() => toggleGroup(group.id)}>
                      {collapsed ? <IconChevronRight size={13} /> : <IconChevronDown size={13} />}
                      <span className="files-group-name">{group.name}</span>
                      <span className="files-group-count">{group.tasks.length} 个任务</span>
                    </button>}
                    {!collapsed && group.tasks.map(({ task, artifacts }) => (
                      <div key={task.id} className="desktop-results-task">
                        <button type="button" className="files-task-row desktop-results-task-link"
                          title="打开来源任务" onClick={() => openVisitedTask(task.id)}>
                          <IconFolder size={14} />
                          <span className="files-task-name">{task.title}</span>
                        </button>
                        {artifacts.map((artifact) => (
                          <button type="button" key={artifact.id} className="files-file-row desktop-results-columns"
                            title={artifact.name} onClick={() => openResult(task.id, artifact.id)}>
                            <span className="files-file-name">
                              <FileBadge name={artifact.name} size={18} />
                              <span className="files-file-label">{artifact.name}</span>
                            </span>
                            <span className="files-cell">{resultType(artifact)}</span>
                            <span className="files-cell">{relativeTime(task.updatedAt)}</span>
                            <span className="files-cell">{artifact.content ? sizeLabel(artifact.content) : "—"}</span>
                          </button>
                        ))}
                      </div>
                    ))}
                  </section>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
