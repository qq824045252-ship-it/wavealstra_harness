import { DOTS_TASK_ID } from "@shared/dots";
import { mapTaskRowToTask } from "@/store/app/tasks/taskMapper";
import { useAppStore } from "@/store/appStore";
import type { NotificationMessageFocus } from "@/store/app/slices/appUi";

export function recordBoardVisit(id: string): void {
  void window.api?.db
    ?.taskBoardAction?.(id, "visit")
    .catch((error) => console.warn("[TaskBoard] 访问记录未保存", error));
}

/** Explicit user navigation only. Session restoration and recommended impressions do not count. */
export function openVisitedTask(id: string, focus?: NotificationMessageFocus): void {
  recordBoardVisit(id);
  useAppStore.getState().setActiveTask(id, focus);
}

export async function openDotsTask(taskId: string): Promise<void> {
  if (taskId === DOTS_TASK_ID || useAppStore.getState().activeTaskId !== DOTS_TASK_ID) return;
  await openDotsActivityTarget(taskId);
}

export async function openDotsActivityTarget(taskId: string, focus?: NotificationMessageFocus, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  const before = useAppStore.getState();
  if (taskId === DOTS_TASK_ID) {
    if (focus && before.page === "chat" && before.activeTaskId === DOTS_TASK_ID) {
      useAppStore.setState({ notificationMessageTarget: { ...focus, taskId }, chatLatestTarget: undefined });
    } else {
      await before.openDots({ focus, signal });
    }
    return;
  }
  if (!before.tasks.some(task => task.id === taskId)) {
    const row = (await window.api?.db.listTasks())?.find(task => task.id === taskId && !task.archived);
    const state = useAppStore.getState();
    if (signal?.aborted || state.page !== before.page || state.activeTaskId !== before.activeTaskId || state.draft !== before.draft) return;
    if (!row) throw new Error("找不到来源任务");
    if (!state.tasks.some(task => task.id === taskId)) {
      const task = mapTaskRowToTask(row, {
        enabledModelIds: new Set(state.models.filter(model => model.enabled !== false).map(model => model.id)),
        defaultModelId: state.defaultModelId, permissionModeDefault: state.permissionMode,
      });
      useAppStore.setState({ tasks: [...state.tasks, task] });
    }
  }
  openVisitedTask(taskId, focus);
}
