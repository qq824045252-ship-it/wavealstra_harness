import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { currentPlatformId } from "./index";

export const officeNativeEngines = ["wordcraft", "gridcraft", "deckcraft"] as const;
export type OfficeNativeEngine = typeof officeNativeEngines[number];

export async function locateOfficeNative(appPath: string, engine: OfficeNativeEngine, resources?: string): Promise<string> {
  if (process.arch !== "x64" || currentPlatformId === "macos") {
    throw new Error("上游 Office 自动化运行资源支持 Windows 和 Linux x64。");
  }
  const windows = currentPlatformId === "windows";
  const root = resources
    ? join(resources, "office-editor", "native")
    : join(appPath, "vendor", "craft-office", "assets", "native", windows ? "win-x64" : "linux-x64");
  const command = windows ? join(root, engine, engine + "-cli.exe") : join(root, engine, "bin", engine + "-cli");
  try { await access(command, constants.X_OK); }
  catch { throw new Error(resources ? `${engine} 上游运行资源缺失` : `请运行 pnpm prepare:office-native 准备 ${engine} 上游运行资源。`); }
  return command;
}
