/**
 * WorkspaceLibraryBindingService
 *
 * Workspace 可绑定：
 * - 整个 Library Space（workspace_library_links）
 * - Library Collection 文件夹（workspace_library_collection_links，作用域含子树）
 *
 * 本服务只维护持久关联和 scope 映射；Permission / Retrieval / Prompt 由上层负责。
 */
import type { AppDatabase } from "../db/AppDatabase";
import type { WorkspaceLibraryBindingRequest } from "../../shared/workspace-library-binding";

export interface RuntimeWorkspaceBindingMutation {
  kind: "bind" | "unbind";
  workspaceId: string;
  librarySpaceId: string;
  collectionId?: string;
  at: number;
}

export interface WorkspaceLibraryCollectionBinding {
  librarySpaceId: string;
  collectionId: string;
}

export interface ResolvedWorkspaceLibraryBindings {
  librarySpaceIds: string[];
  collections: WorkspaceLibraryCollectionBinding[];
}

export class WorkspaceLibraryBindingService {
  constructor(private readonly db: AppDatabase) {}

  async writeTarget(kind: RuntimeWorkspaceBindingMutation["kind"], request: WorkspaceLibraryBindingRequest): Promise<void> {
    const workspaceId = request.workspaceId?.trim();
    const librarySpaceId = request.librarySpaceId?.trim();
    const collectionId = request.collectionId?.trim() || undefined;
    if (!workspaceId) throw new Error("工作空间不能为空");
    if (!librarySpaceId) throw new Error("资料库空间不能为空");
    const mutation = { kind, workspaceId, librarySpaceId, collectionId, at: Date.now() };
    const worker = this.db.runtimeAuditReader;
    const rustRequired = this.db.readonly;
    if (!worker || this.db.inTransaction) {
      if (rustRequired) throw new Error("工作空间资料关联需要通过 Rust 核心执行");
      return this.writeTargetOnHost(mutation);
    }
    const result = await worker.writeWorkspaceBinding(mutation);
    if (result?.status === "saved") return;
    if (result?.status === "needsHost" && !rustRequired) return this.writeTargetOnHost(mutation);
    if (result?.status === "rejected") throw new Error(result.message);
    throw new Error("未收到资料关联保存确认，请刷新后查看状态");
  }

  private writeTargetOnHost({ kind, workspaceId, librarySpaceId, collectionId }: RuntimeWorkspaceBindingMutation): void {
    const connection = this.db.connection;
    connection.transaction(() => {
      const workspace = this.db.getSpace(workspaceId);
      if (!workspace) throw new Error("工作空间不存在");
      if (workspace.archived || workspace.effectiveArchived) throw new Error("归档工作空间只可读取资料");
      if (kind === "bind") {
        if (!connection.prepare("SELECT 1 FROM library_spaces WHERE id=?").get(librarySpaceId)) throw new Error("资料库空间不存在");
        if (collectionId) {
          if (!connection.prepare("SELECT 1 FROM library_collections WHERE id=? AND space_id=?").get(collectionId, librarySpaceId)) {
            throw new Error("资料库文件夹不存在或不属于该资料库");
          }
          this.bindCollection(workspaceId, librarySpaceId, collectionId);
        } else this.bind(workspaceId, librarySpaceId);
      } else if (collectionId) this.unbindCollection(workspaceId, collectionId);
      else this.unbind(workspaceId, librarySpaceId);
    }).immediate();
  }

