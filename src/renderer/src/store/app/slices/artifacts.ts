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

/**
 * 渲染缓存 LRU（P0）：一条 38 图的会话会把所有 payload 留在 renderer 内存里。
 * 现在图片 payload 只有协议 URL + 尺寸，但 SVG/文本产物仍可能很大，必须封顶。
 * 用 Map 的插入序记录最近使用，超限淘汰最久未用的键。
 */
const ARTIFACT_RENDER_CACHE_LIMIT = 48;
const renderCacheOrder = new Map<string, true>();

export function touchArtifactRenderCache(artifactId: string): void {
  if (renderCacheOrder.has(artifactId)) renderCacheOrder.delete(artifactId);
  renderCacheOrder.set(artifactId, true);
}

export function forgetArtifactRenderCache(artifactId: string): void {
  renderCacheOrder.delete(artifactId);
}

function evictOldestRenderCache(): string[] {
  const evicted: string[] = [];
  while (renderCacheOrder.size > ARTIFACT_RENDER_CACHE_LIMIT) {
    const oldest = renderCacheOrder.keys().next().value;
    if (oldest === undefined) break;
    renderCacheOrder.delete(oldest);
    evicted.push(oldest);
  }
  return evicted;
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

    cacheArtifactRender: (artifactId, payload) => {
      touchArtifactRenderCache(artifactId);
      const evicted = evictOldestRenderCache();
      set((s) => {
        const next = { ...s.artifactRenderCache, [artifactId]: payload };
        for (const id of evicted) delete next[id];
        return { artifactRenderCache: next };
      });
    },
  };
}
