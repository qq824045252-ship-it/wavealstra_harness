import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, rmdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { copyJson, type JsonRepresentation } from "@earendil-works/chord";
import { withAbortSignal, type Context } from "@earendil-works/chord/context";
import { getSupportedThinkingLevels, type Message } from "@earendil-works/pi-ai";
import {
  createFindTool, createGrepTool, createLsTool, getAgentDir, SettingsManager,
  resolveModelScopeWithDiagnostics, type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import {
  configure, ConversationIdle, defineTool, InboxDoc, LiveDoc, type ConversationId, type EnvTarget,
  type Cursor, type ToolExecutionApi, type ToolRegistration,
} from "@earendil-works/pi-durable";
import { Type, type Static } from "typebox";
import { DurableSubagentIdentity, DURABLE_SUBAGENT_TIER_LIMIT_RETRIES } from "./DurableSubagentIdentity";
import { addChildResponse } from "./DurableChildMeasurements";
import { DurableSteerChild, readSteerByRequest, recordSteerInstruction, STEER_ENTRY_KIND, steerRequestKey } from "./DurableSteerReceipts";
export { DurableSubagentIdentity } from "./DurableSubagentIdentity";
import { readDurableWorkRevisionContext, type WorkRevisionBinding } from "./DurableWorkRevisionContext";
import { assertModelAdmission } from "../ModelInvocationAdmission";
import type { SubagentSteerReceipt, SubagentSteerResultDto, SubagentStopRequestSource, SubagentSummaryDto } from "../../../shared/agent-ipc";
import { assertSubagentModelAllowed, filterSubagentModels, resolveSubagentTimeout } from "../../../shared/subagent-execution-policy";
import { discoverAgents, type AgentConfig, type AgentScope } from "../../capabilities/subagent/agents";
import { isPstackForegroundTool } from "../../../shared/pstack/tool-names";
import { appendWorkspaceNotes, buildContextBlock, buildSystemPromptContent, inspectSharedContext } from "../../capabilities/subagent/context";
import { resolveBatchDisplayNames } from "../../capabilities/subagent/display-names";
import { computeChildTools, READONLY_TOOLS, RECURSION_TOOLS, tightenPolicy, type PermissionMode } from "../../capabilities/subagent/policy";
import {
  createParallelWriteGuard, registerGuardedChildWrite, releaseGuardedChildWrite, type ParallelWriteGuard,
} from "../../capabilities/subagent/write-conflict";
import { assignDiverseModels, DIVERSE_SUBAGENT_ROLE, resolveSubagentSelection } from "../../capabilities/subagent/selection";
import { normalizeThinking } from "../../capabilities/subagent/config";
import { assertGitIsolationAllowed, repositoryAllowsGitIsolation, prepareSubagentWorkspace, type PreparedSubagentWorkspace } from "../../capabilities/subagent/worktree";
import {
  DEFAULT_CONFIRM_TOOLS, getResultOutput, isFailedResult, ListParams, loadHostDefaults, loadSubagentConfig,
  parallelPerTaskOutputCap, resolveParallelLimits, resultOutcome, SteerParams, SubagentParams, truncateParallelOutput,
  type SingleResult,
} from "../../capabilities/subagent/shared";

type Invocation = Static<typeof SubagentParams>;
type Item = NonNullable<Invocation["tasks"]>[number];
type Selection = ReturnType<typeof resolveSubagentSelection>;
export type BuiltinSubagentRole = Pick<AgentConfig, "name" | "description" | "systemPrompt" | "tools" | "model"> & {
  source: "builtin"; readOnly: boolean; privateBrief?: boolean; draftDocuments?: boolean;
};
type DispatchRole = AgentConfig | BuiltinSubagentRole;
function childRoleTools(role: DispatchRole, tools: string[]): string[] {
  if (role.source === "builtin" && role.privateBrief) return tools.filter(name => name === "project_document");
  return tools.filter(name => name !== "project_document" && (role.source !== "builtin" || !role.readOnly || READONLY_TOOLS.some(tool => name === tool)));
}
type IsolationRequest = "auto" | "shared" | "worktree";
type PlanBase = {
  index: number;
  id: string;
  displayName: string;
  /** Agent name as requested; a rejected item may have no resolved role. */
  agentName: string;
  task: string;
  sourceCwd: string;
  isolation: IsolationRequest;
};
/** D-5: the workspace is resolved once at plan time and then executed as-is. */
type PlannedWorkspace = { kind: "worktree" } | { kind: "shared"; note: string };
type PlannedChild = PlanBase & {
  kind: "run";
  role: DispatchRole;
  tools: string[];
  selection: Selection;
  documents?: Record<string, string>;
  workspace: PlannedWorkspace;
};
/**
 * N-1: an item-scoped configuration error. The dispatch reports it in that item's own block and keeps
 * running the valid items; single mode still fails the whole call because there is nothing to protect.
 */
type RejectedItem = PlanBase & { kind: "rejected"; rejection: string };
type PlanItem = PlannedChild | RejectedItem;
type Dispatch = {
  mode: "single" | "parallel" | "chain";
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  concurrency: number;
  permissionMode: PermissionMode;
  timeout: ReturnType<typeof resolveSubagentTimeout>;
  /** D-4：调用方传了 timeout_ms、但固定策略把它丢掉时，随结果一起回传的可见诊断。 */
  timeoutDiagnostic?: string;
  items: PlanItem[];
  /** Frozen input evidence for this dispatch, never the latest mutable Work. */
  workRevisionContext?: string;
};
export type DurableChildIdentity = {
  taskId: string;
  parentConversationId: ConversationId;
  parentSubmissionIds?: number[];
  item: PlannedChild;
  workspace: PreparedSubagentWorkspace;
  startedAt: number;
  deadline: number;
  timeout: Dispatch["timeout"];
};
type Identity = DurableChildIdentity;

export async function resolveDurableExecutionCwd(target: EnvTarget, context: Context, rootCwd: string): Promise<string> {
  if (!target.cwd) throw new Error("执行工作目录缺失");
  const identity = (await target.read.snapshot(DurableSubagentIdentity, target.conversationId, context))?.value;
  const expected = identity?.workspace.cwd ?? rootCwd;
  if (resolve(target.cwd) !== resolve(expected) || await realpath(target.cwd) !== await realpath(expected)
    || !(await stat(expected)).isDirectory()) throw new Error("执行工作目录与宿主绑定不一致");
  return expected;
}

export interface DurableSubagentOptions {
  taskId: string;
  cwd: string;
  models: ModelRuntime;
  builtinRoles?: readonly BuiltinSubagentRole[];
  privateParticipants?: (agents: string[], scope: { available: string[]; pools: Record<string,string[]>; parent?: string; defaultModel?: string;
    supportsEffort: (id: string, effort: string) => boolean }, api: ToolExecutionApi, context: Context) =>
    Promise<{ models: string[]; documents?: Record<string,string>[] } | undefined>;
  excludedModels?: (api: ToolExecutionApi, ctx: Context) => Promise<ReadonlySet<string>>;
  permissionMode: () => PermissionMode;
  workspaceNotes?: () => string;
  onChange?: () => void;
  observedUsage?: (conversationId: string) => import("../../../shared/task-diagnostics").ConversationUsageReceipt;
  allowGitBranchOrWorktree?: () => boolean;
  readOnlyWorkspace?: boolean;
  workBinding?: () => WorkRevisionBinding | undefined;
}


type ActiveChild = {
  taskId: string;
  id: string;
  identity: Identity;
  summary: SubagentSummaryDto;
  snapshot: () => SubagentSummaryDto;
  steer: (instruction: string, requestId: string, origin: "user" | "parent") => Promise<SubagentSteerResultDto>;
  cancel: (source: SubagentStopRequestSource) => Promise<void>;
  transcript: () => Promise<{ record: SubagentSummaryDto; entries: Array<{ ts: number; type: "message_end"; message: Message }>; ended: boolean }>;
};
const activeChildren = new Map<string, ActiveChild>();

export async function stopDurableSubagentsForModelScopeChange(): Promise<void> {
  await Promise.allSettled([...activeChildren.values()].map(child => child.cancel("model-scope-change")));
}

/**
 * Cancel this task's live children. Native abort reaches a child's conversation only while the
 * parent task that owns it is reachable, so a stop issued after the parent turn already ended
 * leaves the children running: their conversations stay live and every later fork/idle check
 * keeps seeing work. Stopping them explicitly is what makes "stop" mean the whole subtree.
 */
export async function stopDurableSubagentsForTask(taskId: string): Promise<void> {
  await Promise.allSettled([...activeChildren.values()]
    .filter(child => child.taskId === taskId)
    .map(child => child.cancel("task-stop")));
}

function steerUnavailable(requestId: string, reason = "child_unavailable"): SubagentSteerResultDto {
  const message = reason === "invalid_request" ? "引导请求无效"
    : reason === "child_cancelling" ? "子代理正在停止，引导未接收"
      : reason === "conversation_idle" ? "子代理当前轮次已经收尾，引导未接收"
        : "子代理已结束或无法接收引导";
  return { ok: false, requestId, reason, message };
}

const validSteerId = (id: string): boolean => id.length > 0 && id.length <= 160 && id.trim() === id;

/** The live index handles admission, while the passive reader supplies stored receipts after exit. */
export function createDurableSubagentIpcBackend(readReceipts?: (taskId: string, childId: string) => Promise<SubagentSteerReceipt[]>) {
  return {
  steerReceipts: (taskId: string, childId: string) => readReceipts?.(taskId, childId) ?? Promise.resolve([]),
  // 作用域必须按 taskId 过滤：面板只应看到当前任务的实例
  active: (taskId: string) => [...activeChildren.values()]
    .filter(child => child.taskId === taskId)
    .map(child => child.snapshot()),
  transcript: async (id: string) => await activeChildren.get(id)?.transcript() ?? { record: null, entries: [], ended: true },
  steer: async (id: string, instruction: string, taskId: string, requestId: string): Promise<SubagentSteerResultDto> => {
    if (!taskId || !validSteerId(requestId) || !instruction.trim()) return steerUnavailable(requestId, "invalid_request");
    const child = activeChildren.get(id);
    let unavailable = steerUnavailable(requestId);
    if (child?.taskId === taskId) {
      try {
        const result = await child.steer(instruction, requestId, "user");
        if (result.ok) return result;
        unavailable = result;
      } catch (error) {
        // The parent invocation can end immediately after the native admission commits.
        const receipt = (await readReceipts?.(taskId, id))?.find(row => row.requestId === requestId);
        if (receipt) return { ok: true, receipt };
        throw error;
      }
    }
    const receipt = (await readReceipts?.(taskId, id))?.find(row => row.requestId === requestId);
    return receipt ? { ok: true, receipt } : unavailable;
  },
  cancel: async (id: string) => {
    const child = activeChildren.get(id);
    if (!child) return { ok: false, message: "子代理已经结束" };
    await child.cancel("child-panel");
    return { ok: true };
  },
  };
}

export const durableSubagentIpcBackend = createDurableSubagentIpcBackend();

/**
 * D-1: the provider membership quota rejects with HTTP 400 `tier_limit_exceeded` /
 * `membership concurrency limit exceeded`. Pi's retry classifier lists only 429/5xx and
 * `rate.?limit`, so the rejection is classified non-retryable and nothing upstream repeats it.
 * The rolling pool therefore leaves those items failed; this dispatch retries each of them once,
 * serially, after the pool has drained (see the retry loop in the `subagent` tool below).
 */
const TIER_LIMIT_PATTERN = /tier_limit_exceeded|membership concurrency limit exceeded/i;
/** One deferred retry only: a provider quota window is hourly, so more retries just burn requests. */
const TIER_LIMIT_RETRIES = DURABLE_SUBAGENT_TIER_LIMIT_RETRIES;
/** Do not start a retry that no longer fits the original deadline; it would only time out. */
const TIER_LIMIT_RETRY_MIN_BUDGET_MS = 1_000;

function isTierLimitFailure(result: SingleResult | undefined): boolean {
  if (!result || !isFailedResult(result) || !TIER_LIMIT_PATTERN.test(result.errorMessage ?? result.stderr)) return false;
  // A quota rejection normally happens before the child's first turn ran. If the child already
  // called a tool, resubmitting the task would replay work with side effects, so that stays final.
  return !result.messages.some(message => message.role === "assistant"
    && message.content.some(part => part.type === "toolCall"));
}

/**
 * The model can only pass a role id it has seen. Without this list the only way to learn the names
 * is to dispatch and read `Unknown agent: X. Available: ...` from a batch that already failed.
 */
function describeAvailableAgents(cwd: string): string {
  try {
    const config = loadSubagentConfig();
    const scope: AgentScope = config.agentScope === "project" || config.agentScope === "both" ? "both" : "user";
    const disabled = new Set(config.disabledAgents ?? []);
    const names = discoverAgents(cwd, scope).agents.filter(role => !disabled.has(role.name)).map(role => role.name);
    return names.length > 0
      ? `Valid agent ids here: ${names.join(", ")}. Any other name is rejected before dispatch (upstream names such as general-purpose are not local roles). `
      : "";
  } catch {
    return "";
  }
}

export function createDurableSubagentTools(options: DurableSubagentOptions): ToolRegistration[] {
  const subagent = defineTool({
    name: "subagent", parameters: SubagentParams, replay: "safe",
    description: `${describeAvailableAgents(options.cwd)}Delegate single (agent/task), parallel (tasks), or sequential (chain with {previous}) work to durable child conversations. Roles, model selection, reasoning, tool limits and Chinese display names follow MyBuddy settings. Children keep their original workspace and results across restart. Only a supplied subdirectory of the host task workspace is allowed. Child tools cannot delegate recursively. Use subagent_list and subagent_steer for live work. On a revised Work, delegate only changed or missing steps: include the latest requirement and relevant completed/uncertain facts, never copy old imperative tasks to replay already completed work. An original one-time parallel process does not restart merely because the Work revision changed.`,
    execute: async (params, api, context) => {
      const dispatch = await api.memo<JsonRepresentation<Dispatch>>("dispatch", context)
        ?? await api.memo("dispatch", json(await planDispatch(params, api, context, options)), context);
      /** A dispatch memo written by an older release has no `kind`/`workspace`; reattach it safely. */
      // Keep legacy workspace decisions; refresh the executable tool catalogue.
      const normalized = dispatch.items.map(item => normalizePlanItem(item, dispatch));
      const parent = await api.agent(context);
      const excluded = new Set<string>([...RECURSION_TOOLS, "codemode", "execute_code", "multi_model_consult"]);
      const inherited = parent.callable.map(tool => tool.name).filter(name => !excluded.has(name) && !isPstackForegroundTool(name) &&
        (!options.readOnlyWorkspace || READONLY_TOOLS.some(tool => tool === name)));
      const items = normalized.map(item => item.kind === "run" ? { ...item, tools: childRoleTools(item.role, inherited) } : item);
      const results: SingleResult[] = [];
      /** D-1: the identity deadline observed by the first attempt; a retry must stay inside it. */
      const deadlines = new Map<number, number>();
      /** D-1: items whose provider quota rejection was recovered by the deferred serial retry. */
      const recovered = new Set<number>();
      // N-1: rejected items never start a child, so admission is bounded by the runnable items only.
      const runnable = items.filter((item): item is PlannedChild => item.kind === "run");
      // D-1 visibility: the pool admits `workers` children at once and holds the rest, so the caller can
      // tell "the cap was raised" from "the work was queued" without guessing.
      const workers = Math.max(1, Math.min(dispatch.concurrency, runnable.length || 1));
      const queued = Math.max(0, runnable.length - workers);
      // D-2: pi's write has no version check, so two children writing one file both "succeed" and the
      // later content silently overwrites the earlier one. Only a concurrent parallel dispatch can
      // race; single and chain write in order, and chain steps may legitimately rewrite a prior file.
      const writeGuard = dispatch.mode === "parallel" && workers > 1 ? createParallelWriteGuard() : undefined;
      const detailsOf = () => json({ mode: dispatch.mode, agentScope: dispatch.agentScope, projectAgentsDir: dispatch.projectAgentsDir,
        concurrency: { workers, queued, maxConcurrency: dispatch.concurrency },
        // 面板的“排队中”行从这里派生：plan 是入参快照，results 是本派发已完结项，
        // 差集即尚未建子会话的项。名字、agent 与工作目录一并给出，UI 不必从任务正文里猜谁在排队。
        plan: items.map(item => ({ itemId: item.id, index: item.index, agent: item.agentName, displayName: item.displayName,
          task: item.task, cwd: item.sourceCwd, required: true,
          dependencies: dispatch.mode === "chain" && item.index > 0 && items[item.index - 1] ? [items[item.index - 1]!.id] : [],
          isolation: item.kind === "run" ? item.workspace.kind : null })), results: results.filter(Boolean) });
      const publish = async () => api.details(detailsOf(), context);
      const execute = async (item: PlanItem) => {
        if (item.kind === "rejected") {
          const result = rejectedResult(item, dispatch);
          results[item.index] = result;
          await publish();
          return result;
        }
        const { result, deadline } = await runChild(item, dispatch, api, context, options, 0, writeGuard);
        if (deadline !== undefined) deadlines.set(item.index, deadline);
        results[item.index] = result;
        await publish();
        return result;
      };
      await publish();
      if (dispatch.mode === "chain") {
        let previous = "";
        for (const item of items) {
          const result = await execute({ ...item, task: item.task.replace(/\{previous\}/g, () => previous) });
          if (result.exitCode !== 0) break;
          previous = finalText(result.messages);
        }
      } else {
        // Rolling pool: a finished child frees its slot immediately (the old mapWithConcurrencyLimit
        // semantics). Batching with Promise.all made the slowest child hold back an entire batch.
        // Concurrency only bounds admission; execution, cancellation and replay stay inside Durable.
        let next = 0;
        await Promise.all(Array.from({ length: workers }, async () => {
          while (next < items.length) {
            const item = items[next++];
            if (!item) return;
            await execute(item);
          }
        }));
        // D-1: a provider quota rejection is a 400 that no retry classifier covers, so the pool above
        // leaves those items failed. The pool has drained by now, so retrying them one at a time cannot
        // add concurrency pressure; each rejected item is retried at most once and its final result
        // overwrites the failed one, which makes the summary header recount automatically.
        for (let attempt = 1; attempt <= TIER_LIMIT_RETRIES; attempt++) {
          const rejected = runnable.filter(item => isTierLimitFailure(results[item.index]));
          let started = 0;
          for (const item of rejected) {
            if (context.abortSignal?.aborted) break;
            const deadline = deadlines.get(item.index);
            if (deadline === undefined || deadline - api.now() < TIER_LIMIT_RETRY_MIN_BUDGET_MS) continue;
            const retried = await runChild(item, dispatch, api, context, options, attempt, writeGuard);
            if (retried.deadline !== undefined) deadlines.set(item.index, retried.deadline);
            results[item.index] = retried.result;
            if (!isFailedResult(retried.result)) recovered.add(item.index);
            await publish();
            started++;
          }
          if (!started) break;
        }
      }
      // D-3: `results[index]` writes leave holes when a chain stops early; project only real results.
      const completed = results.filter((result): result is SingleResult => Boolean(result));
      const outcomes = completed.map(resultOutcome);
      const clean = outcomes.filter(outcome => outcome === "completed").length;
      const blocked = outcomes.filter(outcome => outcome === "blocked").length;
      const rejectedCount = outcomes.filter(outcome => outcome === "rejected").length;
      const cap = parallelPerTaskOutputCap(completed.length);
      const summaries = completed.map(result => {
        const outcome = resultOutcome(result);
        const status = outcome === "failed"
          ? `failed${result.stopReason && result.stopReason !== "end" ? ` (${result.stopReason})` : ""}`
          : outcome;
        const nameLine = result.displayName && result.subagentId ? `\n> subagent-name: ${result.displayName}` : "";
        const heading = dispatch.mode === "chain" && result.step
          ? `Step ${result.step}: [${result.agent}] ${status} (id: ${result.subagentId})`
          : `### [${result.agent}] ${status} (id: ${result.subagentId})`;
        return `${heading}${nameLine}\n\n${truncateParallelOutput(getResultOutput(result), cap)}`;
      });
      // N-2: `x/y succeeded` used to count a shard whose writes were all blocked, which read as success
      // even though its content never landed. `succeeded` now counts clean completions only; blocked,
      // rejected and quota-recovered items each get their own segment.
      const segments = [
        blocked ? `${blocked} blocked by write conflict: parallel subagents must write different files` : "",
        rejectedCount ? `${rejectedCount} rejected before start` : "",
        recovered.size ? `${recovered.size} recovered after provider concurrency limit` : "",
      ].filter(Boolean);
      // D-1 visibility: only a dispatch that actually admitted children has a pool to describe; an
      // all-rejected batch would otherwise claim workers that never existed.
      const concurrencyLine = runnable.length
        ? `Concurrency: ${workers} worker${workers === 1 ? "" : "s"}, ${queued ? `${queued} queued` : "no queue"} (maxConcurrency ${dispatch.concurrency})\n`
        : "";
      const header = dispatch.mode === "parallel"
        ? `Parallel: ${clean}/${items.length} succeeded${segments.length ? ` (${segments.join("; ")})` : ""}\n${concurrencyLine}\n`
        : "";
      const last = completed.at(-1);
      const lastOutcome = last ? resultOutcome(last) : undefined;
      const stopped = dispatch.mode === "chain" && last && lastOutcome !== "completed" && completed.length < items.length
        ? `\n\nChain stopped at step ${last.step ?? completed.length} (${last.agent}): ${lastOutcome === "rejected" ? "the step was rejected before start" : "the step failed"}.`
        : "";
      const text = `${header}${summaries.join("\n\n---\n\n")}${stopped}`;
      return { output: [{ type: "text", text }], isError: outcomes.some(outcome => outcome !== "completed"),
        details: detailsOf() };
    },
  });
  const list = defineTool({
    name: "subagent_list", parameters: ListParams, replay: "safe",
    // 契约：只有 live 子会话在索引里（activeChildren），终态一律在 runChild 的 finally 中移除。
    // 已结束子会话的结果通过 subagent 工具的 result/details 与任务时间线查看，不在本工具重复暴露。
    description: "List live durable children belonging to this host task. Only running children are indexed; a finished child's result stays in the subagent tool result and the task timeline.",
    execute: async params => {
      const children = [...activeChildren.values()].filter(child => child.taskId === options.taskId)
        .map(child => child.snapshot()).filter(child => (!params.agent || child.role === params.agent) && (!params.status || child.status === params.status))
        .sort((a, b) => b.createdAt - a.createdAt).slice(0, params.limit ?? 20);
      return { output: [{ type: "text", text: JSON.stringify(children) }], details: json({ active: children }) };
    },
  });
  const steer = defineTool({
    name: "subagent_steer", parameters: SteerParams, replay: "safe",
    description: "Send a steering message to a live child of this task or look up its receipt by requestId. The same requestId retrieves the existing submission. A processed receipt means Pi placed the input in the active transcript; settled means Pi answered it.",
    execute: async (params, api, context) => {
      const requestId = params.requestId ?? `tool:${api.taskId}`;
      let result: SubagentSteerResultDto = steerUnavailable(requestId, "invalid_request");
      if (validSteerId(requestId) && (params.instruction === undefined ? params.requestId !== undefined : Boolean(params.instruction.trim()))) {
        const index = await api.snapshot(DurableSteerChild, params.subagentId, context);
        const childId = index?.conversationId as ConversationId | undefined | null;
        const identity = childId == null ? undefined : (await api.snapshot(DurableSubagentIdentity, childId, context))?.value;
        const existing = childId != null && identity?.taskId === options.taskId
          && identity.parentConversationId === api.conversationId && identity.item.id === params.subagentId
          ? await api.commit(tx => readSteerByRequest(tx, childId, steerRequestKey(requestId)), context)
          : undefined;
        const child = activeChildren.get(params.subagentId);
        result = existing ? { ok: true, receipt: existing } : steerUnavailable(requestId, "unknown_request");
        if (!existing && params.instruction !== undefined) {
          result = child?.taskId === options.taskId && child.identity.parentConversationId === api.conversationId
            ? await child.steer(params.instruction, requestId, "parent")
            : steerUnavailable(requestId);
        }
      }
      return { output: [{ type: "text", text: JSON.stringify(result) }], isError: !result.ok, details: json(result) };
    },
  });
  const documents = defineTool({
    name: "project_document", description: "Call with {} or name='.' to list project documents. Read one by name, or supply its complete text as content to save it if this project allows changes.", replay: "safe",
    parameters: Type.Object({ name: Type.Optional(Type.String()), content: Type.Optional(Type.String({ maxLength: 131072 })) }),
    execute: async ({ name, content }, api, ctx) => api.commit(async tx => {
      const identity = (await tx.doc(DurableSubagentIdentity, api.conversationId)).value, files = identity?.item.documents;
      if (identity?.taskId !== options.taskId || !files || identity.item.role.source !== "builtin" || !identity.item.role.privateBrief)
        throw Error("Document unavailable in this session.");
      if (content !== undefined) {
        if (!identity.item.role.draftDocuments) throw Error("This project is read-only.");
        if (!name || name.length > 256 || !name.split("/").every(part => part && part !== "." && part !== ".." && !["__proto__", "constructor", "prototype"].includes(part) && /^[\p{L}\p{N}_. -]+$/u.test(part)))
          throw Error("Choose a project-relative document name.");
        const total = Object.entries(files).reduce((n,[key,value]) => n + (key === name ? 0 : Buffer.byteLength(value)), Buffer.byteLength(content));
        if (total > 128 * 1024) throw Error("Project documents exceed 128 KiB.");
        files[name] = content;
        return { output: [{ type: "text" as const, text: "Saved " + name }] };
      }
      if (!name || name === "." || name === "./") return { output: [{ type: "text" as const, text: JSON.stringify(Object.keys(files)) }] };
      if (!Object.hasOwn(files, name)) throw Error("Document unavailable in this project. Call with {} to list the available names.");
      return { output: [{ type: "text" as const, text: files[name] }] };
    }, ctx),
  });
  return [...createDurableReadOnlyTools(options.cwd), subagent, list, steer, ...(options.privateParticipants ? [documents] : [])];
}

async function planDispatch(params: Invocation, api: ToolExecutionApi, context: Context, options: DurableSubagentOptions): Promise<Dispatch> {
  if ((await api.snapshot(DurableSubagentIdentity, api.conversationId, context))?.value) throw new Error("子代理不能再次委派");
  const config = loadSubagentConfig();
  const mode = params.chain?.length ? "chain" : params.tasks?.length ? "parallel" : "single";
  if (Number(Boolean(params.chain?.length)) + Number(Boolean(params.tasks?.length)) + Number(Boolean(params.agent && params.task)) !== 1) {
    throw new Error("Provide exactly one of agent/task, tasks, or chain");
  }
  const items: Item[] = params.chain ?? params.tasks ?? [{ ...params, agent: params.agent!, task: params.task! }];
  const limits = resolveParallelLimits(config);
  if (items.length > limits.maxParallelTasks) throw new Error(`Too many subagents (${items.length}); limit ${limits.maxParallelTasks}`);
  const timeout = resolveSubagentTimeout(config, params.timeout_ms);
  // D-4: a fixed timeout policy silently discards timeout_ms. Timeout behavior must not change, but
  // the caller has to be able to see that the request was ignored.
  const timeoutDiagnostic = params.timeout_ms !== undefined && timeout.timeoutSource === "settings"
    ? `timeout_ms=${params.timeout_ms} ignored: fixed policy (${timeout.timeoutMs / 1000}s settings)`
    : undefined;
  const scope = params.agentScope === "project" || params.agentScope === "both" || params.agentScope === "user" ? params.agentScope : config.agentScope ?? "user";
  const discovery = discoverAgents(options.cwd, scope);
  const roles = [...options.builtinRoles ?? [], ...discovery.agents].filter(role => !(config.disabledAgents ?? []).includes(role.name));
  const permissionMode: PermissionMode = "auto";
  const models = await options.models.getAvailable();
  const settings = SettingsManager.create(options.cwd, getAgentDir());
  const patterns = settings.getEnabledModels();
  const scoped = patterns ? (await resolveModelScopeWithDiagnostics(patterns, options.models)).scopedModels.map(item => item.model) : models;
  const excludedModels = await options.excludedModels?.(api, context);
  const availableModels = filterSubagentModels(scoped.filter(model => !excludedModels?.has(`${model.provider}/${model.id}`)).map(model => ({ id: `${model.provider}/${model.id}`,
    metadata: { source: "pi" as const, reasoning: model.reasoning, reasoningOptions: [{ type: "effort" as const, values: getSupportedThinkingLevels(model) }] } })), config);
  const parent = await api.agent(context);
  const parentModelId = parent.model && `${parent.model.provider}/${parent.model.modelId}`;
  const host = loadHostDefaults(options.cwd);
  const requestedModels = items.map(item => item.model ?? params.model);
  const privateGroup = await options.privateParticipants?.(items.map(i => i.agent), {
    available: availableModels.map(m => m.id), pools: config.roles ?? {}, parent: parentModelId ?? undefined,
    defaultModel: config.defaultModel ?? host.defaultModelId ?? undefined,
    supportsEffort: (model,effort) => {
      if (effort === "default") return true;
      try {
        resolveSubagentSelection({invocation:{model,reasoning:effort === "off" ? {enabled:false} : {effort}},
          defaults:{},availableModels});
        return true;
      } catch { return false; }
    },
  }, api, context);
  const diverse = requestedModels.some(model => model === DIVERSE_SUBAGENT_ROLE);
  if (diverse && (mode === "single" || requestedModels.some(model => model !== DIVERSE_SUBAGENT_ROLE))) throw new Error("Diverse requires every item in a parallel or chain invocation to select diverse");
  const assignments = privateGroup?.models ?? (diverse ? assignDiverseModels({ mode: mode === "chain" ? "chain" : "parallel", taskCount: items.length,
    availableModels, candidates: config.roles?.[DIVERSE_SUBAGENT_ROLE] ?? [] }) : undefined);
  const names = resolveBatchDisplayNames(items, [...activeChildren.values()].filter(child => child.taskId === options.taskId).map(child => child.summary.displayName ?? ""));
  const worktreeBaseDir = join(getAgentDir(), "subagent-worktrees");
  const inspections = new Map<string, Promise<WorktreePreflight>>();
  /**
   * N-1: an item-scoped error must not destroy the whole batch. Single mode keeps fail-fast because
   * there is no other item to protect (and a typo should not turn into a partial success).
   */
  const rejectionOf = (error: unknown): string => {
    if (mode === "single") throw error;
    return error instanceof Error ? error.message : String(error);
  };
  /** Phase 1: resolve role/model/tools per item. Nothing is dispatched and no workspace is prepared. */
  const candidates: Array<{ base: PlanBase; role: DispatchRole; sourceCwd: string; tools: string[]; selection: Selection; explicitIsolation: boolean }> = [];
  const plan = new Map<number, PlanItem>();
  for (const [index, item] of items.entries()) {
    const requested = item.isolation ?? params.isolation;
    const isolation: IsolationRequest = requested === "worktree" || requested === "shared" ? requested : "auto";
    const base: PlanBase = {
      index,
      id: `durable-${createHash("sha256").update(options.taskId).digest("hex").slice(0, 12)}-${api.taskId}-${index}`,
      displayName: names[index]!,
      agentName: item.agent,
      task: privateGroup?.documents ? item.task : appendWorkspaceNotes(item.task, options.workspaceNotes?.() ?? ""),
      ...(privateGroup?.documents && { documents: privateGroup.documents[index] ?? {} }),
      sourceCwd: options.cwd,
      isolation,
    };
    try {
      const role = roles.find(role => role.name === item.agent)
        // Upstream harnesses name their general subagent `general-purpose` (Claude Code) or
        // `generalPurpose`/`general` (Cursor/OpenCode). Those are the same read-write general worker,
        // and a hard failure here only teaches the model to retry the same batch. Unknown names still fail.
        ?? (["default", "assistant", "agent", "general", "general-purpose", "generalpurpose"].includes(item.agent.trim().toLowerCase()) ? roles.find(role => role.name === "worker") ?? roles[0] : undefined);
      if (!role) throw new Error(`Unknown agent: ${item.agent}. Available: ${roles.map(role => role.name).join(", ")}`);
      const sourceCwd = await realpath(resolve(options.cwd, item.cwd ?? params.cwd ?? options.cwd));
      const selected = resolveSubagentSelection({ invocation: { model: assignments?.[index] ?? item.model ?? params.model, reasoning: item.reasoning ?? params.reasoning }, parentModelId,
        defaults: { roleModel: role.model, defaultModel: config.defaultModel, transportThinking: config.transportThinking, transportThinkingModelId: config.transportThinkingModelId,
          globalDefaultModel: host.defaultModelId ?? parentModelId, globalDefaultProvider: host.defaultProvider }, availableModels, roles: config.roles });
      const model = models.find(model => `${model.provider}/${model.id}` === selected.model);
      if (!model) throw new Error(`Subagent model is unavailable: ${selected.model}`);
      await assertModelAdmission(options.models, settings, model);
      assertSubagentModelAllowed(config, selected.model);
      const policy = computeChildTools({ roleTools: role.tools, permissionMode: config.permissionMode ?? permissionMode,
        allowTools: config.allowTools, denyTools: config.denyTools, confirmTools: config.confirmTools ?? [...DEFAULT_CONFIRM_TOOLS] });
      const tightened = tightenPolicy(policy, permissionMode);
      const allowed = tightened.tools ?? parent.callable.map(tool => tool.name);
      const tools = childRoleTools(role, allowed.filter(name => (!options.readOnlyWorkspace || READONLY_TOOLS.some(tool => tool === name)) &&
        !tightened.excludeTools.includes(name) && !isPstackForegroundTool(name) && !["codemode", "execute_code", "multi_model_consult"].includes(name)));
      candidates.push({ base, role, sourceCwd, tools, selection: selected,
        explicitIsolation: item.isolation !== undefined || params.isolation !== undefined });
    } catch (error) {
      plan.set(index, { ...base, kind: "rejected", rejection: rejectionOf(error) });
    }
  }
  // D-5: auto isolation is about concurrent writers. Only items that actually resolved count, so an
  // invalid item can neither force nor prevent isolation for its valid peers. A dispatch that can run
  // only one child at a time resolves to the supplied directory and says why.
  const isolationAllowed = await repositoryAllowsGitIsolation(options.cwd, options.allowGitBranchOrWorktree);
  const plannedWorkers = Math.max(1, Math.min(limits.maxConcurrency, candidates.length));
  for (const { base, role, sourceCwd, tools, selection, explicitIsolation } of candidates) {
    const itemBase: PlanBase = { ...base, sourceCwd };
    if (base.isolation === "worktree" && !isolationAllowed) {
      plan.set(base.index, { ...itemBase, kind: "rejected", rejection: rejectionOf(new Error("当前 Work 或仓库禁止分支/worktree，显式隔离计划被拒绝；请改用 shared，共享资源访问由宿主协调")) });
      continue;
    }
    const workspace: PlannedWorkspace = !isolationAllowed
      ? { kind: "shared", note: "仓库/Work 禁止分支与 worktree；保留共享目录并行，实际工具调用按资源读写协调" }
      : resolveIsolation({ requested: base.isolation, explicit: explicitIsolation, mode,
        writable: isWritable(tools), workers: plannedWorkers, runnable: candidates.length });
    if (workspace.kind === "shared") {
      plan.set(base.index, { ...itemBase, kind: "run", role, tools, selection, workspace });
      continue;
    }
    // A repository is probed at most once per dispatch; the receipt check stays per operation.
    const requestedCheck: WorktreeIsolationRequest = base.isolation === "auto" ? "auto" : "worktree";
    try {
      const inspection = inspections.get(sourceCwd) ?? inspectWorktreePreflight(sourceCwd, context.abortSignal, requestedCheck);
      inspections.set(sourceCwd, inspection);
      await assertWorktreeIsolationPreflight(sourceCwd, base.id,
        { baseDir: worktreeBaseDir, signal: context.abortSignal, inspection: await inspection, requested: requestedCheck });
    } catch (error) {
      plan.set(base.index, { ...itemBase, kind: "rejected", rejection: rejectionOf(error) });
      continue;
    }
    plan.set(base.index, { ...itemBase, kind: "run", role, tools, selection, workspace: { kind: "worktree" } });
  }
  const planned = [...plan.values()].sort((a, b) => a.index - b.index);
  const workRevisionContext = await readDurableWorkRevisionContext(api, context, options.workBinding?.(), options.taskId);
  return { mode, agentScope: scope, projectAgentsDir: discovery.projectAgentsDir, concurrency: limits.maxConcurrency,
    ...(workRevisionContext ? { workRevisionContext } : {}),
    permissionMode, timeout, ...(timeoutDiagnostic ? { timeoutDiagnostic } : {}), items: planned };
}

/**
 * D-5: one place decides isolation and, when it declines to isolate, says why. The decision and its
 * explanation used to be derived twice, which let them disagree; isolating only means "this dispatch
 * can run more than one concurrent writer", so no other dispatch needs a separate copy of the tree.
 */
function resolveIsolation(input: { requested: IsolationRequest; explicit: boolean; mode: Dispatch["mode"];
  writable: boolean; workers: number; runnable: number }): PlannedWorkspace {
  if (input.requested === "worktree"
    || (input.requested === "auto" && input.mode === "parallel" && input.writable && input.workers > 1)) {
    return { kind: "worktree" };
  }
  const why = input.requested === "shared"
    ? 'isolation:"shared" was selected; writes land in the original directory, not an isolated copy'
    : input.mode === "single"
      ? "isolation:auto does not isolate a single task; writes land in the original directory"
      : input.mode === "chain"
        ? "isolation:auto does not isolate chain steps; each step writes to the original directory"
        : !input.writable
          ? "isolation:auto keeps the supplied directory because the toolset is read-only"
          : input.runnable < 2
            ? "isolation:auto does not isolate a dispatch that runs one child; writes land in the original directory"
            : `isolation:auto needs more than one concurrent writer; maxConcurrency=${input.workers} keeps the supplied directory`;
  const force = input.explicit && input.requested === "auto"
    ? ' isolation:"auto" has no isolation effect here; pass isolation:"worktree" to force a separate worktree.' : "";
  return { kind: "shared", note: `${why}.${force}` };
}

/** One definition of "this toolset can change files": planning, execution and legacy replay share it. */
function isWritable(tools: string[]): boolean {
  return tools.some(name => !(READONLY_TOOLS as readonly string[]).includes(name));
}

export type WorktreePreflight = { repository: string; clean: boolean };
/** Only `auto` needs the explanation: a non-Git dispatch only fails here when auto would isolate. */
type WorktreeIsolationRequest = "auto" | "worktree";

/** Repository-level preconditions for worktree isolation, probed once per cwd per dispatch. */
export async function inspectWorktreePreflight(cwd: string, signal?: AbortSignal,
  requested: WorktreeIsolationRequest = "worktree"): Promise<WorktreePreflight> {
  const why = requested === "auto"
    ? ' This dispatch is parallel and write-capable, so isolation:"auto" isolates it; a shared directory would let concurrent writers race.'
    : "";
  let repository: string;
  try {
    repository = await realpath(await gitPreflight(cwd, ["rev-parse", "--show-toplevel"], signal));
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(`Subagent worktree isolation requires a Git working tree: ${cwd}. `
      + `Run these tasks with isolation:"shared" so writes land in the original directory, or initialize a Git repository first.${why}`, { cause: error });
  }
  const inside = relative(repository, cwd);
  if (isAbsolute(inside) || inside === ".." || inside.startsWith(`..${sep}`)) {
    throw new Error(`Subagent cwd is outside its Git repository: ${cwd}`);
  }
  const clean = !(await gitPreflight(repository, ["status", "--porcelain=v1", "--untracked-files=all"], signal));
  return { repository, clean };
}

/**
 * D-5 preflight: fail once, at dispatch time, when a dispatch that intends to isolate cannot. The
 * checks mirror prepareSubagentWorkspace (worktree.ts:96-148): a matching ready receipt means it
 * reuses that worktree and returns before the clean-repository check, so replay/recovery of an
 * existing durable child must not be rejected here.
 */
export async function assertWorktreeIsolationPreflight(
  cwd: string,
  operationId: string,
  options: { baseDir?: string; signal?: AbortSignal; inspection?: WorktreePreflight; requested?: WorktreeIsolationRequest } = {},
): Promise<void> {
  const requested = options.requested ?? "worktree";
  const inspection = options.inspection ?? await inspectWorktreePreflight(cwd, options.signal, requested);
  // prepareSubagentWorkspace allocates under realpath(baseDir); mirror that so the receipt lookup
  // hits the same directory (a missing baseDir simply means there is no receipt yet).
  let baseDir = options.baseDir ?? join(getAgentDir(), "subagent-worktrees");
  try { baseDir = await realpath(baseDir); } catch { /* no receipts yet */ }
  if (await hasReusableWorktreeReceipt(inspection.repository, cwd, operationId, baseDir)) return;
  if (!inspection.clean) {
    const why = requested === "auto"
      ? ' This dispatch is parallel and write-capable, so isolation:"auto" isolates it; a shared directory would let concurrent writers race.'
      : "";
    throw new Error(`Subagent worktree isolation requires a clean repository, including untracked files: ${inspection.repository}. `
      + `Commit or stash changes, or run these tasks with isolation:"shared" so writes land in the original directory.${why}`);
  }
}

/** Same receipt layout and validity rules as prepareSubagentWorkspace (worktree.ts:113-143). */
async function hasReusableWorktreeReceipt(repository: string, cwd: string, operationId: string, baseDir: string): Promise<boolean> {
  const allocation = join(baseDir, `durable-${createHash("sha256").update(operationId).digest("hex")}`);
  try {
    const saved = JSON.parse(await readFile(join(allocation, "receipt.json"), "utf8")) as Record<string, unknown>;
    if (saved?.state !== "ready" || saved.sourceCwd !== cwd || saved.repository !== repository
      || saved.root !== join(allocation, "worktree") || saved.cwd !== join(allocation, "worktree", relative(repository, cwd))) return false;
    return await realpath(String(saved.root)) === saved.root && await realpath(String(saved.cwd)) === saved.cwd;
  } catch { return false; }
}

function gitPreflight(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], {
      shell: false, windowsHide: true, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, ...(signal ? { signal } : {}),
    }, (error, stdout, stderr) => {
      if (signal?.aborted) reject(signal.reason);
      else if (error) reject(new Error(`git ${args[0]} failed: ${String(stderr).trim() || error.message}`, { cause: error }));
      else resolve(String(stdout).trimEnd());
    });
  });
}

