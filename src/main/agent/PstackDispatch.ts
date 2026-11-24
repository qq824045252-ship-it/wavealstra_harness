import type { JsonObject, ToolExecutionApi } from "@earendil-works/pi-durable";
import { PSTACK_ROLES, pstackExcludedModels, resolvePstackRole } from "../../shared/pstack/roles";
import type { PstackSettings } from "../../shared/pstack/types";
import type { BuiltinSubagentRole } from "./durable/DurableSubagents";
import type { Context } from "@earendil-works/chord/context";
import { runSettings, state } from "./pstack/PstackState";
import { playbookFor } from "./pstack/PstackState";
import { authorRole, candidateReceipt, contestStep, readerRole } from "./pstack/PstackContest";
import { chooseContestModels, chooseDecisionReviewers, type ContestScope } from "./pstack/PstackContestModels";
import { decisionAuthorsMemo } from "./pstack/PstackAttention";
import { PSTACK_WORKER_CONTRACT } from "./pstack/PstackWorkerContract";
import { INTERROGATE_ADVERSARY_ROLE, INTERROGATE_EXECUTION_BRIEF } from "./pstack/PstackInterrogateEvidence";

const implementationRoles = new Set(["feature", "bug-fix", "perf-issue", "hillclimb", "hardest", "arena-runners", "swarm-workers"]);

export const pstackWorkerRoles: BuiltinSubagentRole[] = PSTACK_ROLES.map(role => ({
  name: `pstack-${role.id}`,
  description: role.label,
  source: "builtin",
  readOnly: !implementationRoles.has(role.id),
  systemPrompt: `${PSTACK_WORKER_CONTRACT}\n\n你是 MyBuddy 代码开发流程的${role.label}。\n${role.description}\n报告依据、结论和仍未确认的部分。`,
}));

/** Frozen read-only workflows may delegate only to the same built-in roles
 * whose native child tool catalogue is read-only. Unknown/general aliases and
 * execution-review workers must not regain write authority through delegation. */
export function readOnlyPstackDispatch(args: Record<string, unknown>): boolean {
  const assignments = [
    ...(typeof args.agent === "string" ? [args] : []),
    ...(Array.isArray(args.tasks) ? args.tasks : []),
    ...(Array.isArray(args.chain) ? args.chain : []),
  ];
  return assignments.length > 0 && assignments.every(item => item && typeof item === "object" &&
    pstackWorkerRoles.some(role => role.name === item.agent && role.readOnly));
}

const interrogateAdversary: BuiltinSubagentRole = {
  name: INTERROGATE_ADVERSARY_ROLE, description: "Execute isolated adversarial probes without modifying reviewed source",
  source: "builtin", readOnly: false, executionReview: true,
  systemPrompt: PSTACK_WORKER_CONTRACT + "\n\n" + INTERROGATE_EXECUTION_BRIEF,
};

export function pstackSubagentOptions(taskId: string, settings: PstackSettings) {
  const privateRoles: BuiltinSubagentRole[] = [authorRole, readerRole].map(name => ({ name, source: "builtin", readOnly: true,
    privateBrief: true, draftDocuments: name === authorRole, description: "Independent project contributor",
    systemPrompt: name === authorRole ? "Complete the user's request directly. Use project_document for any project files you need to read or create." : "Complete the user's request directly." }));
  return { builtinRoles: [...pstackWorkerRoles, interrogateAdversary, ...privateRoles], privateParticipants: async (agents: string[], scope: ContestScope, api: ToolExecutionApi, ctx: Context) => {
    if (agents.every(name => name === "pstack-judgment")) {
      const nested = await api.getTask(api.taskId, ctx);
      const parent = nested?.owner && await api.getTask(nested.owner, ctx);
      const authors = parent?.memos?.[decisionAuthorsMemo];
      if (Array.isArray(authors) && authors.every(id => typeof id === "string")) {
        const run = await state(api, ctx);
        if (!run || run.task !== taskId || run.phase !== "running") throw Error("Decision audit requires an active workflow.");
        const models = chooseDecisionReviewers(runSettings(run), scope, authors);
        if (models.length !== agents.length) throw Error("Decision reviewer count differs from the configured role.");
        return {models};
      }
      return;
    }
    if (!agents.some(name => name === authorRole || name === readerRole || name === "pstack-arena-runners")) return;
    const run = await state(api, ctx), stage = run && playbookFor(run).stages[run.stage];
    const phase = run && stage && contestStep(run.playbook, stage.id);
    const arenaWriters = agents.every(name => name === "pstack-arena-runners");
    if (arenaWriters && (!phase || phase.eval || phase.step !== "run")) return;
    const authors = arenaWriters || agents.every(name => name === authorRole);
    if (!run || run.task !== taskId || run.phase !== "running" || !phase || !(authors ? ["run","candidates"].includes(phase.step) :
      agents.length === 1 && agents[0] === readerRole && phase.step === "judge")) throw Error("Private authors and readers require their owning workflow stage.");
    const frozen = runSettings(run), contest = run.contests?.[phase.key];
    if (!contest) throw Error("Missing private criteria.");
    const models = chooseContestModels(frozen, scope, phase.eval, authors ? undefined : candidateReceipt(run, phase.key).models);
    if (models.length !== agents.length) throw Error("The dispatch size changed from the configured comparison.");
    return { models, documents: agents.map((_,i) => authors ? contest.materials?.[contest.materials.length === 1 ? 0 : i] ?? {} : {}) };
  }, excludedModels: async (api: ToolExecutionApi, ctx: Context) => {
    const run = await state(api, ctx);
    return pstackExcludedModels(run?.task === taskId && run.phase === "running" ? runSettings(run) : settings);
  } };
}

/** One common assignment, or one assignment per configured worker. */
export function preparePstackDispatch(settings: PstackSettings, role: string, tasks: string[], cwd: string): JsonObject {
  const { model, effort, count, isolation } = resolvePstackRole(settings, role);
  if (!tasks.length || tasks.some(task => !task.trim()) || (tasks.length !== 1 && tasks.length !== count)) {
    throw new Error(`角色 ${role} 配置了 ${count} 人，请提供一份共用任务或分别提供 ${count} 份任务。`);
  }
  if (model === "diverse" && count < 2) throw new Error("多模型角色至少需要两名成员。");
  if (pstackExcludedModels(settings).has(model)) throw new Error(`pstack 配置已排除模型 ${model}`);
  const items = Array.from({ length: count }, (_, index) => {
    const item: JsonObject = { agent: `pstack-${role}`, task: tasks[index] ?? tasks[0]!, cwd, isolation };
    if (model !== "default") item.model = model;
    if (effort === "off") item.reasoning = { enabled: false };
    else if (effort !== "default") item.reasoning = { effort };
    return item;
  });
  return count === 1 ? items[0]! : { tasks: items };
}

/** Thermos remains a read-only role. Only an Interrogate stage receives the
 * separate execution-review role, and shared fallback is never permitted. */
export function prepareInterrogateDispatch(settings: PstackSettings, tasks: string[], cwd: string): JsonObject {
  const ordinary = preparePstackDispatch(settings, "interrogate-reviewers", tasks, cwd);
  const isolate = (item: JsonObject): JsonObject => ({ ...item, agent: INTERROGATE_ADVERSARY_ROLE, isolation: "worktree" });
  return Array.isArray(ordinary.tasks) ? { tasks: (ordinary.tasks as JsonObject[]).map(isolate) } : isolate(ordinary);
}
