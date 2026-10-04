import type { VerifiedProcessBridge } from "./VerifiedCodeExecution";

const TARGET = "cad-runtime:freecad";
const CAUSE = "cad-freecad-runtime-not-ready";

export function recordCadFreeCadRuntimeFailure(bridge: VerifiedProcessBridge | undefined, message: string): void {
  const ctx = bridge?.resolveContext();
  if (!bridge?.failures || !ctx) return;
  bridge.failures.recordIfAbsent({
    ...ctx,
    causeCode: CAUSE,
    phase: "prepare",
    recovery: "recoverable",
    sideEffects: "none",
    target: TARGET,
    message,
    nextAction: "Restore or configure FreeCADCmd, then retry; the CAD script has not started.",
  });
}

export function resolveCadFreeCadRuntimeFailure(bridge: VerifiedProcessBridge | undefined): void {
  const ctx = bridge?.resolveContext();
  if (!bridge?.failures || !ctx) return;
  bridge.failures.resolveMatching(ctx.taskId, { target: TARGET, causeCodes: [CAUSE] });
}