/** D-1: `deadline` is the identity deadline of the conversation this attempt ran in (if any). */
type ChildAttempt = { result: SingleResult; deadline?: number };

/** N-1: a rejected item never starts a child conversation; it still gets a result-shaped block. */
function rejectedResult(item: RejectedItem, dispatch: Dispatch): SingleResult {
  return {
    agent: item.agentName, agentSource: "unknown", task: item.task, subagentId: item.id, displayName: item.displayName,
    status: "error", exitCode: 1, messages: [], stderr: item.rejection,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    errorMessage: item.rejection, rejected: true,
    ...(dispatch.mode === "chain" ? { step: item.index + 1 } : {}),
  };
}

/**
 * Durable replays the `dispatch` memo written by the release that started the call. Before v4 the memo
 * carried `isolation` instead of a resolved workspace, so it is replayed under that release's rule
 * (worktree.ts: `auto` isolated a parallel, write-capable child) rather than re-decided by the current
 * policy. A child that already prepared its workspace keeps it either way, and runChild rejects a plan
 * that contradicts a prepared workspace.
 */
export function legacyPlannedWorkspace(isolation: IsolationRequest | undefined, mode: Dispatch["mode"], tools: string[]): PlannedWorkspace {
  return isolation === "worktree" || (isolation !== "shared" && mode === "parallel" && isWritable(tools))
    ? { kind: "worktree" }
    : { kind: "shared", note: "isolation was resolved by the release that started this dispatch; writes land in the original directory, not an isolated copy" };
}

