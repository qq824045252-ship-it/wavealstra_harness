/**
 * usage-reconciliation.ts — PI 权威对账（authoritative reconciliation）。
 *
 * 以当前安装版 pi（AgentSession.getSessionStats，pi-coding-agent dist/core/agent-session.js）
 * 为权威，从 session JSONL 重建 PI 口径统计，并与 usage_events 聚合结果逐项对账：
 *
 * PI getSessionStats 语义（v0.84.x 实测源码）：
 * - assistantMessages = entry.type==="message" && message.role==="assistant" 的条数
 *   （pi 每次模型请求产生恰好一条 assistant message：runAgentLoop 的每个
 *   streamAssistantResponse 由 turn_start/turn_end 包裹，turnIndex 每轮自增）→ calls。
 * - userTurns = message.role==="user" 的条数（每次用户消息开启一轮；JSONL 可重建）→ turns。
 * - toolCalls = assistant content 中 type==="toolCall" 的块数（工具调用数，绝不等于调用数）。
 * - tokens/cost = assistant + toolResult(带 usage) + compaction/branch_summary(带 usage)
 *   全部 usage 之和（addUsageToTotals）；input/cacheRead/cacheWrite 为 pi 归一化互斥字段
 *   （Anthropic: input_tokens 不含 cache_read/cache_creation；total = input+output+
 *   cacheRead+cacheWrite）。
 *
 * reconcileUsageRows：给定某 session 的 usage_events 行 + jsonl 文本 → 返回逐项差异报告。
 * 调用方（测试/诊断）可据此断言 calls/turns/tokens/cache/cost 与 PI 一致。
 */
import { isCallRow, type UsageEventRow } from "./usage-stats";

/** PI getSessionStats 等价统计（从 session JSONL 文本重建）。 */
export interface PiSessionStats {
  assistantMessages: number; // = 模型调用数（calls）
  userTurns: number; // = 用户消息数（turns）
  toolCalls: number; // assistant content 中 toolCall 块数
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
}

/** 单 session 对账结果。 */
export interface UsageReconciliation {
  pi: PiSessionStats;
  db: {
    calls: number;
    turns: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
  };
  ok: boolean;
  /** 差异明细（空 = 一致）；每项格式：`字段: db=xx pi=yy` */
  mismatches: string[];
}

interface JsonlEntry {
  type?: string;
  id?: string;
  provider?: string;
  model?: string;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
  message?: {
    role?: string;
    provider?: string;
    model?: string;
    content?: Array<{ type?: string }>;
    usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
  };
}

function addUsage(
  t: { input: number; output: number; cacheRead: number; cacheWrite: number },
  cost: { total: number },
  usage: JsonlEntry["usage"] | undefined,
): void {
  t.input += usage?.input ?? 0;
  t.output += usage?.output ?? 0;
  t.cacheRead += usage?.cacheRead ?? 0;
  t.cacheWrite += usage?.cacheWrite ?? 0;
  cost.total += usage?.cost?.total ?? 0;
}

/**
 * 从 session JSONL 文本重建 PI getSessionStats 等价统计
 * （与 pi dist/core/agent-session.js getSessionStats 逻辑一致：
 * compaction/branch_summary/toolResult 的 usage 计入 tokens/cost，不计 assistantMessages）。
 */
export function computePiSessionStats(jsonlText: string): PiSessionStats {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const cost = { total: 0 };
  let assistantMessages = 0;
  let userTurns = 0;
  let toolCalls = 0;
  for (const line of jsonlText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: JsonlEntry | null = null;
    try {
      entry = JSON.parse(line) as JsonlEntry;
    } catch {
      continue; // 中断残留行（pi 读取时同样按行容错）
    }
    if (!entry) continue;
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      if (entry.usage) addUsage(tokens, cost, entry.usage);
      continue;
    }
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg) continue;
    if (msg.role === "user") {
      userTurns += 1;
    } else if (msg.role === "toolResult") {
      if (msg.usage) addUsage(tokens, cost, msg.usage);
    } else if (msg.role === "assistant") {
      assistantMessages += 1;
      if (Array.isArray(msg.content)) {
        toolCalls += msg.content.filter((c) => c?.type === "toolCall").length;
      }
      addUsage(tokens, cost, msg.usage);
    }
  }
  return {
    assistantMessages,
    userTurns,
    toolCalls,
    tokens: {
      input: tokens.input,
      output: tokens.output,
      cacheRead: tokens.cacheRead,
      cacheWrite: tokens.cacheWrite,
      total: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
    },
    cost: cost.total,
  };
}

