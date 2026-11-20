import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { resolvedPathKey } from "../platform/paths";
import { assertManagedPathSafe, isPathInsideManagedRoot } from "./library-file-io";
import { copyWithRewrittenNoteLinks } from "./library-note-links";

export async function scanLibraryImportFolder(sourcePath: string, managedRoot: string) {
  if (!isAbsolute(sourcePath) || !basename(sourcePath)) throw new Error("请选择具体的本地文件夹");
  if (!(await lstat(sourcePath)).isDirectory()) throw new Error("请选择本地文件夹，符号链接和目录快捷方式无法导入");
  const root = await realpath(sourcePath);
  const libraryRoot = await realpath(managedRoot);
  if (isPathInsideManagedRoot(libraryRoot, root) || isPathInsideManagedRoot(root, libraryRoot)) {
    throw new Error("请选择与 MyBuddy 受管资料分开的本地文件夹");
  }
  const folders: Array<{ path: string; parent: string | null }> = [{ path: root, parent: null }];
  const files: Array<{ path: string; folder: string; size: number }> = [];
  let skippedEntries = 0;
  for (const folder of folders) {
    assertManagedPathSafe(root, folder.path);
    const entries = await readdir(folder.path, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(folder.path, entry.name);
      if (entry.isDirectory()) {
        folders.push({ path, parent: folder.path });
      } else if (entry.isFile()) {
        const status = await lstat(path);
        if (!status.isFile()) throw new Error("导入期间文件已变化：" + entry.name);
        files.push({ path, folder: folder.path, size: status.size });
      } else skippedEntries++;
    }
  }
  return { root, folders, files, skippedEntries };
}

export function rewriteImportedFolderLinks(sourcePath: string, destination: string, itemUrls: ReadonlyMap<string, string>): boolean {
  return copyWithRewrittenNoteLinks(sourcePath, destination, (href) => {
    const match = /^([^?#]+)([?#].*)?$/.exec(href);
    if (!match) return;
    let local: string;
    try { local = decodeURIComponent(match[1]); } catch { return; }
    if (!local || /^([a-z][a-z0-9+.-]*:|[\\/])/i.test(local)) return;
    const url = itemUrls.get(resolvedPathKey(resolve(dirname(sourcePath), local)));
    if (url) return url + (match[2] ?? "");
  });
}