function normalizePlanItem(item: PlanItem, dispatch: Dispatch): PlanItem {
  if (item.kind === "run" || item.kind === "rejected") return item;
  const legacy = item as PlannedChild & { isolation?: IsolationRequest };
  return { ...legacy, kind: "run", workspace: legacyPlannedWorkspace(legacy.isolation, dispatch.mode, legacy.tools) };
}

async function runChild(item: PlannedChild, dispatch: Dispatch, api: ToolExecutionApi, context: Context, options: DurableSubagentOptions,
  attempt = 0, writeGuard?: ParallelWriteGuard): Promise<ChildAttempt> {
  const owned = await api.commit(async tx => {
    const children = await tx.scanConversations({ ownerTaskId: api.taskId }, 250);
    for (const child of children.items) {
      const identity = (await tx.doc(DurableSubagentIdentity, child.id)).value;
      if (identity?.item.id === item.id) return { id: child.id, identity: json(identity) };
    }
    return undefined;
  }, context);
  let workspace = owned?.identity.workspace;
  const privateBrief = item.role.source === "builtin" && item.role.privateBrief === true;
  let privateDirectory: string | undefined;
  const diagnostics = [
    // D-1: a recovered quota rejection must not stay invisible; otherwise a `N/N succeeded` header
    // looks like the provider accepted N concurrent requests when it actually rejected some.
    ...(attempt > 0 ? [`retried after provider concurrency rejection (attempt ${attempt + 1})`] : []),
    ...(item.selection.diagnostics ?? []),
    ...(dispatch.timeoutDiagnostic ? [dispatch.timeoutDiagnostic] : []),
  ];
  const isolationNote = item.workspace.kind === "shared" ? item.workspace.note : undefined;
  const empty = (): SingleResult => ({ agent: item.role.name, agentSource: item.role.source, task: item.task,
    subagentId: item.id, displayName: item.displayName, status: "running", exitCode: -1, messages: [], stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    model: item.selection.model, resolvedModel: item.selection.model, resolvedThinking: item.selection.thinking ?? undefined,
    diagnostics: diagnostics.length ? diagnostics : item.selection.diagnostics, isolationNote,
    modelRole: item.selection.modelRole, roleCandidates: item.selection.roleCandidates,
    ...dispatch.timeout, workspace, ...(dispatch.mode === "chain" ? { step: item.index + 1 } : {}) });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopWatch: (() => Promise<unknown>) | undefined;
  /** D-2: the conversation this attempt registered with the dispatch write guard (released in finally). */
  let guardedConversation: number | undefined;
  /** D-2: blocked writes reach the caller as evidence lines next to the child's own output. */
  const withWriteConflicts = (result: SingleResult): SingleResult => {
    const conflicts = writeGuard?.conflictsFor(item.id) ?? [];
    if (conflicts.length) {
      result.diagnostics = [...(result.diagnostics ?? []), ...conflicts];
      // N-2: machine-readable marker; the heading and the header count use it to stop calling this
      // shard a clean success while its content never landed.
      result.writeConflicts = [...(result.writeConflicts ?? []), ...conflicts];
    }
    return result;
  };
  try {
    // D-5: the isolation decision was made once, in planDispatch. Execute exactly that decision, so
    // the preflight and the child can never disagree about whether a worktree is in play.
    if (item.workspace.kind === "worktree") await assertGitIsolationAllowed(item.sourceCwd, options.allowGitBranchOrWorktree);
    if (privateBrief) {
      const root = await realpath(getAgentDir());
      const slug = createHash("sha256").update(JSON.stringify([options.taskId, item.id, item.sourceCwd])).digest("hex").slice(0, 32);
      const folder = join(root, "document-workspaces", slug);
      await mkdir(folder, { recursive: true, mode: 0o700 });
      if (await realpath(folder) !== folder) throw Error("The private project directory has been redirected.");
      privateDirectory = folder;
      workspace = { kind: "shared", cwd: folder };
    }
    workspace ??= await prepareSubagentWorkspace({ cwd: item.sourceCwd, isolation: item.workspace.kind,
      parallel: dispatch.mode === "parallel", writable: isWritable(item.tools),
      baseDir: join(getAgentDir(), "subagent-worktrees"), signal: context.abortSignal, operationId: item.id, authorizeGitIsolation: options.allowGitBranchOrWorktree });
    if (workspace.kind !== item.workspace.kind) throw new Error(`Subagent workspace changed after planning: expected ${item.workspace.kind}, prepared ${workspace.kind}`);
    const shared = privateBrief ? undefined : inspectSharedContext(item.sourceCwd);
    const instructions = privateBrief ? item.role.systemPrompt : buildSystemPromptContent(item.role.systemPrompt, buildContextBlock({ cwd: workspace.cwd,
      roleName: item.role.name, roleDescription: item.role.description, tools: item.tools, permissionMode: dispatch.permissionMode,
      deniedTools: [...RECURSION_TOOLS], sharedContext: shared?.text, sharedContextStatus: shared, depth: 1 })
      + (dispatch.workRevisionContext ? `\n\n${dispatch.workRevisionContext}` : ""));
    const parent = await api.agent(context);
    const tools = parent.callable.filter(tool => item.tools.includes(tool.name));
    for (const name of item.tools) if (!tools.some(tool => tool.name === name)) throw new Error(`Subagent tool unavailable: ${name}`);
    const separator = item.selection.model.indexOf("/");
    const selectedWorkspace = workspace;
    let created = owned ?? await api.commit(async tx => {
      const child = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
      const parentRun = (await tx.doc(LiveDoc, api.conversationId)).run;
      const identity: Identity = { taskId: options.taskId, parentConversationId: api.conversationId, item, workspace: selectedWorkspace,
        ...(parentRun && { parentSubmissionIds: [...parentRun.inputs] }),
        startedAt: api.now(), deadline: api.now() + dispatch.timeout.timeoutMs, timeout: dispatch.timeout };
      (await tx.doc(DurableSubagentIdentity, child.id)).value = json(identity);
      (await tx.doc(DurableSteerChild, item.id, null)).conversationId = child.id;
      await configure(tx, child.id, { cwd: selectedWorkspace.cwd, tools, modelTools: null, instructions,
        model: { provider: item.selection.model.slice(0, separator), modelId: item.selection.model.slice(separator + 1) },
        thinkingLevel: normalizeThinking(item.selection.thinking) });
      return { id: child.id, identity };
    }, context);
    if (owned) {
      const identity = await api.commit(async tx => {
        const doc = await tx.doc(DurableSubagentIdentity, owned.id);
        if (!doc.value || doc.value.taskId !== options.taskId
          || doc.value.parentConversationId !== api.conversationId || doc.value.item.id !== item.id) {
          throw new Error("Recovered child identity does not match its dispatch");
        }
        const next = { ...doc.value, item: { ...doc.value.item, tools: [...item.tools] } };
        await configure(tx, owned.id, { tools, modelTools: null, instructions });
        doc.value = json(next);
        (await tx.doc(DurableSteerChild, item.id, null)).conversationId = owned.id;
        return json(next);
      }, context);
      created = { id: owned.id, identity };
    }
    const child = await api.conversation(created.id, context);
    if (!child) throw new Error("Durable child conversation is missing");
    // D-2: register before the child can issue any tool call. The ToolTask beforeTool hook
    // (guardSubagentWriteCall) maps (taskId, api.conversationId) back to this child and its workspace;
    // each task has its own durable store, so conversation ids alone collide across concurrent tasks.
    if (writeGuard) {
      guardedConversation = created.id;
      registerGuardedChildWrite(created.id, options.taskId, { guard: writeGuard, childId: item.id,
        label: item.displayName ?? item.role.name, cwd: selectedWorkspace.cwd });
    }
    const result = empty();
    const summary: SubagentSummaryDto = { subagentId: item.id, role: item.role.name, displayName: item.displayName,
      roleSource: item.role.source, roleDescription: item.role.description, project: workspace.cwd, status: "running",
      createdAt: created.identity.startedAt, updatedAt: api.now(), runCount: 1, steerCount: 0, pendingSteers: [],
      usage: result.usage, model: item.selection.model, lastTask: item.task, depth: 1, workerAlive: true,
      resolvedModel: item.selection.model, resolvedThinking: item.selection.thinking ?? undefined };
    const messages = async (): Promise<Message[]> => {
      const output: Message[] = [];
      let cursor: Cursor | undefined;
      do {
        const page = await api.commit(tx => tx.scanEntries({ conversationId: created.id, order: "ascending" }, 500, cursor), context);
        for (const entry of page.items) output.push(...entry.model ?? []);
        cursor = page.next;
      } while (cursor);
      return output;
    };
    const snapshot = (): SubagentSummaryDto => {
      const reported = options.observedUsage?.(String(created.id));
      return reported?.requests ? { ...summary, usage: { ...summary.usage, reported, turns: reported.requests } } : summary;
    };
    let acceptingSteers = true;
    let stopRequest: SubagentStopRequestSource | undefined;
    const steerSubmissions = new Set<number>();
    const active: ActiveChild = { taskId: options.taskId, id: item.id, identity: created.identity, summary, snapshot,
      steer: async (instruction, requestId, origin) => {
        const key = steerRequestKey(requestId);
        try {
          const receipt = await api.commit(async tx => {
            const existing = await readSteerByRequest(tx, created.id, key);
            if (existing) return existing;
            if (!acceptingSteers) return { unavailable: "child_cancelling" };
            const live = await tx.doc(LiveDoc, created.id);
            if (!live.run || live.run.afterRun !== undefined) return { unavailable: "conversation_idle" };
            await child.submit(tx, { type: "input", content: instruction, requestId: key, whenBusy: "steer",
              whenIdle: "reject", entry: { kind: STEER_ENTRY_KIND, data: { requestId, origin } } });
            await recordSteerInstruction(tx, created.id, key, instruction, origin);
            return null;
          }, context);
          if (receipt && "unavailable" in receipt) return steerUnavailable(requestId, receipt.unavailable);
          const committed = receipt ?? await api.commit(tx => readSteerByRequest(tx, created.id, key), context);
          if (!committed) throw new Error("找不到原生引导回执");
          steerSubmissions.add(committed.submissionId);
          summary.steerCount = steerSubmissions.size;
          options.onChange?.();
          return { ok: true, receipt: committed };
        } catch (error) {
          if (error instanceof ConversationIdle) return steerUnavailable(requestId, "conversation_idle");
          throw error;
        }
      }, cancel: source => {
        stopRequest ??= source;
        acceptingSteers = false;
        return child.abort(context);
      },
      transcript: async () => ({ record: snapshot(), entries: (await messages()).map(message => ({ ts: message.timestamp, type: "message_end", message })), ended: false }) };
    const watch = await api.watchDoc(LiveDoc, created.id, context);
    if (watch) {
      stopWatch = () => watch.stop();
      watch.start(async () => {
        summary.updatedAt = api.now();
        options.onChange?.();
      });
    }
    // D-1: Durable dedupes input by conversation-scoped requestId. A retry must submit under a new
    // one, otherwise the resubmission returns the original failed receipt and the retry does nothing.
    const requestId = attempt > 0 ? `subagent:${item.id}:retry:${attempt}` : `subagent:${item.id}`;
    const submission = await child.submit({ type: "input", content: item.task, requestId }, context);
    activeChildren.set(item.id, active); options.onChange?.();
    let timedout = false;
    {
      const timeout = new AbortController();
      const remaining = created.identity.deadline - api.now();
      if (remaining <= 0) timeout.abort(new Error("Subagent time limit reached"));
      else timer = setTimeout(() => timeout.abort(new Error("Subagent time limit reached")), remaining);
      try {
        const waitContext = withAbortSignal(timeout.signal, context);
        await submission.wait(waitContext);
        await child.waitForIdle(waitContext);
      }
      catch (error) {
        if (context.abortSignal?.aborted || !timeout.signal.aborted) throw error;
        timedout = true;
        await active.cancel("deadline");
      }
    }
    acceptingSteers = false;
    const receipt = await submission.status(context);
    // Pi can retain queued input after a failed run. This task-scoped child will close,
    // so settle its queued steers on the native line before releasing the live index.
    const failure = await api.commit(async tx => {
      const inbox = await tx.doc(InboxDoc, created.id);
      const failure = (await tx.doc(LiveDoc, created.id)).runFailure;
      const reason = receipt.status === "unanswered" || failure ? "run_failed" : "child_finished_before_processing";
      for (let index = inbox.items.length - 1; index >= 0; index--) {
        const item = inbox.items[index];
        if (item.mode !== "steer" || item.entry?.kind !== STEER_ENTRY_KIND) continue;
        tx.settleSubmission(item.id, { status: "unanswered", reason });
        inbox.items.splice(index, 1);
      }
      return failure && { reason: failure.reason, detail: typeof failure.detail === "string" ? failure.detail : undefined };
    }, context);
    const persisted = await messages();
    result.messages = persisted.map(message => ({ ...message, content: typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content.map(part => ({ ...part })) }));
    const assistants = persisted.filter(message => message.role === "assistant");
    const final = assistants.at(-1);
    const reason = receipt.status === "unanswered" ? receipt.reason : failure?.reason;
    result.status = timedout ? "timedout" : reason === "aborted" ? "cancelled"
      : !reason && receipt.status === "done" && final?.stopReason === "stop" ? "completed" : "failed";
    result.exitCode = result.status === "completed" ? 0 : 1;
    result.stopReason = final?.stopReason;
    if (result.exitCode) {
      if (timedout) result.errorMessage = "Subagent time limit reached";
      else if (reason) {
        const detail = receipt.status === "unanswered" ? receipt.detail : failure?.detail;
        result.errorMessage = final?.errorMessage || (typeof detail === "string" ? detail.trim() : "") || reason;
      }
      else if (final?.stopReason === "length") result.errorMessage = "子代理回复达到模型输出长度上限，报告被截断";
      else result.errorMessage = final?.errorMessage || "Subagent did not complete";
    }
    result.stderr = result.errorMessage ?? "";
    for (const message of assistants) addChildResponse(result.usage, message);
    result.nativeConversationId = created.id;
    result.durationMs = Math.max(0, api.now() - created.identity.startedAt);
    withWriteConflicts(result);
    const completion = { submissionId: receipt.id, status: resultOutcome(result) === "blocked" ? "blocked" : result.status, durationMs: result.durationMs,
      ...(stopRequest && {stopRequest}) };
    try {
      await api.commit(async tx => { (await tx.doc(DurableSubagentIdentity, created.id)).completion = completion; }, context);
    } catch (error) {
      if (context.abortSignal?.aborted) throw error;
      console.warn("[DurableSubagent] 未写入结束来源", item.id, error);
    }
    const reported = options.observedUsage?.(String(created.id));
    if (reported?.requests && reported.requests === result.usage.turns) result.usage.reported = reported;
    return { result, deadline: created.identity.deadline };
  } catch (error) {
    // Closing the Harness must leave the safe tool pending. Turning cancellation into a result would lose recovery.
    if (context.abortSignal?.aborted) throw error;
    const result = empty();
    result.status = "failed"; result.exitCode = 1;
    result.stderr = result.errorMessage = error instanceof Error ? error.message : String(error);
    return { result: withWriteConflicts(result) };
  } finally {
    if (timer) clearTimeout(timer);
    await stopWatch?.();
    if (guardedConversation !== undefined) releaseGuardedChildWrite(guardedConversation, options.taskId);
    // Documents live in the durable child. Remove only this empty directory.
    if (privateDirectory && !context.abortSignal?.aborted) await rmdir(privateDirectory).catch(() => {});
    activeChildren.delete(item.id); options.onChange?.();
  }
}

