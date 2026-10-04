/**
 * Artifact Projection Reducer — V3.5 Wave 3A（§20/§23/§25）
 *
 * Renderer Artifact projection 的唯一写入口（纯函数，可单测）。
 * Renderer 其他地方不得直接 push/splice/replace projection。
 *
 * 竞态规则（3A.4，task-level revision guard）：
 * - snapshot 与 created/updated/removed 事件都携带 task revision；
 *   incoming revision > current 才 apply（stale 忽略）
 * - snapshot 被拒（落后于已 apply 的增量事件）→ 调用方应重新 hydrate（幂等收敛）
 * - 未加载（unloaded / 未记录）task 的增量事件忽略 —— 下次 hydrate 全量补齐
 * - created 幂等 append（同 id 不重复）；updated 按 id replace 不改变 FIFO 位置；
 *   removed 按 id 删除、其余顺序保持
 *
 * 与 ArtifactRepository 的边界：projection 可丢弃、可重新 hydrate；
 * Repository 不可由 Renderer 反向覆盖。
 */
import type {
  ArtifactCreatedEvent,
  ArtifactDescriptor,
  ArtifactLoadState,
  ArtifactRemovedEvent,
  ArtifactSnapshot,
  ArtifactUpdatedEvent,
} from "./artifact-types";

export interface ArtifactProjection {
  /** task → ArtifactDescriptor[]（稳定 FIFO，创建序） */
  artifactsByTask: Record<string, ArtifactDescriptor[]>;
  /** task → 已应用的 revision（stale-race guard） */
  artifactRevisions: Record<string, number>;
  /** task → load state（unloaded/loading/ready/error，按 taskId 维护，§25） */
  artifactLoadState: Record<string, ArtifactLoadState>;
}

export type ArtifactProjectionAction =
  | { type: "snapshot"; snapshot: ArtifactSnapshot }
  | { type: "created"; event: ArtifactCreatedEvent }
  | { type: "updated"; event: ArtifactUpdatedEvent }
  | { type: "removed"; event: ArtifactRemovedEvent }
  | { type: "setLoadState"; taskId: string; state: ArtifactLoadState }
  | { type: "clearTask"; taskId: string };

export function createInitialArtifactProjection(): ArtifactProjection {
  return { artifactsByTask: {}, artifactRevisions: {}, artifactLoadState: {} };
}

/** 当前已应用 revision（无记录 = -1，任何 incoming 都更新） */
function currentRevision(state: ArtifactProjection, taskId: string): number {
  return state.artifactRevisions[taskId] ?? -1;
}

/**
 * snapshot 是否应被接受：incoming >= current（同 revision 的 snapshot 是全量真相，幂等 replace 无害；
 * 增量事件则必须 > current，见 applyArtifactEvent）。
 */
export function isSnapshotAccepted(state: ArtifactProjection, snapshot: ArtifactSnapshot): boolean {
  return snapshot.revision >= currentRevision(state, snapshot.taskId);
}

/**
 * 应用 snapshot。返回 { state, applied }：
 * applied=false 表示 snapshot 落后于已应用事件 → 调用方应重新 hydrate（幂等收敛）。
 */
export function applyArtifactSnapshot(
  state: ArtifactProjection,
  snapshot: ArtifactSnapshot,
): { state: ArtifactProjection; applied: boolean } {
  const taskId = snapshot.taskId;
  if (!isSnapshotAccepted(state, snapshot)) return { state, applied: false };
  return {
    state: {
      ...state,
      artifactsByTask: { ...state.artifactsByTask, [taskId]: snapshot.artifacts },
      artifactRevisions: { ...state.artifactRevisions, [taskId]: snapshot.revision },
      artifactLoadState: {
        ...state.artifactLoadState,
        [taskId]: snapshot.state === "error" ? "error" : "ready",
      },
    },
    applied: true,
  };
}

/**
 * 增量事件统一入口（created/updated/removed）。
 * 规则：task 已加载（loadState 存在且非 unloaded）且 revision 前进 → apply；否则忽略。
 */
export function applyArtifactEvent(
  state: ArtifactProjection,
  action: Extract<ArtifactProjectionAction, { type: "created" | "updated" | "removed" }>,
): ArtifactProjection {
  const taskId = action.event.taskId;
  const loadState = state.artifactLoadState[taskId];
  // 未加载的 task：事件忽略（下次 hydrate 全量补齐）
  if (loadState === undefined || loadState === "unloaded") return state;
  const rev = currentRevision(state, taskId);
  // removed 允许同 revision（3B.6：task 批量删除广播多个同 rev removed；按 id 删除幂等无害）。
  // created/updated 必须 > current（防重放双份）。
  const stale =
    action.type === "removed" ? action.event.revision < rev : action.event.revision <= rev;
  if (stale) return state;
  const nextRevision = { ...state.artifactRevisions, [taskId]: action.event.revision };

  const artifacts = state.artifactsByTask[taskId] ?? [];
  let nextArtifacts: ArtifactDescriptor[];
  if (action.type === "created") {
    // 幂等 append：同 id 不重复
    nextArtifacts = artifacts.some((a) => a.id === action.event.artifactId)
      ? artifacts
      : [...artifacts, action.event.descriptor];
  } else if (action.type === "updated") {
    // replace 不换位；id 不在列表则忽略（异常路径，不 append 避免双份）
    const idx = artifacts.findIndex((a) => a.id === action.event.artifactId);
    nextArtifacts =
      idx === -1 ? artifacts : artifacts.map((a, i) => (i === idx ? action.event.descriptor : a));
  } else {
    // removed：按 id 删除，其余顺序保持
    nextArtifacts = artifacts.filter((a) => a.id !== action.event.artifactId);
  }

  return {
    ...state,
    artifactsByTask: { ...state.artifactsByTask, [taskId]: nextArtifacts },
    artifactRevisions: nextRevision,
  };
}

/** 统一入口：所有 projection 写操作都走这里（唯一写入口 Gate） */
export function reduceArtifactProjection(
  state: ArtifactProjection,
  action: ArtifactProjectionAction,
): ArtifactProjection {
  switch (action.type) {
    case "snapshot":
      return applyArtifactSnapshot(state, action.snapshot).state;
    case "created":
    case "updated":
    case "removed":
      return applyArtifactEvent(state, action);
    case "setLoadState":
      return {
        ...state,
        artifactLoadState: { ...state.artifactLoadState, [action.taskId]: action.state },
      };
    case "clearTask": {
      const byTask = { ...state.artifactsByTask };
      const revisions = { ...state.artifactRevisions };
      const loadStates = { ...state.artifactLoadState };
      delete byTask[action.taskId];
      delete revisions[action.taskId];
      delete loadStates[action.taskId];
      return { artifactsByTask: byTask, artifactRevisions: revisions, artifactLoadState: loadStates };
    }
  }
}
