import { useEffect, useMemo, useState } from "react";
import type { Artifact, Task } from "@/types";
import { relativeTime, sizeLabel, useAppStore } from "@/store/appStore";
import type { WelcomeMode } from "../../../../shared/agent-ipc";
import { artifactVisibleForDisplay } from "../../../../shared/mode-profile";
import { toRendererArtifact } from "@/lib/artifactIngest";
import { FileBadge } from "@/components/common/FileBadge";
import {
  IconChevronDown,
  IconChevronRight,
  IconFilter,
  IconFolder,
  IconSearch,
} from "@/components/common/icons";

const KIND_LABEL: Record<string, string> = {
  markdown: "文档",
  table: "表格",
  code: "文档",
  html: "网页",
  image: "图片",
};

const EMPTY_ARTIFACTS: Artifact[] = [];

/** 3E：按 task 生成产物渲染视图（projection 优先，保留渲染缓存内容；否则空等 Domain 快照） */
function toTaskArtifactsView(
  st: ReturnType<typeof useAppStore.getState>,
  taskId: string,
): Artifact[] {
  const descriptors = st.artifactProjection.artifactsByTask[taskId];
  if (!descriptors || descriptors.length === 0) return EMPTY_ARTIFACTS;
  return descriptors.map((d) => toRendererArtifact(d, st.artifactRenderCache[d.id]));
}

interface Group {
  id: string;
  name: string;
  tasks: Task[];
}

