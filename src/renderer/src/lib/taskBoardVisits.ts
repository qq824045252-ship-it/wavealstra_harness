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
