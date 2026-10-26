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
