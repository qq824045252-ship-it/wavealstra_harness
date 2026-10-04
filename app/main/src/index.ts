import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { IPC_CHANNELS, type AppInfo } from '@mybuddy/shared'

const DATA_DIR = join(homedir(), '.mybuddy')

function ensureDataDir(): void {
  const subdirs = [
    'sessions',
    'skills',
    'plugins',
    'memory',
    'artifact-index',
    'tasks',
  ]
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true })
  }
  for (const dir of subdirs) {
    const path = join(DATA_DIR, dir)
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: true })
    }
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  win.once('ready-to-show', () => win.show())

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  ensureDataDir()

  ipcMain.handle(IPC_CHANNELS.PING, () => 'pong')

  ipcMain.handle(IPC_CHANNELS.GET_APP_INFO, (): AppInfo => ({
    name: 'MyBuddy',
    version: app.getVersion(),
    dataDir: DATA_DIR,
  }))

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
