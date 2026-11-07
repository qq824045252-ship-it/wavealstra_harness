/**
 * Computer Use「按住状态」清理的注册表（平台无关、无依赖的小模块）。
 *
 * 为什么需要它：Linux 后端要释放自己按下的键/按钮，而清理时机在 capabilities 层的
 * `ComputerUseRunCoordinator.endTask()/cancel()`。如果 coordinator 直接 import
 * `ComputerAutomationService`，会形成
 * `platform/computer-use/index → windows backend → coordinator → ComputerAutomationService → index`
 * 的循环，模块初始化时 `createComputerUseBackend()` 里的工厂缓存还没建好，直接抛
 * `Cannot read properties of undefined`。所以中间放一层没有依赖的注册表：
 * 工厂在创建 backend 时登记，coordinator 只管调用。
 */
type HeldInputReleaser = (taskId?: string) => Promise<unknown>;

let releaser: HeldInputReleaser | undefined;
const pending = new Map<string, Promise<HeldInputCleanupReceipt>>();
export interface HeldInputCleanupReceipt { inputReleased: true; queueDrained: true; receipt: string }
const listeners = new Set<(taskId: string | undefined, receipt: HeldInputCleanupReceipt) => void>();
let cleanupSequence = 0, globalCleanupSequence = 0;
const cleanupByTask = new Map<string, number>();
export function heldInputCleanupGeneration(taskId: string): number { return Math.max(globalCleanupSequence, cleanupByTask.get(taskId) ?? 0); }
export function onHeldInputReleased(listener: (taskId: string | undefined, receipt: HeldInputCleanupReceipt) => void): () => void {
  listeners.add(listener); return () => listeners.delete(listener);
}

/** 由 backend 工厂在创建带按住状态的后端时登记（Linux）；其它平台不需要。 */
export function setHeldInputReleaser(next: HeldInputReleaser | undefined): void {
  releaser = next;
  if (!next) pending.clear();
}

/** 任务结束/取消时调用：释放后端自己按下、现在仍按着的键和鼠标按钮。 */
export function releaseHeldInput(taskId?: string): void {
  const release = releaser;
  if (!release) return;
  // Reserve the backend queue position before the next execution can enqueue
  // a new DOWN for the same task. Deferring this call to a microtask lets old
  // execution cleanup run after (and release) the next execution's input.
  try {
    const operation = release(taskId).then(() => {
      const sequence = ++cleanupSequence;
      if (taskId) cleanupByTask.set(taskId, sequence); else globalCleanupSequence = sequence;
      const receipt: HeldInputCleanupReceipt = { inputReleased: true, queueDrained: true, receipt: `input-release:${taskId ?? "*"}:${Date.now()}` };
      for (const listener of listeners) { try { listener(taskId, receipt); } catch { /* A failed persistent settlement leaves its lease fenced. */ } }
      return receipt;
    });
    pending.set(taskId ?? "*", operation);
    void operation.catch(() => undefined);
  }
  catch { /* Task cancellation remains synchronous; the backend retains failed cleanup state. */ }
}

/** Cancellation remains synchronous; safe resource takeover explicitly awaits this receipt. */
export async function waitForHeldInputRelease(taskId?: string): Promise<HeldInputCleanupReceipt> {
  if (!releaser) throw new Error("桌面后端未初始化，缺少输入释放证明");
  const operation = pending.get(taskId ?? "*");
  if (!operation) throw new Error("尚未提交后端输入清理，不能证明资源可接管");
  return await operation;
}
