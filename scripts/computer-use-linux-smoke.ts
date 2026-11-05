/**
 * Strict GTK + Electron Hyprland GUI acceptance. Every input targets an owned
 * disposable fixture. Missing prerequisites are failures, never skip/pass.
 * Built into out/main and the Linux distribution; the wrapper selects either
 * development Electron in Node mode or the normal packaged main process.
 * The latter imports the exported promise through its isolated test inspector.
 */
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { LinuxComputerUseBackend } from "../src/main/platform/computer-use/linux/LinuxComputerUseBackend";
import { createHyprlandWindowControl } from "../src/main/platform/computer-use/linux/hyprlandWindows";
import { executableInPath } from "../src/main/platform/computer-use/support";
import { ComputerUseError, type ComputerExecInput, type ComputerExecOutput, type ControlInfo, type WindowInfo } from "../src/main/platform/computer-use/protocol";
import type { LinuxScreenshotProvider } from "../src/main/platform/computer-use/linux/screenshotProvider";
import type { AtSpiControlInfo } from "../src/main/platform/computer-use/linux/atspiTypes";

const command = promisify(execFile);
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const reportDir = process.env.MYBUDDY_LINUX_CU_REPORT_DIR ?? join(process.cwd(), "out/tests/linux-computer-use");
mkdirSync(reportDir, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "mybuddy-linux-cu-"));
const taskId = `linux-acceptance-${randomUUID()}`;
const title = `MyBuddy Linux acceptance ${randomUUID()}`;
const report: {
  startedAt: string; finishedAt?: string; status: string; mode: string;
  runtime: Record<string, unknown>; tests: Array<{ name: string; status: string; evidence?: unknown; error?: string }>;
  [key: string]: unknown;
} = {
  startedAt: new Date().toISOString(), status: "running",
  mode: process.env.MYBUDDY_LINUX_CU_MODE ?? "development-backend",
  runtime: {
    pid: process.pid, executable: process.execPath, node: process.versions.node, electron: process.versions.electron,
    processType: (process as NodeJS.Process & { type?: string }).type,
    nodeMode: process.env.ELECTRON_RUN_AS_NODE === "1",
  }, tests: [],
};

async function waitFor<T>(read: () => Promise<T | undefined | false>, label: string, timeout = 10_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await pause(60);
  }
  throw new Error(`Timeout: ${label}`);
}
async function check(name: string, run: () => Promise<unknown> | unknown): Promise<void> {
  try {
    const evidence = await run();
    report.tests.push({ name, status: "passed", evidence });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.tests.push({ name, status: "failed", error: String(error instanceof Error ? error.stack : error) });
    throw error;
  }
}

interface FixtureState {
  semanticCount: number; clicks: number; doubleClicks: number; holds: number[];
  modifiers: Array<{ ctrl: boolean; shift: boolean; alt: boolean; meta: boolean }>;
  pressedKeys: string[]; pressedCodes: string[];
  keyEvents: Array<{ key: string; down: boolean; [key: string]: unknown }>; focusEvents: Array<Record<string, unknown>>;
  pointerDown: boolean; dragMoves: number; dragDelta: number[]; dragDuration: number;
  text: string; scrollTop: number; popupOpen: boolean;
  pointerEvents: Array<{ sequence: number; type: string; target: unknown; client: { x: number; y: number }; screen: { x: number; y: number }; [key: string]: unknown }>;
  pointerEventSequence: number; pointerEventsDropped: number; diagnostics: Record<string, unknown>;
}
interface ElectronFixture {
  child: ChildProcessWithoutNullStreams;
  identity: { pid: number; electron: string; node: string };
  call(method: string, windowId?: number): Promise<unknown>;
  state(windowId?: number): Promise<FixtureState>;
  close(): Promise<void>;
}

async function launchElectronFixture(): Promise<ElectronFixture> {
  const executable = process.env.MYBUDDY_LINUX_FIXTURE_ELECTRON;
  assert.ok(executable && existsSync(executable), "A separate pinned Electron fixture runtime is required");
  const profile = mkdtempSync(join(root, "electron-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: profile, XDG_CONFIG_HOME: join(profile, ".config"),
    MYBUDDY_LINUX_FIXTURE_USER_DATA: join(profile, "chromium"), MYBUDDY_LINUX_FIXTURE_TITLE: title,
    GNOME_ACCESSIBILITY: "1", NO_AT_BRIDGE: "0",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [join(__dirname, "linux-computer-use-fixture.cjs"), "--ozone-platform=wayland"], {
    cwd: root, env, stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let sequence = 0;
  let readyResolve!: (value: ElectronFixture["identity"]) => void;
  let readyReject!: (reason: Error) => void;
  const ready = new Promise<ElectronFixture["identity"]>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const timer = setTimeout(() => readyReject(new Error("Electron fixture startup timeout")), 20_000);
  let stderr = "";
  child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(-40_000); });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line: string) => {
    if (!line.startsWith("LINUX_CU_FIXTURE ")) return;
    try {
      const message = JSON.parse(line.slice("LINUX_CU_FIXTURE ".length));
      if (message.event === "ready") readyResolve(message);
      if (message.event === "error") readyReject(new Error(message.error));
      const request = pending.get(message.id);
      if (request) {
        pending.delete(message.id); clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error)); else request.resolve(message.value);
      }
    } catch (error) { readyReject(error instanceof Error ? error : new Error(String(error))); }
  });
  child.on("error", readyReject);
  child.on("exit", (code) => {
    readyReject(new Error(`Electron fixture exited ${code}: ${stderr}`));
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("fixture exited")); }
    pending.clear();
  });
  const call = (method: string, windowId = 1): Promise<unknown> => new Promise((resolve, reject) => {
    const id = ++sequence;
    const requestTimer = setTimeout(() => { pending.delete(id); reject(new Error(`fixture RPC timed out: ${method}`)); }, 5_000);
    pending.set(id, { resolve, reject, timer: requestTimer });
    child.stdin.write(JSON.stringify({ id, method, windowId }) + "\n");
  });
  try {
    const identity = await ready;
    assert.equal(identity.pid, child.pid);
    assert.equal(identity.electron, process.versions.electron, "fixture and backend Electron versions must match");
    return {
      child, identity, call,
      state: async (windowId) => await call("snapshot", windowId) as FixtureState,
      close: async () => {
        if (child.exitCode === null && !child.signalCode) await call("quit").catch(() => undefined);
        for (let i = 0; i < 20 && child.exitCode === null && !child.signalCode; i += 1) await pause(50);
        if (child.exitCode === null && !child.signalCode) child.kill("SIGTERM");
        lines.close();
        writeFileSync(join(reportDir, `electron-fixture-${identity.pid}.log`), stderr);
      },
    };
  } catch (error) {
    child.kill("SIGTERM"); lines.close();
    writeFileSync(join(reportDir, "electron-fixture-startup-failure.log"), stderr);
    throw error;
  } finally { clearTimeout(timer); }
}

