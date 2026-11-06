import { createRenderHydration } from "../../../lib/renderHydration";
import type { RenderHydration } from "../../../lib/renderHydration";
import type { AppActions } from "../actions";
import type { AppContext } from "../context";
import { findDescriptorByIdAnyTask } from "../selectors";
import { forgetArtifactRenderCache, touchArtifactRenderCache } from "../slices/artifacts";

export function getRenderHydration(storeContext: AppContext): RenderHydration {
  const { get, set } = storeContext;
  if (storeContext.runtime.renderHydration)
    return storeContext.runtime.renderHydration;
  storeContext.runtime.renderHydration = createRenderHydration({
    findDescriptor: (artifactId) =>
      findDescriptorByIdAnyTask(get(), artifactId),
    getCache: (artifactId) => {
      const payload = get().artifactRenderCache[artifactId];
      if (payload) touchArtifactRenderCache(artifactId);
      return payload;
    },
    setCache: (artifactId, payload) =>
      get().cacheArtifactRender(artifactId, payload),
    removeCache: (artifactId) => {
      forgetArtifactRenderCache(artifactId);
      set((s) => {
        if (!(artifactId in s.artifactRenderCache)) return s;
        const next = { ...s.artifactRenderCache };
        delete next[artifactId];
        return { artifactRenderCache: next };
      });
    },
    setLoadState: (artifactId, state, error) => {
      set((s) => ({
        artifactRenderLoadState: {
          ...s.artifactRenderLoadState,
          [artifactId]: state,
        },
        artifactRenderErrors: {
          ...s.artifactRenderErrors,
          [artifactId]: error,
        },
      }));
    },
    clearState: (artifactId) => {
      set((s) => {
        const loads = { ...s.artifactRenderLoadState };
        const errors = { ...s.artifactRenderErrors };
        delete loads[artifactId];
        delete errors[artifactId];
        return { artifactRenderLoadState: loads, artifactRenderErrors: errors };
      });
    },
    readContent: async (artifactId) => {
      const api = storeContext.getApi()?.artifactDomain;
      if (!api?.readContent) return null;
      return api.readContent({ artifactId });
    },
  });
  return storeContext.runtime.renderHydration;
}

export function createArtifactRenderActions(
  storeContext: AppContext,
): Pick<AppActions, "ensureArtifactRenderPayload" | "releaseArtifactRender"> {
  return {
    ensureArtifactRenderPayload: (artifactId) =>
      getRenderHydration(storeContext).ensure(artifactId),
    /** 离开视口回收（P0）：复用 renderHydration.clear 的 cache/state 清理能力 */
    releaseArtifactRender: (artifactId) =>
      getRenderHydration(storeContext).clear(artifactId),
  };
}
