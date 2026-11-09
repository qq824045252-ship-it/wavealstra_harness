import type { Artifact, Task } from "../../types";
import { getTaskDisplayStatus } from "../../utils/taskFilters";
import {
  toRendererArtifact,
  type ArtifactRenderPayload,
} from "../../lib/artifactIngest";
import {
  artifactVisibleForDisplay,
  type ModeArtifactPolicy,
} from "../../../../shared/mode-profile";
import type { ArtifactDescriptor } from "../../../../shared/artifact-types";
import type { AppState } from "./types";

/** Shared empty values stay stable; nonempty selector caches belong to each store. */
const EMPTY_ARTIFACTS: Artifact[] = [];

function sameSidebarTask(previous: Task, current: Task): boolean {
  // Streaming replaces the task object only when the stored projection changed. An untouched
  // task entering the selector again must not re-derive approval/running status from its messages.
  if (previous === current) return true;
  return (
    previous.id === current.id &&
    previous.title === current.title &&
    previous.spaceId === current.spaceId &&
    // 分钟粒度比较：流式/回放事件若仍推进 updatedAt，秒级噪声不该让整个
    // 侧栏任务数组换新引用（会触发全树重渲染，看起来像"一直在加载"）。
    Math.floor(previous.updatedAt / 60_000) ===
      Math.floor(current.updatedAt / 60_000) &&
    previous.status === current.status &&
    previous.archived === current.archived &&
    previous.doneAckedAt === current.doneAckedAt &&
    Boolean(previous.isFavorited) === Boolean(current.isFavorited) &&
    getTaskDisplayStatus(previous) === getTaskDisplayStatus(current)
  );
}

/** Create memoized readers for one store without importing a store singleton. */
export function createAppSelectors() {
  let sidebarTasksCache: Task[] = [];
  let activeArtifactsKey: {
    taskId: string;
    descriptors: ArtifactDescriptor[];
    cache: Record<string, ArtifactRenderPayload>;
  } | null = null;
  let activeArtifactsCache: Artifact[] = EMPTY_ARTIFACTS;
  let visibleArtifactsKey: {
    taskId: string;
    descriptors: ArtifactDescriptor[];
    cache: Record<string, ArtifactRenderPayload>;
    mode: string | undefined;
    policies: Record<string, ModeArtifactPolicy>;
  } | null = null;
  let visibleArtifactsCache: Artifact[] = EMPTY_ARTIFACTS;

  /** Preserve sidebar summaries while only streaming message bodies change. */
  function selectSidebarTasks(state: AppState): Task[] {
    const previousById = new Map(
      sidebarTasksCache.map((task) => [task.id, task]),
    );
    const next = state.tasks.map((task) => {
      const previous = previousById.get(task.id);
      return previous && sameSidebarTask(previous, task) ? previous : task;
    });
    if (
      next.length === sidebarTasksCache.length &&
      next.every((task, index) => task === sidebarTasksCache[index])
    ) {
      return sidebarTasksCache;
    }
    sidebarTasksCache = next;
    return next;
  }

  /** Derive renderer artifacts only when descriptors or render content change. */
  function selectActiveTaskArtifacts(state: AppState): Artifact[] {
    const taskId = state.activeTaskId;
    if (!taskId) return EMPTY_ARTIFACTS;
    const descriptors = state.artifactProjection.artifactsByTask[taskId];
    if (!descriptors || descriptors.length === 0) return EMPTY_ARTIFACTS;
    const key = activeArtifactsKey;
    if (
      key &&
      key.taskId === taskId &&
      key.descriptors === descriptors &&
      key.cache === state.artifactRenderCache
    ) {
      return activeArtifactsCache;
    }
    activeArtifactsKey = {
      taskId,
      descriptors,
      cache: state.artifactRenderCache,
    };
    activeArtifactsCache = descriptors.map((d) =>
      toRendererArtifact(d, state.artifactRenderCache[d.id]),
    );
    return activeArtifactsCache;
  }

  /** Apply display policy without filtering the underlying artifact projection. */
  function selectVisibleActiveTaskArtifacts(state: AppState): Artifact[] {
    const base = selectActiveTaskArtifacts(state);
    if (base === EMPTY_ARTIFACTS || !state.activeTaskId) return base;
    const task = state.activeTaskId
      ? state.tasks.find((t) => t.id === state.activeTaskId)
      : undefined;
    const mode = task?.welcomeMode ?? state.welcomeMode;
    if (mode === "general") return base;
    const policy = mode ? state.artifactPolicies[mode] : undefined;
    const taskId = state.activeTaskId;
    const descriptors = state.artifactProjection.artifactsByTask[taskId];
    const key = visibleArtifactsKey;
    if (
      key &&
      key.taskId === taskId &&
      key.descriptors === descriptors &&
      key.cache === state.artifactRenderCache &&
      key.mode === mode &&
      key.policies === state.artifactPolicies
    ) {
      return visibleArtifactsCache;
    }
    const artifactPaths = base.map((a) => a.path ?? a.name);
    const filtered = base.filter((a) =>
      artifactVisibleForDisplay(a.path ?? a.name, policy, artifactPaths),
    );
    visibleArtifactsKey = {
      taskId,
      descriptors,
      cache: state.artifactRenderCache,
      mode,
      policies: state.artifactPolicies,
    };
    visibleArtifactsCache = filtered;
    return filtered;
  }

  return {
    selectSidebarTasks,
    selectActiveTaskArtifacts,
    selectVisibleActiveTaskArtifacts,
  };
}

/** Cross-task descriptor lookup used by historical artifact and render readers. */
export function findDescriptorByIdAnyTask(
  state: AppState,
  artifactId: string | null,
): ArtifactDescriptor | null {
  if (!artifactId) return null;
  for (const descriptors of Object.values(
    state.artifactProjection.artifactsByTask,
  )) {
    const d = descriptors.find((x) => x.id === artifactId);
    if (d) return d;
  }
  return null;
}

/** Read the active task's artifact directly from projection and render cache. */
export function findActiveTaskArtifact(
  state: AppState,
  id: string | null,
): Artifact | undefined {
  if (!id || !state.activeTaskId) return undefined;
  const descriptors =
    state.artifactProjection.artifactsByTask[state.activeTaskId];
  if (!descriptors) return undefined;
  const descriptor = descriptors.find((d) => d.id === id);
  if (!descriptor) return undefined;
  return toRendererArtifact(
    descriptor,
    state.artifactRenderCache[descriptor.id],
  );
}

export function currentTerminalOwnerKey(s: {
  page?: string;
  activeTaskId?: string | null;
  activeWorkspaceId?: string | null;
}): string {
  if (s.page === "workspace" && s.activeWorkspaceId) {
    return `ws:${s.activeWorkspaceId}`;
  }
  if (s.activeTaskId) {
    return `task:${s.activeTaskId}`;
  }
  if (s.activeWorkspaceId) {
    return `ws:${s.activeWorkspaceId}`;
  }
  return "default";
}
