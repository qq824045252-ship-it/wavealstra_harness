/**
 * 安卓端本地数据库（IndexedDB）。
 *
 * 目的：手机端原来没有持久化——每次进任务都要向电脑端全量拉取，离线时整屏空白。
 * 这里把「任务列表快照」和「每个任务的历史」落到本机，使：
 *
 *   - 冷启动先用本地快照渲染，联网成功后再覆盖（stale-while-revalidate）
 *   - 切任务直接读本地历史，网络只做后台校正
 *   - 离线可读已缓存的对话
 *
 * 设计取舍：
 *   - 用浏览器原生 IndexedDB，不引入 SQLite 插件：Capacitor WebView 原生支持，
 *     零新依赖，不需要 Android 侧 gradle 配置，也不需要处理数据库文件路径与升级。
 *   - 只存服务端投影（RemoteTaskHistory / RemoteTaskSummary），不存凭据——凭据仍走
 *     原有 credentialStore 的加密存储，避免把 token 复制进另一个存储介质。
 *   - 全部操作失败即降级为「无缓存」：任何 IndexedDB 异常都不得阻断主流程。
 */
import type { RemoteBootstrap, RemoteRuntimeSnapshot, RemoteTaskHistory, RemoteTaskSummary } from '@mybuddy/shared'

const DB_NAME = 'mybuddy-remote'
/** v1：tasks / histories / meta 三个 store */
const DB_VERSION = 1
const STORE_TASKS = 'tasks'
const STORE_HISTORIES = 'histories'
const STORE_META = 'meta'

/** 本地保留的任务历史条数上限：超出按 lastUsedAt 淘汰，避免无限增长 */
const HISTORY_KEEP = 20
/** 本地任务列表快照的最大条数 */
const TASK_SUMMARY_KEEP = 300

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDatabase(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    // 无 IndexedDB 的环境（Node 测试 / 受限 WebView）直接降级
    if (typeof indexedDB === 'undefined') { resolve(null); return }
    let settled = false
    const finish = (value: IDBDatabase | null) => { if (!settled) { settled = true; resolve(value) } }
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE_TASKS)) db.createObjectStore(STORE_TASKS, { keyPath: 'key' })
        if (!db.objectStoreNames.contains(STORE_HISTORIES)) {
          const store = db.createObjectStore(STORE_HISTORIES, { keyPath: 'taskId' })
          store.createIndex('lastUsedAt', 'lastUsedAt')
        }
        if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META, { keyPath: 'key' })
      }
      request.onsuccess = () => {
        const db = request.result
        // 其它标签页/版本升级时主动让位，避免 blocked 卡死
        db.onversionchange = () => { db.close(); dbPromise = null }
        finish(db)
      }
      request.onerror = () => finish(null)
      request.onblocked = () => finish(null)
    } catch {
      finish(null)
    }
  })
  return dbPromise
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
  })
}

function transactionDone(tx: IDBTransaction): Promise<boolean> {
  return new Promise((resolve) => {
    tx.oncomplete = () => resolve(true)
    tx.onerror = () => resolve(false)
    tx.onabort = () => resolve(false)
  })
}

/** ── 任务列表快照 ───────────────────────────────────────────── */

export interface CachedTaskList {
  at: number
  tasks: RemoteTaskSummary[]
}

/**
 * 保存任务列表快照。key 绑定到服务器（baseUrl + deviceId），
 * 换服务器或重新配对时必须互不污染。
 */
export async function saveTaskList(serverKey: string, bootstrap: RemoteBootstrap): Promise<void> {
  const db = await openDatabase()
  if (!db) return
  try {
    const tx = db.transaction(STORE_TASKS, 'readwrite')
    const tasks = (bootstrap.tasks ?? []).filter((task) => !task.archived).slice(0, TASK_SUMMARY_KEEP)
    tx.objectStore(STORE_TASKS).put({ key: serverKey, at: Date.now(), tasks, bootstrap })
    await transactionDone(tx)
  } catch {
    /* 缓存失败不得影响主流程 */
  }
}

