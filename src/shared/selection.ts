/**
 * Selection 契约 — V3.5 Wave 4D（§80）
 *
 * SelectionStore = Selection 唯一真相源（active / stale / empty）。
 * stale 语义（4D 锁死）：
 * - artifactVersion 改变 → stale（保留 descriptor，不自动删除——UI 可提示
 *   “选择来自旧版本，页面已变化”，比直接清空更可解释）
 * - surfaceGeneration 改变 → stale（覆盖 reload/navigation/新 preview/WCV 替换；
 *   backendNodeId 只在原 CDP/session/generation 内可信）
 * - artifactId 与当前 surface 不一致 → stale(artifact-changed)（不 clear——
 *   切回来可恢复上下文；除非原 artifact 被删除才 clear）
 * - surface 关闭 → stale(surface-closed)
 * - Capture Mode 退出本身不清 selection（4E PromptContext 消费入口）
 */

import type { SelectionDescriptor } from "./capture-mode";

/**
 * 用户明确「加入聊天」的抓取元素引用（结构化引用，不携带 DOM/整页内容）：
 * 发送时由主进程 PromptContextService 从同一 surface 的可信抓取记录中解析；
 * 页面已更新或记录已清除时不注入 selection。
 */
export interface ChatSelectionRef {
  /** 用户对该元素的备注，与 DOM 描述分开传递。 */
  comment?: string;
  artifactId: string;
  artifactVersion: number;
  surfaceGeneration: number;
  /**
   * 元素级身份（4D canonical identity）：同页内区分不同元素；
   * 非 CDP 源/缺省时退化为三键指纹（同页换元素将视为同一引用，见 selectionFingerprintMatches）。
   */
  backendNodeId?: number;
}

export const SELECTION_COMMENT_MAX_LENGTH = 2000;

export function normalizeSelectionComment(value: unknown): string | undefined {
  return typeof value === "string"
    ? value.trim().slice(0, SELECTION_COMMENT_MAX_LENGTH) || undefined
    : undefined;
}

/**
 * 指纹一致性：descriptor 是否仍是该引用指向的元素。
 * - 三键（artifactId/artifactVersion/surfaceGeneration）必等；
 * - 双方都有 backendNodeId 时必等（同页内换元素 → 不匹配）；
 * - 任一侧缺 backendNodeId → 退化为三键比对。
 * 用于：发送时主进程校验（PromptContextService.collectForChat）与
 * renderer 侧抓取引用去重。
 */
export function selectionFingerprintMatches(
  d: SelectionDescriptor,
  ref: ChatSelectionRef,
): boolean {
  if (
    d.artifactId !== ref.artifactId ||
    d.artifactVersion !== ref.artifactVersion ||
    d.surfaceGeneration !== ref.surfaceGeneration
  ) {
    return false;
  }
  return d.backendNodeId === ref.backendNodeId;
}

export type SelectionStatus = "empty" | "active" | "stale";

export type SelectionStaleReason =
  | "artifact-version-changed"
  | "surface-generation-changed"
  | "artifact-changed"
  | "surface-closed";

export interface SelectionState {
  descriptor: SelectionDescriptor | null;
  status: SelectionStatus;
  staleReason?: SelectionStaleReason;
  updatedAt: number;
}

export const EMPTY_SELECTION: SelectionState = {
  descriptor: null,
  status: "empty",
  updatedAt: 0,
};

export const SelectionIpc = {
  /** renderer → main：当前 Selection 快照 */
  get: "selection:get",
  /** renderer → main：清除 selection（UI [清除] 按钮） */
  clear: "selection:clear",
  comment: "selection:comment",
} as const;

/** main → renderer：Selection 状态变化（快照即投影） */
export const SelectionEvent = {
  changed: "selection:changed",
  attach: "selection:attach",
} as const;

export interface SelectionAttachEvent {
  selection: ChatSelectionRef;
  comment?: string;
}

export interface SelectionChangedEvent {
  state: SelectionState;
}
