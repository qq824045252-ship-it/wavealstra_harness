/**
 * Wave 5A — 预览页 Monaco worker stub（仅测试打包使用）
 *
 * esbuild 不识别 vite 的 `?worker&inline` 后缀，测试 bundle 用本 stub 替换。
 * 构造时抛错 → monaco 内部 catch → 回退主线程执行（console warning，功能可用，
 * 与生产 CSP/worker 失败降级路径一致）。
 */
export default class Wave5aPreviewWorkerStub {
  constructor() {
    throw new Error("wave5a preview: monaco worker 不可用（esbuild stub），回退主线程");
  }
}
