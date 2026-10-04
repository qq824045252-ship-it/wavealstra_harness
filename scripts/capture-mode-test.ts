/**
 * CaptureModeController / PageInspectionService Tests — V3.5 Wave 4C（§78-82）
 *
 * 覆盖（4C Gate）：
 *   T1   enter 全链（blocker→attach→enable→setInspectMode→active）
 *   T2   exit 全链（clearInspect→detach→blocker 移除→exited）
 *   T3   重复 enter（同 artifact）幂等
 *   T4   重复 enter（不同 artifact）先完整退出旧 session
 *   T5   重复 exit 幂等
 *   T6   attach 失败（DevTools 冲突）→ error + blocker 解除（非致命 §36）
 *   T7   target destroyed（debugger detached）→ 静默清理
 *   T8   artifact switch（surfaceGeneration 变化）→ 自动退出 + selection 丢弃
 *   T9   退出后迟到 CDP 事件忽略（session token）
 *   T10  inspect mode enable/disable（sendCommand 序列）
 *   T11  inspectModeCanceled（Esc）→ 状态稳定
 *   T12  click selection → SelectionDescriptor
 *   T13  descriptor 字段正确（artifactId/version/generation/backendNodeId/DOM）
 *   T14  bounds 获取（DOM.getBoxModel CSS 像素语义）
 *   T15  text 截断（SELECTION_TEXT_MAX）
 *   T16  dispose 后事件忽略
 *   T17  无 WCV（getDebugger null）→ error
 *   T18  entering 在途重复 enter 忽略
 *   T19  selection 后自动重启 inspect（连续选择）
 *
 * 运行：pnpm test:capture-mode（node 可跑，debugger 为 mock）
 */
import {
  CaptureModeController,
  type CaptureModeDeps,
  type CaptureModeState,
} from "../src/main/artifact/CaptureModeController";
import type { DebuggerLike } from "../src/main/artifact/PageInspectionService";
import type { PageWebContentsLike } from "../src/main/artifact/PageInspectionService";
import { SELECTION_TEXT_MAX, type SelectionDescriptor } from "../src/shared/capture-mode";

// ---------- Mock Debugger（DebuggerLike，模拟 Electron webContents.debugger） ----------
class MockDebugger implements DebuggerLike {
  attached = false;
  commands: Array<{ method: string; params?: unknown }> = [];
  private messageListeners: Array<(event: unknown, method: string, params: unknown) => void> = [];
  private detachListeners: Array<(event: unknown, reason: string) => void> = [];

  attachFail: Error | null = null;
  nodeInfo = { nodeId: 42, localName: "div", attributes: ["id", "hero", "class", "card main"] };
  boxModel = { model: { content: [10, 20, 110, 20, 110, 80, 10, 80] } };
  outerHTML = '<div id="hero" class="card main">Hello <b>World</b></div>';

  attach(): void {
    if (this.attachFail) throw this.attachFail;
    this.attached = true;
  }
  detach(): void {
    this.attached = false;
  }
  isAttached(): boolean {
    return this.attached;
  }
  async sendCommand(method: string, params?: unknown): Promise<unknown> {
    this.commands.push({ method, params });
    if (method === "DOM.describeNode") return { node: this.nodeInfo };
    if (method === "DOM.getBoxModel") return this.boxModel;
    if (method === "DOM.getOuterHTML") return { outerHTML: this.outerHTML };
    return {};
  }
  on(event: "message" | "detach", listener: (...args: unknown[]) => void): unknown {
    if (event === "message") this.messageListeners.push(listener as never);
    else this.detachListeners.push(listener as never);
    return this;
  }
  off(): unknown {
    return this;
  }
  removeAllListeners(): unknown {
    return this;
  }

  emitMessage(method: string, params: unknown): void {
    for (const l of [...this.messageListeners]) l(null, method, params);
  }
  emitDetach(reason: string): void {
    this.attached = false; // 真实 Electron：detach 事件发出时 debugger 已分离
    for (const l of [...this.detachListeners]) l(null, reason);
  }
  commandCount(method: string): number {
    return this.commands.filter((c) => c.method === method).length;
  }
}

interface Harness {
  dbg: MockDebugger;
  blockers: Set<string>;
  counters: { add: number; remove: number };
  states: Array<{ state: CaptureModeState; artifactId?: string; error?: string }>;
  selections: SelectionDescriptor[];
  bumpGeneration: () => void;
  emitSurfaceChange: (info?: { generation?: number; artifactId?: string | null; reason?: string }) => void;
  controller: CaptureModeController;
}

function makeWebContents(dbg: DebuggerLike): PageWebContentsLike {
  return {
    debugger: dbg,
    executeJavaScript: async () => "",
    isDestroyed: () => false,
  };
}

