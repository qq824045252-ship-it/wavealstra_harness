export const sent: Array<{ channel: string; payload: unknown }> = [];
export const BrowserWindow = { getAllWindows: () => [{ webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) } }] };
export const shell = { openExternal: async (_url: string) => undefined };
export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (_value: string): Buffer => { throw new Error('OS encryption must not be used in Node integration fixtures'); },
  decryptString: (_value: Buffer): string => { throw new Error('OS encryption must not be used in Node integration fixtures'); },
};
export const app = { getPath: () => process.cwd(), isPackaged: false };
