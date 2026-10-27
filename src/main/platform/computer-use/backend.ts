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
  /**
   * 可选：刷新自检。Linux 的 CUL `doctor` 要 1–3 秒，不能塞进 `status()`
   * （它被工具注册、设置页、agent 探针同步调用），所以由这里显式触发；
   * 返回的 Promise 在结果写进缓存后 resolve，之后 `status()` 能读到更细的就绪信息
   * （如 `can_capture_screenshots=false` 与「截图未验证」这类真实状态）。
   */
  refreshDiagnostics?(): void | Promise<void>;
  /**
   * 可选：释放后端自己记录下来的「按住中的键/鼠标按钮」。
   *
   * Linux（ydotool）上 `key_down`/`mouse_down_client` 的按住状态跨进程持久，agent 用完
   * 忘记 `key_up` 就会把用户桌面留在按着 Ctrl 的状态。借鉴 LCU 的输入状态清理规则：
   * 任务结束/取消时由上层调用一次，后端只释放「自己按下、且现在仍按着」的输入，
   * 不动用户自己在按的（用户的按键不经过后端，后端也看不见）。
   * Windows 的 SendInput 没有跨调用按住语义，所以不实现。
   */
  releaseHeldInput?(): Promise<{ keys: number[]; buttons: string[] }>;
}
