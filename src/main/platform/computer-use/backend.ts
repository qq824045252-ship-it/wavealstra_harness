import type { PlatformId } from "../index";
import type { ComputerExecInput, ComputerExecOutput } from "./protocol";

/**
 * Computer Use backend 接口（平台无关）。
 *
 * 业务/入口只依赖这个接口 + `createComputerUseBackend()`；Windows/Linux/macOS 的差异
 * 全部在各自 backend 实现里。新增平台 = 新增一个 backend 文件并在工厂注册。
 */
export interface ComputerUseStatus {
  platform: PlatformId;
  backend: string;
  supported: boolean;
  /** 后端仍缺的命令/依赖（已具备时为空数组）。 */
  missingDependencies: string[];
  /** 缺失依赖的安装提示（如 pacman 命令）。 */
  installHint?: string;
  /** 为什么不可用 / 当前后端状态。 */
  reason?: string;
  /** 给模型/用户看的一句话状态。 */
  detail: string;
  /** Windows Automation Host 子进程 PID（仅 Windows backend 有）。 */
  hostPid?: number;
}

export interface ComputerUseBackend {
  readonly platform: PlatformId;
  readonly backend: string;
  readonly available: boolean;
  status(): ComputerUseStatus;
  execute(input: ComputerExecInput, signal?: AbortSignal): Promise<ComputerExecOutput>;
  shutdown(): Promise<void>;
}
