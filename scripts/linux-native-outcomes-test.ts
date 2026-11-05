import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { LinuxComputerUseBackend } from "../src/main/platform/computer-use/linux/LinuxComputerUseBackend";
import { parseHyprlandMonitors, monitorLayoutId } from "../src/main/platform/computer-use/linux/hyprlandMonitors";
import { parseHyprlandWindows, type HyprlandDesktop } from "../src/main/platform/computer-use/linux/hyprlandWindows";
import type { AtSpiControlInfo, AtSpiDriverApi, AtSpiInspection, AtSpiSemanticResult } from "../src/main/platform/computer-use/linux/atspiTypes";
import { ComputerUseError, type ComputerExecInput, type WindowInfo } from "../src/main/platform/computer-use/protocol";
import { setHeldInputReleaser } from "../src/main/platform/computer-use/heldInput";
import { computerUseRunCoordinator } from "../src/main/capabilities/ComputerUseRunCoordinator";

/** Public backend contract fixtures. These do not claim real D-Bus or desktop input. */
class Fixture {
  readonly monitors = parseHyprlandMonitors([{ id: 1, name: "fixture-output", x: -300, y: 0, width: 1500, height: 900, scale: 1.5, transform: 0, activeWorkspace: { id: 1 } }]);
  readonly layoutId = monitorLayoutId(this.monitors);
  windows = parseHyprlandWindows([{ address: "0x100000000000000001", pid: 42, class: "fixture", title: "Test window", mapped: true, hidden: false, xwayland: false, at: [-100, 20], size: [700, 500], monitor: 1, workspace: { id: 1 } }], this.monitors, "0x100000000000000001");
  activeHandle = this.windows[0].handle;
  labels = ["Activate"];
  truncated = false;
  mutations = 0;
  screenshots = 0;
  readonly edges: string[][] = [];
  readonly references = new Map<string, AtSpiControlInfo>();
  afterMutation?: () => void;
  snapshotError?: Error;
  inspectionError?: Error;
  referenceError?: Error;
  execution: AtSpiSemanticResult["executed"] = true;
  edgeFailure?: (args: readonly string[]) => void;
  private sequence = 0;
  readonly backend: LinuxComputerUseBackend;

  constructor() {
    this.windows[0].identityToken = "compositor-instance:window-1";
    const compositor: HyprlandDesktop = {
      snapshot: async () => {
        if (this.snapshotError) throw this.snapshotError;
        return { windows: structuredClone(this.windows), monitors: this.monitors, activeHandle: this.activeHandle, layoutId: this.layoutId, observedAt: Date.now() };
      },
      activeHandle: async () => this.activeHandle,
      cursor: async () => ({ x: 0, y: 100 }),
      focus: async window => { this.activeHandle = window.handle; return window; },
      movePointer: async point => point,
    };
    const read = async (_window: WindowInfo, runtimeId: string): Promise<AtSpiControlInfo> => {
      if (this.referenceError) throw this.referenceError;
      const value = this.references.get(runtimeId);
      if (!value) throw new ComputerUseError("STALE_OBSERVATION", "Fixture object no longer exists");
      return structuredClone(value);
    };
    const mutate = async (window: WindowInfo, runtimeId: string): Promise<AtSpiSemanticResult> => {
      const before = await read(window, runtimeId);
      this.mutations++;
      this.afterMutation?.();
      return { executed: this.execution, verified: false, before, evidence: "Fixture method returned; application outcome not inferred" };
    };
    const atspi: AtSpiDriverApi = {
      probe: async () => ({ available: true, generation: "fixture-bus", checkedAt: Date.now(), applicationCount: 1 }),
      inspectWindow: async (window, options): Promise<AtSpiInspection> => {
        if (this.inspectionError) throw this.inspectionError;
        const observationId = options?.observationId ?? `fixture-observation-${++this.sequence}`;
        const controls = this.labels.map((name): AtSpiControlInfo => {
          const runtimeId = `fixture-ref-${++this.sequence}`;
          const control: AtSpiControlInfo = {
            runtimeId, name, controlType: "Button", enabled: true, offscreen: false,
            keyboardFocusable: true, hasKeyboardFocus: false, patterns: ["Invoke"],
            interfaces: ["org.a11y.atspi.Accessible", "org.a11y.atspi.Action"], states: ["enabled", "showing"],
            atspi: { busName: ":1.42", objectPath: `/fixture/${this.sequence}`, generation: "fixture-bus", observationId, windowHandle: window.handle, role: 43, boundsReliable: false },
          };
          this.references.set(runtimeId, control); return control;
        });
        return { controls, readableText: this.labels.join("\n"), truncated: this.truncated, diagnostics: [], generation: "fixture-bus", windowRef: "fixture-window", observationId, boundsReliable: false, treeStatus: this.truncated ? "truncated" : controls.length ? "available" : "empty" };
      },
      readControl: read, focus: mutate, invoke: mutate, setValue: mutate, shutdown: async () => {},
    };
    this.backend = new LinuxComputerUseBackend({
      compositor, atspi, sleep: async () => {},
      ydotoolRunner: async args => { this.edges.push([...args]); this.edgeFailure?.(args); },
      screenshotProvider: {
        probe: async () => ({ available: false, verified: false, checkedAt: Date.now(), reason: "Screenshot fixture disabled" }),
        capture: async () => { this.screenshots++; throw new ComputerUseError("CAPTURE_FAILED", "Forced capture failure"); },
      },
    });
  }

