import {
  applyArtifactSnapshot,
  reduceArtifactProjection,
} from "../../../../../shared/artifact-projection";
import type { ArtifactSnapshot } from "../../../../../shared/artifact-types";
import { reconcileMessagesArtifactIds } from "../../../lib/messageArtifactReconcile";
import type { AppActions } from "../actions";
import type { AppContext } from "../context";
import { getRenderHydration } from "./artifactRender";

export function createArtifactProjectionActions(
  storeContext: AppContext,
): Pick<
  AppActions,
  | "hydrateArtifacts"
  | "reconcileTaskMessageArtifacts"
  | "applyArtifactSnapshot"
  | "applyArtifactCreated"
  | "applyArtifactUpdated"
  | "applyArtifactRemoved"
  | "clearArtifactTask"
> {
  const { get, set } = storeContext;
  return {
    hydrateArtifacts: async (taskId) => {
      const api = storeContext.getApi()?.artifactDomain;
      if (!api) return;
      const p = get().artifactProjection;
      // 防重入 + lazy 语义：loading 中不并发拉；ready 靠常驻事件订阅增量更新，不重复 IPC
      if (
        p.artifactLoadState[taskId] === "loading" ||
        p.artifactLoadState[taskId] === "ready"
      )
        return;
      set((s) => ({
        artifactProjection: reduceArtifactProjection(s.artifactProjection, {
          type: "setLoadState",
          taskId,
          state: "loading",
        }),
      }));
      let attempts = 0;
      while (attempts < 3) {
        let snap: ArtifactSnapshot;
        try {
          snap = await api.snapshot({ taskId });
        } catch {
          set((s) => ({
            artifactProjection: reduceArtifactProjection(s.artifactProjection, {
              type: "setLoadState",
              taskId,
              state: "error",
            }),
          }));
          return;
        }
        const { applied } = applyArtifactSnapshot(
          get().artifactProjection,
          snap,
        );
        if (applied) {
          set((s) => {
            const artifactProjection = reduceArtifactProjection(
              s.artifactProjection,
              {
                type: "snapshot",
                snapshot: snap,
              },
            );
            const firstArtifactId = snap.artifacts[0]?.id ?? null;
            const shouldRestoreFirstTab =
              s.activeTaskId === taskId &&
              s.artifactTabs.length === 0 &&
              s.activeArtifactId === null &&
              firstArtifactId !== null;
            return {
              artifactProjection,
              ...(shouldRestoreFirstTab
                ? {
                    artifactTabs: [firstArtifactId],
                    activeArtifactId: firstArtifactId,
                  }
                : {}),
            };
          });
          // Domain 就绪后：把历史消息上的 hist-art 伪 id / 线索对账成真实 Domain id
          get().reconcileTaskMessageArtifacts(taskId);
          return;
        }
        // snapshot 落后于已 apply 的增量事件 → 重拉（幂等收敛，3A.4）
        attempts += 1;
      }
      set((s) => ({
        artifactProjection: reduceArtifactProjection(s.artifactProjection, {
          type: "setLoadState",
          taskId,
          state: "error",
        }),
      }));
    },

    reconcileTaskMessageArtifacts: (taskId) => {
      if (!taskId) return;
      const state = get();
      const descriptors = state.artifactProjection.artifactsByTask[taskId];
      if (!descriptors?.length) return;
      let changed = false;
      const tasks = state.tasks.map((t) => {
        if (t.id !== taskId || !t.messages.length) return t;
        const messages = reconcileMessagesArtifactIds(
          t.messages,
          descriptors,
          taskId,
        );
        if (messages === t.messages) return t;
        changed = true;
        return { ...t, messages };
      });
      // A rebuilt `tasks` array notifies every subscriber, so an unchanged association must
      // return before publishing: only a real Task replacement may reach the store.
      if (!changed) return;
      set({ tasks });
    },

    applyArtifactSnapshot: (snapshot) => {
      set((s) => ({
        artifactProjection: reduceArtifactProjection(s.artifactProjection, {
          type: "snapshot",
          snapshot,
        }),
      }));
    },

    applyArtifactCreated: (event) => {
      set((s) => ({
        artifactProjection: reduceArtifactProjection(s.artifactProjection, {
          type: "created",
          event,
        }),
      }));
    },

    applyArtifactUpdated: (event) => {
      set((s) => ({
        artifactProjection: reduceArtifactProjection(s.artifactProjection, {
          type: "updated",
          event,
        }),
      }));
      // V3.5 hotfix §10：cache 与 artifactVersion 绑定；内容版本移动 → 旧缓存失效
      getRenderHydration(storeContext).invalidate(
        event.artifactId,
        event.version,
      );
      // 当前打开的 artifact 自动重新 hydration（短暂 loading / 旧帧保持由 UI 层决定）
      if (get().activeArtifactId === event.artifactId) {
        void getRenderHydration(storeContext).ensure(event.artifactId);
      }
    },

    applyArtifactRemoved: (event) => {
      set((s) => ({
        artifactProjection: reduceArtifactProjection(s.artifactProjection, {
          type: "removed",
          event,
        }),
      }));
      // V3.5 hotfix §11：removed → cache/loadState/error 全清；in-flight 结果由 stale guard 丢弃
      getRenderHydration(storeContext).clear(event.artifactId);
      get().closeArtifactTab(event.artifactId);
    },

    clearArtifactTask: (taskId) => {
      set((s) => ({
        artifactProjection: reduceArtifactProjection(s.artifactProjection, {
          type: "clearTask",
          taskId,
        }),
      }));
    },
  };
}
