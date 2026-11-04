import type { TrashedTaskDto } from "../../../../../shared/archive-deletion";
import type { Task, TaskFilterStatus, TaskFilterTime } from "../../../types";
import type { AppActions } from "../actions";
import type { AppContext } from "../context";
import type { PendingRegeneration } from "../types";

export interface TasksState {
  tasks: Task[];
  trashedTasks: TrashedTaskDto[];
  pendingRegenerations: Record<string, PendingRegeneration>;
  taskFilterStatus: TaskFilterStatus;
  taskFilterTime: TaskFilterTime;
  pinnedTaskIds: string[];
  compactionByTask: Record<
    string,
    import("../../../../../shared/compaction").TaskCompactionStatusDto
  >;
}

export function createTasksState(): TasksState {
  return {
    tasks: [],
    trashedTasks: [],
    pendingRegenerations: {},
    taskFilterStatus: "all",
    taskFilterTime: "all",
    pinnedTaskIds: [],
    compactionByTask: {},
  };
}

export function createTasksActions(
  storeContext: AppContext,
): Pick<
  AppActions,
  "setTaskFilterStatus" | "setTaskFilterTime" | "resetTaskFilters"
> {
  const { get, set } = storeContext;
  return {
    setTaskFilterStatus: (s) => set({ taskFilterStatus: s }),

    setTaskFilterTime: (t) => set({ taskFilterTime: t }),

    resetTaskFilters: () =>
      set({ taskFilterStatus: "all", taskFilterTime: "all" }),
  };
}
