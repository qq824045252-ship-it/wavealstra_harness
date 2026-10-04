export const IPC_CHANNELS = {
  PING: 'ping',
  GET_APP_INFO: 'get-app-info',
} as const

export type IpcChannel = typeof IPC_CHANNELS[keyof typeof IPC_CHANNELS]

export interface AppInfo {
  name: string
  version: string
  dataDir: string
}

export * from './remote-contract'
