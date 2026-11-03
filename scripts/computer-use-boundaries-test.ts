import assert from "node:assert/strict";
import { WindowsComputerUseBackend } from "../src/main/platform/computer-use/windows/WindowsComputerUseBackend";
import { WindowsAutomationError, type WindowInfo, type ComputerExecInput } from "../src/main/platform/computer-use/protocol";
import { verificationFor } from "../src/main/capabilities/ComputerUsePolicy";
import { computerUseRunCoordinator as coordinator } from "../src/main/capabilities/ComputerUseRunCoordinator";

const window: WindowInfo = { handle: "10", processId: 20, processName: "fixture", title: "Fixture", className: "Fixture",
  visible: true, minimized: false, foreground: true, dpi: 96, scaleFactor: 1,
  windowRect: { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 },
  clientRect: { x: 0, y: 0, width: 800, height: 600 }, clientOrigin: { x: 0, y: 0 } };
const code = (wanted: string) => (e: unknown) => e instanceof WindowsAutomationError && e.code === wanted;
async function main() {
  let current = { ...window }; const calls: string[] = []; let inputs = 0;
  const host = { request: async (action: string) => {
    calls.push(action);
    if (action === "list_windows") return [current];
    if (action === "inspect_window") return current;
    if (action === "click_client") { inputs++; return {}; }
    throw new Error(`unexpected ${action}`);
  } };
  const service = new WindowsComputerUseBackend(host as never, {} as never);
  for (const invalid of [
    { action: "list_windows", actions: [{ action: "move_client", x: 0, y: 0 }], processId: 1 },
    { action: "list_windows", actions: [] }, { actions: [] }, { actions: Array(9).fill({ action: "click_client" }) }, {},
  ]) {
    await assert.rejects(service.execute(invalid as ComputerExecInput));
    assert.equal(calls.length, 0, "invalid input must fail before any Host RPC");
  }
  for (const mutation of [
    { clientRect: { ...window.clientRect, width: 900 } }, { dpi: 144 }, { processId: 21 }, { className: "Replacement" },
  ]) {
    current = { ...window };
    const observed = await service.execute({ action: "inspect_window", windowHandle: "10" });
    current = { ...window, ...mutation };
    for (const input of [
      { action: "click_client", x: 10, y: 10 },
      { actions: [{ action: "click_client", x: 10, y: 10 }] },
    ]) await assert.rejects(service.execute({ ...input, taskId: "stale", windowHandle: "10", observationId: observed.observationId } as ComputerExecInput), code("STALE_OBSERVATION"));
    assert.equal(inputs, 0, "changed DPI, identity or geometry must never send old input, including batches");
    coordinator.endTask("stale");
  }
  current = { ...window };
  // Title changes are normal document state and must not invalidate stable HWND/PID.
  const observed = await service.execute({ action: "inspect_window", windowHandle: "10" });
  current = { ...window, title: "Fixture * unsaved" };
  await service.execute({ action: "click_client", windowHandle: "10", observationId: observed.observationId, x: 5, y: 5 });
  assert.equal(inputs, 1);
  const captured = verificationFor({ action: "screenshot_window", taskId: "screenshot", windowHandle: "10" }, { action: "screenshot_window", window, screenshot: new Uint8Array([1]) });
  assert.equal(captured.visualVerification, "captured"); assert.equal(captured.postObservation, "verified");
  assert.equal(captured.semanticVerification, "not_requested", "a screenshot cannot prove a business outcome");
  const fail = verificationFor({ action: "click_client", captureAfter: true }, { action: "click_client", observationStatus: "failed" });
  assert.equal(fail.visualVerification, "failed"); assert.equal(fail.postObservation, "unavailable");

  const old = new AbortController(), fresh = new AbortController();
  coordinator.scope("owner", old.signal, "execution-old");
  const freshScope = coordinator.scope("owner", fresh.signal, "execution-new");
  old.abort(); coordinator.endTask("owner", "completed", "execution-old");
  assert.equal(freshScope.aborted, false, "late termination of an old turn must not revoke the next turn");
  coordinator.endTask("owner", "completed", "execution-new"); assert.equal(freshScope.aborted, true);

  const nestedParent = new AbortController();
  const toolScope = coordinator.scope("nested", nestedParent.signal, "same-execution");
  coordinator.scope("nested", coordinator.scope("nested", toolScope));
  coordinator.cancel("nested");
  assert.equal(toolScope.aborted, true);
  assert.throws(() => coordinator.scope("nested", nestedParent.signal, "same-execution"), code("REQUEST_CANCELLED"));
  coordinator.endTask("nested");

  let unblock!: () => void, started!: () => void;
  const gate = new Promise<void>(r => { unblock = r; }); const entered = new Promise<void>(r => { started = r; });
  const order: string[] = [];
  const queued = new WindowsComputerUseBackend({ request: async (action: string) => {
    order.push(action); if (action === "list_windows") { started(); await gate; return [window]; }
    if (action === "inspect_window") return window;
    if (action === "click_client") return {};
    throw new Error(action);
  } } as never, {} as never);
  const first = queued.execute({ action: "list_windows" }); await entered;
  const cancel = new AbortController();
  const second = queued.execute({ action: "click_client", windowHandle: "10", x: 1, y: 1 }, cancel.signal);
  cancel.abort(); await assert.rejects(second); assert.deepEqual(order, ["list_windows"]);
  unblock(); await first;
  await queued.execute({ action: "inspect_window", windowHandle: "10" });
  assert.equal(order.includes("click_client"), false, "cancelled queued input must never reach the desktop");

  let batchClicks = 0;
  const partial = new WindowsComputerUseBackend({ request: async (action: string) => {
    if (action === "list_windows") return [window];
    if (action === "inspect_window") return window;
    if (action === "click_client") {
      if (++batchClicks === 2) throw new WindowsAutomationError("FOCUS_FAILED", "focus stolen between steps");
      return {};
    }
    throw new Error(action);
  } } as never, {} as never);
  await assert.rejects(partial.execute({ taskId: "partial", windowHandle: "10", settleMs: 0,
    actions: Array.from({ length: 8 }, () => ({ action: "click_client" as const, x: 1, y: 1 })),
  }), (error: unknown) => {
    assert(error instanceof WindowsAutomationError);
    const batch = (error.details as { batch: { completedSteps: number; failedIndex: number } }).batch;
    assert.equal(batch.completedSteps, 1); assert.equal(batch.failedIndex, 1);
    return error.code === "FOCUS_FAILED";
  });
  assert.equal(batchClicks, 2, "partial batch must stop immediately and never replay already executed steps");
  coordinator.endTask("partial");

  const sequence: number[] = [];
  const ordered = new WindowsComputerUseBackend({ request: async (action: string, params: { x?: number }) => {
    if (action === "list_windows") return [window];
    if (action === "inspect_window") return window;
    if (action === "click_client") { sequence.push(params.x!); return {}; }
    throw new Error(action);
  } } as never, {} as never);
  await Promise.all([1, 2, 3].map(id => ordered.execute({ windowHandle: "10", settleMs: 0,
    actions: Array.from({ length: 8 }, () => ({ action: "click_client" as const, x: id, y: 1 })),
  })));
  assert.deepEqual(sequence, [1, 2, 3].flatMap(id => Array(8).fill(id)), "concurrent eight-step transactions must not interleave");

  let focusWindow = { ...window }, focusAttempts = 0;
  const lostFocus = new WindowsComputerUseBackend({ request: async (action: string) => {
    if (action === "list_windows") return [focusWindow];
    if (action === "inspect_window") return focusWindow;
    if (action === "click_client") {
      focusAttempts++;
      focusWindow = { ...window, dpi: 144 };
      throw new WindowsAutomationError("FOCUS_FAILED", "focus changed while target moved to another display");
    }
    throw new Error(action);
  } } as never, {} as never);
  const focusObservation = await lostFocus.execute({ action: "inspect_window", windowHandle: "10" });
  await assert.rejects(lostFocus.execute({ action: "click_client", taskId: "focus-drift", windowHandle: "10",
    observationId: focusObservation.observationId, x: 1, y: 1,
  }), code("STALE_OBSERVATION"));
  assert.equal(focusAttempts, 1, "focus recovery must not discard evidence and replay coordinates after a DPI change");
  coordinator.endTask("focus-drift");
  console.log("computer use boundaries PASS (conflicting modes, empty/oversized batches, stale size/DPI/PID/class, title changes, screenshot truth, old-turn isolation, queued cancellation)");
}
void main();
