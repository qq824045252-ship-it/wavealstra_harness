import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Database from "better-sqlite3";
import { ExecutionFailureRepository } from "../src/main/agent/ExecutionFailureRepository";
import { UiAutomationService, UiAutomationError } from "../src/main/capabilities/UiAutomationService";
import { recordUiAutomationFailureRecovery, settleUiAutomationRecovery, uiAutomationRecoveryTarget } from "../src/main/agent/UiAutomationFailureRecovery";

const db = new Database(":memory:");
db.exec("CREATE TABLE tasks(id TEXT PRIMARY KEY); INSERT INTO tasks VALUES ('task');");
const failures = new ExecutionFailureRepository(db);
const ctx = { taskId: "task", executionId: "exec", assistantMessageId: "msg" };
const bridge = { resolveContext: () => ctx, failures };

try {
  const unavailableService = new UiAutomationService({ app: () => null, browser: () => null, artifact: () => null });
  await assert.rejects(unavailableService.execute({ action: "snapshot", target: "app" }),
    (error: unknown) => error instanceof UiAutomationError && error.code === "TARGET_UNAVAILABLE");
  const unavailable = new UiAutomationError("TARGET_UNAVAILABLE", "not ready");
  const snapshotInput = { action: "snapshot" as const, target: "app" as const };
  assert(recordUiAutomationFailureRecovery(bridge, snapshotInput, unavailable));
  const targetFailure = failures.list("task").find((item) => item.causeCode === "ui-target-unavailable")!;
  assert.equal(targetFailure.phase, "observe");
  assert.equal(targetFailure.sideEffects, "none");
  assert.equal(targetFailure.target, "ui:snapshot:app:surface");
  settleUiAutomationRecovery(bridge, snapshotInput, { action: "snapshot", target: "app", detail: "ok" });
  assert(failures.list("task").find((item) => item.id === targetFailure.id)?.resolvedAt);

  const fakeWebContents = {
    isDestroyed: () => false,
    getURL: () => "mybuddy://fixture",
    getTitle: () => "Fixture",
    executeJavaScript: async () => ({ ok: true, matches: [] }),
  };
  const service = new UiAutomationService({ app: () => fakeWebContents as any, browser: () => null, artifact: () => null });
  let timeoutError: UiAutomationError | undefined;
  try { await service.execute({ action: "wait_for", target: "app", selector: "#never", state: "visible", timeoutMs: 100 }); }
  catch (error) { if (error instanceof UiAutomationError) timeoutError = error; else throw error; }
  assert.equal(timeoutError?.code, "WAIT_TIMEOUT");
  const waitInput = { action: "wait_for" as const, target: "app" as const, selector: "#never", state: "visible" as const, timeoutMs: 100 };
  assert.deepEqual(timeoutError?.outcome, { dispatch: "not_started", effect: "none" });
  assert.equal(recordUiAutomationFailureRecovery(bridge, waitInput, timeoutError), false);

  let missingError: UiAutomationError | undefined;
  try { await service.execute({ action: "click", target: "app", selector: "#missing" }); }
  catch (error) { if (error instanceof UiAutomationError) missingError = error; else throw error; }
  assert.equal(missingError?.code, "ELEMENT_NOT_FOUND");
  const clickInput = { action: "click" as const, target: "app" as const, selector: "#missing" };
  assert.deepEqual(missingError?.outcome, { dispatch: "not_started", effect: "none" });
  assert.equal(recordUiAutomationFailureRecovery(bridge, clickInput, missingError), false);
  const oldLookup = failures.record({ ...ctx, target: uiAutomationRecoveryTarget(clickInput), causeCode: "ui-element-not-found",
    phase: "observe", recovery: "recoverable", sideEffects: "none", message: "old lookup", nextAction: "observe" });
  assert(!failures.list("task").some(item => item.id === oldLookup.id));
  assert(db.prepare("SELECT id FROM execution_failures WHERE id=? AND resolved_at IS NULL").get(oldLookup.id));

  const fillInput = { action: "fill" as const, target: "app" as const, selector: "#field", value: "abc" };
  const notEditable = new UiAutomationError("ELEMENT_NOT_EDITABLE", "not editable");
  assert.equal(recordUiAutomationFailureRecovery(bridge, fillInput, notEditable), false);
  const sent = new UiAutomationError("EXECUTION_FAILED", "readback unavailable", { outcome: { dispatch: "dispatched", effect: "unknown" } });
  assert(recordUiAutomationFailureRecovery(bridge, fillInput, sent));
  const uncertain = failures.list("task").find(item => item.causeCode === "ui-execution-failed")!;
  assert.equal(uncertain.phase, "execute");
  assert.equal(uncertain.sideEffects, "unknown");
  const readFailure = new UiAutomationError("EXECUTION_FAILED", "renderer read failed", { outcome: { dispatch: "not_started", effect: "none" } });
  assert(recordUiAutomationFailureRecovery(bridge, fillInput, readFailure));
  settleUiAutomationRecovery(bridge, fillInput, { action: "fill", target: "app", detail: "filled" });
  assert(failures.list("task").some(item => item.sideEffects === "none" && item.causeCode === "ui-execution-failed" && item.resolvedAt));
  assert(!failures.list("task").find(item => item.id === uncertain.id)?.resolvedAt);

  const beforeInvalid = failures.list("task").length;
  assert.equal(recordUiAutomationFailureRecovery(bridge, { action: "find", target: "app", selector: "[" }, new UiAutomationError("INVALID_SELECTOR", "bad selector")), false);
  assert.equal(recordUiAutomationFailureRecovery(bridge, { action: "press", target: "app", selector: "#x" }, new UiAutomationError("INVALID_INPUT", "bad key")), false);
  assert.equal(failures.list("task").length, beforeInvalid, "agent invocation mistakes must not create persistent user recovery notices");

  assert.equal(uiAutomationRecoveryTarget({ action: "click", target: "artifact", role: "button", name: "Save" }), "ui:click:artifact:role=button|name=save");

  const builtin = await readFile("src/main/capabilities/builtin-capability-extension.ts", "utf8");
  const assembler = await readFile("src/main/agent/SessionExtensionAssembler.ts", "utf8");
  assert(builtin.includes("settleUiAutomationRecovery(bridge.uiRecovery, input, result)"));
  assert(builtin.includes("recordUiAutomationFailureRecovery(bridge.uiRecovery, input, error)"));
  assert(assembler.includes("uiRecovery: { resolveContext: input.resolveConversationContext, failures: this.deps.executionFailures }"));

  console.log("UI automation recovery: PASS (typed service errors, environment-only recovery, pre-action side-effect safety, same-target resolution, invocation-error filtering, main-session wiring)");
} finally { db.close(); }
