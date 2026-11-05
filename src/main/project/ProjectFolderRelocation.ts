import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AppDatabase } from "../db/AppDatabase";
import type { ProjectFolderPreview } from "../../shared/project-domain";
import type { ArtifactService } from "../artifact/ArtifactService";
import type { ArtifactFolderChange } from "../artifact/ArtifactFolderRelocation";
import type { ArtifactUpdatedEvent } from "../../shared/artifact-types";
import { ProjectRepository } from "./ProjectRepository";

const within = (root: string, path: string) => { const rel = relative(root, path); return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)); };
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const hashFile = (path: string): string => {
  const fd = openSync(path, "r");
  try {
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let count: number;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, count));
    return digest.digest("hex");
  } finally { closeSync(fd); }
};

/** Relink an already moved folder. Never copy, move, or delete user files. */
export class ProjectFolderRelocation {
  private readonly pending = new Map<string, { projectId: string; target: string; fingerprint: string; expires: number }>();
  constructor(private readonly db: AppDatabase, private readonly isTaskBusy: (id: string) => boolean, private readonly getArtifacts: () => ArtifactService | undefined = () => undefined) {}

  private inspect(projectId: string, targetPath: string): Omit<ProjectFolderPreview, "token"> & { artifactChanges: ArtifactFolderChange[] } {
    const repository = new ProjectRepository(this.db.connection);
    const project = repository.get(projectId);
    if (!project || project.archived || !project.defaultSpaceId) throw new Error("项目未设置可修改的默认文件夹");
    const space = this.db.getSpace(project.defaultSpaceId);
    if (!space?.path || space.archived || space.effectiveArchived) throw new Error("原文件夹不可用或已归档");
    if (typeof targetPath !== "string" || !isAbsolute(targetPath)) throw new Error("请选择绝对目录路径");
    const target = realpathSync(targetPath);
    if (!statSync(target).isDirectory()) throw new Error("新位置不是文件夹");
    if (resolve(space.path).toLowerCase() === target.toLowerCase()) throw new Error("新旧文件夹相同，无需重新关联");
    const spaces = this.db.listSpaces();
    // Physical containment decides what moved. UI parentage is preserved, never guessed as disk ancestry.
    const folders = spaces.filter((item) => item.path && within(space.path!, item.path)).map((item) => {
      const newPath = resolve(target, relative(space.path!, item.path!));
      if (!existsSync(newPath) || !statSync(newPath).isDirectory() || !within(target, realpathSync(newPath))) throw new Error(`新位置缺少已关联的子文件夹或目录越界：${item.name}`);
      const info = statSync(newPath);
      return { id: item.id, name: item.name, parentId: item.parentId, archived: item.archived, oldPath: item.path!, newPath, identity: `${info.dev}:${info.ino}` };
    }).sort((a, b) => a.id.localeCompare(b.id));
    const folderIds = new Set(folders.map((item) => item.id));
    for (const item of spaces) {
      if (folderIds.has(item.id) || !item.path) continue;
      const existingPath = existsSync(item.path) ? realpathSync(item.path) : resolve(item.path);
      if (within(target, existingPath)) throw new Error(`新位置已关联其他文件夹：${item.name}`);
    }
    const allTasks = this.db.connection.prepare("SELECT id, title, project_id, space_id FROM tasks ORDER BY id").all() as Array<{ id: string; title: string; project_id: string | null; space_id: string | null }>;
    const artifacts = this.getArtifacts();
    if (!artifacts && this.db.connection.prepare("SELECT 1 FROM sqlite_master WHERE name = 'artifacts'").get()) throw new Error("产物服务尚未就绪，请稍后重试");
    const artifactChanges = artifacts?.inspectFolderRelocation(space.path, target, new Set(allTasks.map((task) => task.id))) ?? [];
    const artifactTasks = new Set(artifactChanges.map((item) => item.before.taskId));
    const tasks = allTasks.map((task) => {
      const cwd = this.db.resolveWorkspaceExecutionPath(task.space_id);
      const newCwd = cwd && within(space.path!, cwd) ? resolve(target, relative(space.path!, cwd)) : undefined;
      return { ...task, newCwd };
    }).filter((task) => task.newCwd || artifactTasks.has(task.id));
    if (tasks.some((task) => this.isTaskBusy(task.id))) throw new Error("有关联任务正在执行，请结束执行后重试");
    const allReferences = this.db.connection.prepare("SELECT id, title, value, project_id FROM project_resources WHERE kind = 'file' ORDER BY id").all() as Array<{ id: string; title: string; value: string; project_id: string }>;
    const movedReferences = allReferences.filter((resource) => isAbsolute(resource.value) && within(space.path!, resource.value));
    const affectedProjectIds = new Set([projectId, ...tasks.flatMap((task) => task.project_id ? [task.project_id] : []), ...movedReferences.map((resource) => resource.project_id)]);
    const affectedProjects = repository.list(true).filter((item) => {
      const cwd = this.db.resolveWorkspaceExecutionPath(item.defaultSpaceId);
      return affectedProjectIds.has(item.id) || (cwd !== null && within(space.path!, cwd));
    }).map((item) => ({ id: item.id, name: item.name, updatedAt: item.updatedAt, archived: item.archived === true, defaultSpaceId: item.defaultSpaceId })).sort((a, b) => a.id.localeCompare(b.id));
    if (this.db.connection.prepare("SELECT 1 FROM sqlite_master WHERE name = 'external_agent_runs'").get()) {
      const running = this.db.connection.prepare("SELECT cwd FROM external_agent_runs WHERE status IN ('starting','working','blocked')").all() as Array<{ cwd: string }>;
      if (running.some((run) => within(space.path!, run.cwd))) throw new Error("此目录还有外部子任务运行，请先结束执行");
    }
    const references = movedReferences.map((resource) => {
      const path = resolve(target, relative(space.path!, resource.value));
      if (!existsSync(path) || !statSync(path).isFile() || !within(target, realpathSync(path))) throw new Error(`新目录缺少安全可读的文件引用：${resource.title}`);
      const fingerprint = hashFile(path);
      const oldExists = existsSync(resource.value);
      if (oldExists && hashFile(resource.value) !== fingerprint) throw new Error(`新旧文件内容不一致：${resource.title}`);
      return { id: resource.id, projectId: resource.project_id, title: resource.title, oldPath: resource.value, newPath: path, fingerprint, oldExists };
    });
    const targetStat = statSync(target);
    return { projectId, spaceId: space.id, oldPath: space.path, newPath: target,
      projectUpdatedAt: project.updatedAt, targetIdentity: `${targetStat.dev}:${targetStat.ino}`,
      tasks: tasks.map(({ id, title, project_id, space_id, newCwd }) => ({ id, title, projectId: project_id, spaceId: space_id, newCwd })), folders, affectedProjects, references, artifactChanges,
      artifacts: artifactChanges.map((item) => ({ id: item.before.id, title: item.before.title ?? item.before.id, rootDir: item.source.rootDir, fileCount: item.evidence.length, missingOriginal: item.evidence.some((e) => !e.oldExists) })) };
  }

