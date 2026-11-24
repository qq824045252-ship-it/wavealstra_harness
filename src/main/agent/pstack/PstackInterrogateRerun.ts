import type { Context } from "@earendil-works/chord/context";
import type { Api, WorkflowOptions, WorkflowRun } from "./PstackState";
import { runSettings } from "./PstackState";
import { assertInterrogateWorkspace, interrogateFindings, type PstackInterrogateFinding } from "./PstackInterrogateEvidence";
import { checkWorkspaceStamp, pstackCheckReceipt } from "./PstackVerificationEvidence";
import { measureWorkspace, verificationCheckout, type WorkspaceBaseline, type WorkspaceDelta } from "./PstackWorkspace";
import { matchingNativeExecutionReceipt } from "../../../shared/native-execution-receipt";

export type InterrogateRerun = NonNullable<WorkflowRun["interrogateReruns"]>[number];
const methodPanelStage = (stageId: string) => stageId.includes("::") ? stageId.slice(0, stageId.lastIndexOf("::") + 2) + "panel" : "panel";

function panel(run: WorkflowRun, stageId: string) {
  const latest = (id: string) => run.delegates.filter(item => item.stageId === id && (item.role === "interrogate-reviewers" || item.interrogate)).at(-1);
  const recorded = latest(stageId) ?? latest(methodPanelStage(stageId));
  const receipt = recorded?.interrogate;
  if (!receipt?.reviewers.length) throw new Error("Interrogate requires a completed panel with real native execution receipts.");
  return { receipt, stageId: recorded!.stageId };
}

export function interrogateFinding(run: WorkflowRun, stageId: string, id: string): PstackInterrogateFinding {
  const finding = interrogateFindings(panel(run, stageId).receipt).find(item => item.id === id);
  if (!finding) throw new Error("Choose a finding ID from this stage's actual interrogate panel receipt.");
  return finding;
}

/** The host chooses the authenticated child directory. The original probe is
 * still executed by the ordinary native shell and its permission policy. */
