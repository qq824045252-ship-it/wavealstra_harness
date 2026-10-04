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
}

export interface WorkspaceLibraryBindingInheritedItem extends WorkspaceLibraryBindingItem {
  sourceWorkspaceId: string;
  sourceWorkspaceName: string | null;
}

export interface WorkspaceLibraryBindingListView {
  workspaceId: string;
  workspaceName: string | null;
  direct: WorkspaceLibraryBindingItem[];
  inherited: WorkspaceLibraryBindingInheritedItem[];
  addable: WorkspaceLibraryBindingItem[];
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
