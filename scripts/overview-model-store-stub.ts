/**
 * overview-model-store-stub.ts — 「概览」实现夹具的 store 替身。
 *
 * 只暴露 RuntimeObservatory 读取的字段（任务/终端/模型/抽屉），
 * 让 UI 夹具能验证「每个子代理显示哪个模型」，不连真实主进程与数据库。
 */
export const state: any = {
  activeTaskId: "task-ui",
  tasks: [] as any[],
  terminalSessions: {} as Record<string, unknown>,
  activeModelId: "",
  models: [] as any[],
  openSubagentDrawer: (id: string) => {
    (globalThis as any).openedSubagent = id;
  },
};

export const useAppStore = Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
  getState: () => state,
});

export const currentTerminalOwnerKey = (): string => String(state.activeTaskId ?? "task-ui");
