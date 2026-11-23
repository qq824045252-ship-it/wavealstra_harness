import type { EntryRecord, NestedToolExecutionResult } from "@earendil-works/pi-durable";
import { z } from "zod";
import type { GoalCheckOutcome, PstackCheckIdentity } from "../../../shared/conversation-goal-activity";
import { readNativeExecutionReceipt } from "../../../shared/native-execution-receipt";
import type { WorkflowRun } from "./PstackState";
import type { WorkspaceDelta } from "./PstackWorkspace";

export const pstackCheckIdentitySchema = z.object({
  version: z.literal(1), workflowRun: z.number().int(), operationTaskId: z.number().int(), toolTaskId: z.number().int(),
  shell: z.enum(["bash", "powershell"]), beforeFingerprint: z.string(), afterFingerprint: z.string(),
  beforeCheckoutSha: z.string().optional(), afterCheckoutSha: z.string().optional(), checkoutSha: z.string().optional(),
  executionId: z.string().optional(), attemptId: z.string().optional(), desktopReport: z.object({
    reportPath: z.string(), reportSha256: z.string(), inputFingerprint: z.string(), caseIds: z.array(z.string()),
  }).strict().optional(),
}).strict() satisfies z.ZodType<PstackCheckIdentity>;

export type VerificationOutcome = { outcome: "passed" } | {
  outcome: Exclude<GoalCheckOutcome, "passed">;
  error: string;
  changedPaths?: string[];
};

const receiptPrefix = "VERIFICATION_RESULT ";
const desktopReceipt = z.object({
  outcome: z.enum(["passed", "assertion_failed", "blocked_same_failure", "infrastructure_failed", "inputs_changed"]),
  reused: z.boolean(), reportPath: z.string().min(1),
  assertionFailure: z.object({ caseId: z.string(), assertion: z.string() }).optional(),
  reportSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  inputFingerprint: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  caseIds: z.array(z.string().min(1)).min(1).optional(),
}).refine(({ reportSha256, inputFingerprint, caseIds }) =>
  !reportSha256 && !inputFingerprint && !caseIds || !!reportSha256 && !!inputFingerprint && !!caseIds && new Set(caseIds).size === caseIds.length);
const desktopErrors = {
  assertion_failed: "The desktop check failed an assertion.",
  blocked_same_failure: "The desktop check reused an earlier assertion failure. Inspect that report before running it again.",
  infrastructure_failed: "The desktop check could not complete its verification or cleanup.",
  inputs_changed: "The desktop check's inputs changed during the run. Its result does not verify the current inputs.",
};

function desktopOutcome(output: string, exitCode: number | null): {
  classification: VerificationOutcome; desktopReport?: PstackCheckIdentity["desktopReport"];
} | undefined {
  const line = output.split(/\r?\n/).reverse().find(line => line.startsWith(receiptPrefix));
  if (!line) return undefined;
  let value: unknown;
  try { value = JSON.parse(line.slice(receiptPrefix.length)); } catch { /* Report a malformed receipt below. */ }
  const receipt = desktopReceipt.safeParse(value);
  if (!receipt.success) return { classification: { outcome: "tool_error", error: "The desktop check returned a malformed verification receipt." } };
  const { outcome, reused, reportPath, assertionFailure, reportSha256, inputFingerprint, caseIds } = receipt.data;
  if ((outcome === "passed") !== (exitCode === 0) || reused !== (outcome === "blocked_same_failure") ||
    ((outcome === "assertion_failed" || outcome === "blocked_same_failure") && (!assertionFailure || caseIds && !caseIds.includes(assertionFailure.caseId)))) {
    return { classification: { outcome: "tool_error", error: "The desktop check receipt disagrees with its process result. Report: " + reportPath } };
  }
  return {
    classification: outcome === "passed" ? { outcome } : { outcome, error: desktopErrors[outcome] + " Report: " + reportPath },
    ...(reportSha256 && inputFingerprint && caseIds && { desktopReport: { reportPath, reportSha256, inputFingerprint, caseIds } }),
  };
}

