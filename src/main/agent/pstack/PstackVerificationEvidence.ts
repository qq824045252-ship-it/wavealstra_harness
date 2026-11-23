import type { EntryRecord } from "@earendil-works/pi-durable";
import type { WorkflowRun } from "./PstackState";
import type { WorkspaceDelta } from "./PstackWorkspace";

type VerificationFailure = "tool_error" | "command_failed" | "workspace_changed" | "workspace_unverified" | "empty_suite" | "silent_measurement";
export type VerificationOutcome = { outcome: "passed" } | {
  outcome: VerificationFailure;
  error: string;
  changedPaths?: string[];
};

export function verificationOutcome(before: WorkspaceDelta, after: WorkspaceDelta, exitCode: number | null, toolError: boolean,
  emptySuite: boolean, silentMeasurement: boolean): VerificationOutcome {
  if (exitCode === null || (exitCode === 0 && toolError))
    return { outcome: "tool_error", error: "The check did not return a successful tool receipt. Inspect the tool diagnostics." };
  if (exitCode !== 0) return { outcome: "command_failed", error: `The check exited with code ${exitCode}. Inspect the command output.` };
  if (!before.coverageComplete || !after.coverageComplete) {
    const issues = [...new Set([...before.unknown, ...after.unknown])].slice(0, 3);
    return { outcome: "workspace_unverified", error: "The check exited successfully. Workspace inspection was incomplete. " +
      "Resolve the inspection problems before relying on this result. " + issues.join(". ") };
  }
  if (before.fingerprint !== after.fingerprint) {
    const changedPaths = [...new Set([...before.paths, ...after.paths])]
      .filter(path => before.fileDigests.get(path) !== after.fileDigests.get(path)).slice(0, 12);
    return { outcome: "workspace_changed", changedPaths, error: "The check exited successfully. The workspace changed while it ran. " +
      (changedPaths.length ? "Inspect the changed paths before checking a stable snapshot. " + changedPaths.join(", ") :
        "Inspect concurrent workspace changes before checking a stable snapshot.") };
  }
  if (emptySuite) return { outcome: "empty_suite", error: "The test runner executed zero tests. Select the project's actual check." };
  if (silentMeasurement) return { outcome: "silent_measurement", error: "The observed program returned no output." };
  return { outcome: "passed" };
}

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object"; }
export type ReviewCheck = { toolTaskId: number; entry: number; command: string; exitCode: number; passed: boolean; output: string; truncated: boolean };

/** Present only authentic results of a host verify operation from this run,
 * bound to the current task workspace. Ordinary shell prose has no version. */
export function currentVerificationEvidence(run: WorkflowRun, fingerprint: string, entries: readonly EntryRecord[]): ReviewCheck[] {
  const checks = new Map<string, ReviewCheck>();
  for (const entry of entries) {
    if (entry.kind !== "pi.tool-result" || entry.byTaskId === undefined || !run.operations.includes(entry.byTaskId)) continue;
    for (const message of entry.model ?? []) {
      if (message.role !== "toolResult" || message.toolName !== "pstack_workflow") continue;
      const text = message.content.map(c => c.type === "text" ? c.text : "").join("");
      if (!text.includes('"toolTaskId"')) continue;
      let item: unknown;
      try { item = JSON.parse(text); } catch { continue; }
      if (!object(item) || typeof item.command !== "string" || typeof item.toolTaskId !== "number" || typeof item.exitCode !== "number" ||
        typeof item.passed !== "boolean" || item.unchanged !== true || !object(item.output) || typeof item.output.output !== "string") continue;
      const last = run.verification;
      const version = item.fingerprint ?? (last?.toolTaskId === item.toolTaskId && last.command === item.command ? last.fingerprint : undefined);
      if (version !== fingerprint) continue;
      const raw = item.output.output, excerpt = raw.length > 1600 ? raw.slice(0, 900) + "\n[…]\n" + raw.slice(-650) : raw;
      checks.delete(item.command);
      checks.set(item.command, { entry:entry.id, toolTaskId:item.toolTaskId, command:item.command, exitCode:item.exitCode,
        passed:item.passed && !message.isError && item.exitCode === 0, output:excerpt, truncated:raw.length !== excerpt.length || item.output.truncated === true });
    }
  }
  return [...checks.values()].slice(-8);
}
