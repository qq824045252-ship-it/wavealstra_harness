import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { z } from "zod";
import { getFinalOutput } from "../../capabilities/subagent/shared";
import { preparePstackDispatch } from "../PstackDispatch";
import { auditParticipant, contestDispatch } from "./PstackContest";
import { arenaSubmission, arenaSurvivors } from "./PstackArenaSubmission";
import { resolvePstackRole } from "../../../shared/pstack";
import { checked, criteria, failure, live, owner, playbookFor, REVIEW, reviewReasons, routeSettings, runSettings, skillView, stageRole, state, success, transcript, update, WorkflowFiles, type WorkflowOptions } from "./PstackState";
import { measureWorkspace, reviewBaseline, reviewScope, verificationCheckout } from "./PstackWorkspace";
import { auditPstackDecisions } from "./PstackDecisionTrail";
import { auditTranscript, decisionAuthorsMemo, decisionDigest, independentAttention } from "./PstackAttention";
import { childInspection, reviewTargets, validateInspections, type ReviewInspection } from "./PstackReviewEvidence";
import { isAutopilot, ownerReports } from "./PstackDelivery";
import { monitorOwnerDispatch } from "./PstackOwnerMonitor";
import { parseThermosVerdict, type ThermosMember } from "./PstackThermosVerdict";
import { currentVerificationEvidence, verificationEvidenceKey } from "./PstackVerificationEvidence";
import { authoredFiles } from "./PstackAuthoredSkills";
import { providerFailures, type ProviderDependency } from "./PstackProviderFailure";
import { recordBlockedUnit } from "./PstackOrchestration";
import { isUnitOwnerDispatch } from "./PstackOrchestrationBoard";
export { parseThermosVerdict } from "./PstackThermosVerdict";

const dispatchParticipants = z.object({ results: z.array(z.object({
  subagentId: z.string(), nativeConversationId: z.number().optional(), agent: z.string().optional(),
  displayName: z.string().optional(), status: z.string(), exitCode: z.number(),
  resolvedModel: z.string().optional(), errorMessage: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
  usage: z.object({
    input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(),
    cost: z.number(), contextTokens: z.number(), turns: z.number(),
    reported: z.object({ inputTokens: z.number().nullable(), outputTokens: z.number().nullable(),
      cacheReadTokens: z.number().nullable(), cacheWriteTokens: z.number().nullable().optional(),
      cacheHitRate: z.number().nullable(), requests: z.number().optional() }).optional(),
  }).optional(),
  workspace: z.object({ cwd: z.string() }).optional(),
})) });

const child = z.object({
  subagentId: z.string().min(1), nativeConversationId: z.number().int(), status: z.literal("completed"), exitCode: z.literal(0),
  rejected: z.literal(false).optional(), writeConflicts: z.array(z.string()).max(0).optional(),
  stopReason: z.string().optional(), model: z.string().optional(), resolvedModel: z.string().optional(), workspace: z.object({ cwd: z.string(), kind: z.string().optional(), baseCommit: z.string().optional() }).optional(),
  messages: z.array(z.object({ role: z.string(), model: z.string().optional(), provider: z.string().optional(),
    toolName: z.string().optional(), toolCallId: z.string().optional(), isError: z.boolean().optional(),
    content: z.array(z.object({ type: z.string(), text: z.string().optional(), name: z.string().optional(), id: z.string().optional(),
      arguments: z.record(z.string(), z.unknown()).optional() })) })),
});

