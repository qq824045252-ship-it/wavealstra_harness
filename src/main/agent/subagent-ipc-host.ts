/**
 * Subagent 面板 IPC 宿主。
 *
 * 渲染层在窗口一出来就会 invoke `subagent:active`（概览 RuntimeObservatory），
 * 但扩展 factory 要等第一次 createSession 才跑。若通道此时还没 handle，
 * Electron 会在主进程打 “No handler registered”，try/catch 也挡不住这条日志。
 *
 * 这里在主进程启动时先挂上稳定 handler；扩展加载后通过 globalThis 宿主槽
 * 注入 backend，handler 本身永不卸载、永不二次 handle。
 */
import { SubagentIpc } from "../../shared/agent-ipc";

/** 内建 Subagent Capability 通过同一字符串定位宿主，避免能力实现反向依赖宿主模块。 */
export const SUBAGENT_IPC_HOST_KEY = "__mybuddySubagentIpcHost";

export interface SubagentIpcBackend {
  /** taskId 是唯一作用域：缺省或不匹配时必须返回空表，绝不做跨任务并集。 */
  active: (taskId: string) => unknown;
  transcript: (subagentId: string) => unknown;
  steer: (subagentId: string, instruction: string) => unknown | Promise<unknown>;
  cancel: (subagentId: string) => unknown | Promise<unknown>;
}

export interface SubagentIpcHostSlot {
  setBackend: (backend: SubagentIpcBackend | null) => void;
  getBackend: () => SubagentIpcBackend | null;
}

const EMPTY_TRANSCRIPT = { record: null, entries: [] as unknown[], ended: true };
const NOT_READY = { ok: false, delivered: "queued" as const, message: "subagent 扩展尚未就绪" };

const HOSTED_CHANNELS = new Set<string>([
  SubagentIpc.active,
  SubagentIpc.transcript,
  SubagentIpc.steer,
  SubagentIpc.cancel,
]);

let backend: SubagentIpcBackend | null = null;
const adopted = new Map<string, (...args: unknown[]) => unknown>();
let registered = false;
let handlePatched = false;
/** 被补丁覆写的目标与其原始 handle：reset 时必须还原，否则同一 ipcMain 对象二次 register 会静默零注册。 */
type IpcMainHandleLike = {
  handle: (channel: string, listener: (...args: unknown[]) => unknown) => void;
};
let patchedTarget: IpcMainHandleLike | null = null;
let originalHandle: IpcMainHandleLike["handle"] | null = null;

export function setSubagentIpcBackend(next: SubagentIpcBackend | null): void {
  backend = next;
}

export function getSubagentIpcBackend(): SubagentIpcBackend | null {
  return backend;
}

function invokeAdopted(channel: string, ...args: unknown[]): unknown {
  const fn = adopted.get(channel);
  if (!fn) return undefined;
  return fn({}, ...args);
}

/** 作用域归一：非字符串/空白/纯空格一律视为无作用域。 */
function normalizeTaskScope(taskId: unknown): string {
  return typeof taskId === "string" ? taskId.trim() : "";
}

export function handleSubagentActive(taskId?: unknown): unknown {
  const scope = normalizeTaskScope(taskId);
  // 无作用域不返回全局表：这是 user 可见的“跨任务乱串”入口
  if (!scope) return [];
  try {
    if (backend) return backend.active(scope);
    const adoptedResult = invokeAdopted(SubagentIpc.active, scope);
    return adoptedResult === undefined ? [] : adoptedResult;
  } catch {
    return [];
  }
}

export function handleSubagentTranscript(subagentId: unknown): unknown {
  try {
    const id = typeof subagentId === "string" ? subagentId : "";
    if (backend) return backend.transcript(id);
    const adoptedResult = invokeAdopted(SubagentIpc.transcript, id);
    return adoptedResult === undefined ? EMPTY_TRANSCRIPT : adoptedResult;
  } catch {
    return EMPTY_TRANSCRIPT;
  }
}

export async function handleSubagentSteer(subagentId: unknown, instruction: unknown): Promise<unknown> {
  try {
    const id = typeof subagentId === "string" ? subagentId : "";
    const text = typeof instruction === "string" ? instruction : "";
    if (backend) return await backend.steer(id, text);
    const adoptedResult = invokeAdopted(SubagentIpc.steer, id, text);
    return adoptedResult === undefined ? NOT_READY : await adoptedResult;
  } catch (err) {
    return {
      ok: false,
      delivered: "queued",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function handleSubagentCancel(subagentId: unknown): Promise<unknown> {
  try {
    const id = typeof subagentId === "string" ? subagentId : "";
    if (backend) return await backend.cancel(id);
    const adoptedResult = invokeAdopted(SubagentIpc.cancel, id);
    return adoptedResult === undefined ? { ok: false, message: NOT_READY.message } : await adoptedResult;
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

function exposeGlobalHost(): void {
  const slot: SubagentIpcHostSlot = {
    setBackend: setSubagentIpcBackend,
    getBackend: getSubagentIpcBackend,
  };
  (globalThis as Record<string, unknown>)[SUBAGENT_IPC_HOST_KEY] = slot;
}

function patchHandleToAdoptLegacy(ipcMain: IpcMainHandleLike): void {
  if (handlePatched) return;
  handlePatched = true;
  patchedTarget = ipcMain;
  originalHandle = ipcMain.handle;
  const original = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel: string, listener: (...args: unknown[]) => unknown) => {
    if (HOSTED_CHANNELS.has(channel)) {
      adopted.set(channel, listener);
      return;
    }
    return original(channel, listener);
  };
}

export function registerSubagentIpcHost(ipcMain: {
  handle: (channel: string, listener: (...args: unknown[]) => unknown) => void;
}): void {
  if (registered) return;
  registered = true;
  exposeGlobalHost();
  ipcMain.handle(SubagentIpc.active, (_e: unknown, taskId: unknown) => handleSubagentActive(taskId));
  ipcMain.handle(SubagentIpc.transcript, (_e: unknown, subagentId: unknown) =>
    handleSubagentTranscript(subagentId),
  );
  ipcMain.handle(SubagentIpc.steer, (_e: unknown, subagentId: unknown, instruction: unknown) =>
    handleSubagentSteer(subagentId, instruction),
  );
  ipcMain.handle(SubagentIpc.cancel, (_e: unknown, subagentId: unknown) =>
    handleSubagentCancel(subagentId),
  );
  // 旧扩展仍会 ipcMain.handle 同名通道；拦截下来当 backend，避免 “second handler”
  patchHandleToAdoptLegacy(ipcMain);
}

/** 仅测试用：清掉注册标记与 backend，避免用例串扰。 */
export function resetSubagentIpcHostForTests(): void {
  backend = null;
  adopted.clear();
  registered = false;
  handlePatched = false;
  // 还原被覆写的 handle：否则同一 ipcMain 对象再次 register 时，补丁会基于已包装的 handle
  // 再包一层，四个宿主通道被吞进 adopted，真实注册数静默变成 0（用例串扰型假绿）。
  if (patchedTarget && originalHandle) patchedTarget.handle = originalHandle;
  patchedTarget = null;
  originalHandle = null;
  try {
    delete (globalThis as Record<string, unknown>)[SUBAGENT_IPC_HOST_KEY];
  } catch {
    (globalThis as Record<string, unknown>)[SUBAGENT_IPC_HOST_KEY] = undefined;
  }
}
