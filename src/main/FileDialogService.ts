import {
  app, BrowserWindow, ipcMain, nativeTheme, screen,
  type IpcMainEvent, type IpcMainInvokeEvent,
} from "electron";
import { mkdir, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, normalize, parse } from "node:path";
import { pathToFileURL } from "node:url";
import { DESKTOP_CHROME } from "../shared/desktop-theme";
import {
  FileDialogIpc, type FileDialogDirectory, type FileDialogEntry, type FileDialogPlace,
  type FileDialogSelection, type FileDialogState, type FileDialogSubmission,
} from "../shared/file-dialog";
import { fileDialogDrivePlaces, isFileDialogName, isFileDialogPath } from "./platform/file-dialog";

interface RequestOptions {
  mode: FileDialogState["mode"];
  title: string;
  confirmLabel: string;
  multiple: boolean;
  showHidden: boolean;
  defaultPath?: string;
  filters: FileDialogState["filters"];
}

interface DialogSession {
  window: BrowserWindow;
  request: RequestOptions;
  state: Promise<FileDialogState>;
  accept: (paths: string[]) => void;
  pendingReplacement?: { path: string; fingerprint: string };
  submitting: boolean;
}

const sessions = new Map<number, DialogSession>();
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
let dialogQueue: Promise<void> = Promise.resolve();
let lastDirectory: string | undefined;

function absoluteDirectory(path: unknown): string {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) {
    throw new Error("请输入完整的文件夹路径。");
  }
  const normalized = normalize(path);
  if (!isFileDialogPath(normalized)) throw new Error("请输入完整的文件夹路径。");
  return normalized;
}

