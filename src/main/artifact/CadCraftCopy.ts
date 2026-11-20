import { constants } from "node:fs";
import { chmod, copyFile, lstat, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { cadCraftExtension, type CadCraftOpenResult, type CadCraftSource } from "../../shared/cadcraft";
import type { ArtifactService } from "./ArtifactService";
import type { SavedArtifactActions } from "./SavedArtifactActions";

interface Ports {
  artifacts: Pick<ArtifactService, "get" | "entryPathOf">;
  saved: Pick<SavedArtifactActions, "verifiedSnapshot">;
  storageRoot: string;
  choose(defaultPath: string, extension: string): Promise<string | undefined>;
  openDrawing(path: string): Promise<void>;
}

function contains(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

async function resolveDrawing(source: CadCraftSource, ports: Ports): Promise<{ path: string; name: string }> {
  if (source?.type === "work") return ports.saved.verifiedSnapshot(source.file);
  if (source?.type !== "artifact" || typeof source.taskId !== "string" || typeof source.id !== "string") {
    throw new Error("CAD 图纸来源无效");
  }
  const descriptor = ports.artifacts.get(source.id);
  const path = ports.artifacts.entryPathOf(source.id);
  if (descriptor?.taskId !== source.taskId || descriptor.source.type !== "workspace-file" || !path ||
      !contains(await realpath(descriptor.source.rootDir), await realpath(path))) {
    throw new Error("CAD 图纸已移除或已离开当前任务的登记目录");
  }
  return { path, name: basename(path) };
}

export async function openCadCraftCopy(source: CadCraftSource, ports: Ports): Promise<CadCraftOpenResult> {
  const drawing = await resolveDrawing(source, ports);
  const extension = cadCraftExtension(drawing.name);
  if (!extension) throw new Error("CADCraft 支持 DWG 和 DXF 图纸");
  const name = `${basename(drawing.name, extname(drawing.name))} - 编辑副本.${extension}`;
  const storage = await realpath(ports.storageRoot);
  const original = await realpath(drawing.path);
  const defaultPath = contains(storage, original) ? name : join(dirname(original), name);
  const selected = await ports.choose(defaultPath, extension);
  if (!selected) return { canceled: true };

  const requested = resolve(selected);
  const parent = await realpath(dirname(requested));
  const output = join(parent, basename(requested));
  if (cadCraftExtension(output) !== extension || contains(storage, output) || relative(original, output) === "") {
    throw new Error("请选择应用存储目录之外的同格式新文件名");
  }
  const current = await resolveDrawing(source, ports);
  if (relative(current.path, drawing.path) !== "" || relative(original, await realpath(current.path)) !== "") {
    throw new Error("原图位置已变化，请重新打开");
  }
  const before = await lstat(original);
  if (!before.isFile() || before.size < 6) throw new Error("图纸为空或无法读取");
  if (extension === "dwg") {
    const file = await open(original, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const header = Buffer.alloc(6);
      await file.read(header, 0, header.length, 0);
      if (!/^AC10[0-9]{2}$/.test(header.toString("ascii"))) throw new Error("图纸缺少有效的 DWG 文件头");
    } finally {
      await file.close();
    }
  }
  try {
    await copyFile(original, output, constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("该文件名已存在，请为编辑副本选择新名称");
    throw error;
  }
  try {
    const after = await lstat(original);
    if (after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error("复制过程中原图发生变化，请重试");
    }
    await chmod(output, 0o600);
  } catch (error) {
    await unlink(output);
    throw error;
  }
  try {
    await ports.openDrawing(output);
  } catch (error) {
    throw new Error(`CADCraft 启动失败。编辑副本已保存到 ${output}`, { cause: error });
  }
  return { canceled: false, path: output };
}
