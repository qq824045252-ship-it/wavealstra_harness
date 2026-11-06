/**
 * D-2：并行子代理同文件写冲突检测。
 *
 * 背景：pi 的 write 只有 {path, content}，没有版本号/CAS；同一 dispatch 里两个 child 写同一个文件时
 * 两个 write 都返回成功，后写者静默覆盖先写者，父代理只看到 `Parallel: x/x succeeded`。
 *
 * 做法：并行 dispatch（concurrency>1）内，每个 child 的 (taskId, conversationId) 注册到本模块的写入守卫
 * （每个 task 有独立 durable store，IdAllocator 都从 2 起，conversationId 会跨 task 撞号，必须带上 taskId）；
 * 第一次写某路径的 child 取得该路径，其它 child 再写同一路径时：
 *   - 生产路径（ToolTask.beforeTool 钩子）返回 `{ block }`，把写入变成明确的工具错误，内容不会被覆盖；
 *   - 直接持有 ToolRegistration 的调用方（自建工具/测试）可用 `wrapWriteTool` 让 execute 抛 `WriteConflictError`。
 *
 * 边界（有意不处理）：
 *   - bash/powershell 写文件绕过检测（本模块只认 write/edit 工具调用）；
 *   - 不同 child 拿到 worktree 时路径自然不同，不会互相冲突；
 *   - 路径按 resolve(cwd, path) 归一（Windows 下大小写不敏感），不做 realpath —— 符号链接目录可能漏检。
 */
import { isAbsolute, resolve, sep } from "node:path";
import type { ToolRegistration } from "@earendil-works/pi-durable";

/** 会计入写冲突的工具名（edit 同样是「写」）。 */
export const WRITE_TOOL_NAMES = ["write", "edit"] as const;
export type WriteToolName = (typeof WRITE_TOOL_NAMES)[number];

