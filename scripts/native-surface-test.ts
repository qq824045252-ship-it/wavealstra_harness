/**
 * NativeSurfaceCoordinator Behavior Tests — V3.5 Wave 4A（§75-77）
 *
 * 覆盖（4A Gate）：
 *   T1  resize 连续更新 bounds 正常（每次 requestBounds 跟随 setBounds）
 *   T2  hide/show 幂等（同值重复请求不重复触达 host）
 *   T3  blocker 叠加正确（两个来源同时隐藏，只隐藏一次）
 *   T4  多 blocker 删一个不能误显示（§76 token 集合语义）
 *   T5  artifact 切换不闪旧 surface（loadArtifact 期间强制隐藏，完成后恢复）
 *   T6  generation 变化后旧请求不能复活 surface（A→B 快速切换，A 迟到完成不显示）
 *   T7  close 后迟到事件不能重建错误状态（closed 期间任何请求不复活）
 *   T8  close 清空 blocker（在途 load 的 token 不残留，重载后正常显示）
 *   T9  bounds 无效（<8px）视为隐藏
 *   T10 destroy 后一切请求忽略（host 不再被触碰）
 *   T11 PreviewHost 不获得业务状态 ownership（Coordinator 独占显示决策）
 *
 * 运行：pnpm test:native-surface（esbuild bundle → node，host 为 mock，无需 Electron）
 */
import { NativeSurfaceCoordinator, SURFACE_MAIN, type NativeSurfaceHost } from "../src/main/artifact/NativeSurfaceCoordinator";

type Rect = { x: number; y: number; width: number; height: number };

/** 可注入的 mock host：记录调用序列，load 返回可控 Promise */
class MockHost implements NativeSurfaceHost {
  calls: string[] = [];
  private pendings: Array<{ url: string; resolve: () => void }> = [];

  load(url: string): Promise<void> {
    this.calls.push(`load(${url})`);
    return new Promise((resolve) => this.pendings.push({ url, resolve }));
  }
  setBounds(r: Rect): void {
    this.calls.push(`setBounds(${r.x},${r.y},${r.width}x${r.height})`);
  }
  show(): void {
    this.calls.push("show()");
  }
  hide(): void {
    this.calls.push("hide()");
  }
  reload(): void {
    this.calls.push("reload()");
  }
  close(): void {
    this.calls.push("close()");
  }
  dispose(): void {
    this.calls.push("dispose()");
  }

