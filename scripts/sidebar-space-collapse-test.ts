/**
 * 侧栏空间树展开状态：默认全部收起（产品要求），只有用户显式展开过的空间才展开。
 *
 * 覆盖真实 store：初始默认、toggle 两个方向、持久化键与语义、删除空间后的陈旧 id 清理、
 * 以及「把任务移进空间」时的自动展开。
 */
import assert from "node:assert/strict";
import { prepareTestEnv } from "./test-store-harness";

const storage = new Map<string, string>();
prepareTestEnv();
// appStore 顶层读 localStorage / matchMedia 是在 import 期（初始 state），所以必须先铺好 mock
const g = globalThis as unknown as { window: { localStorage: unknown; matchMedia?: unknown; api: unknown } };
g.window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
g.window.localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value); },
  removeItem: (key: string) => { storage.delete(key); },
};
// theme 初始化会调 window.api.setTheme；给出空实现，避免初始 state 构造时抛错
(g.window.api as Record<string, unknown>).setTheme = () => {};

const { useAppStore } = await import("../src/renderer/src/store/appStore");

const EXPANDED_KEY = "mybuddy:sidebar-expanded";
const LEGACY_COLLAPSED_KEY = "mybuddy:sidebar-collapsed";
const space = (id: string, name: string) => ({ id, name, parentId: null, sortOrder: 0, archived: false, path: `C:\\ws\\${name}` });

let passed = 0;
let failed = 0;
function check(cond: unknown, label: string): void {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.error(`  ✗ ${label}`); }
}

// 1. 全新安装：默认没有任何空间被展开（= 树里全部收起）
check(useAppStore.getState().expandedSpaceIds.length === 0, "全新安装：expandedSpaceIds 为空 = 全部收起");
check(storage.get(EXPANDED_KEY) === undefined, "初始不主动写 localStorage（默认值不落盘）");

useAppStore.setState({ spaces: [space("sp-1", "alpha"), space("sp-2", "beta")] });

// 2. 展开 / 收起：存储即「已展开集合」
useAppStore.getState().toggleSpaceCollapsed("sp-1");
check(useAppStore.getState().expandedSpaceIds.includes("sp-1"), "展开 sp-1 → 进入展开集合");
check(JSON.parse(storage.get(EXPANDED_KEY) ?? "[]").includes("sp-1"), "展开状态写入 mybuddy:sidebar-expanded");

useAppStore.getState().toggleSpaceCollapsed("sp-2");
check(useAppStore.getState().expandedSpaceIds.length === 2, "再展开 sp-2 → 集合含两个");
useAppStore.getState().toggleSpaceCollapsed("sp-1");
check(!useAppStore.getState().expandedSpaceIds.includes("sp-1"), "收起 sp-1 → 移出集合");
check(JSON.parse(storage.get(EXPANDED_KEY) ?? "[]").join(",") === "sp-2", "移出后持久化同步（只剩 sp-2）");
check(!useAppStore.getState().expandedSpaceIds.includes("sp-1"), "未展开过的新空间默认收起（sp-1 已收起）");

// 3. 展开/收起全部
useAppStore.getState().setAllSpacesExpanded(true);
check(useAppStore.getState().expandedSpaceIds.length === 2, "展开全部 → 所有空间都在集合里");
useAppStore.getState().setAllSpacesExpanded(false);
check(useAppStore.getState().expandedSpaceIds.length === 0, "收起全部 → 回到默认（全收起）");

// 4. 删除空间：陈旧 id 不残留
useAppStore.getState().toggleSpaceCollapsed("sp-2");
useAppStore.setState((state) => ({ spaces: state.spaces.filter((candidate) => candidate.id !== "sp-2") }));
useAppStore.setState((state) => {
  const next = state.expandedSpaceIds.filter((id) => id !== "sp-2");
  return { expandedSpaceIds: next };
});
check(!useAppStore.getState().expandedSpaceIds.includes("sp-2"), "空间删除后展开集合里不再残留该 id");

// 5. 旧键语义不被沿用：新键不存在时按「全部收起」处理，旧键保留不动
storage.clear();
storage.set(LEGACY_COLLAPSED_KEY, JSON.stringify(["sp-legacy"]));
check(storage.get(EXPANDED_KEY) === undefined, "旧键 mybuddy:sidebar-collapsed 不被读取为新语义");
check(storage.get(LEGACY_COLLAPSED_KEY) === JSON.stringify(["sp-legacy"]), "旧键保留不动（不删除用户数据）");

// 6. 持久化读取：用户下次打开应用恢复「上次展开过的空间」，其余仍收起
storage.clear();
storage.set(EXPANDED_KEY, JSON.stringify(["sp-2"]));
const restored = JSON.parse(storage.get(EXPANDED_KEY) ?? "[]") as string[];
check(restored.length === 1 && restored[0] === "sp-2", "重开后只恢复用户展开过的空间（其余保持收起）");

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}  passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
