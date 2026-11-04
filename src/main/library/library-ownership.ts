import type { LibraryCreateSpaceRequest, LibraryOwnerScope, LibrarySpaceDto } from "../../shared/library-ipc";
import type { AppDatabase } from "../db/AppDatabase";
import type { LibraryRepository } from "./LibraryRepository";
import type { LibraryQueryScope } from "./library-query-scope";

export interface LibraryOwnerReference {
  spaceId: string;
  collectionId?: string | null;
  itemId?: string;
}

/** 在同步保存入口、任何文件/条目变更之前校验，拒绝另一个窗口改绑后的旧页面请求。 */
export function assertArtifactSaveOwner(
  db: AppDatabase,
  repo: LibraryRepository,
  owner: LibraryOwnerScope,
  spaceId: string,
  artifactId: string,
): void {
  if (!owner || !ownedLibraryQueryScope(db, repo, owner).spaceIds.has(spaceId)) {
    throw new Error("目标资料空间不属于当前查看的归属，请刷新后重试");
  }
  // artifacts.space_id 是历史快照；只能信任来源任务此刻的 project_id / space_id。
  const source = db.connection.prepare(`SELECT t.project_id, t.space_id
    FROM artifacts a JOIN tasks t ON t.id = a.task_id WHERE a.id = ?`).get(artifactId) as {
      project_id: string | null;
      space_id: string | null;
    } | undefined;
  if (!source) throw new Error("产物不存在或来源任务已删除，请刷新后重试");
  const matches = owner.type === "project" ? source.project_id === owner.projectId.trim()
    : owner.type === "workspace" ? source.space_id === owner.workspaceId.trim()
    : owner.type === "personal" && source.project_id === null && source.space_id === null;
  if (!matches) throw new Error("产物来源任务已不属于当前归属，可能已移动或改绑，请刷新后重试");
}

/** 人类资料页按被查看的真实归属检索；reference 只进一步收窄，不改变归属。 */
export function ownedLibraryQueryScope(
  db: AppDatabase,
  repo: LibraryRepository,
  owner: LibraryOwnerScope,
  reference?: LibraryOwnerReference,
): LibraryQueryScope {
  const empty = (): LibraryQueryScope => ({ spaceIds: new Set() });
  let spaces: LibrarySpaceDto[];
  if (owner.type === "personal") {
    // 历史无归属 team 空间继续在个人资料入口可找回，不变更文件或 ID。
    spaces = repo.listSpaces().filter((space) => !space.projectId && !space.workspaceId);
  } else if (owner.type === "project" && owner.projectId?.trim()) {
    const id = owner.projectId.trim();
    if (!db.connection.prepare("SELECT 1 FROM projects WHERE id = ?").get(id)) return empty();
    spaces = repo.listProjectSpaces(id);
  } else if (owner.type === "workspace" && owner.workspaceId?.trim()) {
    const id = owner.workspaceId.trim();
    if (!db.getSpace(id)) return empty();
    spaces = repo.listWorkspaceSpaces(id);
  } else return empty();

  const spaceIds = new Set(spaces.map((space) => space.id));
  if (!reference) return { spaceIds };
  if (!spaceIds.has(reference.spaceId)) return empty();
  let collectionIds: Set<string> | undefined;
  if (reference.collectionId != null) {
    const root = repo.getCollection(reference.collectionId);
    if (!root || root.spaceId !== reference.spaceId) return empty();
    collectionIds = new Set<string>();
    const queue = [root.id];
    while (queue.length) {
      const id = queue.pop()!;
      if (collectionIds.has(id)) continue;
      collectionIds.add(id);
      for (const child of repo.listCollections(reference.spaceId, id)) queue.push(child.id);
    }
  }
  if (reference.itemId !== undefined) {
    const item = repo.getItem(reference.itemId);
    if (!item || item.spaceId !== reference.spaceId || (collectionIds && (!item.collectionId || !collectionIds.has(item.collectionId)))) return empty();
    return { spaceIds: new Set(), itemIds: new Set([item.id]) };
  }
  return collectionIds ? { spaceIds: new Set(), collectionIds } : { spaceIds: new Set([reference.spaceId]) };
}

/** 惰性创建归属空间；旧项目可能有多个空间，沿用确定性排序的第一个。 */
export function ensureOwnedLibrarySpace(
  db: AppDatabase,
  repo: LibraryRepository,
  owner: LibraryOwnerScope,
  createSpace: (request: LibraryCreateSpaceRequest) => LibrarySpaceDto,
  ensurePersonal: () => LibrarySpaceDto,
): LibrarySpaceDto {
  return db.connection.transaction(() => {
    if (owner.type === "personal") return ensurePersonal();
    if (owner.type === "project") {
      const projectId = owner.projectId?.trim();
      if (!projectId) throw new Error("项目不能为空");
      const project = db.connection.prepare("SELECT name FROM projects WHERE id = ?").get(projectId) as { name: string } | undefined;
      if (!project) throw new Error("项目不存在");
      return repo.listProjectSpaces(projectId)[0]
        ?? createSpace({ projectId, name: `${project.name.slice(0, 80)}资料` });
    }
    if (owner.type === "workspace") {
      const workspaceId = owner.workspaceId?.trim();
      if (!workspaceId) throw new Error("工作空间不能为空");
      const workspace = db.getSpace(workspaceId);
      if (!workspace) throw new Error("工作空间不存在");
      return repo.listWorkspaceSpaces(workspaceId)[0]
        ?? createSpace({ workspaceId, name: `${(workspace.name ?? "工作空间").slice(0, 80)}资料` });
    }
    throw new Error("未知资料归属类型");
  })();
}
