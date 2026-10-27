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
type HeldInputReleaser = () => Promise<unknown>;

let releaser: HeldInputReleaser | undefined;

/** 由 backend 工厂在创建带按住状态的后端时登记（Linux）；其它平台不需要。 */
export function setHeldInputReleaser(next: HeldInputReleaser | undefined): void {
  releaser = next;
}

/** 任务结束/取消时调用：释放后端自己按下、现在仍按着的键和鼠标按钮。 */
export function releaseHeldInput(): void {
  if (!releaser) return;
  void Promise.resolve()
    .then(() => releaser?.())
    .catch(() => undefined);
}
