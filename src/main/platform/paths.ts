/**
 * 路径语义（platform/paths）：大小写归一化、分隔符、symlink 类型、正斜杠化。
 *
 * 这些判断原本散落在 AgentService / paths.ts / PluginStorage / SkillsService /
 * TaskExecutionWorkspace / HerdrLauncher / TerminalHost / terminal-env / ShellArguments /
 * ExternalCliMemoryBridge 里，写成 `process.platform === "win32" ? … : …`。
 * 现在统一收敛到这里；业务侧不再读取 process.platform。
 *
 * 约定：平台参数用产品内部的 `PlatformId`（windows/linux/macos），默认当前进程。
 */
import { resolve } from "node:path";
import { currentPlatformId, type PlatformId } from "./index";

/** 文件系统是否大小写不敏感（Windows 盘符/目录名大小写不敏感）。 */
export function caseInsensitivePathFs(platform: PlatformId = currentPlatformId): boolean {
  return platform === "windows";
}

/** 仅大小写归一化（调用方已有 resolved 值时用；不做 resolve）。 */
export function pathKey(value: string, platform: PlatformId = currentPlatformId): string {
  return caseInsensitivePathFs(platform) ? value.toLowerCase() : value;
}

/** resolve + 大小写归一化（各文件的 normalizeForCompare / normalizePathForComparison）。 */
export function resolvedPathKey(value: string, platform: PlatformId = currentPlatformId): string {
  return pathKey(resolve(value), platform);
}

/**
 * 路径比较用的 canonical 形式：resolve + 去掉尾部斜杠 + `toLocaleLowerCase`（Windows）。
 * 迁自 HerdrLauncher/TerminalHost/ExternalCliMemoryBridge 的同名私有函数。
 */
export function canonicalPathKey(value: string, platform: PlatformId = currentPlatformId): string {
  const normalized = resolve(value).replace(/[\\/]+$/, "");
  return caseInsensitivePathFs(platform) ? normalized.toLocaleLowerCase() : normalized;
}

/** 目标平台的目录分隔符（PluginStorage 的词法越界判断要用". .\\"而不是"../"）。 */
export function pathSeparator(platform: PlatformId = currentPlatformId): string {
  return platform === "windows" ? "\\" : "/";
}

/** 相对路径越界前缀：`..` + 目标平台分隔符。 */
export function parentTraversalPrefix(platform: PlatformId = currentPlatformId): string {
  return `..${pathSeparator(platform)}`;
}

/** 目录 symlink 类型：Windows 用 junction（无需管理员权限），POSIX 用 dir。 */
export function directorySymlinkType(platform: PlatformId = currentPlatformId): "junction" | "dir" {
  return platform === "windows" ? "junction" : "dir";
}

/** 反斜杠转正斜杠（仅 Windows 需要；POSIX 原样返回）。 */
export function toPosixPath(value: string, platform: PlatformId = currentPlatformId): string {
  return platform === "windows" ? value.replaceAll("\\", "/") : value;
}