let captureCalls = 0;
const failingCapture: LinuxScreenshotProvider = {
  probe: async () => ({ available: false, verified: false, checkedAt: Date.now(), reason: "acceptance: screenshot provider deliberately disabled" }),
  capture: async () => { captureCalls += 1; throw new ComputerUseError("CAPTURE_FAILED", "acceptance: screenshot provider deliberately failed"); },
};
let backend: LinuxComputerUseBackend | undefined;
let fixture: ElectronFixture | undefined;
let gtk: ChildProcessWithoutNullStreams | undefined;
let window: WindowInfo;
let fractionalMonitor: { name: string; scale: number; x: number; y: number } | undefined;
const captureAudit = join(reportDir, "forbidden-capture-commands.log");
const originalPath = process.env.PATH;
const originalCaptureAudit = process.env.MYBUDDY_LINUX_CU_CAPTURE_AUDIT;

function denyCaptureCommands(): void {
  const bin = join(root, "forbidden-capture"); mkdirSync(bin);
  process.env.MYBUDDY_LINUX_CU_CAPTURE_AUDIT = captureAudit;
  for (const name of ["grim", "slurp", "tesseract", "computer-use-linux", "computer-use-linux-linux-x64", "computer-use-linux-linux-arm64"]) {
    const file = join(bin, name);
    writeFileSync(file, '#!/bin/sh\nprintf "%s\\n" "$0" >> "$MYBUDDY_LINUX_CU_CAPTURE_AUDIT"\nexit 97\n');
    chmodSync(file, 0o755);
  }
  process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
}
const forbiddenCalls = (): string[] => existsSync(captureAudit) ? readFileSync(captureAudit, "utf8").trim().split(/\r?\n/).filter(Boolean) : [];
const isButton = (control: ControlInfo): boolean => /button/i.test(control.controlType);
function textWritePath(control: ControlInfo): "atspi-editable-text" | "atspi-value" | "atspi-focus-clipboard" | undefined {
  if (!control.enabled) return undefined;
  const { interfaces = [], states = [] } = control as Partial<AtSpiControlInfo>;
  if (interfaces.includes("org.a11y.atspi.EditableText")) return "atspi-editable-text";
  if (interfaces.includes("org.a11y.atspi.Value")) return "atspi-value";
  // Electron's editable Text control need not export EditableText/Value. Match
  // the existing backend focus-and-paste contract, not an invented pattern.
  if ((interfaces.includes("org.a11y.atspi.Text") || control.patterns.includes("Text")) &&
    states.includes("editable") && control.keyboardFocusable) return "atspi-focus-clipboard";
  return undefined;
}
const isEditable = (control: ControlInfo): boolean => textWritePath(control) !== undefined;
const isGtkEditableText = (control: ControlInfo): boolean => textWritePath(control) === "atspi-editable-text";
const textControlEvidence = (control: ControlInfo) => ({
  ...control, writePath: textWritePath(control),
});
async function inspectTarget(target = window): Promise<ComputerExecOutput> {
  const result = await backend!.execute({ action: "inspect_controls", windowHandle: target.handle, taskId, maxDepth: 24, maxNodes: 1200 });
  assert.equal(result.truncated, false, "fixture tree must be fully traversed before claiming unique controls");
  assert.ok(result.observationId, "structured inspection must produce an observation identity");
  return result;
}
function named(tree: ComputerExecOutput, name: string, predicate: (control: ControlInfo) => boolean = () => true): ControlInfo {
  const matches = (tree.controls ?? []).filter((control) => control.name === name && predicate(control));
  assert.equal(matches.length, 1, `expected exactly one ${name}: ${JSON.stringify(matches)}; observed controls: ${JSON.stringify((tree.controls ?? []).map(({ name, controlType, patterns }) => ({ name, controlType, patterns })))}`);
  return matches[0];
}
const pointerActions: Array<Record<string, unknown>> = [];
report.pointerActions = pointerActions;
const pointerState = (state: FixtureState) => ({
  clicks: state.clicks, doubleClicks: state.doubleClicks, holds: state.holds, modifiers: state.modifiers,
  pressedKeys: state.pressedKeys, pressedCodes: state.pressedCodes, keyEvents: state.keyEvents, focusEvents: state.focusEvents,
  pointerDown: state.pointerDown, pointerEventSequence: state.pointerEventSequence,
  pointerEventsDropped: state.pointerEventsDropped, pointerEvents: state.pointerEvents, diagnostics: state.diagnostics,
});
async function observedPointer(input: ComputerExecInput, tree: ComputerExecOutput, control: ControlInfo, coordinateSpace: "client-logical" | "screen-logical"): Promise<ComputerExecOutput> {
  const target = tree.window ?? window;
  const evidence: Record<string, unknown> = {
    index: pointerActions.length + 1, startedAt: new Date().toISOString(), coordinateSpace,
    request: input, control, target,
    // Derived for comparison only; never use DOM geometry to choose an input point.
    requestedScreenLogical: { x: input.x! + (coordinateSpace === "client-logical" ? target.clientOrigin.x : 0),
      y: input.y! + (coordinateSpace === "client-logical" ? target.clientOrigin.y : 0) },
  };
  pointerActions.push(evidence);
  evidence.applicationBefore = await fixture!.state().then(pointerState, (error: unknown) => ({ error: String(error) }));
  try {
    const result = await backend!.execute(input);
    evidence.result = result;
    return result;
  } catch (error) {
    evidence.error = { message: String(error), ...(error instanceof ComputerUseError ? { code: error.code, details: error.details } : {}) };
    throw error;
  } finally {
    // Both observations are read-only and also run after a rejected input. Preserve
    // the primary failure if diagnostic collection itself is unavailable.
    const [application, compositor] = await Promise.all([
      fixture!.state().then(pointerState, (error: unknown) => ({ error: String(error) })),
      command("hyprctl", ["-j", "cursorpos"], { timeout: 2_000 }).then(({ stdout }) => ({
        observedAt: new Date().toISOString(), coordinateSpace: "hyprland-logical", position: JSON.parse(stdout),
      }), (error: unknown) => ({ error: String(error) })).catch((error: unknown) => ({ error: String(error) })),
    ]);
    evidence.applicationAfter = application; evidence.compositorPointerAfter = compositor;
    evidence.finishedAt = new Date().toISOString();
  }
}
async function pointer(name: string, action: ComputerExecInput["action"], extra: Partial<ComputerExecInput> = {}): Promise<ComputerExecOutput> {
  const tree = await inspectTarget();
  if (!report.firstPointerInspection) report.firstPointerInspection = tree;
  const control = named(tree, name, name === "Scroll area" ? (item) => !/text|label/i.test(item.controlType) : isButton);
  assert.equal(control.boundsReliable, true, `${name}: pointer input needs verified AT-SPI bounds; observed=${JSON.stringify(control)}`);
  const bounds = control.clientBoundsDip;
  assert.ok(bounds && bounds.width > 0 && bounds.height > 0);
  return observedPointer({ action, windowHandle: window.handle, taskId,
    observationId: tree.observationId, controlRuntimeId: control.runtimeId,
    x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, ...extra }, tree, control, "client-logical");
}
async function screenPointer(name: string, action: ComputerExecInput["action"], extra: Partial<ComputerExecInput> = {}): Promise<ComputerExecOutput> {
  const tree = await inspectTarget();
  const control = named(tree, name, name === "Scroll area" ? (item) => !/text|label/i.test(item.controlType) : isButton);
  assert.equal(control.boundsReliable, true);
  const bounds = control.screenBoundsLogical;
  assert.ok(bounds && bounds.width > 0 && bounds.height > 0, "screen actions need explicit logical bounds");
  const x = bounds.left + bounds.width / 2; const y = bounds.top + bounds.height / 2;
  const drag = action === "drag_screen" || action === "mouse_drag";
  return observedPointer({ action, windowHandle: window.handle, taskId, observationId: tree.observationId,
    controlRuntimeId: drag ? undefined : control.runtimeId,
    x, y, ...(drag ? { x2: x + 55, y2: y + 12 } : {}), ...extra }, tree, control, "screen-logical");
}
async function semantic(name: string, action: "invoke_control" | "set_control_value", text?: string): Promise<ComputerExecOutput> {
  const tree = await inspectTarget();
  const control = named(tree, name, action === "set_control_value" ? isEditable : isButton);
  return backend!.execute({ action, windowHandle: window.handle, taskId, observationId: tree.observationId, controlRuntimeId: control.runtimeId, text });
}
async function windowFor(pid: number, expectedTitle: string): Promise<WindowInfo> {
  return waitFor(async () => {
    const matches = ((await backend!.execute({ action: "list_windows", taskId })).windows ?? [])
      .filter((candidate) => candidate.processId === pid && candidate.title === expectedTitle);
    assert.ok(matches.length <= 1, "fixture PID/title unexpectedly identifies multiple windows");
    return matches[0];
  }, "owned fixture compositor identity");
}
async function placeFixtureOnFractionalOutput(): Promise<void> {
  if (!fractionalMonitor) return;
  await backend!.execute({ action: "resize_window", windowHandle: window.handle, taskId, windowWidth: 900, windowHeight: 700 });
  await backend!.execute({ action: "move_window", windowHandle: window.handle, taskId,
    windowX: fractionalMonitor.x + 30, windowY: fractionalMonitor.y + 30 });
  window = (await backend!.execute({ action: "inspect_window", windowHandle: window.handle, taskId })).window!;
  assert.equal(window.monitorHandle, fractionalMonitor.name, "the fixture must actually be on the fractional-scale output");
  assert.equal(window.scaleFactor, fractionalMonitor.scale);
  assert.ok(window.monitorRect && window.windowRect.left >= window.monitorRect.left && window.windowRect.top >= window.monitorRect.top &&
    window.windowRect.right <= window.monitorRect.right && window.windowRect.bottom <= window.monitorRect.bottom,
  `the actual fractional-scale output must fit the owned acceptance window: ${JSON.stringify({ windowRect: window.windowRect, monitorRect: window.monitorRect })}`);
  report.fractionalFixture = { pid: fixture!.identity.pid, windowHandle: window.handle,
    monitor: window.monitorHandle, scale: window.scaleFactor, windowRect: window.windowRect, monitorRect: window.monitorRect };
}