  invoke(extra: Partial<ComputerExecInput> = {}) {
    return this.backend.execute({ action: "invoke_control", windowHandle: this.activeHandle, controlName: "Activate", exactName: true, ...extra });
  }
}

const tests: Array<[string, (fixture: Fixture) => Promise<void>]> = [
  ["semantic delivery and capability probes never imply business verification or capture", async f => {
    await f.backend.refreshDiagnostics();
    const result = await f.invoke();
    assert.equal(result.executed, true); assert.equal(result.verified, false);
    assert.equal(f.screenshots, 0); assert.equal(f.mutations, 1);
    assert.equal(f.backend.status().capabilities?.screenshot?.available, false);
    assert.equal(f.backend.status().capabilities?.accessibility?.available, true);
  }],
  ["a fresh explicit control outcome verifies only the requested fact", async f => {
    f.afterMutation = () => { f.labels.push("Done"); };
    const result = await f.invoke({ expectedOutcomes: [{ kind: "control_present", controlName: "Done", exactName: true }] });
    assert.equal(result.semanticOutcome?.status, "passed"); assert.equal(result.verified, true);
    assert.equal(f.mutations, 1); assert.equal(f.screenshots, 0);
  }],
  ["failed window readback cannot be treated as a closed target", async f => {
    f.afterMutation = () => { f.snapshotError = new ComputerUseError("HOST_UNAVAILABLE", "Compositor disconnected"); };
    const result = await f.invoke({ expectedOutcomes: [{ kind: "target_closed" }] });
    assert.equal(result.executed, true); assert.equal(result.verified, false);
    assert.equal(result.observationStatus, "failed"); assert.equal(result.semanticOutcome?.status, "not_evaluable");
    assert.equal(f.mutations, 1);
  }],
  ["an explicit outcome does not turn unknown delivery into confirmed delivery", async f => {
    f.execution = "unknown";
    const result = await f.invoke({ expectedOutcomes: [{ kind: "target_present" }] });
    assert.equal(result.semanticOutcome?.status, "passed"); assert.equal(result.executed, "unknown");
    assert.equal(result.verified, false); assert.equal(f.mutations, 1);
  }],
  ["control absence requires a complete successful tree", async f => {
    f.afterMutation = () => { f.labels = []; };
    const result = await f.invoke({ expectedOutcomes: [{ kind: "control_absent", controlName: "Activate", exactName: true }] });
    assert.equal(result.semanticOutcome?.status, "passed"); assert.equal(result.verified, true);
  }],
  ["truncation never proves control absence", async f => {
    f.afterMutation = () => { f.labels = []; f.truncated = true; };
    const result = await f.invoke({ expectedOutcomes: [{ kind: "control_absent", controlName: "Activate", exactName: true }] });
    assert.equal(result.semanticOutcome?.status, "not_evaluable"); assert.equal(result.verified, false);
  }],
  ["a missing accessibility bridge after dispatch keeps the dispatched result", async f => {
    f.afterMutation = () => { f.inspectionError = new ComputerUseError("HOST_UNAVAILABLE", "Accessibility bus disconnected"); };
    const result = await f.invoke({ expectedOutcomes: [{ kind: "control_absent", controlName: "Activate" }] });
    assert.equal(result.executed, true); assert.equal(result.semanticOutcome?.status, "not_evaluable");
    assert.equal(result.verified, false); assert.equal(f.mutations, 1);
  }],
  ["unreadable original runtime references do not prove control absence", async f => {
    const before = await f.backend.execute({ action: "inspect_controls", windowHandle: f.activeHandle });
    const runtimeId = before.controls![0].runtimeId;
    f.afterMutation = () => { f.referenceError = new ComputerUseError("STALE_OBSERVATION", "Original object was replaced"); };
    const result = await f.invoke({ controlRuntimeId: runtimeId, observationId: before.observationId, expectedOutcomes: [{ kind: "control_absent", controlRuntimeId: runtimeId }] });
    assert.equal(result.semanticOutcome?.status, "not_evaluable"); assert.equal(result.verified, false);
  }],
  ["same-address replacement is a new lifetime even with the same PID and title", async f => {
    f.afterMutation = () => { f.windows[0].identityToken = "compositor-instance:window-2"; };
    const result = await f.invoke({ expectedOutcomes: [{ kind: "target_closed" }, { kind: "new_window", windowTitleContains: "Test window" }] });
    assert.equal(result.semanticOutcome?.status, "passed");
    assert.equal(result.observation?.closedWindows.length, 1); assert.equal(result.observation?.newWindows.length, 1);
  }],
  ["optional capture failure preserves delivered action and semantic evidence", async f => {
    const result = await f.invoke({ captureAfter: true, expectedOutcomes: [{ kind: "target_present" }] });
    assert.equal(result.executed, true); assert.equal(result.verified, true);
    assert.equal(result.semanticOutcome?.status, "passed"); assert.match(String(result.captureError), /Forced capture failure/);
    assert.equal(result.screenshot, undefined); assert.equal(f.screenshots, 1); assert.equal(f.mutations, 1);
  }],
  ["failed batches retain successful prefixes and never execute later steps", async f => {
    f.edgeFailure = args => { if (args.includes("48:1")) throw new ComputerUseError("HOST_UNAVAILABLE", "B delivery unknown", { executed: "unknown" }); };
    const result = await f.backend.execute({ windowHandle: f.activeHandle, settleMs: 0, actions: [{ action: "key_press", key: "A" }, { action: "key_press", key: "B" }, { action: "key_press", key: "C" }], expectedOutcomes: [{ kind: "target_present" }] });
    assert.equal(result.batch?.completed, false); assert.equal(result.batch?.steps.length, 2);
    assert.equal(result.batch?.steps[0].ok, true); assert.equal(result.batch?.steps[1].ok, false);
    assert.equal(result.executed, true); assert.equal(result.verified, false);
    assert.equal(result.semanticOutcome?.status, "passed", "postcondition evidence remains independent of the failed batch");
    assert.equal(f.edges.some(args => args.includes("46:1")), false, "C must never be submitted");
    assert.equal(f.edges.filter(args => args.includes("30:1")).length, 1, "A must not be replayed");
    assert.equal(f.edges.some(args => args.includes("48:0")), true, "possibly submitted B is released");
  }],
  ["old execution cleanup reserves its queue before the next execution holds a key", async f => {
    const taskId = "linux-outcome-execution-ownership";
    setHeldInputReleaser(owner => f.backend.releaseHeldInput(owner));
    try {
      computerUseRunCoordinator.scope(taskId, undefined, "old-execution");
      const fresh = computerUseRunCoordinator.scope(taskId, undefined, "new-execution");
      const held = await f.backend.execute({ action: "key_down", key: "Shift", windowHandle: f.activeHandle, taskId }, fresh);
      await nextTurn();
      assert.equal(fresh.aborted, false); assert.deepEqual(held.heldKeys, [42]);
      assert.deepEqual(f.edges, [["key", "42:1"]], "old execution cleanup must not release a new execution's DOWN");
      await f.backend.execute({ action: "key_up", key: "Shift", taskId }, fresh);
      assert.deepEqual(f.edges, [["key", "42:1"], ["key", "42:0"]]);
    } finally {
      computerUseRunCoordinator.endTask(taskId);
      setHeldInputReleaser(undefined);
    }
  }],
];

async function main() {
  for (const [name, test] of tests) {
    const fixture = new Fixture();
    try { await test(fixture); console.log(`PASS ${name}`); }
    finally { await fixture.backend.shutdown(); }
  }
  console.log(`PASS ${tests.length} Linux native outcome contracts (injected dependencies; no desktop acceptance claim)`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
