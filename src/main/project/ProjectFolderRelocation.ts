import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AppDatabase } from "../db/AppDatabase";
import type { ProjectFolderPreview } from "../../shared/project-domain";
import type { ArtifactService } from "../artifact/ArtifactService";
import { artifactFromRow, type ArtifactRow } from "../artifact/ArtifactRepository";
import { computeEffectiveArchived } from "../../shared/workspace-tree";
import { inspectArtifactFolderRelocation, type ArtifactFolderChange } from "../artifact/ArtifactFolderRelocation";
import type { ArtifactUpdatedEvent } from "../../shared/artifact-types";
import { ProjectRepository } from "./ProjectRepository";
import { gatewayChannelForSpace } from "../../shared/gateway-task";

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

type CoreSnapshot = {
  witness: string;
  projects: Array<{ id: string; name: string; updated_at: number; default_space_id: string | null; archived: number }>;
  spaces: Array<{ id: string; name: string; path: string | null; parent_id: string | null; archived: number }>;
  tasks: Array<{ id: string; title: string; project_id: string | null; space_id: string | null }>;
  references: Array<{ id: string; title: string; value: string; project_id: string }>;
  runs: Array<{ cwd: string }>;
  artifacts: ArtifactRow[];
  dependencies: Array<{ artifact_id: string; file_path: string; dependency_kind: string; created_at: number }>;
};

/** Relink an already moved folder. Never copy, move, or delete user files. */
export class ProjectFolderRelocation {
  private readonly pending = new Map<string, { projectId: string; target: string; fingerprint: string; expires: number }>();
  constructor(private readonly db: AppDatabase, private readonly isTaskBusy: (id: string) => boolean, private readonly getArtifacts: () => ArtifactService | undefined = () => undefined) {}

