import { computeEffectiveArchived as computeEffectiveArchivedShared } from "../../../../../shared/workspace-tree";
import type { Space, Task } from "../../../types";
import type { AppActions } from "../actions";
import type { AppContext } from "../context";
import { saveSidebarExpanded } from "../persistence/uiPreferences";
import type { AppState } from "../types";
import { recomputeEffectiveArchived } from "../workspaces/spaceHelpers";

export function createWorkspaceMovesActions(
  storeContext: AppContext,
): Pick<AppActions, "bindTaskSpace" | "moveSpace" | "moveTaskInWorkspaceTree"> {
  const { get, set } = storeContext;
  return {
    bindTaskSpace: (taskId, spaceId) => {
      // P1-2 消除 upsert 旁路：所有任务换空间必须复用 moveTaskInWorkspaceTree 的 archived/effectiveArchived 双层防御与排序/renumber 契约。
      // 保持 TaskItem/WorkspacePicker/ChatInput 原调用不动，仅将底层由 upsertTask 改为等价 moveTask（源校验、目标校验、排序一致）。
      // 若 IPC 不可用（单测 mock）则回退为轻量本地校验+upsert，但主流程一律走 move 语义。
      const targetSpaceId = spaceId ?? null;
      const db = storeContext.getApi()?.db;
      const hasMoveApi =
        db &&
        "moveTaskInWorkspaceTree" in db &&
        typeof db.moveTaskInWorkspaceTree === "function";
      if (hasMoveApi) {
        void get().moveTaskInWorkspaceTree({ taskId, targetSpaceId });
        // 同步 homeSpaceId / 展开的语义由 moveTaskInWorkspaceTree 已处理；此处补充 activeTask 的 homeSpaceId 立即可见（move 为异步乐观，已在内部处理）
        return;
      }
      // fallback（无 IPC 环境，如单测）：走本地轻量 upsert，但仍做归档校验避免脏写
      const state = get();
      const task = state.tasks.find((t) => t.id === taskId);
      if (!task) return;
      if (task.archived) return;
      if (targetSpaceId != null) {
        const eff = computeEffectiveArchivedShared(
          state.spaces.map((s) => ({
            id: s.id,
            parentId: s.parentId ?? null,
            archived: Boolean(s.archived),
          })),
        );
        if (eff.get(targetSpaceId)) return;
        if (!state.spaces.some((s) => s.id === targetSpaceId)) return;
      }
      const now = Date.now();
      set((s) => {
        const next: Partial<AppState> = {
          tasks: s.tasks.map((t) =>
            t.id === taskId
              ? { ...t, spaceId: targetSpaceId ?? undefined, updatedAt: now }
              : t,
          ),
        };
        if (s.activeTaskId === taskId) next.homeSpaceId = targetSpaceId;
        // 把任务挂进某个空间时自动展开它，否则用户看不见刚落进去的任务
        if (targetSpaceId && !s.expandedSpaceIds.includes(targetSpaceId)) {
          const expanded = [...s.expandedSpaceIds, targetSpaceId];
          saveSidebarExpanded(expanded);
          next.expandedSpaceIds = expanded;
        }
        return next;
      });
      void storeContext.getApi()?.db?.upsertTask({
        id: task.id,
        title: task.title,
        spaceId: targetSpaceId,
        status: task.status,
        updatedAt: now,
        sessionFile: task.sessionFile,
        cwd: task.cwd,
        welcomeMode: task.welcomeMode,
      });
    },

    moveSpace: async ({ spaceId, targetParentId, targetIndex }) => {
      if (storeContext.runtime.pendingMoveSpaceIds.has(spaceId))
        return { ok: false as const, error: "正在移动中，请稍后重试" };
      storeContext.runtime.pendingMoveSpaceIds.add(spaceId);
      const prevChain = storeContext.runtime.moveChain;
      let releaseChain!: () => void;
      storeContext.runtime.moveChain = new Promise<void>(
        (res) => (releaseChain = res),
      );
      await prevChain;
      let prevSpaces: Space[] = [];
      let prevExpanded: string[] = [];
      let prevById = new Map<string, Space>();
      let newSiblingIds = new Set<string>();
      let oldSiblingIds = new Set<string>();
      let hasOptimistic = false;
      let result: { ok: true } | { ok: false; error: string } = {
        ok: true as const,
      };
      try {
        prevSpaces = get().spaces.map((s) => ({ ...s }));
        prevExpanded = get().expandedSpaceIds.slice();
        prevById = new Map(prevSpaces.map((s) => [s.id, s]));
        const moving = prevById.get(spaceId);
        if (!moving) {
          result = { ok: false as const, error: "空间不存在" };
          return result;
        }
        const oldParentId = moving.parentId ?? null;
        if (targetParentId === spaceId) {
          result = {
            ok: false as const,
            error: "不能把空间移动到其自身之下（cycle）",
          };
          return result;
        }
        if (targetParentId != null) {
          const byId = new Map(
            prevSpaces.map((s) => [s.id, s.parentId ?? null]),
          );
          let cur: string | null = targetParentId;
          const seen = new Set<string>();
          while (cur != null) {
            if (seen.has(cur)) break;
            seen.add(cur);
            if (cur === spaceId) {
              result = {
                ok: false as const,
                error: "不能把空间移动到其子孙空间之下（cycle）",
              };
              return result;
            }
            cur = byId.get(cur) ?? null;
          }
          const eff = computeEffectiveArchivedShared(
            prevSpaces.map((s) => ({
              id: s.id,
              parentId: s.parentId ?? null,
              archived: Boolean(s.archived),
            })),
          );
          if (eff.get(spaceId)) {
            result = { ok: false as const, error: "已归档空间不能移动" };
            return result;
          }
          if (eff.get(targetParentId)) {
            result = { ok: false as const, error: "不能移动到已归档空间" };
            return result;
          }
          if (!prevSpaces.some((s) => s.id === targetParentId)) {
            result = { ok: false as const, error: "目标空间不存在" };
            return result;
          }
        } else {
          const eff = computeEffectiveArchivedShared(
            prevSpaces.map((s) => ({
              id: s.id,
              parentId: s.parentId ?? null,
              archived: Boolean(s.archived),
            })),
          );
          if (eff.get(spaceId)) {
            result = { ok: false as const, error: "已归档空间不能移动" };
            return result;
          }
        }
        // 计算受影响 sibling 集合，用于精确回滚（跨 id 并发时不覆盖另一成功乐观）
        const siblingsTarget = prevSpaces
          .filter((s) => (s.parentId ?? null) === (targetParentId ?? null))
          .sort((a, b) => {
            const ao = a.sortOrder ?? 0;
            const bo = b.sortOrder ?? 0;
            if (ao !== bo) return ao - bo;
            const ac = a.createdAt ?? 0;
            const bc = b.createdAt ?? 0;
            if (ac !== bc) return ac - bc;
            return a.id.localeCompare(b.id);
          });
        const filteredTargetIds = siblingsTarget
          .map((s) => s.id)
          .filter((id) => id !== spaceId);
        newSiblingIds = new Set(filteredTargetIds);
        if (oldParentId !== targetParentId) {
          const oldSiblings = prevSpaces
            .filter(
              (s) => (s.parentId ?? null) === oldParentId && s.id !== spaceId,
            )
            .sort((a, b) => {
              const ao = a.sortOrder ?? 0;
              const bo = b.sortOrder ?? 0;
              if (ao !== bo) return ao - bo;
              const ac = a.createdAt ?? 0;
              const bc = b.createdAt ?? 0;
              if (ac !== bc) return ac - bc;
              return a.id.localeCompare(b.id);
            });
          oldSiblingIds = new Set(oldSiblings.map((s) => s.id));
        }
        const now = Date.now();
        let nextSpaces: Space[] = prevSpaces.map((s) => ({ ...s }));
        if (targetIndex !== undefined) {
          const filtered = filteredTargetIds;
          const clamped = Math.max(0, Math.min(targetIndex, filtered.length));
          const newOrder = [
            ...filtered.slice(0, clamped),
            spaceId,
            ...filtered.slice(clamped),
          ];
          const orderMap = new Map(
            newOrder.map((id, idx) => [id, (idx + 1) * 1000]),
          );
          nextSpaces = nextSpaces.map((s) => {
            if (orderMap.has(s.id)) {
              return {
                ...s,
                parentId: targetParentId,
                sortOrder: orderMap.get(s.id)!,
              };
            }
            return s;
          });
          if (oldParentId !== targetParentId) {
            const oldSiblings = prevSpaces
              .filter(
                (s) => (s.parentId ?? null) === oldParentId && s.id !== spaceId,
              )
              .sort((a, b) => {
                const ao = a.sortOrder ?? 0;
                const bo = b.sortOrder ?? 0;
                if (ao !== bo) return ao - bo;
                const ac = a.createdAt ?? 0;
                const bc = b.createdAt ?? 0;
                if (ac !== bc) return ac - bc;
                return a.id.localeCompare(b.id);
              });
            const oldMap = new Map(
              oldSiblings.map((s, idx) => [s.id, (idx + 1) * 1000]),
            );
            nextSpaces = nextSpaces.map((s) =>
              oldMap.has(s.id) ? { ...s, sortOrder: oldMap.get(s.id)! } : s,
            );
          }
        } else {
          const curMax = Math.max(
            0,
            ...prevSpaces
              .filter(
                (s) =>
                  (s.parentId ?? null) === (targetParentId ?? null) &&
                  s.id !== spaceId,
              )
              .map((s) => s.sortOrder ?? 0),
          );
          nextSpaces = nextSpaces.map((s) =>
            s.id === spaceId
              ? { ...s, parentId: targetParentId, sortOrder: curMax + 1000 }
              : s,
          );
          if (oldParentId !== targetParentId) {
            const oldSiblings = prevSpaces
              .filter(
                (s) => (s.parentId ?? null) === oldParentId && s.id !== spaceId,
              )
              .sort((a, b) => {
                const ao = a.sortOrder ?? 0;
                const bo = b.sortOrder ?? 0;
                if (ao !== bo) return ao - bo;
                return a.id.localeCompare(b.id);
              });
            const oldMap = new Map(
              oldSiblings.map((s, idx) => [s.id, (idx + 1) * 1000]),
            );
            nextSpaces = nextSpaces.map((s) =>
              oldMap.has(s.id) ? { ...s, sortOrder: oldMap.get(s.id)! } : s,
            );
          }
        }
        nextSpaces = recomputeEffectiveArchived(nextSpaces);
        // 移动进某个空间时自动展开它（否则用户看不到移动结果）；存储语义为「已展开集合」
        let nextExpanded = prevExpanded.slice();
        if (targetParentId && !nextExpanded.includes(targetParentId)) {
          nextExpanded = [...nextExpanded, targetParentId];
          saveSidebarExpanded(nextExpanded);
        }
        set({ spaces: nextSpaces, expandedSpaceIds: nextExpanded });
        hasOptimistic = true;
        const res: any = await (storeContext.getApi() as any)?.db?.moveSpace?.({
          spaceId,
          targetParentId,
          targetIndex,
        });
        if (res && res.ok === false) {
          // 精确函数式回滚：仅回退本 move 影响的 ids 与 targetParentId 折叠态，跨 kind/跨 id 成功展开不被覆盖（P2-3）
          set((s) => {
            const restored = s.spaces.map((cur) => {
              if (cur.id === spaceId) {
                const prev = prevById.get(cur.id)!;
                return {
                  ...cur,
                  parentId: prev.parentId,
                  sortOrder: prev.sortOrder,
                };
              }
              if (newSiblingIds.has(cur.id) || oldSiblingIds.has(cur.id)) {
                const prev = prevById.get(cur.id);
                if (prev) return { ...cur, sortOrder: prev.sortOrder };
              }
              return cur;
            });
            // P2-3 精确回退：仅当本次乐观展开了 targetParentId 时才把它移出展开集合
            const curExpanded = s.expandedSpaceIds;
            const wasExpanded = targetParentId
              ? prevExpanded.includes(targetParentId)
              : false;
            const isNowExpanded = targetParentId
              ? curExpanded.includes(targetParentId)
              : false;
            let nextExpanded = curExpanded;
            if (targetParentId && !wasExpanded && isNowExpanded) {
              nextExpanded = curExpanded.filter((id) => id !== targetParentId);
              saveSidebarExpanded(nextExpanded);
            }
            return {
              spaces: recomputeEffectiveArchived(restored),
              expandedSpaceIds: nextExpanded,
            };
          });
          result = { ok: false as const, error: res.error || "移动空间失败" };
          return result;
        }
        result = { ok: true as const };
        return result;
      } catch (err) {
        if (hasOptimistic) {
          set((s) => {
            const restored = s.spaces.map((cur) => {
              if (cur.id === spaceId) {
                const prev = prevById.get(cur.id)!;
                return {
                  ...cur,
                  parentId: prev.parentId,
                  sortOrder: prev.sortOrder,
                };
              }
              if (newSiblingIds.has(cur.id) || oldSiblingIds.has(cur.id)) {
                const prev = prevById.get(cur.id);
                if (prev) return { ...cur, sortOrder: prev.sortOrder };
              }
              return cur;
            });
            const curExpanded = s.expandedSpaceIds;
            const wasExpanded = targetParentId
              ? prevExpanded.includes(targetParentId)
              : false;
            const isNowExpanded = targetParentId
              ? curExpanded.includes(targetParentId)
              : false;
            let nextExpanded = curExpanded;
            if (targetParentId && !wasExpanded && isNowExpanded) {
              nextExpanded = curExpanded.filter((id) => id !== targetParentId);
              saveSidebarExpanded(nextExpanded);
            }
            return {
              spaces: recomputeEffectiveArchived(restored),
              expandedSpaceIds: nextExpanded,
            };
          });
        }
        result = {
          ok: false as const,
          error: err instanceof Error ? err.message : String(err),
        };
        return result;
      } finally {
        releaseChain();
        storeContext.runtime.pendingMoveSpaceIds.delete(spaceId);
      }
    },

    moveTaskInWorkspaceTree: async ({ taskId, targetSpaceId, targetIndex }) => {
      if (storeContext.runtime.pendingMoveTaskIds.has(taskId))
        return { ok: false as const, error: "正在移动中，请稍后重试" };
      storeContext.runtime.pendingMoveTaskIds.add(taskId);
      const prevChain = storeContext.runtime.moveChain;
      let releaseChain!: () => void;
      storeContext.runtime.moveChain = new Promise<void>(
        (res) => (releaseChain = res),
      );
      await prevChain;
      let prevTasks: Task[] = [];
      let prevSpaces: Space[] = [];
      let prevExpanded: string[] = [];
      let prevHomeSpaceId: string | null = null;
      let isActiveTask = false;
      let prevById = new Map<string, Task>();
      let newSiblingIds = new Set<string>();
      let oldSiblingIds = new Set<string>();
      let hasOptimistic = false;
      let result: { ok: true } | { ok: false; error: string } = {
        ok: true as const,
      };
      try {
        prevTasks = get().tasks.map((t) => ({ ...t }));
        prevSpaces = get().spaces;
        prevExpanded = get().expandedSpaceIds.slice();
        prevHomeSpaceId = get().homeSpaceId;
        isActiveTask = get().activeTaskId === taskId;
        prevById = new Map(prevTasks.map((t) => [t.id, t]));
        const moving = prevById.get(taskId);
        if (!moving) {
          result = { ok: false as const, error: "任务不存在" };
          return result;
        }
        const oldSpaceId = moving.spaceId ?? null;
        if (moving.archived) {
          result = { ok: false as const, error: "已归档任务不能移动" };
          return result;
        }
        if (targetSpaceId != null) {
          const eff = computeEffectiveArchivedShared(
            prevSpaces.map((s) => ({
              id: s.id,
              parentId: s.parentId ?? null,
              archived: Boolean(s.archived),
            })),
          );
          if (eff.get(targetSpaceId)) {
            result = { ok: false as const, error: "不能移动到已归档空间" };
            return result;
          }
          if (!prevSpaces.some((s) => s.id === targetSpaceId)) {
            result = { ok: false as const, error: "目标空间不存在" };
            return result;
          }
        }
        // 计算受影响 sibling 集合用于精确回滚
        if (targetIndex !== undefined && targetSpaceId != null) {
          const siblings = prevTasks
            .filter((t) => (t.spaceId ?? null) === targetSpaceId)
            .sort((a, b) => {
              const ao = a.spaceSortOrder ?? 0;
              const bo = b.spaceSortOrder ?? 0;
              if (ao !== bo) return ao - bo;
              if (a.updatedAt !== b.updatedAt) return a.updatedAt - b.updatedAt;
              return a.id.localeCompare(b.id);
            });
          const filtered = siblings
            .map((t) => t.id)
            .filter((id) => id !== taskId);
          newSiblingIds = new Set(filtered);
          if (oldSpaceId !== targetSpaceId && oldSpaceId != null) {
            const oldSiblings = prevTasks
              .filter(
                (t) => (t.spaceId ?? null) === oldSpaceId && t.id !== taskId,
              )
              .sort((a, b) => {
                const ao = a.spaceSortOrder ?? 0;
                const bo = b.spaceSortOrder ?? 0;
                if (ao !== bo) return ao - bo;
                return a.id.localeCompare(b.id);
              });
            oldSiblingIds = new Set(oldSiblings.map((t) => t.id));
          }
        } else if (targetSpaceId == null) {
          if (oldSpaceId != null) {
            const oldSiblings = prevTasks
              .filter(
                (t) => (t.spaceId ?? null) === oldSpaceId && t.id !== taskId,
              )
              .sort((a, b) => {
                const ao = a.spaceSortOrder ?? 0;
                const bo = b.spaceSortOrder ?? 0;
                if (ao !== bo) return ao - bo;
                return a.id.localeCompare(b.id);
              });
            oldSiblingIds = new Set(oldSiblings.map((t) => t.id));
          }
        } else {
          const curSiblings = prevTasks
            .filter(
              (t) => (t.spaceId ?? null) === targetSpaceId && t.id !== taskId,
            )
            .map((t) => t.id);
          newSiblingIds = new Set(curSiblings);
          if (oldSpaceId !== targetSpaceId && oldSpaceId != null) {
            const oldSiblings = prevTasks
              .filter(
                (t) => (t.spaceId ?? null) === oldSpaceId && t.id !== taskId,
              )
              .map((t) => t.id);
            oldSiblingIds = new Set(oldSiblings);
          }
        }
        const now = Date.now();
        let nextTasks: Task[] = prevTasks.map((t) => ({ ...t }));
        if (targetIndex !== undefined && targetSpaceId != null) {
          const siblings = prevTasks
            .filter((t) => (t.spaceId ?? null) === targetSpaceId)
            .sort((a, b) => {
              const ao = a.spaceSortOrder ?? 0;
              const bo = b.spaceSortOrder ?? 0;
              if (ao !== bo) return ao - bo;
              if (a.updatedAt !== b.updatedAt) return a.updatedAt - b.updatedAt;
              return a.id.localeCompare(b.id);
            });
          const filtered = siblings
            .map((t) => t.id)
            .filter((id) => id !== taskId);
          const clamped = Math.max(0, Math.min(targetIndex, filtered.length));
          const newOrder = [
            ...filtered.slice(0, clamped),
            taskId,
            ...filtered.slice(clamped),
          ];
          const orderMap = new Map(
            newOrder.map((id, idx) => [id, (idx + 1) * 1000]),
          );
          nextTasks = nextTasks.map((t) => {
            if (orderMap.has(t.id)) {
              return {
                ...t,
                spaceId: targetSpaceId ?? undefined,
                spaceSortOrder: orderMap.get(t.id)!,
                updatedAt: now,
              };
            }
            if (t.id === taskId && !orderMap.has(t.id)) {
              return {
                ...t,
                spaceId: targetSpaceId ?? undefined,
                updatedAt: now,
              };
            }
            return t;
          });
          if (oldSpaceId !== targetSpaceId && oldSpaceId != null) {
            const oldSiblings = prevTasks
              .filter(
                (t) => (t.spaceId ?? null) === oldSpaceId && t.id !== taskId,
              )
              .sort((a, b) => {
                const ao = a.spaceSortOrder ?? 0;
                const bo = b.spaceSortOrder ?? 0;
                if (ao !== bo) return ao - bo;
                if (a.updatedAt !== b.updatedAt)
                  return a.updatedAt - b.updatedAt;
                return a.id.localeCompare(b.id);
              });
            const oldMap = new Map(
              oldSiblings.map((t, idx) => [t.id, (idx + 1) * 1000]),
            );
            nextTasks = nextTasks.map((t) =>
              oldMap.has(t.id)
                ? { ...t, spaceSortOrder: oldMap.get(t.id)! }
                : t,
            );
          }
        } else if (targetSpaceId == null) {
          nextTasks = nextTasks.map((t) =>
            t.id === taskId
              ? { ...t, spaceId: undefined, spaceSortOrder: 0, updatedAt: now }
              : t,
          );
          if (oldSpaceId != null) {
            const oldSiblings = prevTasks
              .filter(
                (t) => (t.spaceId ?? null) === oldSpaceId && t.id !== taskId,
              )
              .sort((a, b) => {
                const ao = a.spaceSortOrder ?? 0;
                const bo = b.spaceSortOrder ?? 0;
                if (ao !== bo) return ao - bo;
                return a.id.localeCompare(b.id);
              });
            const oldMap = new Map(
              oldSiblings.map((t, idx) => [t.id, (idx + 1) * 1000]),
            );
            nextTasks = nextTasks.map((t) =>
              oldMap.has(t.id)
                ? { ...t, spaceSortOrder: oldMap.get(t.id)! }
                : t,
            );
          }
        } else {
          const curMax = Math.max(
            0,
            ...prevTasks
              .filter(
                (t) => (t.spaceId ?? null) === targetSpaceId && t.id !== taskId,
              )
              .map((t) => t.spaceSortOrder ?? 0),
          );
          nextTasks = nextTasks.map((t) =>
            t.id === taskId
              ? {
                  ...t,
                  spaceId: targetSpaceId ?? undefined,
                  spaceSortOrder: curMax + 1000,
                  updatedAt: now,
                }
              : t,
          );
          if (oldSpaceId !== targetSpaceId && oldSpaceId != null) {
            const oldSiblings = prevTasks
              .filter(
                (t) => (t.spaceId ?? null) === oldSpaceId && t.id !== taskId,
              )
              .sort((a, b) => {
                const ao = a.spaceSortOrder ?? 0;
                const bo = b.spaceSortOrder ?? 0;
                if (ao !== bo) return ao - bo;
                return a.id.localeCompare(b.id);
              });
            const oldMap = new Map(
              oldSiblings.map((t, idx) => [t.id, (idx + 1) * 1000]),
            );
            nextTasks = nextTasks.map((t) =>
              oldMap.has(t.id)
                ? { ...t, spaceSortOrder: oldMap.get(t.id)! }
                : t,
            );
          }
        }
        const nextPinned = nextTasks
          .filter((t) => t.isFavorited)
          .map((t) => t.id);
        // 任务被移进某空间时自动展开它（否则移动结果不可见）
        let nextExpanded = prevExpanded.slice();
        if (targetSpaceId && !nextExpanded.includes(targetSpaceId)) {
          nextExpanded = [...nextExpanded, targetSpaceId];
          saveSidebarExpanded(nextExpanded);
        }
        // P2-1 单一真相：homeSpaceId 由 moveTask 统一处理，activeTask 同步 targetSpaceId，失败回滚恢复旧值
        const nextHomeSpaceId = isActiveTask ? targetSpaceId : prevHomeSpaceId;
        set({
          tasks: nextTasks,
          pinnedTaskIds: nextPinned,
          expandedSpaceIds: nextExpanded,
          homeSpaceId: nextHomeSpaceId,
        });
        hasOptimistic = true;
        const res: any = await (
          storeContext.getApi() as any
        )?.db?.moveTaskInWorkspaceTree?.({
          taskId,
          targetSpaceId,
          targetIndex,
        });
        if (res && res.ok === false) {
          set((s) => {
            const restored = s.tasks.map((cur) => {
              if (cur.id === taskId) {
                const prev = prevById.get(cur.id)!;
                return {
                  ...cur,
                  spaceId: prev.spaceId,
                  spaceSortOrder: prev.spaceSortOrder,
                  updatedAt: prev.updatedAt,
                };
              }
              if (newSiblingIds.has(cur.id) || oldSiblingIds.has(cur.id)) {
                const prev = prevById.get(cur.id);
                if (prev)
                  return { ...cur, spaceSortOrder: prev.spaceSortOrder };
              }
              return cur;
            });
            // P2-3 精确回退（展开集合）+ P2-1 homeSpaceId 回滚
            const curExpanded = s.expandedSpaceIds;
            const wasExpanded = targetSpaceId
              ? prevExpanded.includes(targetSpaceId)
              : false;
            const isNowExpanded = targetSpaceId
              ? curExpanded.includes(targetSpaceId)
              : false;
            let restoredExpanded = curExpanded;
            if (targetSpaceId && !wasExpanded && isNowExpanded) {
              restoredExpanded = curExpanded.filter(
                (id) => id !== targetSpaceId,
              );
              saveSidebarExpanded(restoredExpanded);
            }
            const restoredHomeSpaceId = isActiveTask
              ? prevHomeSpaceId
              : s.homeSpaceId;
            return {
              tasks: restored,
              pinnedTaskIds: restored
                .filter((t) => t.isFavorited)
                .map((t) => t.id),
              expandedSpaceIds: restoredExpanded,
              homeSpaceId: restoredHomeSpaceId,
            };
          });
          result = { ok: false as const, error: res.error || "移动任务失败" };
          return result;
        }
        result = { ok: true as const };
        return result;
      } catch (err) {
        if (hasOptimistic) {
          set((s) => {
            const restored = s.tasks.map((cur) => {
              if (cur.id === taskId) {
                const prev = prevById.get(cur.id)!;
                return {
                  ...cur,
                  spaceId: prev.spaceId,
                  spaceSortOrder: prev.spaceSortOrder,
                  updatedAt: prev.updatedAt,
                };
              }
              if (newSiblingIds.has(cur.id) || oldSiblingIds.has(cur.id)) {
                const prev = prevById.get(cur.id);
                if (prev)
                  return { ...cur, spaceSortOrder: prev.spaceSortOrder };
              }
              return cur;
            });
            const curExpanded = s.expandedSpaceIds;
            const wasExpanded = targetSpaceId
              ? prevExpanded.includes(targetSpaceId)
              : false;
            const isNowExpanded = targetSpaceId
              ? curExpanded.includes(targetSpaceId)
              : false;
            let restoredExpanded = curExpanded;
            if (targetSpaceId && !wasExpanded && isNowExpanded) {
              restoredExpanded = curExpanded.filter(
                (id) => id !== targetSpaceId,
              );
              saveSidebarExpanded(restoredExpanded);
            }
            const restoredHomeSpaceId = isActiveTask
              ? prevHomeSpaceId
              : s.homeSpaceId;
            return {
              tasks: restored,
              pinnedTaskIds: restored
                .filter((t) => t.isFavorited)
                .map((t) => t.id),
              expandedSpaceIds: restoredExpanded,
              homeSpaceId: restoredHomeSpaceId,
            };
          });
        }
        result = {
          ok: false as const,
          error: err instanceof Error ? err.message : String(err),
        };
        return result;
      } finally {
        releaseChain();
        storeContext.runtime.pendingMoveTaskIds.delete(taskId);
      }
    },
  };
}
