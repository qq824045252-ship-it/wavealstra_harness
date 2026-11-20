import { lstat, mkdtemp, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { OfficeOpen } from "../../shared/office-use";
import type { ArtifactService } from "../artifact/ArtifactService";
import type { SavedArtifactActions } from "../artifact/SavedArtifactActions";
import type { LibraryService } from "../library/LibraryService";
import { assertOfficePackage, atomicBytes, inside, kindFor, plainFile, type OfficeFileTarget } from "./OfficeFile";

interface OfficeSourcePorts {
  artifacts: ArtifactService;
  library: LibraryService;
  saved: SavedArtifactActions;
  storageRoot: string;
  choose(name: string): Promise<string | undefined>;
}

async function optionalStat(path: string) {
  try { return await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

const equalPath = (left: string, right: string) => relative(left, right) === "";

function copyName(name: string): string {
  const extension = extname(name);
  return basename(name, extension) + " - 编辑副本" + extension;
}

async function assertWithin(root: string, path: string): Promise<void> {
  if (!isAbsolute(path) || !inside(resolve(root), resolve(path)) ||
      !inside(await realpath(root), await realpath(path))) {
    throw new Error("Office 文件已离开登记目录");
  }
  await plainFile(path);
}

async function assertOutsideStorage(root: string, path: string): Promise<void> {
  if (inside(resolve(root), resolve(path)) || inside(await realpath(root), path)) {
    throw new Error("请选择应用存储目录以外的位置");
  }
}

async function assertWorkspaceArea(storageRoot: string, declaredRoot: string, path: string): Promise<void> {
  const storage = await realpath(storageRoot);
  if (!inside(resolve(storageRoot), path) && !inside(storage, path)) return;
  const workspaceDirs = ["bot-workspaces", "task-workspaces", "task-worktrees", "bot-conversations"];
  const realRoot = await realpath(declaredRoot);
  if (workspaceDirs.some(directory => {
    const allowed = join(storage, directory);
    return inside(allowed, realRoot) && inside(allowed, path);
  })) return;
  throw new Error("Office 文件位于应用的受保护存储目录");
}

export async function saveOfficeAs(
  bytes: Buffer, target: OfficeFileTarget, ports: Pick<OfficeSourcePorts, "storageRoot" | "choose">,
  verifySource?: () => Promise<void>,
): Promise<string | null> {
  await assertOfficePackage(bytes, target.kind);
  const selection = await ports.choose(copyName(target.name));
  if (!selection) return null;
  const requested = resolve(selection);
  const parent = await realpath(dirname(requested));
  const destination = join(parent, basename(requested));
  if (kindFor(destination) !== target.kind || equalPath(destination, target.path)) {
    throw new Error("请选择同格式的其他 Office 文件名");
  }
  await assertOutsideStorage(ports.storageRoot, destination);
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory()) throw new Error("请选择可写的保存目录");
  const before = await optionalStat(destination);
  if (before && (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)) {
    throw new Error("保存目标不是独立的普通文件");
  }
  const unchanged = async (): Promise<void> => {
    await verifySource?.();
    await assertOutsideStorage(ports.storageRoot, destination);
    const actualParent = await realpath(dirname(requested));
    const parentNow = await lstat(parent);
    const after = await optionalStat(destination);
    if (!equalPath(actualParent, parent) || parentInfo.dev !== parentNow.dev || parentInfo.ino !== parentNow.ino) {
      throw new Error("保存目录发生变化，请重新选择");
    }
    if (before ? !after || after.nlink !== 1 || after.dev !== before.dev || after.ino !== before.ino ||
        after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      : after !== undefined) {
      throw new Error("目标文件发生变化，请重新保存");
    }
  };
  await atomicBytes(destination, bytes, unchanged);
  return destination;
}

export async function resolveOfficeTarget(request: OfficeOpen, ports: OfficeSourcePorts): Promise<OfficeFileTarget> {
  const { source } = request;
  if (source.type === "artifact") {
    const descriptor = ports.artifacts.get(source.id);
    const path = ports.artifacts.entryPathOf(source.id);
    if (!descriptor || !path || descriptor.kind !== "office" || (source.taskId && source.taskId !== descriptor.taskId)) {
      throw new Error("办公产物不属于当前任务或已移除");
    }
    const base64 = descriptor.source.type === "managed-content";
    const name = base64
      ? descriptor.title?.trim() || source.id
      : basename(path);
    const originalKind = descriptor.capabilities.originalKind;
    const declaredKind = base64 && typeof originalKind === "string" ? kindFor("file." + originalKind) : undefined;
    const kind = declaredKind ?? kindFor(name);
    if (!kind) throw new Error("Office Use 支持 DOCX、XLSX 和 PPTX");
    const fileName = kindFor(name) === kind ? basename(name) :
      basename(name, extname(name)) + "." + originalKind;
    const root = descriptor.source.rootDir;
    const check = async (): Promise<void> => {
      const current = ports.artifacts.get(source.id);
      const entry = ports.artifacts.entryPathOf(source.id);
      if (!current || current.kind !== "office" || current.taskId !== descriptor.taskId || !entry ||
          !equalPath(entry, path) || current.source.type !== descriptor.source.type ||
          !equalPath(current.source.rootDir, root) ||
          (base64 && current.capabilities.originalKind !== originalKind)) {
        throw new Error("办公产物来源已变化，请重新打开");
      }
      await assertWithin(root, path);
      if (base64) await assertWithin(ports.storageRoot, path);
      else await assertWorkspaceArea(ports.storageRoot, root, path);
    };
    await check();
    return { path, name: fileName, kind, base64, taskId: descriptor.taskId,
      identity: JSON.stringify(["artifact", descriptor.taskId, descriptor.id, path]),
      check, published: () => ports.artifacts.notifyHtmlSaved(path) };
  }
  if (source.type === "work") {
    const { name, path } = await ports.saved.verifiedSnapshot(source.file);
    const kind = kindFor(name);
    if (!kind) throw new Error("此保存版本不是受支持的 Office 文件");
    const check = async (): Promise<void> => {
      const current = await ports.saved.verifiedSnapshot(source.file);
      if (!equalPath(current.path, path)) throw new Error("交付文件已发生变化");
      await plainFile(path);
    };
    const target: OfficeFileTarget = { path, name, kind, identity: JSON.stringify(["work", path]), check };
    target.copy = async (bytes, unchanged) => {
      const destination = await saveOfficeAs(bytes, target, ports, unchanged ?? check);
      return destination ? "已保存副本 " + destination : null;
    };
    return target;
  }
  if (source.type === "library") {
    const owner = source.owner;
    if (!owner) throw new Error("请选择资料所属位置");
    const item = ports.library.resolveOfficeItem(source.id, owner, source.reference);
    const path = ports.library.absolutePath(item);
    const name = basename(item.filename);
    const kind = kindFor(name);
    if (!kind) throw new Error("此资料不是受支持的 Office 文件");
    const readOnly = Boolean(source.readOnly || source.reference);
    const validateScope = (write = false): void => {
      const current = ports.library.resolveOfficeItem(source.id, owner, source.reference, write);
      if (current.spaceId !== item.spaceId || current.collectionId !== item.collectionId ||
          !equalPath(ports.library.absolutePath(current), path)) {
        throw new Error("资料位置已变化，请重新打开");
      }
    };
    const check = async (): Promise<void> => {
      validateScope();
      await plainFile(path);
    };
    await check();
    return {
      path, name, kind, readOnly, check,
      identity: JSON.stringify(["library", item.spaceId, item.collectionId, item.id, path]),
      copy: async (bytes, unchanged) => {
        if (readOnly) throw new Error("当前资料只读");
        validateScope(true);
        const directory = await mkdtemp(join(await realpath(ports.storageRoot), "office-library-"));
        const temporary = join(directory, copyName(name));
        try {
          await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
          await (unchanged ?? check)();
          validateScope(true);
          const saved = ports.library.importFile({
            sourcePath: temporary, spaceId: item.spaceId, collectionId: item.collectionId,
          });
          return "已保存资料副本 " + saved.filename;
        } finally {
          try {
            await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
          } finally { await rmdir(directory); }
        }
      },
    };
  }
  throw new Error("Office 文档来源无效");
}
