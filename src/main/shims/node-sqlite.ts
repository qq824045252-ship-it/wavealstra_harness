/**
 * Electron 无 Node 内置 node:sqlite。
 * undici 的 SqliteCacheStore 在模块加载时会 require 它；
 * 提供 stub 避免启动崩溃（实际不会走到该缓存实现）。
 */
export class DatabaseSync {
  constructor() {
    throw new Error("node:sqlite is not available in Electron");
  }
}

export class StatementSync {
  constructor() {
    throw new Error("node:sqlite is not available in Electron");
  }
}
