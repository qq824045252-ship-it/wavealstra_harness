import { z } from "zod";
import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type { Context } from "@earendil-works/chord/context";
import type { Cursor, TaskId } from "@earendil-works/pi-durable";
import type { Api, DelegateReceipt, WorkflowRun } from "./PstackState";
import { DurableSubagentIdentity } from "../durable/DurableSubagentIdentity";
import { isUnitOwnerDispatch } from "./PstackOrchestrationBoard";
import { readPlanFile } from "./PstackWorkspace";
import type { WorkspaceDelta } from "./PstackWorkspace";
import { parseEveryExpr } from "../../cron/CronSchedule";
import { chooseForge, originCommand, OriginReader } from "./watch/origin";

export async function inspectPrBody(cwd: string, name: string | undefined, target: number) {
  const file = await readPlanFile(cwd, name ?? "pr.md");
  if (!file.text.trim() || /[\u0000-\u0008\u000e-\u001f\ufffd]/u.test(file.text)) throw new Error("The PR briefing must contain readable text.");
  const lines = file.text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").length;
  if (lines > target) throw new Error(`The PR briefing ${file.path} has ${lines} lines. Shorten it to the configured ${target} lines and link longer supporting evidence.`);
  return { path: file.path, digest: file.digest, lines, target };
}

const exec = promisify(execFile);
const githubPr = z.object({ number: z.number().int().positive(), url: z.string().url(), state: z.enum(["OPEN", "MERGED", "CLOSED"]), isDraft: z.boolean(),
  headRefOid: z.string().regex(/^[a-f\d]{40}(?:[a-f\d]{24})?$/), headRefName: z.string().min(1), baseRefName: z.string().min(1), title: z.string().min(1), body: z.string() });
