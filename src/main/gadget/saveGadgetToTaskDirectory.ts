import { lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { resolvedPathKey } from "../platform/paths";
import type { GadgetDescriptor, GadgetSourceSnapshot } from "../../shared/gadget-types";
import type { GadgetSaveToTaskDirectoryResult } from "../../shared/gadget-ipc";

function safeDirectory(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Gadgets 保存目录必须是真实文件夹，不能是符号链接");
}

/** A source-only snapshot, never a move or a mirror of runtime/private data. */
export function saveGadgetToTaskDirectory(
  taskDirectory: string,
  gadget: Pick<GadgetDescriptor, "id" | "name">,
  snapshot: GadgetSourceSnapshot,
): GadgetSaveToTaskDirectoryResult {
  if (!isAbsolute(taskDirectory)) throw new Error("任务工作目录必须是绝对路径");
  const root = realpathSync(taskDirectory);
  safeDirectory(root);
  const parent = join(root, "gadgets");
  try { mkdirSync(parent); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  safeDirectory(parent);
  if (resolvedPathKey(realpathSync(parent)) !== resolvedPathKey(parent)) throw new Error("Gadgets 保存目录越界");
  if (!/^[a-zA-Z0-9_-]+$/.test(gadget.id)) throw new Error("Gadget id 无效");
  const name = gadget.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/[. ]+$/g, "").slice(0, 60) || "gadget";
  const base = `${/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? "gadget-" : ""}${name}-${gadget.id}`;
  let directory = "";
  // mkdir is the reservation: repeated saves and identical names never replace existing files.
  for (let version = 1; version <= 10_000; version++) {
    const candidate = join(parent, `${base}${version === 1 ? "" : `-${version}`}`);
    try { mkdirSync(candidate); directory = candidate; break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  if (!directory) throw new Error("保存副本过多，请整理任务工作目录后重试");
  try {
    const source = join(directory, "code");
    mkdirSync(source);
    for (const file of snapshot.files) {
      const parts = file.path.replaceAll("\\", "/").split("/");
      if (parts.some(part => !part || part === "." || part === ".." || part.includes(":"))) throw new Error("Gadget 源码路径无效");
      const destination = join(source, ...parts);
      mkdirSync(resolve(destination, ".."), { recursive: true });
      writeFileSync(destination, file.encoding === "base64" ? Buffer.from(file.content, "base64") : file.content, { flag: "wx" });
    }
    const requestedEntry = resolvedPathKey(join(source, ...snapshot.manifest.entry.split("/")));
    const entry = snapshot.files.find(file => resolvedPathKey(join(source, ...file.path.split("/"))) === requestedEntry);
    if (!entry) throw new Error("Gadget 入口文件不存在");
    const entryPath = join(source, ...entry.path.split("/"));
    writeFileSync(join(directory, "gadget.json"), `${JSON.stringify({ ...snapshot.manifest, entry: entry.path }, null, 2)}\n`, { flag: "wx" });
    writeFileSync(join(directory, "README.md"), `# ${gadget.name}\n\n这是从 MyBuddy 保存的独立源码副本。\n\n- 入口：code/${entry.path}\n- 源码与资源：code/\n- 工具配置：gadget.json\n\n可在浏览器中打开入口 HTML；依赖 HTTP 的功能需使用本地静态服务器。\n副本不自动同步，不包含运行数据、浏览器登录状态或其它任务内容。\n再次保存会创建新文件夹，不覆盖已有文件。\n`, { flag: "wx" });
    return { directory, entryPath, fileCount: snapshot.files.length };
  } catch (error) {
    // Only this operation's exclusively-created directory is eligible for cleanup.
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
