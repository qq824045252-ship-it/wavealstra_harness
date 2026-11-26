import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const appEvents = new EventEmitter();

function resolveDataDir(): string {
  const dir = process.env.MYBUDDY_DATA_DIR?.trim() || join(homedir(), ".mybuddy");
  try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return dir;
}

export const app = {
  isPackaged: process.env.MYBUDDY_IS_PACKAGED === "1",
  getAppPath: (): string => process.env.MYBUDDY_APP_PATH?.trim() || process.cwd(),
  getPath: (name: string): string => {
    if (name === "userData" || name === "appData") return resolveDataDir();
    if (name === "home") return homedir();
    if (name === "temp") return tmpdir();
    return resolveDataDir();
  },
  getVersion: (): string => process.env.MYBUDDY_APP_VERSION?.trim() || "0.0.0-host",
  getName: (): string => "MyBuddyPiHost",
  whenReady: async (): Promise<void> => undefined,
  on: appEvents.on.bind(appEvents),
  once: appEvents.once.bind(appEvents),
  off: appEvents.off.bind(appEvents),
  quit: (): void => undefined,
  exit: (code = 0): never => process.exit(code),
  getLoginItemSettings: () => ({ openAtLogin: false }),
  setLoginItemSettings: (): void => undefined,
};

export const shell = {
  openPath: async (): Promise<string> => "",
  openExternal: async (): Promise<void> => undefined,
};

export class BrowserWindow {
  contentView = {
    addChildView: (): void => undefined,
    removeChildView: (): void => undefined,
  };
  webContents = {
    send: (): void => undefined,
    isDestroyed: (): boolean => true,
  };

  isDestroyed(): boolean {
    return true;
  }

  static getAllWindows(): BrowserWindow[] {
    return [];
  }
}

export const BaseWindow = BrowserWindow;

export class WebContentsView {
  webContents = {
    loadURL: async (): Promise<void> => undefined,
    setWindowOpenHandler: (): void => undefined,
    on: (): void => undefined,
    send: (): void => undefined,
  };

  setVisible(): void {}
  setBounds(): void {}
}

export const dialog = {
  showSaveDialog: async () => ({ canceled: true as const }),
  showOpenDialog: async () => ({ canceled: true as const, filePaths: [] as string[] }),
};

export const ipcMain = {
  handle: (): void => undefined,
  removeHandler: (): void => undefined,
  on: (): void => undefined,
};

export const nativeTheme = {
  shouldUseDarkColors: false,
  on: (): void => undefined,
};

export const screen = {
  getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1280, height: 800 }, scaleFactor: 1 }),
  getAllDisplays: () => [],
};

export const protocol = {
  handle: (): void => undefined,
  registerSchemesAsPrivileged: (): void => undefined,
};

export const session = {
  fromPartition: () => {
    throw new Error("Browser sessions require Electron UI process");
  },
};

export const safeStorage = {
  isEncryptionAvailable: (): boolean => false,
  getSelectedStorageBackend: (): string => "basic_text",
  encryptString: (_value: string): Buffer => {
    throw new Error("safeStorage encryption requires Electron UI process");
  },
  decryptString: (_value: Buffer): string => {
    throw new Error("safeStorage decryption requires Electron UI process");
  },
};

export default {
  app,
  shell,
  BrowserWindow,
  BaseWindow,
  WebContentsView,
  dialog,
  ipcMain,
  nativeTheme,
  screen,
  protocol,
  session,
  safeStorage,
};
