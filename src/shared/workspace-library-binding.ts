/**
 * Workspace ↔ Library binding — Shared Types
 *
 * 绑定目标支持两级：
 * - Library Space：整个资料库空间；
 * - Library Collection：资料库中的文件夹（包含其全部子文件夹）。
 *
 * Workspace 继承仍由 Current + Ancestors 自然产生，不额外持久化 inherit 字段。
 * Permission 与 Binding 分离：绑定只决定候选范围，最终读取仍需通过资料库权限过滤。
 */
import type { LibrarySpaceKind } from "./library-ipc";

export const WorkspaceLibraryBindingIpc = {
  list: "workspace:libraryBindings:list",
  bind: "workspace:libraryBindings:bind",
  unbind: "workspace:libraryBindings:unbind",
  createFolder: "workspace:libraryBindings:createFolder",
} as const;

export type WorkspaceLibraryBindingTargetType = "space" | "collection";

/** 旧的 Space 绑定持久化 DTO（兼容 Blueprint/现有调用） */
export interface WorkspaceLibraryBindingDto {
  workspaceId: string;
  librarySpaceId: string;
  createdAt: number;
}

/** UI/IPC 展示目标：整个资料库，或资料库内的文件夹。 */
export interface WorkspaceLibraryBindingItem {
  targetType: WorkspaceLibraryBindingTargetType;
  librarySpaceId: string;
  collectionId?: string;
  name: string;
  /** 文件夹路径，例如「我的文档 / 公共知识 / 规范」 */
  path?: string;
  kind: LibrarySpaceKind;
  projectId?: string;
  /** 来源工作空间；无此字段且无 projectId 的旧资料仍可从个人资料管理。 */
  workspaceId?: string;
}

export interface WorkspaceLibraryBindingInheritedItem extends WorkspaceLibraryBindingItem {
  sourceWorkspaceId: string;
  sourceWorkspaceName: string | null;
}

export interface WorkspaceLibraryBindingListView {
  workspaceId: string;
  workspaceName: string | null;
  /** 当前工作空间真正拥有的资料位置，无需再绑定。 */
  owned: WorkspaceLibraryBindingItem[];
  ownedItemCount: number;
  direct: WorkspaceLibraryBindingItem[];
  inherited: WorkspaceLibraryBindingInheritedItem[];
  addable: WorkspaceLibraryBindingItem[];
  libraryStoragePath?: string;
  destinations?: Array<{ id: string; name: string }>;
}

/** collectionId 缺省 = 绑定整个 Library Space；存在 = 只绑定该文件夹及其子树。 */
export interface WorkspaceLibraryBindingRequest {
  workspaceId: string;
  librarySpaceId: string;
  collectionId?: string;
}

export type WorkspaceLibraryBindingMutationResult =
  | { ok: true }
  | { ok: false; error: string };
