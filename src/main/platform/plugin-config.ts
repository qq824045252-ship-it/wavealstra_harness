import { isAbsolute, relative, resolve, sep } from "node:path";
import type { RuntimeAuditReader, RuntimePluginConfigTarget } from "./runtime-audit";

export async function editPluginConfig(
  native: RuntimeAuditReader | undefined,
  kind: RuntimePluginConfigTarget["kind"],
  roots: readonly string[],
  filePath: string,
  edit: (text: string | null) => string,
): Promise<boolean> {
  if (!native) return false;
  for (const directory of roots) {
    const root = resolve(directory);
    const file = relative(root, resolve(filePath));
    if (!file || file === ".." || file.startsWith(".." + sep) || isAbsolute(file)) continue;
    const target = { root, file, kind };
    const before = await native.readPluginConfig(target);
    if (before?.status !== "observed") return false;

    const text = edit(before.text);
    const result = await native.replacePluginConfig(target, before.version, text);
    if (result?.status === "saved") return true;
    if (result?.status === "needsHost") return false;
    if (result?.status === "changed") throw new Error("插件配置已变化，请刷新后重试");
    if (result?.status === "failed") throw new Error(`无法保存插件配置：${result.message}`);
    throw new Error("未收到插件配置保存确认，请刷新查看当前状态");
  }
  return false;
}
