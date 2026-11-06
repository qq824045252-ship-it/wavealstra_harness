import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { DEFAULT_SUBAGENT_TIMEOUT_MS, parseSubagentExecutionPolicy, type SubagentExecutionPolicy } from "../../../shared/subagent-execution-policy";
import type { ModelReasoningPreferenceDto } from "../../../shared/model-metadata";
import type { AgentScope } from "./agents";
import type { PreparedSubagentWorkspace, SubagentIsolation } from "./worktree";
export type SubagentStatus = "idle" | "running" | "completed" | "failed" | "cancelled" | "timedout" | "interrupted" | "error";

export interface MessageLike {
  role: string;
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number }; totalTokens?: number };
  model?: string;
  stopReason?: string;
}

export const MAX_PARALLEL_TASKS = 200;
export const MAX_CONCURRENCY = 100;
export const DEFAULT_TASK_TIMEOUT_MS = DEFAULT_SUBAGENT_TIMEOUT_MS;
export const DEFAULT_CONFIRM_TOOLS = ["write", "edit"] as const;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const PER_PARALLEL_TOTAL_OUTPUT_CAP = 400 * 1024;

export interface SingleResult {
  agent: string;
  agentSource: "user" | "project" | "unknown";
  task: string;
  subagentId: string;
  /** 可选显示名（纯展示；允许中文；不参与身份/文件名/worker 参数） */
  displayName?: string;
  status: SubagentStatus;
  exitCode: number;
  messages: MessageLike[];
  stderr: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; contextTokens: number; turns: number };
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
  workerReused?: boolean;
  /** 模型解析/降级诊断（如裸名解析、模型降级） */
  diagnostics?: string[];
  workspace?: PreparedSubagentWorkspace;
  requestedModel?: string;
  resolvedModel?: string;
  resolvedThinking?: string;
  /** 命中的 subagent.json 角色别名与候选清单（未命中角色时为空） */
  modelRole?: string;
  roleCandidates?: string[];
  timeoutMs?: number;
  timeoutSource?: "settings" | "invocation";
}


export function isFailedResult(result: SingleResult): boolean {
  return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

/**
 * single 模式结果尾部的 id / 显示名标记行。
 * 名字行走同一条文本桥，但只在实例真实存在时输出（避免失败在创建前留下孤立标记）。
 */
export function buildSubagentIdLine(result: Pick<SingleResult, "subagentId" | "displayName">): string {
  const nameLine = result.displayName && result.subagentId ? `> subagent-name: ${result.displayName}\n` : "";
  return `\n\n${nameLine}> subagent: ${result.subagentId}（本次任务内临时实例，已结束）`;
}


export function getResultOutput(result: SingleResult): string {
  // A run that produced text and then failed still carries that text in `messages`; dropping it
  // forced the caller to redo the whole task. Keep the error line first, then what was produced.
  const produced = getFinalOutput(result.messages);
  const output = !isFailedResult(result)
    ? produced || "(no output)"
    : [result.errorMessage || result.stderr, produced ? `--- 失败前已产出的内容 ---\n${produced}` : ""].filter(Boolean).join("\n\n") || "(no output)";
  const evidence = [
    result.resolvedModel ? `Resolved model: ${result.resolvedModel}${result.resolvedThinking ? `; thinking: ${result.resolvedThinking}` : ""}` : "",
    result.model ? `Observed model: ${result.model}` : "",
    result.timeoutMs ? `Run time limit: ${result.timeoutMs / 1000}s (${result.timeoutSource})` : "",
    result.workspace?.kind === "worktree"
      ? `Retained worktree: ${result.workspace.cwd}\nBranch: ${result.workspace.branch}\nBase: ${result.workspace.baseCommit}\nReceipt: ${result.workspace.receiptPath}`
      : result.workspace
        // D-5: an un-isolated run used to be invisible; callers could not tell "isolated copy" from
        // "wrote straight into the original directory". Keep the fact on the same evidence lines.
        ? `Workspace: shared (${result.workspace.cwd}); writes land in the original directory, not an isolated copy`
        : "",
    ...(result.diagnostics ?? []),
  ].filter(Boolean);
  return [...evidence, output].join("\n\n");
}

export function getFinalOutput(messages: MessageLike[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text" && part.text) return part.text;
      }
    }
  }
  return "";
}

