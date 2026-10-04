import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ComputerAutomationService } from "../src/main/capabilities/ComputerAutomationService";
import { WINDOWS_AUTOMATION_HOST_SCRIPT } from "../src/main/capabilities/windows/windowsAutomationHostScript";
import {
  WINDOWS_AUTOMATION_ERROR_CODES,
  WindowsAutomationError,
  normalizeWindowInfo,
  validateClientPoint,
  type WindowInfo,
} from "../src/main/capabilities/windows/windowsAutomationProtocol";
import { COMPUTER_EXEC_READONLY_ACTIONS, isComputerExecReadonly, isDangerousTool, isSideEffectTool } from "../src/shared/pi-event-mapper";

const requiredActions = [
  "status", "active_window", "list_windows", "inspect_window", "focus_window", "wait_for_window",
  "screenshot", "screenshot_window", "inspect_controls", "find_control", "invoke_control", "set_control_value",
  "move_client", "click_client", "drag_client", "scroll_client",
  "mouse_move", "mouse_click", "mouse_drag", "scroll", "key_press", "type_text",
];
const readonlyActions = [
  "status", "active_window", "list_windows", "inspect_window", "wait_for_window",
  "screenshot", "inspect_controls", "find_control",
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

async function main(): Promise<void> {
  const extensionSource = readFileSync(resolve("src/main/capabilities/builtin-capability-extension.ts"), "utf8");
  const serviceSource = readFileSync(resolve("src/main/capabilities/ComputerAutomationService.ts"), "utf8");
  for (const action of requiredActions) {
    assert.match(extensionSource, new RegExp(`Type\\.Literal\\(\\"${action}\\"\\)`), `schema missing ${action}`);
  }
  assert.match(extensionSource, /additionalProperties:\s*false/);
  assert.doesNotMatch(serviceSource, /execFile|EncodedCommand|Add-Type/);

  for (const action of requiredActions) {
    if (action === "screenshot_window") {
      assert.equal(isComputerExecReadonly({ action }), false, "foreground window capture is a side effect");
      assert.equal(isSideEffectTool("computer_exec", { action }), true);
      assert.equal(isDangerousTool("computer_exec", { action }), true);
      assert.equal(isComputerExecReadonly({ action, ensure_foreground: false }), true, "already-foreground capture can be readonly");
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
  const captureSource = readFileSync(resolve("src/main/capabilities/windows/WindowCaptureService.ts"), "utf8");
  assert.match(captureSource, /target\.width\s*\/\s*window\.scaleFactor/);
  assert.match(captureSource, /clientOnly \? "client-dip-aligned-pixels" : "window-dip-aligned-pixels"/);

  let current = windowFixture();
  let sideEffectCalled = false;
  let lastSideEffectTarget: Record<string, unknown> | undefined;
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
        lastSideEffectTarget = params.target as Record<string, unknown>;
        if (closeOnNextClick) windowClosed = true;
        if (loseObservationAfterNextClick) observationUnavailable = true;
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
  assert.equal(closedDuringCapture.observation?.closedWindows.length, 1, "post-action observation must survive capture failure");
  closeOnNextClick = false;
  windowClosed = false;
  loseObservationAfterNextClick = true;
  const lostPostObservation = await service.execute({ action: "click_client", windowHandle: current.handle, x: 10, y: 10 });
  assert.equal(lostPostObservation.observationStatus, "failed", "post-action observation failure must preserve a completed side effect result");
  assert.equal((lostPostObservation.observationError as { code?: string }).code, "POST_ACTION_OBSERVATION_FAILED");
  loseObservationAfterNextClick = false;
  observationUnavailable = false;

  console.log(`computer automation contract PASS (${requiredActions.length} actions, ${readonlyActions.length} always-readonly + conditional capture)`);
}

void main();
