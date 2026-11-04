import {
  findSpaceToRemount,
  spacePathKey,
} from "../../../../../shared/space-relocate";
import type { Space } from "../../../types";
import type { AppActions } from "../actions";
import type { AppContext } from "../context";
import { saveSidebarExpanded } from "../persistence/uiPreferences";
import { uid } from "../runtime/ids";
import {
  nextAvailableSpaceName,
  normalizePath,
  recomputeEffectiveArchived,
} from "../workspaces/spaceHelpers";
import { applySpacePath } from "../workspaces/spacePersistence";

export function createWorkspaceLifecycleActions(
  storeContext: AppContext,
): Pick<
  AppActions,
  | "archiveSpace"
  | "restoreSpace"
  | "deleteSpace"
  | "addSpace"
  | "refreshSpaces"
  | "ensureSpaceFromPath"
  | "addSpaceFromPath"
  | "relocateSpace"
  | "refreshSpacePathStatus"
  | "renameSpace"
> {
  const { get, set } = storeContext;
  return {
    archiveSpace: async (id) => {
      const space = get().spaces.find((x) => x.id === id);
      if (!space) return;
      // P1-2 修复：DB 只改 spaces.archived，UI 绝不 fan-out 到 tasks；effective 由 recompute 统一计算，重启前后一致
      set((s) => ({
        spaces: recomputeEffectiveArchived(
          s.spaces.map((x) => (x.id === id ? { ...x, archived: true } : x)),
        ),
        homeSpaceId: s.homeSpaceId === id ? null : s.homeSpaceId,
      }));
      await storeContext.getApi()?.db?.archiveSpace?.(id, true);
    },

    restoreSpace: async (id) => {
      set((s) => ({
        spaces: recomputeEffectiveArchived(
          s.spaces.map((x) => (x.id === id ? { ...x, archived: false } : x)),
        ),
      }));
      await storeContext.getApi()?.db?.archiveSpace?.(id, false);
    },

    deleteSpace: async (id) => {
      const res: any = await storeContext.getApi()?.db?.deleteSpace?.(id);
      if (res && res.ok === false) {
        if (res.reason === "workspace_not_empty") {
          throw new Error("空间非空，无法删除：请先移走子空间和任务");
        }
        throw new Error(res.error || "删除空间失败");
      }
      // P2-1 清理 stale id（删除后不再残留 localStorage；存储语义为「已展开集合」）
      set((s) => {
        const nextExpanded = s.expandedSpaceIds.filter((x) => x !== id);
        if (nextExpanded.length !== s.expandedSpaceIds.length)
          saveSidebarExpanded(nextExpanded);
        return {
          spaces: s.spaces.filter((x) => x.id !== id),
          homeSpaceId: s.homeSpaceId === id ? null : s.homeSpaceId,
          expandedSpaceIds: nextExpanded,
          // 主进程已把任务 space_id 置 NULL，内存同步解绑，任务归入「任务」分组
          tasks: s.tasks.map((t) =>
            t.spaceId === id ? { ...t, spaceId: undefined } : t,
          ),
        };
      });
    },

    addSpace: async (
      parentId?: string | null,
      requestedName?: string,
    ): Promise<string | undefined> => {
      const pid = parentId ?? null;
      const base =
        requestedName?.trim() || `工作空间 ${get().spaces.length + 1}`;
      const name = nextAvailableSpaceName(get().spaces, base, pid);
      const space: Space = {
        id: uid(storeContext),
        name,
        parentId: pid,
      };
      set((s) => ({
        spaces: [...s.spaces, space],
        homeSpaceId: space.id,
      }));
      const result = await storeContext.getApi()?.db?.upsertSpace({
        id: space.id,
        name: space.name,
        path: space.path,
        parentId: pid,
      } as any);
      if (result && !result.ok) {
        console.error("[addSpace] 写入失败：", result.error);
        set((s) => ({
          spaces: s.spaces.filter((x) => x.id !== space.id),
          homeSpaceId: s.homeSpaceId === space.id ? null : s.homeSpaceId,
        }));
        return undefined;
      }
      await get().refreshSpaces();
      return space.id;
    },

    refreshSpaces: async () => {
      try {
        const all = await storeContext.getApi()?.db?.listSpaces?.();
        if (!all) return;
        const mapped = (all as any[]).map((s: any) => ({
          id: s.id,
          name: s.name,
          path: s.path,
          archived: Boolean(s.archived),
          parentId: s.parentId ?? null,
          sortOrder: s.sortOrder ?? 0,
          createdAt: s.createdAt ?? 0,
          effectiveArchived: s.effectiveArchived ?? false,
          pathMissing: Boolean(s.pathMissing),
        }));
        set((state) => ({
          spaces: mapped.length ? (mapped as Space[]) : state.spaces,
        }));
      } catch (error) {
        console.error("[refreshSpaces] 读取失败：", error);
      }
    },

    ensureSpaceFromPath: async (
      folderPath,
      name,
      parentId = null,
      options = {},
    ) => {
      const activate = options.activate !== false;
      const normalized = normalizePath(folderPath);
      const spaces = get().spaces;
      const destKey = spacePathKey(normalized);

      // Same physical path: reuse the durable Space. Project flows may reuse it without
      // changing the global home workspace selection.
      const samePath = spaces.find(
        (space) => space.path && spacePathKey(space.path) === destKey,
      );
      if (samePath) {
        if (samePath.archived) await get().restoreSpace(samePath.id);
        set((state) => ({
          spaces: state.spaces.map((item) =>
            item.id === samePath.id ? { ...item, pathMissing: false } : item,
          ),
          ...(activate ? { homeSpaceId: samePath.id } : {}),
        }));
        const persisted = await storeContext.getApi()?.db?.upsertSpace({
          id: samePath.id,
          name: samePath.name,
          path: samePath.path,
        });
        if (persisted && !persisted.ok)
          throw new Error(persisted.error || "目录记录更新失败");
        return { id: samePath.id, created: false };
      }

      const trimmedName = name.trim();
      const existence = new Map<string, boolean>();
      await Promise.all(
        spaces
          .filter((space) => space.path)
          .map(async (space) => {
            const key = spacePathKey(space.path!);
            if (existence.has(key)) return;
            const ok =
              (await storeContext.getApi()?.pathExists?.(space.path!)) ?? true;
            existence.set(key, ok);
          }),
      );
      const remount = findSpaceToRemount(
        spaces,
        normalized,
        trimmedName || normalized.split(/[\\/]/).pop() || normalized,
        (path) => existence.get(spacePathKey(path)) === true,
      );
      if (remount) {
        const written = await applySpacePath(storeContext, remount, normalized);
        if (!written.ok) throw new Error(written.error || "目录重新关联失败");
        if (remount.archived) await get().restoreSpace(remount.id);
        set((state) => ({
          spaces: state.spaces.map((item) =>
            item.id === remount.id
              ? { ...item, path: normalized, pathMissing: false }
              : item,
          ),
          ...(activate ? { homeSpaceId: remount.id } : {}),
        }));
        return { id: remount.id, created: false };
      }

      const base = trimmedName || normalized.split(/[\\/]/).pop() || normalized;
      const space: Space = {
        id: uid(storeContext),
        name: nextAvailableSpaceName(spaces, base, parentId),
        path: normalized,
        parentId,
      };
      set((state) => ({
        spaces: [space, ...state.spaces],
        ...(activate ? { homeSpaceId: space.id } : {}),
      }));
      const result = await storeContext.getApi()?.db?.upsertSpace({
        id: space.id,
        name: space.name,
        path: space.path,
        parentId,
      } as any);
      if (result && !result.ok) {
        set((state) => ({
          spaces: state.spaces.filter((item) => item.id !== space.id),
          ...(activate && state.homeSpaceId === space.id
            ? { homeSpaceId: null }
            : {}),
        }));
        throw new Error(result.error || "项目工作目录保存失败");
      }
      return { id: space.id, created: true };
    },

    addSpaceFromPath: async (folderPath, name, parentId = null) => {
      const result = await get().ensureSpaceFromPath(
        folderPath,
        name,
        parentId,
        { activate: true },
      );
      return result.id;
    },

    relocateSpace: async (id) => {
      const space = get().spaces.find((s) => s.id === id);
      if (!space) return { ok: false, reason: "missing" };
      const folder = await storeContext.getApi()?.pickLocalFolder?.();
      if (!folder) return { ok: false, reason: "cancel" };
      const normalized = normalizePath(folder.path);
      const destKey = spacePathKey(normalized);
      const other = get().spaces.find(
        (s) => s.id !== id && s.path && spacePathKey(s.path) === destKey,
      );
      if (other) {
        return { ok: false, reason: "occupied", otherName: other.name };
      }
      // DB 是 workspace path 的权威源。必须先写成功，再让 Renderer 发布新 path；
      // 否则 TerminalView 会先因 path 变化 reopen，而 main 此时仍解析到旧 cwd。
      const written = await applySpacePath(
        storeContext,
        { ...space, path: normalized },
        normalized,
      );
      if (!written.ok) {
        console.error("[relocateSpace] 写入失败：", written.error);
        return { ok: false, reason: "write" };
      }
      set((s) => ({
        spaces: s.spaces.map((x) =>
          x.id === id ? { ...x, path: normalized, pathMissing: false } : x,
        ),
        homeSpaceId: id,
      }));
      return { ok: true };
    },

    refreshSpacePathStatus: async (id) => {
      const space = get().spaces.find((s) => s.id === id);
      if (!space?.path) return;
      const ok =
        (await storeContext.getApi()?.pathExists?.(space.path)) ?? true;
      const missing = !ok;
      if (missing === Boolean(space.pathMissing)) return;
      set((s) => ({
        spaces: s.spaces.map((x) =>
          x.id === id ? { ...x, pathMissing: missing } : x,
        ),
      }));
    },

    renameSpace: async (id, name) => {
      const trimmed = name.trim();
      if (!trimmed) return false;
      // P1-4 修复：按 parentId 做同级唯一检查（DB 已支持跨父同名，UI 不得全局拦截）
      const target = get().spaces.find((s) => s.id === id);
      const parentId = target?.parentId ?? null;
      const conflict = get().spaces.some(
        (s) =>
          s.id !== id &&
          (s.parentId ?? null) === parentId &&
          s.name.trim().toLowerCase() === trimmed.toLowerCase(),
      );
      if (conflict) return false;
      const result = await storeContext
        .getApi()
        ?.db?.renameSpace?.(id, trimmed);
      if (result && !result.ok) {
        console.error("[renameSpace] 失败：", result.error);
        return false;
      }
      set((s) => ({
        spaces: s.spaces.map((x) =>
          x.id === id ? { ...x, name: trimmed } : x,
        ),
      }));
      return true;
    },
  };
}