/** 单次 parallel 调用的每任务输出上限：总量封顶后按任务数均分，任务少时保持 50KB。 */
export function parallelPerTaskOutputCap(taskCount: number): number {
  if (!Number.isFinite(taskCount) || taskCount <= 0) return PER_TASK_OUTPUT_CAP;
  return Math.max(2 * 1024, Math.min(PER_TASK_OUTPUT_CAP, Math.floor(PER_PARALLEL_TOTAL_OUTPUT_CAP / taskCount)));
}

export function truncateParallelOutput(output: string, cap = PER_TASK_OUTPUT_CAP): string {
  const byteLength = Buffer.byteLength(output, "utf8");
  if (byteLength <= cap) return output;
  let truncated = output.slice(0, cap);
  while (Buffer.byteLength(truncated, "utf8") > cap) truncated = truncated.slice(0, -1);
  return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}


export function resolveParallelLimits(input?: { maxParallelTasks?: unknown; maxConcurrency?: unknown }): {
  maxParallelTasks: number;
  maxConcurrency: number;
} {
  const toInt = (value: unknown): number | undefined => {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    const int = Math.floor(value);
    return int >= 1 ? int : undefined;
  };
  const maxParallelTasks = Math.min(toInt(input?.maxParallelTasks) ?? MAX_PARALLEL_TASKS, MAX_PARALLEL_TASKS);
  // 并发不可能超过总任务数
  const maxConcurrency = Math.min(toInt(input?.maxConcurrency) ?? MAX_CONCURRENCY, MAX_CONCURRENCY, maxParallelTasks);
  return { maxParallelTasks, maxConcurrency };
}

export interface SubagentConfig extends SubagentExecutionPolicy {
  agentScope?: AgentScope;
  confirmProjectAgents?: boolean;
  disabledAgents?: string[];
  allowTools?: string[];
  denyTools?: string[];
  confirmTools?: string[];
  permissionMode?: "default" | "readonly" | "auto";
  /** 默认模型（provider/id 或裸名；三级优先级第 2 级） */
  defaultModel?: string;
  /** Main 派生的 Pi CLI transport；不是用户偏好。 */
  transportThinking?: string;
  /** transportThinking 绑定的目标模型。 */
  transportThinkingModelId?: string;
  /** subagent.json 可选：单次 parallel 的任务上限（只能 ≤ 200） */
  maxParallelTasks?: number;
  /** subagent.json 可选：同时运行的 worker 数（只能 ≤ 100 且 ≤ maxParallelTasks） */
  maxConcurrency?: number;
}

export function loadSubagentConfig(): SubagentConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(getAgentDir(), "subagent.json"), "utf-8")) as Record<string, unknown>;
    const scope = raw.agentScope;
    const confirm = raw.confirmProjectAgents;
    const disabled = raw.disabledAgents;
    const execution = parseSubagentExecutionPolicy(raw);
    const strList = (v: unknown): string[] | undefined =>
      Array.isArray(v) ? v.filter((d): d is string => typeof d === "string") : undefined;
    return {
      agentScope: scope === "project" || scope === "both" || scope === "user" ? scope : undefined,
      confirmProjectAgents: typeof confirm === "boolean" ? confirm : undefined,
      disabledAgents: strList(disabled),
      ...execution,
      allowTools: strList(raw.allowTools),
      denyTools: strList(raw.denyTools),
      confirmTools: strList(raw.confirmTools),
      permissionMode:
        raw.permissionMode === "readonly" || raw.permissionMode === "auto" ? raw.permissionMode : undefined,
      defaultModel: typeof raw.defaultModel === "string" && raw.defaultModel.trim() ? raw.defaultModel.trim() : undefined,
      transportThinking:
        typeof raw.transportThinking === "string" && raw.transportThinking.trim()
          ? raw.transportThinking.trim()
          : undefined,
      transportThinkingModelId:
        typeof raw.transportThinkingModelId === "string" && raw.transportThinkingModelId.trim()
          ? raw.transportThinkingModelId.trim()
          : undefined,
      // 原样保留，交给 resolveParallelLimits 统一做上限与交叉约束（并发 ≤ 任务数）
      maxParallelTasks: typeof raw.maxParallelTasks === "number" ? raw.maxParallelTasks : undefined,
      maxConcurrency: typeof raw.maxConcurrency === "number" ? raw.maxConcurrency : undefined,
    };
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    return {};
  }
}


