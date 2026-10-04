/**
 * Artifact Domain IPC 契约 — V3.5 Wave 2 冻结版（§6/§20）
 *
 * 与 Native Surface 命令（ArtifactIpc: preview/setRect/reload/hide/show/close）
 * 完全分离：Domain 管"数据从哪来、谁是真相"，Surface 管"视图在哪里、何时显示"。
 *
 * 本文件只定义契约；通道注册在 Wave 3 接入 main 时完成。
 * Renderer Artifact projection 唯一写入源 = snapshot + created/updated/removed 事件（§20）。
 */
import type {
  ArtifactDescriptor,
  ArtifactLoadState,
  ArtifactSnapshot,
  ArtifactUpdatedEvent,
  ArtifactRemovedEvent,
  ArtifactCreatedEvent,
} from "./artifact-types";

export const ArtifactDomainIpc = {
  /** renderer → main：取单个 artifact（registry 优先，miss 回源 repository） */
  get: "artifact-domain:get",
  /** renderer → main：取 task 的 artifact 列表（lazy hydrate 入口） */
  list: "artifact-domain:list",
  /** renderer → main：取 task 快照（含 load state，§25；首次触发 legacy migration） */
  snapshot: "artifact-domain:snapshot",
  /** renderer → main：注册新 artifact（3C：Artifact create 唯一通道） */
  register: "artifact-domain:register",
  /** renderer → main：读取 artifact 内容（managed→storage；workspace-file→fs+root 边界） */
  readContent: "artifact-domain:readContent",
  /** renderer → main：删除 task 的全部 artifact（task 生命周期，§3B.6） */
  removeTask: "artifact-domain:removeTask",
  /** renderer → main：删除单个 artifact（产物列/文件树删除） */
  remove: "artifact-domain:remove",
  /** main → renderer：artifact 创建事件 */
  created: "artifact-domain:created",
  /** main → renderer：artifact 内容/版本变化事件（version++ 后推送，§70） */
  updated: "artifact-domain:updated",
  /** main → renderer：artifact 移除事件 */
  removed: "artifact-domain:removed",
} as const;

/** artifact-domain:get 请求 */
export interface ArtifactDomainGetRequest {
  taskId: string;
  artifactId: string;
}

/** artifact-domain:list / snapshot / removeTask 请求 */
export interface ArtifactDomainTaskRequest {
  taskId: string;
}

/** artifact-domain:remove 请求 */
export interface ArtifactDomainRemoveRequest {
  artifactId: string;
}

/** artifact-domain:register 请求 = ArtifactRegistration（含 content/workspaceFile 二选一） */
export type ArtifactDomainRegisterRequest = import("./artifact-types").ArtifactRegistration;

/** artifact-domain:readContent 请求 */
export interface ArtifactDomainReadContentRequest {
  artifactId: string;
}

/** artifact-domain:readContent 响应 */
export interface ArtifactDomainReadContentResponse {
  content: string;
  language?: string;
  /** 原始 kind（docx/xlsx/pptx/image/pdf 等细分） */
  kind?: string;
  path?: string;
}

/** artifact-domain:get 响应 */
export interface ArtifactDomainGetResponse {
  artifact: ArtifactDescriptor | null;
}

/** artifact-domain:list 响应 */
export interface ArtifactDomainListResponse {
  artifacts: ArtifactDescriptor[];
  state: ArtifactLoadState;
}

export type ArtifactDomainSnapshotResponse = ArtifactSnapshot;

/** 事件 payload（main → renderer，走 webContents.send） */
export type ArtifactDomainEvent =
  | { type: "created"; payload: ArtifactCreatedEvent }
  | { type: "updated"; payload: ArtifactUpdatedEvent }
  | { type: "removed"; payload: ArtifactRemovedEvent };
