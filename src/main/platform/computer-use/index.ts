import { currentPlatformId, type PlatformId } from "../index";
import type { ComputerUseBackend } from "./backend";
import { LinuxComputerUseBackend } from "./linux/LinuxComputerUseBackend";
import { MacosComputerUseBackend } from "./macos/MacosComputerUseBackend";
import { WindowsComputerUseBackend } from "./windows/WindowsComputerUseBackend";

export * from "./backend";
export * from "./protocol";
export * from "./support";

/**
 * Computer Use backend 工厂（按平台缓存单例）。
 *
 * - windows → WindowsComputerUseBackend（完整 UIA/SendInput/WGC/OCR 实现）
 * - linux   → LinuxComputerUseBackend（available=false；能力探测 + 安装提示，观察层待接线）
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
  return backend;
}

/** 测试用：清空工厂缓存（生产路径不需要调用）。 */
export function resetComputerUseBackends(): void {
  backends.clear();
}
