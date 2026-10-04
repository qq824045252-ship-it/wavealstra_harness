import { useMemo, useState } from "react";
import { IconFolderKanban, IconSearch } from "@/components/common/icons";
import { filterProjectTasks, formatRelativeTime, type ProjectTaskStatusFilter } from "@/lib/projectWorkspace";
import { getWorkspaceDisplayPath } from "@/lib/workspaceDisplay";
import type { Space, Task, TaskStatus } from "@/types";

const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  in_progress: "进行中",
  completed: "已完成",
  failed: "失败",
  pending: "待开始",
  planning: "规划中",
};

interface Props {
  projectId: string;
  archived: boolean;
  tasks: Task[];
  spaces: Space[];
  onNewTask: () => void;
  onOpenTask: (taskId: string) => void;
}

const STATUS_FILTERS: Array<{ id: ProjectTaskStatusFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "active", label: "进行中" },
  { id: "done", label: "已完成" },
];

export default function ProjectTasks({
  projectId,
  archived,
  tasks,
  spaces,
  onNewTask,
  onOpenTask,
}: Props): React.JSX.Element {
  const [status, setStatus] = useState<ProjectTaskStatusFilter>("all");
  const [query, setQuery] = useState("");
  const visible = useMemo(
    () => filterProjectTasks(tasks, projectId, { status, query }),
    [tasks, projectId, status, query],
  );

  return (
    <div className="project-desk-pane">
      <div className="project-desk-toolbar">
        <div className="project-seg" role="group" aria-label="任务状态筛选">
          {STATUS_FILTERS.map((filter) => (
            <button
              key={filter.id}
              type="button"
              className={status === filter.id ? "active" : ""}
              aria-pressed={status === filter.id}
              onClick={() => setStatus(filter.id)}
            >
              {filter.id === "all" ? "全部任务" : filter.label}
            </button>
          ))}
        </div>
        <label className="project-plan-search">
          <IconSearch size={14} />
          <input
            value={query}
            placeholder="搜索任务"
            aria-label="搜索任务"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <span className="input-spacer" />
        <button type="button" className="btn primary" disabled={archived} onClick={onNewTask}>新建任务</button>
      </div>
      <div className="project-task-rows">
        {visible.length === 0 ? (
          <div className="project-empty-state">
            {tasks.some((task) => task.projectId === projectId && !task.archived)
              ? "没有匹配的任务"
              : <><strong>还没有项目任务</strong><span>点「新建任务」或在下方输入框直接说事，任务会自动带上本项目的说明、记忆和资料。</span></>}
          </div>
        ) : (
          visible.map((task) => {
            const workspaceLabel = getWorkspaceDisplayPath(spaces as any, task.spaceId ?? null);
            const directoryLabel = !task.spaceId ? "独立目录" : workspaceLabel === "工作空间不可用" ? "目录不可用" : workspaceLabel;
            return (
              <button type="button" className="project-task-line" key={task.id} onClick={() => onOpenTask(task.id)}>
                <span className={`project-task-dot status-${task.status ?? "pending"}`} title={TASK_STATUS_LABEL[task.status ?? "pending"]} />
                <span className="project-task-mark" title="项目任务">
                  <IconFolderKanban size={13} />
                </span>
                <span className="project-task-name-text">{task.title}</span>
                <span className="project-local-badge" title={`任务工作目录：${directoryLabel}`}>
                  {directoryLabel}
                </span>
                <span className="input-spacer" />
                <span className="project-task-time">{formatRelativeTime(task.updatedAt)}</span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
