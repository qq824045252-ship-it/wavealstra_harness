/**
 * Artifact Domain 类型 — V3.5 Wave 2 冻结版（§3/§4/§25/§68/§70）
 *
 * 约束：
 * - ArtifactDescriptor.taskId 必须存在（§3）
 * - ArtifactSource 不允许长期 content:string（§4）；纯内存 content 只存在于
 *   注册输入 ArtifactRegistration，materialize 后不留在 descriptor
 * - 唯一持久真相 = ArtifactRepository；Registry/Store 都是可重建的 cache
 */

export type ArtifactKind = "markdown" | "code" | "html" | "svg" | "image" | "video" | "audio" | "pdf" | "office" | "cad";

/** 正式 Artifact 来源（V3.5 §4 最终推荐；不把纯内存 content 作为长期 source） */
export type ArtifactSource =
  | {
      type: "workspace-file";
      entryFile: string;
      rootDir: string;
    }
  | {
      type: "managed-content";
      /** 相对 ArtifactStorage root 的路径（<taskId>/<artifactId>/<file>） */
      storagePath: string;
      rootDir: string;
    };

/** 能力位（版本能力声明；具体字段按 kind 扩展，保持兼容） */
export type ArtifactCapabilities = Record<string, unknown>;

/** 消息 ↔ Artifact 关系（P1 溯源；createdBy* 仅首次，后续历史走 refs） */
export type ArtifactMessageRelation = "created" | "updated" | "referenced";

/** Artifact 持久元数据真相（V3.5 §3） */
export interface ArtifactDescriptor {
  id: string;
  taskId: string;
  spaceId?: string;

  kind: ArtifactKind;
  source: ArtifactSource;

  /** 内容版本；内容变化必须 version++（§68），由 Repository transaction 持久化 */
  version: number;
  capabilities: ArtifactCapabilities;

  title?: string;
  mimeType?: string;

  /**
   * 首次创建者消息/工具（P1 §14）。
   * 写入后不可变；历史行保持 undefined/NULL，不伪造来源。
   */
  createdByMessageId?: string;
  createdByToolCallId?: string;

  createdAt: number;
  updatedAt: number;
}

/** 消息级 Artifact 引用（task-scoped；跨 task 不可凭 artifactId 读取） */
export interface ArtifactMessageRef {
  taskId: string;
  messageId: string;
  artifactId: string;
  relation: ArtifactMessageRelation;
  toolCallId?: string;
  createdAt: number;
}

/** 多文件 Artifact 显式依赖（P1 §15；必须位于同一 taskRoot） */
export interface ArtifactFileDependency {
  artifactId: string;
  filePath: string;
  dependencyKind: string;
  createdAt: number;
}

/** 注册输入（唯一允许携带 raw content 的地方；持久化后不保留 content） */
export interface ArtifactRegistration {
  /** 可选：显式 artifact ID。重复注册 → 冲突抛错（register 不做 upsert，§W2.2②） */
  id?: string;
  taskId: string;
  spaceId?: string;
  kind: ArtifactKind;
  title?: string;
  mimeType?: string;
  /** 初始能力声明（3C：canvas 类产物 = html + executable/interactive；originalKind 保留旧细分） */
  capabilities?: ArtifactCapabilities;

  /** workspace 文件来源：entryFile 相对 rootDir 或绝对路径 */
  workspaceFile?: { entryFile: string; rootDir: string };
  /** 纯内存内容：materialize 为 managed-content 后落盘 */
  content?: string;

  /** P1：生产者消息/工具（写入 createdBy* + relation=created 的 message ref） */
  producerMessageId?: string;
  producerToolCallId?: string;
}

/** Renderer hydration state（§25），按 taskId 维护 */
export type ArtifactLoadState = "unloaded" | "loading" | "ready" | "error";

/**
 * task 级 artifact 集合版本（§W2.2③ 与 3A 前置决策）：
 * - ArtifactDescriptor.version = 单个 Artifact 内容版本
 * - task revision = 某 task 的 Artifact 集合/事件序列版本（单调递增，重启后持久）
 * snapshot 与 created/updated/removed 事件都携带；Renderer 用 revision guard 处理 stale-race。
 */

export interface ArtifactUpdatedEvent {
  artifactId: string;
  taskId: string;
  version: number;
  /** task 级事件序列号（应用 guard 用） */
  revision: number;
  /** 更新后的完整 descriptor（Renderer 无需额外 get()） */
  descriptor: ArtifactDescriptor;
}

export interface ArtifactRemovedEvent {
  artifactId: string;
  taskId: string;
  /** task 级事件序列号 */
  revision: number;
}

export interface ArtifactCreatedEvent {
  artifactId: string;
  taskId: string;
  version: number;
  /** task 级事件序列号 */
  revision: number;
  /** 创建后的完整 descriptor */
  descriptor: ArtifactDescriptor;
}

/** task 级快照（Renderer Store 唯一写入源之一，§20/§23） */
export interface ArtifactSnapshot {
  taskId: string;
  artifacts: ArtifactDescriptor[];
  /** 快照生成时刻的 task revision（stale-race guard） */
  revision: number;
  state: ArtifactLoadState;
  error?: string;
}

/** Refresh 输入（V3.5 §68；现有 AgentService.emitChangedArtifacts 的升级形态） */
export interface WorkspaceChangedEvent {
  taskId: string;
  cwd: string;
  changedFiles: string[];
  /**
   * P1：回合末 snapshot / 精确刷新时可带 messageId，用于写入 relation=updated 的 ref。
   * toolCallId 可空（snapshot 无 tool 上下文）。
   */
  messageId?: string;
  toolCallId?: string;
}
