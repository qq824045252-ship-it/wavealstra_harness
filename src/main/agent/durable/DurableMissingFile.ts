import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { FileError, type ExecutionEnv } from "@earendil-works/pi-durable/env";

function similarName(requested: string, found: string): boolean {
  const fold = (s: string) => s.normalize("NFC").toLowerCase().replace(/[ _-]+/g, "");
  const a = fold(requested), b = fold(found);
  if (a === b) return true;
  if (a.length < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length !== b.length) return a.length < b.length ? a.slice(i) === b.slice(i + 1) : a.slice(i + 1) === b.slice(i);
  return a.slice(i + 1) === b.slice(i + 1)
    || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
}

async function nearbyFiles(env: ExecutionEnv, missing: string, context: Context): Promise<string[]> {
  const name = basename(missing);
  if (name.startsWith(".") || name.length > 180) return [];
  const cwd = await env.absolutePath(".", context);
  if (!cwd.ok || !isAbsolute(missing)) return [];
  const parent = dirname(missing);
  const [root, directory] = await Promise.all([env.canonicalPath(cwd.value, context), env.canonicalPath(parent, context)]);
  if (!root.ok || !directory.ok) return [];
  const local = relative(root.value, directory.value);
  if (isAbsolute(local) || local === ".." || local.startsWith(".." + sep)) return [];
  const reader = await env.openDirReader(directory.value, context);
  if (!reader.ok) return [];
  try {
    const page = await reader.value.next(96, context);
    if (!page.ok) return [];
    return page.value.entries.filter(e => e.kind === "file" && !e.name.startsWith(".") && e.name !== name && similarName(name, e.name))
      .map(e => join(directory.value, e.name)).sort().slice(0, 3);
  } finally {
    await reader.value.close(context);
  }
}

/** Let the next action use an observed filename. A failed read stays failed, including in Code Mode. */
export function withMissingFileRecovery(tool: ToolRegistration): ToolRegistration {
  return { ...tool, execute: async (args, api, context) => {
    try { return await tool.execute(args, api, context); }
    catch (error) {
      if (api.env && error instanceof FileError && error.code === "not_found" && error.path) {
        try {
          const files = await nearbyFiles(api.env, error.path, context);
          if (files.length) api.diagnostic({ severity: "info", code: "nearby_file_names",
            message: "同一目录中找到以下近似文件名，请按本次任务核对目标：" + JSON.stringify(files) });
        } catch { /* Optional lookup must preserve the original read error. */ }
        context.abortSignal?.throwIfAborted();
      }
      throw error;
    }
  } };
}
