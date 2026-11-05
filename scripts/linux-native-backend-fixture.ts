import { LinuxComputerUseBackend } from "../src/main/platform/computer-use/linux/LinuxComputerUseBackend";
import type { AtSpiControlInfo, AtSpiDriverApi, AtSpiInspection } from "../src/main/platform/computer-use/linux/atspiTypes";
import { monitorLayoutId, parseHyprlandMonitors } from "../src/main/platform/computer-use/linux/hyprlandMonitors";
import { parseHyprlandWindows, windowGeometryIdentity, type HyprlandDesktop, type LinuxWindowInfo } from "../src/main/platform/computer-use/linux/hyprlandWindows";
import { ComputerUseError, type ComputerExecInput, type Point } from "../src/main/platform/computer-use/protocol";
import { throwIfCancelled } from "../src/main/platform/computer-use/linux/nativeHelpers";
import { YdotoolInput } from "../src/main/platform/computer-use/linux/ydotool";

/** Deterministic, dependency-injected integration fixture. No display, capture or input side effect. */
export function createLinuxFixture() {
  const monitors = parseHyprlandMonitors([{ id: 1, name: "DP-left", x: -1600, y: 0, width: 2000, height: 1200, scale: 1.25, transform: 0, activeWorkspace: { id: 1 } }, { id: 2, name: "DP-right", x: 0, y: 0, width: 2400, height: 1600, scale: 2, transform: 0, activeWorkspace: { id: 2 } }]);
  const handle = "0x123456789abcdef0123456789abcdef";
  const window = parseHyprlandWindows([{ address: handle, pid: 1001, class: "Fixture", title: "Fixture", at: [-1500, 80], size: [600, 500], monitor: 1, workspace: { id: 1 }, mapped: true, hidden: false, xwayland: false, floating: true }], monitors, handle, 1_000)[0];
  window.identityToken = "lifetime:1"; window.identity = windowGeometryIdentity(window);
  const state = {
    time: 1_000, windows: [window], monitors, activeHandle: handle as string | undefined, layoutId: monitorLayoutId(monitors), cursor: { x: -1400, y: 120 },
    edges: [] as string[][], moves: [] as Array<Point & { time: number }>, focusCalls: [] as string[], sleepCalls: [] as number[], clipboard: [] as string[],
    captureCalls: 0, inspectCalls: 0, invokeCalls: 0, setValueCalls: 0, atspiFocusCalls: 0, snapshotCalls: 0,
    replaceOnPaste: false,
    treeUnavailable: false, treeTruncated: false, captureFailure: false, invokeVerified: false, text: "", semanticMode: "normal" as "normal" | "unknown" | "close",
    controls: [] as AtSpiControlInfo[],
    snapshotHook: undefined as undefined | (() => void | Promise<void>),
    moveHook: undefined as undefined | ((point: Point) => void | Promise<void>),
    inputHook: undefined as undefined | ((args: readonly string[]) => void | Promise<void>),
    sleepHook: undefined as undefined | ((ms: number) => void | Promise<void>),
    readControlHook: undefined as undefined | ((control: AtSpiControlInfo) => AtSpiControlInfo),
    inspectHook: undefined as undefined | (() => void | Promise<void>),
  };
  const refs = new Map<string, AtSpiControlInfo>();
  const compositor: HyprlandDesktop = {
    async snapshot(signal) { throwIfCancelled(signal); state.snapshotCalls++; await state.snapshotHook?.(); throwIfCancelled(signal); return structuredClone({ windows: state.windows, monitors: state.monitors, activeHandle: state.activeHandle, layoutId: state.layoutId, observedAt: state.time }); },
    async activeHandle() { return state.activeHandle; },
    async cursor() { return { ...state.cursor }; },
    async focus(target) { state.focusCalls.push(target.handle); state.activeHandle = target.handle; state.windows.forEach(w => { w.foreground = w.handle === target.handle; if (w.foreground) w.visible = true; }); return structuredClone(state.windows.find(w => w.handle === target.handle)!); },
    async movePointer(point, signal) { throwIfCancelled(signal); state.moves.push({ ...point, time: state.time }); await state.moveHook?.(point); state.cursor = { ...point }; return { ...state.cursor }; },
    async shutdown() {},
  };
  const atspi: AtSpiDriverApi = {
    async probe() { return { available: !state.treeUnavailable, generation: "test", checkedAt: state.time }; },
    async inspectWindow(target, options, signal) {
      throwIfCancelled(signal); state.inspectCalls++; await state.inspectHook?.(); throwIfCancelled(signal);
      if (state.treeUnavailable) throw new ComputerUseError("HOST_UNAVAILABLE", "fixture AT-SPI unavailable");
      const observationId = options?.observationId ?? `obs-${state.inspectCalls}`;
      const controls = (state.controls.length ? state.controls : [{ runtimeId: "fixture-entry", controlType: "Edit", name: "Editor", enabled: true, offscreen: false, keyboardFocusable: true, hasKeyboardFocus: true, patterns: ["ValuePattern", "TextPattern"], text: state.text, boundsReliable: true, clientBoundsDip: { x: 20, y: 20, width: 180, height: 80 }, interfaces: ["org.a11y.atspi.Accessible", "org.a11y.atspi.EditableText", "org.a11y.atspi.Text"], states: ["enabled", "visible", "focused"] }]).map((control, index) => ({ ...control, runtimeId: `${observationId}:control:${index}`, atspi: { busName: ":1.100", objectPath: `/fixture/${index}`, generation: "test", observationId, windowHandle: target.handle, role: 61, boundsReliable: control.boundsReliable === true } } as AtSpiControlInfo));
      controls.forEach(control => refs.set(control.runtimeId, structuredClone(control)));
      return { controls, observationId, boundsReliable: true, diagnostics: [], generation: "test", windowRef: "fixture-window", readableText: state.text, truncated: state.treeTruncated, treeStatus: state.treeTruncated ? "truncated" : controls.length ? "available" : "empty" } as AtSpiInspection;
    },
    async readControl(_window, runtimeId, signal) { throwIfCancelled(signal); const control = refs.get(runtimeId); if (!control) throw new ComputerUseError("STALE_OBSERVATION", "fixture stale reference"); const current = { ...structuredClone(control), text: state.text, hasKeyboardFocus: control.states.includes("focused") }; return state.readControlHook?.(current) ?? current; },
    async focus(target, runtimeId, signal) {
      throwIfCancelled(signal); state.atspiFocusCalls++;
      const before = await atspi.readControl(target, runtimeId, signal);
      for (const [id, control] of refs) {
        const states = control.states.filter(value => value !== "focused");
        if (id === runtimeId) states.push("focused");
        refs.set(id, { ...control, states, hasKeyboardFocus: id === runtimeId });
      }
      const after = await atspi.readControl(target, runtimeId, signal);
      return { executed: true, verified: after.hasKeyboardFocus, before, after, evidence: "fixture Component.GrabFocus focused readback" };
    },
    async invoke(target, runtimeId, _action, signal) { throwIfCancelled(signal); state.invokeCalls++; const before = await atspi.readControl(target, runtimeId, signal); if (state.semanticMode === "unknown") return { executed: "unknown", verified: false, before, evidence: "fixture timeout after submission", readbackError: "timed out" }; if (state.semanticMode === "close") state.windows = state.windows.filter(w => w.handle !== target.handle); return { executed: true, verified: state.invokeVerified, before, after: before, evidence: state.invokeVerified ? "fixture explicitly verified" : "fixture invoked with no semantic delta" }; },
    async setValue(target, runtimeId, text, signal) { throwIfCancelled(signal); state.setValueCalls++; const before = await atspi.readControl(target, runtimeId, signal); state.text = text; const after = await atspi.readControl(target, runtimeId, signal); return { executed: true, verified: after.text === text, before, after, evidence: "fixture exact text readback" }; },
    async shutdown() {},
  };
  const input = new YdotoolInput({ runner: async (args, signal) => { throwIfCancelled(signal); state.edges.push([...args]); await state.inputHook?.(args); throwIfCancelled(signal); } });
  const backend = new LinuxComputerUseBackend({
    compositor, atspi, input,
    screenshotProvider: { async probe() { return { available: !state.captureFailure, verified: false, checkedAt: state.time }; }, async capture({ window: target }) { state.captureCalls++; if (state.captureFailure) throw new ComputerUseError("CAPTURE_FAILED", "fixture capture failed"); return { screenshot: new Uint8Array([1, 2, 3]), screenshotMimeType: "image/png", imageScale: 1, imageSize: { width: target?.clientRect.width ?? 100, height: target?.clientRect.height ?? 100 }, coordinateSpace: "hyprland-logical", captureRegion: { x: target?.clientOrigin.x ?? 0, y: target?.clientOrigin.y ?? 0, width: target?.clientRect.width ?? 100, height: target?.clientRect.height ?? 100 } }; } },
    windowControl: { async move(_handle, x, y) { window.clientOrigin = { x, y }; window.windowRect = { left: x, top: y, right: x + window.clientRect.width, bottom: y + window.clientRect.height, width: window.clientRect.width, height: window.clientRect.height }; return { x, y, width: window.clientRect.width, height: window.clientRect.height, floating: true }; }, async resize(_handle, width, height) { window.clientRect.width = width; window.clientRect.height = height; return { ...window.clientOrigin, width, height, floating: true }; }, async geometry() { return { ...window.clientOrigin, width: window.clientRect.width, height: window.clientRect.height, floating: true }; } },
    now: () => state.time,
    sleep: async (ms, signal) => { throwIfCancelled(signal); state.sleepCalls.push(ms); state.time += ms; await state.sleepHook?.(ms); throwIfCancelled(signal); },
    pasteViaClipboard: text => { state.clipboard.push(text); },
  });
  const observe = (taskId?: string) => backend.execute({ action: "inspect_window", windowHandle: handle, taskId });
  const inspect = (taskId?: string) => backend.execute({ action: "inspect_controls", windowHandle: handle, taskId });
  const coordinates = async (action: ComputerExecInput["action"], extra: Partial<ComputerExecInput> = {}) => { const observed = await observe(extra.taskId); return backend.execute({ action, windowHandle: handle, observationId: observed.observationId, x: 40, y: 40, ...extra }); };
  return { backend, state, handle, window, compositor, atspi, input, observe, inspect, coordinates };
}
export type LinuxFixture = ReturnType<typeof createLinuxFixture>;
