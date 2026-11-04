import { isTaskDoneUnread } from "../../../utils/taskFilters";
import type { AppActions } from "../actions";
import type { AppContext } from "../context";
import { saveSidebarExpanded } from "../persistence/uiPreferences";
import { mapTaskRowToTask } from "../tasks/taskMapper";
import { resetTaskScopedUiState } from "../transitions/taskUiTransition";
import { recomputeEffectiveArchived } from "../workspaces/spaceHelpers";

export function createTaskLifecycleActions(
  storeContext: AppContext,
): Pick<
  AppActions,
  | "deleteTask"
  | "purgeArchivedContent"
  | "refreshTrashedTasks"
  | "restoreTrashedTask"
  | "setTaskStatus"
  | "renameTask"
  | "togglePinTask"
  | "archiveTask"
  | "ackTaskDone"
  | "restoreTask"
> {
  const { get, set } = storeContext;
  return {
    deleteTask: (id) => {
      // Mark before the optimistic UI removal / async Main trash call, closing the late-patch race window.
      storeContext.runtime.deletedTaskRuntimeTombstones.add(id);
      const deletingActive = get().activeTaskId === id;
      set((s) => {
        const tasks = s.tasks.filter((x) => x.id !== id);
        if (deletingActive) {
          const nextTaskId = tasks[0]?.id ?? null;
          return {
            tasks,
            // 删除当前任务：Task 级 UI 原子收口（含 sidebar 恢复、browser 残留清理）
            ...resetTaskScopedUiState(s, {
              nextTaskId,
              deletedTaskId: id,
              clearBrowserUrl: true,
            }),
          };
        }
        // 删除非当前任务：不动当前右栏，只摘掉被删任务自身的 browser 残留
        const browserUrlByTask = s.browserUrlByTask ?? {};
        return {
          tasks,
          browserUrlByTask: Object.fromEntries(
            Object.entries(browserUrlByTask).filter(([k]) => k !== id),
          ),
        };
      });
      // P1.5：delete = 安全回收（move 到 projects-trash + 标记 trashed），保留 task/Artifact 至 purge。
      // 不再立即 artifactDomain.removeTask；永久清理由 purge 路径触发。
      const deletePromise = storeContext.getApi()?.db?.deleteTask(id);
      // 对话分支血缘：删除 child 后父任务「查看分支（N）」计数要刷新；
      // 删除 parent 后当前任务的来源 chip 要刷新为 parentExists=false。
      // 等主进程事务落库后再刷新，避免读到旧行。
      void deletePromise
        ?.then(() => {
          if (get().activeTaskId)
            get().refreshBranchLineage(get().activeTaskId!);
        })
        .catch(() => undefined);
      // 删除当前任务：在状态切换后立即显式关闭原生 Browser/Artifact WebContentsView，
      // 尽量缩短原生表面残留窗口；失败不阻止删除（App.tsx panel 卸载 effect 会兜底重关）。
      const api = storeContext.getApi();
      if (deletingActive && api?.artifact?.close) {
        try {
          api.artifact.close();
        } catch (err) {
          console.warn("[deleteTask] artifact.close failed", err);
        }
      }
      if (deletingActive && api?.browser?.close) {
        try {
          api.browser.close();
        } catch (err) {
          console.warn("[deleteTask] browser.close failed", err);
        }
      }
      // F3：taskConnectorIds 随任务保留至真正 purge —— delete = 回收站，restore 需恢复连接器配置；
      // 主进程 TaskExecutionWorkspaceLifecycle.purge 会在永久删除时清理对应 settings key。
      // projection 是 renderer 侧缓存：UI 隐藏即可；数据仍在 Domain 供恢复
      get().clearArtifactTask(id);
    },

    purgeArchivedContent: async (request) => {
      const api = storeContext.getApi()?.db?.purgeArchivedContent;
      if (!api) throw new Error("永久删除接口不可用，请重启到最新版本");
      // Only remove records acknowledged by Main; failed items remain available for retry.
      const result = await api(request);
      const taskIds = new Set(result.deletedTaskIds);
      const spaceIds = new Set(result.deletedSpaceIds);
      for (const id of taskIds)
        storeContext.runtime.deletedTaskRuntimeTombstones.add(id);
      const deletingActive = taskIds.has(get().activeTaskId ?? "");
      set((state) => {
        const tasks = state.tasks.filter((task) => !taskIds.has(task.id));
        const spaces = recomputeEffectiveArchived(
          state.spaces.filter((space) => !spaceIds.has(space.id)),
        );
        const archivedSpaceIds = new Set(
          spaces
            .filter((space) => space.effectiveArchived ?? space.archived)
            .map((space) => space.id),
        );
        const expandedSpaceIds = state.expandedSpaceIds.filter(
          (id) => !spaceIds.has(id),
        );
        if (expandedSpaceIds.length !== state.expandedSpaceIds.length)
          saveSidebarExpanded(expandedSpaceIds);
        const reset = deletingActive
          ? resetTaskScopedUiState(state, {
              nextTaskId:
                tasks.find(
                  (task) =>
                    !task.archived && !archivedSpaceIds.has(task.spaceId ?? ""),
                )?.id ?? null,
              deletedTaskId: state.activeTaskId!,
              clearBrowserUrl: true,
            })
          : {};
        return {
          ...reset,
          tasks,
          spaces,
          pinnedTaskIds: state.pinnedTaskIds.filter((id) => !taskIds.has(id)),
          expandedSpaceIds,
          homeSpaceId: spaceIds.has(state.homeSpaceId ?? "")
            ? null
            : state.homeSpaceId,
          draft: spaceIds.has(state.draft?.spaceId ?? "") ? null : state.draft,
          browserUrlByTask: Object.fromEntries(
            Object.entries(state.browserUrlByTask ?? {}).filter(
              ([id]) => !taskIds.has(id),
            ),
          ),
        };
      });
      for (const id of taskIds) get().clearArtifactTask(id);
      if (deletingActive) {
        try {
          await storeContext.getApi()?.artifact?.close?.();
          await storeContext.getApi()?.browser?.close?.();
        } catch (error) {
          console.warn(
            "[purgeArchivedContent] close native panel failed",
            error,
          );
        }
      }
      if (get().activeTaskId && taskIds.size)
        void get().refreshBranchLineage(get().activeTaskId!);
      return result;
    },

    refreshTrashedTasks: async () => {
      const api = storeContext.getApi()?.db?.listTrashedTasks;
      if (!api) return;
      try {
        set({ trashedTasks: await api() });
      } catch (error) {
        console.warn("[refreshTrashedTasks]", error);
      }
    },

    restoreTrashedTask: async (id) => {
      const api = storeContext.getApi()?.db?.restoreTrashedTask;
      if (!api) throw new Error("回收站接口不可用，请重启到最新版本");
      const restored = await api(id);
      // 恢复后任务回到侧栏；回收站里不再列出它。
      storeContext.runtime.deletedTaskRuntimeTombstones.delete(id);
      const state = get();
      const task = restored
        ? mapTaskRowToTask(restored, {
            enabledModelIds: new Set(
              state.models
                .filter((model) => model.enabled !== false)
                .map((model) => model.id),
            ),
            defaultModelId: state.defaultModelId,
            permissionModeDefault: state.permissionMode,
          })
        : null;
      set((current) => ({
        trashedTasks: current.trashedTasks.filter((item) => item.id !== id),
        tasks:
          task && !current.tasks.some((item) => item.id === task.id)
            ? [task, ...current.tasks]
            : current.tasks,
      }));
    },

    setTaskStatus: (id, status) => {
      const updatedAt = Date.now();
      set((state) => ({
        tasks: state.tasks.map((task) =>
          task.id === id ? { ...task, status, updatedAt } : task,
        ),
      }));
      const task = get().tasks.find((item) => item.id === id);
      if (!task) return;
      void storeContext.getApi()?.db?.upsertTask({
        id: task.id,
        title: task.title,
        spaceId: task.spaceId,
        status,
        updatedAt,
      });
    },

    renameTask: (id, title) => {
      set((s) => ({
        tasks: s.tasks.map((x) =>
          x.id === id ? { ...x, title, updatedAt: Date.now() } : x,
        ),
      }));
      const task = get().tasks.find((x) => x.id === id);
      if (task && (task.messages.length > 0 || task.sessionFile)) {
        void storeContext.getApi()?.db?.upsertTask({
          id: task.id,
          title,
          spaceId: task.spaceId,
          status: task.status,
          updatedAt: Date.now(),
        });
      }
    },

    togglePinTask: async (id) => {
      if (storeContext.runtime.pendingPinTaskIds.has(id)) return; // P1-1：同任务并发直接丢弃，避免重叠乐观更新形成幽灵 pin
      const task = get().tasks.find((t) => t.id === id);
      if (!task) return;
      const prevFav = Boolean(task.isFavorited);
      const prevUpdatedAt = task.updatedAt;
      const next = !prevFav;
      const now = Date.now(); // 单一 now：乐观与持久化同戳，回滚可精确还原
      storeContext.runtime.pendingPinTaskIds.add(id);
      // 乐观更新：本地 tasks.isFavorited + pinnedTaskIds + updatedAt 同步，重启后以 DB is_favorited 为准（Phase 2 持久化闭环）
      set((s) => ({
        tasks: s.tasks.map((t) =>
          t.id === id ? { ...t, isFavorited: next, updatedAt: now } : t,
        ),
        pinnedTaskIds: next
          ? [...s.pinnedTaskIds.filter((x) => x !== id), id]
          : s.pinnedTaskIds.filter((x) => x !== id),
      }));
      try {
        await storeContext.getApi()?.db?.upsertTask?.({
          id,
          title: task.title,
          updatedAt: now,
          isFavorited: next,
        });
      } catch (err) {
        // 失败仅回退目标 id（函数式），不以全量快照覆盖 pinnedTaskIds，避免跨任务并发时误删/误留其它任务的乐观 pin（P2 修复：prevFav 决定仅对 id 做增/删）
        set((s) => ({
          tasks: s.tasks.map((t) =>
            t.id === id
              ? { ...t, isFavorited: prevFav, updatedAt: prevUpdatedAt }
              : t,
          ),
          pinnedTaskIds: prevFav
            ? s.pinnedTaskIds.includes(id)
              ? s.pinnedTaskIds
              : [...s.pinnedTaskIds, id]
            : s.pinnedTaskIds.filter((x) => x !== id),
        }));
        console.error("[appStore] togglePinTask 持久化失败:", err);
      } finally {
        storeContext.runtime.pendingPinTaskIds.delete(id);
      }
    },

    archiveTask: async (id) => {
      const task = get().tasks.find((x) => x.id === id);
      if (!task) return;
      set((s) => ({
        tasks: s.tasks.map((x) => (x.id === id ? { ...x, archived: true } : x)),
      }));
      await storeContext.getApi()?.db?.archiveTask?.(id, true);
    },

    ackTaskDone: async (id) => {
      const task = get().tasks.find((t) => t.id === id);
      // 只处理「已结束且未确认」：进行中/空闲/已确认都不写库，避免每次切换任务产生无意义 IPC
      if (!task || !isTaskDoneUnread(task)) return;
      const ackedAt = Date.now();
      // 乐观更新：本地先关绿点（渲染层同帧生效），持久化失败也不回滚——
      // 绿点是「看过」的弱提示，误清比常亮代价小；下次点击会重试写库。
      set((s) => ({
        tasks: s.tasks.map((t) =>
          t.id === id ? { ...t, doneAckedAt: ackedAt } : t,
        ),
      }));
      try {
        await storeContext.getApi()?.db?.ackTaskDone?.(id, ackedAt);
      } catch (error) {
        console.warn(
          "[appStore] ackTaskDone 持久化失败（绿点会在重启后重现）:",
          error,
        );
      }
    },

    restoreTask: async (id) => {
      set((s) => ({
        tasks: s.tasks.map((x) =>
          x.id === id ? { ...x, archived: false } : x,
        ),
      }));
      await storeContext.getApi()?.db?.archiveTask?.(id, false);
    },
  };
}
