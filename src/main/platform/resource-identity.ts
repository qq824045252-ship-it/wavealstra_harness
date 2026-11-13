import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathKey } from "./paths";

export interface FileResourceIdentity {
  path: string;
  pathKey: string;
  entity: string | null;
  parentEntity: string;
  version: string;
  directory: boolean;
}

function absent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Lock identity without reading file contents or enumerating a directory. */
export function fileResourceAddress(input: string): Pick<FileResourceIdentity, "path" | "entity"> {
  let ancestor = resolve(input);
  const suffix: string[] = [];
  for (;;) {
    try { lstatSync(ancestor); break; }
    catch (error) {
      if (!absent(error)) throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new Error(`无法解析资源父目录：${input}`);
      suffix.unshift(basename(ancestor)); ancestor = parent;
    }
  }
  const canonical = realpathSync.native(ancestor), stat = statSync(canonical, { bigint: true });
  if (suffix.length && !stat.isDirectory()) throw new Error("新资源的父路径不是目录");
  if (stat.ino === 0n) throw new Error("当前文件系统未提供可信实体身份，不能协调细粒度资源访问");
  return { path: resolve(canonical, ...suffix), entity: suffix.length ? null : `${stat.dev}:${stat.ino}` };
}

/** Real names, entity IDs and content are separate: realpath alone misses hard links. */
export function fileResourceIdentity(input: string): FileResourceIdentity {
  const requested = resolve(input);
  let ancestor = requested;
  const suffix: string[] = [];
  for (;;) {
    try { lstatSync(ancestor); break; }
    catch (error) {
      if (!absent(error)) throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new Error(`无法解析资源父目录：${requested}`);
      suffix.unshift(basename(ancestor)); ancestor = parent;
    }
  }
  const realAncestor = realpathSync.native(ancestor);
  const parent = statSync(realAncestor, { bigint: true });
  if (suffix.length && !parent.isDirectory()) throw new Error("新资源的父路径不是目录");
  const canonical = resolve(realAncestor, ...suffix);
  const entityOf = (s: typeof parent) => `${s.dev}:${s.ino}`;
  if (parent.ino === 0n) throw new Error("当前文件系统未提供可信实体身份，不能授予细粒度资源锁");
  if (suffix.length) return { path: canonical, pathKey: pathKey(canonical), entity: null,
    parentEntity: entityOf(parent), version: `absent:${entityOf(parent)}:${suffix.join(sep)}`, directory: false };
  const directory = parent.isDirectory();
  const content = directory ? readdirSync(canonical, { withFileTypes: true }).map(item =>
    `${item.name}:${item.isDirectory() ? "d" : item.isSymbolicLink() ? "l" : "f"}`).sort().join("\n") : readFileSync(canonical);
  return { path: canonical, pathKey: pathKey(canonical), entity: entityOf(parent), parentEntity: entityOf(statSync(dirname(canonical), { bigint: true })),
    version: `${entityOf(parent)}:sha256:${createHash("sha256").update(content).digest("hex")}`, directory };
}

/** Component containment avoids confusing /repo/a with /repo/another. */
export function resourcePathContains(parent: string, child: string): boolean {
  const suffix = relative(pathKey(parent), pathKey(child));
  return suffix === "" || !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`);
}

/** Includes dirty/untracked content; Git HEAD cannot describe the current working files. */
export function directoryContentVersion(root: string, maxFiles = 10_000): string {
  const hash = createHash("sha256");
  let files = 0;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git") continue;
      if (++files > maxFiles) throw new Error("资源内容清单超过有界扫描上限，需要缩小范围");
      const name = join(directory, entry.name);
      const identity = fileResourceIdentity(name);
      hash.update(relative(root, name)); hash.update(identity.version);
      // Do not recursively follow directory aliases, whose contents have another managed identity.
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(name);
    }
  };
  visit(realpathSync.native(root));
  return `sha256:${hash.digest("hex")}`;
}
