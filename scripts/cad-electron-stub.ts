/**
 * electron stub（CAD 测试专用）：node 环境下测试 FreeCadInterop/CadArtifactService
 * 用。shell.openPath 只在实际调用时才会执行（测试注入 openPath 则不触发）。
 */
export const shell = {
  openPath: async (): Promise<string> => {
    throw new Error("shell.openPath 需要真实 Electron 运行时（测试注入 openPath）");
  },
};

export const protocol = {
  handle: (): void => {
    throw new Error("protocol.handle 需要真实 Electron 运行时（测试不调用）");
  },
  unhandle: (): void => {
    throw new Error("protocol.unhandle 需要真实 Electron 运行时（测试不调用）");
  },
};
