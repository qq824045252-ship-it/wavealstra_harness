import { createHash } from "node:crypto";
import { cpSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

/** Copies packages into a host-owned revision; links cannot escape the snapshot. */
export function copyExpertPackages<T extends { id: string; directory: string }>(root: string, packages: T[]): T[] {
  const ownedRoot = resolve(root);
  return packages.map(pkg => {
    const { id, directory } = pkg;
    const destination = resolve(ownedRoot, createHash("sha256").update(id).digest("hex"));
    if (!destination.startsWith(ownedRoot + sep)) throw new Error("专家快照路径无效");
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(directory, destination, { recursive: true, force: false, errorOnExist: true, filter: path => {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error(`技能包不允许链接或特殊文件：${id}`);
      return true;
    } });
    return { ...pkg, directory: destination };
  });
}
