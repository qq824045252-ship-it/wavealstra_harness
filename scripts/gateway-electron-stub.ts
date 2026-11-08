/** electron stub：node 环境下测试 GatewayService 纯逻辑用 */
export const BrowserWindow = {
  getAllWindows: (): unknown[] => [],
};

// Test-only codec. Production uses Electron's OS encryption and refuses plaintext fallback.
let encryptionAvailable = true;
let storageBackend = "gnome_libsecret";
export function setStorageBackend(value: string): void { storageBackend = value; }
export function setEncryptionAvailable(value: boolean): void { encryptionAvailable = value; }
export const safeStorage = {
  getSelectedStorageBackend: (): string => storageBackend,
  isEncryptionAvailable: (): boolean => encryptionAvailable,
  encryptString: (value: string): Buffer => Buffer.from("test-only:" + value, "utf8"),
  decryptString: (value: Buffer): string => value.toString("utf8").slice("test-only:".length),
};
