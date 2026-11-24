import { createHash } from "node:crypto";
import { z } from "zod";
import { getFinalOutput } from "../../capabilities/subagent/shared";
import { matchingNativeExecutionReceipt } from "../../../shared/native-execution-receipt";
import { captureInterrogateWorkspace, type PstackInterrogateWorkspace } from "./PstackInterrogateWorkspace";
export { assertInterrogateWorkspace, type PstackInterrogateWorkspace } from "./PstackInterrogateWorkspace";

export const INTERROGATE_ADVERSARY_ROLE = "pstack-interrogate-adversary";
export const INTERROGATE_EXECUTION_BRIEF = [
  "Interrogate is an execution-backed adversarial review. Work only in the isolated cwd assigned by the host. Read the applicable repository instructions and the actual source, then run focused tests or reproduction probes against that source.",
  "Do not fix, edit, delete or commit existing source. You may create new reproduction files in your own worktree and must leave them available for the host's rerun. Preserve the original checkout. Do not modify the parent workspace, publish, contact external services, install globally or delegate further.",
  "Every reviewer must execute at least one real native bash/powershell probe, even when no bugs are found. Missing tools, setup or isolation is a concrete coverage gap; it is not a successful zero-finding review. Preserve the failing assertion's exit status. A finding must fail with a nonzero exit code; if a program exits zero with incorrect behavior, write an assertion that tests the expected behavior.",
  'Finish with one JSON object: {"coverage":"What the executed probes covered and what remains untested","probes":[{"toolCallId":"your actual native tool-call id","shell":"bash or powershell","command":"exact command you executed"}],"findings":[{"title":"specific behavior violated","toolCallId":"matching probe call id","shell":"bash or powershell","command":"same exact command","expected":"expected behavior","actual":"nonempty exact excerpt from that probe output","exitCode":1}]}. Include only executed probes and findings proven by their actual output. findings may be empty; probes may not. The host supplies stable finding IDs and independently reruns the original commands before reporting confirmed defects.',
].join("\n");

type EvidenceMessage = { role: string; toolName?: string; toolCallId?: string; isError?: boolean; details?: unknown;
  content: { type: string; text?: string; id?: string; name?: string; arguments?: Record<string, unknown> }[] };
export type InterrogateChild = { subagentId: string; nativeConversationId: number; messages: EvidenceMessage[];
  workspace?: { cwd: string; kind?: string; baseCommit?: string } };
export type PstackInterrogateProbe = {
  id: string; shell: "bash" | "powershell"; command: string; toolCallId: string; toolTaskId: number;
  executionId: string; exitCode: number; output: string; truncated: boolean;
};
export type PstackInterrogateFinding = {
  id: string; title: string; expected: string; actual: string; childId: string; conversationId: number;
  workspace: PstackInterrogateWorkspace; probe: PstackInterrogateProbe;
};
export type PstackInterrogateReceipt = { reviewers: {
  childId: string; conversationId: number; coverage: string; workspace: PstackInterrogateWorkspace;
  probes: PstackInterrogateProbe[]; findings: PstackInterrogateFinding[];
}[] };

const probeSchema = z.object({ toolCallId: z.string().min(1), shell: z.enum(["bash", "powershell"]), command: z.string().min(1) }).strict();
const verdictSchema = z.object({ coverage: z.string().trim().min(1), probes: z.array(probeSchema).min(1).max(24),
  findings: z.array(probeSchema.extend({ title: z.string().trim().min(1), expected: z.string().trim().min(1),
    actual: z.string().trim().min(1), exitCode: z.number().int().refine(code => code !== 0) }).strict()).max(40) }).strict();
const stableId = (kind: string, value: unknown) => "interrogate-" + kind + "-" + createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);

/** Pair actual child calls with host-issued native results. Prose or a JSON
 * claim alone cannot manufacture an execution receipt. */
