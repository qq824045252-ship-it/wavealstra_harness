import type { ComputerUseBackend, ComputerUseStatus } from "../backend";
import type { ComputerExecInput, ComputerExecOutput } from "../protocol";

const MACOS_UNSUPPORTED_REASON =
  "macOS 没有 Computer Use 后端实现（产品只提供 Windows UIA 后端）。";

/** macOS backend：与 Linux 一样是显式 unsupported 边界，不静默假装可用。 */
export class MacosComputerUseBackend implements ComputerUseBackend {
  readonly platform = "macos" as const;
  readonly backend = "unsupported" as const;

  get available(): boolean {
    return false;
  }

  status(): ComputerUseStatus {
    return {
      platform: this.platform,
      backend: this.backend,
      supported: false,
      missingDependencies: [],
      reason: MACOS_UNSUPPORTED_REASON,
      detail: `computer_exec 在 macos 上不可用（backend=${this.backend}）；${MACOS_UNSUPPORTED_REASON}`,
    };
  }

  async execute(_input: ComputerExecInput, _signal?: AbortSignal): Promise<ComputerExecOutput> {
    throw new Error(this.status().detail);
  }

  async shutdown(): Promise<void> {
    // 没有常驻子进程/服务需要停止。
  }
}
