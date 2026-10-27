import type { ComputerUseBackend, ComputerUseStatus } from "../backend";
import type { ComputerExecInput, ComputerExecOutput } from "../protocol";
import { computerUseUnsupportedMessage, detectComputerUseSupport } from "../support";

/**
 * Linux Computer Use backend（当前是能力探测 + 可诊断的 unsupported 边界）。
 *
 * 观察/输入层（hyprctl / grim / slurp / tesseract / wtype / ydotool）尚未接线：
 * `available=false`，`status()` 返回依赖探测与 pacman 安装提示，`execute()` 直接抛
 * 带安装提示的错误，绝不静默假装成功。后续补齐观察层时替换本类的 execute 即可，
 * 业务层与工具 schema 不需要再改。
 */
export class LinuxComputerUseBackend implements ComputerUseBackend {
  readonly platform = "linux" as const;
  readonly backend = "linux-wayland" as const;

  get available(): boolean {
    return false;
  }

  status(): ComputerUseStatus {
    const support = detectComputerUseSupport("linux");
    return {
      platform: this.platform,
      backend: this.backend,
      supported: false,
      missingDependencies: support.missingDependencies,
      installHint: support.installHint,
      reason: support.reason,
      detail: computerUseUnsupportedMessage(support),
    };
  }

  async execute(_input: ComputerExecInput, _signal?: AbortSignal): Promise<ComputerExecOutput> {
    throw new Error(computerUseUnsupportedMessage(detectComputerUseSupport("linux")));
  }

  async shutdown(): Promise<void> {
    // 没有常驻子进程/服务需要停止。
  }
}