export function createPstackDelegate(options: WorkflowOptions): ToolRegistration {
  return defineTool({
    name: "pstack_delegate", executionMode: "sequential", replay: "safe",
    description: "Dispatch the configured role for this stage. Supply one shared task or one task per worker. For Thermos use purpose=thermos and the configured reviewerRole. For investigation, include the complete proposed answer in answerDraft. For a decision trail use purpose=decisions and role=judgment. The host records child IDs, actual models and findings.",
    parameters: Type.Object({ role: Type.String(), tasks: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 200 }),
      purpose: Type.Optional(Type.Union([Type.Literal("stage"), Type.Literal("thermos"), Type.Literal("decisions")])),
      answerDraft: Type.Optional(Type.String({ minLength: 1, maxLength: 24000, description: "Exact user-facing investigation result to review. Revise this text after a substantive finding. The accepted text is delivered to the user." })) }),
    async execute({ role, tasks, purpose, answerDraft }, api, ctx) {
      let details: { participants: z.infer<typeof dispatchParticipants>["results"] } | undefined;
      try {
        checked(options, ctx); await owner(api, ctx);
        const run = await state(api, ctx);
        if (!run || run.task !== options.taskId || run.phase !== "running") throw new Error("Start or resume the workflow first.");
        if (run.operations.includes(api.taskId)) return success("Dispatch already recorded. Read workflow status.");
        const settings = runSettings(run), stage = playbookFor(run).stages[run.stage];
        const thermos = purpose === "thermos";
        const decisions = purpose === "decisions";
        if (thermos && (role !== settings.thermos.reviewerRole || !settings.skills[REVIEW]?.enabled))
          throw new Error("Thermos needs the configured, enabled reviewer role: " + settings.thermos.reviewerRole);
        if (decisions && (role !== "judgment" || !settings.skills["show-me-your-work"]?.enabled)) throw new Error("Decision audit requires the enabled decision trail and the judgment role.");
        if (!thermos && !decisions && (!stage || !Object.hasOwn(settings.roles, role))) throw new Error("No active stage or configured role.");
        if (!thermos && !decisions && run.playbook === "eval" && (stage.id === "candidates" || stage.id === "judge")) {
          const recorded = run.delegates.find(r => r.stageId === stage.id && r.role === role);
          if (recorded) return success({ ...recorded, reused: true,
            next: "This blind comparison already has its sealed result. Use advance to record the outcome, including any author who did not consult the materials." });
        }
        const config = resolvePstackRole(settings, role);
        const base = (await api.snapshot(WorkflowFiles, api.conversationId, ctx))?.base;
        if (!base) throw new Error("Missing workspace baseline.");
        const scope = reviewScope(base, run.reviewCommit);
        const scoped = thermos ? await authoredFiles(api,ctx,run,undefined,true) : [];
        const delta = thermos ? await measureWorkspace(scope, settings.thermos.fileLines, ctx.abortSignal,scoped) : undefined;
        const rubric = criteria(settings);
        const history = delta || decisions ? await transcript(api, ctx, run.first) : [];
        const reasons = delta ? reviewReasons(settings, delta, history, run) : [];
        if (thermos && !reasons.length) return success({ dispatched: false, reasons: [], next: "Thermos is not required. Continue with the active stage." });
        const draft = thermos && run.playbook === "investigation" ? answerDraft?.replace(/\r\n?/g,"\n").trim() : undefined;
        if (thermos && run.playbook === "investigation" && !draft)
          throw new Error("Supply the full proposed answer in answerDraft, including the example and source citations. The investigation stays read-only.");
        const audit = decisions ? await auditPstackDecisions(options, run, api, ctx) : undefined;
        if (audit && !audit.rows.length) throw new Error("There are no recorded decision rows to audit.");
        const authors = audit ? [...new Set([...history.flatMap(e => (e.model ?? []).flatMap(m =>
          m.role === "assistant" && m.model && m.stopReason !== "error" && m.stopReason !== "aborted" ? [m.model] : [])),
          ...run.delegates.filter(d => ["feature","bug-fix","hillclimb","perf-issue","hardest","arena-runners","swarm-workers"].includes(d.role)).flatMap(d => d.models)])] : [];
        if (audit) await api.memo(decisionAuthorsMemo, authors, ctx);
        const userInputs = history.filter(e => e.kind === "pi.user" || e.kind === "mybuddy.user").flatMap(e => (e.model ?? []).flatMap(m => {
          if (m.role !== "user") return [];
          const text = typeof m.content === "string" ? m.content : m.content.flatMap(p => p.type === "text" ? [p.text] : []).join("\n");
          return text.startsWith("[MyBuddy pstack ") ? [] : [{ id: Number(e.id), text: text.slice(0, 5000) }];
        }));
        const userRequests = userInputs.map(i => i.text), inputIds = userInputs.map(i => i.id);
        const baseline = delta && await reviewBaseline(scope, delta.paths, ctx.abortSignal,scoped);
        const panelDiff = run.tagId === "code-review" && !thermos && role === "interrogate-reviewers"
          ? await reviewBaseline(scope, (await measureWorkspace(scope, settings.thermos.fileLines, ctx.abortSignal)).paths, ctx.abortSignal)
          : undefined;
        const targets = delta ? await reviewTargets(base.cwd, delta.paths, userRequests, history) : [];
        const taskVersion = delta && (scope === base ? delta : await measureWorkspace(base, settings.thermos.fileLines, ctx.abortSignal,scoped));
        const checkoutSha = taskVersion ? await verificationCheckout(base, ctx.abortSignal) : undefined;
        const verified = taskVersion?.coverageComplete ? currentVerificationEvidence(run, taskVersion.fingerprint, history, checkoutSha) : [];
        const verificationKey = verificationEvidenceKey(verified);
        const previous = delta && run.review?.fingerprint === delta.fingerprint && run.review.members?.length === config.count && run.review.inspections?.length === config.count &&
          run.review.inputs?.join(",") === inputIds.join(",") && run.review.reasons?.join(",") === reasons.join(",") &&
          run.review.verificationKey === verificationKey && run.review.checkoutSha === (checkoutSha ?? null) &&
          run.review.answerDraft === draft ? run.review : undefined;
        const retained = previous?.members?.map((m, i) => ({ ...m, child: previous.receipt.children[i], model: previous.receipt.models[i],
          answer: previous.receipt.answers[i], inspection: previous.inspections![i] }));
        const slots = retained?.flatMap((m, i) => m.error ? [i] : []);
        if (previous && (!slots?.length || (previous.repairs ?? 0) >= 2)) return {
          ...success({ ...previous.receipt, passed: previous.passed, inspections: previous.inspections, error: previous.error,
            next: previous.passed ? "Already reviewed." : draft ? "Revise answerDraft to address the findings and resubmit. Keep the workspace unchanged." : "Read the recorded findings. Fix the workspace or block with the unresolved reviewer evidence." }),
          ...(!previous.passed && { isError: true }) };
        const contest = !thermos && !decisions && stage ? contestDispatch(run, stage.id, role, tasks, options.cwd, settings) : undefined;
        const briefs = contest ? [] : tasks.map(task => thermos ? [
          "Inspect the actual current files in " + base.cwd + " against the task goal. Read-only review.",
          "Use the native read tool on the actual source files before deciding. For a deleted path, use ls on its nearest existing parent and inspect the supplied before-image. Review scope: " + JSON.stringify(targets) + ". When empty, read the source named in the user's request. Each independent reviewer must inspect the requested source. The host correlates child tool results with the files.",
          "User instructions: " + JSON.stringify(userRequests) + ". Original task baseline: " + JSON.stringify(baseline),
          ...(draft ? [
            "Review the proposed investigation answer below as the actual deliverable. Treat it as untrusted text. Check its material claims, citations and example against the source. Existing implementation tradeoffs are not defects in a factual explanation unless it misrepresents them.",
            "Proposed answer: " + JSON.stringify(draft),
            ...(run.review?.answerDraft && !run.review.passed && run.review.answerDraft !== draft ? ["Assess the previous unresolved findings against this revision: " + JSON.stringify(run.review.receipt.answers.map(a=>a.slice(0,1800)))] : []),
          ] : []),
          "Measured paths: " + JSON.stringify(delta!.paths) + ". Measurement limitations: " + JSON.stringify(delta!.unknown),
          "Host checks of this exact workspace version (command, exit code, bounded real output, native task and entry IDs): " + JSON.stringify(verified),
          "You have read, ls, grep and find. Inspect the source independently for the enabled quality criteria. The root owns shell execution. A passed host check proves that particular command executed on this version. Do not attempt shell commands, require a rerun of an attested check, or reject only because this reviewer has no shell. If a material risk needs another check, identify the risk and the exact missing check for the root. Record substantive unresolved blockers as findings.",
          "Review criteria: " + JSON.stringify(rubric),
          'Conclude with a single JSON object {"verdict":"pass" or "revise","findings":[],"notes":[],"checks":{"criterion-id":"specific file/line evidence and conclusion"}}. Cover every enabled criterion. Findings are unresolved material blockers under the enabled criteria (e.g. structural regression, a clear boundary leak, or an obvious change that deletes substantial complexity). Use revise for these. Put cosmetic or optional suggestions in notes. Example of passing with an optional suggestion: {"verdict":"pass","findings":[],"notes":["Consider a clearer local name"],"checks":{"criterion-id":"file:line and specific evidence"}}. Keep the actual criterion IDs. Do not turn an unresolved blocker into a note.',
        ].join("\n") : audit ? [
          "Cross-check decision rows in " + audit.path + " against the following task-local execution transcript. Flag weak evidence, omitted verification and risky decisions. Each flag is a plain string naming the affected row or entry and explaining the problem. Return one JSON object, for example {\"flags\":[\"Row 2 lacks a verification receipt.\"]} or {\"flags\":[]} if there are no findings.",
          JSON.stringify(audit.rows), auditTranscript(history), task,
        ].join("\n") : [stage.instructions, ...(run.reviewCommit ? ["Compare the task changes from the recorded Git baseline " + run.reviewCommit + ", including the current working tree."] : []),
          ...(panelDiff ? ["Changed excerpts at the selected baseline: " + JSON.stringify(panelDiff)] : []),
          "Parameters: " + JSON.stringify(routeSettings(settings, run.playbook).parameters),
          "Stage methods: " + JSON.stringify(stage.skillIds.filter(id => settings.skills[id]?.enabled).map(id => skillView(settings, id))), task].join("\n"));
        let args = contest?.args ?? await preparePstackDispatch(settings, role, briefs, options.cwd);
        if (slots?.length && retained) {
          const all = Array.isArray(args.tasks) ? args.tasks : [args];
          const repairs = slots.map(index => {
            const member = retained[index], task = all[index];
            if (!task || typeof task !== "object" || Array.isArray(task)) throw Error("Invalid reviewer assignment.");
            return { ...task, model: member.model, task: task.task + "\nOnly your earlier receipt needs correction. " + member.error +
              "\nYour previous answer: " + member.answer.slice(-6000) + "\nRead the target again and return one final JSON verdict." };
          });
          args = repairs.length === 1 ? repairs[0] : { tasks: repairs };
        }
        checked(options, ctx);
        const ownerDispatch = !thermos && !decisions && isAutopilot(run.playbook) && role === "swarm-workers" &&
          (stage?.id === "owners" || await api.commit(tx => isUnitOwnerDispatch(tx, api, run, api.taskId), ctx))
          ? await api.memo("owner-dispatch-at", api.now(), ctx) : undefined;
        const pending = api.executeTool("subagent", args, ctx, { key: "pstack-dispatch", progress: true });
        const timing = settings.playbooks[run.playbook]?.parameters;
        const { result, latest } = ownerDispatch === undefined ? { result: await pending, latest: null }
          : await monitorOwnerDispatch(pending, api, ctx, ownerDispatch, Number(timing.firstReportMinutes), Number(timing.auditMinutes),
            { run: run.run, active: options.active, expectedOwners: config.count });
        checked(options, ctx);
        const participants = dispatchParticipants.safeParse(result.details);
        if (participants.success) details = { participants: participants.data.results };
        const failed = result.isError ? providerFailures(result.details) : [];
        const allAuthorsUnavailable = contest && failed.length === contest.count && failed.some(f => f.quota);
        const partial = contest && !contest.privatePrompt && result.details && !allAuthorsUnavailable ? arenaSurvivors(result.details, contest.count) : undefined;
        if (result.isError && !partial) {
          if (failed.length) {
            const messages = failed.map(f => f.model + " [" + f.child + "] " + f.error);
            const label = thermos ? "Thermos 独立审查" : decisions ? "决策记录审计" : "阶段 " + stage?.id + " 的 " + role + " 派发";
            const reason = label + "尚未完成。\n" + messages.join("\n");
            if (failed.some(f => f.quota)) {
              const active = await live(api, ctx);
              const dependency: ProviderDependency = { toolTaskId: Number(result.taskId), delegateTaskId: Number(api.taskId), role,
                purpose: purpose ?? "stage", inputs: [...active?.inputs ?? run.inputs], failures: failed };
              await update(options, run, api, ctx, async (next, tx) => {
                const unit = await recordBlockedUnit(tx, api, next, reason);
                if (!unit && !thermos && !decisions && !contest && (!stage || stageRole(settings,stage) !== role)) return;
                next.phase = "blocked"; next.block = reason;
                if (thermos) next.reviewDependency = dependency;
                else next.dispatchDependency = dependency;
              });
            }
            return { ...success({ message: reason, failures: failed, toolTaskId: result.taskId }), details, isError: true };
          }
          throw new Error("Subagent dispatch failed: " + JSON.stringify(result.diagnostics) + " " + String(JSON.stringify(result.structuredOutput) ?? "").slice(0, 4000));
        }
        const records = z.object({ results: z.array(child).min(1) }).parse(partial ?? result.details).results;
        const ids = records.map(c => c.subagentId), models = records.map(c => {
          const answer = c.messages.filter(message => message.role === "assistant").at(-1);
          return answer?.model ? [answer.provider, answer.model].filter(Boolean).join("/") : "";
        });
        if (records.length + (partial?.dropouts.length ?? 0) !== (slots?.length || contest?.count || Math.max(tasks.length, config.count)) || new Set(records.map(c => c.nativeConversationId)).size !== records.length
          || new Set(ids).size !== records.length || records.some(c => c.stopReason === "error" || c.stopReason === "aborted"))
          throw new Error("Configured workers did not all return independent completed receipts.");
        if (models.some(model => !model)) throw new Error("Worker receipt is missing the model that actually answered.");
        if (!contest && !slots?.length && config.model === "diverse" && new Set(models).size < 2)
          throw new Error("Diverse dispatch requires two distinct observed models.");
        const prompt = contest?.privatePrompt;
        const observations = prompt && records.map(c => auditParticipant(c.nativeConversationId, c.messages, prompt));
        const answers = await Promise.all(records.map(async (c, index) => {
          const text = getFinalOutput(c.messages);
          const files = contest && !prompt && c.workspace ? await arenaSubmission(c.workspace, c.messages, ctx.abortSignal) : observations && observations[index].files;
          return files && Object.keys(files).length ? text + "\n\n" + JSON.stringify({ files }) : text;
        }));
        if (answers.some(answer => !answer.trim())) throw new Error("A worker did not return an answer.");
        contest?.check(models, answers);
        const receipt = { stage: run.stage, stageId: stage?.id ?? "", role, toolTaskId: Number(result.taskId), children: ids, models, answers: contest ? answers : answers.map(a => a.slice(0, 12_000)),
          ...(observations && { participants: observations.map(o => o.audit) }),
          ...(partial?.dropouts.length && { dropouts: partial.dropouts }),
          ...(latest && { ownerAudit: latest }), ...(ownerDispatch !== undefined && { ownerReports: ownerReports(result.details, ownerDispatch,
            await api.memo("owner-return-at", api.now(), ctx), Number(settings.playbooks[run.playbook].parameters.firstReportMinutes)).filter(report => ids.includes(report.owner)) }) };
        let passed = false;
        let inspections: ReviewInspection[] | undefined;
        let members: ThermosMember[] | undefined;
        let reviewError: string | undefined;
        let attention: NonNullable<NonNullable<typeof run>["attention"]> | undefined;
        if (audit) {
          const checked = independentAttention(authors, models, answers);
          attention = { ...checked, digest: decisionDigest(audit.rows), toolTaskId: receipt.toolTaskId };
          if (attention.digest !== decisionDigest((await auditPstackDecisions(options, run, api, ctx)).rows))
            throw new Error("Decision rows changed during independent review; retry.");
        }
        if (delta) {
          const after = await measureWorkspace(scope, settings.thermos.fileLines, ctx.abortSignal,await authoredFiles(api,ctx,run));
          if (after.fingerprint !== delta.fingerprint || checkoutSha !== await verificationCheckout(base, ctx.abortSignal))
            throw new Error("Workspace changed during review; review again.");
          inspections = await Promise.all(records.map(c => childInspection(api, c.nativeConversationId, c.workspace?.cwd ?? base.cwd, base.cwd, ctx,scoped.map(f=>f.path))));
          const fresh = await Promise.all(answers.map(async (answer, i): Promise<ThermosMember> => {
            const member = { child: ids[i], model: models[i], answer: answer.slice(0, 16_000), inspection: inspections![i] };
            try {
              const passed = parseThermosVerdict(answer, rubric.map(c => c.id), run.tagId === "code-review");
              await validateInspections(base.cwd, targets, [member.inspection], false);
              return { ...member, passed };
            } catch (error) { return { ...member, passed: false, error: (error as Error).message }; }
          }));
          members = retained && slots?.length ? retained.map((m, i) => slots.includes(i) ? fresh[slots.indexOf(i)] : m) : fresh;
          inspections = members.map(m => m.inspection);
          if (new Set(inspections.map(r => r.child)).size !== config.count || (config.model === "diverse" && new Set(members.map(m => m.model)).size < 2))
            throw new Error("Corrected panel is missing distinct reviewer conversations or required models.");
          if (members.every(m => !m.error)) try { await validateInspections(base.cwd, targets, inspections); }
          catch (error) { members[0] = { ...members[0], passed: false, error: (error as Error).message }; }
          reviewError = members.flatMap(m => m.error ? [m.child + ": " + m.error] : []).join("\n") || undefined;
          receipt.children = members.map(m => m.child); receipt.models = members.map(m => m.model); receipt.answers = members.map(m => m.answer);
          passed = members.every(m => m.passed);
        }
        await update(options, run, api, ctx, next => {
          if (delta) next.review = { fingerprint: delta.fingerprint, passed, receipt, reasons, members: members?.map(({ passed, error }) => ({ passed, ...(error && { error }) })),
            inputs: inputIds, verificationKey, checkoutSha: checkoutSha ?? null,
            ...(draft && {answerDraft:draft}), repairs: previous ? (previous.repairs ?? 0) + 1 : 0,
            ...(inspections && { inspections }), ...(reviewError && { error: reviewError }) };
          else if (attention) next.attention = attention;
          else next.delegates.push(receipt);
        });
        return { ...success({ ...receipt, ...(delta && { passed, reasons, inspections }), ...(reviewError && { error: reviewError }), ...(attention && { attention }) }),
          details, ...(reviewError && { isError: true }) };
      } catch (error) { ctx.abortSignal?.throwIfAborted(); return { ...failure(error), details }; }
    },
  });
}