export function interrogateRerunCommand(finding: PstackInterrogateFinding): string {
  const quote = (value: string) => "'" + value.replace(/'/g, finding.probe.shell === "bash" ? "'\\''" : "''") + "'";
  return finding.probe.shell === "bash"
    ? "cd -- " + quote(finding.workspace.cwd) + " && (\n" + finding.probe.command + "\n)"
    : "Push-Location -LiteralPath " + quote(finding.workspace.cwd) + " -ErrorAction Stop; try {\n" + finding.probe.command +
      "\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }\n} finally { Pop-Location }";
}

export async function rerunInterrogateFinding(input: {
  options: WorkflowOptions; run: WorkflowRun; stageId: string; finding: string; base: WorkspaceBaseline;
  delta: WorkspaceDelta; api: Api; ctx: Context;
}): Promise<InterrogateRerun> {
  const { options, run, stageId, base, delta, api, ctx } = input;
  const finding = interrogateFinding(run, stageId, input.finding), shell = finding.probe.shell;
  const workspaceFingerprint = await assertInterrogateWorkspace(finding.workspace, ctx.abortSignal);
  const command = interrogateRerunCommand(finding);
  const memoKey = "pstack-interrogate-rerun-input";
  const value = { finding: finding.id, command, shell, workspaceFingerprint,
    source: checkWorkspaceStamp(delta, await verificationCheckout(base, ctx.abortSignal)) };
  const intent = await api.memo<typeof value>(memoKey, ctx) ?? await api.memo(memoKey, value, ctx);
  if (intent.finding !== finding.id || intent.command !== command || intent.shell !== shell ||
      intent.workspaceFingerprint !== workspaceFingerprint || intent.source.fingerprint !== delta.fingerprint)
    throw new Error("Interrogate source or probe changed since the durable rerun began.");
  const result = await api.executeTool(shell, { command }, ctx, { key: "pstack-interrogate-rerun", progress: true });
  await assertInterrogateWorkspace(finding.workspace, ctx.abortSignal);
  const after = await measureWorkspace(base, runSettings(run).thermos.fileLines, ctx.abortSignal);
  const receipt = pstackCheckReceipt({ taskId: options.taskId, conversationId: Number(api.conversationId), workflowRun: run.run,
    operationTaskId: Number(api.taskId), shell, command: finding.probe.command, measurement: false, before: intent.source,
    after: checkWorkspaceStamp(after, await verificationCheckout(base, ctx.abortSignal)), result });
  const native = matchingNativeExecutionReceipt(result, { taskId: options.taskId, conversationId: Number(api.conversationId),
    toolTaskId: Number(result.taskId), toolName: shell });
  const settled = !!native && native.transport === "returned" && native.settlement === "consumed" &&
    native.status !== "inconclusive" && native.exitCode === receipt.exitCode && receipt.unchanged &&
    receipt.outcome !== "tool_error" && (native.status === "passed") === (receipt.exitCode === 0) &&
    Boolean(result.isError) === (receipt.exitCode !== 0);
  const output = (result.structuredOutput as { output?: unknown } | undefined)?.output;
  const verdict = !settled || receipt.emptySuite ? "inconclusive" : receipt.passed ? "not-reproduced" :
    receipt.exitCode === finding.probe.exitCode && receipt.exitCode !== null && receipt.exitCode > 0 && receipt.exitCode < 126 &&
      typeof output === "string" && output.includes(finding.actual) ? "reproduced" : "inconclusive";
  return { finding: finding.id, stageId: panel(run, stageId).stageId, sourceFingerprint: after.fingerprint,
    workspaceFingerprint, receipt, verdict };
}

export async function interrogateJudgment(run: WorkflowRun, stageId: string, sourceFingerprint: string, signal?: AbortSignal) {
  const { receipt, stageId: owningStage } = panel(run, stageId);
  for (const reviewer of receipt.reviewers) await assertInterrogateWorkspace(reviewer.workspace, signal);
  const judgments = interrogateFindings(receipt).map(finding => {
    const rerun = run.interrogateReruns?.filter(item => item.finding === finding.id && item.stageId === owningStage).at(-1);
    if (!rerun || rerun.sourceFingerprint !== sourceFingerprint || rerun.workspaceFingerprint !== finding.workspace.fingerprint ||
        rerun.receipt.checkIdentity.workflowRun !== run.run)
      throw new Error("Rerun every candidate against the current source with verify(finding): " + finding.id);
    return { id: finding.id, title: finding.title, expected: finding.expected, originalOutput: finding.actual,
      command: finding.probe.command, cwd: finding.workspace.cwd, verdict: rerun.verdict, actual: rerun.receipt.output,
      exitCode: rerun.receipt.exitCode, toolTaskId: rerun.receipt.toolTaskId };
  });
  return { confirmed: judgments.filter(item => item.verdict === "reproduced"),
    excluded: judgments.filter(item => item.verdict !== "reproduced"),
    coverage: receipt.reviewers.map(item => ({ childId: item.childId, coverage: item.coverage, probes: item.probes.length })) };
}

/** Completion rechecks the latest review for every owning stage, including
 * direct playbook roles and invoked methods. Old prose-only receipts cannot
 * substitute for this version's native probes. */
export async function allInterrogateJudgments(run: WorkflowRun, sourceFingerprint: string, signal?: AbortSignal) {
  const stages = new Set(run.delegates.filter(item => item.role === "interrogate-reviewers" || item.interrogate).map(item => item.stageId));
  if (run.playbook === "skill:interrogate") stages.add("panel");
  for (const invoked of run.invoked ?? []) if (invoked.skill === "interrogate") stages.add(invoked.stage + "::interrogate::panel");
  const results: Array<{ stageId: string } & Awaited<ReturnType<typeof interrogateJudgment>>> = [];
  for (const stageId of stages) results.push({ stageId, ...await interrogateJudgment(run, stageId, sourceFingerprint, signal) });
  return results;
}
