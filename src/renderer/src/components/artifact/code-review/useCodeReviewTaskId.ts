import { useAppStore } from "@/store/appStore";

export function useCodeReviewTaskId(): string | null {
  return useAppStore(({ activeTaskId, activeWorkspaceId, page, tasks }) => {
    if (!activeTaskId) return null;
    if (page === "chat") return activeTaskId;
    if (page !== "workspace" || !activeWorkspaceId) return null;
    const task = tasks.find(item => item.id === activeTaskId);
    return task?.spaceId === activeWorkspaceId ? activeTaskId : null;
  });
}
