/**
 * Subagent 扩展（MyBuddy 版）
 *
 * 架构（2026-08 收敛）：Subagent = Task-scoped disposable worker（非长期 Agent）。
 * - 每个实例绑定父 Task 作用域（pi 会话 sessionId）；terminal（RESULT/FAILED/CANCELLED）
 *   或父 Task 结束即销毁：kill worker、删 session 文件与 transcript、移除 active 记录。
 * - worker 底层：`pi --mode rpc` 子进程（node.exe + CLI JS，shell:false）。
 * - 注册表：active-only（内存 + active.json 最小快照，仅用于崩溃后 GC 遗留）；无历史。
 * - 权限：子代理工具白名单由宿主 permissionMode + 角色 frontmatter 推导
 *   （引擎级 --tools/--exclude-tools，进程外无弹窗审批）；递归工具恒排除 + 深度硬上限。
 * - 上下文契约：继承 cwd + 角色 systemPrompt + 任务文本；Shared Context/Memory/
 *   Plan/策略不继承（写进子代理系统提示，不伪造未知）。
 *
 * 工具：
 *   subagent        single/parallel/chain（每次创建新的 Task-scoped 临时实例）
 *   subagent_list   当前父 Task 的 active 实例
 *   subagent_steer  当前父 Task active 实例的引导（已结束 → 明确拒绝）
 */

import { assertSubagentModelAllowed, DEFAULT_SUBAGENT_TIMEOUT_MS, filterSubagentModels, parseSubagentExecutionPolicy, resolveSubagentTimeout, type SubagentExecutionPolicy } from "../../../shared/subagent-execution-policy";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { assertModelAdmission } from "../../agent/ModelInvocationAdmission";
import { type ModelRuntime, SettingsManager, resolveModelScopeWithDiagnostics } from "@earendil-works/pi-coding-agent";
import { StringEnum, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { AgentConfig, AgentScope } from "./agents.ts";
import { discoverAgents } from "./agents.ts";
import {
  getAgentDirCompat,
  getConfigDirNameCompat,
  getMarkdownThemeCompat,
  parseFrontmatterCompat,
  withFileMutationQueueCompat,
} from "./compat.ts";
import { computeChildTools, type ToolPolicyResult } from "./policy.ts";
import {
  assignDiverseModels,
  DIVERSE_SUBAGENT_ROLE,
  resolveSubagentSelection,
} from "./selection.ts";
import { prepareSubagentWorkspace, type PreparedSubagentWorkspace, type SubagentIsolation } from "./worktree.ts";
import { resolveBatchDisplayNames } from "./display-names.ts";
import type { ModelReasoningPreferenceDto } from "../../../shared/model-metadata";
import {
  normalizeSubagentDisplayName,
  type SubagentModelOptionLike,
} from "../../../shared/subagent-model-config";
import { READONLY_TOOLS } from "./policy.ts";
import {
  buildContextBlock,
  appendWorkspaceNotes,
  buildSystemPromptContent,
  readOptionalSharedContext,
  inspectSharedContext,
  SHARED_CONTEXT_MAX_BYTES,
} from "./context.ts";
import {
  MAX_SUBAGENT_DEPTH,
  SubagentRuntime,
  type MessageLike,
  type RunOutcome,
  type SubagentRecord,
} from "./runtime.ts";
import { resolvePiCliJs, resolvePiInvocation, resolveSystemNode, tryRequireResolve } from "./invocation.ts";
import type { SubagentStatus } from "./registry.ts";

/**
 * 并行上限（2026-10 用户要求：总数 200、同时干活 100、其余排队）。
 *
 * 为什么不是「无限」：每个 subagent 是真实 Pi RPC 子进程 + 独立 session，
 * 200 条 tasks 是单次 parallel 调用允许声明的上限，100 是同时存活的进程数，
 * 剩下 100 条在队列里，前面完成一个补位一个（mapWithConcurrencyLimit）。
 *
 * 代价（部署时需知）：
 *  - 100 个并发 Pi 子进程 ≈ 数十 GB 内存；机器不够时 OS 会 OOM，表现为 run 失败而非静默丢任务。
 *  - 100 个并发模型请求容易撞 provider 速率限制（429），失败会逐个体现在结果里。
 *  - 主模型要读回全部结果，所以下面用 PER_PARALLEL_TOTAL_OUTPUT_CAP 给总量封顶。
 */
export const MAX_PARALLEL_TASKS = 200;
export const MAX_CONCURRENCY = 100;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
/**
 * 一次 parallel 返回给主模型的输出总量上限。
 * 单任务 50KB × 200 = 10MB 会直接撑爆上下文，因此总量封顶后按任务数均分
 * （任务少时仍是每任务 50KB，行为不变）。
 */
const PER_PARALLEL_TOTAL_OUTPUT_CAP = 400 * 1024;
export const DEFAULT_TASK_TIMEOUT_MS = DEFAULT_SUBAGENT_TIMEOUT_MS;

export const DEFAULT_CONFIRM_TOOLS = ["write", "edit"] as const;

// ---------- 格式化/渲染辅助（沿用既有实现） ----------

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; contextTokens?: number; turns?: number },
  model?: string,
): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

// ---------- 结果模型（工具 details + 渲染） ----------

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

interface SubagentDetails {
  mode: "single" | "parallel" | "chain";
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  results: SingleResult[];
}

function outcomeToResult(
  outcome: RunOutcome,
  base: { agent: string; agentSource: SingleResult["agentSource"]; task: string; step?: number; displayName?: string },
): SingleResult {
  const failed = outcome.status !== "completed";
  return {
    agent: base.agent,
    agentSource: base.agentSource,
    task: base.task,
    subagentId: outcome.subagentId,
    displayName: base.displayName,
    status: outcome.status,
    exitCode: failed ? 1 : 0,
    messages: outcome.messages,
    stderr: outcome.errorMessage ?? "",
    usage: { ...outcome.usage },
    model: outcome.model,
    stopReason: outcome.stopReason,
    errorMessage: outcome.errorMessage,
    step: base.step,
    workerReused: outcome.workerReused,
    diagnostics: outcome.diagnostics,
  };
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

/** 当前 Task 内 active 子代理已占用的显示名（自动分配时避开）。 */
function activeDisplayNames(runtime: SubagentRuntime, scope: string): string[] {
  return runtime
    .listActive(scope)
    .map((record) => record.displayName)
    .filter((name): name is string => Boolean(name));
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
      ? `Retained worktree: ${result.workspace.cwd}\nBranch: ${result.workspace.branch}\nBase: ${result.workspace.baseCommit}\nReceipt: ${result.workspace.receiptPath}` : "",
    ...(result.diagnostics ?? []),
  ].filter(Boolean);
  return [...evidence, output].join("\n\n");
}

function getFinalOutput(messages: MessageLike[]): string {
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

function truncateParallelOutput(output: string, cap = PER_TASK_OUTPUT_CAP): string {
  const byteLength = Buffer.byteLength(output, "utf8");
  if (byteLength <= cap) return output;
  let truncated = output.slice(0, cap);
  while (Buffer.byteLength(truncated, "utf8") > cap) truncated = truncated.slice(0, -1);
  return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: MessageLike[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text" && typeof part.text === "string") {
          items.push({ type: "text", text: part.text });
        } else if (
          part.type === "toolCall" &&
          typeof part.name === "string" &&
          part.arguments != null &&
          typeof part.arguments === "object"
        ) {
          items.push({ type: "toolCall", name: part.name, args: part.arguments as Record<string, any> });
        }
      }
    }
  }
  return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------- 配置 ----------