  /** 绑定整个资料库空间（幂等） */
  bind(workspaceId: string, librarySpaceId: string): void {
    const ws = this.requireNonEmpty(workspaceId, "workspaceId");
    const ls = this.requireNonEmpty(librarySpaceId, "librarySpaceId");
    this.db.connection
      .prepare(
        `INSERT OR IGNORE INTO workspace_library_links (workspace_id, library_space_id, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(ws, ls, Date.now());
  }

  /** 解绑整个资料库空间（幂等） */
  unbind(workspaceId: string, librarySpaceId: string): void {
    const ws = this.requireNonEmpty(workspaceId, "workspaceId");
    const ls = this.requireNonEmpty(librarySpaceId, "librarySpaceId");
    this.db.connection
      .prepare(`DELETE FROM workspace_library_links WHERE workspace_id = ? AND library_space_id = ?`)
      .run(ws, ls);
  }

  /** 绑定资料库文件夹（幂等；librarySpaceId 冗余保存用于权限/清理）。 */
  bindCollection(workspaceId: string, librarySpaceId: string, collectionId: string): void {
    const ws = this.requireNonEmpty(workspaceId, "workspaceId");
    const ls = this.requireNonEmpty(librarySpaceId, "librarySpaceId");
    const cid = this.requireNonEmpty(collectionId, "collectionId");
    this.db.connection
      .prepare(
        `INSERT OR IGNORE INTO workspace_library_collection_links
           (workspace_id, library_space_id, collection_id, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(ws, ls, cid, Date.now());
  }

  /** 解绑资料库文件夹（幂等）。 */
  unbindCollection(workspaceId: string, collectionId: string): void {
    const ws = this.requireNonEmpty(workspaceId, "workspaceId");
    const cid = this.requireNonEmpty(collectionId, "collectionId");
    this.db.connection
      .prepare(`DELETE FROM workspace_library_collection_links WHERE workspace_id = ? AND collection_id = ?`)
      .run(ws, cid);
  }

  /** 某 workspace 直接绑定的整个 library space id 列表（兼容旧调用）。 */
  listByWorkspace(workspaceId: string): string[] {
    const ws = workspaceId.trim();
    if (!ws) return [];
    const rows = this.db.connection
      .prepare(
        `SELECT library_space_id FROM workspace_library_links
         WHERE workspace_id = ? ORDER BY created_at, library_space_id`,
      )
      .all(ws) as Array<{ library_space_id: string }>;
    return rows.map((r) => r.library_space_id);
  }

  listCollectionsByWorkspace(workspaceId: string): WorkspaceLibraryCollectionBinding[] {
    const ws = workspaceId.trim();
    if (!ws) return [];
    const rows = this.db.connection
      .prepare(
        `SELECT library_space_id, collection_id FROM workspace_library_collection_links
         WHERE workspace_id = ? ORDER BY created_at, collection_id`,
      )
      .all(ws) as Array<{ library_space_id: string; collection_id: string }>;
    return rows.map((r) => ({ librarySpaceId: r.library_space_id, collectionId: r.collection_id }));
  }

  /** UI 用：某 workspace 的两类直接绑定。 */
  listTargetsByWorkspace(workspaceId: string): ResolvedWorkspaceLibraryBindings {
    return {
      librarySpaceIds: this.listByWorkspace(workspaceId),
      collections: this.listCollectionsByWorkspace(workspaceId),
    };
  }

  listByLibrarySpace(librarySpaceId: string): string[] {
    const ls = librarySpaceId.trim();
    if (!ls) return [];
    const rows = this.db.connection
      .prepare(
        `SELECT workspace_id FROM workspace_library_links
         WHERE library_space_id = ? ORDER BY created_at, workspace_id`,
      )
      .all(ls) as Array<{ workspace_id: string }>;
    return rows.map((r) => r.workspace_id);
  }

  listByCollection(collectionId: string): string[] {
    const cid = collectionId.trim();
    if (!cid) return [];
    const rows = this.db.connection
      .prepare(
        `SELECT workspace_id FROM workspace_library_collection_links
         WHERE collection_id = ? ORDER BY created_at, workspace_id`,
      )
      .all(cid) as Array<{ workspace_id: string }>;
    return rows.map((r) => r.workspace_id);
  }

  /** 兼容旧调用：仅返回「整个资料库」绑定。 */
  resolveLibrarySpaceIds(scopeSpaceIds: Iterable<string>): string[] {
    return this.resolveTargets(scopeSpaceIds).librarySpaceIds;
  }

  /** Workspace scope → Space + Collection 两类绑定，均去重并确定性排序。 */
  resolveTargets(scopeSpaceIds: Iterable<string>): ResolvedWorkspaceLibraryBindings {
    const ids = [...scopeSpaceIds].map((id) => id.trim()).filter(Boolean);
    if (ids.length === 0) return { librarySpaceIds: [], collections: [] };
    const placeholders = ids.map(() => "?").join(",");
    const spaceRows = this.db.connection
      .prepare(
        `SELECT DISTINCT library_space_id FROM workspace_library_links
         WHERE workspace_id IN (${placeholders})
         ORDER BY library_space_id`,
      )
      .all(...ids) as Array<{ library_space_id: string }>;
    const collectionRows = this.db.connection
      .prepare(
        `SELECT DISTINCT library_space_id, collection_id FROM workspace_library_collection_links
         WHERE workspace_id IN (${placeholders})
         ORDER BY library_space_id, collection_id`,
      )
      .all(...ids) as Array<{ library_space_id: string; collection_id: string }>;
    return {
      librarySpaceIds: spaceRows.map((r) => r.library_space_id),
      collections: collectionRows.map((r) => ({ librarySpaceId: r.library_space_id, collectionId: r.collection_id })),
    };
  }

  private requireNonEmpty(value: string, label: string): string {
    const trimmed = value.trim();
    if (!trimmed) throw new Error(`${label} 不能为空`);
    return trimmed;
  }
}
