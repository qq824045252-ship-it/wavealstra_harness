import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { createPstackWorkflowHooks, textMessage } from "./PstackWorkflowHooks";
import { authoredFiles } from "./PstackAuthoredSkills";
import { Type } from "typebox";
import { dirname, relative, resolve, sep } from "node:path";
import { PSTACK_PLAYBOOKS, PSTACK_SKILLS, normalizePstackSettings, validatePstackPlan } from "../../../shared/pstack";
import { createPstackDelegate } from "./PstackDelegate";
import { isPstackObservation } from "./PstackObservationCommand";
import { contestStep, prepareContestAdvance } from "./PstackContest";
import { checkEvalExport, createEvalSave, exportEval, requestedEvalFiles } from "./PstackEvalExport";
import { checked, criteria, detached, failure, live, observation, owner, playbookFor, reviewReasons, routeSettings, runSettings, skillView, stageRole, state, success,
  transcript, update, view, WorkflowFiles, WorkflowState, type WorkflowOptions, type WorkflowRun } from "./PstackState";
import { baselineWorkspace, branchReviewBase, measureWorkspace, readPlanFile, reviewCommit, reviewScope } from "./PstackWorkspace";
import { appendPstackDecision, auditPstackDecisions, createPstackDecisionAppend, decisionParameters, hasPstackDecisions } from "./PstackDecisionTrail";
import { decisionDigest } from "./PstackAttention";
import { createPstackWatchTool } from "./watch";
import { inspectOwnerAudit, inspectPrBody, inspectPublishedPr, isAutopilot } from "./PstackDelivery";
import { recordedOwnerAudits } from "./PstackOwnerMonitor";
import { createPstackOrchestrationTools, orchestrationProgress } from "./PstackOrchestration";

const actions = ["status", "start", "advance", "review", "complete", "block", "resume", "skill", "invoke", "verify", "decision", "decision-audit", "audit", "pr-body", "export-eval"] as const;
const parameters = Type.Object({
  action: Type.Union(actions.map(value => Type.Literal(value))),
  playbook: Type.Optional(Type.String()), stage: Type.Optional(Type.String()), skill: Type.Optional(Type.String()),
  note: Type.Optional(Type.String({ maxLength: 4000 })), command: Type.Optional(Type.String({ maxLength: 1800 })),
  artifact: Type.Optional(Type.String({ description: "Workspace path to the multi-phase plan, or the actual PR body at opening-a-pr describe (default pr.md)." })),
  scheduleId: Type.Optional(Type.String({ minLength: 1, description: "At an autopilot audit, optionally attach the authorized current-task automation that uses the auditSchedule returned by status." })),
  pullRequest: Type.Optional(Type.String({ minLength: 1, maxLength: 1024, description: "The actual published PR URL for opening-a-pr open and confirm. Do not publish without authorization." })),
  baseRef: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Review existing Git changes relative to this ref. The host freezes the commit." })),
  criteria: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1500 }), { description: "Private, frozen eval/arena rubric at the initial stage." })),
  ratingScale: Type.Optional(Type.Object({min:Type.Integer(),max:Type.Integer()},{description:"Override the configured integer scoring range for this comparison when freezing its criteria."})),
  artifactDirectory: Type.Optional(Type.String({minLength:1,description:"To save eval results, select a workspace directory, or '.' for the workspace root. The host exports rubric.json and Document-N.md exactly as seen by the judge."})),
  prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 12000, description: "The one ordinary user request delivered identically to every eval author." })),
  materials: Type.Optional(Type.Array(Type.Array(Type.Union([Type.String({ minLength: 1 }), Type.Object({path:Type.String({minLength:1}),name:Type.String({minLength:1})})])), { description: "At eval isolate, one shared list of workspace files or one list per author. Use a path string for only its filename, or {path,name} for a project-relative name. Each author sees only the selected documents." })),
  replace: Type.Optional(Type.Boolean({ description: "A later user input changed the objective. Start a fresh run and retain the earlier evidence in history." })),
  decision: Type.Optional(decisionParameters),
  shell: Type.Optional(Type.Union([Type.Literal("bash"), Type.Literal("powershell")])),
});