export function isWriteToolName(name: string | undefined): name is WriteToolName {
  return typeof name === "string" && (WRITE_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * normalize：只看「最终落到哪个文件」，因此相对路径按 child 自己的工作目录解析。
 * Windows 文件系统大小写不敏感，统一小写比较；POSIX 保持原样。
 */
export function canonicalWritePath(rawPath: string, cwd: string): string {
  const absolute = isAbsolute(rawPath) ? resolve(rawPath) : resolve(cwd, rawPath);
  return sep === "\\" ? absolute.toLowerCase() : absolute;
}

export type WriteClaim = {
  /** 归一后的绝对路径（Windows 小写）。 */
  path: string;
  /** 首次写入该文件的 child。 */
  childId: string;
  label: string;
  tool: WriteToolName;
};

export function formatWriteConflict(claim: WriteClaim, input: { childId: string; label: string; tool: WriteToolName; path: string }): string {
  return `并行子代理写冲突：${claim.path}\n`
    + `该文件已由 [${claim.label}] (id: ${claim.childId}) 用 ${claim.tool} 写入，[${input.label}] (id: ${input.childId}) 又用 ${input.tool} 写同一文件。\n`
    + `并行子代理必须写不同文件；或改用 isolation:"shared" 并自行串行化（同一文件的多次写放进 chain 顺序执行）。`
    + `本次写入已被阻止，避免后写静默覆盖先写。`;
}

/** 可读的冲突错误：message 直接给模型看。 */
export class WriteConflictError extends Error {
  readonly code = "subagent_write_conflict";
  readonly claim: WriteClaim;
  constructor(message: string, claim: WriteClaim) {
    super(message);
    this.name = "WriteConflictError";
    this.claim = claim;
  }
}

export type WriteClaimInput = { childId: string; label: string; cwd: string; tool: WriteToolName; path: string };

export interface ParallelWriteGuard {
  /** 认领一次写；同一 child 重复写同一文件是合法的（顺序追加/多次编辑），跨 child 冲突抛 WriteConflictError。 */
  claim(input: WriteClaimInput): WriteClaim;
  /** 查看当前已认领的路径（测试/诊断用）。 */
  claims(): readonly WriteClaim[];
  /** 值得回传给调用方的冲突行（写进 SingleResult.diagnostics）。 */
  conflictsFor(childId: string): string[];
}

/**
 * 一个并行 dispatch 一个实例：dispatch 结束后整体失效，不做跨 dispatch 抑制
 * （chain 的后续步骤写前一步的文件是合法的）。
 */
export function createParallelWriteGuard(): ParallelWriteGuard {
  const owners = new Map<string, WriteClaim>();
  const conflicts = new Map<string, string[]>();
  return {
    claim(input) {
      const path = canonicalWritePath(input.path, input.cwd);
      const owner = owners.get(path);
      if (!owner) {
        const claim: WriteClaim = { path, childId: input.childId, label: input.label, tool: input.tool };
        owners.set(path, claim);
        return claim;
      }
      if (owner.childId === input.childId) return owner;
      const message = formatWriteConflict(owner, { ...input, path });
      const lines = conflicts.get(input.childId) ?? [];
      lines.push(`write conflict blocked: ${path} already written by ${owner.childId} (${owner.tool})`);
      conflicts.set(input.childId, lines);
      throw new WriteConflictError(message, owner);
    },
    claims: () => [...owners.values()],
    conflictsFor: childId => [...(conflicts.get(childId) ?? [])],
  };
}

type GuardedChild = { guard: ParallelWriteGuard; childId: string; label: string; cwd: string };
/** MyBuddy task id：任务路由用 string，测试/内部调用也可能给 number。 */
type TaskIdLike = string | number;

/**
 * 注册表键 = (MyBuddy taskId, conversationId)。每个 task 有独立的 durable store，各自的 IdAllocator
 * 都从 2 起，所以两个并发 task 的 child conversationId 会相同；只按 conversationId 建键会跨 task
 * 误认领、误 block。taskId 缺失/为空时返回 undefined：既不注册也不保护（父会话 root id=1 不注册，
 * 本来也不会命中）。
 */
function guardedWriteKey(taskId: TaskIdLike | undefined, conversationId: number | undefined): string | undefined {
  if (conversationId === undefined || conversationId === null) return undefined;
  if (taskId === undefined || taskId === null || String(taskId).trim() === "") return undefined;
  return `${String(taskId)}:${conversationId}`;
}

/**
 * 活着的受保护 child：(taskId:conversationId) → 守卫。子会话的工具执行由 pi-durable 按名字从注册表
 * 解析，`configure({tools})` 只存名字（AgentState.tools 是 string[]），因此「套在工具对象上的包装」
 * 到不了子会话执行路径；真正生效的接缝是 ToolTask 的 beforeTool 钩子（见守卫调用方）。
 * conversationId 是 pi-durable 的 ConversationId（品牌化的 number）。
 */
const guardedChildren = new Map<string, GuardedChild>();

export function registerGuardedChildWrite(conversationId: number, taskId: TaskIdLike | undefined, child: GuardedChild): void {
  const key = guardedWriteKey(taskId, conversationId);
  if (key) guardedChildren.set(key, child);
}

export function releaseGuardedChildWrite(conversationId: number, taskId: TaskIdLike | undefined): void {
  const key = guardedWriteKey(taskId, conversationId);
  if (key) guardedChildren.delete(key);
}

/** 测试/诊断：当前注册中的受保护 child 数。 */
export function guardedChildWriteCount(): number {
  return guardedChildren.size;
}

/**
 * ToolTask.beforeTool 的守卫入口：受保护的 child 写一个已被别的 child 认领的路径时返回 `{ block }`。
 * 非受保护会话（父会话 / single / chain）、其它 task 的同号 conversation、非写工具、参数缺失
 * （交给工具自己报参数错误）都直接放行。
 */
export function guardSubagentWriteCall(
  call: { readonly name?: string; readonly arguments?: unknown },
  conversationId: number | undefined,
  taskId: TaskIdLike | undefined,
): { block: string } | undefined {
  const key = guardedWriteKey(taskId, conversationId);
  if (!key || !isWriteToolName(call.name)) return undefined;
  const child = guardedChildren.get(key);
  if (!child) return undefined;
  const raw = (call.arguments as { path?: unknown } | null | undefined)?.path;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  try {
    child.guard.claim({ childId: child.childId, label: child.label, cwd: child.cwd, tool: call.name, path: raw });
    return undefined;
  } catch (error) {
    if (error instanceof WriteConflictError) return { block: error.message };
    throw error;
  }
}

/**
 * 包装单个工具注册：仅 write/edit 生效，其它工具原样返回（同一个对象）。
 * 适用于「执行的就是这个对象」的调用方（自建工具、单元测试）；Durable 子会话走 guardSubagentWriteCall。
 */
export function wrapWriteTool<T extends ToolRegistration>(tool: T, childId: string, guard: ParallelWriteGuard, label = childId): T {
  if (!isWriteToolName(tool.name)) return tool;
  const execute: ToolRegistration["execute"] = async (args, api, context) => {
    const raw = (args as { path?: unknown } | null | undefined)?.path;
    if (typeof raw === "string" && raw.trim()) {
      const agent = await api.agent(context);
      const cwd = agent.cwd ?? process.cwd();
      guard.claim({ childId, label, cwd, tool: tool.name as WriteToolName, path: raw });
    }
    return tool.execute(args, api, context);
  };
  return { ...tool, execute } as T;
}
