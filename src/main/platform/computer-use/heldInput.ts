import type { ResourceRecoveryAttempt } from "../../../shared/resource-recovery";

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
type HeldInputReleaser = (taskId?: string, recovery?: ResourceRecoveryAttempt) => Promise<unknown>;

let releaser: HeldInputReleaser | undefined;
const pending = new Map<string, { operation: Promise<HeldInputCleanupReceipt>; recovery?: ResourceRecoveryAttempt }>();
export interface HeldInputCleanupReceipt { inputReleased: true; queueDrained: true; receipt: string }
const listeners = new Set<(taskId: string | undefined, receipt: HeldInputCleanupReceipt) => void>();
let cleanupSequence = 0, globalCleanupSequence = 0;
const cleanupByTask = new Map<string, number>();
export function heldInputCleanupGeneration(taskId: string): number { return Math.max(globalCleanupSequence, cleanupByTask.get(taskId) ?? 0); }
export function onHeldInputReleased(listener: (taskId: string | undefined, receipt: HeldInputCleanupReceipt) => void): () => void {
  listeners.add(listener); return () => listeners.delete(listener);
}

/** 由 backend 工厂登记；后端必须能证明本驱动的输入已释放、队列已排空。 */
export function setHeldInputReleaser(next: HeldInputReleaser | undefined): void {
  releaser = next;
  pending.clear();
}

/** 任务结束/取消时调用：释放后端自己按下、现在仍按着的键和鼠标按钮。 */
export function releaseHeldInput(taskId?: string, recovery?: ResourceRecoveryAttempt): void {
  const release = releaser;
  if (!release) return;
  // Reserve the backend queue position before the next execution can enqueue
  // a new DOWN for the same task. Deferring this call to a microtask lets old
  // execution cleanup run after (and release) the next execution's input.
  let operation: Promise<HeldInputCleanupReceipt>;
  try {
    recovery?.assertCurrent();
    operation = release(taskId, recovery).then(() => {
      recovery?.assertCurrent();
      if (releaser !== release) throw new Error("输入后端已切换，旧清理回执不可复用");
      const identity = recovery ? `${recovery.token}:${recovery.attempt}:` : "";
      const receipt: HeldInputCleanupReceipt = { inputReleased: true, queueDrained: true, receipt: `input-release:${taskId ?? "*"}:${identity}${Date.now()}` };
      // A recovery receipt belongs to its three-stage reconciliation. Broadcasting
      // it here would release a quarantined held-input lease before effect proof,
      // or let a late receipt from a cancelled probe settle another generation.
      if (!recovery) {
        const sequence = ++cleanupSequence;
        if (taskId) cleanupByTask.set(taskId, sequence); else globalCleanupSequence = sequence;
        for (const listener of listeners) { try { listener(taskId, receipt); } catch { /* A failed persistent settlement leaves its lease fenced. */ } }
      }
      return receipt;
    });
  } catch (error) {
    // Replace a previous successful receipt even when queue submission fails
    // synchronously. Cancellation remains synchronous; takeover awaits failure.
    operation = Promise.reject(error);
  }
  pending.set(taskId ?? "*", { operation, recovery });
  void operation.catch(() => undefined);
}

/** Cancellation remains synchronous; safe resource takeover explicitly awaits this receipt. */
export async function waitForHeldInputRelease(taskId?: string, recovery?: ResourceRecoveryAttempt): Promise<HeldInputCleanupReceipt> {
  if (!releaser) throw new Error("桌面后端未初始化，缺少输入释放证明");
  const cleanup = pending.get(taskId ?? "*");
  if (!cleanup || cleanup.recovery !== recovery) throw new Error("尚未提交本轮后端输入清理，不能证明资源可接管");
  // Do not race this wait against cancellation: the recovery runner retains the
  // original promise as a barrier until the backend queue has actually stopped.
  const receipt = await cleanup.operation;
  recovery?.assertCurrent();
  return receipt;
}