/** A single ordinary check invocation. A shell expression that only prints a
 * result or masks the child process' exit cannot supply verification. */
export function isPstackCheck(command: string, custom: unknown = "") {
  if (!/^[\p{L}\p{N}_@./:\\=,+ "'-]+$/u.test(command)) return false;
  if (/^(?:echo|printf|write-(?:output|host)|exit|true|rem|cmd|bash|powershell|pwsh)(?:\s|$)/i.test(command)) return false;
  if (typeof custom === "string" && custom.split(/\r?\n/).some(line => line.trim() === command)) return true;
  const script = /^(?:node|bun|python3?|py)\s+(?:"([^"]+)"|'([^']+)'|([^\s"']+))$/i.exec(command);
  if (script) {
    const path = script[1] ?? script[2] ?? script[3] ?? "";
    if (/^[\w./\\-]+\.(?:[cm]?js|py)$/i.test(path) && !path.startsWith("-") &&
      /(?:^|[./\\_-])(?:check|checks|test|tests|verify|validate)(?:[./\\_-]|$)/i.test(path)) return true;
  }
  return /^(?:(?:pnpm|yarn|npm|bun)\s+(?:(?:run|-s|--silent)\s+)*(?:test|check|typecheck|lint|verify|build)(?:\b|:)|(?:node|bun)\s+--test\b|(?:python3?|py)\s+-m\s+(?:unittest|pytest|mypy)\b|(?:pytest|vitest|jest|tsc|eslint|ruff)\b|go\s+(?:test|vet)\b|cargo\s+(?:test|check|clippy)\b|dotnet\s+test\b|(?:mvn|mvnw|gradle|gradlew)\s+(?:test|check|verify)\b|ctest\b|git\s+diff\s+--check\b)/i.test(command)
    && !/(?:^|\s)(?:--help|-h|--version|-v(?:ersion)?|--list(?:Tests)?|--collect-only|--no-run|--passWithNoTests|--if-present|--dry-run)(?:\s|$)/i.test(command);
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function createPstackWorkflow(options: WorkflowOptions) {
  const workflow: ToolRegistration = defineTool({
    name: "pstack_workflow", replay: "safe", executionMode: "sequential",
    description: "Host-owned pstack workflow. status lists routes or shows current phase. start with playbook or skill before changing files. skill displays instructions. invoke(skill) runs a configured supporting method within the current stage and then returns to it. advance(stage,note) records a stage outcome. verify(shell,command) runs a focused check and records the exit code and workspace version. review shows Thermos triggers and reviewer role. decision appends to the configured TSV. complete checks current evidence; multi-phase-plan also requires artifact. For a real dependency use block(note), then resume on a later input.",
    parameters,
    async execute(args, api, ctx) {
      try {
        checked(options, ctx); await owner(api, ctx);
        const { action, note } = args;
        const current = await state(api, ctx), run = current?.task === options.taskId ? current : null;
        const settings = run && run.phase !== "complete" && !(action === "start" && args.replace) ? runSettings(run) : normalizePstackSettings(options.settings());
        if (action === "skill") return success(skillView(settings, args.skill ?? ""));
        if (action === "status") return success(run ? { ...view(run), ...(isAutopilot(run.playbook) && { ownerAuditHistory: await recordedOwnerAudits(api, ctx, run.run) }) } : {
          phase: "idle", preferredPlaybook: settings.skills["poteto-mode"]?.parameters.preferredPlaybook,
          playbooks: PSTACK_PLAYBOOKS.filter(s => settings.playbooks[s.id]?.enabled).map(({ id, description }) => ({ id, description })),
          skills: PSTACK_SKILLS.filter(s => settings.skills[s.id]?.enabled).map(({ id }) => id),
        });
        const active = await live(api, ctx);
        if (!active?.first || !active.inputs.length) throw new Error("Workflow requires a current user input.");
        if (run?.operations.includes(api.taskId)) return success(view(run));
        if (action === "start") {
          const preferred = settings.skills["poteto-mode"]?.parameters.preferredPlaybook;
          const requested = args.skill ? "skill:" + args.skill : args.playbook ?? (typeof preferred === "string" && preferred !== "auto" ? preferred : "");
          if (run && run.phase !== "complete" && !args.replace) {
            if (requested !== run.playbook) throw new Error("A workflow is already active. Finish it or resume its current stage.");
            return success(view(run));
          }
          if (run?.inputs.some(id => active.inputs.includes(id as typeof active.inputs[number]))) throw new Error("This input already completed its workflow.");
          if (args.replace && !note?.trim()) throw new Error("Record the change in the user's requested objective in note.");
          const book = playbookFor({ playbook: requested });
          if (!routeSettings(settings, book.id)?.enabled) throw new Error("Select an enabled playbook or skill from status.");
          const base = await baselineWorkspace(options.cwd, ctx.abortSignal);
          let reviewBase: string | undefined;
          if (args.baseRef) reviewBase = await reviewCommit(base, args.baseRef, ctx.abortSignal);
          else if (["skill:thermo-nuclear-code-quality-review", "skill:interrogate","skill:no-comments"].includes(book.id)) {
            const preferredBase = routeSettings(settings, book.id).parameters.baseRef;
            if (base.head) reviewBase = await branchReviewBase(base, typeof preferredBase === "string" ? preferredBase.trim() : "", ctx.abortSignal);
          }
          const started: WorkflowRun = { task: options.taskId, run: api.taskId, first: active.first, inputs: [...active.inputs],
            revision: 1, operations: [api.taskId], playbook: book.id, config: JSON.stringify(settings), phase: "running",
            block: "", stage: 0, notes: [], verification: null, review: null, delegates: [],
            ...(reviewBase !== undefined && { reviewCommit: reviewBase }) };
          const result = await api.commit(async tx => {
            const doc = await tx.doc(WorkflowState, api.conversationId), files = await tx.doc(WorkflowFiles, api.conversationId);
            checked(options, ctx);
            if (doc.run?.run === started.run) return detached(doc.run);
            if ((doc.run?.run ?? null) !== (current?.run ?? null) || doc.run?.revision !== current?.revision) throw new Error("Another workflow started; read status.");
            doc.run = started; files.base = base;
            return started;
          }, ctx);
          return success(view(result));
        }
        if (!run) throw new Error("No workflow. Call start with an enabled playbook.");
        const save = (change: (next: WorkflowRun) => void) => update(options, run, api, ctx, next => {
          for (const input of active.inputs) if (!next.inputs.includes(input)) next.inputs.push(input);
          change(next);
        });
        if (action === "export-eval") {
          const report=await exportEval(options,run,args.artifactDirectory ?? run.contests?.eval?.directory ?? ".",api,ctx);
          return success(view(await save(next=>{next.evalExport=report;})));
        }
        if (action === "resume") {
          if (run.phase !== "blocked") throw new Error("Only a blocked workflow can resume.");
          const dependency = run.dispatchDependency ?? run.reviewDependency;
          if (dependency && !active.inputs.some(id => !dependency.inputs.includes(id)))
            throw new Error(run.block + "\n待服务恢复后可在新消息中继续。");
          if (run.block.startsWith("架构确认点")) {
            if (!active.inputs.some(id => !run.inputs.includes(id))) throw new Error("等待用户在新的输入中确认架构。");
            const inputs = (await transcript(api, ctx, active.first)).filter(e => e.kind === "pi.user" || e.kind === "mybuddy.user")
              .flatMap(e => (e.model ?? []).flatMap(m => m.role === "user" ? [textMessage(m.content)] : []));
            if (!inputs.some(text => /^(?:确认|同意|批准|可以实施|继续实施|go ahead|approve(?:d)?|yes)(?:[，,。.!！\s]|$)/i.test(text.trim())))
              throw new Error("架构方案仍需用户明确批准。可以回复“确认”后继续。");
          }
          return success(view(await save(next => { next.phase = "running"; next.block = ""; delete next.reviewDependency; delete next.dispatchDependency; })));
        }
        if (run.phase !== "running") throw new Error("Workflow is " + run.phase + ". Read status.");
        if (action === "pr-body") {
          if (run.playbook !== "opening-a-pr") throw new Error("PR briefings belong to opening-a-pr.");
          const body = await inspectPrBody(options.cwd, args.artifact ?? run.prBody?.path, Number(settings.playbooks[run.playbook].parameters.bodyLines));
          return success(view(await save(next => { next.prBody = body; })));
        }
        if (action === "decision" || action === "decision-audit") {
          if (!settings.skills["show-me-your-work"]?.enabled) throw new Error("Decision trail is disabled in this workflow.");
          if (action === "decision-audit") return success(await auditPstackDecisions(options, run, api, ctx));
          if (!args.decision) throw new Error("Supply decision fields phase, decision, why, evidence and result.");
          return success(await appendPstackDecision(options, run, args.decision, api, ctx));
        }
        if (action === "block") {
          if (!note?.trim()) throw new Error("Explain which decision or external dependency is needed.");
          return success(view(await save(next => { next.phase = "blocked"; next.block = note.trim(); })));
        }
        const stage = playbookFor(run).stages[run.stage];
        const [, nestedSkill, nestedStep] = stage?.id.split("::") ?? [];
        const method = nestedSkill ?? (run.playbook.startsWith("skill:") ? run.playbook.slice(6) : undefined);
        const stepId = nestedStep ?? stage?.id;
        if (action === "invoke") {
          if (stage && run.playbook === "eval" && ["candidates", "judge"].includes(stage.id) && args.skill === "arena")
            throw new Error("This stage already executes Arena through pstack_delegate using the frozen blind assignment. Dispatch its assigned role directly.");
          if (!stage || nestedSkill || !args.skill || args.skill === method || !stage.skillIds.includes(args.skill) || !settings.skills[args.skill]?.enabled)
            throw new Error("Choose an enabled supporting skill listed on the current parent stage.");
          const selected = args.skill;
          if (run.invoked?.some(entry => entry.stage === stage.id && entry.skill === selected))
            throw new Error("This supporting method was already executed in this stage.");
          return success(view(await save(next => { next.invoked = [...next.invoked ?? [], { stage: stage.id, skill: selected }]; })));
        }
        if (action === "advance") {
          if (!stage || stage.id !== args.stage || !note?.trim()) throw new Error("Pass the current stage ID and its concrete outcome.");
          const prBody = run.playbook === "opening-a-pr" && stage.id === "describe"
            ? await inspectPrBody(options.cwd, args.artifact ?? run.prBody?.path, Number(settings.playbooks[run.playbook].parameters.bodyLines)) : undefined;
          if (run.playbook === "opening-a-pr" && ["open", "confirm"].includes(stage.id) && !run.prBody)
            throw new Error("Inspect the actual briefing with pr-body before validating publication.");
          const published = run.playbook === "opening-a-pr" && ["open", "confirm"].includes(stage.id) && run.prBody
            ? await inspectPublishedPr(options.cwd, args.pullRequest ?? run.publishedPr?.url, run.prBody, settings.playbooks[run.playbook].parameters.forge, ctx.abortSignal) : undefined;
          if (isAutopilot(run.playbook) && stage.id === "audit" && (!run.audit || api.now() >= run.audit.nextDue))
            throw new Error("Call pstack_workflow(action=audit) to inspect current owner reports and workspace changes. For an authorized recurring audit, pass the verified scheduleId.");
          const role = stageRole(settings, stage);
          const contest = await prepareContestAdvance(run, settings, options.cwd, stage.id, args);
          let exported: WorkflowRun["evalExport"];
          if (run.playbook === "eval" && stage.id === "audit") {
            const inputs=(await transcript(api,ctx,run.first)).filter(e=>e.kind==="pi.user" || e.kind==="mybuddy.user")
              .flatMap(e=>(e.model ?? []).flatMap(m=>m.role==="user"?[textMessage(m.content)]:[]));
            const directory=args.artifactDirectory ?? run.contests?.eval?.directory ?? (inputs.some(requestedEvalFiles) ? "." : undefined);
            if (directory!==undefined && !run.evalExport) exported=await exportEval(options,run,directory,api,ctx);
            else if (run.evalExport) await checkEvalExport(options.cwd,run.evalExport);
          }
          if (contest && stage.roleId && !role) throw new Error("This comparison requires the Arena method enabled on the workflow settings.");
          if (role && !run.delegates.some(item => item.role === role && (item.stageId === stage.id || (!contest && item.stageId?.startsWith(stage.id + "::")))))
            throw new Error("This stage needs a completed pstack_delegate receipt for " + role);
          if (run.playbook === "authoring-a-skill" && stage.id === "assess") {
            const history = await transcript(api, ctx, run.first);
            if (!history.some(e => e.kind === "pi.tool-result" && e.byTaskId !== undefined && e.model?.some(m =>
              m.role === "toolResult" && m.toolName === "skill_authoring_assess" && !m.isError)))
              throw new Error("Call skill_authoring_assess and follow the returned create, reuse, improve-existing, or no-skill decision before advancing.");
          }
          if (run.playbook === "worktree-cleanup" && stage.id === "inventory") {
            const entries = await transcript(api, ctx, run.first);
            if (!entries.some(e => e.byTaskId !== undefined && e.kind === "pi.tool-result" && e.model?.some(m => m.role === "toolResult" && m.toolName === "pstack_worktrees" && !m.isError)))
              throw new Error("Run the read-only pstack_worktrees inventory before advancing.");
          }
          if ((run.playbook === "babysit" || run.playbook === "shipping") && stage.id === "watch"
            && !(run.watch?.stage === run.stage && run.watch.allowed))
            throw new Error("Check the current PR or queue with pstack_watch_pr before advancing.");
          if (method === "tdd" && stepId === "red" && !run.red)
            throw new Error("Record a failing behavioral check with verify, then state why its failure is expected.");
          if (method === "tdd" && stepId === "green" && (!run.red || !run.verification?.passed ||
            run.red.command !== run.verification.command || run.red.fingerprint === run.verification.fingerprint))
            throw new Error("Rerun the original failed command against the changed workspace and obtain exit code zero.");
          const checkpoint = settings.skills.architect?.enabled && settings.skills.architect.parameters.checkpoint === true
            && (method === "architect" ? stepId === "synthesize" : stage.skillIds.includes("architect") && stage.id === "design"
              && !run.invoked?.some(entry => entry.stage === stage.id && entry.skill === "architect"));
          return success(view(await save(next => {
            if (contest) next.contests = { ...next.contests, [contestStep(run.playbook, stage.id)!.key]: contest };
            if (exported) next.evalExport=exported;
            next.notes.push(note.trim()); next.stage++;
            if (prBody) next.prBody = prBody;
            if (published) next.publishedPr = published;
            if (checkpoint) { next.phase = "blocked"; next.block = "架构确认点。请确认以下方案后再实施。\n" + note.trim(); }
          })));
        }
        const base = (await api.snapshot(WorkflowFiles, api.conversationId, ctx))?.base;
        if (!base) throw new Error("Missing workspace baseline.");
        const scoped = await authoredFiles(api,ctx,run);
        const delta = await measureWorkspace(base, settings.thermos.fileLines, ctx.abortSignal,scoped);
        if (action === "audit") {
          const timing = settings.playbooks[run.playbook]?.parameters;
          const receipt = await inspectOwnerAudit(api, ctx, run, delta, Number(timing?.auditMinutes), Number(timing?.firstReportMinutes), args.scheduleId);
          return success(view(await save(next => { next.audit = receipt; })));
        }
        if (action === "verify") {
          const command = args.command?.trim() ?? "";
          const measurement = await isPstackObservation(run.playbook, command, options.cwd);
          if (!args.shell || (!measurement && !isPstackCheck(command, settings.skills["poteto-mode"]?.parameters.verificationCommands)))
            throw new Error("Run one check from the current task directory, e.g. node --test check.cjs. Omit cd and shell chains. Additional project commands can be saved in poteto-mode settings.");
          checked(options, ctx);
          const result = await api.executeTool(args.shell, { command }, ctx, { key: "pstack-verification", progress: true });
          const receipt = result.structuredOutput;
          const exitCode = object(receipt) && typeof receipt.exitCode === "number" ? receipt.exitCode : null;
          const output = object(receipt) && typeof receipt.output === "string" ? receipt.output : "";
          const counts = [...output.matchAll(/^\s*(?:ℹ|#)?\s*tests\s+(\d+)\s*$|\b(?:ran|collected)\s+(\d+)\s+(?:tests?|items?)\b/gim)]
            .map(match => Number(match[1] ?? match[2]));
          const emptySuite = counts.length ? counts.every(total => total === 0) : /\bno tests (?:were |have been )?(?:found|collected|run)\b/i.test(output);
          const after = await measureWorkspace(base, settings.thermos.fileLines, ctx.abortSignal,await authoredFiles(api,ctx,run));
          const unchanged = delta.fingerprint === after.fingerprint;
          const silentMeasurement = measurement && !output.trim();
          const passed = !result.isError && exitCode === 0 && unchanged && !emptySuite && !silentMeasurement;
          await save(next => {
            next.verification = { command, passed, toolTaskId: result.taskId, fingerprint: after.fingerprint };
            if (method === "tdd" && stepId === "red" && unchanged && !emptySuite && exitCode !== null && exitCode > 0 && exitCode < 126)
              next.red = { command, toolTaskId: result.taskId, fingerprint: after.fingerprint, exitCode };
          });
          const evidence = { passed, command, exitCode, unchanged, fingerprint: after.fingerprint, ...(silentMeasurement && { error: "The observed program returned no output." }), ...(emptySuite && { error: "The test runner executed zero tests. Select the project's actual check." }),
            toolTaskId: result.taskId, output: receipt ?? result.diagnostics };
          return { ...success(evidence), isError: !passed };
        }
        const history = await transcript(api, ctx, run.first);
        const scope = reviewScope(base, run.reviewCommit);
        const reviewedDelta = scope === base ? delta : await measureWorkspace(scope, settings.thermos.fileLines, ctx.abortSignal,scoped);
        const reasons = reviewReasons(settings, reviewedDelta, history, run);
        const reviewed = !!run.review?.passed && run.review.fingerprint === reviewedDelta.fingerprint
          && (run.playbook !== "investigation" || !!run.review.answerDraft);
        if (action === "review") return success({ reasons, reviewBase: run.reviewCommit ?? "task start", reviewerRole: settings.thermos.reviewerRole,
          currentReviewPassed: reviewed, criteria: criteria(settings), authoredSkills:scoped.map(f=>({file:f.path,sha256:f.current.digest})), ...reviewedDelta });
        const snapshotDone = run.watch?.allowed && ["STATUS", "ORIGIN_STATUS"].includes(run.watch.verdict) && !delta.paths.length &&
          (run.watch.mergedSnapshot || (run.playbook === "babysit" && settings.playbooks.babysit.parameters.mode === "check"));
        if (stage && !snapshotDone) throw new Error("Complete the current stage: " + stage.id);
        if (run.evalExport) await checkEvalExport(options.cwd,run.evalExport);
        if (run.playbook === "opening-a-pr") {
          const current = await inspectPrBody(base.cwd, run.prBody?.path, Number(settings.playbooks[run.playbook].parameters.bodyLines));
          if (current.digest !== run.prBody?.digest) throw new Error("The PR body changed after its review. Call pr-body(artifact) to inspect its current content before claiming publication.");
          await inspectPublishedPr(base.cwd, args.pullRequest ?? run.publishedPr?.url, current, settings.playbooks[run.playbook].parameters.forge, ctx.abortSignal);
        }
        if (run.playbook === "investigation" && delta.paths.length)
          throw new Error("The read-only investigation changed the workspace: " + delta.paths.join(", ") + ". Reconcile the changes before claiming completion.");
        if (run.playbook === "orchestrate") {
          const missing = await orchestrationProgress(api, ctx, run);
          if (missing) throw new Error(missing);
        }
        if (!delta.coverageComplete || !reviewedDelta.coverageComplete) throw new Error("The workspace could not be fully fingerprinted. Resolve unreadable paths or start a task with a narrower workspace. " + reviewedDelta.unknown.slice(0, 3).join(", "));
        if (reasons.length && !reviewed) throw new Error("Independent Thermos review required: " + reasons.join(", "));
        let planReceipt: WorkflowRun["plan"];
        if (run.playbook === "multi-phase-plan") {
          const planPath = settings.playbooks["multi-phase-plan"].parameters.planPath;
          const plan = await readPlanFile(base.cwd, args.artifact, typeof planPath === "string" ? planPath : undefined);
          const issues = validatePstackPlan(plan.text, settings);
          if (issues.length) throw new Error("Plan validation failed:\n" + issues.join("\n"));
          planReceipt = { path: plan.path, digest: plan.digest };
        }
        let auditedTrail = "";
        if (run.playbook === "skill:show-me-your-work" || await hasPstackDecisions(run, api, ctx)) {
          const audit = await auditPstackDecisions(options, run, api, ctx);
          if (!audit.rows.length || run.attention?.digest !== decisionDigest(audit.rows))
            throw new Error("Decision trail needs logged rows and fresh cross-model pstack_delegate(purpose=decisions,role=judgment) evidence.");
          auditedTrail = relative(base.cwd, resolve(base.cwd, audit.path)).split(sep).join("/");
        }
        const authored = scoped.filter(f=>f.current.digest!==f.before.digest);
        if (authored.length) {
          const { SkillAuthoringService } = await import("../../skills/SkillAuthoringService");
          const validator = new SkillAuthoringService();
          for (const f of authored) {
            const check=validator.validateSkillPackage(dirname(f.path));
            if (!check.valid) throw new Error("Installed skill validation failed for " + f.path + ": " + check.errors.join(", "));
          }
        }
        if (delta.paths.some(path => path !== planReceipt?.path && path !== auditedTrail && !authored.some(f=>f.path===path)) || delta.unknown.length) {
          if (!run.verification?.passed || run.verification.fingerprint !== delta.fingerprint)
            throw new Error("Current workspace needs a successful verification. Call verify with the project's focused check.");
        } else if (!planReceipt && !auditedTrail && !authored.length && !observation(history) && !run.verification?.passed && !run.delegates.length && !reviewed && !run.watch?.allowed) {
          throw new Error("No successful workspace observation, verification or worker receipt in this workflow.");
        }
        if ((await measureWorkspace(base, settings.thermos.fileLines, ctx.abortSignal,await authoredFiles(api,ctx,run))).fingerprint !== delta.fingerprint)
          throw new Error("Workspace changed while evaluating the completion gate; inspect the latest version.");
        const thermosOutcome = reasons.length ? "Thermos 审查通过（" + reasons.join("，") + "）。"
          : !settings.skills["thermo-nuclear-code-quality-review"]?.enabled ? "Thermos 未触发（任务设置已关闭质量审查）。"
          : "Thermos 未触发（变更 " + reviewedDelta.changedLines + " 行，未满足本任务启用的审查条件）。";
        return success(view(await save(next => { next.phase = "complete"; next.thermosOutcome = thermosOutcome; if (planReceipt) next.plan = planReceipt;
          if (stage && snapshotDone) { next.notes.push("PR snapshot: " + next.watch!.repository + " #" + next.watch!.prs.join(", #") + " at " + next.watch!.observedAt); next.stage = playbookFor(next).stages.length; }
        })));
      } catch (error) { ctx.abortSignal?.throwIfAborted(); return failure(error); }
    },
  });

  return { tools: [workflow, createPstackDelegate(options), createPstackDecisionAppend(options), createPstackWatchTool(options), createEvalSave(options),
    ...createPstackOrchestrationTools(options)], ...createPstackWorkflowHooks(options) };
}