export function observedInterrogateProbes(child: InterrogateChild, taskId: string): PstackInterrogateProbe[] {
  const calls = new Map<string, { shell: "bash" | "powershell"; command: string }>(), probes: PstackInterrogateProbe[] = [];
  const used = new Set<string>();
  for (const message of child.messages) {
    if (message.role === "assistant") for (const part of message.content) {
      if (part.type === "toolCall" && part.id && (part.name === "bash" || part.name === "powershell") && typeof part.arguments?.command === "string") {
        if (calls.has(part.id) || used.has(part.id)) throw Error("Interrogate returned duplicate native tool-call identities.");
        calls.set(part.id, { shell: part.name, command: part.arguments.command });
      }
    }
    if (message.role !== "toolResult" || !message.toolCallId) continue;
    const call = calls.get(message.toolCallId);
    calls.delete(message.toolCallId);
    if (!call || message.toolName !== call.shell) continue;
    used.add(message.toolCallId);
    const receipt = matchingNativeExecutionReceipt(message, { taskId, conversationId: child.nativeConversationId,
      toolName: call.shell, callId: message.toolCallId });
    if (!receipt || receipt.transport !== "returned" || receipt.settlement !== "consumed" || receipt.status === "inconclusive" ||
      receipt.exitCode === undefined || (receipt.status === "passed") !== (receipt.exitCode === 0) ||
      Boolean(message.isError) !== (receipt.exitCode !== 0)) continue;
    const raw = message.content.flatMap(part => part.type === "text" && part.text ? [part.text] : []).join("\n");
    const output = raw.length > 96_000 ? raw.slice(0, 48_000) + "\n[…]\n" + raw.slice(-48_000) : raw;
    probes.push({ id: stableId("probe", [child.subagentId, receipt.conversationId, receipt.toolTaskId, receipt.callId]),
      shell: call.shell, command: call.command, toolCallId: receipt.callId, toolTaskId: receipt.toolTaskId,
      executionId: receipt.executionId, exitCode: receipt.exitCode, output, truncated: output !== raw });
  }
  return probes;
}

export async function collectInterrogateEvidence(children: readonly InterrogateChild[], sourceCwd: string, taskId: string,
  signal?: AbortSignal): Promise<PstackInterrogateReceipt> {
  const reviewers: PstackInterrogateReceipt["reviewers"] = [];
  for (const child of children) {
    signal?.throwIfAborted();
    let verdict: z.infer<typeof verdictSchema>;
    try { verdict = verdictSchema.parse(JSON.parse(getFinalOutput(child.messages).trim().replace(/^`{3}(?:json)?\s*/i, "").replace(/\s*`{3}$/, ""))); }
    catch (error) { throw Error("Interrogate reviewer must return coverage, actual native probes and evidence-bound findings: " + child.subagentId, { cause: error }); }
    const observed = observedInterrogateProbes(child, taskId);
    const probes = verdict.probes.map(claim => {
      const probe = observed.find(probe => probe.toolCallId === claim.toolCallId && probe.shell === claim.shell && probe.command === claim.command);
      if (!probe) throw Error("Interrogate probe has no matching settled native execution: " + claim.toolCallId);
      return probe;
    });
    if (new Set(probes.map(probe => probe.id)).size !== probes.length) throw Error("Interrogate repeats the same probe receipt.");
    const workspace = await captureInterrogateWorkspace(child.workspace, sourceCwd, signal);
    const findings = verdict.findings.map(claim => {
      const probe = probes.find(probe => probe.toolCallId === claim.toolCallId && probe.shell === claim.shell && probe.command === claim.command);
      if (!probe || !probe.exitCode || probe.exitCode !== claim.exitCode || !probe.output.includes(claim.actual))
        throw Error("Interrogate finding does not match a real failing probe and its actual output: " + claim.title);
      const { title, expected, actual } = claim;
      return { id: stableId("finding", [child.subagentId, probe.id, title, expected, actual]), title, expected, actual,
        childId: child.subagentId, conversationId: child.nativeConversationId, workspace, probe };
    });
    if (new Set(findings.map(finding => finding.id)).size !== findings.length) throw Error("Interrogate repeats the same finding.");
    reviewers.push({ childId: child.subagentId, conversationId: child.nativeConversationId, coverage: verdict.coverage, workspace, probes, findings });
  }
  if (!reviewers.length) throw Error("Interrogate requires at least one completed reviewer with an actual probe.");
  return { reviewers };
}

export const interrogateFindings = (receipt: PstackInterrogateReceipt): PstackInterrogateFinding[] =>
  receipt.reviewers.flatMap(reviewer => reviewer.findings);