export function verificationOutcome(before: MeasuredWorkspace, after: MeasuredWorkspace, exitCode: number | null, toolError: boolean,
  emptySuite: boolean, silentMeasurement: boolean, desktop?: VerificationOutcome): VerificationOutcome {
  if (exitCode === null || (exitCode === 0 && toolError))
    return { outcome: "tool_error", error: "The check did not return a successful tool receipt. Inspect the tool diagnostics." };
  if (desktop && desktop.outcome !== "passed") return desktop;
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

type MeasuredWorkspace = Pick<WorkspaceDelta, "fingerprint" | "coverageComplete" | "paths" | "fileDigests" | "unknown">;

export function checkWorkspaceStamp(workspace: MeasuredWorkspace, checkoutSha?: string) {
  return {
    fingerprint: workspace.fingerprint, coverageComplete: workspace.coverageComplete, paths: workspace.paths,
    fileDigests: Object.fromEntries(workspace.fileDigests), unknown: workspace.unknown, ...(checkoutSha && { checkoutSha }),
  };
}

type CheckWorkspaceStamp = ReturnType<typeof checkWorkspaceStamp>;

export type PstackCheckReceipt = VerificationOutcome & {
  checkIdentity: PstackCheckIdentity;
  command: string;
  passed: boolean;
  exitCode: number | null;
  unchanged: boolean;
  emptySuite: boolean;
  fingerprint: string;
  toolTaskId: number;
  output: { output: string; truncated: boolean };
};

const shellResult = z.object({ exitCode: z.number().int(), output: z.string(), truncated: z.boolean() });

export function pstackCheckReceipt(input: {
  taskId: string; conversationId: number; workflowRun: number; operationTaskId: number;
  shell: string; command: string; measurement: boolean;
  before: CheckWorkspaceStamp; after: CheckWorkspaceStamp; result: NestedToolExecutionResult;
}): PstackCheckReceipt {
  const { taskId, conversationId, workflowRun, operationTaskId, shell, command, measurement, before, after, result } = input;
  const toolTaskId = Number(result.taskId);
  const shellValue = shellResult.safeParse(result.structuredOutput).data;
  const exitCode = shellValue?.exitCode ?? null;
  const output = shellValue?.output ?? "";
  const details = result.details;
  const native = readNativeExecutionReceipt(details);
  const hasNative = object(details) && Object.hasOwn(details, "executionReceipt");
  const matchingNative = native && native.taskId === taskId && native.conversationId === conversationId &&
    native.toolTaskId === toolTaskId && native.toolName === shell;
  const validNative = matchingNative && (native.exitCode ?? null) === exitCode &&
    (native.status === "passed") === (exitCode === 0 && !result.isError) && native.transport === "returned" &&
    native.settlement === "consumed" && native.status !== "inconclusive";
  const counts = [...output.matchAll(/^\s*(?:ℹ|#)?\s*tests\s+(\d+)\s*$|\b(?:ran|collected)\s+(\d+)\s+(?:tests?|items?)\b/gim)]
    .map(match => Number(match[1] ?? match[2]));
  const emptySuite = counts.length ? counts.every(total => total === 0) : /\bno tests (?:were |have been )?(?:found|collected|run)\b/i.test(output);
  const checkoutChanged = before.checkoutSha !== after.checkoutSha;
  const unchanged = before.coverageComplete && after.coverageComplete && before.fingerprint === after.fingerprint && !checkoutChanged;
  const desktop = desktopOutcome(output, exitCode);
  let outcome: VerificationOutcome = hasNative && !validNative
    ? { outcome: "tool_error", error: "The native shell receipt did not confirm this check's execution." }
    : verificationOutcome(
      { ...before, fileDigests: new Map(Object.entries(before.fileDigests)) },
      { ...after, fileDigests: new Map(Object.entries(after.fileDigests)) },
      exitCode, result.isError, emptySuite, measurement && !output.trim(), desktop?.classification,
    );
  if (outcome.outcome === "passed" && checkoutChanged)
    outcome = { outcome: "workspace_changed", error: "The checkout commit changed while the check ran. Verify the current checkout." };
  const observation = shellValue ? output : result.diagnostics.map(item => item.message).join("\n");
  const excerpt = observation.length > 1600 ? observation.slice(0, 900) + "\n[…]\n" + observation.slice(-650) : observation;
  const checkIdentity: PstackCheckIdentity = {
    version: 1, workflowRun, operationTaskId, toolTaskId, shell,
    beforeFingerprint: before.fingerprint, afterFingerprint: after.fingerprint,
    ...(before.checkoutSha && { beforeCheckoutSha: before.checkoutSha }),
    ...(after.checkoutSha && { afterCheckoutSha: after.checkoutSha }),
    ...(unchanged && after.checkoutSha && { checkoutSha: after.checkoutSha }),
    ...(matchingNative && { executionId: native.executionId, ...(native.attemptId && { attemptId: native.attemptId }) }),
    ...(desktop?.desktopReport && { desktopReport: desktop.desktopReport }),
  };
  return { ...outcome, checkIdentity, command, exitCode, toolTaskId, unchanged, emptySuite, fingerprint: after.fingerprint,
    passed: outcome.outcome === "passed", output: { output: excerpt, truncated: excerpt !== observation || shellValue?.truncated === true } };
}

export function passedCurrentCheck(check: WorkflowRun["verification"], workspace: Pick<WorkspaceDelta, "fingerprint" | "coverageComplete">,
  checkoutSha?: string): boolean {
  return !!check && workspace.coverageComplete && check.fingerprint === workspace.fingerprint &&
    (check.checkIdentity ? check.outcome === "passed" && check.checkIdentity.checkoutSha === checkoutSha : check.passed);
}

export function latestCheck(run: WorkflowRun): WorkflowRun["verification"] {
  return run.checkReceipts?.at(-1) ?? run.verification;
}

export function verificationEvidenceKey(checks: readonly ReviewCheck[]): string {
  return checks.map(check => check.toolTaskId).join(",");
}

export function reviewMatchesVerification(run: WorkflowRun, workspace: MeasuredWorkspace, entries: readonly EntryRecord[],
  checkoutSha?: string): boolean {
  const review = run.review;
  return !!review && workspace.coverageComplete &&
    (review.checkoutSha === undefined || review.checkoutSha === (checkoutSha ?? null)) &&
    (review.verificationKey === undefined ||
      review.verificationKey === verificationEvidenceKey(currentVerificationEvidence(run, workspace.fingerprint, entries, checkoutSha)));
}

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object"; }
export type ReviewCheck = { toolTaskId: number; entry?: number; command: string; exitCode: number | null; passed: boolean; output: string; truncated: boolean;
  checkIdentity?: PstackCheckIdentity; outcome?: GoalCheckOutcome };

/** Present only authentic results of a host verify operation from this run,
 * bound to the current task workspace. Ordinary shell prose has no version. */
export function currentVerificationEvidence(run: WorkflowRun, fingerprint: string, entries: readonly EntryRecord[], checkoutSha?: string,
  limit = 8): ReviewCheck[] {
  const checks = new Map<string, ReviewCheck>();
  const modern = new Set(run.checkReceipts?.map(receipt => receipt.checkIdentity.operationTaskId));
  const resultEntries = new Map<number, number>();
  for (const entry of entries) {
    if (entry.kind !== "pi.tool-result" || entry.byTaskId === undefined || !run.operations.includes(entry.byTaskId)) continue;
    if (modern.has(entry.byTaskId)) {
      resultEntries.set(entry.byTaskId, entry.id);
      continue;
    }
    for (const message of entry.model ?? []) {
      if (message.role !== "toolResult" || message.toolName !== "pstack_workflow") continue;
      if (object(message.details) && Object.hasOwn(message.details, "checkIdentity")) continue;
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
  for (const receipt of run.checkReceipts ?? []) {
    const { checkIdentity } = receipt;
    if (checkIdentity.workflowRun !== run.run || !run.operations.includes(checkIdentity.operationTaskId) ||
      !receipt.unchanged || receipt.fingerprint !== fingerprint || checkIdentity.checkoutSha !== checkoutSha) continue;
    const entry = resultEntries.get(checkIdentity.operationTaskId);
    const { command, toolTaskId, exitCode, outcome } = receipt;
    checks.delete(command);
    checks.set(command, { command, toolTaskId, exitCode, passed: outcome === "passed", outcome, checkIdentity, ...receipt.output,
      ...(entry !== undefined && { entry }) });
  }
  return [...checks.values()].slice(-limit);
}
