import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WindowsComputerUseFixture as ComputerAutomationService } from "./windows-input-fixture";
import { WindowsComputerUseBackend } from "../src/main/platform/computer-use/windows/WindowsComputerUseBackend";
import { setHeldInputReleaser, waitForHeldInputRelease, onHeldInputReleased } from "../src/main/platform/computer-use/heldInput";
import { computerUseRunCoordinator } from "../src/main/capabilities/ComputerUseRunCoordinator";
import { WINDOWS_AUTOMATION_HOST_SCRIPT } from "../src/main/platform/computer-use/windows/windowsAutomationHostScript";
import { requestWithWindowsFocusRecovery, type WindowsFocusRecoveryBudget } from "../src/main/platform/computer-use/windows/WindowsFocusRecovery";
import { isKnownWindowsShellOverlay, WINDOWS_SHELL_OVERLAY_NATIVE_MATCH } from "../src/main/platform/computer-use/windows/windowsShellOverlayPolicy";
import { planComputerUseRecovery } from "../src/main/capabilities/ComputerUseRecoveryPolicy";
import {
  WINDOWS_AUTOMATION_ERROR_CODES,
  WindowsAutomationError,
  normalizeWindowInfo,
  validateClientPoint,
  type WindowInfo,
} from "../src/main/platform/computer-use/protocol";
import { COMPUTER_EXEC_READONLY_ACTIONS, isComputerExecReadonly, isDangerousTool, isSideEffectTool } from "../src/shared/pi-event-mapper";

const requiredActions = [
  "attach_app",
  "status", "active_window", "list_windows", "inspect_window", "focus_window", "wait_for_window",
  "screenshot", "screenshot_window", "ocr_window", "inspect_controls", "find_control", "invoke_control", "set_control_value",
  "move_client", "click_client", "drag_client", "scroll_client",
  "mouse_down_client", "mouse_up_client", "key_down", "key_up", "paste_text", "drag_screen",
  "mouse_move", "mouse_click", "mouse_drag", "scroll", "key_press", "type_text",
];
const readonlyActions = [
  "attach_app",
  "status", "active_window", "list_windows", "inspect_window", "wait_for_window",
  "screenshot", "ocr_window", "inspect_controls", "find_control",
];

function windowFixture(overrides: Partial<WindowInfo> = {}): WindowInfo {
  return {
    handle: "1234",
    processId: 55,
    processName: "fixture",
    title: "Fixture",
    className: "FixtureClass",
    visible: true,
    minimized: false,
    foreground: true,
    windowRect: { left: -1800, top: 50, right: -800, bottom: 750, width: 1000, height: 700 },
    clientRect: { x: 0, y: 0, width: 1200, height: 800 },
    clientOrigin: { x: -1788, y: 82 },
    dpi: 144,
    scaleFactor: 1.5,
    monitorHandle: "9",
    monitorRect: { left: -1920, top: 0, right: 0, bottom: 1080, width: 1920, height: 1080 },
    ...overrides,
  };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof WindowsAutomationError && error.code === code);
}

