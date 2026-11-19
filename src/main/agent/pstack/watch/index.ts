import { defineDoc, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { checked, failure, owner, playbookFor, runSettings, state, success, update, type WorkflowOptions } from "../PstackState";
import { monitorPullRequests, watchSeed, type WatchScope } from "./monitor";
import { assessFreshBuilds, verifyBuildEvidence, type BuildHistory } from "./builds";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ForgeScope } from "./origin";

const Queue = defineDoc({
  kind: "mybuddy.pstack-pr-queue", version: 1, scope: "conversation", history: "rewindable", fork: "initial",
  checkpointWhen: () => true, initial: (): { run: string; scopes: Record<string, number[]> } => ({ run: "", scopes: {} }),
});
const Forge = defineDoc({
  kind: "mybuddy.pstack-pr-forge", version: 1, scope: "conversation", history: "rewindable", fork: "initial",
  checkpointWhen: () => true, initial: (): { run: string; repositories: Record<string, ForgeScope> } => ({ run: "", repositories: {} }),
});
type Capture = { revision: number; result: { receipt: { stage: number; toolTaskId: number; forge: string; repository: string; prs: number[]; verdict: string; observedAt: string; allowed: boolean; mergedSnapshot: boolean };
  report: string; progress: { kind: string; observedAt: string }[]; freshBuilds: ReturnType<typeof assessFreshBuilds>;
  verifiedLog?: Awaited<ReturnType<typeof verifyBuildEvidence>> }; builds: BuildHistory[] };

export function createPstackWatchTool(options: WorkflowOptions): ToolRegistration {
  return defineTool({
    name: "pstack_watch_pr", replay: "safe", executionMode: "sequential",
    description: "Read GitHub or Cursor Origin PR state for babysit or shipping. One-shot snapshots can run from any stage; long watches run at watch. Call pstack_workflow complete after a check-mode snapshot or a snapshot proving every named PR is already merged. To triage a failing GitHub Actions check, supply its exact observed identity, classification and evidence. Fresh-build reservations only track the configured budget; no remote write occurs.",
    parameters: Type.Object({ owner: Type.String({ minLength: 1 }), repo: Type.String({ minLength: 1 }),
      pr: Type.Integer({ minimum: 1 }), queue: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1, uniqueItems: true })),
      classification: Type.Optional(Type.Object({ repository: Type.String(), pr: Type.Integer({ minimum: 1 }), head: Type.String(), workflow: Type.String(),
        check: Type.String(), run: Type.String({ pattern: "^[0-9]+$" }), classification: StringEnum(["flake", "infrastructure", "stale-base", "code"] as const),
        evidence: Type.String({ minLength: 1, maxLength: 1000, description: "For a fresh-build reservation, one exact line from the failed GitHub Actions job log (timestamp prefix optional)." }) })) }),
    async execute(target, api, ctx) {
      try {
        checked(options, ctx);
        await owner(api, ctx);
        const run = await state(api, ctx);
        if (!run || run.task !== options.taskId || run.phase !== "running" || !["babysit", "shipping"].includes(run.playbook))
          throw new Error("PR monitoring requires an active babysit or shipping workflow.");
        const book = run.playbook === "shipping" ? "shipping" : "babysit";
        const settings = runSettings(run);
        const policy = settings.playbooks[book].parameters;
        const oneShot = policy.statusOnly === true || (book === "babysit" && (policy.mode === "check" || policy.mode === "threads-only"));
        if (playbookFor(run).stages[run.stage]?.id !== "watch" && !oneShot) throw new Error("Continuous PR monitoring requires the watch stage.");
        if (target.classification && (book !== "babysit" || !target.classification.evidence.trim())) throw new Error("CI classification needs babysit and a concrete reason based on logs.");
        const publish = async (capture: Capture) => {
          const receipt = capture.result.receipt;
          if (!run.operations.includes(api.taskId)) {
            if (run.stage !== receipt.stage || run.revision !== capture.revision) throw new Error("The workflow changed while recording this observation. Read the PR again.");
            await update(options, run, api, ctx, current => { current.watch = receipt; if (capture.builds.length) current.builds = capture.builds; });
          }
          return { ...success(capture.result), isError: !receipt.allowed };
        };
        const replay = await api.memo<Capture>("watch-result", ctx);
        if (replay) return await publish(replay);
        watchSeed(target, policy.forge !== "github");
        const forgeRun = JSON.stringify([run.task, run.run]), forgeKey = (target.owner + "/" + target.repo).toLowerCase();
        const key = forgeKey + "/" + target.pr;
        const previous = await api.snapshot(Queue, api.conversationId, ctx);
        const previousQueue = previous?.run === forgeRun ? previous.scopes[key] : undefined;
        if (previousQueue && target.queue && JSON.stringify(target.queue) !== JSON.stringify(previousQueue)) {
          throw new Error("This queued-stack run already has a frozen PR list.");
        }
        const request = previousQueue ? { ...target, queue: previousQueue } : target;
        const freeze = (scope: WatchScope) => api.commit(async tx => {
          checked(options, ctx);
          const doc = await tx.doc(Queue, api.conversationId);
          if (doc.run !== forgeRun) { doc.run = forgeRun; doc.scopes = {}; }
          doc.scopes[key] ??= scope.prs;
          return { repository: scope.repository, prs: [...doc.scopes[key]] };
        }, ctx);
        const persisted = await api.snapshot(Forge, api.conversationId, ctx);
        const pin = (scope: ForgeScope) => api.commit(async tx => {
          checked(options, ctx);
          const doc = await tx.doc(Forge, api.conversationId);
          if (doc.run !== forgeRun) { doc.run = forgeRun; doc.repositories = {}; }
          doc.repositories[forgeKey] ??= scope;
          return { ...doc.repositories[forgeKey] };
        }, ctx);
        const observed = await monitorPullRequests(settings, book, request, { signal: ctx.abortSignal, cwd: options.cwd,
          active: options.active, freeze, chosen: persisted?.run === forgeRun ? persisted.repositories[forgeKey] : undefined, pin });
        checked(options, ctx);
        const receipt = { stage: run.stage, toolTaskId: Number(api.taskId), repository: observed.repository, prs: observed.prs,
          verdict: observed.verdict.kind, observedAt: observed.verdict.observedAt, allowed: observed.allowed,
          forge: observed.forge, mergedSnapshot: observed.mergedSnapshot };
        const history = structuredClone(run.builds ?? []);
        const freshBuilds = assessFreshBuilds(history, observed.findings, Number(policy.freshBuildRetries ?? 0), target.classification);
        const reserved = freshBuilds.find(build => build.disposition === "fresh-build-reserved");
        const verifiedLog = reserved && target.classification ? await verifyBuildEvidence(reserved, target.classification.evidence, ctx.abortSignal) : undefined;
        const report = observed.output.length > 24_000 ? observed.output.slice(0, 24_000) + "\n…(truncated)" : observed.output;
        const saved = await api.memo<Capture>("watch-result", { revision: run.revision, result: { receipt, report, progress: observed.progress, freshBuilds, ...(verifiedLog && { verifiedLog }) }, builds: history }, ctx);
        return await publish(saved);
      } catch (error) { return failure(error); }
    },
  });
}
