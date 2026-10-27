/**
 * 运行时常量/布局（platform/runtime）：node 可执行名、PATH 分隔符、ProgramFiles 默认、
 * Python venv 布局、uv 资产名、子进程 detach 语义。
 *
 * 这些判定的特点是**与 Node 运行时/打包布局绑定**，用 NodeJS.Platform（"win32"/"darwin"/
 * "linux"）而不是产品内部的 PlatformId；业务侧（subagent / runtime / security / web-access）
 * 不再直接读 `process.platform`，默认值统一从 `currentNodePlatform` 取。
 */
import { join, resolve, sep } from "node:path";

/**
 * 唯一读取 `process.platform` 的地方（本模块内）。
 * 服务层需要"当前平台"默认值时用它，不要在业务文件里直接读 process.platform。
 */
export const currentNodePlatform: NodeJS.Platform = process.platform;

/** node 可执行文件名（Windows 需要 .exe 才能在 PATH 里命中）。 */
export function nodeExecutableName(platform: NodeJS.Platform = currentNodePlatform): string {
  return platform === "win32" ? "node.exe" : "node";
}

/** PATH 分隔符（Windows ";"，POSIX ":"）。 */
export function pathListSeparator(platform: NodeJS.Platform = currentNodePlatform): string {
  return platform === "win32" ? ";" : ":";
}

/** ProgramFiles 的默认值（POSIX 没有这个概念，返回空串表示"不参与探测"）。 */
export function programFilesDefault(platform: NodeJS.Platform = currentNodePlatform): string {
  return platform === "win32" ? "C:\\Program Files" : "";
}

/**
 * 子进程是否放进独立进程组：Unix 需要（超时可整树杀），Windows 不用（用 taskkill /T）。
 * 对应各处的 `detached: process.platform !== "win32"`。
 */
export function spawnDetachedForTreeKill(platform: NodeJS.Platform = currentNodePlatform): boolean {
  return platform !== "win32";
}

/** Python venv 里解释器的相对路径（Windows: Scripts/python.exe；POSIX: bin/python）。 */
export function venvPythonRelativePath(platform: NodeJS.Platform = currentNodePlatform): string {
  return platform === "win32" ? join("Scripts", "python.exe") : join("bin", "python");
}

/** Python venv 里 python3 的相对路径（Windows 无 python3，回落到 python.exe）。 */
export function venvPython3RelativePath(platform: NodeJS.Platform = currentNodePlatform): string {
  return platform === "win32" ? "python.exe" : join("bin", "python3");
}

/**
 * in-project 虚拟环境里解释器的相对路径片段（`.venv` + 这些）：
 * Windows = Scripts/python.exe，POSIX = bin/python。供项目 Python 发现使用。
 */
export function pythonVenvInterpreterParts(platform: NodeJS.Platform = currentNodePlatform): string[] {
  return platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"];
}

/** 解释器可执行文件名。 */
export function pythonExecutableName(platform: NodeJS.Platform = currentNodePlatform): string {
  return platform === "win32" ? "python.exe" : "python";
}

/**
 * 项目目录的主键形式：统一分隔符，Windows 额外小写。
 * （迁自 runtime/python-environment-spec.ts 的 pythonProjectDirKey，保留原名字导出。）
 */
export function pythonProjectCacheKey(dir: string, platform: NodeJS.Platform = currentNodePlatform): string {
  const resolved = resolve(dir);
  const unified = resolved.split(sep).join("/");
  return platform === "win32" ? unified.toLowerCase() : unified;
}

/** uv 可执行文件名。 */
export function uvExecutableName(platform: NodeJS.Platform = currentNodePlatform): string {
  return platform === "win32" ? "uv.exe" : "uv";
}

/**
 * uv 受管下载的资产名（平台 + 架构 → GitHub release 资产）。
 * 逐字搬迁自 runtime/UvToolchain.ts 的 uvAssetName。
 */
export function uvAssetName(platform: NodeJS.Platform, arch: NodeJS.Architecture): string {
  const archPart = (() => {
    switch (arch) {
      case "x64":
        return "x86_64";
      case "arm64":
        return "aarch64";
      default:
        throw new Error(`uv 受管下载不支持的架构：${arch}`);
    }
  })();
  switch (platform) {
    case "win32":
      return `uv-${archPart}-pc-windows-msvc.zip`;
    case "darwin":
      return `uv-${archPart}-apple-darwin.tar.gz`;
    case "linux":
      return `uv-${archPart}-unknown-linux-gnu.tar.gz`;
    default:
      throw new Error(`uv 受管下载不支持的平台：${platform}`);
  }
}