/**
 * 并行上限的生效值：默认就是 200 总数 / 100 并发，允许 subagent.json 往下调
 * （只能调小，不能超过上面的硬上限），给内存不足的机器一个不用重新打包的旋钮。
 */
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

interface SubagentConfig extends SubagentExecutionPolicy {
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

function loadSubagentConfig(): SubagentConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(getAgentDirCompat(), "subagent.json"), "utf-8")) as Record<string, unknown>;
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

function loadHostPermissionMode(): "default" | "readonly" | "auto" {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(getAgentDirCompat(), "settings.json"), "utf-8")) as Record<string, unknown>;
    const mode = raw.permissionMode;
    if (mode === "readonly" || mode === "auto" || mode === "default") return mode;
  } catch {
    /* ignore */
  }
  return "default";
}

/** 宿主全局默认只提供默认模型；reasoning preference 已改为按模型存储。 */
function loadHostDefaults(cwd = process.cwd()): { defaultModelId?: string; defaultProvider?: string } {
  try {
    const settings = SettingsManager.create(cwd, getAgentDirCompat());
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

let hostModelRuntime: ModelRuntime | null = null;
export function attachSubagentModelRuntime(runtime: ModelRuntime): void { hostModelRuntime = runtime; }
let workspaceNotesForScope: ((scope: string) => string) | undefined;
export function attachSubagentWorkspaceNotes(resolve: (scope: string) => string): void { workspaceNotesForScope = resolve; }
export function stopSubagentsForModelScopeChange(): void { runtimeInstance?.shutdownAll(); }

async function validateSubagentModel(modelId: string | undefined, cwd: string): Promise<void> {
  const runtime = hostModelRuntime;
  const model = runtime?.getModels().find((candidate) => `${candidate.provider}/${candidate.id}` === modelId);
  if (!runtime || !model) throw new Error("Subagent 缺少已准入的 Pi 模型");
  assertSubagentModelAllowed(loadSubagentConfig(), `${model.provider}/${model.id}`);
  await assertModelAdmission(runtime, SettingsManager.create(cwd, getAgentDirCompat()), model);
}

async function scopedSubagentModels(cwd: string) {
  const modelRuntime = hostModelRuntime;
  if (!modelRuntime) throw new Error("Subagent 的共享 Pi ModelRuntime 尚未初始化");
  const patterns = SettingsManager.create(cwd, getAgentDirCompat()).getEnabledModels();
  if (patterns === undefined) return { models: await modelRuntime.getAvailable(), diagnostics: [] as string[] };
  const scope = await resolveModelScopeWithDiagnostics(patterns, modelRuntime);
  return { models: scope.scopedModels.map((item) => item.model), diagnostics: scope.diagnostics.map((item) => item.message) };
}


function subagentModelOptions(models: Awaited<ReturnType<typeof scopedSubagentModels>>["models"]): SubagentModelOptionLike[] {
  return filterSubagentModels(models.map((model) => ({
    id: `${model.provider}/${model.id}`,
    metadata: {
      source: "pi" as const,
      reasoning: model.reasoning,
      reasoningOptions: [{ type: "effort" as const, values: getSupportedThinkingLevels(model) }],
    },
  })), loadSubagentConfig());
}

async function resolveDiverseAssignments(input: {
  mode: "parallel" | "chain";
  cwd: string | undefined;
  roles: Record<string, string[]> | undefined;
  requestedModels: Array<string | undefined>;
}): Promise<string[]> {
  if (input.requestedModels.some(model => !wantsDiverseRole(model))) {
    throw new Error("A diverse panel must select diverse for every task; mixed explicit selections are not a verified diverse panel");
  }
  const scoped = await scopedSubagentModels(path.resolve(input.cwd ?? process.cwd()));
  return assignDiverseModels({
    candidates: input.roles?.[DIVERSE_SUBAGENT_ROLE] ?? [],
    availableModels: subagentModelOptions(scoped.models),
    taskCount: input.requestedModels.length,
    mode: input.mode,
  });
}

function wantsDiverseRole(model: string | undefined): boolean {
  return model?.trim() === DIVERSE_SUBAGENT_ROLE;
}

// ---------- 系统提示文件 ----------

async function writeSystemPromptFile(role: AgentConfig, contextBlock: string): Promise<string> {
  const content = buildSystemPromptContent(role.systemPrompt, contextBlock);
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
  const safeName = role.name.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  await withFileMutationQueueCompat(filePath, async () => {
    await fs.promises.writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 });
  });
  return filePath;
}

function cleanupTempFile(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
    fs.rmdirSync(path.dirname(filePath));
  } catch {
    /* ignore */
  }
}

// ---------- 运行时单例 ----------

function makeInvocationResolver() {
  return (): { command: string; args: string[] } | null => {
    const execName = path.basename(process.execPath).toLowerCase();
    const isElectron = execName.includes("electron") || !!process.versions.electron;
    const bundledRoot = path.join(__dirname, "capabilities/subagent/runtime/pi-runtime.mjs").replace("app.asar", "app.asar.unpacked");
    const isPackaged = __dirname.includes("app.asar");
    if (isPackaged && !fs.existsSync(bundledRoot)) {
      // 打包后 app.asar 里的路径对子进程不可执行：runtime 必须落在 app.asar.unpacked。
      // 产物缺文件时给出可验证的诊断，而不是只留一句“请重新构建”。
      throw new Error(
        `安装包缺少原生 Pi 子代理 Runtime：${bundledRoot} 不存在。` +
          `这是 app.asar.unpacked 不完整的构建（开发模式 out/ 始终有该文件，dev 测试发现不了）；` +
          `请运行 pnpm -s verify:packaged 校验产物后重新安装，勿使用该构建。`,
      );
    }
    const resolved = fs.existsSync(bundledRoot)
      ? { command: resolveSystemNode(process.env, fs.existsSync) ?? "node", args: [bundledRoot] }
      : resolvePiInvocation(process.env, process.execPath, isElectron, tryRequireResolve, fs.existsSync);
    if (!resolved) return null;
    const candidates = [
      path.join(__dirname, "capabilities/subagent/worker-launcher.mjs").replace("app.asar", "app.asar.unpacked"),
      path.join(process.cwd(), "src/main/capabilities/subagent/worker-launcher.mjs"),
    ];
    const launcher = candidates.find((candidate) => fs.existsSync(candidate));
    if (!launcher || resolved.args.length !== 1) {
      throw new Error(
        `无法加载子代理模型准入入口（worker-launcher.mjs 不在 ${candidates.join(" 或 ")}，` +
          `Pi CLI 参数数 ${resolved.args.length}）；请运行 pnpm -s verify:packaged 校验产物后重新安装。`,
      );
    }
    return { command: resolved.command, args: [launcher, ...resolved.args] };
  };
}

/** Same worker entry resolution used by execution; diagnostics never start a model request. */
export function resolveBuiltinSubagentInvocation(): { command: string; args: string[] } | null {
  return makeInvocationResolver()();
}