  preview(projectId: string, target: string): ProjectFolderPreview {
    const result = this.inspect(projectId, target);
    for (const [key, value] of this.pending) if (value.expires < Date.now()) this.pending.delete(key);
    if (this.pending.size >= 50) this.pending.delete(this.pending.keys().next().value!);
    const token = randomUUID();
    this.pending.set(token, { projectId, target: result.newPath, fingerprint: hash(JSON.stringify(result)), expires: Date.now() + 300_000 });
    const { artifactChanges: _changes, ...preview } = result;
    return { ...preview, token };
  }

  commit(token: string): void {
    const pending = this.pending.get(token);
    this.pending.delete(token);
    if (!pending || pending.expires < Date.now()) throw new Error("预览已失效，请重新选择文件夹");
    let artifactEvents: ArtifactUpdatedEvent[] = [];
    this.db.connection.transaction(() => {
      const fresh = this.inspect(pending.projectId, pending.target);
      if (hash(JSON.stringify(fresh)) !== pending.fingerprint) throw new Error("目录、任务或资料已发生变化，请重新预览");
      artifactEvents = this.getArtifacts()?.applyFolderRelocation(fresh.artifactChanges) ?? [];
      const now = Date.now();
      for (const folder of fresh.folders!) this.db.connection.prepare("UPDATE spaces SET path = ?, updated_at = ? WHERE id = ?").run(folder.newPath, now, folder.id);
      for (const resource of fresh.references) this.db.connection.prepare("UPDATE project_resources SET value = ?, updated_at = ? WHERE id = ? AND project_id = ?").run(resource.newPath, now, resource.id, resource.projectId);
      for (const affected of fresh.affectedProjects!) this.db.connection.prepare("UPDATE projects SET updated_at = MAX(updated_at + 1, ?) WHERE id = ?").run(now, affected.id);
    })();
    this.getArtifacts()?.publishFolderRelocation(artifactEvents);
  }
}
