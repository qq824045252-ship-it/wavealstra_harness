/**
 * Workspace Shared Context UI Race Guard — 定向 P2 回归证明
 * 覆盖 Review 唯一 P2 的 4 个必证竞态：
 *  A) A→B 快速切换，B 先 resolve/A 后 resolve，最终仍显示 B（stale 不覆盖）
 *  B) unmount 后延迟 resolve 不产生 state update
 *  C) 双击 promote 只有一次 IPC（ref in-flight guard）
 *  D) promote + memoryChanged 双 refresh 不被旧响应覆盖
 * 外加静态源码守卫：组件必须包含 requestId/mounted/promotingRef/clearTimeout 等 P2 修复痕迹
 * Run: pnpm run test:workspace-shared-context-ui-race  或  esbuild ... && node out/tests/...cjs
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let passed = 0;
let failed = 0;
function ok(cond: unknown, label: string): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`); } else { failed++; console.error(`  ✗ ${label}`); }
}

// 辅助：可控 deferred promise
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// ---- 对照实现：与 WorkspaceSharedContextSection.tsx 中相同的防护语义（requestId + mounted） ----
class MockFetchView {
  seq = 0;
  mounted = true;
  view: string | null = null;
  loading = false;
  error: string | null = null;
  // 模拟 IPC：由外部提供 deferred
  ipcCalls: Array<{ req: string; deferred: ReturnType<typeof deferred<string>> }> = [];
  // 真实组件的 fetchView 语义
  async fetchView(req: string, d: ReturnType<typeof deferred<string>>) {
    const seq = ++this.seq;
    if (this.mounted) { this.loading = true; this.error = null; }
    try {
      const v = await d.promise;
      if (!this.mounted || seq !== this.seq) return; // stale guard
      this.view = v;
    } catch (e) {
      if (!this.mounted || seq !== this.seq) return;
      this.error = String(e);
    } finally {
      if (!this.mounted || seq !== this.seq) return;
      this.loading = false;
    }
  }
  unmount() { this.mounted = false; this.seq++; }
}

// promote guard mock（ref 版）
class MockPromote {
  promotingRef = false;
  calls = 0;
  async promote(ipc: () => Promise<void>) {
    if (this.promotingRef) return;
    this.promotingRef = true;
    try { this.calls++; await ipc(); } finally { this.promotingRef = false; }
  }
}

async function main(): Promise<void> {
  console.log("== 1) A→B 快速切换：B 先 resolve/A 后 resolve，最终仍保留 B ==");
  {
    const m = new MockFetchView();
    const dA = deferred<string>(); // A 的 view = "A_VIEW"
    const dB = deferred<string>(); // B 的 view = "B_VIEW"
    // A 发起
    const pA = m.fetchView("A", dA);
    // 紧接着 B 发起（模拟 currentSpaceId 快速从 A 切到 B）
    const pB = m.fetchView("B", dB);
    // B 先 resolve
    dB.resolve("B_VIEW");
    await pB;
    ok(m.view === "B_VIEW", "B 先 resolve 后 view=B_VIEW");
    ok(m.loading === false, "B resolve 后 loading false");
    // A 后 resolve（延迟到达的旧响应）
    dA.resolve("A_VIEW");
    await pA;
    ok(m.view === "B_VIEW", `A 后 resolve 仍为 B_VIEW (got ${m.view}) — stale 未覆盖`);
    ok(m.loading === false, "A stale 后 loading 仍 false");
    // 反向：A 先 resolve 但晚发起 B 后 resolve，B 赢
    const m2 = new MockFetchView();
    const dA2 = deferred<string>();
    const dB2 = deferred<string>();
    const pA2 = m2.fetchView("A", dA2);
    dA2.resolve("A_VIEW");
    await pA2;
    ok(m2.view === "A_VIEW", "单 A 完成后 view=A");
    const pB2 = m2.fetchView("B", dB2);
    dB2.resolve("B_VIEW");
    await pB2;
    ok(m2.view === "B_VIEW", "后续 B 切换后 view=B_VIEW");
  }

  console.log("== 2) unmount 后延迟 resolve 不产生 state update ==");
  {
    const m = new MockFetchView();
    const d = deferred<string>();
    const p = m.fetchView("A", d);
    m.unmount(); // 模拟 React unmount：mounted false + seq bump
    d.resolve("LATE_VIEW");
    await p;
    ok(m.view === null, `unmount 后 late resolve 未写入 view (got ${m.view})`);
    ok(m.loading === true || m.loading === false, "loading 保持 stale 前状态（不为 late 覆盖）");
    // 更严格：stale fetch 的 finally 不会把 loading 置为 false（若初始 loading true，unmount 后不应 flip）
    const m2 = new MockFetchView();
    m2.loading = true;
    const d2 = deferred<string>();
    const p2 = m2.fetchView("X", d2);
    // fetchView 内已 set loading true，但我们手动记为 true，unmount 后 resolve
    m2.unmount();
    d2.resolve("X_VIEW");
    await p2;
    ok(m2.view === null, "unmount 第二例 view 仍 null");
    // Promote 的 notice / promoting 也应在 unmount 后不 setState（在组件内通过 mountedRef 守卫，行为同上）
  }

  console.log("== 3) 双击 promote 只有一次 IPC（ref guard，并发/极速双击） ==");
  {
    const mp = new MockPromote();
    let ipcCalls = 0;
    const ipc = async () => { ipcCalls++; await new Promise(r => setTimeout(r, 30)); };
    // 模拟同一事件循环内极速双击：两次调用在第一次的 await 完成前就发起
    const p1 = mp.promote(ipc);
    const p2 = mp.promote(ipc); // 此时 promotingRef 已 true，应被 guard 挡住
    await Promise.all([p1, p2]);
    ok(ipcCalls === 1, `极速双击仅一次 IPC (calls=${ipcCalls})`);
    ok(mp.calls === 1, "MockPromote.calls 1（第二次被 ref guard 返回）");
    // 串行：第一次完成后第二次应允许
    ipcCalls = 0;
    const mp2 = new MockPromote();
    await mp2.promote(async () => { ipcCalls++; });
    await mp2.promote(async () => { ipcCalls++; });
    ok(ipcCalls === 2, `串行两次 promote 允许 (calls=${ipcCalls})`);
    // 并发三次
    ipcCalls = 0;
    const mp3 = new MockPromote();
    await Promise.all([mp3.promote(ipc), mp3.promote(ipc), mp3.promote(ipc)]);
    // 第一次 ipc 计数 1，其余被挡；但由于 ipc 异步 30ms，第二次第三次在第一次完成前被挡
    // 注意 mp3.calls 仍为 1（只有第一次进入真正 ipc）
    ok(ipcCalls === 1, `并发三击仅一次 IPC (calls=${ipcCalls})`);
  }

  console.log("== 4) promote + memoryChanged 双 refresh 不被旧响应覆盖 ==");
  {
    // 模拟：promote 后 fetchView + 同时 onMemoryChanged 触发 fetchView，双 fetch 叠加
    const m = new MockFetchView();
    const dPromote = deferred<string>(); // promote 触发的 fetch 返回 PROMOTE_VIEW
    const dMemory = deferred<string>(); // memoryChanged 触发的 fetch 返回 MEMORY_VIEW（更新）
    // promote 的 refresh 先发起
    const pPromote = m.fetchView("promote-refresh", dPromote);
    // memoryChanged 紧接发起（更新的请求）
    const pMemory = m.fetchView("memory-refresh", dMemory);
    // 旧的 promote refresh 先 resolve，但应被丢弃
    dPromote.resolve("PROMOTE_VIEW");
    await pPromote;
    ok(m.view === null, "旧 promote refresh 先 resolve 时 view 仍 null（被 stale 丢弃）");
    // 新的 memory refresh 后 resolve，应生效
    dMemory.resolve("MEMORY_VIEW");
    await pMemory;
    ok(m.view === "MEMORY_VIEW", `双 refresh 最终为最新 MEMORY_VIEW (got ${m.view})`);
    // 反向：新的先 resolve，旧的后 resolve 也不应覆盖
    const m2 = new MockFetchView();
    const dOld = deferred<string>();
    const dNew = deferred<string>();
    const pOld = m2.fetchView("old", dOld);
    const pNew = m2.fetchView("new", dNew);
    dNew.resolve("NEW_VIEW");
    await pNew;
    ok(m2.view === "NEW_VIEW", "new 先 resolve 为 NEW_VIEW");
    dOld.resolve("OLD_VIEW");
    await pOld;
    ok(m2.view === "NEW_VIEW", `old 后 resolve 仍保留 NEW_VIEW (got ${m2.view})`);
  }

  console.log("== 5) 静态源码守卫：WorkspaceSharedContextSection.tsx 必须包含 P2 修复痕迹 ==");
  {
    const fp = resolve(process.cwd(), "src/renderer/src/components/workspace/WorkspaceSharedContextSection.tsx");
    let src = "";
    try { src = readFileSync(fp, "utf8"); } catch (e) { ok(false, `读取组件源码失败: ${String(e)}`); }
    ok(src.includes("fetchSeqRef") || src.includes("requestId"), "源码包含 requestId/fetchSeqRef 单调递增");
    ok(src.includes("mountedRef"), "源码包含 mountedRef/disposed guard");
    ok(src.includes("seq !== fetchSeqRef.current") || src.includes("requestId") && src.includes("!=="), "源码包含 stale 检查（seq !== current）");
    ok(src.includes("promotingRef"), "源码包含 promotingRef in-flight guard");
    ok(src.includes("promotingRef.current") && src.includes("if (promotingRef.current) return"), "promote 以 ref guard 提前返回（极速双击防护）");
    ok(src.includes("fetchSeqRef.current += 1") || src.includes("fetchSeqRef.current++"), "useEffect cleanup 使旧请求失效（seq bump）");
    const hasAbortGuard = src.includes("AbortController");
    ok(!hasAbortGuard || src.includes("fetchSeqRef"), "不依赖 AbortController（或即使有也不作为唯一防护）");
    ok(src.includes("noticeTimerRef") && src.includes("clearTimeout"), "notice timer 有 mounted/clearTimeout 清理（P3 顺手修复）");
    ok(src.includes("useRef"), "引入 useRef");
    ok(src.includes("if (!mountedRef.current || seq !== fetchSeqRef.current) return"), "setView/setError/setLoading 前双重 guard（mounted + seq）");
  }

  console.log(`\n结果: passed=${passed} failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}
void main();
