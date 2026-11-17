import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AutomationScope } from "../AutomationScope";
import type { CollectionResult } from "./BrowserCollection";

export interface BrowserCollectionExport { path: string; rootDir: string; bytes: number; sha256: string; }
export class BrowserCollectionExportError extends Error {
  constructor(message: string, readonly details: { stage: "directory" | "created" | "written"; path?: string; directory?: string }, options?: ErrorOptions) {
    super(message, options); this.name = "BrowserCollectionExportError";
  }
}

/** taskRoot is host authority, not a user-provided output path. Partial files are retained and reported on failure. */
export async function exportBrowserCollection(args: { taskRoot: string; collection: CollectionResult; scope: AutomationScope }): Promise<BrowserCollectionExport> {
  const { scope, collection } = args;
  scope.check();
  if (!args.taskRoot) throw new Error("Collection export requires a task root");
  const root = await realpath(resolve(args.taskRoot)); scope.check();
  const rootInfo = await stat(root); scope.check();
  if (!rootInfo.isDirectory()) throw new Error("Collection export root is not a directory");
  const content = Buffer.from(`${JSON.stringify(collection)}\n`, "utf8");
  const expectedHash = createHash("sha256").update(content).digest("hex");
  let directory: string | undefined, path: string | undefined;
  let stage: "directory" | "created" | "written" = "directory";
  try {
    scope.dispatch();
    directory = await mkdtemp(join(root, ".mybuddy-collection-"));
    scope.check();
    const canonicalDirectory = await realpath(directory); scope.check();
    const part = relative(root, canonicalDirectory);
    if (!part || part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part) || dirname(canonicalDirectory) !== root) throw new Error("Collection export directory escaped the task root");
    path = join(canonicalDirectory, "collection.json");
    const file = await open(path, "wx", 0o600); stage = "created";
    try { scope.check(); await file.writeFile(content); stage = "written"; }
    finally { await file.close(); }
    scope.check();
    const actualPath = await realpath(path); scope.check();
    if (actualPath !== path) throw new Error("Collection export path changed");
    const info = await stat(path); scope.check();
    if (!info.isFile()) throw new Error("Collection export is not a regular file");
    const hash = createHash("sha256"); let bytes = 0;
    for await (const chunk of createReadStream(path)) { scope.check(); hash.update(chunk); bytes += chunk.length; }
    scope.check();
    const sha256 = hash.digest("hex");
    if (bytes !== info.size || bytes !== content.length || sha256 !== expectedHash) throw new Error("Collection export verification failed");
    scope.confirmed = true;
    return { path, rootDir: root, bytes, sha256 };
  } catch (error) {
    throw new BrowserCollectionExportError("集合结果导出未完成；已创建的文件会保留，请先核对后再决定是否重试", { stage, ...(path ? { path } : {}), ...(directory ? { directory } : {}) }, { cause: error });
  }
}