async function testFocusRecovery(): Promise<void> {
  const target = windowFixture({ foreground: false });
  const overlay = {
    handle: "880", processId: 88, processName: "ShellExperienceHost", className: "Windows.UI.Core.CoreWindow",
    processPath: "C:\\Windows\\SystemApps\\ShellExperienceHost_cw5n1h2txyewy\\ShellExperienceHost.exe",
    windowsDirectory: "C:\\Windows", visible: true, foreground: true,
  };
  assert.equal(isKnownWindowsShellOverlay(overlay), true);
  for (const invalid of [
    { ...overlay, processName: "ordinary-app" },
    { ...overlay, className: "Chrome_WidgetWin_1" },
    { ...overlay, processPath: "C:\\Users\\user\\ShellExperienceHost.exe" },
    { ...overlay, processPath: "" }, { ...overlay, foreground: false }, { ...overlay, processId: 0 },
  ]) assert.equal(isKnownWindowsShellOverlay(invalid), false, "class/name alone must not authorize Escape");
  assert.ok(WINDOWS_AUTOMATION_HOST_SCRIPT.includes(WINDOWS_SHELL_OVERLAY_NATIVE_MATCH), "native input guard must consume the same narrow allowlist");

  function fixture(options: {
    foreground?: unknown; proofTarget?: WindowInfo; current?: WindowInfo; beforeInput?: boolean;
    noProof?: boolean; dismissed?: boolean; failRetry?: boolean; onDismiss?: () => void;
    beforeInputState?: unknown; afterInputState?: unknown; inspectFails?: boolean;
  } = {}) {
    const calls: string[] = [];
    const signals: Array<AbortSignal | undefined> = [];
    let attempts = 0, effects = 0;
    const inputState = { owner: "__direct__", hostInstance: "focus-native-host", controls: [] };
    const fail = () => new WindowsAutomationError("FOCUS_FAILED", "controlled native focus failure", options.noProof ? {} : {
      focusAttempt: { beforeInput: options.beforeInput ?? true, targetWindow: options.proofTarget ?? target, foregroundWindow: options.foreground ?? overlay },
      ownedInputState: "beforeInputState" in options ? options.beforeInputState : inputState,
    });
    const params = { target: { windowHandle: target.handle, expectedProcessId: target.processId }, x: 10, y: 20 };
    const request = (async (action: string, supplied: unknown, _timeout?: number, signal?: AbortSignal) => {
      calls.push(action); signals.push(signal);
      if (action === "dismiss_shell_overlay") {
        assert.deepEqual((supplied as { overlay: unknown }).overlay, options.foreground ?? overlay);
        assert.equal((supplied as { inputOwner: string }).inputOwner, inputState.owner);
        assert.equal((supplied as { expectedInputHost: string }).expectedInputHost, inputState.hostInstance);
        options.onDismiss?.();
        return { dismissed: options.dismissed ?? true, ownedInputState: "afterInputState" in options ? options.afterInputState : inputState };
      }
      if (action === "inspect_window") {
        if (options.inspectFails) throw new WindowsAutomationError("WINDOW_NOT_FOUND", "target disappeared after Escape", { ownedInputState: { ...inputState, hostInstance: "unrelated-inspection-host" } });
        return options.current ?? target;
      }
      const replay = supplied as { target: { expectedFocusWindow?: WindowInfo } };
      assert.deepEqual(supplied, { ...params, ...(attempts > 0 ? { inputOwner: inputState.owner, expectedInputHost: inputState.hostInstance } : {}),
        target: { ...params.target, ...(attempts > 0 && action !== "focus_window" ? { expectedFocusWindow: target } : {}) } },
        "retry must keep the original params/coordinates and pin native focus to the original snapshot");
      if (attempts > 0 && action !== "focus_window") assert.strictEqual(replay.target.expectedFocusWindow, target);
      if (++attempts === 1 || options.failRetry) throw fail();
      return { effect: ++effects };
    }) as Parameters<typeof requestWithWindowsFocusRecovery>[0];
    const run = (budget: WindowsFocusRecoveryBudget = { attempted: false }, signal?: AbortSignal, action: "click_client" | "focus_window" = "click_client") =>
      requestWithWindowsFocusRecovery(request, action, params, target, budget, signal);
    return { calls, signals, run, get effects() { return effects; } };
  }

  const success = fixture(), signal = new AbortController().signal, budget = { attempted: false };
  await success.run(budget, signal);
  assert.deepEqual(success.calls, ["click_client", "dismiss_shell_overlay", "inspect_window", "click_client"]);
  assert.equal(success.effects, 1, "only the unstarted target input is retried, exactly once");
  assert.ok(success.signals.every((item) => item === signal), "all recovery RPCs must keep cancellation");
  assert.equal(budget.attempted, true);

  for (const options of [
    { foreground: { ...overlay, processName: "ordinary-app" } },
    { noProof: true }, { beforeInput: false },
    { beforeInputState: undefined },
    { beforeInputState: { owner: "foreign", hostInstance: "focus-native-host", controls: [] } },
    { beforeInputState: { owner: "__direct__", hostInstance: "focus-native-host", controls: ["key:16:0:0"] } },
    { proofTarget: windowFixture({ processId: 999 }) },
    { proofTarget: windowFixture({ handle: "999" }) },
  ]) {
    const denied = fixture(options);
    await expectCode(denied.run(), "FOCUS_FAILED");
    assert.deepEqual(denied.calls, ["click_client"], "unproven/preexisting effects or wrong identities must not trigger Escape/replay");
    assert.equal(denied.effects, 0);
  }
  for (const afterInputState of [undefined,
    { owner: "foreign", hostInstance: "focus-native-host", controls: [] },
    { owner: "__direct__", hostInstance: "replacement-host", controls: [] },
    { owner: "__direct__", hostInstance: "focus-native-host", controls: ["key:27:0:0"] },
  ]) {
    const noReleaseProof = fixture({ afterInputState });
    await expectCode(noReleaseProof.run(), "HOST_PROTOCOL_ERROR");
    assert.deepEqual(noReleaseProof.calls, ["click_client", "dismiss_shell_overlay"], "unproven Escape UP must stop before target inspection/replay");
  }
  const inspectionFailed = fixture({ inspectFails: true });
  await assert.rejects(inspectionFailed.run(), (error: unknown) => {
    assert(error instanceof WindowsAutomationError && error.code === "WINDOW_NOT_FOUND");
    const details = error.details as { shellOverlayRecoveryAttempted?: boolean; ownedInputState?: { hostInstance: string } };
    assert.equal(details.shellOverlayRecoveryAttempted, true);
    assert.equal(details.ownedInputState?.hostInstance, "focus-native-host", "inspection errors retain the confirmed Escape UP receipt, never unrelated/older proof");
    return true;
  });
  const changedBefore = fixture({ proofTarget: windowFixture({ dpi: 192 }) });
  await expectCode(changedBefore.run(), "STALE_OBSERVATION");
  assert.deepEqual(changedBefore.calls, ["click_client"]);
  for (const current of [windowFixture({ dpi: 192 }), windowFixture({ processId: 999 }), windowFixture({ className: "ReusedClass" })]) {
    const changedAfter = fixture({ current });
    await expectCode(changedAfter.run(), "STALE_OBSERVATION");
    assert.deepEqual(changedAfter.calls, ["click_client", "dismiss_shell_overlay", "inspect_window"]);
    assert.equal(changedAfter.effects, 0, "recovery cannot refresh a moved/reused target into valid coordinates");
  }
  const abort = new AbortController();
  const cancelled = fixture({ onDismiss: () => abort.abort() });
  await expectCode(cancelled.run(undefined, abort.signal), "REQUEST_CANCELLED");
  assert.deepEqual(cancelled.calls, ["click_client", "dismiss_shell_overlay"]);
  const preCancelled = fixture();
  await expectCode(preCancelled.run(undefined, abort.signal), "REQUEST_CANCELLED");
  assert.equal(preCancelled.calls.length, 0);

  for (const refused of [fixture({ dismissed: false }), fixture({ failRetry: true })]) {
    let failure: unknown;
    try { await refused.run(); } catch (error) { failure = error; }
    assert(failure instanceof WindowsAutomationError);
    assert.equal(planComputerUseRecovery(failure, { action: "click_client", windowHandle: target.handle }, 0)?.retry, false,
      "the outer task retry must not reset the one-Escape budget");
    assert.equal(refused.calls.filter((action) => action === "dismiss_shell_overlay").length, 1);
  }
  const nextBatchStep = fixture();
  await expectCode(nextBatchStep.run(budget), "FOCUS_FAILED");
  assert.deepEqual(nextBatchStep.calls, ["click_client"], "a later batch step shares the same Escape budget");
  const restoreOnly = fixture({ current: windowFixture({ clientRect: { x: 0, y: 0, width: 800, height: 600 } }) });
  await restoreOnly.run(undefined, undefined, "focus_window");
  assert.equal(restoreOnly.calls.filter((action) => action === "focus_window").length, 2,
    "focus-only recovery can restore the target's size without replaying coordinates");

  // Exercise the production backend wiring, including a fresh budget for a later execute.
  let current = target, focuses = 0, dismissals = 0;
  const service = new ComputerAutomationService({
    pid: 888,
    request: async (action: string) => {
      if (action === "inspect_window") return current;
      if (action === "list_windows") return [current];
      if (action === "dismiss_shell_overlay") { dismissals++; return { dismissed: true }; }
      if (action === "focus_window") {
        if (++focuses % 2 === 1) throw new WindowsAutomationError("FOCUS_FAILED", "native overlay", {
          focusAttempt: { beforeInput: true, targetWindow: current, foregroundWindow: overlay },
        });
        current = { ...current, foreground: true }; return { window: current };
      }
      throw new Error(`Unexpected focus fixture action: ${action}`);
    },
  } as never);
  for (let index = 0; index < 2; index++) {
    current = { ...current, foreground: false };
    const output = await service.execute({ action: "focus_window", windowHandle: target.handle });
    assert.equal(output.window?.foreground, true);
  }
  assert.equal(dismissals, 2, "independent execute calls each receive one bounded recovery attempt");
  assert.equal(focuses, 4);

  const batchCalls: number[] = [], batchEffects: number[] = [];
  let batchDismissals = 0;
  const batchService = new ComputerAutomationService({
    request: async (action: string, params: { x?: number }) => {
      if (action === "inspect_window") return target;
      if (action === "list_windows") return [target];
      if (action === "dismiss_shell_overlay") { batchDismissals++; return { dismissed: true }; }
      if (action === "click_client") {
        batchCalls.push(params.x!);
        if (params.x === 3 || (params.x === 2 && batchCalls.filter((value) => value === 2).length === 1)) {
          throw new WindowsAutomationError("FOCUS_FAILED", "overlay between batch steps", {
            focusAttempt: { beforeInput: true, targetWindow: target, foregroundWindow: overlay },
          });
        }
        batchEffects.push(params.x!); return {};
      }
      throw new Error(`Unexpected batch focus fixture action: ${action}`);
    },
  } as never);
  await assert.rejects(batchService.execute({ windowHandle: target.handle, settleMs: 0,
    actions: [1, 2, 3].map((x) => ({ action: "click_client" as const, x, y: 1 })),
  }), (error: unknown) => {
    assert(error instanceof WindowsAutomationError);
    assert.equal((error.details as { batch: { completedSteps: number } }).batch.completedSteps, 2);
    return error.code === "FOCUS_FAILED";
  });
  assert.deepEqual(batchEffects, [1, 2], "completed batch steps must never be replayed during focus recovery");
  assert.deepEqual(batchCalls, [1, 2, 2, 3]);
  assert.equal(batchDismissals, 1, "a second obstructed batch step cannot send a second Escape");
}

