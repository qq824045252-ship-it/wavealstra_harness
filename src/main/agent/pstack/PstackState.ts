import { defineDoc, LiveDoc, type Cursor, type EntryId, type EntryRecord, type HookApi, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { PSTACK_PLAYBOOKS, PSTACK_SKILLS, THERMOS_CRITERIA, normalizePstackSettings, resolvePstackRole, type PstackPlaybook, type PstackStage, type PstackSettings } from "../../../shared/pstack";
import type { WorkspaceBaseline, WorkspaceDelta } from "./PstackWorkspace";
import { readOnlyCodingTag, type CodingTag } from "../../../shared/pstack/coding-tags";
import { auditSchedule, isAutopilot, type inspectPublishedPr, type OwnerReport } from "./PstackDelivery";
import type { BuildHistory } from "./watch/builds";
import type { OwnerAuditTick } from "./PstackOwnerMonitor";
import { MERGE_REVIEW_BLOCK, reviewIntent } from "./PstackReviewIntent";
import type { ReviewInspection } from "./PstackReviewEvidence";
import type { ThermosMember } from "./PstackThermosVerdict";
import type { ProviderDependency } from "./PstackProviderFailure";
import type { Contest, ContestAudit } from "./PstackContest";
import type { EvalExport } from "./PstackEvalExport";
import type { PstackCheckReceipt, VerificationOutcome } from "./PstackVerificationEvidence";
import { nativeExecutionSucceeded } from "../../../shared/native-execution-receipt";
import { PSTACK_UPSTREAM } from "../../../shared/pstack/upstream";
import { promptPstackMethod, type ReframeSource } from "./PstackPromptEvidence";
import type { PstackInterrogateReceipt } from "./PstackInterrogateEvidence";
import type { AdvancedArtifactReceipt } from "./PstackAdvancedArtifacts";

export type Api = Parameters<ToolRegistration["execute"]>[1];
export type WorkflowOptions = { taskId: string; cwd: string; tag?: CodingTag | null; active: () => boolean; settings: () => PstackSettings;
  githubAvailable?: () => boolean; worktreeActivity?: () => import("./PstackWorktreeAudit").WorktreeTask[] };
export const REVIEW = "thermo-nuclear-code-quality-review";
export type DelegateReceipt = { role: string; stage: number; stageId: string; toolTaskId: number; children: string[]; models: string[]; answers: string[]; ownerReports?: OwnerReport[]; ownerAudit?: OwnerAuditTick; participants?: ContestAudit[]; interrogate?: PstackInterrogateReceipt };
export type WorkflowRun = {
  task: string; run: number; first: EntryId; inputs: number[]; revision: number; playbook: string; config: string;
  tagId?: string;
  phase: "running" | "blocked" | "complete"; stage: number; block: string; notes: string[]; operations: number[];
  verification: { command: string; fingerprint: string; toolTaskId: number; passed: boolean; exitCode?: number | null;
    outcome?: VerificationOutcome["outcome"]; error?: string; changedPaths?: string[]; checkIdentity?: PstackCheckReceipt["checkIdentity"] } | null;
  checkReceipts?: PstackCheckReceipt[];
  advanced?: AdvancedArtifactReceipt[];
  reframe?: { stageId: string; sources: ReframeSource[] }[];
  interrogateReruns?: { finding: string; stageId: string; sourceFingerprint: string; workspaceFingerprint: string;
    receipt: PstackCheckReceipt; verdict: "reproduced" | "not-reproduced" | "inconclusive" }[];
  red?: { command: string; fingerprint: string; toolTaskId: number; exitCode: number };
  reviewCommit?: string;
  reviewDependency?: ProviderDependency;
  dispatchDependency?: ProviderDependency;
  thermosOutcome?: string;
  review: { fingerprint: string; passed: boolean; receipt: DelegateReceipt; inspections?: ReviewInspection[]; reasons?: string[]; error?: string;
    members?: Pick<ThermosMember, "passed" | "error">[]; repairs?: number; inputs?: number[]; verificationKey?: string; checkoutSha?: string | null; answerDraft?: string } | null;
  delegates: DelegateReceipt[];
  contests?: Record<string, Contest>;
  evalExport?: EvalExport;
  invoked?: { stage: string; skill: string }[];
  attention?: { digest: string; models: string[]; flags: string[]; toolTaskId: number };
  plan?: { path: string; digest: string };
  prBody?: { path: string; digest: string; lines: number; target: number };
  publishedPr?: Awaited<ReturnType<typeof inspectPublishedPr>>;
  audit?: { observedAt: number; nextDue: number; fingerprint: string; changed: boolean | null; paths: string[]; overdueOwners: string[];
    schedule: { id: string; nextRunAt: number; toolTaskId: number } | null };
  watch?: { stage: number; toolTaskId: number; repository: string; prs: number[]; verdict: string; observedAt: string; allowed: boolean; mergedSnapshot?: boolean };
  builds?: BuildHistory[];
};
/** Document drafts are ephemeral Pi overlays. Only detach JSON while their transaction is live. */
export function detached(run: WorkflowRun): WorkflowRun { return JSON.parse(JSON.stringify(run)) as WorkflowRun; }
export const WorkflowState = defineDoc({ kind: "mybuddy.pstack-run", version: 1, scope: "conversation", history: "rewindable", fork: "initial",
  checkpointWhen: () => true, initial: (): { run: WorkflowRun | null } => ({ run: null }) });
export const WorkflowFiles = defineDoc({ kind: "mybuddy.pstack-baseline", version: 1, scope: "conversation", history: "rewindable", fork: "initial",
  checkpointWhen: () => true, initial: (): { base: WorkspaceBaseline | null } => ({ base: null }) });
export const runSettings = (run: WorkflowRun) => normalizePstackSettings(JSON.parse(run.config));
function route(id: string): PstackPlaybook {
  if (id.startsWith("skill:")) {
    const skill = PSTACK_SKILLS.find(s => "skill:" + s.id === id);
    if (!skill) throw new Error("Unavailable skill: " + id);
    return { ...skill, id, stages: skill.stages ?? [
      { id: "apply", label: skill.label, instructions: skill.instructions, skillIds: [skill.id] },
    ] };
  }
  const book = PSTACK_PLAYBOOKS.find(item => item.id === id);
  if (!book) throw new Error("This playbook is unavailable: " + id);
  return book;
}
export function playbookFor(run: Pick<WorkflowRun, "playbook" | "invoked" | "tagId">): PstackPlaybook {
  let book = route(run.playbook);
  if (book.id === "skill:architect" && readOnlyCodingTag(run.tagId))
    book = { ...book, stages: book.stages.filter(stage => ["ground", "sketch", "synthesize"].includes(stage.id)) };
  if (!run.invoked?.length) return book;
  return { ...book, stages: book.stages.flatMap(stage => [
    ...run.invoked!.filter(entry => entry.stage === stage.id).flatMap(entry => route("skill:" + entry.skill).stages.map(substage =>
      ({ ...substage, id: [stage.id, entry.skill, substage.id].join("::"), skillIds: [...new Set([entry.skill, ...substage.skillIds])] }))),
    stage,
  ]) };
}
export function stageRole(settings: PstackSettings, stage: PstackStage) {
  if (!stage.roleId) return;
  const owners = PSTACK_SKILLS.filter(s => stage.skillIds.includes(s.id) && s.roleIds.includes(stage.roleId!));
  return !owners.length || owners.some(s => settings.skills[s.id]?.enabled) ? stage.roleId : undefined;
}
export const routeSettings = (settings: PstackSettings, id: string) =>
  id.startsWith("skill:") ? settings.skills[id.slice("skill:".length)] : settings.playbooks[id];

export async function state(api: Api | HookApi, ctx: Context) {
  return (await api.snapshot(WorkflowState, api.conversationId, ctx))?.run ?? null;
}
export async function live(api: Api | HookApi, ctx: Context) { return (await api.snapshot(LiveDoc, api.conversationId, ctx))?.run; }
export const success = (value: unknown) => ({ output: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
export const failure = (error: unknown) => ({ ...success((error as Error).message || String(error)), isError: true });
export function checked(options: WorkflowOptions, ctx: Context) {
  ctx.abortSignal?.throwIfAborted();
  if (!options.active()) throw new Error("Pstack is disabled for this task.");
}
export async function owner(api: Api, ctx: Context) {
  if (!await api.commit(async tx => {
    const conversation = await tx.conversation(api.conversationId);
    return conversation && !conversation.owner;
  }, ctx)) throw new Error("Pstack orchestration is available only in the owning conversation.");
}
export async function update(options: WorkflowOptions, previous: WorkflowRun, api: Api, ctx: Context, mutate: (run: WorkflowRun, tx: Tx) => void | Promise<void>) {
  return api.commit(async tx => {
    const doc = await tx.doc(WorkflowState, api.conversationId);
    checked(options, ctx);
    const run = doc.run;
    if (!run || run.task !== options.taskId || run.run !== previous.run) throw new Error("Workflow identity changed; read status.");
    if (run.operations.includes(api.taskId)) return detached(run);
    if (run.revision !== previous.revision) throw new Error("Workflow changed during execution; read status and retry.");
    await mutate(run, tx);
    run.operations.push(api.taskId);
    run.revision++;
    return detached(run);
  }, ctx);
}
export async function transcript(api: Api | HookApi, ctx: Context, first: EntryId): Promise<EntryRecord[]> {
  const rows: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const query = { minEntryId: first, order: "ascending" as const };
    const page = "entries" in api ? await api.entries(query, 100, cursor, ctx)
      : await api.commit(tx => tx.scanEntries({ conversationId: api.conversationId, ...query }, 100, cursor), ctx);
    rows.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return rows;
}

export function observation(entries: EntryRecord[]) {
  return entries.flatMap(entry => entry.kind === "pi.tool-result" && entry.byTaskId !== undefined
    ? (entry.model ?? []).flatMap(message => message.role === "toolResult"
      && /^(?:read|grep|find|ls|workspace_search|project_materials_search|browser_exec|computer_use)$/.test(message.toolName)
      && nativeExecutionSucceeded(message, { conversationId: entry.conversationId, toolTaskId: entry.byTaskId,
        toolName: message.toolName, callId: message.toolCallId })
      ? [{ entry: entry.id, tool: message.toolName }] : []) : []).at(-1);
}
export function reviewReasons(settings: PstackSettings, delta: WorkspaceDelta, entries: EntryRecord[], run?: Pick<WorkflowRun, "playbook">) {
  if (!settings.skills[REVIEW]?.enabled) return [];
  if (run?.playbook === "skill:interrogate") return [];
  if (run && promptPstackMethod(run.playbook) && !delta.paths.length) return [];
  const config = settings.thermos;
  const userText = entries.flatMap(e => e.kind === "pi.user" || e.kind === "mybuddy.user" ? (e.model ?? []).flatMap(m =>
    m.role === "user" ? typeof m.content === "string" ? [m.content] : m.content.flatMap(p => p.type === "text" ? [p.text] : []) : []) : [])
    .filter(text => !text.startsWith("[MyBuddy pstack "));
  const request = reviewIntent(userText);
  const reasons: string[] = [];
  if (config.onRequest && request.review) reasons.push("user requested review");
  if (config.beforeMerge && (request.merge || entries.some(e => e.byTaskId !== undefined && e.kind === "pi.tool-result" &&
    e.model?.some(m => m.role === "toolResult" && m.isError && ["bash", "powershell", "terminal_exec"].includes(m.toolName) &&
      m.content.some(c => c.type === "text" && c.text.includes("[error] Tool call blocked: " + MERGE_REVIEW_BLOCK)))))) reasons.push("pre-merge review");
  if (run?.playbook === "skill:" + REVIEW) reasons.push("Thermos review selected for this workflow");
  if (delta.changedLines > config.changedLines) reasons.push("changed lines exceed " + config.changedLines);
  if (delta.largestCrossing) reasons.push("file crossed " + config.fileLines + " lines");
  if (delta.addedBranches >= config.specialCases && delta.addedBranches > 0) reasons.push("possible new special cases: " + delta.addedBranches);
  if (delta.unknown.length) reasons.push("workspace measurement needs manual inspection");
  return reasons;
}
export const criteria = (settings: PstackSettings) => THERMOS_CRITERIA.filter(item => settings.thermos.criteria[item.id]);

/** A standalone review reports substantiated defects; implementation and answer-review gates still require a passing verdict. */
export const reportOnlyReview = (run: Pick<WorkflowRun, "playbook" | "tagId">) =>
  run.playbook === "skill:" + REVIEW || run.tagId === "code-review";

function parameterGuidance(definition: Pick<PstackPlaybook, "parameters">) {
  return definition.parameters.length ? {
    parameterGuidance: Object.fromEntries(definition.parameters.map(p => [p.id, p.label + "。" + p.description])),
  } : {};
}

export function skillView(settings: PstackSettings, id: string) {
  const definition = PSTACK_SKILLS.find(item => item.id === id);
  if (!definition || !settings.skills[id]?.enabled) throw new Error("Unavailable skill: " + id);
  return { ...definition, parameters: settings.skills[id].parameters, ...parameterGuidance(definition),
    roles: Object.fromEntries(definition.roleIds.map(role => [role, resolvePstackRole(settings, role)])) };
}
export function view(run: WorkflowRun) {
  const settings = runSettings(run), book = playbookFor(run), stage = book.stages[run.stage];
  const review = run.review && { passed: run.review.passed, fingerprint: run.review.fingerprint, receipt: run.review.receipt,
    inspections: run.review.inspections, reasons: run.review.reasons, error: run.review.error, repairs: run.review.repairs };
  return { playbook: book.id, upstream: PSTACK_UPSTREAM, run: run.run, phase: run.phase, revision: run.revision, block: run.block || undefined,
    ...(isAutopilot(book.id) && { audit: run.audit, auditSchedule: auditSchedule(run, Number(settings.playbooks[book.id].parameters.auditMinutes)) }),
    ...(run.prBody && { prBody: run.prBody }), ...(run.evalExport && {evalExport:run.evalExport}),
    ...(run.publishedPr && { publishedPr: run.publishedPr }),
    ...(run.reframe?.length && { reframe: run.reframe }),
    ...(run.advanced?.length && { artifacts: run.advanced }),
    ...(run.interrogateReruns?.length && { interrogateReruns: run.interrogateReruns }),
    parameters: routeSettings(settings, book.id).parameters, ...parameterGuidance(book), steps: book.stages.map(s => s.id), completed: run.notes,
    current: stage && { ...stage, roleId: stageRole(settings, stage), skills: stage.skillIds.filter(id => settings.skills[id]?.enabled).map(id => skillView(settings, id)),
      role: stageRole(settings, stage) && resolvePstackRole(settings, stage.roleId!) }, verification: run.verification, red: run.red,
    review, reviewDependency: run.reviewDependency, dispatchDependency: run.dispatchDependency, thermosOutcome: run.thermosOutcome, reviewBase: run.reviewCommit ?? "task start", watch: run.watch, plan: run.plan, attention: run.attention,
    delegates: run.delegates.map(({ answers: _answers, ...receipt }) => receipt) };
}