async function main(): Promise<void> {
  await check("real Hyprland session and fixed tool prerequisites", async () => {
    assert.equal(process.platform, "linux");
    for (const key of ["WAYLAND_DISPLAY", "HYPRLAND_INSTANCE_SIGNATURE", "DBUS_SESSION_BUS_ADDRESS"]) assert.ok(process.env[key], `Missing ${key}`);
    for (const tool of ["hyprctl", "ydotool", "wl-copy", "zenity"]) assert.ok(executableInPath(tool), `Missing ${tool}; this is a failed GUI prerequisite, not a skip`);
    const monitors = JSON.parse((await command("hyprctl", ["-j", "monitors"], { timeout: 5_000 })).stdout) as Array<Record<string, unknown>>;
    report.monitors = monitors.map(({ name, width, height, scale, x, y, transform }) => ({ name, width, height, scale, x, y, transform }));
    report.hyprlandVersion = (await command("hyprctl", ["version"], { timeout: 5_000 })).stdout.trim();
    report.gtkFixtureVersion = (await command("zenity", ["--version"], { timeout: 5_000 })).stdout.trim();
    report.hasFractionalScale = monitors.some((monitor) => typeof monitor.scale === "number" && !Number.isInteger(monitor.scale));
    const fractional = monitors.find((monitor) => typeof monitor.scale === "number" && monitor.scale > 0 && !Number.isInteger(monitor.scale) &&
      typeof monitor.name === "string" && typeof monitor.x === "number" && typeof monitor.y === "number");
    if (fractional) fractionalMonitor = { name: String(fractional.name), scale: Number(fractional.scale), x: Number(fractional.x), y: Number(fractional.y) };
    return { monitors: report.monitors, session: "Hyprland/Wayland", screenshotsDisabled: true };
  });
  denyCaptureCommands();
  fixture = await launchElectronFixture();
  report.fixture = fixture.identity;
  backend = new LinuxComputerUseBackend({ screenshotProvider: failingCapture });

  await check("cold diagnostic probe succeeds with the screenshot provider disabled", async () => {
    await backend!.refreshDiagnostics();
    const status = backend!.status();
    assert.equal(status.backend, "linux-atspi");
    assert.equal(status.supported, true, status.detail);
    for (const name of ["accessibility", "window", "pointer", "keyboard"] as const) {
      assert.equal(status.capabilities?.[name]?.available, true, `${name}: ${status.capabilities?.[name]?.reason ?? status.detail}`);
    }
    assert.equal(status.capabilities?.screenshot?.available, false);
    assert.equal(captureCalls, 0); assert.deepEqual(forbiddenCalls(), []);
    return status;
  });
  window = await windowFor(fixture.identity.pid, title);
  await backend.execute({ action: "focus_window", windowHandle: window.handle, taskId });
  await check("owned fixture is placed on the actual fractional-scale output when present", async () => {
    await placeFixtureOnFractionalOutput();
    return report.fractionalFixture ?? { fractionalOutputUnavailable: true, fullAcceptanceBlocked: true };
  });

  await check("reliable AT-SPI bounds drive click, double-click, long press and modifiers", async () => {
    const before = await fixture!.state();
    await pointer("Pointer target", "move_client");
    await pointer("Pointer target", "click_client");
    await pointer("Pointer target", "click_client", { clickCount: 2 });
    await pointer("Pointer target", "click_client", { holdMs: 350 });
    await pointer("Pointer target", "click_client", { modifiers: ["ctrl"] });
    const after = await fixture!.state();
    report.pointerClickCheck = { expectedClicks: 5, receivedClicks: after.clicks - before.clicks,
      before: pointerState(before), after: pointerState(after), actionIndexes: pointerActions.map((entry) => entry.index) };
    assert.equal(after.clicks - before.clicks, 5, "all five clicks must reach Pointer target; see pointerClickCheck and pointerActions in acceptance-report.json for DOM targets/client/screen coordinates, AT-SPI bounds, requests and compositor cursor readback");
    assert.ok(after.doubleClicks > before.doubleClicks);
    assert.ok(after.holds.some((duration) => duration >= 300), "long press must spend real time with the button down");
    assert.ok(after.modifiers.some((modifiers) => modifiers.ctrl));
    return { clicks: after.clicks, doubleClicks: after.doubleClicks, holds: after.holds, modifiers: after.modifiers };
  });
  await check("GTK exports real controls and receives semantic Chinese/Unicode writes", async () => {
    const gtkTitle = `GTK Linux acceptance ${randomUUID()}`;
    const gtkHome = mkdtempSync(join(root, "gtk-"));
    gtk = spawn("zenity", ["--forms", `--title=${gtkTitle}`, "--text=Isolated AT-SPI acceptance", "--separator=|", "--add-entry=First input", "--add-entry=Second input"], {
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HOME: gtkHome, XDG_CONFIG_HOME: join(gtkHome, ".config"), LANG: "C.UTF-8", LC_ALL: "C.UTF-8", NO_AT_BRIDGE: "0", GTK_A11Y: "atspi" },
    });
    let gtkOutput = ""; let gtkError = "";
    gtk.stdout.on("data", (data: Buffer) => { gtkOutput += data.toString(); });
    gtk.stderr.on("data", (data: Buffer) => { gtkError = (gtkError + data.toString()).slice(-20_000); });
    const exited = new Promise<number | null>((resolve, reject) => { gtk!.once("exit", resolve); gtk!.once("error", reject); });
    assert.ok(gtk.pid);
    const target = await windowFor(gtk.pid, gtkTitle);
    const marker = "GTK 中文 🧪 café Ω";
    const writes: Array<Record<string, unknown>> = [];
    report.gtkTextWrites = writes;
    for (let index = 0; index < 2; index += 1) {
      const tree = await inspectTarget(target);
      const entries = (tree.controls ?? []).filter(isGtkEditableText);
      report.gtkEntries = entries.map(textControlEvidence);
      assert.equal(entries.length, 2, "the dedicated GTK form must export its two EditableText fields");
      const next = entries.find((control) => control.text !== marker);
      assert.ok(next);
      const write: Record<string, unknown> = { requestedText: marker, before: textControlEvidence(next) };
      writes.push(write);
      const result = await backend!.execute({ action: "set_control_value", windowHandle: target.handle, taskId,
        observationId: tree.observationId, controlRuntimeId: next.runtimeId, text: marker });
      write.result = result;
      assert.equal(result.verified, true);
    }
    const tree = await inspectTarget(target);
    const readback = (tree.controls ?? []).filter(isGtkEditableText);
    report.gtkTextReadback = readback.map(textControlEvidence);
    assert.equal(readback.length, 2);
    assert.ok(readback.every((control) => control.text === marker && (control as AtSpiControlInfo).textTruncated !== true),
      "both GTK fields must retain complete AT-SPI Unicode readback before submitting the application");
    const okay = (tree.controls ?? []).filter((control) => isButton(control) && /^(OK|Ok)$/.test(control.name ?? ""));
    assert.equal(okay.length, 1, "GTK form must expose exactly one OK action");
    const invoked = await backend!.execute({ action: "invoke_control", windowHandle: target.handle, taskId,
      observationId: tree.observationId, controlRuntimeId: okay[0].runtimeId });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const exit = await Promise.race([exited, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("GTK submit did not finish")), 5_000); })]).finally(() => clearTimeout(timeout));
    assert.equal(exit, 0, gtkError);
    assert.equal(gtkOutput.trimEnd(), `${marker}|${marker}`);
    writeFileSync(join(reportDir, "gtk-fixture.log"), gtkError);
    return { bridgeConditions: { GTK_A11Y: "atspi", NO_AT_BRIDGE: "0" }, stdout: gtkOutput.trimEnd(), executed: invoked.executed, backendVerified: invoked.verified, applicationExitCode: exit };
  });
  await backend.execute({ action: "focus_window", windowHandle: window.handle, taskId });
  await check("Electron invoke and Chinese/Unicode text replacement reach the real application", async () => {
    await semantic("Semantic counter", "invoke_control");
    assert.equal((await fixture!.state()).semanticCount, 1);
    const tree = await inspectTarget();
    const control = named(tree, "Unicode input", isEditable);
    const text = "中文输入 🧪 café Ω\n第二行";
    const evidence: Record<string, unknown> = { requestedText: text, before: textControlEvidence(control) };
    report.electronTextCheck = evidence;
    const written = await backend!.execute({ action: "set_control_value", windowHandle: window.handle, taskId,
      observationId: tree.observationId, controlRuntimeId: control.runtimeId, text });
    evidence.result = written;
    const state = await fixture!.state();
    evidence.applicationReadback = { text: state.text, diagnostics: state.diagnostics };
    assert.equal(written.verified, true, "text replacement must have complete matching AT-SPI readback, including the focus/clipboard path");
    assert.equal(written.control?.text, text, "AT-SPI must read back the complete Chinese/Unicode value");
    assert.notEqual((written.control as AtSpiControlInfo | undefined)?.textTruncated, true);
    if (textWritePath(control) === "atspi-focus-clipboard") {
      assert.equal(written.pasted, true, "Text-only Electron controls must exercise verified focus plus clipboard replacement");
      assert.equal(written.control?.hasKeyboardFocus, true);
    }
    assert.equal(state.text, text, "the application must independently retain the exact Unicode value");
    return evidence;
  });
  await check("keyboard and mouse down persist until explicit up, including intervening observation", async () => {
    await backend!.execute({ action: "key_down", key: "Shift", windowHandle: window.handle, taskId });
    await inspectTarget();
    assert.ok((await fixture!.state()).pressedKeys.includes("Shift"));
    await pointer("Pointer target", "click_client");
    assert.equal((await fixture!.state()).modifiers.at(-1)?.shift, true);
    await backend!.execute({ action: "key_up", key: "Shift", windowHandle: window.handle, taskId });
    await pointer("Pointer target", "mouse_down_client");
    await inspectTarget();
    assert.equal((await fixture!.state()).pointerDown, true);
    await pointer("Pointer target", "mouse_up_client");
    const after = await fixture!.state();
    assert.equal(after.pointerDown, false); assert.deepEqual(after.pressedKeys, []);
    return { heldAcrossObservation: true, keysAfter: after.pressedKeys, buttonAfter: after.pointerDown };
  });
  await check("scroll and timed drag produce application-visible wheel/motion effects", async () => {
    await pointer("Scroll area", "scroll_client", { notches: -3 });
    assert.ok((await fixture!.state()).scrollTop > 0);
    const tree = await inspectTarget(); const control = named(tree, "Drag target", isButton);
    assert.equal(control.boundsReliable, true); assert.ok(control.clientBoundsDip);
    const b = control.clientBoundsDip;
    await backend!.execute({ action: "drag_client", windowHandle: window.handle, taskId, observationId: tree.observationId,
      x: b.x + b.width / 2, y: b.y + b.height / 2,
      x2: b.x + b.width / 2 + 80, y2: b.y + b.height / 2 + 20, durationMs: 500, steps: 12 });
    const after = await fixture!.state();
    assert.ok(after.dragMoves >= 4, `drag received only ${after.dragMoves} motion events`);
    assert.ok(after.dragDuration >= 400);
    assert.ok(after.dragDelta[0] >= 70);
    return { scrollTop: after.scrollTop, dragMoves: after.dragMoves, dragDuration: after.dragDuration, dragDelta: after.dragDelta };
  });
  await check("global logical pointer actions reach the same fixture at the observed output scale", async () => {
    const before = await fixture!.state();
    await screenPointer("Pointer target", "mouse_move");
    await screenPointer("Pointer target", "mouse_click");
    assert.equal((await fixture!.state()).clicks, before.clicks + 1);
    await screenPointer("Scroll area", "scroll", { notches: -2 });
    assert.ok((await fixture!.state()).scrollTop > before.scrollTop);
    const drags = [];
    for (const action of ["drag_screen", "mouse_drag"] as const) {
      await screenPointer("Drag target", action, { durationMs: 300, steps: 8 });
      const state = await fixture!.state();
      assert.ok(state.dragMoves >= 2 && state.dragDuration >= 240 && state.dragDelta[0] >= 45);
      drags.push({ action, moves: state.dragMoves, duration: state.dragDuration, delta: state.dragDelta });
    }
    return { monitor: window.monitorHandle, scale: window.scaleFactor, clicksReceived: 1, drags };
  });
  await check("keyboard/clipboard Unicode input preserves the requested content", async () => {
    const tree = await inspectTarget(); const control = named(tree, "Unicode input", isEditable);
    assert.ok(control.boundsReliable && control.clientBoundsDip);
    const bounds = control.clientBoundsDip;
    await observedPointer({ action: "click_client", windowHandle: window.handle, taskId, observationId: tree.observationId,
      controlRuntimeId: control.runtimeId, x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }, tree, control, "client-logical");
    const evidence: Record<string, unknown> = { before: textControlEvidence(control) };
    report.keyboardTextCheck = evidence;
    await backend!.execute({ action: "key_press", key: "Ctrl+A", windowHandle: window.handle, taskId });
    const text = "键盘粘贴 🧪 Unicode αβ";
    evidence.requestedTyped = text;
    evidence.typeResult = await backend!.execute({ action: "type_text", text, windowHandle: window.handle, taskId });
    const typedState = await fixture!.state();
    evidence.typedReadback = { text: typedState.text, diagnostics: typedState.diagnostics };
    assert.equal(typedState.text, text);
    await backend!.execute({ action: "key_press", key: "Ctrl+A", windowHandle: window.handle, taskId });
    const pasted = "粘贴路径 🧪 второй";
    evidence.requestedPasted = pasted;
    evidence.pasteResult = await backend!.execute({ action: "paste_text", text: pasted, windowHandle: window.handle, taskId });
    const pastedState = await fixture!.state();
    evidence.pastedReadback = { text: pastedState.text, diagnostics: pastedState.diagnostics };
    assert.equal(pastedState.text, pasted);
    return evidence;
  });
  await check("popup controls are reobserved and semantically operated", async () => {
    await semantic("Open popup", "invoke_control");
    assert.equal((await fixture!.state()).popupOpen, true);
    await semantic("Close popup", "invoke_control");
    assert.equal((await fixture!.state()).popupOpen, false);
    return { popupOpened: true, popupClosed: true };
  });
  await check("rebuilt controls reject their old object references", async () => {
    const tree = await inspectTarget(); const old = named(tree, "Unicode input", isEditable);
    await fixture!.call("rebuildInput"); await pause(150);
    await assert.rejects(backend!.execute({ action: "set_control_value", windowHandle: window.handle, taskId,
      controlRuntimeId: old.runtimeId, observationId: tree.observationId, text: "must not be entered" }));
    assert.equal((await fixture!.state()).text, "");
    return { oldReferenceRejected: true };
  });
  await check("window move/resize invalidates coordinate observations", async () => {
    const before = await backend!.execute({ action: "inspect_window", windowHandle: window.handle, taskId });
    assert.ok(before.window && before.observationId);
    const move = await backend!.execute({ action: "move_window", windowHandle: window.handle, taskId,
      windowX: before.window.windowRect.left + 20, windowY: before.window.windowRect.top + 18 });
    await assert.rejects(backend!.execute({ action: "click_client", windowHandle: window.handle, taskId, observationId: before.observationId, x: 30, y: 30 }));
    const resize = await backend!.execute({ action: "resize_window", windowHandle: window.handle, taskId, windowWidth: 860, windowHeight: 680 });
    window = (await backend!.execute({ action: "inspect_window", windowHandle: window.handle, taskId })).window!;
    assert.ok(window);
    return { moved: move.windowGeometry, resized: resize.windowGeometry, observationRejected: true };
  });
  await check("same-title same-PID windows do not silently select a sibling, and focus is reread", async () => {
    await fixture!.call("createTwin"); await pause(200);
    await assert.rejects(backend!.execute({ action: "inspect_window", windowTitle: title, processId: fixture!.identity.pid, taskId }),
      (error: unknown) => error instanceof ComputerUseError && error.code === "WINDOW_AMBIGUOUS");
    await fixture!.call("focusTwin");
    await backend!.execute({ action: "key_press", key: "F10", windowHandle: window.handle, taskId });
    assert.ok((await fixture!.state(1)).keyEvents.some((event) => event.key === "F10" && event.down));
    assert.ok(!(await fixture!.state(2)).keyEvents.some((event) => event.key === "F10"));
    await fixture!.call("closeTwin");
    return { ambiguousSelectorRejected: true, targetReceivedKey: true, siblingReceivedKey: false };
  });
  await check("cancelled queued input never reaches the desktop", async () => {
    const batch = backend!.execute({ windowHandle: window.handle, taskId, settleMs: 250,
      actions: [{ action: "key_press", key: "F8" }, { action: "key_press", key: "F8" }] });
    const abort = new AbortController();
    const queued = backend!.execute({ action: "key_press", key: "F9", windowHandle: window.handle, taskId }, abort.signal);
    abort.abort();
    const results = await Promise.allSettled([batch, queued]);
    assert.equal(results[1].status, "rejected");
    assert.ok(!(await fixture!.state()).keyEvents.some((event) => event.key === "F9"));
    return { queuedRejected: true, queuedInputReceived: false, batchStatus: results[0].status };
  });
  await check("a partial batch preserves the first input and stops after geometry changes", async () => {
    const observed = await backend!.execute({ action: "inspect_window", windowHandle: window.handle, taskId });
    assert.ok(observed.observationId && observed.window);
    const externalWindow = createHyprlandWindowControl();
    const originalGeometry = await externalWindow.geometry(window.handle);
    assert.ok(originalGeometry);
    const evidence: Record<string, unknown> = { originalGeometry };
    report.partialBatchCheck = evidence;
    const before = await fixture!.state();
    const received = (state: FixtureState, key: string): number => state.keyEvents.filter((event) => event.key === key && event.down).length;
    const pending = backend!.execute({ windowHandle: window.handle, taskId, observationId: observed.observationId, settleMs: 1000,
      actions: [{ action: "key_press", key: "F6" }, { action: "key_press", key: "F7" }] });
    await waitFor(async () => received(await fixture!.state(), "F6") === received(before, "F6") + 1, "first batch key reaches the fixture");
    // On Wayland BrowserWindow.setSize is only a client request and may leave
    // compositor geometry unchanged. Change this owned window externally to the
    // backend's running queue, and prove the guard's actual precondition.
    const requested = { width: originalGeometry.width - 20, height: originalGeometry.height - 20 };
    evidence.requested = requested;
    const resized = await externalWindow.resize(window.handle, requested.width, requested.height);
    evidence.resizedGeometry = resized;
    const result = await pending;
    const after = await fixture!.state();
    evidence.result = result;
    evidence.applicationAfter = { keyEvents: after.keyEvents, pressedKeys: after.pressedKeys, diagnostics: after.diagnostics };
    assert.ok(resized && resized.width === requested.width && resized.height === requested.height,
      "the compositor must actually resize the owned fixture before testing batch invalidation");
    assert.equal(result.batch?.completed, false, "changed geometry must stop the remaining batch");
    assert.equal(result.batch?.steps[0]?.ok, true);
    assert.equal(result.batch?.steps[1]?.ok, false);
    assert.equal(received(after, "F6"), received(before, "F6") + 1);
    assert.equal(received(after, "F7"), received(before, "F7"));
    assert.deepEqual(after.pressedKeys, []);
    window = (await backend!.execute({ action: "inspect_window", windowHandle: window.handle, taskId })).window!;
    return { steps: result.batch?.steps, firstKeyReceived: 1, secondKeyReceived: 0, keysReleased: true };
  });
  for (const cause of ["cancel", "timeout"] as const) {
    await check(`${cause} during a real held press releases input without replay`, async () => {
      const tree = await inspectTarget(); const control = named(tree, "Pointer target", isButton);
      assert.ok(control.boundsReliable && control.clientBoundsDip);
      const b = control.clientBoundsDip;
      const before = await fixture!.state();
      const abort = new AbortController();
      const pending = backend!.execute({ action: "click_client", windowHandle: window.handle, taskId,
        observationId: tree.observationId, controlRuntimeId: control.runtimeId,
        x: b.x + b.width / 2, y: b.y + b.height / 2,
        holdMs: 1600, timeoutMs: cause === "timeout" ? 900 : 5000,
      }, abort.signal).then((output) => ({ ok: true as const, output }), (error: unknown) => ({ ok: false as const, error }));
      await waitFor(async () => (await fixture!.state()).pointerDown, "the held button reaches the real application", 5000);
      if (cause === "cancel") abort.abort();
      const settled = await pending;
      assert.equal(settled.ok, false, `${cause} must reject the interrupted action`);
      await waitFor(async () => !(await fixture!.state()).pointerDown, `${cause} releases the owned button`, 5000);
      const after = await fixture!.state();
      assert.equal(after.holds.length, before.holds.length + 1, "exactly one DOWN/UP pair must reach the application");
      assert.ok(after.holds.at(-1)! < 1500, "cleanup must interrupt the requested hold duration");
      assert.ok(after.clicks - before.clicks <= 1, "cleanup may complete one click but must never replay it");
      assert.deepEqual(after.pressedKeys, []);
      return { receivedHolds: 1, actualHoldMs: after.holds.at(-1), receivedClicks: after.clicks - before.clicks, released: true };
    });
  }
  await check("unexpected worker exit releases owned held keys and invalidates old references", async () => {
    const tree = await inspectTarget(); const old = named(tree, "Unicode input", isEditable);
    const pid = backend!.status().hostPid;
    assert.ok(pid && pid > 0, "the backend must expose the owned worker PID for lifecycle diagnostics");
    await backend!.execute({ action: "key_down", key: "Shift", windowHandle: window.handle, taskId });
    assert.ok((await fixture!.state()).pressedKeys.includes("Shift"));
    process.kill(pid, "SIGKILL");
    await waitFor(async () => !(await fixture!.state()).pressedKeys.includes("Shift"), "owned input release after worker crash", 5_000);
    await assert.rejects(backend!.execute({ action: "set_control_value", windowHandle: window.handle, taskId,
      controlRuntimeId: old.runtimeId, observationId: tree.observationId, text: "must not replay" }));
    await semantic("Unicode input", "set_control_value", "worker recovered");
    assert.equal((await fixture!.state()).text, "worker recovered");
    return { crashedPid: pid, recoveredPid: backend!.status().hostPid, keysReleased: true, referenceRejected: true };
  });
  await check("application restart invalidates old window and control identities", async () => {
    const tree = await inspectTarget(); const oldControl = named(tree, "Unicode input", isEditable);
    const oldWindow = window;
    const oldPid = fixture!.identity.pid;
    await fixture!.close();
    await waitFor(async () => !((await backend!.execute({ action: "list_windows", taskId })).windows ?? [])
      .some((candidate) => candidate.handle === oldWindow.handle), "closed application disappears from compositor state");
    fixture = await launchElectronFixture();
    assert.notEqual(fixture.identity.pid, oldPid);
    window = await windowFor(fixture.identity.pid, title);
    await placeFixtureOnFractionalOutput();
    await assert.rejects(backend!.execute({ action: "set_control_value", windowHandle: oldWindow.handle, taskId,
      observationId: tree.observationId, controlRuntimeId: oldControl.runtimeId, text: "must not cross process lifetimes" }));
    assert.equal((await fixture!.state()).text, "");
    await semantic("Unicode input", "set_control_value", "fresh process identity");
    assert.equal((await fixture!.state()).text, "fresh process identity");
    return { oldPid, newPid: fixture.identity.pid, oldWindow: oldWindow.handle, newWindow: window.handle, oldReferenceRejected: true };
  });
  await check("the complete cold-start workflow made zero capture/OCR/legacy-backend calls", () => {
    assert.equal(captureCalls, 0); assert.deepEqual(forbiddenCalls(), []);
    report.coldWorkflowCaptureCalls = captureCalls;
    report.forbiddenCaptureCommandCalls = forbiddenCalls();
    return { captureCalls, forbiddenCommands: forbiddenCalls() };
  });
  await check("an optional capture_after failure preserves an already-executed input", async () => {
    await backend!.execute({ action: "focus_window", windowHandle: window.handle, taskId });
    const before = (await fixture!.state()).clicks;
    const result = await pointer("Pointer target", "click_client", { captureAfter: true });
    assert.equal((await fixture!.state()).clicks, before + 1);
    assert.equal(result.executed, true);
    assert.ok(result.captureError || result.captureFailed || result.screenshotError, "optional capture failure must be explicit in output");
    assert.equal(captureCalls, 1, "the failed optional capture must not replay the click or capture");
    return { clicksReceived: 1, captureCalls, captureError: result.captureError ?? result.captureFailed ?? result.screenshotError };
  });
  await check("the real desktop includes a fractional-scale output", () => {
    assert.equal(report.hasFractionalScale, true, "fractional-scale live acceptance has not run: configure an actual fractional-scale output and rerun; transform fixtures are not hardware evidence");
    assert.ok(report.fractionalFixture, "the input fixture must run on that actual fractional-scale output");
    return { monitors: report.monitors, fixture: report.fractionalFixture, syntheticLayoutCoverage: "separate linux-native behavior tests" };
  });
  report.status = "passed";
}

