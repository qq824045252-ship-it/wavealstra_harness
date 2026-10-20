import assert from "node:assert/strict";
import { ComputerAutomationService } from "../src/main/capabilities/ComputerAutomationService";
import { prepareComputerUseInput } from "../src/main/capabilities/ComputerUsePolicy";
import { planComputerUseRecovery } from "../src/main/capabilities/ComputerUseRecoveryPolicy";
import { computerUseRunCoordinator } from "../src/main/capabilities/ComputerUseRunCoordinator";
import { computerUseOverlayService } from "../src/main/capabilities/ComputerUseOverlayService";
import { WindowsAutomationError, type WindowInfo } from "../src/main/capabilities/windows/windowsAutomationProtocol";

function fixture(overrides: Partial<WindowInfo> = {}): WindowInfo {
  return {
    handle: "9001",
    processId: 101,
    processName: "fixture",
    title: "Fixture",
    className: "FixtureClass",
    visible: true,
    minimized: false,
    foreground: true,
    windowRect: { left: 100, top: 100, right: 900, bottom: 700, width: 800, height: 600 },
    clientRect: { x: 0, y: 0, width: 780, height: 560 },
    clientOrigin: { x: 110, y: 130 },
    dpi: 96,
    scaleFactor: 1,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function isCancelled(error: unknown): boolean {
  return error instanceof WindowsAutomationError && error.code === "REQUEST_CANCELLED";
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("CU cancellation fixture did not settle within 2 seconds")), 2_000);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function cancellationCase(action: "mouse_click" | "wait_for_window"): Promise<void> {
  const taskId = `cancel-${action}`;
  const started = deferred<void>();
  const parent = new AbortController();
  const calls: string[] = [];
  let pending = true;
  let cancelledRequests = 0;
  const host = {
    request: async (called: string, _params: unknown, _timeout: number | undefined, signal?: AbortSignal) => {
      calls.push(called);
      assert.ok(signal, "Every Agent-facing Host request must carry its CU scope");
      assert.equal(signal.aborted, false);
      if (called === "list_windows") return [fixture()];
      if (called === action) {
        if (!pending) return { matched: true, window: fixture() };
        started.resolve();
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            cancelledRequests += 1;
            reject(new WindowsAutomationError("REQUEST_CANCELLED", "fixture cancelled"));
          }, { once: true });
        });
      }
      throw new Error(`Unexpected cancellation fixture action ${called}`);
    },
  };
  const service = new ComputerAutomationService(host as never, {} as never);
  const input = action === "mouse_click"
    ? { action, taskId, x: 1, y: 1 }
    : { action, taskId, windowHandle: "9001", timeoutMs: 30_000 };
  const running = service.execute(input, parent.signal);
  await bounded(started.promise);
  computerUseRunCoordinator.cancel(taskId);
  await assert.rejects(bounded(running), isCancelled, "Stopping CU must reject the pending operation");
  assert.equal(parent.signal.aborted, false, "Stopping CU must leave the Agent signal active");
  assert.equal(cancelledRequests, 1, "The pending Windows Host request must be cancelled");
  assert.equal(calls.filter(called => called === action).length, 1, "Cancelled input must not retry");
  const count = calls.length;
  await assert.rejects(service.execute(input, parent.signal), isCancelled, "Later CU calls in the same parent run must be rejected");
  assert.equal(calls.length, count, "Rejected same-run calls must not contact the Host");
  assert.throws(() => computerUseRunCoordinator.prepare(input), isCancelled);
  assert.throws(() => computerUseRunCoordinator.presentDesktop(input), isCancelled);
  assert.throws(() => computerUseRunCoordinator.presentTarget(input, fixture()), isCancelled);
  assert.throws(() => computerUseRunCoordinator.complete(input, { action }), isCancelled);
  computerUseRunCoordinator.endTask(taskId, "failed");
  pending = false;
  const next = await service.execute(input, parent.signal);
  assert.equal(next.action, action, "A new parent run may use CU after endTask releases the cancelled run");
  assert.equal(calls.filter(called => called === action).length, 2);
  computerUseRunCoordinator.endTask(taskId);
}