/** 数值相等（cost 浮点容差 1e-6 绝对 + 1e-6 相对）。 */
function closeEnough(a: number, b: number): boolean {
  if (a === b) return true;
  const diff = Math.abs(a - b);
  return diff <= 1e-6 || diff <= 1e-6 * Math.max(Math.abs(a), Math.abs(b));
}

/**
 * 三方对账：usage_events 行（DB 聚合） vs jsonl 重建的 PI 统计。
 * - calls = 调用行数（isCallRow；main/btw/subagent，排除 dispose 安全结算行）
 * - turns = 用户轮次：优先 userTurnsBySession（回填水位中的 jsonl user 消息数，含无回复
 *   轮次，与 pi userMessages 完全一致）；无水位（live 中会话）→ distinct user_turn
 * - tokens/cost = 全部行（含 compaction/toolresult 开销行）之和
 */
export function reconcileUsageRows(
  rows: UsageEventRow[],
  jsonlText: string,
  userTurnsBySession?: ReadonlyMap<string, number>,
): UsageReconciliation {
  const pi = computePiSessionStats(jsonlText);
  const callRows = rows.filter(isCallRow);
  const liveTurns = new Set<string>();
  for (const r of callRows) {
    if (r.userTurn === null) continue;
    liveTurns.add(`${r.sourceKind}:${r.sessionFile ?? r.taskId ?? "?"}:${r.userTurn}`);
  }
  let dbTurns = liveTurns.size;
  // 有权威水位的 main 会话：以 jsonl user 消息数为准（liveTurns 键含 main: 前缀；
  // 逐会话替换，避免与其余会话的 distinct 计数混淆）
  if (userTurnsBySession && userTurnsBySession.size > 0) {
    const perSession = new Map<string, Set<number>>();
    for (const r of callRows) {
      if (r.userTurn === null) continue;
      const key = `${r.sourceKind}:${r.sessionFile ?? r.taskId ?? "?"}`;
      let set = perSession.get(key);
      if (!set) {
        set = new Set();
        perSession.set(key, set);
      }
      set.add(r.userTurn);
    }
    dbTurns = 0;
    for (const [key, set] of perSession) {
      if (key.startsWith("main:")) {
        const sf = key.slice("main:".length);
        const authoritative = sf ? userTurnsBySession.get(sf) : undefined;
        if (authoritative !== undefined) {
          dbTurns += authoritative;
          continue;
        }
      }
      dbTurns += set.size;
    }
  }
  const db = {
    calls: callRows.length,
    turns: dbTurns,
    input: rows.reduce((a, r) => a + r.inputTokens, 0),
    output: rows.reduce((a, r) => a + r.outputTokens, 0),
    cacheRead: rows.reduce((a, r) => a + r.cacheRead, 0),
    cacheWrite: rows.reduce((a, r) => a + r.cacheWrite, 0),
    cost: rows.reduce((a, r) => a + r.costTotal, 0),
  };
  const mismatches: string[] = [];
  if (db.calls !== pi.assistantMessages) {
    mismatches.push(`calls: db=${db.calls} pi=${pi.assistantMessages}（assistantMessages）`);
  }
  if (db.turns !== pi.userTurns) {
    mismatches.push(`turns: db=${db.turns} pi=${pi.userTurns}（userTurns）`);
  }
  for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    if (!closeEnough(db[field], pi.tokens[field])) {
      mismatches.push(`${field}: db=${db[field]} pi=${pi.tokens[field]}`);
    }
  }
  if (!closeEnough(db.cost, pi.cost)) {
    mismatches.push(`cost: db=${db.cost} pi=${pi.cost}`);
  }
  return { pi, db, ok: mismatches.length === 0, mismatches };
}