function localName(value: unknown): string {
  if (typeof value !== "string" || !value || value === "." || value === ".."
    || basename(value) !== value || !isFileDialogName(value)) {
    throw new Error("请输入有效的文件名。");
  }
  return value;
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function listDirectory(path: unknown): Promise<FileDialogDirectory> {
  const directory = absoluteDirectory(path);
  const parent = dirname(directory);
  const items = await readdir(directory, { withFileTypes: true });
  const entries: FileDialogEntry[] = [];
  for (const item of items) {
    const itemPath = join(directory, item.name);
    if (item.isDirectory() || item.isFile()) {
      entries.push({ name: item.name, path: itemPath, kind: item.isDirectory() ? "directory" : "file", hidden: item.name.startsWith(".") });
    } else if (item.isSymbolicLink()) {
      const target = await stat(itemPath).catch(() => null);
      if (target?.isDirectory() || target?.isFile()) {
        entries.push({ name: item.name, path: itemPath, kind: target.isDirectory() ? "directory" : "file", hidden: item.name.startsWith(".") });
      }
    }
  }
  entries.sort((a, b) => a.kind === b.kind ? collator.compare(a.name, b.name) : a.kind === "directory" ? -1 : 1);
  return { path: directory, parent: parent === directory ? null : parent, entries };
}

function locations(): FileDialogPlace[] {
  const places: FileDialogPlace[] = [];
  for (const [name, label] of [
    ["home", "个人文件夹"], ["desktop", "桌面"], ["downloads", "下载"], ["documents", "文档"],
  ] as const) {
    try { places.push({ label, path: app.getPath(name) }); }
    catch { /* Platforms may omit an optional known folder. */ }
  }
  return places;
}

async function initialize(request: RequestOptions): Promise<FileDialogState> {
  const places = locations();
  const target = request.defaultPath;
  let requestedFolder: string | undefined;
  let initialName = "";
  if (target && isAbsolute(target) && isFileDialogPath(target)) {
    const targetInfo = await stat(target).catch(() => undefined);
    requestedFolder = targetInfo?.isDirectory() ? target : dirname(target);
    if (!targetInfo?.isDirectory() && request.mode !== "open-directory") initialName = basename(target);
  } else if (target && request.mode === "save") {
    initialName = basename(target);
  }

  let directory: FileDialogDirectory | undefined;
  const starts = [requestedFolder, lastDirectory, ...places.map((place) => place.path), app.getPath("temp")];
  for (const path of new Set(starts)) {
    if (!path) continue;
    directory = await listDirectory(path).catch(() => undefined);
    if (directory) break;
  }
  if (!directory) throw new Error("无法访问本机文件夹。");

  const drives = await fileDialogDrivePlaces();
  const root = parse(directory.path).root;
  const navigation = new Map<string, FileDialogPlace>();
  for (const place of [...places, ...drives, { label: root, path: root }]) navigation.set(normalize(place.path), place);
  return { ...request, initialName, directory, places: [...navigation.values()], theme: nativeTheme.shouldUseDarkColors ? "dark" : "light" };
}

function requireSession(event: IpcMainEvent | IpcMainInvokeEvent): DialogSession {
  const session = sessions.get(event.sender.id);
  if (!session || session.window.isDestroyed() || event.sender !== session.window.webContents
    || !event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    throw new Error("文件对话框已经关闭。");
  }
  return session;
}

function openPicker(parent: BrowserWindow | null, request: RequestOptions): Promise<string[]> {
  const run = dialogQueue.then(() => new Promise<string[]>((resolve, reject) => {
    if (parent?.isDestroyed()) { resolve([]); return; }
    const window = parent && sessions.has(parent.webContents.id) ? parent.getParentWindow() : parent;
    const display = window ? screen.getDisplayMatching(window.getBounds()) : screen.getPrimaryDisplay();
    const width = Math.max(320, Math.min(850, display.workAreaSize.width - 24));
    const height = Math.max(310, Math.min(650, display.workAreaSize.height - 24));
    const dark = nativeTheme.shouldUseDarkColors;
    const picker = new BrowserWindow({
      ...(window ? { parent: window, modal: true } : {}),
      title: request.title,
      width, height, minWidth: Math.min(width, 480), minHeight: Math.min(height, 350),
      frame: false, show: false, skipTaskbar: true, minimizable: false, maximizable: false,
      backgroundColor: DESKTOP_CHROME[dark ? "dark" : "light"].background,
      webPreferences: {
        contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: false,
        preload: join(__dirname, "../preload/fileDialog.js"),
      },
    });
    const senderId = picker.webContents.id;
    picker.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    picker.webContents.on("will-navigate", (event) => event.preventDefault());
    const state = initialize(request);
    // The renderer receives initialization failures through its start request.
    void state.catch(() => undefined);
    sessions.set(senderId, {
      window: picker, request, state, submitting: false,
      accept: (paths) => { resolve(paths); picker.close(); },
    });
    picker.once("closed", () => { sessions.delete(senderId); resolve([]); });
    picker.webContents.once("render-process-gone", () => { if (!picker.isDestroyed()) picker.destroy(); });
    picker.once("ready-to-show", () => { if (!picker.isDestroyed()) picker.show(); });
    const url = new URL("file-dialog.html", process.env.ELECTRON_RENDERER_URL
      ?? pathToFileURL(join(__dirname, "../renderer/index.html")).href);
    // Release the calling workflow even if navigation failed before the UI mounted.
    void picker.loadURL(url.href).catch((error) => {
      reject(error);
      if (!picker.isDestroyed()) picker.destroy();
    });
  }));
  dialogQueue = run.then(() => undefined, () => undefined);
  return run;
}

export async function showOpenFileDialog(
  parent: BrowserWindow | null,
  options: Electron.OpenDialogOptions,
): Promise<Electron.OpenDialogReturnValue> {
  const directory = options.properties?.includes("openDirectory") ?? false;
  const paths = await openPicker(parent, {
    mode: directory ? "open-directory" : "open-file",
    title: options.title ?? (directory ? "选择文件夹" : "打开文件"),
    confirmLabel: options.buttonLabel ?? (directory ? "选择文件夹" : "打开"),
    multiple: options.properties?.includes("multiSelections") ?? false,
    showHidden: options.properties?.includes("showHiddenFiles") ?? false,
    defaultPath: options.defaultPath, filters: options.filters ?? [],
  });
  return { canceled: !paths.length, filePaths: paths };
}

export async function showSaveFileDialog(
  parent: BrowserWindow | null,
  options: Electron.SaveDialogOptions,
): Promise<Electron.SaveDialogReturnValue> {
  const paths = await openPicker(parent, {
    mode: "save", title: options.title ?? "另存为", confirmLabel: options.buttonLabel ?? "保存",
    multiple: false, showHidden: options.properties?.includes("showHiddenFiles") ?? false,
    defaultPath: options.defaultPath, filters: options.filters ?? [],
  });
  return { canceled: !paths.length, filePath: paths[0] };
}

async function submit(session: DialogSession, selection: FileDialogSelection): Promise<FileDialogSubmission> {
  if (session.submitting) throw new Error("正在检查选择。");
  session.submitting = true;
  try {
    if (session.request.mode === "save") {
      if (selection?.kind !== "save") throw new Error("请选择保存位置。");
      const directory = absoluteDirectory(selection.directory);
      if (!(await stat(directory)).isDirectory()) throw new Error("保存位置必须是文件夹。");
      let name = localName(selection.name.trim());
      const extension = session.request.filters[selection.filter]?.extensions.find((entry) => entry !== "*");
      if (extension && !extname(name)) name = name + "." + extension;
      const path = join(directory, name);
      const existing = await stat(path).catch((error) => {
        if (missing(error)) return null;
        throw error;
      });
      if (existing) {
        if (!existing.isFile()) throw new Error("同名项目已存在，请换一个文件名。");
        const fingerprint = [existing.dev, existing.ino, existing.size, existing.mtimeMs].join(":");
        if (!selection.overwrite || session.pendingReplacement?.path !== path
          || session.pendingReplacement?.fingerprint !== fingerprint) {
          session.pendingReplacement = { path, fingerprint };
          return { state: "overwrite", name };
        }
      }
      if (!session.window.isDestroyed()) {
        lastDirectory = directory;
        session.accept([path]);
      }
    } else {
      if (selection?.kind !== "entries" || !Array.isArray(selection.paths)
        || !selection.paths.length || (!session.request.multiple && selection.paths.length !== 1)) {
        throw new Error("请选择要打开的项目。");
      }
      const paths = [...new Set(selection.paths.map(absoluteDirectory))];
      const directory = session.request.mode === "open-directory";
      for (const path of paths) {
        const info = await stat(path);
        if (directory ? !info.isDirectory() : !info.isFile()) throw new Error("选择的项目类型不匹配。");
      }
      if (!session.window.isDestroyed()) {
        lastDirectory = directory ? paths[0] : dirname(paths[0]);
        session.accept(paths);
      }
    }
    return { state: "accepted" };
  } finally {
    session.submitting = false;
  }
}

export function registerFileDialogIpc(): void {
  ipcMain.handle(FileDialogIpc.start, (event) => requireSession(event).state);
  ipcMain.handle(FileDialogIpc.list, (event, directory) => {
    requireSession(event);
    return listDirectory(directory);
  });
  ipcMain.handle(FileDialogIpc.submit, (event, selection) => submit(requireSession(event), selection));
  ipcMain.handle(FileDialogIpc.createFolder, async (event, path, name) => {
    requireSession(event);
    const directory = absoluteDirectory(path);
    const folder = join(directory, localName(typeof name === "string" ? name.trim() : name));
    await mkdir(folder);
    return listDirectory(folder);
  });
  ipcMain.on(FileDialogIpc.cancel, (event) => {
    const session = sessions.get(event.sender.id);
    if (session && event.sender === session.window.webContents && event.senderFrame === event.sender.mainFrame) {
      session.window.close();
    }
  });
}