  private inspect(projectId: string, targetPath: string, core?: CoreSnapshot): Omit<ProjectFolderPreview, "token"> & { artifactChanges: ArtifactFolderChange[] } {
    const projects = core ? core.projects.map(p => ({ id: p.id, name: p.name, updatedAt: p.updated_at, defaultSpaceId: p.default_space_id, archived: Boolean(p.archived) })) : new ProjectRepository(this.db.connection).list(true);
    const project = projects.find(p => p.id === projectId);
    if (!project || project.archived || !project.defaultSpaceId) throw new Error("项目未设置可修改的默认文件夹");
    const coreSpaces = core?.spaces.map(s => ({ ...s, parentId: s.parent_id, archived: Boolean(s.archived) }));
    const effective = computeEffectiveArchived(coreSpaces ?? []);
    const spaces = coreSpaces ? coreSpaces.map(s => ({ ...s, effectiveArchived: effective.get(s.id) })) : this.db.listSpaces();
    const byId = new Map(spaces.map(s => [s.id, s] as const));
    const resolveCwd = (id: string | null | undefined) => {
      const seen = new Set<string>();
      while (id && !seen.has(id)) {
        seen.add(id);
        const item = byId.get(id);
        if (!item) break;
        if (item.path?.trim()) {
          const path = resolve(item.path.trim());
          if (!existsSync(path) || statSync(path).isDirectory()) return path;
        }
        id = item.parentId;
      }
      return null;
    };
    const space = byId.get(project.defaultSpaceId);
    if (!space?.path || space.archived || space.effectiveArchived) throw new Error("原文件夹不可用或已归档");
    if (typeof targetPath !== "string" || !isAbsolute(targetPath)) throw new Error("请选择绝对目录路径");
    const target = realpathSync(targetPath);
    if (!statSync(target).isDirectory()) throw new Error("新位置不是文件夹");
    if (resolve(space.path).toLowerCase() === target.toLowerCase()) throw new Error("新旧文件夹相同，无需重新关联");
    // Physical containment decides what moved. UI parentage is preserved, never guessed as disk ancestry.
    const folders = spaces.filter((item) => item.path && within(space.path!, item.path)).map((item) => {
      if (gatewayChannelForSpace(item.id)) throw new Error(`网关渠道空间必须使用其专属目录：${item.name}`);
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
    const allTasks = core?.tasks ?? this.db.connection.prepare("SELECT id, title, project_id, space_id FROM tasks ORDER BY id").all() as Array<{ id: string; title: string; project_id: string | null; space_id: string | null }>;
    const artifacts = this.getArtifacts();
    if (!artifacts && !core && this.db.connection.prepare("SELECT 1 FROM sqlite_master WHERE name = 'artifacts'").get()) throw new Error("产物服务尚未就绪，请稍后重试");
    const taskIds = new Set(allTasks.map(task => task.id));
    const artifactChanges = core ? inspectArtifactFolderRelocation({
      listAll: () => core.artifacts.map(artifactFromRow),
      listFileDependencies: id => core.dependencies.filter(d => d.artifact_id === id).map(d => ({
        artifactId: id, filePath: d.file_path, dependencyKind: d.dependency_kind, createdAt: d.created_at,
      })),
    }, space.path, target, taskIds) : artifacts?.inspectFolderRelocation(space.path, target, taskIds) ?? [];
    const artifactTasks = new Set(artifactChanges.map((item) => item.before.taskId));
    const tasks = allTasks.map((task) => {
      const cwd = resolveCwd(task.space_id);
      const newCwd = cwd && within(space.path!, cwd) ? resolve(target, relative(space.path!, cwd)) : undefined;
      return { ...task, newCwd };
    }).filter((task) => task.newCwd || artifactTasks.has(task.id));
    if (tasks.some((task) => this.isTaskBusy(task.id))) throw new Error("有关联任务正在执行，请结束执行后重试");
    const allReferences = core?.references ?? this.db.connection.prepare("SELECT id, title, value, project_id FROM project_resources WHERE kind = 'file' ORDER BY id").all() as Array<{ id: string; title: string; value: string; project_id: string }>;
    const movedReferences = allReferences.filter((resource) => isAbsolute(resource.value) && within(space.path!, resource.value));
    const affectedProjectIds = new Set([projectId, ...tasks.flatMap((task) => task.project_id ? [task.project_id] : []), ...movedReferences.map((resource) => resource.project_id)]);
    const affectedProjects = projects.filter((item) => {
      const cwd = resolveCwd(item.defaultSpaceId);
      return affectedProjectIds.has(item.id) || (cwd !== null && within(space.path!, cwd));
    }).map((item) => ({ id: item.id, name: item.name, updatedAt: item.updatedAt, archived: item.archived === true, defaultSpaceId: item.defaultSpaceId })).sort((a, b) => a.id.localeCompare(b.id));
    if (core || this.db.connection.prepare("SELECT 1 FROM sqlite_master WHERE name = 'external_agent_runs'").get()) {
      const running = core?.runs ?? this.db.connection.prepare("SELECT cwd FROM external_agent_runs WHERE status IN ('starting','working','blocked')").all() as Array<{ cwd: string }>;
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
    return this.savePreview(projectId, this.inspect(projectId, target));
  }

  private async readCore() {
    const snapshot = await this.db.runtimeAuditReader?.projectMetadata<CoreSnapshot>({ kind: "folderRelocation" });
    if (!snapshot) throw new Error("项目目录快照未获 Rust Core 确认");
    return snapshot;
  }

  async previewAsync(projectId: string, target: string): Promise<ProjectFolderPreview> {
    if (!this.db.coreIdentity && !this.db.runtimeAuditReader?.supervised && !this.db.connection.readonly) return this.preview(projectId, target);
    return this.savePreview(projectId, this.inspect(projectId, target, await this.readCore()));
  }

  private savePreview(projectId: string, result: ReturnType<ProjectFolderRelocation["inspect"]>): ProjectFolderPreview {
    for (const [key, value] of this.pending) if (value.expires < Date.now()) this.pending.delete(key);
    if (this.pending.size >= 50) this.pending.delete(this.pending.keys().next().value!);
    const token = randomUUID();
    this.pending.set(token, { projectId, target: result.newPath, fingerprint: hash(JSON.stringify(result)), expires: Date.now() + 300_000 });
    const { artifactChanges: _changes, ...preview } = result;
    return { ...preview, token };
  }

  async commit(token: string): Promise<void> {
    const pending = this.pending.get(token);
    this.pending.delete(token);
    if (!pending || pending.expires < Date.now()) throw new Error("预览已失效，请重新选择文件夹");
    let artifactEvents: ArtifactUpdatedEvent[] = [];
    const reader = this.db.runtimeAuditReader;
    if (this.db.coreIdentity || reader?.supervised || this.db.connection.readonly) {
      if (!reader) throw new Error("目录迁移失败：Rust 写入核心未就绪");
      const snapshot = await this.readCore();
      const fresh = this.inspect(pending.projectId, pending.target, snapshot);
      if (hash(JSON.stringify(fresh)) !== pending.fingerprint) throw new Error("目录、任务或资料已发生变化，请重新预览");
      const now = Date.now();
      const receipt = await reader.batch2Write<{ updated: Array<{ id: string; version: number; revision: number }> }>({
        witness: snapshot.witness,
        artifacts: fresh.artifactChanges.map(c => ({ id: c.before.id, taskId: c.before.taskId, updatedAt: now, sourceType: c.source.type, rootDir: c.source.rootDir, entryFile: c.source.type === "workspace-file" ? c.source.entryFile : null, storagePath: c.source.type === "managed-content" ? c.source.storagePath : null, dependencies: c.dependencies })),
        kind: "relocateProjectFolder",
        now,
        folders: (fresh.folders ?? []).map((folder) => ({ id: folder.id, newPath: folder.newPath })),
        references: fresh.references.map((resource) => ({ id: resource.id, projectId: resource.projectId, newPath: resource.newPath })),
        affectedProjectIds: (fresh.affectedProjects ?? []).map((affected) => affected.id),
      });
      if (!receipt) throw new Error("项目目录写入未获 Rust Core 确认，请刷新");
      artifactEvents = fresh.artifactChanges.map(c => {
        const row = receipt.updated.find(r => r.id === c.before.id);
        if (!row) throw new Error("项目产物迁移回执不完整，请刷新");
        const descriptor = { ...c.before, source: c.source, version: row.version, updatedAt: now };
        return { artifactId: descriptor.id, taskId: descriptor.taskId, descriptor, revision: row.revision, version: row.version };
      });
      this.getArtifacts()?.publishFolderRelocation(artifactEvents);
      return;
    }
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