  /** resolve 第 n 个在途 load（1-based，按顺序） */
  finish(n: number): void {
    const p = this.pendings.splice(n - 1, 1)[0];
    if (!p) throw new Error(`no pending load #${n}`);
    p.resolve();
  }
  pendingCount(): number {
    return this.pendings.length;
  }
  lastShowAt(): number {
    return this.calls.lastIndexOf("show()");
  }
  lastHideAt(): number {
    return this.calls.lastIndexOf("hide()");
  }
  count(kind: string): number {
    return this.calls.filter((c) => c === kind).length;
  }
}

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = ""): void => {
  results.push([name, pass, detail]);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const R = (x: number, y: number, w: number, h: number): Rect => ({ x, y, width: w, height: h });
const SHOW = (host: MockHost): number => host.count("show()");
const HIDE = (host: MockHost): number => host.count("hide()");

async function main(): Promise<void> {
  // ---------- T1 resize 连续更新 bounds ----------
  {
    const host = new MockHost();
    const c = new NativeSurfaceCoordinator(host);
    c.requestVisible(SURFACE_MAIN, true);
    c.requestBounds(SURFACE_MAIN, R(0, 0, 200, 300));
    c.requestBounds(SURFACE_MAIN, R(0, 0, 240, 300));
    c.requestBounds(SURFACE_MAIN, R(0, 0, 260, 320));
    const n = host.calls.filter((c2) => c2.startsWith("setBounds(")).length;
    check("T1 resize 连续 bounds 全部跟随", n === 3 && SHOW(host) === 1, `setBounds×${n}, show×${SHOW(host)}`);
  }

  // ---------- T2 hide/show 幂等 ----------
  {
    const host = new MockHost();
    const c = new NativeSurfaceCoordinator(host);
    c.requestVisible(SURFACE_MAIN, true);
    c.requestBounds(SURFACE_MAIN, R(0, 0, 200, 300));
    c.requestVisible(SURFACE_MAIN, true); // 同值重复
    c.requestVisible(SURFACE_MAIN, false);
    c.requestVisible(SURFACE_MAIN, false); // 同值重复
    check(
      "T2 hide/show 幂等",
      SHOW(host) === 1 && HIDE(host) === 1,
      `show×${SHOW(host)}, hide×${HIDE(host)}`,
    );
  }

  // ---------- T3/T4 blocker 叠加与多 blocker 语义 ----------
  {
    const host = new MockHost();
    const c = new NativeSurfaceCoordinator(host);
    c.requestVisible(SURFACE_MAIN, true);
    c.requestBounds(SURFACE_MAIN, R(0, 0, 200, 300));
    check("T3a 无 blocker 时显示", SHOW(host) === 1);
    c.addBlocker(SURFACE_MAIN, "route-transition");
    c.addBlocker(SURFACE_MAIN, "modal");
    check("T3b 双 blocker 只隐藏一次", HIDE(host) === 1 && SHOW(host) === 1, `show×${SHOW(host)}, hide×${HIDE(host)}`);
    c.removeBlocker(SURFACE_MAIN, "route-transition");
    check(
      "T4 删一个 blocker 不误显示（modal 仍在）",
      SHOW(host) === 1 && HIDE(host) === 1,
      `show×${SHOW(host)}, hide×${HIDE(host)}`,
    );
    c.removeBlocker(SURFACE_MAIN, "modal");
    check("T3c 全部移除后恢复显示", SHOW(host) === 2 && HIDE(host) === 1, `show×${SHOW(host)}, hide×${HIDE(host)}`);
    // removeBlocker 未知 token 幂等
    c.removeBlocker(SURFACE_MAIN, "nope");
    check("T3d 未知 token 移除无副作用", SHOW(host) === 2);
  }

  // ---------- T5 artifact 切换不闪旧 surface ----------
  {
    const host = new MockHost();
    const c = new NativeSurfaceCoordinator(host);
    c.requestVisible(SURFACE_MAIN, true);
    c.requestBounds(SURFACE_MAIN, R(0, 0, 200, 300));
    const shownBefore = SHOW(host);
    const loadP = c.loadArtifact(SURFACE_MAIN, "art-B");
    // 加载在途：必须已隐藏（不闪旧 A 内容），且未显示新内容
    check(
      "T5a 加载期间强制隐藏",
      host.lastHideAt() > host.lastShowAt() && SHOW(host) === shownBefore,
      `show×${SHOW(host)}, hide×${HIDE(host)}`,
    );
    await host.finish(1);
    await loadP;
    check("T5b 加载完成后恢复显示", SHOW(host) === shownBefore + 1, `show×${SHOW(host)}`);
  }

  // ---------- T6 generation：旧请求不能复活 surface ----------
  {
    const host = new MockHost();
    const c = new NativeSurfaceCoordinator(host);
    c.requestVisible(SURFACE_MAIN, true);
    c.requestBounds(SURFACE_MAIN, R(0, 0, 200, 300));
    const pA = c.loadArtifact(SURFACE_MAIN, "art-A");
    const pB = c.loadArtifact(SURFACE_MAIN, "art-B");
    const showAfterBothLoads = SHOW(host); // 两次加载在途：隐藏中
    await host.finish(1); // A 迟到完成（被 B 取代）
    await pA;
    check(
      "T6a A 迟到完成不恢复显示（B 仍在途）",
      SHOW(host) === showAfterBothLoads && host.pendingCount() === 1,
      `show×${SHOW(host)}`,
    );
    await host.finish(1); // B 完成
    await pB;
    check("T6b 最新 generation 完成才恢复显示", SHOW(host) === 2, `show×${SHOW(host)}（初始 1 + B 完成恢复 1）`);
  }

  // ---------- T7 close 后迟到事件不复活 ----------
  {
    const host = new MockHost();
    const c = new NativeSurfaceCoordinator(host);
    c.requestVisible(SURFACE_MAIN, true);
    c.requestBounds(SURFACE_MAIN, R(0, 0, 200, 300));
    c.close(SURFACE_MAIN);
    const showBefore = SHOW(host);
    c.requestVisible(SURFACE_MAIN, true); // 迟到意图
    c.requestBounds(SURFACE_MAIN, R(0, 0, 400, 500)); // 迟到 bounds
    c.addBlocker(SURFACE_MAIN, "modal");
    c.removeBlocker(SURFACE_MAIN, "modal");
    check(
      "T7 close 后迟到请求不复活 surface",
      SHOW(host) === showBefore && HIDE(host) === 1,
      `show×${SHOW(host)}, hide×${HIDE(host)}`,
    );
  }

  // ---------- T8 close 清空 blocker；重新 loadArtifact 正常激活 ----------
  {
    const host = new MockHost();
    const c = new NativeSurfaceCoordinator(host);
    c.requestVisible(SURFACE_MAIN, true);
    c.requestBounds(SURFACE_MAIN, R(0, 0, 200, 300));
    const pA = c.loadArtifact(SURFACE_MAIN, "art-A"); // 在途，blocker on
    c.close(SURFACE_MAIN); // 关闭：blocker 必须清空
    await host.finish(1);
    await pA; // A 的 finally：generation 过期 → 不操作（blocker 已清）
    c.requestVisible(SURFACE_MAIN, true);
    c.requestBounds(SURFACE_MAIN, R(0, 0, 200, 300));
    check(
      "T8a close 后 blocker 不残留（迟到 finish 不删任何 token）",
      SHOW(host) === 1 && HIDE(host) === 1,
      `show×${SHOW(host)}, hide×${HIDE(host)}`,
    );
    const pB = c.loadArtifact(SURFACE_MAIN, "art-B"); // 重新激活
    await host.finish(1);
    await pB;
    check("T8b loadArtifact 重新激活 surface", SHOW(host) === 2, `show×${SHOW(host)}`);
  }

  // ---------- T9 bounds 无效（<8px）视为隐藏 ----------
  {
    const host = new MockHost();
    const c = new NativeSurfaceCoordinator(host);
    c.requestVisible(SURFACE_MAIN, true);
    c.requestBounds(SURFACE_MAIN, R(0, 0, 4, 300)); // 过窄
    check("T9a 过窄 bounds 不显示（从未显示则无需 hide，幂等）", SHOW(host) === 0 && HIDE(host) === 0, `show×${SHOW(host)}, hide×${HIDE(host)}`);
    c.requestBounds(SURFACE_MAIN, R(0, 0, 200, 6)); // 过矮
    check("T9b 过矮 bounds 仍隐藏", SHOW(host) === 0, `show×${SHOW(host)}`);
    c.requestBounds(SURFACE_MAIN, R(0, 0, 200, 300));
    check("T9c 有效 bounds 恢复显示", SHOW(host) === 1, `show×${SHOW(host)}`);
  }

  // ---------- T10 destroy 后一切请求忽略 ----------
  {
    const host = new MockHost();
    const c = new NativeSurfaceCoordinator(host);
    c.requestVisible(SURFACE_MAIN, true);
    c.requestBounds(SURFACE_MAIN, R(0, 0, 200, 300));
    const callsBefore = host.calls.length;
    c.dispose();
    c.requestVisible(SURFACE_MAIN, true);
    c.requestBounds(SURFACE_MAIN, R(0, 0, 200, 300));
    c.addBlocker(SURFACE_MAIN, "modal");
    c.removeBlocker(SURFACE_MAIN, "modal");
    void c.loadArtifact(SURFACE_MAIN, "art-X");
    c.close(SURFACE_MAIN);
    c.reload(SURFACE_MAIN);
    check(
      "T10 dispose 后请求全忽略",
      host.calls.length === callsBefore + 1, // 只有 dispose()
      `calls=${host.calls.length} (期望 ${callsBefore + 1})`,
    );
  }

  // ---------- T11 PreviewHost 不获得业务状态 ownership ----------
  {
    const host = new MockHost();
    const c = new NativeSurfaceCoordinator(host);
    c.requestVisible(SURFACE_MAIN, true);
    c.requestBounds(SURFACE_MAIN, R(0, 0, 200, 300));
    c.addBlocker(SURFACE_MAIN, "modal");
    // host 只见过 show/hide/setBounds/preview 等动作，从未收到 blocker/desiredVisible 数据
    const leaks = host.calls.filter((call) => /blocker|desiredVisible|generation/i.test(call));
    check("T11 host 不接收业务状态", leaks.length === 0, leaks.join(", ") || "无泄漏");
  }

  const failed = results.filter(([, pass]) => !pass);
  console.log("");
  console.log(`===== NativeSurfaceCoordinator: ${results.length - failed.length}/${results.length} 通过 =====`);
  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("[native-surface-test] 异常:", e);
  process.exit(1);
});
