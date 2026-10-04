/**
 * SelectionStore Tests — V3.5 Wave 4D（§80 stale 语义）
 *
 * 覆盖（4D Gate）：
 *   T1  set selection → active
 *   T2  clear → empty
 *   T3  version 相同（artifact updated 同 version）→ 保持 active
 *   T4  version 改变 → stale(artifact-version-changed)
 *   T5  generation 改变（reload/重载）→ stale(surface-generation-changed)
 *   T6  artifactId 改变（load 换 artifact）→ stale(artifact-changed)（不 clear）
 *   T7  artifact deleted → clear
 *   T8  新 selection 覆盖 stale selection → active
 *   T9  退出 Capture Mode 不清 selection（store 无 capture 依赖；无事件时保持）
 *   T10 重复 stale 幂等（reason/status 不变）
 *   T11 stale reason 正确（各场景）
 *   T12 旧 artifact event 不误伤当前 selection（A 选中，B updated → A 不 stale）
 *   T13 surface closed → stale(surface-closed)
 *   T14 clear 后迟到事件不复活（markStale/updated 对 empty 无操作）
 *   T15 validateAgainst 直接调用语义
 *
 * 运行：pnpm test:selection-store（纯 node，无 Electron 依赖）
 */
import { SelectionStore } from "../src/main/artifact/SelectionStore";
import type { SelectionDescriptor } from "../src/shared/capture-mode";
import type { SelectionState } from "../src/shared/selection";

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = ""): void => {
  results.push([name, pass, detail]);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

function makeDescriptor(overrides: Partial<SelectionDescriptor> = {}): SelectionDescriptor {
  return {
    artifactId: "art-A",
    artifactVersion: 3,
    surfaceGeneration: 7,
    backendNodeId: 42,
    tagName: "div",
    id: "hero",
    classNames: ["card", "main"],
    selector: "div#hero.card.main",
    text: "Hello World",
    bounds: { x: 10, y: 20, width: 100, height: 60 },
    ...overrides,
  };
}

const isStatus = (s: SelectionState, status: SelectionState["status"]): boolean => s.status === status;

function main(): void {
  // ---------- T1 set → active ----------
  {
    const store = new SelectionStore();
    store.setSelection(makeDescriptor());
    const s = store.getState();
    check("T1 set selection → active", isStatus(s, "active") && s.descriptor?.artifactId === "art-A", `status=${s.status}`);
  }

  // ---------- T2 clear → empty ----------
  {
    const store = new SelectionStore();
    store.setSelection(makeDescriptor());
    store.clearSelection();
    check("T2 clear → empty", isStatus(store.getState(), "empty") && store.getState().descriptor === null);
  }

  // ---------- T3 version 相同 → 保持 active ----------
  {
    const store = new SelectionStore();
    store.setSelection(makeDescriptor({ artifactVersion: 3 }));
    store.onArtifactUpdated({ artifactId: "art-A", taskId: "t", version: 3, revision: 1, descriptor: makeDescriptor() });
    check("T3 version 相同不 stale", isStatus(store.getState(), "active"), `status=${store.getState().status}`);
  }

  // ---------- T4 version 改变 → stale ----------
  {
    const store = new SelectionStore();
    store.setSelection(makeDescriptor({ artifactVersion: 3 }));
    store.onArtifactUpdated({ artifactId: "art-A", taskId: "t", version: 8, revision: 1, descriptor: makeDescriptor({ artifactVersion: 8 }) });
    const s = store.getState();
    check(
      "T4 version 改变 → stale(artifact-version-changed)",
      isStatus(s, "stale") && s.staleReason === "artifact-version-changed" && s.descriptor !== null,
      `status=${s.status} reason=${s.staleReason} descriptor=${s.descriptor ? "保留" : "null"}`,
    );
  }

  // ---------- T5 generation 改变（同 artifact reload/重载）→ stale ----------
  {
    const store = new SelectionStore();
    store.setSelection(makeDescriptor({ surfaceGeneration: 7 }));
    store.onSurfaceChanged({ surfaceId: "artifact-main", generation: 8, artifactId: "art-A", reason: "reload" });
    const s = store.getState();
    check(
      "T5 generation 改变 → stale(surface-generation-changed)",
      isStatus(s, "stale") && s.staleReason === "surface-generation-changed",
      `reason=${s.staleReason}`,
    );
  }

  // ---------- T6 artifactId 改变（load 换 artifact）→ stale(artifact-changed) 不 clear ----------
  {
    const store = new SelectionStore();
    store.setSelection(makeDescriptor());
    store.onSurfaceChanged({ surfaceId: "artifact-main", generation: 8, artifactId: "art-B", reason: "load" });
    const s = store.getState();
    check(
      "T6 artifactId 改变 → stale(artifact-changed) 且保留 descriptor",
      isStatus(s, "stale") && s.staleReason === "artifact-changed" && s.descriptor?.artifactId === "art-A",
      `reason=${s.staleReason} kept=${s.descriptor?.artifactId}`,
    );
  }

  // ---------- T7 artifact deleted → clear ----------
  {
    const store = new SelectionStore();
    store.setSelection(makeDescriptor());
    store.onArtifactRemoved({ artifactId: "art-A", taskId: "t", revision: 2 });
    check("T7 选中 artifact 删除 → clear", isStatus(store.getState(), "empty"), `status=${store.getState().status}`);
    // 非选中 artifact 删除不影响
    store.setSelection(makeDescriptor());
    store.onArtifactRemoved({ artifactId: "art-OTHER", taskId: "t", revision: 3 });
    check("T7b 其他 artifact 删除不影响", isStatus(store.getState(), "active"), `status=${store.getState().status}`);
  }

  // ---------- T8 新 selection 覆盖 stale → active ----------
  {
    const store = new SelectionStore();
    store.setSelection(makeDescriptor({ artifactVersion: 3 }));
    store.onArtifactUpdated({ artifactId: "art-A", taskId: "t", version: 8, revision: 1, descriptor: makeDescriptor({ artifactVersion: 8 }) });
    check("T8a 先进入 stale", isStatus(store.getState(), "stale"));
    store.setSelection(makeDescriptor({ artifactVersion: 8, backendNodeId: 99 }));
    const s = store.getState();
    check("T8b 新 selection 覆盖 → active 且 reason 清空", isStatus(s, "active") && !s.staleReason && s.descriptor?.backendNodeId === 99);
  }

  // ---------- T8c 同一 surface 多 selection 可分别解析 ----------
  {
    const store = new SelectionStore();
    store.setSelection(makeDescriptor({ backendNodeId: 42 }));
    store.setSelection(makeDescriptor({ backendNodeId: 99, id: "submit", tagName: "button" }));
    const first = store.resolveSelection({
      artifactId: "art-A",
      artifactVersion: 3,
      surfaceGeneration: 7,
      backendNodeId: 42,
    });
    const second = store.resolveSelection({
      artifactId: "art-A",
      artifactVersion: 3,
      surfaceGeneration: 7,
      backendNodeId: 99,
    });
    check(
      "T8c 同一 surface 多 selection 保留可信记录",
      first?.backendNodeId === 42 && second?.backendNodeId === 99,
    );
    store.markStale("surface-generation-changed");
    check(
      "T8d surface 失效后累计 selection 全部不可解析",
      store.resolveSelection({ artifactId: "art-A", artifactVersion: 3, surfaceGeneration: 7, backendNodeId: 42 }) === null &&
        store.resolveSelection({ artifactId: "art-A", artifactVersion: 3, surfaceGeneration: 7, backendNodeId: 99 }) === null,
    );
  }

  // ---------- T9 退出 Capture Mode 不清 selection ----------
  {
    const store = new SelectionStore();
    store.setSelection(makeDescriptor());
    // store 不订阅任何 capture mode 事件；模拟"退出"（无 store 调用）→ selection 保持 active
    check(
      "T9 退出 Capture Mode 不清 selection（无设计事件依赖）",
      isStatus(store.getState(), "active") && store.getState().descriptor !== null,
      `status=${store.getState().status}`,
    );
  }

  // ---------- T10 重复 stale 幂等 ----------
  {
    const store = new SelectionStore();
    store.setSelection(makeDescriptor());
    store.markStale("artifact-version-changed");
    const first = store.getState();
    store.markStale("surface-generation-changed"); // 已 stale → 无操作
    const second = store.getState();
    check(
      "T10 重复 stale 幂等（reason/status 不变）",
      second.status === "stale" && second.staleReason === "artifact-version-changed" && first.updatedAt === second.updatedAt,
      `reason=${second.staleReason} updatedAt 相同=${first.updatedAt === second.updatedAt}`,
    );
  }

  // ---------- T11 stale reason 正确（汇总） ----------
  {
    const cases: Array<[string, (s: SelectionStore) => void, string]> = [
      ["version", (s) => s.onArtifactUpdated({ artifactId: "art-A", taskId: "t", version: 99, revision: 1, descriptor: makeDescriptor() }), "artifact-version-changed"],
      ["generation", (s) => s.onSurfaceChanged({ surfaceId: "artifact-main", generation: 99, artifactId: "art-A", reason: "reload" }), "surface-generation-changed"],
      ["artifact-changed", (s) => s.onSurfaceChanged({ surfaceId: "artifact-main", generation: 99, artifactId: "art-B", reason: "load" }), "artifact-changed"],
      ["surface-closed", (s) => s.onSurfaceChanged({ surfaceId: "artifact-main", generation: 99, artifactId: null, reason: "close" }), "surface-closed"],
    ];
    let allOk = true;
    for (const [name, trigger, expected] of cases) {
      const store = new SelectionStore();
      store.setSelection(makeDescriptor());
      trigger(store);
      const s = store.getState();
      const ok = s.status === "stale" && s.staleReason === expected;
      if (!ok) allOk = false;
      console.log(`  ${ok ? "PASS" : "FAIL"}  T11[${name}] → ${s.staleReason ?? s.status}（期望 ${expected}）`);
    }
    check("T11 stale reason 全部正确", allOk);
  }

  // ---------- T12 旧 artifact event 不误伤 ----------
  {
    const store = new SelectionStore();
    store.setSelection(makeDescriptor()); // selection = art-A v3
    store.onArtifactUpdated({ artifactId: "art-B", taskId: "t", version: 1, revision: 1, descriptor: makeDescriptor({ artifactId: "art-B" }) });
    store.onArtifactUpdated({ artifactId: "art-C", taskId: "t", version: 9, revision: 1, descriptor: makeDescriptor({ artifactId: "art-C" }) });
    check(
      "T12 其他 artifact updated 不 stale 当前 selection",
      isStatus(store.getState(), "active"),
      `status=${store.getState().status}`,
    );
  }

  // ---------- T13 surface closed → stale(surface-closed) ----------
  {
    const store = new SelectionStore();
    store.setSelection(makeDescriptor());
    store.onSurfaceChanged({ surfaceId: "artifact-main", generation: 8, artifactId: null, reason: "close" });
    const s = store.getState();
    check(
      "T13 surface close → stale(surface-closed)",
      isStatus(s, "stale") && s.staleReason === "surface-closed" && s.descriptor !== null,
      `reason=${s.staleReason}`,
    );
  }

  // ---------- T14 clear 后迟到事件不复活 ----------
  {
    const store = new SelectionStore();
    store.setSelection(makeDescriptor());
    store.clearSelection();
    store.markStale("artifact-version-changed"); // empty 无操作
    store.onArtifactUpdated({ artifactId: "art-A", taskId: "t", version: 99, revision: 1, descriptor: makeDescriptor() });
    store.onSurfaceChanged({ surfaceId: "artifact-main", generation: 99, artifactId: "art-A", reason: "load" });
    check("T14 clear 后迟到事件不复活", isStatus(store.getState(), "empty"), `status=${store.getState().status}`);
  }

  // ---------- T15 validateAgainst 语义 ----------
  {
    const store = new SelectionStore();
    store.setSelection(makeDescriptor({ artifactVersion: 3, surfaceGeneration: 7 }));
    store.validateAgainst({ artifactId: "art-A", artifactVersion: 3, surfaceGeneration: 7 });
    check("T15a 全部一致 → 保持 active", isStatus(store.getState(), "active"));
    store.validateAgainst({ artifactId: "art-A", artifactVersion: 4, surfaceGeneration: 7 });
    check("T15b version 不一致 → stale", isStatus(store.getState(), "stale") && store.getState().staleReason === "artifact-version-changed");
    const store2 = new SelectionStore();
    store2.setSelection(makeDescriptor());
    store2.validateAgainst({ artifactId: "art-A", artifactVersion: 3, surfaceGeneration: 8 });
    check("T15c generation 不一致 → stale(surface-generation-changed)", store2.getState().staleReason === "surface-generation-changed");
    const store3 = new SelectionStore();
    store3.setSelection(makeDescriptor());
    store3.validateAgainst({ artifactId: "art-B", artifactVersion: 3, surfaceGeneration: 7 });
    check("T15d artifactId 不一致 → stale(artifact-changed)", store3.getState().staleReason === "artifact-changed");
    const store4 = new SelectionStore();
    store4.setSelection(makeDescriptor());
    store4.validateAgainst({ artifactId: "art-A", artifactVersion: 3, surfaceGeneration: 7, surfaceClosed: true });
    check("T15e surfaceClosed → stale(surface-closed)", store4.getState().staleReason === "surface-closed");
  }

  const failed = results.filter(([, pass]) => !pass);
  console.log("");
  console.log(`===== SelectionStore: ${results.length - failed.length}/${results.length} 通过 =====`);
  if (failed.length > 0) {
    console.log(`FAILED: ${failed.map(([n]) => n).join(", ")}`);
    process.exit(1);
  }
}

main();