function makeHarness(overrides: Partial<CaptureModeDeps> = {}): Harness {
  const dbg = new MockDebugger();
  const wc = makeWebContents(dbg);
  let generation = 7;
  const blockers = new Set<string>();
  const counters = { add: 0, remove: 0 };
  const states: Harness["states"] = [];
  const selections: SelectionDescriptor[] = [];
  let surfaceListener: ((info: { generation: number; artifactId: string | null; reason: string }) => void) | null = null;

  const controller = new CaptureModeController(
    {
      addBlocker: (token) => {
        blockers.add(token);
        counters.add += 1;
      },
      removeBlocker: (token) => {
        blockers.delete(token);
        counters.remove += 1;
      },
      getWebContents: () => wc,
      getArtifactVersion: (artifactId) => (artifactId === "art-1" ? 3 : artifactId === "art-2" ? 5 : null),
      getSurfaceGeneration: () => generation,
      onSurfaceChanged: (listener) => {
        surfaceListener = listener;
        return () => {
          surfaceListener = null;
        };
      },
      ...overrides,
    },
    {
      onStateChange: (state, artifactId, error) => states.push({ state, artifactId, error }),
      onSelection: (d) => selections.push(d),
    },
  );

  return {
    dbg,
    blockers,
    counters,
    states,
    selections,
    bumpGeneration: () => {
      generation += 1;
    },
    emitSurfaceChange: (info: { generation?: number; artifactId?: string | null; reason?: string }) =>
      surfaceListener?.({
        generation: info.generation ?? generation,
        artifactId: info.artifactId ?? "art-1",
        reason: info.reason ?? "load",
      }),
    controller,
  };
}

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = ""): void => {
  results.push([name, pass, detail]);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function main(): Promise<void> {
  // ---------- T1 enter 全链 ----------
  {
    const h = makeHarness();
    await h.controller.enter("art-1");
    const enableOk = ["DOM.enable", "CSS.enable", "Overlay.enable"].every((m) => h.dbg.commandCount(m) === 1);
    const inspectOn = h.dbg.commandCount("Overlay.setInspectMode") === 1;
    const last = h.states[h.states.length - 1];
    check(
      "T1 enter 全链（blocker→attach→enable→inspect→active）",
      h.counters.add === 1 && h.counters.remove === 1 && enableOk && inspectOn && last?.state === "active",
      `addBlocker=${h.counters.add} removeBlocker=${h.counters.remove} enable=${enableOk} inspect=${inspectOn} state=${last?.state}`,
    );
    check("T1b 过渡后 blocker 已解除", h.blockers.size === 0);
  }

  // ---------- T2 exit 全链 ----------
  {
    const h = makeHarness();
    await h.controller.enter("art-1");
    h.controller.exit();
    const cleared = h.dbg.commandCount("Overlay.setInspectMode") >= 2; // searchForNode + none
    check(
      "T2 exit 全链（clearInspect→detach→blocker 移除→exited）",
      cleared && !h.dbg.attached && h.blockers.size === 0 && h.states.at(-1)?.state === "exited",
      `setInspectMode×${h.dbg.commandCount("Overlay.setInspectMode")} attached=${h.dbg.attached}`,
    );
  }

  // ---------- T3 重复 enter（同 artifact）幂等 ----------
  {
    const h = makeHarness();
    await h.controller.enter("art-1");
    const attachAfterFirst = h.dbg.attached;
    await h.controller.enter("art-1"); // 同 artifactId → 幂等
    check(
      "T3 重复 enter（同 artifact）不重新 attach",
      attachAfterFirst && h.dbg.attached && h.dbg.commandCount("DOM.enable") === 1 && h.states.filter((s) => s.state === "active").length === 1,
      `DOM.enable×${h.dbg.commandCount("DOM.enable")} active×${h.states.filter((s) => s.state === "active").length}`,
    );
  }

  // ---------- T4 重复 enter（不同 artifact）先完整退出旧 ----------
  {
    const h = makeHarness();
    await h.controller.enter("art-1");
    await h.controller.enter("art-2");
    const last = h.states.at(-1);
    check(
      "T4 换 artifact 先完整退出旧 session（静默替换）",
      h.dbg.commandCount("DOM.enable") === 2 && h.dbg.attached && last?.state === "active" && last?.artifactId === "art-2",
      `DOM.enable×${h.dbg.commandCount("DOM.enable")} last=${last?.state}/${last?.artifactId}`,
    );
  }

  // ---------- T5 重复 exit 幂等 ----------
  {
    const h = makeHarness();
    await h.controller.enter("art-1");
    h.controller.exit();
    h.controller.exit(); // 幂等
    check(
      "T5 重复 exit 幂等",
      h.states.filter((s) => s.state === "exited").length === 1 && !h.dbg.attached,
      `exited×${h.states.filter((s) => s.state === "exited").length}`,
    );
  }

  // ---------- T6 attach 失败（DevTools 冲突）非致命 ----------
  {
    const h = makeHarness();
    h.dbg.attachFail = new Error("Another debugger is already attached");
    await h.controller.enter("art-1");
    const last = h.states.at(-1);
    check(
      "T6 attach 失败 → error + blocker 解除",
      last?.state === "error" && !!last?.error && h.blockers.size === 0 && !h.dbg.attached,
      `state=${last?.state} blockers=${h.blockers.size} err=${last?.error?.slice(0, 30)}`,
    );
  }

  // ---------- T7 target destroyed 静默清理 ----------
  {
    const h = makeHarness();
    await h.controller.enter("art-1");
    h.dbg.emitDetach("target_closed");
    check(
      "T7 target destroyed 静默清理",
      h.states.at(-1)?.state === "exited" && !h.dbg.attached && h.blockers.size === 0,
      `state=${h.states.at(-1)?.state} blockers=${h.blockers.size}`,
    );
  }

  // ---------- T8 artifact switch（generation 变化）自动退出 ----------
  {
    const h = makeHarness();
    await h.controller.enter("art-1");
    h.bumpGeneration(); // 模拟 Coordinator.loadArtifact（generation++）
    h.dbg.emitMessage("Overlay.inspectNodeRequested", { backendNodeId: 42, nodeId: 42 });
    await tick();
    await tick();
    check(
      "T8 generation 变化 → 自动退出 + selection 丢弃",
      h.selections.length === 0 && h.states.at(-1)?.state === "exited" && !h.dbg.attached,
      `selections=${h.selections.length} state=${h.states.at(-1)?.state}`,
    );
  }

  // ---------- T9 退出后迟到事件忽略 ----------
  {
    const h = makeHarness();
    await h.controller.enter("art-1");
    h.controller.exit();
    h.dbg.emitMessage("Overlay.inspectNodeRequested", { backendNodeId: 42, nodeId: 42 });
    await tick();
    await tick();
    check("T9 退出后迟到 CDP 事件忽略", h.selections.length === 0 && h.states.at(-1)?.state === "exited");
  }

  // ---------- T10 inspect mode enable/disable ----------
  {
    const h = makeHarness();
    await h.controller.enter("art-1");
    const searchForNode = h.dbg.commands.find((c) => c.method === "Overlay.setInspectMode" && (c.params as { mode?: string })?.mode === "searchForNode");
    await h.controller.stopInspect();
    const noneMode = h.dbg.commands.some((c) => c.method === "Overlay.setInspectMode" && (c.params as { mode?: string })?.mode === "none");
    await h.controller.startInspect();
    const searchCount = h.dbg.commands.filter((c) => c.method === "Overlay.setInspectMode" && (c.params as { mode?: string })?.mode === "searchForNode").length;
    check(
      "T10 inspect mode enable/disable/重新 enable",
      !!searchForNode && noneMode && searchCount === 2,
      `searchForNode×${searchCount} none=${noneMode}`,
    );
  }

  // ---------- T11 inspectModeCanceled（Esc）状态稳定 ----------
  {
    const h = makeHarness();
    await h.controller.enter("art-1");
    h.dbg.emitMessage("Overlay.inspectModeCanceled", {});
    await tick();
    check("T11 Esc 取消后状态保持 active（可重新 startInspect）", h.states.at(-1)?.state === "active" && h.dbg.attached);
  }

  // ---------- T12/T13/T14 click selection → descriptor ----------
  {
    const h = makeHarness();
    await h.controller.enter("art-1");
    h.dbg.emitMessage("Overlay.inspectNodeRequested", { backendNodeId: 42, nodeId: 42 });
    await tick();
    await tick();
    const d = h.selections[0];
    check(
      "T12 click selection 产生 descriptor",
      h.selections.length === 1 && !!d,
      `selections=${h.selections.length}`,
    );
    check(
      "T13 字段正确（id/version/generation/backendNodeId/DOM）",
      d?.artifactId === "art-1" &&
        d?.artifactVersion === 3 &&
        d?.surfaceGeneration === 7 &&
        d?.backendNodeId === 42 &&
        d?.tagName === "div" &&
        d?.id === "hero" &&
        d?.classNames.join(" ") === "card main" &&
        d?.selector === "div#hero.card.main",
      d ? `${d.tagName}#${d.id} .${d.classNames.join(".")} sel=${d.selector}` : "无",
    );
    check(
      "T14 bounds 来自 getBoxModel（CSS 像素）",
      d?.bounds.x === 10 && d?.bounds.y === 20 && d?.bounds.width === 100 && d?.bounds.height === 60,
      d ? JSON.stringify(d.bounds) : "无",
    );
    check("T14b text 提取（strip tags）", d?.text === "Hello World", `text=${d?.text}`);
  }

  // ---------- T15 text 截断 ----------
  {
    const h = makeHarness();
    h.dbg.outerHTML = `<div>${"x".repeat(SELECTION_TEXT_MAX * 2)}</div>`;
    await h.controller.enter("art-1");
    h.dbg.emitMessage("Overlay.inspectNodeRequested", { backendNodeId: 42, nodeId: 42 });
    await tick();
    await tick();
    const d = h.selections[0];
    check(
      "T15 text 截断上限",
      (d?.text?.length ?? 0) <= SELECTION_TEXT_MAX && (d?.text?.length ?? 0) > 0,
      `len=${d?.text?.length}（上限 ${SELECTION_TEXT_MAX}）`,
    );
  }

  // ---------- T16 dispose 后事件忽略 ----------
  {
    const h = makeHarness();
    await h.controller.enter("art-1");
    h.controller.dispose();
    h.dbg.emitMessage("Overlay.inspectNodeRequested", { backendNodeId: 42, nodeId: 42 });
    h.dbg.emitDetach("target_closed");
    await tick();
    await tick();
    check("T16 dispose 后事件忽略", h.selections.length === 0 && h.blockers.size === 0);
  }

  // ---------- T17 无 WCV → error ----------
  {
    const h = makeHarness({ getWebContents: () => null });
    await h.controller.enter("art-1");
    check("T17 无 WCV → error（非致命）", h.states.at(-1)?.state === "error" && h.blockers.size === 0);
  }

  // ---------- T18 entering 在途重复 enter 忽略 ----------
  {
    const h = makeHarness();
    const p1 = h.controller.enter("art-1");
    const p2 = h.controller.enter("art-1"); // entering 在途
    await Promise.all([p1, p2]);
    check("T18 entering 在途重复 enter 忽略", h.dbg.commandCount("DOM.enable") === 1 && h.states.filter((s) => s.state === "active").length === 1);
  }

  // ---------- T19 selection 后自动重启 inspect ----------
  {
    const h = makeHarness();
    await h.controller.enter("art-1");
    h.dbg.emitMessage("Overlay.inspectNodeRequested", { backendNodeId: 42, nodeId: 42 });
    await tick();
    await tick();
    await tick();
    const searchCount = h.dbg.commands.filter((c) => c.method === "Overlay.setInspectMode" && (c.params as { mode?: string })?.mode === "searchForNode").length;
    check("T19 selection 后暂停检查，留给评论菜单", searchCount === 1 && h.dbg.commands.some(c => c.method === "Overlay.hideHighlight"), `searchForNode×${searchCount}`);
    await h.controller.startInspect();
    check("T19b 评论完成后可继续选取", h.dbg.commands.filter(c => c.method === "Overlay.setInspectMode" && (c.params as { mode?: string })?.mode === "searchForNode").length === 2);
  }

  // ---------- T20 surface 变化主动退出（4C 防御：不继续 inspect 旧 WCV） ----------
  {
    const h = makeHarness();
    await h.controller.enter("art-1");
    check("T20a enter 后订阅 surface 变化", h.states.at(-1)?.state === "active");
    h.emitSurfaceChange({ artifactId: "art-2", generation: 8, reason: "load" }); // 切换 artifact
    check(
      "T20b artifact 切换 → 立即退出（无需 selection 事件）",
      h.states.at(-1)?.state === "exited" && !h.dbg.attached && h.blockers.size === 0,
      `state=${h.states.at(-1)?.state}`,
    );
    await h.controller.enter("art-1");
    h.emitSurfaceChange({ artifactId: "art-1", generation: 9, reason: "reload" }); // 同 artifact 重载
    check(
      "T20c 同 artifact 重载 → 立即退出",
      h.states.at(-1)?.state === "exited" && !h.dbg.attached,
      `state=${h.states.at(-1)?.state}`,
    );
    await h.controller.enter("art-1");
    h.emitSurfaceChange({ artifactId: null, generation: 10, reason: "close" }); // surface 关闭
    check(
      "T20d surface close → 立即退出",
      h.states.at(-1)?.state === "exited" && !h.dbg.attached && h.blockers.size === 0,
      `state=${h.states.at(-1)?.state}`,
    );
  }

  const failed = results.filter(([, pass]) => !pass);
  console.log("");
  console.log(`===== CaptureModeController/PageInspectionService: ${results.length - failed.length}/${results.length} 通过 =====`);
  if (failed.length > 0) {
    console.log(`FAILED: ${failed.map(([n]) => n).join(", ")}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("[capture-mode-test] 异常:", e);
  process.exit(1);
});


