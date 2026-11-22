import { DOTS_TASK_ID } from "@shared/dots";
import { mapTaskRowToTask } from "@/store/app/tasks/taskMapper";
import { useAppStore } from "@/store/appStore";

export function recordBoardVisit(id: string): void {
  void window.api?.db
    ?.taskBoardAction?.(id, "visit")
    .catch((error) => console.warn("[TaskBoard] 访问记录未保存", error));
}

/** Explicit user navigation only. Session restoration and recommended impressions do not count. */
export function openVisitedTask(id: string): void {
  recordBoardVisit(id);
  useAppStore.getState().setActiveTask(id);
}

export async function openDotsTask(taskId: string): Promise<void> {
  if (taskId === DOTS_TASK_ID || useAppStore.getState().activeTaskId !== DOTS_TASK_ID) return;
  if (!useAppStore.getState().tasks.some(task => task.id === taskId)) {
    const row = (await window.api?.db.listTasks())?.find(task => task.id === taskId && !task.archived);
    const state = useAppStore.getState();
    if (state.activeTaskId !== DOTS_TASK_ID) return;
    if (!row) throw new Error("找不到来源任务");
    if (!state.tasks.some(task => task.id === taskId)) {
      const task = mapTaskRowToTask(row, {
        enabledModelIds: new Set(state.models.filter(model => model.enabled !== false).map(model => model.id)),
        defaultModelId: state.defaultModelId, permissionModeDefault: state.permissionMode,
      });
      useAppStore.setState({ tasks: [...state.tasks, task] });
    }
  }
  openVisitedTask(taskId);
}