async function testWindowsOwnedInput(): Promise<void> {
  const taskId = "windows-owned-input-proof", window = windowFixture();
  const own = new Set<string>(), physical = new Set<string>(["user:Control", "other-driver:right"]);
  const events: string[] = [];
  let started!: () => void, finish!: () => void, receipts = 0, releases = 0;
  const releaseStarted = new Promise<void>(resolve => { started = resolve; });
  const releaseGate = new Promise<void>(resolve => { finish = resolve; });
  const backend = new WindowsComputerUseBackend({
    waitForQuiescence: async () => {},
    request: async (action: string, params: { inputOwner: string; expectedInputHost?: string; controls?: string[] }) => {
      if (action === "inspect_window") return window;
      if (action === "list_windows") return [window];
      if (action === "key_down") { own.add("key:16:0:0"); physical.add("driver:Shift"); events.push("down"); }
      else if (action === "mouse_down_client") { own.add("mouse:left"); physical.add("driver:left"); events.push("mouse-down"); }
      else if (action === "release_owned_input") {
        releases++; events.push("release-start");
        assert.equal(params.expectedInputHost, "original-host");
        assert.deepEqual(new Set(params.controls), own, "cleanup may request only the original driver's recorded controls");
        started(); await releaseGate;
        own.clear(); physical.delete("driver:Shift"); physical.delete("driver:left"); events.push("up");
        return { inputReleased: true, ownedInputState: { owner: params.inputOwner, hostInstance: "original-host", controls: [] } };
      } else throw new Error(`Unexpected owned input fixture action: ${action}`);
      return { ownedInputState: { owner: params.inputOwner, hostInstance: "original-host", controls: [...own] } };
    },
  } as never);
  setHeldInputReleaser((owner, recovery) => backend.releaseHeldInput(owner, recovery));
  const unsubscribe = onHeldInputReleased((owner) => {
    if (owner !== taskId) return;
    assert(events.includes("up"), "no resource-release receipt may be broadcast before actual owned UP finishes");
    events.push("receipt"); receipts++;
  });
  try {
    await backend.execute({ action: "key_down", taskId, key: "Shift", windowHandle: window.handle, observeAfter: false });
    await backend.execute({ action: "mouse_down_client", taskId, x: 10, y: 10, windowHandle: window.handle, observeAfter: false });
    computerUseRunCoordinator.endTask(taskId);
    await releaseStarted;
    assert.equal(receipts, 0);
    assert(physical.has("driver:Shift"));
    const cleanup = waitForHeldInputRelease(taskId);
    finish(); await cleanup;
    assert.equal(receipts, 1);
    assert.deepEqual(events, ["down", "mouse-down", "release-start", "up", "receipt"]);
    assert.deepEqual(physical, new Set(["user:Control", "other-driver:right"]), "cleanup never releases user or other-driver controls");
    await backend.releaseHeldInput(taskId);
    assert.equal(releases, 1, "a repeated cleanup cannot emit a second UP for the same held generation");
  } finally { finish(); unsubscribe(); setHeldInputReleaser(undefined); computerUseRunCoordinator.endTask(taskId); }

  for (const mode of ["missing", "wrong-owner", "transport-unknown", "changed-host", "incomplete"] as const) {
    let upCalls = 0;
    const uncertain = new WindowsComputerUseBackend({
      waitForQuiescence: async () => {},
      request: async (action: string, params: { inputOwner: string }) => {
        if (action === "inspect_window") return window;
        if (action === "list_windows") return [window];
        if (action === "key_down") {
          if (mode === "transport-unknown") throw new WindowsAutomationError("REQUEST_TIMEOUT", "unknown DOWN delivery");
          if (mode === "missing") return {};
          return { ownedInputState: { owner: mode === "wrong-owner" ? "foreign" : params.inputOwner, hostInstance: "original-host", controls: ["key:16:0:0"] } };
        }
        if (action === "release_owned_input") {
          upCalls++;
          return { inputReleased: true, ownedInputState: { owner: params.inputOwner, hostInstance: mode === "changed-host" ? "replacement-empty-host" : "original-host",
            controls: mode === "incomplete" ? ["key:16:0:0"] : [] } };
        }
        throw new Error(action);
      },
    } as never);
    const down = uncertain.execute({ action: "key_down", key: "Shift", windowHandle: window.handle, observeAfter: false });
    if (mode === "changed-host" || mode === "incomplete") await down;
    else await expectCode(down, mode === "transport-unknown" ? "REQUEST_TIMEOUT" : "HOST_PROTOCOL_ERROR");
    await expectCode(uncertain.releaseHeldInput(), "HOST_UNAVAILABLE");
    assert.equal(upCalls, mode === "changed-host" || mode === "incomplete" ? 1 : 0, "unknown DOWN cannot authorize a blind cleanup");
    await expectCode(uncertain.releaseHeldInput(), "HOST_UNAVAILABLE");
  }
}

