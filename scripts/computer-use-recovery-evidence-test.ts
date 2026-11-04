import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Database from "better-sqlite3";
import { ExecutionFailureRepository } from "../src/main/agent/ExecutionFailureRepository";
import {
  computerUseRecoveryTarget,
  recordComputerUseFailureRecovery,
  settleComputerUseResultRecovery,
} from "../src/main/agent/ComputerUseFailureRecovery";
import { WindowsAutomationError, type ComputerExecInput, type ComputerExecOutput, type WindowInfo } from "../src/main/platform/computer-use/protocol";

function windowFixture(): WindowInfo {
  return {
    handle: "9001", processId: 101, processName: "fixture", title: "Fixture", className: "FixtureClass",
    visible: true, minimized: false, foreground: true,
    windowRect: { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 },
    clientRect: { x: 0, y: 0, width: 780, height: 560 }, clientOrigin: { x: 10, y: 30 }, dpi: 96, scaleFactor: 1,
  };
}

const db = new Database(":memory:");
db.exec("CREATE TABLE tasks(id TEXT PRIMARY KEY); INSERT INTO tasks VALUES ('task');");
const failures = new ExecutionFailureRepository(db);
const ctx = { taskId: "task", executionId: "exec", assistantMessageId: "msg" };
const bridge = { resolveContext: () => ctx, failures };
const target = windowFixture();

