import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import release from "../../../vendor/cadcraft/releases.json";
import { currentPlatformId } from "./index";

export async function locateCadCraftEditor(appPath: string, packagedResources?: string): Promise<string> {
  if (process.arch !== "x64" || currentPlatformId === "macos") {
    throw new Error("CADCraft 离线编辑器支持 Windows 和 Linux x64");
  }
  const target = currentPlatformId === "windows" ? "win-x64" : "linux-x64";
  const root = packagedResources ? join(packagedResources, "cadcraft") : join(appPath, "vendor/cadcraft/assets", target);
  const editor = join(root, release.targets[target].editor);
  try {
    await access(editor, constants.X_OK);
  } catch {
    throw new Error(packagedResources ? "CADCraft 运行资源缺失或不可执行" : "请先运行 pnpm prepare:cadcraft 安装编辑器资源");
  }
  return editor;
}

export function startCadCraftEditor(editor: string, drawing: string, configDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(editor, [drawing], {
      cwd: dirname(drawing),
      env: { ...process.env, CADCRAFT_CONFIG_DIR: configDir },
      detached: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}