async function main(): Promise<void> {
  await testFocusRecovery();
  await testWindowsOwnedInput();
  const extensionSource = readFileSync(resolve("src/main/capabilities/builtin-capability-extension.ts"), "utf8");
  const serviceSource = readFileSync(resolve("src/main/platform/computer-use/windows/WindowsComputerUseBackend.ts"), "utf8");
  for (const action of requiredActions) {
    assert.match(extensionSource, new RegExp(`Type\\.Literal\\(\\"${action}\\"\\)`), `schema missing ${action}`);
  }
  assert.match(extensionSource, /additionalProperties:\s*false/);
  assert.doesNotMatch(serviceSource, /exec\(|execSync|spawnSync|EncodedCommand|Add-Type|shell:\s*true/);

  for (const action of requiredActions) {
    if (action === "screenshot_window") {
      assert.equal(isComputerExecReadonly({ action }), false, "foreground window capture is a side effect");
      assert.equal(isSideEffectTool("computer_exec", { action }), true);
      assert.equal(isDangerousTool("computer_exec", { action }), true);
      assert.equal(isComputerExecReadonly({ action, ensure_foreground: false }), true, "already-foreground capture can be readonly");
      assert.equal(isComputerExecReadonly({ action, background: true }), true, "PrintWindow background capture is readonly");
      assert.equal(isSideEffectTool("computer_exec", { action, ensure_foreground: false }), false);
      continue;
    }
    const readonly = readonlyActions.includes(action);
    assert.equal(COMPUTER_EXEC_READONLY_ACTIONS.has(action), readonly, `readonly mismatch: ${action}`);
    assert.equal(isSideEffectTool("computer_exec", { action }), !readonly, `side-effect mismatch: ${action}`);
    assert.equal(isDangerousTool("computer_exec", { action }), !readonly, `dangerous mismatch: ${action}`);
  }

  const normalized = normalizeWindowInfo(windowFixture());
  assert.equal(normalized.windowRect.left, -1800, "negative display coordinates must be preserved");
  assert.equal(normalized.scaleFactor, 1.5);
  assert.deepEqual(validateClientPoint(normalized, 100, 100), { xPhysical: 150, yPhysical: 150 });
  assert.throws(() => validateClientPoint(normalized, 801, 100), (error: unknown) => error instanceof WindowsAutomationError && error.code === "POINT_OUTSIDE_CLIENT");
  const at125 = windowFixture({ dpi: 120, scaleFactor: 1.25, clientRect: { x: 0, y: 0, width: 1000, height: 750 } });
  assert.deepEqual(validateClientPoint(at125, 400, 200), { xPhysical: 500, yPhysical: 250 });

  for (const code of ["WINDOW_AMBIGUOUS", "CONTROL_AMBIGUOUS", "STALE_OBSERVATION", "FOCUS_FAILED", "CAPTURE_FAILED", "REQUEST_CANCELLED"]) {
    assert.ok(WINDOWS_AUTOMATION_ERROR_CODES.includes(code as never), `missing stable error code ${code}`);
  }
  assert.equal((WINDOWS_AUTOMATION_HOST_SCRIPT.match(/\[Console\]::Out\.WriteLine/g) ?? []).length, 1, "stdout must have one protocol writer");
  assert.doesNotMatch(WINDOWS_AUTOMATION_HOST_SCRIPT, /Write-Output/);
  assert.doesNotMatch(WINDOWS_AUTOMATION_HOST_SCRIPT, /mouse_event|keybd_event/, "input down/up must use atomic SendInput batches");
  assert.match(WINDOWS_AUTOMATION_HOST_SCRIPT, /search was truncated; uniqueness cannot be established/);
  assert.match(WINDOWS_AUTOMATION_HOST_SCRIPT, /GetFirstChild\(\$element\).*\$truncated = \$true/, "max-depth search must be marked truncated when children remain");
  assert.match(WINDOWS_AUTOMATION_HOST_SCRIPT, /\(\$visited \+ \$queue\.Count\) -ge \$maxNodes/, "UIA sibling enumeration must respect maxNodes before enqueue");
  assert.match(WINDOWS_AUTOMATION_HOST_SCRIPT, /CompensatePartial\(array, inserted\)/, "partial SendInput must compensate inserted down events");
  assert.match(WINDOWS_AUTOMATION_HOST_SCRIPT, /SwitchToThisWindow\(hWnd, false\)/, "focus fallback must use an explicit window switch");
  assert.doesNotMatch(WINDOWS_AUTOMATION_HOST_SCRIPT, /new byte\[\] \{ 0x12 \}/, "focus fallback must not synthesize Alt");
  assert.match(WINDOWS_AUTOMATION_HOST_SCRIPT, /foreach \(\$character in \$value\.ToCharArray\(\)\)[\s\S]*Confirm-InputTarget \$focused\.window[\s\S]*SendUnicode\(\[string\]\$character\)[\s\S]*Confirm-InputTarget \$focused\.window/, "targeted text must revalidate the foreground target around every character");
  assert.match(WINDOWS_AUTOMATION_HOST_SCRIPT, /'key_press'[\s\S]*Focus-Target \$params\.target[\s\S]*Confirm-InputTarget \$focused\.window[\s\S]*SendKeyChord/, "targeted key press must revalidate the target immediately before SendInput");
  assert.match(WINDOWS_AUTOMATION_HOST_SCRIPT, /screenBoundsPhysical = \$screenBounds[\s\S]*clientBoundsDip = \$clientBounds[\s\S]*bounds = if \(\$null -eq \$clientBounds\)/, "UIA control bounds must expose physical diagnostics and client-DIP action coordinates");
  assert.match(WINDOWS_AUTOMATION_HOST_SCRIPT, /invoke_control[\s\S]*Current\.IsEnabled[\s\S]*Current\.IsOffscreen[\s\S]*TryGetCurrentPattern/, "semantic invoke must reject disabled/offscreen controls before action");
  assert.match(WINDOWS_AUTOMATION_HOST_SCRIPT, /set_control_value[\s\S]*Current\.IsEnabled[\s\S]*Current\.IsOffscreen[\s\S]*ValuePattern/, "semantic value update must reject disabled/offscreen controls before action");
  assert.match(WINDOWS_AUTOMATION_HOST_SCRIPT, /completed = \$false; typedLength = \$typedLength; requestedLength = \$value\.Length/, "partial targeted text must report its completed prefix");
  assert.match(WINDOWS_AUTOMATION_HOST_SCRIPT, /\(\$visited \+ \$queue\.Count\) -ge 2000/, "runtime-id lookup must bound sibling enqueue");
  const captureSource = readFileSync(resolve("src/main/platform/computer-use/windows/WindowCaptureService.ts"), "utf8");
  assert.match(captureSource, /target\.width\s*\/\s*window\.scaleFactor/);
  assert.match(captureSource, /clientOnly \? "client-dip-aligned-pixels" : "window-dip-aligned-pixels"/);

  let current = windowFixture();
  let sideEffectCalled = false;
  let clickCount = 0;
  let lastSideEffectTarget: Record<string, unknown> | undefined;
  let lastClickParams: Record<string, unknown> | undefined;
  function resetClickParams(): void { lastClickParams = undefined; }
  let lastDragParams: Record<string, unknown> | undefined;
  let lastScrollParams: Record<string, unknown> | undefined;
  let lastKeyAction: string | undefined;
  let closeOnNextClick = false;
  let windowClosed = false;
  let loseObservationAfterNextClick = false;
  let observationUnavailable = false;
  const fakeHost = {
    pid: 777,
    request: async (action: string, params: Record<string, unknown>) => {
      if (action === "inspect_window") {
        const target = params.target as { windowTitle?: string } | undefined;
        if (target?.windowTitle === "ambiguous") throw new WindowsAutomationError("WINDOW_AMBIGUOUS", "duplicate", { candidates: [current, current] });
        return current;
      }
      if (action === "list_windows") {
        if (observationUnavailable) throw new Error("simulated post-action host failure");
        return windowClosed ? [] : [current];
      }
      if (action === "focus_window") return { window: current };
      if (action === "click_client") {
        sideEffectCalled = true;
        clickCount += 1;
        lastSideEffectTarget = params.target as Record<string, unknown>;
        lastClickParams = params;
        if (closeOnNextClick) windowClosed = true;
        if (loseObservationAfterNextClick) observationUnavailable = true;
        return {};
      }
      if (action === "drag_client" || action === "drag_screen") {
        lastDragParams = params;
        return {};
      }
      if (action === "scroll_client") {
        lastScrollParams = params;
        return {};
      }
      if (action === "key_press" || action === "key_down" || action === "key_up") {
        lastKeyAction = action;
        return {};
      }
      throw new Error(`Unexpected fake action ${action}`);
    },
    shutdown: async () => undefined,
  };
  let capturedClientOnly: boolean | undefined;
  const fakeCapture = { capture: async (_window: WindowInfo, clientOnly?: boolean) => {
    capturedClientOnly = clientOnly;
    return { screenshot: new Uint8Array([1]), details: {} };
  } };
  const service = new ComputerAutomationService(fakeHost as never, fakeCapture as never);
  await expectCode(service.execute({ action: "inspect_window", windowTitle: "ambiguous" }), "WINDOW_AMBIGUOUS");
  const inspected = await service.execute({ action: "inspect_window", windowHandle: current.handle });
  assert.ok(inspected.observationId);
  current = windowFixture({ clientRect: { ...current.clientRect, width: current.clientRect.width + 10 } });
  await expectCode(service.execute({
    action: "click_client",
    windowHandle: current.handle,
    observationId: inspected.observationId,
    x: 10,
    y: 10,
  }), "STALE_OBSERVATION");
  assert.equal(sideEffectCalled, false, "stale observations must fail before input");

  current = windowFixture();
  const titleMutable = await service.execute({ action: "inspect_window", windowHandle: current.handle });
  current = windowFixture({ title: "Fixture - changed title" });
  sideEffectCalled = false;
  await service.execute({ action: "click_client", observationId: titleMutable.observationId, x: 10, y: 10, observeAfter: false });
  assert.equal(sideEffectCalled, true, "normal title changes must not invalidate an HWND/PID observation");

  current = windowFixture();
  const consistent = await service.execute({ action: "inspect_window", windowHandle: current.handle });
  await expectCode(service.execute({
    action: "click_client",
    windowTitle: "Different target",
    observationId: consistent.observationId,
    x: 10,
    y: 10,
  }), "STALE_OBSERVATION");
  sideEffectCalled = false;
  await assert.rejects(service.execute({ action: "mouse_click", x: 10, observeAfter: false }), /x\/y 必须同时提供/);
  await service.execute({ action: "click_client", windowTitle: current.title, x: 10, y: 10, observeAfter: false });
  assert.equal(sideEffectCalled, true);
  assert.deepEqual(lastSideEffectTarget, { windowHandle: current.handle, expectedProcessId: current.processId }, "side effects must pin selectors to HWND + PID before input");
  await service.execute({ action: "screenshot_window", windowHandle: current.handle, ensureForeground: false });
  assert.equal(capturedClientOnly, true, "window screenshots must default to client-aligned pixels");
  await service.execute({ action: "screenshot_window", windowHandle: current.handle, ensureForeground: false, clientOnly: false });
  assert.equal(capturedClientOnly, false, "explicit full-window capture must remain available");
  const focusedWithoutOptionalObservation = await service.execute({ action: "focus_window", windowHandle: current.handle, observeAfter: false });
  assert.equal(focusedWithoutOptionalObservation.observation?.focusPreserved, true, "focus must always receive delayed foreground verification");
  const capturedAfterAction = await service.execute({ action: "click_client", windowHandle: current.handle, x: 10, y: 10, captureAfter: true, observeAfter: false });
  assert.equal(capturedClientOnly, true, "post-action capture must use client-aligned pixels");
  assert.ok(capturedAfterAction.screenshot, "post-action capture must be returned after identity verification");
  assert.equal(capturedAfterAction.captureStatus, "captured");
  closeOnNextClick = true;
  const closedDuringCapture = await service.execute({ action: "click_client", windowHandle: current.handle, x: 10, y: 10, captureAfter: true });
  assert.equal(closedDuringCapture.captureStatus, "failed", "capture failure must not turn a completed side effect into a failed action");
  assert.equal((closedDuringCapture.captureError as { code?: string }).code, "CAPTURE_FAILED");
  assert.equal(closedDuringCapture.observation?.closedWindows?.length, 1, "post-action observation must survive capture failure");
  closeOnNextClick = false;
  windowClosed = false;
  loseObservationAfterNextClick = true;
  const lostPostObservation = await service.execute({ action: "click_client", windowHandle: current.handle, x: 10, y: 10 });
  assert.equal(lostPostObservation.observationStatus, "failed", "post-action observation failure must preserve a completed side effect result");
  assert.equal((lostPostObservation.observationError as { code?: string }).code, "POST_ACTION_OBSERVATION_FAILED");
  loseObservationAfterNextClick = false;
  observationUnavailable = false;

  // list_windows filtering + compact output (the full geometry dominated context)
  const filteredWindows = await service.execute({ action: "list_windows", windowTitle: "fix" });
  assert.equal(filteredWindows.windows?.length, 1, "list_windows must honor the title filter");
  assert.equal((filteredWindows.windows?.[0] as { windowRect?: unknown }).windowRect, undefined, "list_windows must stay compact");
  assert.ok((filteredWindows.windows?.[0] as { clientRect?: unknown }).clientRect, "compact windows must keep client geometry");
  const noWindow = await service.execute({ action: "list_windows", windowTitle: "nope" });
  assert.equal(noWindow.windows?.length, 0, "a non-matching filter must return an empty list");

  // batch: sequential steps, one final observation, stop at the first error
  clickCount = 0;
  const batch = await service.execute({
    actions: [
      { action: "click_client", x: 10, y: 10 },
      { action: "click_client", x: 20, y: 20 },
    ],
    windowHandle: current.handle,
    settleMs: 0,
  });
  assert.equal(batch.action, "batch");
  assert.equal(clickCount, 2, "batch must execute every step");
  assert.equal(batch.batch?.steps.length, 2);
  assert.ok(batch.batch?.steps.every((step) => step.ok), "successful batch steps must be reported");
  assert.ok(batch.observation?.targetAfter, "batch must return one final observation");

  let batchError: unknown;
  try {
    await service.execute({
      actions: [
        { action: "click_client", x: 10, y: 10 },
        { action: "drag_client", x: 10, y: 10 },
      ],
      windowHandle: current.handle,
      settleMs: 0,
    });
  } catch (error) { batchError = error; }
  const batchFailure = batchError as { message?: string; details?: { batch?: { completedSteps?: number } } };
  assert.match(String(batchFailure.message), /批量第 2 步失败/);
  assert.equal(batchFailure.details?.batch?.completedSteps, 1, "batch failure must report how many steps already ran");
  await assert.rejects(service.execute({ actions: [{ action: "click_client", x: 1, y: 1 }] }), /window_handle/);

  // app session: attach once, then target by session id
  const attached = await service.execute({ action: "attach_app", windowTitle: current.title });
  assert.ok(attached.appSessionId, "attach_app must return an app session id");
  assert.equal(attached.window?.handle, current.handle);
  resetClickParams();
  await service.execute({ action: "click_client", appSessionId: attached.appSessionId, x: 10, y: 10, observeAfter: false });
  assert.equal((lastClickParams?.target as { windowHandle?: string })?.windowHandle, current.handle, "app session must resolve to the attached HWND");
  await expectCode(service.execute({ action: "click_client", appSessionId: "missing-session", x: 1, y: 1 }), "STALE_OBSERVATION");

  // input primitives: click count + modifiers, timed drag, notches, key down/up
  await service.execute({ action: "click_client", windowHandle: current.handle, x: 10, y: 10, clickCount: 2, modifiers: ["ctrl", "shift"], observeAfter: false });
  assert.equal(lastClickParams?.clickCount, 2, "double click must reach the host");
  assert.deepEqual(lastClickParams?.modifiers, [17, 16], "modifiers must be translated to virtual keys");
  await service.execute({ action: "drag_client", windowHandle: current.handle, x: 0, y: 0, x2: 20, y2: 20, steps: 30, durationMs: 500, observeAfter: false });
  assert.equal(lastDragParams?.steps, 30, "drag steps must reach the host");
  assert.equal(lastDragParams?.durationMs, 500, "drag duration must reach the host");
  await service.execute({ action: "drag_screen", x: 10, y: 10, x2: 300, y2: 300, steps: 8, observeAfter: false });
  assert.equal(lastDragParams?.steps, 8, "cross-window drag must use desktop coordinates");
  await service.execute({ action: "scroll_client", windowHandle: current.handle, notches: -3, observeAfter: false });
  assert.equal(lastScrollParams?.notches, -3, "scroll notches must reach the host");
  await service.execute({ action: "key_down", windowHandle: current.handle, key: "Shift", observeAfter: false });
  assert.equal(lastKeyAction, "key_down");
  await service.execute({ action: "key_up", windowHandle: current.handle, key: "Shift", observeAfter: false });
  assert.equal(lastKeyAction, "key_up");

  console.log(`computer automation contract PASS (${requiredActions.length} actions, ${readonlyActions.length} always-readonly + conditional capture + batch + app session + input primitives + window filtering + bounded verified shell-overlay focus recovery)`);
}

void main();
