export const LINUX_ATSPI_WORKER_FILE: string;
export const LINUX_INPUT_GUARDIAN_FILE: string;
export const LINUX_CU_RUNTIME_FILE: string;
export interface LinuxComputerUseAsset {
  type: "asset";
  fileName: string;
  source: string | Uint8Array;
}
export function buildLinuxComputerUseAssets(root: string): Promise<LinuxComputerUseAsset[]>;