/** 读取任务列表快照；键不匹配（换服务器）时返回 null */
export async function loadTaskList(serverKey: string): Promise<CachedTaskList | null> {
  const db = await openDatabase()
  if (!db) return null
  try {
    const tx = db.transaction(STORE_TASKS, 'readonly')
    const row = await requestToPromise(tx.objectStore(STORE_TASKS).get(serverKey)) as
      | { key: string; at: number; tasks: RemoteTaskSummary[] }
      | null
    if (!row || !Array.isArray(row.tasks)) return null
    return { at: row.at, tasks: row.tasks }
  } catch {
    return null
  }
}

/** ── 单任务历史 ─────────────────────────────────────────────── */

export interface CachedHistory {
  taskId: string
  at: number
  lastUsedAt: number
  history: RemoteTaskHistory
  runtime?: RemoteRuntimeSnapshot
}

export async function saveHistory(
  serverKey: string, taskId: string, history: RemoteTaskHistory, runtime?: RemoteRuntimeSnapshot,
): Promise<void> {
  const db = await openDatabase()
  if (!db) return
  try {
    const tx = db.transaction(STORE_HISTORIES, 'readwrite')
    const store = tx.objectStore(STORE_HISTORIES)
    store.put({ taskId: `${serverKey}\u0000${taskId}`, realTaskId: taskId, serverKey, at: Date.now(), lastUsedAt: Date.now(), history, runtime })
    // 淘汰策略：只在本服务器范围内计数，避免另一台电脑的数据冲掉本机缓存
    const all = await requestToPromise(store.getAll()) as Array<{ taskId: string; serverKey: string; lastUsedAt: number }> | null
    if (all) {
      const mine = all.filter((row) => row.serverKey === serverKey)
      if (mine.length > HISTORY_KEEP) {
        mine.sort((a, b) => a.lastUsedAt - b.lastUsedAt)
        for (const victim of mine.slice(0, mine.length - HISTORY_KEEP)) store.delete(victim.taskId)
      }
    }
    await transactionDone(tx)
  } catch {
    /* 缓存失败不得影响主流程 */
  }
}

export async function loadHistory(serverKey: string, taskId: string): Promise<CachedHistory | null> {
  const db = await openDatabase()
  if (!db) return null
  try {
    const tx = db.transaction(STORE_HISTORIES, 'readwrite')
    const store = tx.objectStore(STORE_HISTORIES)
    const key = `${serverKey}\u0000${taskId}`
    const row = await requestToPromise(store.get(key)) as CachedHistory | null
    if (row?.history) {
      // 刷新 LRU 使用时刻
      store.put({ ...row, lastUsedAt: Date.now() })
      await transactionDone(tx)
      return row
    }
    return null
  } catch {
    return null
  }
}

/** 删除任务时同步清掉本地历史，避免回收后还能读到旧对话 */
export async function deleteHistory(serverKey: string, taskId: string): Promise<void> {
  const db = await openDatabase()
  if (!db) return
  try {
    const tx = db.transaction(STORE_HISTORIES, 'readwrite')
    tx.objectStore(STORE_HISTORIES).delete(`${serverKey}\u0000${taskId}`)
    await transactionDone(tx)
  } catch {
    /* ignore */
  }
}

/** 清空所有本地缓存（断开连接/切换服务器时调用） */
export async function clearAll(): Promise<void> {
  const db = await openDatabase()
  if (!db) return
  try {
    const tx = db.transaction([STORE_TASKS, STORE_HISTORIES, STORE_META], 'readwrite')
    tx.objectStore(STORE_TASKS).clear()
    tx.objectStore(STORE_HISTORIES).clear()
    tx.objectStore(STORE_META).clear()
    await transactionDone(tx)
  } catch {
    /* ignore */
  }
}

/** 服务器标识：baseUrl + deviceId，用于隔离不同电脑的缓存 */
export function serverCacheKey(baseUrl: string, deviceId?: string | null): string {
  return `${baseUrl.replace(/\/$/, '')}\u0000${deviceId ?? ''}`
}
