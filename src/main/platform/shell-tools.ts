/**
 * 平台 shell 工具（platform/shell-tools）。
 *
 * 背景：`DurableBotRuntime.codingTools()` 里原本内联
 * `...(process.platform === "win32" ? [createPowerShellTool()] : [])`——
 * Pi 的 CodingTools 自带 bash，Windows 没有 bash 才需要额外暴露 PowerShell。
 * 按平台边界约定，把「这个平台额外提供哪种 shell 工具」收敛到这里；
 * 业务侧（DurableBotRuntime）只拼装平台无关的 CodingTools + 本函数结果。
 */
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { createPowerShellTool } from "@earendil-works/pi-durable/tools";
import { currentPlatformId, type PlatformId } from "./index";

/**
 * 该平台原生支持的 shell 语言 id（execute_code 的 language 取值）。
 * 迁自 capabilities/LocalCapabilityChecks.ts 的 `["javascript", ...(win32 ? ["powershell"] : [])]`。
 */
export function platformShellLanguageIds(platform: PlatformId = currentPlatformId): string[] {
  return platform === "windows" ? ["powershell"] : [];
}

/**
 * execute_code 支持的 language 列表：javascript/python/shell 恒有，Windows 额外有 powershell。
 * 顺序与搬迁前 schema 一致（javascript, python, [powershell], shell），供 schema 生成与错误提示复用。
 */
export function executeCodeLanguages(platform: PlatformId = currentPlatformId): string[] {
  return ["javascript", "python", ...platformShellLanguageIds(platform), "shell"];
}

export interface PlatformShellToolDeps {
  /** 测试注入用；默认 `@earendil-works/pi-durable/tools` 的 createPowerShellTool。 */
  createPowerShellTool?: () => ToolRegistration;
}

/**
 * 当前平台额外需要的 shell 工具。
 *
 * - windows：`[createPowerShellTool()]`（原生 argv 执行，两个 Tag 都暴露；逻辑与搬迁前一致）；
 * - linux / macOS：`[]`（CodingTools 自带 bash，不重复提供）。
 */
export function createPlatformShellTools(
  platform: PlatformId = currentPlatformId,
  deps: PlatformShellToolDeps = {},
): ToolRegistration[] {
  if (platform !== "windows") return [];
  const factory = deps.createPowerShellTool ?? createPowerShellTool;
  return [factory()];
}
