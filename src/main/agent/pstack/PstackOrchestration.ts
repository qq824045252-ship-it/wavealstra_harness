import { defineTool, type HookApi, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { auditPstackWorktrees, gitHubCheckout } from "./PstackWorktreeAudit";
import { dirname } from "node:path";
import { checked, failure, live, owner, runSettings, state, success, WorkflowFiles, WorkflowState, type Api, type WorkflowOptions, type WorkflowRun } from "./PstackState";
import { durableSourceUserMessageId } from "../durable/DurableInputProvenance";
import { measureWorkspace, verificationCheckout } from "./PstackWorkspace";
import { latestCheck, passedCurrentCheck } from "./PstackVerificationEvidence";
import { authoredFiles } from "./PstackAuthoredSkills";
import { boardDoc, empty, type Board, type Unit } from "./PstackOrchestrationBoard";
import { recordGoalNativeEvidence as recordPstackGoalEvidence } from "../durable/DurableGoalNativeEvidence";

const exec = promisify(execFile);
const text = Type.String({ minLength: 1, maxLength: 3000 });
const key = Type.String({ minLength: 1, maxLength: 80 });
const actions = ["status", "unit", "dispatch", "verify", "check", "inbox", "drain", "gate", "answer", "standing", "frontier"] as const;
const params = Type.Object({
  action: StringEnum(actions), id: Type.Optional(key), track: Type.Optional(key),
  brief: Type.Optional(text), dependencies: Type.Optional(Type.Array(key, { maxItems: 100, uniqueItems: true })),
  role: Type.Optional(key), note: Type.Optional(text), branch: Type.Optional(key), pr: Type.Optional(Type.Integer({ minimum: 1 })),
  sha: Type.Optional(Type.String({ pattern: "^[0-9a-f]{40}(?:[0-9a-f]{24})?$" })),
  order: Type.Optional(Type.Array(key, { maxItems: 1000, uniqueItems: true })),
});
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Publish the failed unit receipt and block the workflow in one transaction.
 * Only the nested delegate belonging to the current unit may settle it. */
export async function recordBlockedUnit(tx: Tx, api: Api, run: WorkflowRun, reason: string) {
  if (!["orchestrate", "autopilot-full", "autopilot-stack"].includes(run.playbook)) return false;
  const dispatch = (await tx.task(api.taskId))?.owner;
  if (!dispatch) return false;
  const board = (await tx.doc(boardDoc, api.conversationId)).board;
  if (!board || board.run !== run.run) return false;
  const unit = board.units.find(item => item.dispatch === dispatch && item.status === "running");
  if (!unit) return false;
  unit.status = "failed";
  unit.receipt = api.taskId;
  unit.lastError = reason;
  unit.providerFailures = (unit.providerFailures ?? 0) + 1;
  board.inbox.push({ id: unit.id, dispatch: unit.receipt, status: unit.status, note: reason });
  board.operations.push(dispatch);
  await recordPstackGoalEvidence(tx, api, { kind: "unit", unitId: unit.id, state: "failed", boardRun: run.run, reason }, dispatch);
  return true;
}

export async function orchestrationProgress(api: Pick<HookApi, "snapshot" | "conversationId">, ctx: Context, run: WorkflowRun) {
  const board = (await api.snapshot(boardDoc, api.conversationId, ctx))?.board;
  if (!board || board.run !== run.run || !board.units.length) return "Use pstack_orchestrate to register the planned work units.";
  if (board.units.some(unit => unit.status !== "verified") || board.gates.some(gate => !gate.answer) || board.inbox.length)
    return "Orchestration has unverified units, pending receipts, or open decisions. Read pstack_orchestrate status.";
  return undefined;
}

function unitFor(board: Board, id?: string) {
  const unit = board.units.find(item => item.id === id);
  if (!unit) throw new Error("Unknown orchestration unit: " + (id ?? ""));
  return unit;
}
function editBoard(board: Board, args: Static<typeof params>, input: number, answerFromUser: boolean) {
  if (args.action === "unit") {
    if (!args.id || !args.brief) throw new Error("Supply a stable unit ID and its brief.");
    const existing = board.units.find(u => u.id === args.id);
    if (existing) {
      if (existing.brief !== args.brief || existing.track !== (args.track ?? "") || JSON.stringify(existing.dependencies) !== JSON.stringify(args.dependencies ?? []))
        throw new Error("Unit ID already has a different brief, track or dependencies.");
      return existing;
    }
    for (const id of args.dependencies ?? []) unitFor(board, id);
    const unit: Unit = { id: args.id, track: args.track ?? "", brief: args.brief, dependencies: args.dependencies ?? [], status: "pending",
      attempts: 0, unknownFailures: 0, dispatch: 0, receipt: 0, branch: "", pr: 0, sha: "", lastError: "" };
    board.units.push(unit); return unit;
  }
  if (args.action === "gate") {
    if (!args.id || !args.note) throw new Error("Supply the gate ID and the question for the user.");
    const prior = board.gates.find(g => g.id === args.id);
    if (prior && prior.question !== args.note) throw new Error("Gate ID already in use.");
    if (!prior) board.gates.push({ id: args.id, question: args.note, answer: "", input });
    return board.gates;
  }
  if (args.action === "answer") {
    const gate = board.gates.find(g => g.id === args.id);
    if (!gate || !args.note || gate.input >= input || !answerFromUser) throw new Error("This decision needs an answer quoted from a later user input.");
    if (gate.answer && gate.answer !== args.note) throw new Error("Decision already recorded.");
    gate.answer = args.note; return gate;
  }
  if (args.action === "standing") {
    if (!args.note || !answerFromUser) throw new Error("Quote a standing instruction from the current user input.");
    if (!board.standing.includes(args.note)) board.standing.push(args.note);
    return board.standing;
  }
  if (args.action === "frontier") {
    if (!args.order) return { generation: board.generation, order: board.order };
    for (const [index, id] of args.order.entries()) {
      if (unitFor(board, id).dependencies.some(dep => !args.order!.slice(0, index).includes(dep))) throw new Error("Order dependencies before their dependants.");
    }
    if (JSON.stringify(board.order) !== JSON.stringify(args.order)) { board.order = args.order; board.generation++; }
    return { generation: board.generation, order: board.order };
  }
  throw new Error("Unsupported orchestration action");
}

export function createPstackOrchestrationTools(options: WorkflowOptions): ToolRegistration[] {
  const orchestration = defineTool({ name: "pstack_orchestrate", replay: "safe", executionMode: "sequential", parameters: params,
    description: "For orchestrate/autopilot runs manage persistent units, dependencies, decision gates, standing user instructions, dependency order, child receipts and verification. unit(id,brief,dependencies?) registers work. dispatch(id,role) runs its actual configured workers. verify(id,pr?,sha?) binds the latest successful native project check to the unit. check looks up that revision, inbox/drain consumes child notifications. status lists unfinished units. No remote writes.",
    async execute(args, api, ctx) {
      try {
        checked(options, ctx); await owner(api, ctx);
        const run = await state(api, ctx);
        if (!run || run.task !== options.taskId || !["orchestrate", "autopilot-full", "autopilot-stack"].includes(run.playbook)) throw new Error("Select an orchestration playbook first.");
        const previous = (await api.snapshot(boardDoc, api.conversationId, ctx))?.board;
        const board = previous?.run === run.run ? previous : empty(run.run);
        if (args.action === "status") return success(board);
        if (args.action === "inbox") return success(board.inbox);
        if (args.action === "check") return success(board.checks.filter(row => row.id === args.id && (!args.sha || args.sha === row.sha) && (!args.pr || row.pr === args.pr)));
        if (args.action === "verify" && board.operations.includes(api.taskId))
          return success(board.checks.find(row => row.acceptanceTaskId === api.taskId) ?? { replayed: true });
        if (args.action === "dispatch" && board.operations.includes(api.taskId)) {
          const receipt = unitFor(board, args.id);
          return { ...success(receipt), isError: receipt.status === "failed" };
        }
        if (run.phase !== "running") throw new Error("Resume the workflow before changing the board.");
        const change = (mutate: (draft: Board, tx: Tx) => unknown | Promise<unknown>, final = true) => api.commit(async tx => {
          checked(options, ctx);
          const active = await tx.doc(WorkflowState, api.conversationId);
          if (active.run?.run !== run.run || active.run.phase !== "running") throw new Error("Workflow changed during execution.");
          if (args.action === "verify" && latestCheck(active.run)?.toolTaskId !== latestCheck(run)?.toolTaskId)
            throw new Error("Verification changed while accepting the unit. Check the latest result before accepting.");
          const doc = await tx.doc(boardDoc, api.conversationId);
          if (doc.board?.run !== run.run) doc.board = empty(run.run);
          if (doc.board.operations.includes(api.taskId)) return args.action === "drain" ? copy(doc.board.drained[String(api.taskId)]) : { replayed: true };
          const result = copy(await mutate(doc.board, tx));
          if (final) doc.board.operations.push(api.taskId);
          return result;
        }, ctx);
        if (args.action === "dispatch") {
          if (!args.role) throw new Error("Choose a configured worker role.");
          const original = unitFor(board, args.id);
          const config = runSettings(run).playbooks[run.playbook].parameters;
          const budget = Number(config.retryLimit ?? 2), unknownBudget = Number(config.unknownFailureRetries ?? budget);
          await change(async (draft, tx) => {
            const unit = unitFor(draft, args.id);
            if (unit.dispatch === api.taskId) return unit;
            if (!["pending", "failed"].includes(unit.status) || unit.attempts - (unit.providerFailures ?? 0) > budget || unit.unknownFailures > unknownBudget) throw new Error("Unit is active, done, or out of retries.");
            if (unit.dependencies.some(id => unitFor(draft, id).status !== "verified")) throw new Error("Unit prerequisites are unverified.");
            unit.status = "running"; unit.attempts++; unit.dispatch = api.taskId;
            await recordPstackGoalEvidence(tx, api, { kind: "unit", unitId: unit.id, state: "running", boardRun: run.run });
            return unit;
          }, false);
          const result = await api.executeTool("pstack_delegate", { role: args.role, tasks: [original.brief] }, ctx, { key: "unit-" + original.id, progress: true });
          if (result.isError) {
            const settled = (await api.snapshot(boardDoc, api.conversationId, ctx))?.board;
            const receipt = settled?.run === run.run && settled.units.find(unit => unit.id === original.id && unit.dispatch === api.taskId && unit.receipt === result.taskId);
            if (receipt) return { ...success(receipt), isError: true };
          }
          const receipt = await change(async (draft, tx) => {
            const unit = unitFor(draft, args.id);
            if (unit.dispatch !== api.taskId) throw new Error("Another dispatch owns the unit.");
            unit.status = result.isError ? "failed" : "returned"; unit.receipt = result.taskId;
            unit.lastError = result.isError ? JSON.stringify(result.structuredOutput ?? result.diagnostics).slice(0, 1600) : "";
            if (result.isError && !/timeout|timedout|unavailable|quota|network|rate.limit|write conflict/i.test(unit.lastError)) unit.unknownFailures++;
            draft.inbox.push({ id: unit.id, dispatch: unit.receipt, status: unit.status, note: unit.lastError });
            await recordPstackGoalEvidence(tx, api, { kind: "unit", unitId: unit.id, state: unit.status, boardRun: run.run,
              ...(unit.lastError ? { reason: unit.lastError } : {}) });
            return unit;
          });
          return { ...success(receipt), isError: result.isError };
        }
        if (args.action === "verify") {
          const evidence = latestCheck(run), base = (await api.snapshot(WorkflowFiles, api.conversationId, ctx))?.base;
          if (!evidence || !base)
            throw new Error("Run a successful project check on the current workspace first.");
          const measure = async () => measureWorkspace(base, runSettings(run).thermos.fileLines, ctx.abortSignal, await authoredFiles(api, ctx, run));
          const current = await measure();
          if (!passedCurrentCheck(evidence, current, await verificationCheckout(base, ctx.abortSignal)))
            throw new Error("Run a successful project check on the current workspace first.");
          const sha = args.sha ?? "";
          let branch = "";
          if ((args.pr || args.branch) && !sha) throw new Error("A branch or PR verification needs the exact checkout SHA.");
          if (sha) {
            if (evidence.checkIdentity?.checkoutSha !== sha) throw new Error("Run the check at the exact checkout SHA before accepting the revision.");
            const localGit = (...args: string[]) => exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", options.cwd, ...args], { windowsHide: true, signal: ctx.abortSignal, timeout: 15_000 });
            if ((await localGit("rev-parse", "HEAD")).stdout.trim() !== sha || (await localGit("status", "--porcelain")).stdout.trim())
              throw new Error("A commit receipt requires a clean checkout at the exact verified SHA.");
            branch = (await localGit("branch", "--show-current")).stdout.trim();
            if (args.pr) {
              const repo = await gitHubCheckout(options.cwd, ctx.abortSignal);
              const head = await exec("gh", ["pr", "view", String(args.pr), "-R", repo, "--json", "headRefOid,headRefName"], {
                cwd: dirname(process.execPath), windowsHide: true, signal: ctx.abortSignal, timeout: 15_000, env: { ...process.env, GH_PROMPT_DISABLED: "1" },
              });
              const remote = JSON.parse(head.stdout) as { headRefOid?: string; headRefName?: string };
              if (remote.headRefOid !== sha) throw new Error("PR head differs from the verified commit.");
              branch = remote.headRefName ?? "";
            }
            if (args.branch && branch !== args.branch) throw new Error("Verified branch differs from the requested branch.");
          }
          if (!passedCurrentCheck(evidence, await measure(), await verificationCheckout(base, ctx.abortSignal)))
            throw new Error("The workspace changed during unit acceptance. Run the check on the current revision.");
          return success(await change(async (draft, tx) => {
            const unit = unitFor(draft, args.id);
            if (unit.status !== "returned" || unit.receipt >= evidence.toolTaskId) throw new Error("Verify this unit after its worker returns.");
            unit.status = "verified"; unit.branch = branch; unit.pr = args.pr ?? 0; unit.sha = sha;
            const checkIdentity = evidence.checkIdentity;
            const row = { id: unit.id, pr: unit.pr, sha, fingerprint: evidence.fingerprint, toolTaskId: evidence.toolTaskId,
              command: evidence.command, acceptanceTaskId: Number(api.taskId), ...(checkIdentity && { checkIdentity }) };
            draft.checks.push(row);
            await recordPstackGoalEvidence(tx, api, { kind: "unit", unitId: unit.id, state: "verified", boardRun: run.run,
              command: row.command, fingerprint: row.fingerprint, ...(sha ? { sha } : {}), ...(branch ? { branch } : {}), ...(unit.pr ? { pr: unit.pr } : {}),
              ...(checkIdentity && { checkIdentity }) });
            return row;
          }));
        }
        if (args.action === "drain") return success(await change(draft => {
          const rows = copy(draft.inbox); draft.inbox = [];
          draft.drained[String(api.taskId)] = rows; return rows;
        }));
        const input = (await live(api, ctx))?.inputs.at(-1);
        const requestId = input && ["answer", "standing"].includes(args.action)
          ? await durableSourceUserMessageId(api, ctx, api.conversationId, [input]) : undefined;
        const fromUser = !!requestId && await api.commit(async tx => {
          const receipt = await tx.submissionByRequest(api.conversationId, requestId);
          const entry = receipt?.entry && await tx.entry(receipt.entry);
          return !!entry && !!entry.model?.some(m => m.role === "user"
            && (typeof m.content === "string" ? m.content : m.content.flatMap(p => p.type === "text" ? p.text : []).join("\n")).includes(args.note ?? ""));
        }, ctx);
        return success(await change(draft => editBoard(draft, args, input ?? 0, fromUser)));
      } catch (error) { ctx.abortSignal?.throwIfAborted(); return failure(error); }
    },
  });
  const worktrees = defineTool({ name: "pstack_worktrees", replay: "safe", parameters: Type.Object({
    baseRef: Type.Optional(key), queryGithub: Type.Optional(Type.Boolean()), sizes: Type.Optional(Type.Boolean()),
  }), description: "Audit the worktree-cleanup playbook's registered Git worktrees, tracked/untracked work, age, local merged history, optional PR status and disk use. Read only.",
  async execute(args, api, ctx) {
    try {
      checked(options, ctx); await owner(api, ctx);
      const run = await state(api, ctx);
      if (!run || run.task !== options.taskId || run.phase !== "running" || run.playbook !== "worktree-cleanup") throw new Error("Start the worktree-cleanup playbook first.");
      const root = String(runSettings(run).playbooks[run.playbook].parameters.targetRoot ?? "");
      const result = await auditPstackWorktrees(options.cwd, { ...args, root, signal: ctx.abortSignal, tasks: options.worktreeActivity?.() });
      checked(options, ctx); return success(result);
    } catch (error) { ctx.abortSignal?.throwIfAborted(); return failure(error); }
  } });
  return [orchestration, worktrees];
}
