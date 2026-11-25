import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { assertManagedWritePathSafe, atomicWriteFileSync } from "../library/library-file-io";

const residentDirectory = "常驻能力";
export type DotsResidentSource = "Google" | "RSS" | "Dream";

export function validateDotsWorkspaceRoot(path: string): string {
  if (!isAbsolute(path)) throw new Error("请选择一个现有的绝对目录。");
  const root = realpathSync(path);
  if (!statSync(root).isDirectory()) throw new Error("Dots 根目录必须是文件夹。");
  accessSync(root, constants.W_OK);
  return root;
}

function localDateTime(now: Date) {
  const numbers = (values: number[], separator: string) => values.map(n => String(n).padStart(2, "0")).join(separator);
  return { day: numbers([now.getFullYear(), now.getMonth() + 1, now.getDate()], "-"),
    time: numbers([now.getHours(), now.getMinutes(), now.getSeconds()], "") };
}

export function createDotsWorkspace(root: string, now = new Date()): string {
  const { day, time } = localDateTime(now);
  const dateDirectory = join(root, day);
  mkdirSync(dateDirectory, { recursive: true });
  if (realpathSync(dateDirectory) !== dateDirectory) throw new Error("Dots 日期目录不能指向另一个位置。");
  const workspace = join(dateDirectory, `dots-${time}-${randomUUID().slice(0, 8)}`);
  mkdirSync(workspace);
  return workspace;
}

export function saveDotsBrief(workspace: string, source: DotsResidentSource, key: string, text: string, queuedAt: number) {
  const root = validateDotsWorkspaceRoot(workspace);
  if (root !== workspace) throw new Error("Dots 工作目录已被替换，简报保留等待写入。");
  const resident = join(root, residentDirectory);
  assertManagedWritePathSafe(root, resident);
  mkdirSync(resident, { recursive: true });
  const folder = join(resident, source);
  assertManagedWritePathSafe(root, folder);
  mkdirSync(folder, { recursive: true });
  const { day, time } = localDateTime(new Date(queuedAt));
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 20);
  const filename = `${day}_${time}-${hash}.md`;
  const path = join(folder, filename);
  assertManagedWritePathSafe(root, path);
  atomicWriteFileSync(path, text + "\n");
}

export function isDotsBriefPath(workspace: string, path: string) {
  return relative(workspace, path).split(sep)[0] === residentDirectory;
}
