import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Database from "better-sqlite3";
import { ExecutionFailureRepository } from "../src/main/agent/ExecutionFailureRepository";
import {
  computerUseRecoveryTarget,
  recordComputerUseFailureRecovery,
  settleComputerUseResultRecovery,
} from "../src/main/agent/ComputerUseFailureRecovery";
import { WindowsAutomationError, type WindowInfo } from "../src/main/platform/computer-use/protocol";

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

  const builtin = await readFile("src/main/capabilities/builtin-capability-extension.ts", "utf8");
  const assembler = await readFile("src/main/agent/SessionExtensionAssembler.ts", "utf8");
  assert(builtin.includes("settleComputerUseResultRecovery(bridge.computerRecovery, input, result)"));
  assert(builtin.includes("recordComputerUseFailureRecovery(bridge.computerRecovery, input, failure)"));
  assert(assembler.includes("computerRecovery: { resolveContext: input.resolveConversationContext, failures: this.deps.executionFailures }"));

  console.log("computer use recovery evidence: PASS (pre-action none, input timeout unknown, cancel exclusion, stable target resolution, semantic/post verification recovery, main-session wiring)");
} finally { db.close(); }
