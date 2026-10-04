import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ArtifactDescriptor, ArtifactFileDependency } from "../../shared/artifact-types";
import type { ArtifactRepository } from "./ArtifactRepository";

const within = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
};

export interface ArtifactFolderChange {
  before: ArtifactDescriptor;
  source: ArtifactDescriptor["source"];
  dependencies: ArtifactFileDependency[];
  evidence: Array<{ path: string; digest: string; oldExists: boolean }>;
}

/** Read-only plan, rebuilt at commit. Managed storage remains owned by ArtifactStorage. */
export function inspectArtifactFolderRelocation(repository: ArtifactRepository, oldRoot: string, newRoot: string, taskIds: ReadonlySet<string>): ArtifactFolderChange[] {
  const map = (path: string) => within(oldRoot, path) ? resolve(newRoot, relative(oldRoot, path)) : path;
  const changes: ArtifactFolderChange[] = [];
  const evidenceCache = new Map<string, ArtifactFolderChange["evidence"][number]>();
  // Bound synchronous main-process work; large projects need the asynchronous migration path.
  let remaining = 256 * 1024 * 1024;
  const digest = (path: string) => {
    const info = statSync(path);
    if (!info.isFile()) throw new Error(`产物文件不可读：${path}`);
    if (info.size > remaining) throw new Error("产物核对超过 256 MiB，请缩小本次重新关联范围");
    const fd = openSync(path, "r");
    try {
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let count: number;
      while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
        remaining -= count;
        if (remaining < 0) throw new Error("产物核对超过 256 MiB，请缩小本次重新关联范围");
        hash.update(buffer.subarray(0, count));
      }
      return hash.digest("hex");
    } finally { closeSync(fd); }
  };
  const verify = (oldPath: string) => {
    const cached = evidenceCache.get(oldPath);
    if (cached) return cached;
    const path = map(oldPath);
    if (!existsSync(path) || !within(newRoot, realpathSync(path))) throw new Error(`新目录缺少产物文件或文件越界：${path}`);
    const fingerprint = digest(path);
    const oldExists = existsSync(oldPath);
    if (oldExists && !within(oldRoot, realpathSync(oldPath))) throw new Error(`原产物文件越界：${oldPath}`);
    if (oldExists && digest(oldPath) !== fingerprint) throw new Error(`新旧产物内容不一致：${path}`);
    const evidence = { path, digest: fingerprint, oldExists };
    evidenceCache.set(oldPath, evidence);
    return evidence;
  };
  for (const before of repository.listAll()) {
    const originalDependencies = repository.listFileDependencies(before.id);
    const oldEntry = before.source.type === "workspace-file" ? resolve(before.source.rootDir, before.source.entryFile) : undefined;
    if (!within(oldRoot, before.source.rootDir) && !(oldEntry && within(oldRoot, oldEntry)) && !originalDependencies.some((d) => within(oldRoot, d.filePath))) continue;
    if (!taskIds.has(before.taskId)) throw new Error(`其他任务的产物仍引用此目录：${before.title ?? before.id}`);
    const source = { ...before.source, rootDir: map(before.source.rootDir) };
    if (within(oldRoot, before.source.rootDir) && (!existsSync(source.rootDir) || !statSync(source.rootDir).isDirectory() || !within(newRoot, realpathSync(source.rootDir)))) throw new Error(`新目录缺少产物根目录：${source.rootDir}`);
    const evidence: ArtifactFolderChange["evidence"] = [];
    if (source.type === "workspace-file" && oldEntry) {
      source.entryFile = map(oldEntry);
      if (!within(source.rootDir, source.entryFile)) throw new Error("重新关联后的产物入口越界");
      if (within(oldRoot, oldEntry)) evidence.push(verify(oldEntry));
      if (existsSync(source.entryFile) && !within(realpathSync(source.rootDir), realpathSync(source.entryFile))) throw new Error("重新关联后的产物入口越界");
    }
    const dependencies = originalDependencies.map((dependency) => {
      if (within(oldRoot, dependency.filePath)) evidence.push(verify(dependency.filePath));
      const filePath = map(dependency.filePath);
      if (!within(source.rootDir, filePath)) throw new Error("重新关联后的产物依赖越界");
      if (existsSync(filePath) && !within(realpathSync(source.rootDir), realpathSync(filePath))) throw new Error("重新关联后的产物依赖越界");
      return { ...dependency, filePath };
    });
    changes.push({ before, source, dependencies, evidence });
  }
  return changes;
}
