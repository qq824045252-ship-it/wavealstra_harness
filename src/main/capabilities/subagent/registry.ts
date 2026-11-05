/**
 * registry.ts — Subagent active-only 注册表（Task-scoped disposable）。
 *
 * 产品语义：Subagent Instance 是父 Task 内的临时执行者。本注册表只登记
 * **active**（工具调用进行中）的实例；terminal（completed/failed/cancelled/
 * timedout）或父 Task 结束时立即移除，不留任何历史。
 *
 * 持久化最小化：
 * - `active.json`：仅 active 实例的最小快照（id/pid/sessionFile/scope），
 *   唯一用途是**进程崩溃后**发现并清理遗留 worker/session/transcript；
 *   启动加载后全部视为遗留 GC，清空快照。
 * - 不再有 registry.json 历史数据库；结果摘要由工具返回内容承载。
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type SubagentStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timedout"
  | "interrupted"
  | "error";

export interface SubagentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface PendingSteer {
  text: string;
  queuedAt: number;
}

export interface SubagentRecord {
  subagentId: string;
  /** 父 Task 作用域（pi 会话 sessionId；MyBuddy task↔session 1:1）——跨 task 禁止复用 */
  scope: string;
  role: string;
  /** 可选显示名（纯展示；允许中文；不参与唯一性、文件名、worker 参数） */
  displayName?: string;
  roleSource: "user" | "project" | "unknown";
  roleDescription: string;
  project: string;
  sourceProject?: string;
  status: SubagentStatus;
  createdAt: number;
  updatedAt: number;
  runCount: number;
  steerCount: number;
  pendingSteers: PendingSteer[];
  usage: SubagentUsage;
  sessionId?: string;
  sessionFile?: string;
  pid?: number;
  workerStartedAt?: number;
  model?: string;
  lastTask?: string;
  lastPromptAt?: number;
  lastResultAt?: number;
  lastResult?: {
    status: string;
    errorMessage?: string;
    finalText?: string;
    stopReason?: string;
  };
  toolPolicy?: { tools: string[] | null; excludeTools: string[] };
  toolPolicyMode?: string;
  toolPolicyAt?: number;
  resolvedModel?: string;
  resolvedThinking?: string;
  modelSource?: "invocation" | "role-map" | "parent" | "role" | "default" | "global";
  thinkingSource?: "invocation" | "transport";
  actualModel?: string;
  actualThinking?: string;
  depth: number;
}

export const EMPTY_USAGE: SubagentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };

export function createRecord(input: {
  subagentId: string;
  scope: string;
  role: string;
  displayName?: string;
  roleSource: SubagentRecord["roleSource"];
  roleDescription: string;
  project: string;
  sourceProject?: string;
  depth: number;
  model?: string;
}): SubagentRecord {
  const now = Date.now();
  return {
    subagentId: input.subagentId,
    scope: input.scope,
    role: input.role,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    roleSource: input.roleSource,
    roleDescription: input.roleDescription,
    project: input.project,
    sourceProject: input.sourceProject,
    status: "idle",
    createdAt: now,
    updatedAt: now,
    runCount: 0,
    steerCount: 0,
    pendingSteers: [],
    usage: { ...EMPTY_USAGE },
    depth: input.depth,
    model: input.model,
  };
}

/** 纯函数：任务结束时汇总 outcome 到记录（terminal 后由调用方从注册表移除）。 */
export function applyOutcome(
  record: SubagentRecord,
  outcome: {
    status: "completed" | "failed" | "cancelled" | "timedout";
    errorMessage?: string;
    finalText?: string;
    stopReason?: string;
    usage?: Partial<SubagentUsage>;
  },
): SubagentRecord {
  const now = Date.now();
  const usage = { ...record.usage };
  if (outcome.usage) {
    usage.input += outcome.usage.input ?? 0;
    usage.output += outcome.usage.output ?? 0;
    usage.cacheRead += outcome.usage.cacheRead ?? 0;
    usage.cacheWrite += outcome.usage.cacheWrite ?? 0;
    usage.cost += outcome.usage.cost ?? 0;
    if (outcome.usage.contextTokens) usage.contextTokens = outcome.usage.contextTokens;
    if (outcome.usage.turns) usage.turns += outcome.usage.turns;
  }
  return {
    ...record,
    status: outcome.status,
    updatedAt: now,
    runCount: record.runCount + 1,
    usage,
  };
}

/**
 * active-only 注册表：内存 Map + active.json 最小快照（崩溃恢复 GC 用）。
 * 所有写入走内存；快照仅在 create/remove 时更新（active 集合小，代价可忽略）。
 */
export class SubagentRegistry {
  constructor(
    private readonly file: string, // <baseDir>/active.json
    private readonly now: () => number = Date.now,
  ) {}

  /** 启动恢复：读取 active 快照。返回后调用方应做遗留 GC 并清空快照。 */
  loadActive(): Array<{ subagentId: string; pid?: number; sessionFile?: string; scope: string }> {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf-8")) as {
        instances?: Array<{ subagentId: string; pid?: number; sessionFile?: string; scope: string }>;
      };
      return instancesOf(raw) ?? [];
    } catch {
      return [];
    }
  }

  saveActive(records: SubagentRecord[]): void {
    try {
      const instances = records.map((r) => ({
        subagentId: r.subagentId,
        pid: r.pid,
        sessionFile: r.sessionFile,
        scope: r.scope,
      }));
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, instances }, null, 2), "utf-8");
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.warn(`[subagent] active 快照写入失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 清空快照（崩溃恢复 GC 完成后 / 全部实例结束后） */
  clearActive(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ version: 1, instances: [] }, null, 2), "utf-8");
    } catch {
      /* ignore */
    }
  }
}

function instancesOf(raw: { instances?: unknown }): Array<{ subagentId: string; pid?: number; sessionFile?: string; scope: string }> | null {
  if (!Array.isArray(raw.instances)) return null;
  return (raw.instances as Array<Record<string, unknown>>).filter(
    (x) => x && typeof x.subagentId === "string",
  ) as Array<{ subagentId: string; pid?: number; sessionFile?: string; scope: string }>;
}
