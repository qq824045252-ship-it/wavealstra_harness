import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, type AppInfo } from '@mybuddy/shared'

const api = {
  ping: (): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.PING),
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke(IPC_CHANNELS.GET_APP_INFO),
}

contextBridge.exposeInMainWorld('mybuddy', api)

export type MyBuddyApi = typeof api