export async function inspectPublishedPr(cwd: string, url: string | undefined, body: Awaited<ReturnType<typeof inspectPrBody>>, forge: unknown, signal?: AbortSignal) {
  const github = url?.match(/^https:\/\/github\.com\/([a-z\d][a-z\d-]*\/[\w.-]+)\/pull\/([1-9]\d*)$/i);
  const origin = url?.match(/^https:\/\/cursor\.com\/codebase\/([a-z\d][\w.-]*\/[a-z\d][\w.-]*)\/pull\/([1-9]\d*)$/i);
  if (!url || !(github || origin))
    throw new Error("Supply the published GitHub or Cursor Origin pullRequest URL, or block if publication is outside the user's scope or no writable remote exists.");
  const read = originCommand(signal);
  const binding = await chooseForge(forge === "auto" && origin ? "origin" : forge, (origin ?? github)![1], read, cwd, signal);
  if ((origin ? "origin" : "github") !== binding.forge) throw new Error("Supply the published PR URL for the selected source-of-truth forge (" + binding.forge + ").");
  const opts = { cwd: dirname(process.execPath), windowsHide: true, signal, timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" } };
  const remote = async () => {
    if (origin) {
      const pr = await new OriginReader(read, binding.repository).pull(Number(origin[2]));
      return { url: pr.webUrl, state: pr.merged ? "MERGED" : pr.state.toUpperCase(), isDraft: pr.draft,
        headRefOid: pr.head.sha, headRefName: pr.head.ref, baseRefName: pr.base.ref, title: pr.title, body: pr.body };
    }
    const data = await exec("gh", ["pr", "view", url, "--json", Object.keys(githubPr.shape).join(",")], opts);
    return githubPr.parse(JSON.parse(data.stdout));
  };
  const [pr, local, briefing] = await Promise.all([remote(),
    exec("git", ["--no-optional-locks", "-C", cwd, "rev-parse", "--verify", "HEAD"], opts), readPlanFile(cwd, body.path)]);
  const clean = (value: string) => value.replace(/\r\n?/g, "\n").trimEnd();
  if (pr.url.toLowerCase() !== url.toLowerCase() || pr.isDraft || pr.state === "CLOSED" || pr.headRefOid !== local.stdout.trim()
    || clean(pr.body) !== clean(briefing.text) || body.digest !== briefing.digest)
    throw new Error(binding.forge + " did not confirm the submitted URL, ready state, current local HEAD and reviewed briefing together.");
  return { forge: binding.forge, url: pr.url, state: pr.state, title: pr.title, head: pr.headRefOid, headRef: pr.headRefName, base: pr.baseRefName, body: body.digest };
}

export const isAutopilot = (book: string) => book === "autopilot-full" || book === "autopilot-stack";
export const isOwnerArtifactTool = (name: string) => /^(write|edit|apply_patch|pstack_decision_append|register_artifact)$/.test(name);
export type OwnerReport = { owner: string; started: number; firstReportDue: number; firstReport: number;
  kind: string; late: boolean };
const worker = z.object({ subagentId: z.string(), messages: z.array(z.object({
  role: z.string(), timestamp: z.number().optional(), toolName: z.string().optional(), isError: z.boolean().optional(),
  stopReason: z.string().optional(), content: z.unknown().optional(),
})) });
export function ownerReports(raw: unknown, started: number, returned: number, minutes: number): OwnerReport[] {
  return z.object({ results: z.array(worker) }).parse(raw).results.map(child => {
    const time = (stamp: number | undefined) => stamp !== undefined && stamp >= started && stamp <= returned;
    const first = child.messages.find(message => message.role === "user" && time(message.timestamp))?.timestamp ?? started;
    const evidence = child.messages.filter(message => message.role === "toolResult" && !message.isError && time(message.timestamp) && message.timestamp! >= first
      && isOwnerArtifactTool(message.toolName ?? ""))
      .sort((a, b) => a.timestamp! - b.timestamp!)[0];
    // Each child can return well before the slowest member of a parallel batch.
    const answer = child.messages.find(m => m.role === "assistant" && ["stop", "length"].includes(m.stopReason ?? "") &&
      time(m.timestamp) && m.timestamp! >= first && Array.isArray(m.content) && m.content.some(p => p?.type === "text" && p.text?.trim()));
    const firstReport = evidence?.timestamp ?? answer?.timestamp ?? returned, firstReportDue = first + minutes * 60_000;
    return { owner: child.subagentId, started: first, firstReportDue, firstReport, kind: evidence?.toolName ?? "returned-report", late: firstReport > firstReportDue };
  });
}

export function auditSchedule(run: Pick<WorkflowRun, "run" | "playbook">, minutes: number) {
  return { name: `pstack ${run.playbook} audit #${run.run}`, schedule_type: "every", schedule_expr: minutes + "m", target: "current-task",
    prompt: `Read pstack_workflow status. Only if workflow run ${run.run} is still running, call pstack_workflow(action="audit") and inspect changed owner artifacts, local verification receipts and outstanding blockers. Stop this audit schedule at completion.` };
}

export function verifiedAuditSchedule(raw: unknown, id: string, expected: ReturnType<typeof auditSchedule>) {
  const found = z.object({ status: z.literal("scheduled"), job: z.object({ id: z.literal(id), enabled: z.literal(true),
    sourceTaskId: z.string().min(1), target: z.object({ kind: z.literal("task"), taskId: z.string().min(1) }),
    scheduleType: z.literal("every"), scheduleExpr: z.string(), prompt: z.string(), nextRunAt: z.number().positive() }) }).safeParse(raw);
  if (!found.success || found.data.job.target.taskId !== found.data.job.sourceTaskId || !found.data.job.prompt.includes(expected.prompt)
    || parseEveryExpr(found.data.job.scheduleExpr) !== parseEveryExpr(expected.schedule_expr))
    throw new Error("The scheduler did not confirm an active current-task audit with this run's instructions and interval. " + JSON.stringify(expected));
  return { id, nextRunAt: found.data.job.nextRunAt };
}
async function inspectAuditSchedule(api: Api, ctx: Context, id: string, expected: ReturnType<typeof auditSchedule>) {
  const read = await api.executeTool("automation_exec", { action: "get", id }, ctx, { key: "read-audit-schedule" });
  if (read.isError) throw new Error("The audit schedule could not be read for this task.");
  return { ...verifiedAuditSchedule(read.details, id, expected), toolTaskId: Number(read.taskId) };
}

async function readOwnerReports(api: Api, ctx: Context, run: WorkflowRun, receipt: DelegateReceipt, minutes: number): Promise<OwnerReport[]> {
  if (receipt.ownerReports?.length === receipt.children.length && receipt.children.every(id => receipt.ownerReports?.some(r => r.owner === id)))
    return receipt.ownerReports;
  // A resumed run can retain the dispatch receipt without its timing summary.
  // Only the original dispatch's actual child conversations can supply that evidence.
  return api.commit(async tx => {
    const taskId = receipt.toolTaskId as TaskId;
    const dispatch = await tx.task(taskId);
    if (receipt.stageId !== "owners" && (!dispatch?.owner || !await isUnitOwnerDispatch(tx, api, run, dispatch.owner))) return [];
    if (dispatch?.conversationId !== api.conversationId || dispatch.state.status !== "terminal" ||
      dispatch.state.outcome.status !== "completed" || dispatch.startedAt === undefined || dispatch.endedAt === undefined)
      throw new Error("Missing completed owner dispatch " + taskId);
    const reports: OwnerReport[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await tx.scanConversations({ ownerTaskId: taskId }, 100, cursor);
      for (const child of page.items) {
        const identity = (await tx.doc(DurableSubagentIdentity, child.id)).value;
        if (identity?.parentConversationId !== api.conversationId || !receipt.children.includes(identity.item.id)) continue;
        let entries: Cursor | undefined;
        const messages: z.infer<typeof worker>["messages"] = [];
        do {
          const batch = await tx.scanEntries({ conversationId: child.id, order: "ascending" }, 100, entries);
          for (const entry of batch.items) for (const message of entry.model ?? []) {
            if (message.timestamp < dispatch.startedAt || message.timestamp > dispatch.endedAt) continue;
            if ((message.role === "user" && !messages.length) ||
              (message.role === "toolResult" && !message.isError && isOwnerArtifactTool(message.toolName)) ||
              (message.role === "assistant" && ["stop", "length"].includes(message.stopReason) && message.content.some(c => c.type === "text" && c.text.trim())))
              messages.push(message);
          }
          entries = batch.next;
        } while (entries && !messages.some(m => m.role === "toolResult"));
        if (!messages.some(m => m.role !== "user")) throw new Error("Missing stored work or final report from owner " + identity.item.id);
        reports.push(...ownerReports({ results: [{ subagentId: identity.item.id, messages }] }, dispatch.startedAt, dispatch.endedAt, minutes));
      }
      cursor = page.next;
    } while (cursor);
    if (!receipt.children.length || reports.length !== receipt.children.length || !receipt.children.every(id => reports.some(r => r.owner === id)))
      throw new Error("Missing original owner conversations for dispatch " + taskId);
    return reports;
  }, ctx);
}

export async function inspectOwnerAudit(api: Api, ctx: Context, run: WorkflowRun, delta: WorkspaceDelta, minutes: number, firstReportMinutes: number, scheduleId?: string) {
  if (!isAutopilot(run.playbook)) throw new Error("Owner audits require autopilot-stack or autopilot-full.");
  const owners: OwnerReport[] = [];
  for (const receipt of run.delegates.filter(r => r.role === "swarm-workers"))
    owners.push(...await readOwnerReports(api, ctx, run, receipt, firstReportMinutes));
  if (!owners.length) throw new Error("Dispatch the owners and obtain their stored reports before the first audit.");
  if (!delta.coverageComplete) throw new Error("Cannot audit an incompletely observed workspace: " + delta.unknown.join(", "));
  const id = scheduleId ?? run.audit?.schedule?.id;
  const schedule = id ? await inspectAuditSchedule(api, ctx, id, auditSchedule(run, minutes)) : null;
  const observedAt = await api.memo("audit-observed-at", api.now(), ctx);
  return { observedAt, nextDue: observedAt + minutes * 60_000, schedule,
    fingerprint: delta.fingerprint, changed: run.audit ? run.audit.fingerprint !== delta.fingerprint : null,
    paths: delta.paths, overdueOwners: owners.filter(report => report.late).map(report => report.owner) };
}