async function captureCancellationCase(): Promise<void> {
  const taskId = "cancel-capture";
  const captureStarted = deferred<void>();
  const finishCapture = deferred<{ screenshot: Uint8Array; details: {} }>();
  let hostCalls = 0;
  const host = { request: async (action: string, _params: unknown, _timeout: unknown, signal?: AbortSignal) => {
    assert.ok(signal);
    hostCalls += 1;
    if (action === "inspect_window") return fixture();
    if (action === "focus_window") return { window: fixture() };
    throw new Error(`Unexpected capture fixture action ${action}`);
  } };
  const capture = { capture: async () => { captureStarted.resolve(); return finishCapture.promise; } };
  const service = new ComputerAutomationService(host as never, capture as never);
  const pending = service.execute({ action: "screenshot_window", taskId, windowHandle: "9001" });
  await bounded(captureStarted.promise);
  computerUseRunCoordinator.cancel(taskId);
  await assert.rejects(bounded(pending), isCancelled, "CU stop must leave a pending capture without waiting for Electron");
  const callsAtCancel = hostCalls;
  finishCapture.resolve({ screenshot: new Uint8Array([1]), details: {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hostCalls, callsAtCancel, "Late capture results must not trigger verification Host calls");
  computerUseRunCoordinator.endTask(taskId);
}

async function lifecycleCases(): Promise<void> {
  const originalSettle = computerUseOverlayService.settle;
  const settled: Array<{ taskId: string; phase: string }> = [];
  computerUseOverlayService.settle = (taskId, phase) => { settled.push({ taskId, phase }); };
  try {
    const failedHost = { request: async () => { throw new Error("initial observation failed"); } };
    const service = new ComputerAutomationService(failedHost as never, {} as never);
    await assert.rejects(service.execute({ action: "list_windows", taskId: "initial-no-target" }), /initial observation failed/);
    assert(settled.some(value => value.taskId === "initial-no-target" && value.phase === "failed"), "First failure with no resolved target must settle the overlay");
    const isolated = new AbortController();
    const scoped = computerUseRunCoordinator.scope("parent-cancel", isolated.signal);
    isolated.abort();
    assert.equal(scoped.aborted, true, "Parent cancellation must reach the CU scope");
    computerUseRunCoordinator.endTask("parent-cancel", "failed");
    const released = computerUseRunCoordinator.scope("released-run");
    computerUseRunCoordinator.endTask("released-run");
    assert.equal(released.aborted, true, "Ending a parent run must cancel its remaining CU work");
    computerUseRunCoordinator.cancel("unknown-run");
    assert.equal(computerUseRunCoordinator.scope("unknown-run").aborted, false, "Cancelling an absent run must not revoke a future run");
    computerUseRunCoordinator.endTask("unknown-run");
  } finally {
    computerUseRunCoordinator.endTask("initial-no-target", "failed");
    computerUseOverlayService.settle = originalSettle;
  }
}

async function runOwnershipCase(): Promise<void> {
  const taskId = "run-ownership";
  const input = { action: "list_windows" as const, taskId };
  const parent = new AbortController();
  const oldOuterScope = computerUseRunCoordinator.scope(taskId, parent.signal);
  const started = deferred<void>();
  const finishRequest = deferred<WindowInfo[]>();
  const originalSettle = computerUseOverlayService.settle;
  const settled: Array<{ taskId: string; phase: string }> = [];
  computerUseOverlayService.settle = (settledTaskId, phase) => { settled.push({ taskId: settledTaskId, phase }); };
  try {
    const host = { request: async (action: string, _params: unknown, _timeout: unknown, signal?: AbortSignal) => {
      assert.equal(action, "list_windows");
      assert.ok(signal);
      assert.equal(signal.aborted, false);
      started.resolve();
      return finishRequest.promise;
    } };
    const service = new ComputerAutomationService(host as never, {} as never);
    const oldCall = service.execute(input, oldOuterScope);
    await bounded(started.promise);

    // Replace the run synchronously before the old request's abort catch resumes.
    computerUseRunCoordinator.endTask(taskId);
    const nextScope = computerUseRunCoordinator.scope(taskId);
    computerUseRunCoordinator.prepare(input);
    const settledAtReplacement = settled.length;
    await assert.rejects(bounded(oldCall), isCancelled);
    assert.equal(settled.length, settledAtReplacement, "The old service failure must not settle the replacement run's overlay");
    assert.equal(parent.signal.aborted, false);
    assert.equal(nextScope.aborted, false);

    // An outer tool scope can finish after its service scope (for example Vision).
    computerUseRunCoordinator.fail(input, oldOuterScope);
    assert.equal(settled.length, settledAtReplacement, "A late outer tool failure must retain its original run ownership");
    finishRequest.resolve([fixture()]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled.length, settledAtReplacement, "A late Host result must not settle the replacement run");

    computerUseRunCoordinator.fail(input, nextScope);
    assert.equal(settled.length, settledAtReplacement + 1, "A failure owned by the current run must still settle its overlay");
    assert.deepEqual(settled.at(-1), { taskId, phase: "failed" });
  } finally {
    finishRequest.resolve([fixture()]);
    computerUseRunCoordinator.endTask(taskId);
    computerUseOverlayService.settle = originalSettle;
  }
}

async function main(): Promise<void> {
  const prepared = prepareComputerUseInput({
    action: "click_client", taskId: "task-run", windowHandle: "9001", x: 20, y: 30, observeAfter: false,
  });
  assert.equal(prepared.observeAfter, true, "Agent side effects must force post-action observation");
  assert.equal(prepared.captureAfter, undefined, "capture_after must stay opt-in");
  const explicitCapture = prepareComputerUseInput({
    action: "click_client", taskId: "task-run", windowHandle: "9001", x: 20, y: 30, captureAfter: true,
  });
  assert.equal(explicitCapture.captureAfter, true, "explicit capture_after must be preserved");
  const raw = prepareComputerUseInput({ action: "click_client", windowHandle: "9001", x: 20, y: 30, observeAfter: false });
  assert.equal(raw.observeAfter, false, "raw low-level calls keep caller semantics");
  assert.equal(raw.captureAfter, undefined);

  const stalePlan = planComputerUseRecovery(new WindowsAutomationError("STALE_OBSERVATION", "stale"), {
    action: "click_client", taskId: "task-run", windowHandle: "9001", observationId: "old", x: 1, y: 1,
  }, 0);
  assert.equal(stalePlan?.retry, true);
  assert.equal(stalePlan?.input?.observationId, undefined);
  const ambiguousPlan = planComputerUseRecovery(new WindowsAutomationError("CONTROL_AMBIGUOUS", "ambiguous"), {
    action: "invoke_control", taskId: "task-run", windowHandle: "9001", controlName: "Open",
  }, 0);
  assert.equal(ambiguousPlan?.retry, false);
  assert.match(ambiguousPlan?.guidance ?? "", /inspect_controls/);
  assert.equal(planComputerUseRecovery(new WindowsAutomationError("REQUEST_CANCELLED", "cancelled"), { action: "mouse_click", taskId: "cancelled-policy" }, 0)?.retry, false);

  let current = fixture();
  let clicks = 0;
  let failNextClickWithFocus = false;
  const fakeHost = {
    pid: 777,
    request: async (action: string) => {
      if (action === "inspect_window") return current;
      if (action === "list_windows") return [current];
      if (action === "click_client") {
        if (failNextClickWithFocus) {
          failNextClickWithFocus = false;
          throw new WindowsAutomationError("FOCUS_FAILED", "simulated focus failure");
        }
        clicks += 1;
        return {};
      }
      throw new Error(`Unexpected action ${action}`);
    },
    shutdown: async () => undefined,
  };
  const fakeCapture = {
    capture: async () => ({ screenshot: new Uint8Array([1, 2, 3]), details: { coordinateSpace: "client-dip-aligned-pixels" } }),
  };
  const service = new ComputerAutomationService(fakeHost as never, fakeCapture as never);

  const result = await service.execute({
    action: "click_client", taskId: "task-run", windowHandle: current.handle, x: 10, y: 10, captureAfter: true,
    expectedOutcomes: [{ kind: "target_foreground", windowTitleContains: "Fixture" }],
  });
  assert.equal(clicks, 1);
  assert.ok(result.screenshot, "automatic verify must return a post-action screenshot");
  assert.equal((result.computerUseRun as any)?.verification?.postObservation, "verified");
  assert.equal((result.computerUseRun as any)?.verification?.visualVerification, "captured");
  assert.equal(result.semanticOutcome?.status, "passed", "explicit semantic postcondition must pass");
  assert.equal((result.computerUseRun as any)?.verification?.semanticVerification, "passed");

  const semanticMismatch = await service.execute({
    action: "click_client", taskId: "task-run", windowHandle: current.handle, x: 12, y: 12,
    expectedOutcomes: [{ kind: "new_window", windowTitleContains: "Expected Dialog" }],
  });
  assert.equal(clicks, 2);
  assert.equal(semanticMismatch.semanticOutcome?.status, "failed", "missing expected window must not be reported as success");
  assert.equal((semanticMismatch.computerUseRun as any)?.verification?.semanticVerification, "failed");
  assert.equal(semanticMismatch.screenshot, undefined, "capture_after must not be forced after every action");
  assert.equal((semanticMismatch.computerUseRun as any)?.verification?.visualVerification, "not-required");

  const observation = await service.execute({ action: "inspect_window", windowHandle: current.handle });
  current = fixture({ clientRect: { x: 0, y: 0, width: 760, height: 560 } });
  const recovered = await service.execute({
    action: "click_client", taskId: "task-run", windowHandle: current.handle,
    observationId: observation.observationId, x: 10, y: 10,
  });
  assert.equal(clicks, 3, "stale observation recovery must execute the side effect exactly once");
  assert.equal((recovered.computerUseRun as any)?.recovery?.reason, "stale-observation");

  failNextClickWithFocus = true;
  const focusRecovered = await service.execute({
    action: "click_client", taskId: "task-run", windowHandle: current.handle, x: 10, y: 10,
  });
  assert.equal(clicks, 4, "focus recovery must retry only after the failed pre-input focus attempt");
  assert.equal((focusRecovered.computerUseRun as any)?.recovery?.reason, "focus-retry");

  computerUseRunCoordinator.endTask("task-run");
  await cancellationCase("mouse_click");
  await cancellationCase("wait_for_window");
  await captureCancellationCase();
  await lifecycleCases();
  await runOwnershipCase();
  console.log("computer use run PASS (O-A-V, bounded recovery, scoped input/wait/capture cancellation, same-run revocation, parent isolation, run release, first-failure overlay cleanup, late failure run ownership)");
}

void main();
