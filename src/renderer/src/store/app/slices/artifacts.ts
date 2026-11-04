import { createInitialArtifactProjection } from "../../../../../shared/artifact-projection";
import type { ArtifactProjection } from "../../../../../shared/artifact-projection";
import type { ModeArtifactPolicy } from "../../../../../shared/mode-profile";
import type { ArtifactRenderPayload } from "../../../lib/artifactIngest";
import type { ArtifactRenderLoadState } from "../../../lib/renderHydration";
import type { WelcomeMode } from "../../../types";
import type { AppActions } from "../actions";
import type { AppContext } from "../context";

export interface ArtifactsState {
  artifactProjection: ArtifactProjection;
  artifactPolicies: Partial<Record<WelcomeMode, ModeArtifactPolicy>>;
  artifactRenderCache: Record<string, ArtifactRenderPayload>;
  artifactRenderLoadState: Record<string, ArtifactRenderLoadState>;
  artifactRenderErrors: Record<string, string | undefined>;
}

export function createArtifactsState(): ArtifactsState {
  return {
    artifactProjection: createInitialArtifactProjection(),
    artifactPolicies: {},
    artifactRenderCache: {},
    artifactRenderLoadState: {},
    artifactRenderErrors: {},
  };
}

export function createArtifactsActions(
  storeContext: AppContext,
): Pick<AppActions, "refreshArtifactPolicy" | "cacheArtifactRender"> {
  const { get, set } = storeContext;
  return {
    refreshArtifactPolicy: async (mode) => {
      try {
        const profile = await storeContext
          .getApi()
          ?.agent?.getModeProfile?.(mode);
        if (!profile) return;
        set((s) => ({
          artifactPolicies: {
            ...s.artifactPolicies,
            [mode]: profile.policy.artifactPolicy,
          },
        }));
      } catch (error) {
        console.warn("[appStore] refreshArtifactPolicy failed", mode, error);
      }
    },

    cacheArtifactRender: (artifactId, payload) =>
      set((s) => ({
        artifactRenderCache: {
          ...s.artifactRenderCache,
          [artifactId]: payload,
        },
      })),
  };
}
