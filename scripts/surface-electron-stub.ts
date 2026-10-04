/**
 * electron stub：node 环境下测试 NativeSurfaceCoordinator / ArtifactProtocol
 * 纯逻辑用（4B：Protocol 的 register/unregister 需真实 electron，测试不调用）。
 */
export const protocol = {
  handle: (): void => {
    throw new Error("protocol.handle 需要真实 Electron 运行时（测试不调用）");
  },
  unhandle: (): void => {
    throw new Error("protocol.unhandle 需要真实 Electron 运行时（测试不调用）");
  },
};
