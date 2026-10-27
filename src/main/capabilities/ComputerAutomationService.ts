/**
 * 兼容薄层：Computer Use 的 Windows 实现已整体迁移到
 * `src/main/platform/computer-use/windows/WindowsComputerUseBackend.ts`。
 *
 * 业务/入口可以继续从这里 import（history: index.ts / LocalCapabilityChecks /
 * builtin-capability-extension / tests）；新代码请直接使用 `src/main/platform/computer-use/`。
 * 本文件不再包含任何平台实现或 Windows 逻辑。
 */
import { createComputerUseBackend } from "../platform/computer-use/index";

export * from "../platform/computer-use/protocol";
export { WindowsComputerUseBackend as ComputerAutomationService } from "../platform/computer-use/windows/WindowsComputerUseBackend";

/** 当前平台的 Computer Use backend（Windows=UIA 实现；Linux/macOS=unsupported）。 */
export const computerAutomationService = createComputerUseBackend();
