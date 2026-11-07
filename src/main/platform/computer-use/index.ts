import { currentPlatformId, type PlatformId } from "../index";
import type { ComputerUseBackend } from "./backend";
import { setHeldInputReleaser } from "./heldInput";
import { LinuxComputerUseBackend } from "./linux/LinuxComputerUseBackend";
import { MacosComputerUseBackend } from "./macos/MacosComputerUseBackend";
import { WindowsComputerUseBackend } from "./windows/WindowsComputerUseBackend";

export * from "./backend";
export * from "./heldInput";
export * from "./protocol";
export * from "./support";

/**
 * Computer Use backend 工厂（按平台缓存单例）。
 *
 * - windows → WindowsComputerUseBackend（完整 UIA/SendInput/WGC/OCR 实现）
 * - linux   → LinuxComputerUseBackend（AT-SPI worker + Hyprland，分能力异步诊断）
 * - macos   → MacosComputerUseBackend（显式 unsupported）
 */
const backends = new Map<PlatformId, ComputerUseBackend>();

export function createComputerUseBackend(platform: PlatformId = currentPlatformId): ComputerUseBackend {
  const cached = backends.get(platform);
  if (cached) return cached;
  let backend: ComputerUseBackend;
  switch (platform) {
    case "windows":
      backend = new WindowsComputerUseBackend();
      break;
    case "macos":
      backend = new MacosComputerUseBackend();
      break;
    default:
      backend = new LinuxComputerUseBackend();
      break;
  }
  backends.set(platform, backend);
  // Each backend must prove release of its owned input, in addition to draining
  // its queue. An idle queue alone cannot prove that a previous DOWN was released.
  setHeldInputReleaser(async (taskId, recovery) => {
    recovery?.assertCurrent();
    if (backend.releaseHeldInput) return backend.releaseHeldInput(taskId, recovery);
    throw new Error("当前桌面后端没有可确认的队列/输入清理接口");
  });
  return backend;
}

/** 测试用：清空工厂缓存（生产路径不需要调用）。 */
export function resetComputerUseBackends(): void {
  backends.clear();
  setHeldInputReleaser(undefined);
}
