/**
 * test-store-harness.ts — 在 esbuild+node 环境下挂载真实 appStore 的共用脚手架。
 *
 * 用途：让 Phase 1 的 Problem One（deleteTask）与 Problem Three（regenerateMessage）
 * 能在 headless node 下被真实调用、观测状态迁移，避免脆弱的内部 stub。
 *
 * 关键点（来自 __probe 验证）：
 * 1. appStore 顶层对 `window.localStorage` 有 `typeof window === "undefined"` 守卫，
 *    不设置 window 时也不会在 import 期崩溃。
 * 2. 方法内使用 `window.api?.db?.…` 可选链，把 window.api 设为 {} + 各方法空实现即可。
 * 3. esbuild bundle + electron stub（--alias:electron）已在 architecture test 复用。
 *
 * 注意：多个测试文件各自独立 bundle，进程隔离；本文件只被各测试脚本 import，不做执行入口。
 */

/** 在 import appStore 之前调用：铺好全局 window/api。 */
export function prepareTestEnv(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (!g.window) g.window = {};
  g.window.api = g.window.api ?? {
    db: {
      deleteTask: async () => {},
      upsertTask: async () => {},
      upsertSpace: async () => {},
      listTasks: async () => [],
    },
    artifact: {},
    agent: {
      getContextUsage: async () => undefined,
      loadTaskHistory: async () => ({ messages: [] }),
      regenerate: async () => {},
    },
    browser: {},
    extension: {},
  };
  // localStorage 守卫需要 window.localStorage 存在时才读；node 下保持缺省即可。
}

/** 关闭计数器：deleteTask 对原生视图的显式 close 调用会被记录（供用例8断言）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function installCloseCounters(): { artifactClose: () => number; browserClose: () => number } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = (globalThis as any).window.api as Record<string, { close?: () => void }>;
  api.artifact = Object.assign(api.artifact ?? {}, {
    close: api.artifact?.close ?? (() => {}),
    __closeCount: 0,
  });
  api.browser = Object.assign(api.browser ?? {}, {
    close: api.browser?.close ?? (() => {}),
    __closeCount: 0,
  });
  // 包一层计数
  const artifactTarget = api.artifact;
  const browserTarget = api.browser;
  artifactTarget.close = () => {
    artifactTarget.__closeCount = (artifactTarget.__closeCount ?? 0) + 1;
  };
  browserTarget.close = () => {
    browserTarget.__closeCount = (browserTarget.__closeCount ?? 0) + 1;
  };
  return {
    artifactClose: () => artifactTarget.__closeCount ?? 0,
    browserClose: () => browserTarget.__closeCount ?? 0,
  };
}

/** 简化的最小 Task 构造，避免测试里写满完整字段。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function minimalTask(id: string, title = "task"): any {
  return {
    id,
    title,
    updatedAt: Date.now(),
    status: "completed",
    messages: [],
  };
}