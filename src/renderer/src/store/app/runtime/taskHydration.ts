import { normalizeSingleExpertId } from "../../../../../shared/expert-id";
import {
  DEFAULT_WELCOME_MODE,
  defaultModePresetId,
} from "../../../../../shared/mode-profile";
import type { Task } from "../../../types";
import type { AppContext } from "../context";
import { historyMessageToChatMessage } from "../messages/historyMapper";

export const EXTERNAL_HISTORY_HYDRATION_MS = 2000;

const alwaysActive = (): boolean => true;

export function hydrateExternalAgentHistory(
  storeContext: AppContext,
  taskId: string,
  isActive: () => boolean = alwaysActive,
): void {
  const { set, runtime } = storeContext;
  if (!isActive()) return;
  const now = Date.now();
  const previousRequest = runtime.externalHistoryHydrationRequests.get(taskId);
  // An inactive request cannot commit, so it must not throttle a replacement runtime.
  if (
    (!previousRequest || previousRequest.isActive()) &&
    now - (runtime.externalHistoryHydrations.get(taskId) ?? 0) <
      EXTERNAL_HISTORY_HYDRATION_MS
  )
    return;
  const request = { isActive };
  runtime.externalHistoryHydrations.set(taskId, now);
  runtime.externalHistoryHydrationRequests.set(taskId, request);
  void (async () => {
    try {
      const history = await storeContext
        .getApi()
        ?.agent?.loadTaskHistory?.(taskId);
      if (!isActive() || !history?.messages?.length) return;
      set((state) => ({
        tasks: state.tasks.map((task) => {
          if (task.id !== taskId) return task;
          const known = new Set(task.messages.map((message) => message.id));
          const missing = history.messages
            .filter((message) => !known.has(message.id))
            .map((message) => historyMessageToChatMessage(message));
          if (!missing.length) return task;
          return {
            ...task,
            messages: [...task.messages, ...missing].sort(
              (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
            ),
          };
        }),
      }));
    } catch {
      /* best effort：补历史失败不影响后续事件（下一次事件会再试） */
    } finally {
      // Identity matters: an old completion must not release its successor's request.
      if (runtime.externalHistoryHydrationRequests.get(taskId) === request) {
        runtime.externalHistoryHydrationRequests.delete(taskId);
        if (!isActive()) runtime.externalHistoryHydrations.delete(taskId);
      }
    }
  })();
}

export function hydrateTaskMetadataFromDb(
  storeContext: AppContext,
  taskId: string,
): void {
  const { get, set } = storeContext;
  if (storeContext.runtime.pendingTaskMetadataHydrations.has(taskId)) return;
  storeContext.runtime.pendingTaskMetadataHydrations.add(taskId);
  void (async () => {
    try {
      const rows = await storeContext.getApi()?.db?.listTasks?.();
      const row = rows?.find((candidate) => candidate.id === taskId);
      if (!row) return;
      if (
        row.spaceId &&
        !get().spaces.some((space) => space.id === row.spaceId)
      ) {
        void get().refreshSpaces();
      }
      set((state) => {
        const current = state.tasks.find((task) => task.id === taskId);
        if (!current) return state;
        const welcomeMode =
          row.welcomeMode ?? current.welcomeMode ?? DEFAULT_WELCOME_MODE;
        const selectedPresetId =
          row.modePresetId ?? defaultModePresetId(welcomeMode);
        const permissionMode =
          row.permissionMode ?? current.permissionMode ?? state.permissionMode;
        return {
          tasks: state.tasks.map((task) =>
            task.id === taskId
              ? {
                  ...task,
                  title: row.title || task.title,
                  spaceId: row.spaceId ?? undefined,
                  projectId: row.projectId ?? undefined,
                  status: (row.status as Task["status"]) ?? task.status,
                  updatedAt: Math.max(task.updatedAt, row.updatedAt),
                  sessionFile: row.sessionFile ?? task.sessionFile,
                  cwd: row.cwd ?? task.cwd,
                  modelId: row.modelId ?? task.modelId,
                  permissionMode,
                  welcomeMode,
                  archived: row.archived,
                  expertId: normalizeSingleExpertId(row.expertId),
                  expertBinding: row.expertBinding,
                  modePresetId: row.modePresetId,
                  startAt: row.startAt ?? undefined,
                  dueAt: row.dueAt ?? undefined,
                  isFavorited: Boolean(row.isFavorited),
                  spaceSortOrder:
                    row.spaceSortOrder ?? task.spaceSortOrder ?? 0,
                  externalAgentPin:
                    row.externalAgentPin ?? task.externalAgentPin,
                  doneAckedAt: row.doneAckedAt ?? task.doneAckedAt ?? null,
                }
              : task,
          ),
          ...(state.activeTaskId === taskId
            ? {
                welcomeMode,
                modePresetId: selectedPresetId,
                permissionMode,
                fullAccessDuringRun: permissionMode === "auto",
              }
            : {}),
        };
      });
    } catch (error) {
      console.warn("[appStore] 外部任务元数据同步失败", error);
    } finally {
      storeContext.runtime.pendingTaskMetadataHydrations.delete(taskId);
    }
  })();
}