export default function FilesPage(): React.JSX.Element {
  const tasks = useAppStore((s) => s.tasks);
  const spaces = useAppStore((s) => s.spaces);
  const openArtifactInTask = useAppStore((s) => s.setActiveTask);
  // V3.6：按任务模式的产物黑白名单过滤显示（仅显示层；文件照常落地、变更显示不受影响）
  const artifactPolicies = useAppStore((s) => s.artifactPolicies);
  const refreshArtifactPolicy = useAppStore((s) => s.refreshArtifactPolicy);
  const [tab, setTab] = useState<"artifacts" | "cloud">("artifacts");
  const [query, setQuery] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([]);
  /** 3E：跨任务产物缓存（taskId → 渲染视图）；唯一来源 = Artifact Domain（snapshot 触发一次性 legacy migration） */
  const [taskArtifacts, setTaskArtifacts] = useState<Record<string, Artifact[]>>({});

  // 挂载时：已有 projection 的任务直接派生（内容缓存保留）；未 hydration 的任务从 Domain 拉快照。
  // 依赖 = 任务 id 列表（新增/删除任务才重拉；流式正文更新不打扰本页）。
  const taskIdKey = tasks.map((t) => t.id).join(",");
  useEffect(() => {
    const api = window.api?.artifactDomain;
    const st = useAppStore.getState();
    const initial: Record<string, Artifact[]> = {};
    for (const t of st.tasks) {
      const view = toTaskArtifactsView(st, t.id);
      if (view.length > 0) initial[t.id] = view;
    }
    setTaskArtifacts((prev) => {
      // 已缓存（快照拉取过）的任务不覆盖，避免重复 IPC
      const merged = { ...initial };
      for (const t of st.tasks) {
        if (prev[t.id] && !merged[t.id]) merged[t.id] = prev[t.id];
      }
      return merged;
    });
    const missing = st.tasks.filter(
      (t) => !initial[t.id] && !st.artifactProjection.artifactsByTask[t.id],
    );
    if (!api || missing.length === 0) return;
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        missing.map(async (t) => {
          try {
            const snap = await api.snapshot?.({ taskId: t.id });
            return [t.id, (snap?.artifacts ?? []).map((d) => toRendererArtifact(d))] as const;
          } catch (err) {
            console.warn("[FilesPage] artifact snapshot failed", t.id, err);
            return [t.id, EMPTY_ARTIFACTS] as const;
          }
        }),
      );
      if (cancelled) return;
      setTaskArtifacts((prev) => {
        const next = { ...prev };
        for (const [id, arts] of entries) next[id] = arts;
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [taskIdKey]);

  // 挂载时补拉各任务模式的产物显示策略（失败静默 = 不过滤，显示全部）
  useEffect(() => {
    const modes = [
      ...new Set(tasks.map((t) => t.welcomeMode).filter((m): m is WelcomeMode => Boolean(m))),
    ];
    for (const mode of modes) void refreshArtifactPolicy(mode);
  }, [taskIdKey, refreshArtifactPolicy]);

  const groups = useMemo<Group[]>(() => {
    const withArtifacts = tasks.filter((t) => (taskArtifacts[t.id]?.length ?? 0) > 0);
    const ungrouped = withArtifacts.filter((t) => !t.spaceId);
    const result: Group[] = [];
    if (ungrouped.length > 0) result.push({ id: "none", name: "未分组", tasks: ungrouped });
    for (const space of spaces) {
      const items = withArtifacts.filter((t) => t.spaceId === space.id);
      if (items.length > 0) result.push({ id: space.id, name: space.name, tasks: items });
    }
    return result;
  }, [tasks, spaces, taskArtifacts]);

  const toggleGroup = (id: string): void => {
    setCollapsedGroups((list) =>
      list.includes(id) ? list.filter((x) => x !== id) : [...list, id],
    );
  };

  const matches = (name: string): boolean =>
    !query.trim() || name.toLowerCase().includes(query.trim().toLowerCase());

  return (
    <div className="page-scroll">
      <div className="page-container">
        <div className="page-title">我的文件</div>
        <div className="page-sub">快速查看任务成果，上传到云端网盘开启跨端同步。</div>

        <div className="files-tabs">
          <button
            className={`files-tab ${tab === "artifacts" ? "active" : ""}`}
            onClick={() => setTab("artifacts")}
          >
            <IconFolder size={14} /> 任务成果
          </button>
          <button
            className={`files-tab ${tab === "cloud" ? "active" : ""}`}
            onClick={() => setTab("cloud")}
          >
            <IconFolder size={14} /> 云端网盘
          </button>
        </div>

        {tab === "cloud" ? (
          <div className="files-empty">云端网盘尚未开通，开通后任务成果可跨端同步。</div>
        ) : (
          <>
            <div className="files-toolbar">
              <button className="pill">
                <IconFilter size={13} /> 全部类型 <IconChevronDown size={12} />
              </button>
              <div className="files-search">
                <IconSearch size={14} />
                <input
                  placeholder="搜索文件、任务或工作空间"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <label className="files-fav">
                <input type="checkbox" /> 我的收藏
              </label>
            </div>

            <div className="files-table">
              <div className="files-head">
                <span>名称</span>
                <span>类型</span>
                <span>更新人</span>
                <span>更新时间</span>
                <span>大小</span>
              </div>

              {groups.map((group) => {
                const collapsed = collapsedGroups.includes(group.id);
                return (
                  <div key={group.id}>
                    <button className="files-group-row" onClick={() => toggleGroup(group.id)}>
                      {collapsed ? <IconChevronRight size={13} /> : <IconChevronDown size={13} />}
                      <span className="files-group-name">{group.name}</span>
                      <span className="files-group-count">{group.tasks.length}个任务</span>
                    </button>
                    {!collapsed &&
                      group.tasks.map((task) => (
                        <div key={task.id}>
                          <div className="files-task-row">
                            <span className="files-task-icon">
                              <IconFolder size={14} />
                            </span>
                            <span className="files-task-name">{task.title}</span>
                          </div>
                          {taskArtifacts[task.id]?.filter(
                            (a) =>
                              matches(a.name) &&
                              artifactVisibleForDisplay(
                                a.path ?? a.name,
                                task.welcomeMode ? artifactPolicies[task.welcomeMode] : undefined,
                                (taskArtifacts[task.id] ?? []).map((item) => item.path ?? item.name),
                              ),
                          ).map((a) => (
                            <button
                              key={a.id}
                              className="files-file-row"
                              onClick={() => {
                                openArtifactInTask(task.id);
                                useAppStore.getState().openArtifact(a.id);
                              }}
                            >
                              <span className="files-file-name">
                                <FileBadge name={a.name} size={18} />
                                <span className="files-file-label">{a.name}</span>
                              </span>
                              <span className="files-cell">{KIND_LABEL[a.kind] ?? "文档"}</span>
                              <span className="files-cell">CORREFLOW罗彬</span>
                              <span className="files-cell">{relativeTime(task.updatedAt)}</span>
                              <span className="files-cell">{sizeLabel(a.content)}</span>
                            </button>
                          ))}
                        </div>
                      ))}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