function finalText(messages: SingleResult["messages"]): string {
  const last = [...messages].reverse().find(message => message.role === "assistant");
  return last?.content.filter(part => part.type === "text").map(part => part.text ?? "").join("\n") ?? "";
}

export function createDurableReadOnlyTools(cwd: string): ToolRegistration[] {
  const ls = createLsTool(cwd), find = createFindTool(cwd), grep = createGrepTool(cwd);
  const boundCwd = async (api: ToolExecutionApi, context: Context) => {
    const bound = (await api.agent(context)).cwd;
    if (!bound) throw new Error("Subagent workspace is missing");
    return bound;
  };
  return [
    defineTool({ name: ls.name, description: ls.description, parameters: ls.parameters, replay: "safe", execute: async (args, api, context) => {
      const result = await createLsTool(await boundCwd(api, context)).execute(api.callId, args, context.abortSignal);
      return { output: result.content, details: copyJson(result.details ?? null, { omitUndefinedProperties: true }) };
    } }),
    defineTool({ name: find.name, description: find.description, parameters: find.parameters, replay: "safe", execute: async (args, api, context) => {
      const result = await createFindTool(await boundCwd(api, context)).execute(api.callId, args, context.abortSignal);
      return { output: result.content, details: copyJson(result.details ?? null, { omitUndefinedProperties: true }) };
    } }),
    defineTool({ name: grep.name, description: grep.description + " Source searches skip node_modules by default. Supply a dependency path or an explicit glob to search dependencies.", parameters: grep.parameters, replay: "safe", execute: async (args, api, context) => {
      const directory = await boundCwd(api, context);
      const searchPath = resolve(directory, args.path ?? ".");
      const includeDependencies = searchPath.split(/[\\/]/).some(part => part.toLowerCase() === "node_modules");
      const query = args.glob || includeDependencies ? args : { ...args, glob: "!**/node_modules" };
      const result = await createGrepTool(directory).execute(api.callId, query, context.abortSignal);
      return { output: result.content, details: copyJson(result.details ?? null, { omitUndefinedProperties: true }) };
    } }),
  ];
}

/** copyJson validates the tree and omits optional properties at the persistence boundary. */
function json<T>(value: T): JsonRepresentation<T> {
  return copyJson(value, { omitUndefinedProperties: true }) as JsonRepresentation<T>;
}