try {
  const click = { action: "click_client" as const, taskId: "task", windowHandle: target.handle, x: 10, y: 10 };
  assert.equal(computerUseRecoveryTarget(click), "computer:click_client:hwnd=9001");

  assert.equal(recordComputerUseFailureRecovery(bridge, click, new WindowsAutomationError("WINDOW_NOT_FOUND", "gone")), true);
  const missing = failures.list("task").find((item) => item.causeCode === "computer-window-not-found")!;
  assert.equal(missing.phase, "observe");
  assert.equal(missing.sideEffects, "none", "window lookup failure proves the input action never ran");
  assert.match(missing.nextAction, /do not replay input to a different window/i);

  assert.equal(recordComputerUseFailureRecovery(bridge, click, new WindowsAutomationError("REQUEST_TIMEOUT", "timeout")), true);
  const timeout = failures.list("task").find((item) => item.causeCode === "computer-request-timeout")!;
  assert.equal(timeout.phase, "execute");
  assert.equal(timeout.sideEffects, "unknown", "input timeout may have reached Windows and must not be auto-replayed");

  const beforeCancelCount = failures.list("task").length;
  assert.equal(recordComputerUseFailureRecovery(bridge, click, new WindowsAutomationError("REQUEST_CANCELLED", "cancelled")), false);
  assert.equal(failures.list("task").length, beforeCancelCount, "user/runtime cancellation must not create a persistent recovery notice");

  settleComputerUseResultRecovery(bridge, click, {
    action: "click_client", window: target,
    semanticOutcome: { status: "not_requested", checks: [] },
    computerUseRun: { verification: { postObservation: "verified", visualVerification: "captured", semanticVerification: "not_requested" } },
  });
  assert(failures.list("task").find((item) => item.id === missing.id)?.resolvedAt, "same action + stable HWND success resolves prior target failure");
  assert.equal(failures.list("task").find((item) => item.id === timeout.id)?.resolvedAt, undefined,
    "plain tool success must not erase a prior side-effecting timeout whose first action may already have reached Windows");

  settleComputerUseResultRecovery(bridge, click, {
    action: "click_client", window: target,
    semanticOutcome: { status: "failed", checks: [{ kind: "new_window", status: "failed", evidence: "missing" }] },
    computerUseRun: { verification: { postObservation: "verified", visualVerification: "captured", semanticVerification: "failed" } },
  });
  const semanticFailure = failures.list("task").find((item) => !item.resolvedAt && item.causeCode === "computer-semantic-verification-failed")!;
  assert.equal(semanticFailure.phase, "verify");
  assert.equal(semanticFailure.sideEffects, "known", "the click ran; only its intended outcome is unproven");
  assert.equal(failures.list("task").find((item) => item.id === timeout.id)?.resolvedAt, undefined, "failed semantic postcondition still does not reconcile the timed-out click");

  settleComputerUseResultRecovery(bridge, click, {
    action: "click_client", window: target,
    semanticOutcome: { status: "passed", checks: [{ kind: "target_foreground", status: "passed", evidence: "ok" }] },
    computerUseRun: { verification: { postObservation: "verified", visualVerification: "captured", semanticVerification: "passed" } },
  });
  assert(failures.list("task").find((item) => item.id === semanticFailure.id)?.resolvedAt, "same target semantic pass clears prior semantic failure");
  assert(failures.list("task").find((item) => item.id === timeout.id)?.resolvedAt, "explicit same-target semantic pass may clear the prior side-effecting transport uncertainty");

  settleComputerUseResultRecovery(bridge, click, {
    action: "click_client", window: target,
    semanticOutcome: { status: "not_requested", checks: [] },
    computerUseRun: { verification: { postObservation: "unavailable", visualVerification: "failed", semanticVerification: "not_requested" } },
  });
  const verifyUnavailable = failures.list("task").find((item) => !item.resolvedAt && item.causeCode === "computer-post-verification-unavailable")!;
  assert.equal(verifyUnavailable.phase, "verify");
  assert.equal(verifyUnavailable.sideEffects, "known");
  settleComputerUseResultRecovery(bridge, click, {
    action: "click_client", window: target,
    semanticOutcome: { status: "not_requested", checks: [] },
    computerUseRun: { verification: { postObservation: "verified", visualVerification: "captured", semanticVerification: "not_requested" } },
  });
  assert(failures.list("task").find((item) => item.id === verifyUnavailable.id)?.resolvedAt, "fresh post-action evidence clears verification-unavailable recovery");

  const observationOnly = { action: "type_text" as const, taskId: "task", observationId: "old-observation", text: "abc" };
  const staleDetails = { observation: target };
  const stableFromEvidence = computerUseRecoveryTarget(observationOnly, staleDetails);
  assert.equal(stableFromEvidence, "computer:type_text:hwnd=9001|pid=101");
  recordComputerUseFailureRecovery(bridge, observationOnly, new WindowsAutomationError("STALE_OBSERVATION", "stale", staleDetails));
  const stale = failures.list("task").find((item) => !item.resolvedAt && item.causeCode === "computer-stale-observation")!;
  assert.equal(stale.target, stableFromEvidence, "observation-only failures recover stable HWND/PID identity from evidence rather than binding to an expired observation id");
  settleComputerUseResultRecovery(bridge, { ...observationOnly, observationId: "fresh-observation" }, {
    action: "type_text", window: target,
    semanticOutcome: { status: "not_requested", checks: [] },
    computerUseRun: { verification: { postObservation: "verified", visualVerification: "captured", semanticVerification: "not_requested" } },
  });
  assert(failures.list("task").find((item) => item.id === stale.id)?.resolvedAt, "new observation of the same HWND/PID can clear the stale-observation recovery without replaying to another window");

  const openFor = (input: ComputerExecInput, code: string) => failures.list("task").find(item => !item.resolvedAt &&
    item.target === computerUseRecoveryTarget(input) && item.causeCode === code);
  const resolved = (id: string): boolean => Boolean(failures.list("task").find(item => item.id === id)?.resolvedAt);
  const verified = (action: ComputerExecOutput["action"]): ComputerExecOutput => ({
    action, executed: true, verified: true, semanticOutcome: { status: "passed", checks: [] },
    computerUseRun: { verification: { postObservation: "verified", visualVerification: "not-required", semanticVerification: "passed" } },
  });
  let evidenceChecks = 0;
  for (const [index, details, expected] of [
    [0, { executed: true }, "known"],
    [1, { executed: "unknown" }, "unknown"],
    [2, { completedSteps: 4 }, "known"],
    [3, { executed: false, completedClicks: 1 }, "known"],
    [4, { executed: true, executionUncertain: true, completedSteps: 2 }, "unknown"],
    [5, { actionResult: { executed: true, batch: { completed: false, steps: [{ index: 0, action: "key_press", ok: true }] } } }, "known"],
    [6, { completedKeys: [42], unknownButtons: [0] }, "unknown"],
    [7, { executed: false, clipboardChanged: true }, "known"],
  ] as const) {
    const input = { ...click, windowHandle: String(9100 + index) };
    recordComputerUseFailureRecovery(bridge, input, new WindowsAutomationError("STALE_OBSERVATION", "changed after dispatch", details));
    const record = openFor(input, "computer-stale-observation")!;
    assert.equal(record.sideEffects, expected, JSON.stringify(details));
    assert.equal(record.phase, "execute", "delivery evidence overrides pre-action error-code assumptions");
    assert.match(record.nextAction, /do not replay/i);
    // A later ordinary Windows result is not evidence that the delivered prefix was reconciled.
    settleComputerUseResultRecovery(bridge, input, { action: "click_client", window: target,
      semanticOutcome: { status: "not_requested", checks: [] },
      computerUseRun: { verification: { postObservation: "verified", visualVerification: "not-required" } },
    });
    assert.equal(resolved(record.id), false, "a precondition-shaped code must not clear a dispatched prefix");
    settleComputerUseResultRecovery(bridge, input, verified("click_client"));
    assert.equal(resolved(record.id), true, "confirmed explicit outcome can reconcile the same stable target");
    evidenceChecks++;
  }

  const noDispatch = { ...click, windowHandle: "9201" };
  recordComputerUseFailureRecovery(bridge, noDispatch, new WindowsAutomationError("REQUEST_TIMEOUT", "expired in queue", { executed: false }));
  assert.equal(openFor(noDispatch, "computer-request-timeout")!.sideEffects, "none", "an explicit unsent timeout has no input side effects");
  recordComputerUseFailureRecovery(bridge, noDispatch, new WindowsAutomationError("REQUEST_TIMEOUT", "expired after submission", { executed: "unknown" }));
  assert.equal(openFor(noDispatch, "computer-request-timeout")!.sideEffects, "unknown", "deduplication cannot keep an obsolete no-effect diagnosis");
  evidenceChecks++;

  const batch: ComputerExecInput = { taskId: "task", windowHandle: "9301", actions: [{ action: "key_press", key: "A" }, { action: "key_press", key: "B" }] };
  assert.equal(computerUseRecoveryTarget(batch), "computer:batch:hwnd=9301");
  recordComputerUseFailureRecovery(bridge, batch, new WindowsAutomationError("REQUEST_TIMEOUT", "batch delivery uncertain"));
  const batchTimeout = openFor(batch, "computer-request-timeout")!;
  assert.equal(batchTimeout.sideEffects, "unknown", "batch inputs are never inferred read-only because action is omitted");
  assert.match(batchTimeout.message, /Computer Use batch/);
  assert.doesNotMatch(batchTimeout.message, /undefined/);
  const partialBatch: ComputerExecOutput = {
    ...verified("batch"), executed: true, verified: false,
    batch: { completed: false, settleMs: 0, steps: [
      { index: 0, action: "key_press", ok: true }, { index: 1, action: "key_press", ok: false },
    ] },
  };
  settleComputerUseResultRecovery(bridge, batch, partialBatch);
  assert.equal(resolved(batchTimeout.id), false, "a returned partial batch cannot clear prior transport uncertainty");
  const incompleteBatch = openFor(batch, "computer-batch-incomplete")!;
  assert.equal(incompleteBatch.sideEffects, "known");
  assert.match(incompleteBatch.message, /1 completed input steps/);
  assert.match(incompleteBatch.nextAction, /Do not replay the batch/);
  settleComputerUseResultRecovery(bridge, batch, { ...verified("batch"), batch: {
    completed: true, settleMs: 0, steps: [{ index: 0, action: "key_press", ok: true }, { index: 1, action: "key_press", ok: true }],
  } });
  assert.equal(resolved(batchTimeout.id), true);
  assert.equal(resolved(incompleteBatch.id), true);
  evidenceChecks++;

  const legacyBatch = { ...batch, windowHandle: "9302" };
  recordComputerUseFailureRecovery(bridge, legacyBatch, new WindowsAutomationError("FOCUS_FAILED", "Windows stopped after first step", { batch: { completedSteps: 1, failedIndex: 1 } }));
  assert.equal(openFor(legacyBatch, "computer-focus-failed")!.sideEffects, "known", "Windows completedSteps evidence remains supported without executed fields");
  evidenceChecks++;

  for (const [index, change] of [
    [0, { executed: "unknown", verified: false }],
    [1, { executed: true, verified: false }],
    [2, { executed: true, verified: true, executionUncertain: true }],
    [3, { executed: true, verified: true, observationStatus: "failed" }],
    [4, { executed: true, verified: true, captureError: "optional capture failed" }],
  ] as const) {
    const input = { ...click, windowHandle: String(9400 + index) };
    recordComputerUseFailureRecovery(bridge, input, new WindowsAutomationError("REQUEST_TIMEOUT", "previous uncertain click", { executed: "unknown" }));
    const previous = openFor(input, "computer-request-timeout")!;
    settleComputerUseResultRecovery(bridge, input, { ...verified("click_client"), ...change });
    assert.equal(resolved(previous.id), false, `${JSON.stringify(change)} must not be upgraded by a passed semantic flag`);
    if (index === 0 || index === 2) assert.equal(openFor(input, "computer-delivery-uncertain")!.sideEffects, "unknown");
    settleComputerUseResultRecovery(bridge, input, verified("click_client"));
    assert.equal(resolved(previous.id), true);
    evidenceChecks++;
  }

  const readOnly: ComputerExecInput = { action: "inspect_window", windowHandle: "9501" };
  recordComputerUseFailureRecovery(bridge, readOnly, new WindowsAutomationError("HOST_UNAVAILABLE", "read failed"));
  const readFailure = openFor(readOnly, "computer-host-unavailable")!;
  assert.equal(readFailure.sideEffects, "none");
  settleComputerUseResultRecovery(bridge, readOnly, { action: "inspect_window", window: target });
  assert.equal(resolved(readFailure.id), true, "legacy successful read-only output still resolves no-effect operational errors");
  recordComputerUseFailureRecovery(bridge, readOnly, new WindowsAutomationError("HOST_UNAVAILABLE", "unexpected submitted work", { executed: "unknown" }));
  const uncertainRead = openFor(readOnly, "computer-host-unavailable")!;
  settleComputerUseResultRecovery(bridge, readOnly, { action: "inspect_window", window: target });
  assert.equal(resolved(uncertainRead.id), false, "even a read-only label cannot erase explicit earlier delivery uncertainty");
  evidenceChecks++;

  const nestedTarget = computerUseRecoveryTarget({ actions: [{ action: "key_press", key: "A" }], observationId: "stale-ref" },
    { actionResult: { window: target, executed: true } });
  assert.equal(nestedTarget, "computer:batch:hwnd=9001|pid=101", "result-delivery wrappers retain stable window provenance");
  evidenceChecks++;

  const builtin = await readFile("src/main/capabilities/builtin-capability-extension.ts", "utf8");
  const assembler = await readFile("src/main/agent/SessionExtensionAssembler.ts", "utf8");
  assert(builtin.includes("settleComputerUseResultRecovery(bridge.computerRecovery, input, result)"));
  assert(builtin.includes("recordComputerUseFailureRecovery(bridge.computerRecovery, input, failure)"));
  assert(assembler.includes("computerRecovery: { resolveContext: input.resolveConversationContext, failures: this.deps.executionFailures }"));

  console.log(`computer use recovery evidence: PASS (legacy Windows contracts plus ${evidenceChecks} delivery/batch/uncertainty cases, stable provenance, main-session wiring)`);
} finally { db.close(); }