async function runAcceptance(): Promise<typeof report> {
  try { await main(); }
  catch (error) {
    report.status = "failed"; report.error = String(error instanceof Error ? error.stack : error);
    console.error(`[linux-computer-use] FAIL ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await backend?.releaseHeldInput(taskId).catch((error: unknown) => { report.releaseError = String(error); report.status = "failed"; });
    await backend?.shutdown().catch((error: unknown) => { report.shutdownError = String(error); report.status = "failed"; });
    await fixture?.close().catch((error: unknown) => { report.fixtureCloseError = String(error); report.status = "failed"; });
    if (gtk && gtk.exitCode === null && !gtk.signalCode) gtk.kill("SIGTERM");
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalCaptureAudit === undefined) delete process.env.MYBUDDY_LINUX_CU_CAPTURE_AUDIT;
    else process.env.MYBUDDY_LINUX_CU_CAPTURE_AUDIT = originalCaptureAudit;
    report.finishedAt = new Date().toISOString();
    report.totalCaptureCalls = captureCalls;
    report.forbiddenCaptureCommandCalls = forbiddenCalls();
    writeFileSync(join(reportDir, "acceptance-report.json"), JSON.stringify(report, null, 2) + "\n");
    rmSync(root, { recursive: true, force: true });
    console.log(`[linux-computer-use] ${report.status}: ${reportDir}/acceptance-report.json`);
  }
  return report;
}

/** Requiring this module from the normal packaged main process starts the same suite. */
export const acceptanceRun = runAcceptance();
if (require.main === module) {
  void acceptanceRun.then((result) => { if (result.status !== "passed") process.exitCode = 1; })
    .catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}