export function loadHostDefaults(cwd = process.cwd()): { defaultModelId?: string; defaultProvider?: string } {
  try {
    const settings = SettingsManager.create(cwd, getAgentDir());
    const defaultProvider = settings.getDefaultProvider() ?? "";
    const defaultModel = settings.getDefaultModel() ?? "";
    return {
      defaultModelId: defaultProvider && defaultModel ? `${defaultProvider}/${defaultModel}` : undefined,
      defaultProvider: defaultProvider || undefined,
    };
  } catch {
    return {};
  }
}


const ExecutionFields = {
  model: Type.Optional(Type.String({ minLength: 1, description: "Exact provider/model, or inherit-parent/auto for the current parent model. An unavailable explicit choice fails; it never switches models." })),
  reasoning: Type.Optional(Type.Object({
    enabled: Type.Optional(Type.Boolean()),
    effort: Type.Optional(Type.String({ minLength: 1 })),
    budgetTokens: Type.Optional(Type.Integer({ minimum: 1 })),
  }, { additionalProperties: false, description: "Native reasoning preference. Unsupported or lossy subprocess settings fail explicitly." })),
  isolation: Type.Optional(StringEnum(["auto", "shared", "worktree"] as const, { description: "auto isolates parallel write-capable tasks in retained Git worktrees. worktree requires a clean repository. shared explicitly opts into the supplied cwd." })),
};

export interface DelegatedExecutionOptions {
  model?: string;
  reasoning?: ModelReasoningPreferenceDto;
  isolation?: SubagentIsolation;
}

/**
 * 显示名参数（单任务 / tasks[] / chain[] 三处共用）。
 * 纯展示字段：允许中文；不参与身份、唯一性、文件名或 worker 参数。
 */
const DisplayNameField = Type.Optional(
  Type.String({
    // 不做 minLength：空串在归一化阶段变成 undefined（回退 role/id），不因空值拒绝整次委派。
    maxLength: 200,
    description: "Display-only name shown in the subagent list and panel (any language, e.g. 皮卡丘). Omit to auto-assign a random unused Gen-1 Pokémon name in Simplified Chinese. Identity stays the ASCII subagentId; duplicates allowed; steering still uses subagentId.",
  }),
);

const TaskItem = Type.Object({
  ...ExecutionFields,
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task handoff: goal; allowed file scope; constraints; known facts with source paths; acceptance commands/conditions; artifact paths. Return conclusion, changed files, execution evidence, unverified items" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
  subagentId: Type.Optional(Type.String({ description: "Reuse/create a persistent subagent with this id" })),
  displayName: DisplayNameField,
});

const ChainItem = Type.Object({
  ...ExecutionFields,
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
  subagentId: Type.Optional(Type.String({ description: "Reuse/create a persistent subagent with this id" })),
  displayName: DisplayNameField,
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
  description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
  default: "user",
});

export const SubagentParams = Type.Object({
  ...ExecutionFields,
  agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
  task: Type.Optional(Type.String({ description: "Task handoff: goal; allowed scope; constraints; facts/source paths; acceptance commands; artifact paths (single mode)" })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
  chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
  agentScope: Type.Optional(AgentScopeSchema),
  confirmProjectAgents: Type.Optional(
    Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
  ),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
  subagentId: Type.Optional(
    Type.String({ description: "Persistent subagent id: reuse an existing one (same session/history) or create with this id" }),
  ),
  displayName: DisplayNameField,
  timeout_ms: Type.Optional(
    Type.Integer({ description: "Requested total run time in ms (1s..3600s). Honored only if Settings > Models > Subagent execution limits allows per-call overrides. Fixed settings take precedence; default 600s.", minimum: 1000, maximum: 3_600_000 }),
  ),
});

export const ListParams = Type.Object({
  agent: Type.Optional(Type.String({ description: "Filter by role/agent name" })),
  status: Type.Optional(
    StringEnum(["idle", "running", "completed", "failed", "cancelled", "timedout", "interrupted", "error"] as const, {
      description: "Filter by status",
    }),
  ),
  limit: Type.Optional(Type.Integer({ description: "Max entries (newest first). Default: 20.", minimum: 1, maximum: 200 })),
});

export const SteerParams = Type.Object({
  subagentId: Type.String({ description: "Persistent subagent id from subagent_list / subagent result" }),
  instruction: Type.String({ description: "Additional instruction to deliver" }),
});
