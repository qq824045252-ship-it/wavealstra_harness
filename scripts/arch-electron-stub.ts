/** 测试用 electron 桩（ModeProfileStore 等仅引用 shell，测试不触发真实 Electron）。 */
export const shell = {
  openPath: async (): Promise<string> => "",
  openExternal: async (): Promise<void> => undefined,
};
export const app = {
  getAppPath: (): string => process.cwd(),
};
/** AgentService 集成测试：broadcast 需要 BrowserWindow.getAllWindows()（返回空列表即可） */
export class BrowserWindow {
  contentView = {
    addChildView: (): void => undefined,
    removeChildView: (): void => undefined,
  };

  static getAllWindows(): unknown[] {
    return [];
  }
}
export class WebContentsView {
  webContents = {
    loadURL: async (): Promise<void> => undefined,
    setWindowOpenHandler: (): void => undefined,
    on: (): void => undefined,
  };

  setVisible(): void {}
  setBounds(): void {}
}
export default { app, shell, BrowserWindow, WebContentsView };
export const dialog = { showSaveDialog: async () => ({ canceled: true }) };

/** No encryption available in this non-Electron fixture. Never silently store plaintext. */
export const safeStorage = {
  isEncryptionAvailable: () => false,
  getSelectedStorageBackend: () => "basic_text",
  encryptString: (_value: string): Buffer => { throw new Error("Encryption unavailable in architecture fixture"); },
  decryptString: (_value: Buffer): string => { throw new Error("Encryption unavailable in architecture fixture"); },
};