let runtimeInstance: SubagentRuntime | null = null;
/** 当前父 Task 作用域（pi 会话 sessionId；MyBuddy task↔session 1:1） */
let currentScope = "";

export function getRuntime(): SubagentRuntime {
  if (!runtimeInstance) {
    runtimeInstance = new SubagentRuntime({
      validateModel: validateSubagentModel,
      baseDir: path.join(getAgentDirCompat(), "subagent"),
      env: process.env,
      resolveInvocation: makeInvocationResolver(),
    });
    // 启动 GC：清理历史临时数据（旧 registry/session/transcript 与崩溃遗留）
    runtimeInstance.gcLegacy();
    process.on("exit", () => {
      try {
        runtimeInstance?.shutdownAll();
      } catch {
        /* ignore */
      }
    });
  }
  return runtimeInstance;
}

/** 解析父 Task 作用域（sessionId 优先；无会话时用 cwd 兜底保证 scope 非空） */
function resolveScope(ctx: any): string {
  try {
    const sid = ctx?.sessionManager?.getSessionId?.();
    if (typeof sid === "string" && sid) return sid;
  } catch {
    /* ignore */
  }
  return `cwd:${ctx?.cwd ?? process.cwd()}`;
}

// ---------- IPC（渲染层 Subagent 面板；electron 不可用时降级为无 IPC） ----------

/** 与 src/main/agent/subagent-ipc-host.ts 的 SUBAGENT_IPC_HOST_KEY 对齐。 */
const SUBAGENT_IPC_HOST_KEY = "__mybuddySubagentIpcHost";

let ipcRegistered = false;
let ipcViaHost = false;
let ipcMainModule: any = null;
const ipcChannels: string[] = [];
let ipcRegistryUnsub: (() => void) | null = null;

interface SubagentIpcHostSlot {
  setBackend: (backend: SubagentIpcBackend | null) => void;
}

interface SubagentIpcBackend {
  active: () => unknown;
  transcript: (subagentId: string) => unknown;
  steer: (subagentId: string, instruction: string) => unknown | Promise<unknown>;
  cancel: (subagentId: string) => unknown | Promise<unknown>;
}

function getIpcHost(): SubagentIpcHostSlot | null {
  const slot = (globalThis as Record<string, unknown>)[SUBAGENT_IPC_HOST_KEY];
  if (slot && typeof slot === "object" && typeof (slot as SubagentIpcHostSlot).setBackend === "function") {
    return slot as SubagentIpcHostSlot;
  }
  return null;
}

function tryRequireElectron(): any {
  const req = typeof require === "function" ? require : (globalThis as { require?: NodeRequire }).require;
  if (typeof req !== "function") return null;
  try {
    return req("electron");
  } catch {
    return null;
  }
}

function attachRegistryPush(rt: SubagentRuntime, electronMod: any): void {
  ipcRegistryUnsub = rt.onRegistryChange(() => {
    try {
      const wins = electronMod?.BrowserWindow?.getAllWindows?.() ?? [];
      for (const w of wins) {
        w.webContents.send("subagent:event", { ts: Date.now() });
      }
    } catch {
      /* ignore */
    }
  });
}

function createIpcBackend(rt: SubagentRuntime): SubagentIpcBackend {
  return {
    active: () => (currentScope ? rt.listActive(currentScope).map((r) => toSummaryDto(r)) : []),
    transcript: (subagentId: string) => {
      const record = rt.get(subagentId, currentScope || undefined);
      if (!record) return { record: null, entries: [], ended: true };
      return { record: toSummaryDto(record), entries: rt.readTranscript(subagentId), ended: false };
    },
    steer: async (subagentId: string, instruction: string) => {
      if (typeof instruction !== "string" || !instruction.trim()) return { ok: false, message: "instruction 为空" };
      const record = rt.get(subagentId, currentScope || undefined);
      if (!record) {
        return { ok: false, delivered: "queued", message: `subagent 已结束或不属于当前任务（${subagentId}），请创建新的 subagent` };
      }
      let steerOpts: Parameters<typeof rt.steer>[2] = { permissionMode: loadHostPermissionMode() };
      const resolved = await resolveForRecord(record);
      steerOpts = { ...steerOpts, resolvedModel: resolved.model, resolvedThinking: resolved.thinking,
        modelSource: resolved.modelSource, thinkingSource: resolved.thinkingSource };
      const res = await rt.steer(subagentId, instruction.trim(), steerOpts);
      return { ok: res.ok, delivered: res.delivered, message: res.message };
    },
    cancel: (subagentId: string) => rt.cancel(subagentId),
  };
}

/**
 * 回滚本模块已注册的全部 IPC 副作用（host backend / channel handler + registry 监听）。
 * 事务语义：factory 执行中 registerIpc 之后的任何失败，或 registerIpc 自身
 * 中途失败（同名 channel 已被残留占用），都必须移除已注册部分，保证
 * 「注册后抛错 -> 无残留 -> 后续同名 handler 可注册」。
 */
