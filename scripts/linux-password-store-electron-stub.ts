const switches = new Map<string, string>();

/** 仅供 linux-password-store 单测：记录 appendSwitch，不拉起 Chromium。 */
export const app = {
  commandLine: {
    appendSwitch(key: string, value: string): void {
      switches.set(key, value);
    },
    getSwitchValue(key: string): string {
      return switches.get(key) ?? "";
    },
  },
  whenReady(): Promise<void> {
    return Promise.resolve();
  },
};

export const safeStorage = {
  isEncryptionAvailable: (): boolean => true,
  getSelectedStorageBackend: (): string => "gnome_libsecret",
};

export function switchValue(key: string): string | undefined {
  return switches.get(key);
}