export function rollbackIpc(): void {
  if (!ipcRegistered) return;
  ipcRegistered = false;
  if (ipcViaHost) {
    try {
      getIpcHost()?.setBackend(null);
    } catch {
      /* ignore */
    }
    ipcViaHost = false;
  }
  try {
    const ipcMain = ipcMainModule?.ipcMain;
    if (ipcMain) {
      for (const channel of ipcChannels) {
        try {
          ipcMain.removeHandler(channel);
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
  ipcChannels.length = 0;
  try {
    ipcRegistryUnsub?.();
  } catch {
    /* ignore */
  }
  ipcRegistryUnsub = null;
}

function registerIpc(): void {
  if (ipcRegistered) return; // P2-4：严格幂等，双加载不允许重复 handle 崩主进程
  const host = getIpcHost();
  const electronMod = tryRequireElectron();
  ipcMainModule = electronMod;
  const rt = getRuntime();
  const backend = createIpcBackend(rt);

  if (host) {
    ipcRegistered = true;
    ipcViaHost = true;
    try {
      attachRegistryPush(rt, electronMod);
      host.setBackend(backend);
    } catch (err) {
      rollbackIpc();
      throw err;
    }
    return;
  }

  const ipcMain = electronMod?.ipcMain;
  if (!ipcMain) return; // 非 Electron 环境（CLI/测试）无 IPC
  ipcRegistered = true;
  ipcViaHost = false;
  attachRegistryPush(rt, electronMod);
  try {
    ipcMain.handle("subagent:transcript", (_ev: unknown, subagentId: string) => backend.transcript(subagentId));
    ipcChannels.push("subagent:transcript");
    ipcMain.handle("subagent:steer", (_ev: unknown, subagentId: string, instruction: string) =>
      backend.steer(subagentId, instruction),
    );
    ipcChannels.push("subagent:steer");
    ipcMain.handle("subagent:cancel", (_ev: unknown, subagentId: string) => backend.cancel(subagentId));
    ipcChannels.push("subagent:cancel");
    ipcMain.handle("subagent:active", (_ev: unknown) => backend.active());
    ipcChannels.push("subagent:active");
  } catch (err) {
    // 事务：注册中途失败（如同名 channel 已被残留占用）→ 回滚已注册部分，不留污染
    rollbackIpc();
    throw err;
  }
}

/** 主进程预加载扩展时调用：不依赖 factory(pi)，尽早把 backend 接到宿主 handler。 */
export function installHostIpc(): void {
  registerIpc();
}

function toSummaryDto(r: SubagentRecord): Record<string, unknown> {
  return {
    subagentId: r.subagentId,
    role: r.role,
    displayName: r.displayName,
    roleSource: r.roleSource,
    roleDescription: r.roleDescription,
    project: r.project,
    status: r.status,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastPromptAt: r.lastPromptAt,
    lastResultAt: r.lastResultAt,
    runCount: r.runCount,
    steerCount: r.steerCount,
    pendingSteers: r.pendingSteers,
    lastResult: r.lastResult,
    usage: r.usage,
    sessionId: r.sessionId,
    pid: r.pid,
    model: r.model,
    lastTask: r.lastTask,
    depth: r.depth,
    workerAlive: r.pid != null,
    // 模型/思考：resolved（三级优先级解析值）+ 来源 + 子进程实证值
    resolvedModel: r.resolvedModel,
    resolvedThinking: r.resolvedThinking,
    modelSource: r.modelSource,
    thinkingSource: r.thinkingSource,
    actualModel: r.actualModel,
    actualThinking: r.actualThinking,
  };
}

async function resolveForRecord(record: SubagentRecord) {
  const model = record.resolvedModel ?? record.model;
  await validateSubagentModel(model, record.sourceProject ?? record.project);
  return {
    model, thinking: record.resolvedThinking,
    modelSource: record.modelSource, thinkingSource: record.thinkingSource,
    diagnostics: [] as string[],
  };
}

// ---------- 参数 schema ----------

const ExecutionFields = {
  model: Type.Optional(Type.String({ minLength: 1, description: "Exact provider/model, or inherit-parent/auto for the current parent model. An unavailable explicit choice fails; it never switches models." })),
  reasoning: Type.Optional(Type.Object({
    enabled: Type.Optional(Type.Boolean()),
    effort: Type.Optional(Type.String({ minLength: 1 })),
    budgetTokens: Type.Optional(Type.Integer({ minimum: 1 })),
  }, { additionalProperties: false, description: "Native reasoning preference. Unsupported or lossy subprocess settings fail explicitly." })),
  isolation: Type.Optional(StringEnum(["auto", "shared", "worktree"] as const, { description: "auto isolates parallel write-capable tasks in retained Git worktrees. worktree requires a clean repository. shared explicitly opts into the supplied cwd." })),
};

interface DelegatedExecutionOptions {
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

const SubagentParams = Type.Object({
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

const ListParams = Type.Object({
  agent: Type.Optional(Type.String({ description: "Filter by role/agent name" })),
  status: Type.Optional(
    StringEnum(["idle", "running", "completed", "failed", "cancelled", "timedout", "interrupted", "error"] as const, {
      description: "Filter by status",
    }),
  ),
  limit: Type.Optional(Type.Integer({ description: "Max entries (newest first). Default: 20.", minimum: 1, maximum: 200 })),
});

const SteerParams = Type.Object({
  subagentId: Type.String({ description: "Persistent subagent id from subagent_list / subagent result" }),
  instruction: Type.String({ description: "Additional instruction to deliver" }),
});

// ---------- 委派执行 ----------

async function runDelegatedStep(params: {
  runtime: SubagentRuntime;
  agent: AgentConfig;
  task: string;
  cwd: string | undefined;
  subagentId: string | undefined;
  /** 可选显示名（原始输入，函数内归一化） */
  displayName?: string;
  step: number | undefined;
  config: SubagentConfig;
  hostPermissionMode: "default" | "readonly" | "auto";
  parentDepth: number;
  timeout: ReturnType<typeof resolveSubagentTimeout>;
  signal: AbortSignal | undefined;
  onUpdate: ((partial: AgentToolResult<SubagentDetails>) => void) | undefined;
  makeDetails: (results: SingleResult[]) => SubagentDetails;
  taskScope: string;
  execution?: DelegatedExecutionOptions;
  parentModelId?: string;
  parallel?: boolean;
}): Promise<SingleResult> {
  const { runtime, agent, task, cwd, subagentId, step, config, hostPermissionMode, parentDepth, signal, onUpdate, makeDetails, taskScope } = params;
  const displayName = normalizeSubagentDisplayName(params.displayName);
  const { timeoutMs } = params.timeout;
  let workspace: PreparedSubagentWorkspace | undefined;
  let promptFile: string | null = null;
  let instanceId = "";
  try {
    signal?.throwIfAborted();

    const policy: ToolPolicyResult = computeChildTools({
      roleTools: agent.tools,
      permissionMode: config.permissionMode ?? hostPermissionMode,
      allowTools: config.allowTools,
      denyTools: config.denyTools,
      confirmTools: config.confirmTools ?? [...DEFAULT_CONFIRM_TOOLS],
    });

    const sourceCwd = path.resolve(cwd ?? process.cwd());
    const host = loadHostDefaults(sourceCwd);
    const scoped = await scopedSubagentModels(sourceCwd);
    const resolved = resolveSubagentSelection({
      invocation: params.execution,
      parentModelId: params.parentModelId,
      defaults: {
        roleModel: agent.model,
        defaultModel: config.defaultModel,
        transportThinking: config.transportThinking,
        transportThinkingModelId: config.transportThinkingModelId,
        globalDefaultModel: host.defaultModelId,
        globalDefaultProvider: host.defaultProvider,
      },
      availableModels: subagentModelOptions(scoped.models),
      roles: config.roles,
    });
    const resolvedModel = resolved.model;
    const resolvedThinking = resolved.thinking ?? undefined;
    const resolvedDiagnostics = [...resolved.diagnostics, ...scoped.diagnostics];
    await validateSubagentModel(resolvedModel, sourceCwd);
    workspace = await prepareSubagentWorkspace({
      cwd: sourceCwd,
      isolation: params.execution?.isolation,
      parallel: params.parallel ?? false,
      writable: policy.tools === null || policy.tools.some((tool) => !policy.excludeTools.includes(tool) && !(READONLY_TOOLS as readonly string[]).includes(tool)),
      baseDir: path.join(getAgentDirCompat(), "subagent-worktrees"),
      signal,
    });
    signal?.throwIfAborted();

    if (agent.systemPrompt.trim()) {
      const diagnostic = inspectSharedContext(sourceCwd);
      console.info("[subagent] shared-context", { injected: diagnostic.injected, bytes: diagnostic.bytes, reason: diagnostic.reason });
      const shared = diagnostic.text;
      const contextBlock = buildContextBlock({
        cwd: workspace.cwd,
        roleName: agent.name,
        roleDescription: agent.description,
        tools: policy.tools,
        permissionMode: config.permissionMode ?? hostPermissionMode,
        deniedTools: policy.denied,
        sharedContext: shared,
        sharedContextStatus: diagnostic,
        depth: parentDepth + 1,
      });
      promptFile = await writeSystemPromptFile(agent, contextBlock);
    }

    const workerTask = appendWorkspaceNotes(task, workspaceNotesForScope?.(taskScope) ?? "");
    signal?.throwIfAborted();
    const record = runtime.ensureSubagent({
      scope: taskScope, subagentId, displayName,
      role: agent.name, roleSource: agent.source, roleDescription: agent.description,
      project: workspace.cwd, sourceProject: sourceCwd,
      depth: parentDepth + 1, model: resolvedModel,
    });
    instanceId = record.subagentId;
    const outcome = await runtime.runPrompt(record.subagentId, {
      task: workerTask,
      timeoutMs,
      signal,
      systemPromptFile: promptFile ?? undefined,
      model: resolvedModel,
      thinking: resolvedThinking,
      modelSource: resolved.modelSource ?? undefined,
      thinkingSource: resolvedThinking ? resolved.thinkingSource ?? undefined : undefined,
      permissionMode: config.permissionMode ?? hostPermissionMode,
      toolArgs: { tools: policy.tools, excludeTools: policy.excludeTools },
      onUpdate: (snapshot) => {
        if (!onUpdate) return;
        const partial: SingleResult = {
          agent: agent.name,
          agentSource: agent.source,
          task,
          subagentId: record.subagentId,
          displayName,
          status: snapshot.status,
          exitCode: -1,
          messages: snapshot.messages,
          stderr: "",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
          model: resolvedModel,
          workspace,
          resolvedModel,
          resolvedThinking,
          ...params.timeout,
          step,
        };
        onUpdate({
          content: [{ type: "text", text: snapshot.finalText || "(running...)" }],
          details: makeDetails([partial]),
        });
      },
    });

    const result = outcomeToResult(outcome, { agent: agent.name, agentSource: agent.source, task, step, displayName });
    Object.assign(result, params.timeout);
    result.workspace = workspace;
    result.requestedModel = params.execution?.model;
    result.resolvedModel = resolvedModel;
    result.resolvedThinking = resolvedThinking;
    result.modelRole = resolved.modelRole;
    result.roleCandidates = resolved.roleCandidates;
    result.diagnostics = [...(result.diagnostics ?? []), ...resolvedDiagnostics];
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      agent: agent.name, agentSource: agent.source, task, step,
      subagentId: instanceId, displayName,
      status: signal?.aborted ? "cancelled" : "failed", exitCode: 1,
      messages: [], stderr: message, errorMessage: message, workspace, ...params.timeout,
      requestedModel: params.execution?.model,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    };
  } finally {
    if (promptFile) cleanupTempFile(promptFile);
  }
}

export default function (pi: any) {
  const runtime = getRuntime();

  // 父 Task 生命周期：会话开始 → 更新当前作用域；会话关闭 → 清理该作用域全部 child
  pi.on("session_start", async (_event: unknown, ctx: any) => {
    try {
      currentScope = resolveScope(ctx);
    } catch {
      /* ignore */
    }
  });
  pi.on("session_shutdown", () => {
    const scope = currentScope;
    currentScope = "";
    if (scope) {
      try {
        runtime.cleanupTask(scope);
      } catch {
        /* ignore */
      }
    }
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate bounded subtasks to task-scoped disposable Pi workers. Each invocation has a new session; terminal workers and transcripts are removed.",
      "Modes: single (agent+task), parallel (tasks array, up to " + MAX_PARALLEL_TASKS + " tasks, " + MAX_CONCURRENCY + " running concurrently, the rest queued), chain (sequential, {previous} placeholder).",
      "Select model and native reasoning per single call or per tasks/chain item. Exact provider/model choices fail when unavailable; inherit-parent/auto uses the current parent's model, not global defaults. Same-model workers are not cross-model review. Unsupported reasoning transport fails explicitly.",
      "Context boundary: the subagent inherits ONLY cwd + role system prompt + your task text. Project shared context / memory / plan / tag / skill / expert / connector policies are NOT inherited — compress and pass needed context inside the task (unknown stays unknown, no fabrication).",
      "Display names: every subagent gets a human-readable displayName automatically — a random unused Gen-1 Pokémon name in Simplified Chinese — unless you pass displayName for the call or for individual tasks/chain items. It is display-only: subagentId remains the identity used by subagent_steer, results, transcripts, and worker arguments.",
      "Permissions: subagent tool sets are derived from the host permission mode; default (no tools frontmatter) is a READ-ONLY analysis set (read/ls/find/grep). bash/write/edit require explicit tools frontmatter or allowTools — bash is a HIGH-PRIVILEGE tool (arbitrary command execution, no approval in subagent); recursion is hard-capped and subagent tools are disabled inside subagents.",
      "isolation:auto creates separate retained Git worktrees for parallel write-capable tasks. A clean committed repository is required; dirty or non-Git input fails before launch, without snapshotting. isolation:shared explicitly opts into shared cwd. Worktrees and branches are never automatically merged or deleted; result text/details contain receipts after success or failure. subagent_list shows active workers only; subagent_steer guides active work without changing its selected model.",
      `Default agent scope is "user" (from ${path.join(getAgentDirCompat(), "agents")} and ${path.join(getAgentDirCompat(), "plugins", "agents")}).`,
      `To enable project-local agents in ${getConfigDirNameCompat()}/agents, set agentScope: "both" (or "project").`,
      "Model choices must satisfy the subagent allowed-model list in Settings > Models > Subagent execution limits, including explicit, parent, role, and diverse selections.",
      "Total run time uses fixed settings (default 600s). timeout_ms is honored only when timeoutPolicy=allow-override; on timeout the worker is aborted then killed. Results report the effective limit and source.",
    ].join(" "),
    parameters: SubagentParams,

    async execute(_toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
      const config = loadSubagentConfig();
      const hostPermissionMode = loadHostPermissionMode();
      const timeout = resolveSubagentTimeout(config, params.timeout_ms);
      const agentScope: AgentScope = params.agentScope ?? config.agentScope ?? "user";
      const discovery = discoverAgents(ctx.cwd, agentScope);
      const disabled = new Set(config.disabledAgents ?? []);
      discovery.agents = discovery.agents.filter((a) => !disabled.has(a.name));
      const agents = discovery.agents;
      const resolveAgent = (name: unknown): AgentConfig | undefined => {
        if (typeof name !== "string" || !name.trim()) return undefined;
        const exact = agents.find((a) => a.name === name);
        if (exact) return exact;
        const alias = name.trim().toLowerCase();
        if (alias === "default" || alias === "assistant" || alias === "agent") {
          return agents.find((a) => a.name === "worker") ?? agents[0];
        }
        return undefined;
      };
      const confirmProjectAgents = params.confirmProjectAgents ?? config.confirmProjectAgents ?? true;
      // 生效并行上限：默认 200/100，subagent.json 可往下调（不会超过硬上限，并发也不会超过任务数）
      const limits = resolveParallelLimits({ maxParallelTasks: config.maxParallelTasks, maxConcurrency: config.maxConcurrency });
      // 诊断信息：把「到底查了哪些目录」写进错误文本，避免再出现「Unknown agent」却不知道去哪放文件
      const searchedAgentDirs = [
        discovery.productAgentsDir,
        discovery.userAgentsDir,
        agentScope === "project" || agentScope === "both" ? discovery.projectAgentsDir : null,
      ].filter((dir): dir is string => Boolean(dir));
      const unknownAgentMessage = (name: unknown): string => {
        const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
        return `Unknown agent: "${name}". Available: ${available}. Searched (agentScope=${agentScope}): ${searchedAgentDirs.join(" | ")}`;
      };

      const parentDepth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0") || 0;
      const parentModelId = ctx.model?.provider && ctx.model?.id ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const makeDetailsFn =
        (mode: "single" | "parallel" | "chain") =>
        (results: SingleResult[]): SubagentDetails => ({
          mode,
          agentScope,
          projectAgentsDir: discovery.projectAgentsDir,
          results,
        });
      if (parentDepth >= MAX_SUBAGENT_DEPTH) {
        return {
          content: [{ type: "text", text: `递归深度已达上限（${MAX_SUBAGENT_DEPTH}）。子代理不允许再次委派（subagent 工具已在子代理中禁用）。` }],
          details: makeDetailsFn("single")([]),
        };
      }

      const hasChain = (params.chain?.length ?? 0) > 0;
      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);
      const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

      if (modeCount !== 1) {
        const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
        return {
          content: [{ type: "text", text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}` }],
          details: makeDetailsFn("single")([]),
        };
      }

      if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
        const requestedAgentNames = new Set<string>();
        if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
        if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
        if (params.agent) requestedAgentNames.add(params.agent);
        const projectAgentsRequested = Array.from(requestedAgentNames)
          .map((name) => agents.find((a) => a.name === name))
          .filter((a): a is AgentConfig => a?.source === "project");
        if (projectAgentsRequested.length > 0) {
          const names = projectAgentsRequested.map((a) => a.name).join(", ");
          const dir = discovery.projectAgentsDir ?? "(unknown)";
          const ok = await ctx.ui.confirm(
            "Run project-local agents?",
            `Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
          );
          if (!ok)
            return {
              content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
              details: makeDetailsFn(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
            };
        }
      }

      const taskScope = resolveScope(ctx);
      // 自动显示名：避开当前 Task 内 active 子代理已占用的名字（显式 displayName 仍然优先）。
      const reservedDisplayNames = activeDisplayNames(runtime, taskScope);

      // ---- chain ----
      if (params.chain && params.chain.length > 0) {
        const chainDisplayNames = resolveBatchDisplayNames(params.chain, reservedDisplayNames);
        const results: SingleResult[] = [];
        let previousOutput = "";
        let diverseAssignments: string[] | null = null;
        if (wantsDiverseRole(params.model) || params.chain.some((step: any) => wantsDiverseRole(step.model))) {
          try {
            diverseAssignments = await resolveDiverseAssignments({
              mode: "chain",
              cwd: ctx.cwd,
              roles: config.roles,
              requestedModels: params.chain.map((step: { model?: string }) => step.model ?? params.model),
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { content: [{ type: "text", text: message }], details: makeDetailsFn("chain")([]), isError: true };
          }
        }
        for (let i = 0; i < params.chain.length; i++) {
          const step = params.chain[i];
          const agent = resolveAgent(step.agent);
          if (!agent) {
            const result = {
              agent: step.agent, agentSource: "unknown" as const, task: step.task, subagentId: "unknown",
              status: "failed" as const, exitCode: 1, messages: [], stderr: unknownAgentMessage(step.agent),
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }, step: i + 1,
            };
            results.push(result);
            return { content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): unknown agent` }], details: makeDetailsFn("chain")(results), isError: true };
          }
          const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
          const chainUpdate = onUpdate
            ? (partial: AgentToolResult<SubagentDetails>) => {
                const current = partial.details?.results[0];
                if (current) onUpdate({ content: partial.content, details: makeDetailsFn("chain")([...results, current]) });
              }
            : undefined;
          const result = await runDelegatedStep({
            runtime, agent, task: taskWithContext, cwd: step.cwd ?? ctx.cwd, subagentId: step.subagentId, step: i + 1,
            displayName: chainDisplayNames[i],
            config, hostPermissionMode, parentDepth, timeout, signal, onUpdate: chainUpdate,
            makeDetails: makeDetailsFn("chain"), taskScope,
            execution: {
              ...params,
              ...step,
              ...(diverseAssignments && (wantsDiverseRole(step.model) || (!step.model && wantsDiverseRole(params.model)))
                ? { model: diverseAssignments[i] }
                : {}),
            },
            parentModelId,
          });
          if (diverseAssignments) {
            result.modelRole = DIVERSE_SUBAGENT_ROLE;
            result.roleCandidates = config.roles?.[DIVERSE_SUBAGENT_ROLE];
          }
          results.push(result);
          if (isFailedResult(result)) {
            return { content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}):\n${results.map((result, index) => `Step ${index + 1}:\n${getResultOutput(result)}`).join("\n\n")}` }], details: makeDetailsFn("chain")(results), isError: true };
          }
          previousOutput = getFinalOutput(result.messages);
        }
        return { content: [{ type: "text", text: results.map((result, index) => `Step ${index + 1}:\n${getResultOutput(result)}`).join("\n\n") }], details: makeDetailsFn("chain")(results) };
      }

      // ---- parallel ----
      if (params.tasks && params.tasks.length > 0) {
        if (params.tasks.length > limits.maxParallelTasks)
          return { content: [{ type: "text", text: `Too many parallel tasks (${params.tasks.length}). Max is ${limits.maxParallelTasks} (concurrency ${limits.maxConcurrency}).` }], details: makeDetailsFn("parallel")([]) };
        const taskDisplayNames = resolveBatchDisplayNames(params.tasks, reservedDisplayNames);
        const allResults: SingleResult[] = new Array(params.tasks.length);
        let diverseAssignments: string[] | null = null;
        if (wantsDiverseRole(params.model) || params.tasks.some((t: any) => wantsDiverseRole(t.model))) {
          try {
            diverseAssignments = await resolveDiverseAssignments({
              mode: "parallel",
              cwd: ctx.cwd,
              roles: config.roles,
              requestedModels: params.tasks.map((task: { model?: string }) => task.model ?? params.model),
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { content: [{ type: "text", text: message }], details: makeDetailsFn("parallel")([]), isError: true };
          }
        }
        for (let i = 0; i < params.tasks.length; i++) {
          const t = params.tasks[i];
          allResults[i] = {
            agent: t.agent, agentSource: "unknown", task: t.task, subagentId: "", status: "running", exitCode: -1,
            messages: [], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
          };
        }
        const emitParallelUpdate = () => {
          if (!onUpdate) return;
          const done = allResults.filter((r) => r.exitCode !== -1).length;
          onUpdate({ content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done...` }], details: makeDetailsFn("parallel")([...allResults]) });
        };
        const results = await mapWithConcurrencyLimit(params.tasks, limits.maxConcurrency, async (t: any, index: number) => {
          const agent = resolveAgent(t.agent);
          if (!agent) {
            const result: SingleResult = {
              agent: t.agent, agentSource: "unknown", task: t.task, subagentId: "", status: "failed", exitCode: 1,
              messages: [], stderr: unknownAgentMessage(t.agent),
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
            };
            allResults[index] = result;
            emitParallelUpdate();
            return result;
          }
          const result = await runDelegatedStep({
            runtime, agent, task: t.task, cwd: t.cwd ?? ctx.cwd, subagentId: t.subagentId, step: undefined,
            displayName: taskDisplayNames[index],
            config, hostPermissionMode, parentDepth, timeout, signal,
            onUpdate: (partial) => {
              if (partial.details?.results[0]) { allResults[index] = partial.details.results[0]; emitParallelUpdate(); }
            },
            makeDetails: makeDetailsFn("parallel"), taskScope,
            execution: {
              ...params,
              ...t,
              ...(diverseAssignments && (wantsDiverseRole(t.model) || (!t.model && wantsDiverseRole(params.model)))
                ? { model: diverseAssignments[index] }
                : {}),
            },
            parentModelId, parallel: true,
          });
          if (diverseAssignments) {
            result.modelRole = DIVERSE_SUBAGENT_ROLE;
            result.roleCandidates = config.roles?.[DIVERSE_SUBAGENT_ROLE];
          }
          allResults[index] = result;
          emitParallelUpdate();
          return result;
        });
        const successCount = results.filter((r) => !isFailedResult(r)).length;
        // 200 条任务时每任务 2KB（400KB 总量），任务少时仍是 50KB —— 避免主模型上下文被结论淹没。
        const outputCap = parallelPerTaskOutputCap(results.length);
        const summaries = results.map((r) => {
          const output = truncateParallelOutput(getResultOutput(r), outputCap);
          const status = isFailedResult(r) ? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}` : "completed";
          const nameLine = r.displayName && r.subagentId ? `\n> subagent-name: ${r.displayName}` : "";
          return `### [${r.agent}] ${status} (id: ${r.subagentId})${nameLine}\n\n${output}`;
        });
        return { content: [{ type: "text", text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}` }], details: makeDetailsFn("parallel")(results), isError: successCount !== results.length };
      }

      // ---- single ----
      if (params.agent && params.task) {
        const agent = resolveAgent(params.agent);
        if (!agent) {
          const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
          return { content: [{ type: "text", text: unknownAgentMessage(params.agent) }], details: makeDetailsFn("single")([]) };
        }
        const singleDisplayName = resolveBatchDisplayNames([params], reservedDisplayNames)[0];
        const result = await runDelegatedStep({
          runtime, agent, task: params.task, cwd: params.cwd ?? ctx.cwd, subagentId: params.subagentId, step: undefined,
          config, hostPermissionMode, parentDepth, timeout, signal, onUpdate,
          makeDetails: makeDetailsFn("single"), taskScope, execution: params, parentModelId,
          displayName: singleDisplayName,
        });
        // 结果文本携带 instanceId（主对话 chip 可据此打开临时 Chat；实例在返回后已销毁）
        const idLine = buildSubagentIdLine(result);
        if (isFailedResult(result)) {
          return { content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${getResultOutput(result)}${idLine}` }], details: makeDetailsFn("single")([result]), isError: true };
        }
        return { content: [{ type: "text", text: `${getResultOutput(result)}${idLine}` }], details: makeDetailsFn("single")([result]) };
      }

      const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
      return { content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }], details: makeDetailsFn("single")([]) };
    },

    renderCall(args: any, theme: any, _context: any) {
      const scope: AgentScope = args.agentScope ?? "user";
      if (args.chain && args.chain.length > 0) {
        let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `chain (${args.chain.length} steps)`) + theme.fg("muted", ` [${scope}]`);
        for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
          const step = args.chain[i];
          const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
          const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
          text += `\n  ${theme.fg("muted", `${i + 1}.`)} ${theme.fg("accent", step.agent)}${theme.fg("dim", ` ${preview}`)}`;
        }
        if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
        return new Text(text, 0, 0);
      }
      if (args.tasks && args.tasks.length > 0) {
        let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `parallel (${args.tasks.length} tasks)`) + theme.fg("muted", ` [${scope}]`);
        for (const t of args.tasks.slice(0, 3)) {
          const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
          text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
        }
        if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
        return new Text(text, 0, 0);
      }
      const agentName = args.agent || "...";
      const idSuffix = args.subagentId ? theme.fg("dim", ` [id:${args.subagentId}]`) : "";
      const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
      let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", agentName) + idSuffix + theme.fg("muted", ` [${scope}]`);
      text += `\n  ${theme.fg("dim", preview)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result: any, { expanded }: { expanded: boolean }, theme: any, _context: any) {
      const details = result.details as SubagentDetails | undefined;
      if (!details || details.results.length === 0) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
      }
      const mdTheme = getMarkdownThemeCompat();
      const formatToolCall2 = (name: string, args: Record<string, unknown>) => {
        const argsStr = JSON.stringify(args);
        const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
        return theme.fg("accent", name) + theme.fg("dim", ` ${preview}`);
      };
      const statusIcon = (r: SingleResult) => {
        switch (r.status) {
          case "completed": return theme.fg("success", "✓");
          case "running": case "idle": return theme.fg("warning", "⏳");
          case "cancelled": case "timedout": return theme.fg("warning", "◐");
          default: return theme.fg("error", "✗");
        }
      };
      const renderItems = (items: DisplayItem[], limit?: number) => {
        const toShow = limit ? items.slice(-limit) : items;
        const skipped = limit && items.length > limit ? items.length - limit : 0;
        let text = "";
        if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
        for (const item of toShow) {
          if (item.type === "text") text += `${theme.fg("toolOutput", expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n"))}\n`;
          else text += `${theme.fg("muted", "→ ") + formatToolCall2(item.name, item.args)}\n`;
        }
        return text.trimEnd();
      };

      if (details.mode === "single" && details.results.length === 1) {
        const r = details.results[0];
        const icon = statusIcon(r);
        const displayItems = getDisplayItems(r.messages);
        const finalOutput = getFinalOutput(r.messages);
        if (expanded) {
          const container = new Container();
          let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
          if (r.subagentId) header += theme.fg("dim", ` id:${r.subagentId}`);
          if (r.status !== "completed") header += ` ${theme.fg("error", `[${r.status}]`)}`;
          container.addChild(new Text(header, 0, 0));
          if (r.errorMessage) container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
          if (r.diagnostics?.length)
            for (const d of r.diagnostics) container.addChild(new Text(theme.fg("warning", `⚠ ${d}`), 0, 0));
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
          container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
          if (displayItems.length === 0 && !finalOutput) container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
          else {
            for (const item of displayItems) {
              if (item.type === "toolCall")
                container.addChild(new Text(theme.fg("muted", "→ ") + formatToolCall2(item.name, item.args), 0, 0));
            }
            if (finalOutput) { container.addChild(new Spacer(1)); if (mdTheme) container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme)); else container.addChild(new Text(finalOutput.trim(), 0, 0)); }
          }
          const usageStr = formatUsageStats(r.usage, r.model);
          if (usageStr) { container.addChild(new Spacer(1)); container.addChild(new Text(theme.fg("dim", usageStr), 0, 0)); }
          return container;
        }
        let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
        if (r.subagentId) text += theme.fg("dim", ` id:${r.subagentId}`);
        if (r.status !== "completed") text += ` ${theme.fg("error", `[${r.status}]`)}`;
        if (r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
        if (r.diagnostics?.length) text += `\n${theme.fg("warning", r.diagnostics.map((d) => `⚠ ${d}`).join("\n"))}`;
        else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
        else {
          text += `\n${renderItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
          if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
        }
        const usageStr = formatUsageStats(r.usage, r.model);
        if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
        return new Text(text, 0, 0);
      }

      const aggregateUsage = (results: SingleResult[]) => {
        const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
        for (const r of results) {
          total.input += r.usage.input; total.output += r.usage.output;
          total.cacheRead += r.usage.cacheRead; total.cacheWrite += r.usage.cacheWrite;
          total.cost += r.usage.cost; total.turns += r.usage.turns;
        }
        return total;
      };
      const renderResultList = (title: string, results: SingleResult[]) => {
        const successCount = results.filter((r) => r.status === "completed").length;
        const icon = successCount === results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");
        if (expanded) {
          const container = new Container();
          container.addChild(new Text(icon + " " + theme.fg("toolTitle", theme.bold(title)) + theme.fg("accent", ` ${successCount}/${results.length}`), 0, 0));
          for (const r of results) {
            const rIcon = statusIcon(r);
            container.addChild(new Spacer(1));
            container.addChild(new Text(`${theme.fg("muted", `─── ${r.step ? `Step ${r.step}: ` : ""}`) + theme.fg("accent", r.agent)} ${rIcon}${r.subagentId ? theme.fg("dim", ` id:${r.subagentId}`) : ""}`, 0, 0));
            if (r.status !== "completed" && r.errorMessage) container.addChild(new Text(theme.fg("error", r.errorMessage), 0, 0));
            const displayItems = getDisplayItems(r.messages);
            for (const item of displayItems) {
              if (item.type === "toolCall") container.addChild(new Text(theme.fg("muted", "→ ") + formatToolCall2(item.name, item.args), 0, 0));
            }
            const finalOutput = getFinalOutput(r.messages);
            if (finalOutput) { container.addChild(new Spacer(1)); if (mdTheme) container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme)); else container.addChild(new Text(finalOutput.trim(), 0, 0)); }
            const u = formatUsageStats(r.usage, r.model);
            if (u) container.addChild(new Text(theme.fg("dim", u), 0, 0));
          }
          const usageStr = formatUsageStats(aggregateUsage(results));
          if (usageStr) { container.addChild(new Spacer(1)); container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0)); }
          return container;
        }
        let text = `${icon} ${theme.fg("toolTitle", theme.bold(title))}${theme.fg("accent", ` ${successCount}/${results.length}`)}`;
        for (const r of results) {
          text += `\n\n${theme.fg("muted", `─── ${r.step ? `Step ${r.step}: ` : ""}`)}${theme.fg("accent", r.agent)} ${statusIcon(r)}${r.subagentId ? theme.fg("dim", ` id:${r.subagentId}`) : ""}`;
          const displayItems = getDisplayItems(r.messages);
          if (displayItems.length === 0) text += `\n${theme.fg("muted", r.status === "running" ? "(running...)" : "(no output)")}`;
          else text += `\n${renderItems(displayItems, 5)}`;
        }
        const usageStr = formatUsageStats(aggregateUsage(results));
        if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
        if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
        return new Text(text, 0, 0);
      };

      if (details.mode === "chain") return renderResultList("chain", details.results);
      if (details.mode === "parallel") {
        const running = details.results.filter((r) => r.status === "running").length;
        const label = running > 0 ? `parallel (${details.results.length - running}/${details.results.length} done)` : "parallel";
        return renderResultList(label, details.results);
      }
      const text = result.content[0];
      return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
    },
  });

  pi.registerTool({
    name: "subagent_list",
    label: "Subagent List",
    description: [
      "List ACTIVE subagent instances of the current parent task (task-scoped, disposable).",
      "Instances are destroyed once their result is returned (RESULT/FAILED/CANCELLED) or the parent task ends; this tool only shows the currently running ones.",
      "Use before steering: check whether the subagent you want to steer is still active.",
    ].join(" "),
    parameters: ListParams,

    async execute(_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      const scope = resolveScope(ctx);
      const records = runtime
        .listActive(scope)
        .filter((r) => !params.agent || r.role === params.agent)
        .filter((r) => !params.status || r.status === params.status)
        .slice(0, params.limit ?? 20);
      const text = records.length === 0
        ? "No active subagents in the current task."
        : records.map((r) => {
            const usageStr = formatUsageStats(r.usage, r.model);
            return `- ${r.subagentId} | role=${r.role} | ${r.status}${r.lastTask ? ` | task: ${r.lastTask.slice(0, 60)}` : ""}${usageStr ? ` | ${usageStr}` : ""}`;
          }).join("\n");
      return {
        content: [{ type: "text", text }],
        details: { mode: "single", agentScope: "user", projectAgentsDir: null, results: [] } as SubagentDetails,
        extra: { records: records.map(toSummaryDto) },
      };
    },
  });

  pi.registerTool({
    name: "subagent_steer",
    label: "Subagent Steer",
    description: [
      "Send an additional instruction to an ACTIVE subagent instance of the current parent task (from subagent_list or a subagent result).",
      "Instances are task-scoped and disposable: once the result is returned or the parent task ends, steering is rejected with an explicit 'ended, create a new subagent' message.",
    ].join(" "),
    parameters: SteerParams,

    async execute(_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      // 仅当前父 Task 的 active 实例可 steer（跨 Task/已结束 → 明确拒绝）
      const taskScope = resolveScope(ctx);
      const record = runtime.get(params.subagentId, taskScope);
      if (!record) {
        return {
          content: [{ type: "text", text: `subagent ${params.subagentId} 已结束或不属于当前任务，请创建新的 subagent` }],
          details: { mode: "single", agentScope: "user", projectAgentsDir: null, results: [] } as SubagentDetails,
          isError: true,
        };
      }
      let steerOpts: Parameters<typeof runtime.steer>[2] = { permissionMode: loadHostPermissionMode() };
      const resolved = await resolveForRecord(record);
      steerOpts = { ...steerOpts, resolvedModel: resolved.model, resolvedThinking: resolved.thinking,
        modelSource: resolved.modelSource, thinkingSource: resolved.thinkingSource };
      const res = await runtime.steer(params.subagentId, params.instruction, steerOpts);
      return {
        content: [{ type: "text", text: res.ok ? `Steered ${params.subagentId}: ${res.message}` : `Steer failed: ${res.message}` }],
        details: { mode: "single", agentScope: "user", projectAgentsDir: null, results: [] } as SubagentDetails,
        isError: !res.ok,
      };
    },
  });

  // 事务顺序：工具/事件注册全部成功后才注册进程级 IPC（ipcMain.handle 是进程级
  // 副作用，无法随 session 销毁自动清理）。若前面任一注册抛错，factory 直接失败，
  // 此时 IPC 尚未注册 → 无残留；registerIpc 自身中途失败由内部 rollbackIpc 回滚。
  registerIpc();
}

// 兼容旧测试导出（invocation 解析相关）
export { resolvePiCliJs, resolvePiInvocation, resolveSystemNode, tryRequireResolve, parseFrontmatterCompat };
export { computeChildTools, buildContextBlock, buildSystemPromptContent, readOptionalSharedContext, inspectSharedContext, SHARED_CONTEXT_MAX_BYTES };
export { SubagentRuntime, MAX_SUBAGENT_DEPTH };
export type { RunOutcome, MessageLike };
export {
  createRecord,
  applyOutcome,
  EMPTY_USAGE,
} from "./registry.ts";
export { parseRpcLine, JsonlLineBuffer, spawnRpcChild, RPC_KILL_GRACE_MS } from "./rpc.ts";
export { DEFAULT_SUBAGENT_TOOLS, READONLY_TOOLS, RECURSION_TOOLS, tightenPolicy, permissionStrictness } from "./policy.ts";
export {
  resolveSubagentModelThinking,
  resolveBareModel,
  normalizeThinking,
  THINKING_LEVELS,
} from "./config.ts";
