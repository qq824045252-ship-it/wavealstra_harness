/**
 * UsageStatsService.ts — LLM 用量统一事实表：实时投影 + 历史回填 + 查询聚合。
 *
 * 数据源：
 * - live：AgentService 主/BTW 事件桥的 message_end（完整 AssistantMessage.usage）
 *   + PerformanceTracker 样本（TTFT/TPS/wall time）。
 * - 历史：pi durable session jsonl（tasks.session_file）增量回填（水位
 *   usage_backfill_state.last_entry_id）；仅 assistant message 条目计入调用；
 *   compaction/branch_summary/toolResult 带 usage 的行以 source_kind=compaction/
 *   toolresult 入表（计 tokens/cost/cache hit，不计调用——对齐 pi getSessionStats）。
 * - subagent：扩展 ~/.mybuddy/subagent/usage-archive.jsonl（实例结束时追加；
 *   source_kind=subagent），按 sub:{subagentId} 幂等。
 *
 * 幂等/防双计：
 * - usage_events 主键 entry_id。live 行 entry_id = `live:{sessionFile}:{responseId}`
 *   （无 responseId 兑底 `ti{turnIndex}`）——responseId 每次模型调用唯一，消除同 session
 *   多轮/多 agent run 的键碰撞；回填时按 response_id 精确匹配（jsonl 中就是同一 message
 *   对象）认领 live 行并把 entry_id 更新为真实 entry id；无 response_id 的行按
 *   `session_file + assistant 顺序 = turn_index 顺序` 对齐认领；其余插入（INSERT OR
 *   IGNORE 兜底）。认领只针对成功匹配的行（旧实现把全部带 response_id 的条目视为已认领，
 *   导致回填丢全部带 response_id 的 assistant message）。
 * - 用户轮次 user_turn：assistant 行记录其触发的 user message 序号（1 基），live 路径由
 *   AgentService 计数 message_start(role=user) 写入，回填路径由 parseSessionJsonl 重建；
 *   认领时以 jsonl 值覆盖（应用中途接入时 live 计数可能偏低）。turns = distinct
 *   (sourceKind:sessionFile:user_turn)（PI 语义：每次用户消息开启一轮）。
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import type { PerfSample } from "./PerformanceTracker";
import { nativeCostEvidence } from "../agent/NativeCostEvidence";
import {
  applyMyBuddyModelAttribution,
  summarizeRows,
  groupByProviderModel,
  dailyTrend,
  dailyActivity,
  weekHeatmap,
  monthlySummary,
  toCsv,
  rangeStartMs,
  localDayKey,
  streakStats,
  longestSessionMs,
  parseSkillInvocations,
  type UsageEventRow,
} from "../../shared/usage-stats";

/** live 行 entry_id 前缀（回填认领目标）。 */
export const LIVE_PREFIX = "live:";
export const SUBAGENT_PREFIX = "sub:";

export interface RecordLiveInput {
  reportedUsage?: import("../../shared/task-diagnostics").ReportedTokenUsage & { costTotal: number | null };
  taskId: string | null;
  sessionFile: string | null;
  sourceKind: "main" | "btw" | "subagent" | "auxiliary";
  sourceDetail?: string | null;
  sample: Omit<PerfSample, "requestStartedAt"> & { requestStartedAt: number | null };
  /** Immutable native ledger identity, when the caller projects a persisted backend. */
  persistedEntryId?: string;
  message: {
    provider?: string | null;
    model?: string | null;
    responseModel?: string | null;
    responseId?: string | null;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      cacheWrite1h?: number | null;
      reasoning?: number | null;
      totalTokens?: number;
      cost?: { total?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
    } | null;
    stopReason?: string | null;
    errorMessage?: string | null;
    timestamp?: number;
  };
  /** 用户轮次（message_start role=user 计数；无则 null） */
  userTurn?: number | null;
  /** MyBuddy 记账模型（`provider/id`）。有则覆盖 pi message.model。 */
  modelId?: string | null;
}

export interface ParsedAssistantEntry {
  entryId: string;
  responseId: string | null;
  provider: string;
  model: string;
  ts: number;
  usage: RecordLiveInput["message"]["usage"];
  stopReason: string | null;
  errorMessage: string | null;
  /** jsonl 中 assistant message 出现顺序（= 模型请求顺序 = turn_index 顺序） */
  order: number;
  /** 用户轮次 = 此前已出现的 user message 数（1 基；无 user message 为 0） */
  userTurn: number;
}

/**
 * 开销行（非模型调用，但 pi getSessionStats 计入 tokens/cost）：
 * compaction/branch_summary 条目（带 usage）与 toolResult message（带 usage）。
 */
export interface ParsedOverheadEntry {
  entryId: string;
  kind: "compaction" | "toolresult";
  ts: number;
  provider: string | null;
  model: string | null;
  usage: RecordLiveInput["message"]["usage"] | null;
}

/**
 * 解析 pi session jsonl 文本中的 assistant message 条目（可测纯函数）。
 * 兼容 v3 结构（message.role === "assistant"）；无法解析的行跳过。
 * user_turn = 该 assistant 所属用户轮次（此前已出现的 user message 数；1 基）。
 */
export function parseSessionJsonl(text: string): ParsedAssistantEntry[] {
  const out: ParsedAssistantEntry[] = [];
  let order = 0;
  let userTurn = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: { type?: string; id?: string; message?: Record<string, unknown> } | null = null;
    try {
      entry = JSON.parse(line) as { type?: string; id?: string; message?: Record<string, unknown> } | null;
    } catch {
      continue; // 部分写入的行（中断安全）
    }
    if (!entry || entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg || msg.role === "custom") continue;
    if (msg.role === "user") {
      userTurn += 1;
      continue;
    }
    if (msg.role !== "assistant") continue;
    const usage = msg.usage as RecordLiveInput["message"]["usage"] | undefined;
    out.push({
      entryId: entry.id ?? `entry:${order}`,
      responseId: (msg.responseId as string | null) ?? null,
      provider: (msg.provider as string | null) ?? "unknown",
      model: (msg.model as string | null) ?? (msg.responseModel as string | null) ?? "unknown",
      ts: (msg.timestamp as number | null) ?? Date.now(),
      usage,
      stopReason: (msg.stopReason as string | null) ?? null,
      errorMessage: (msg.errorMessage as string | null) ?? null,
      order: order++,
      userTurn,
    });
  }
  return out;
}

/** jsonl 中 user message 总数（turns 权威口径；含无 assistant 回复的尾部轮次）。 */
export function countSessionUserMessages(text: string): number {
  let n = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as { type?: string; message?: { role?: string } } | null;
      if (e?.type === "message" && e.message?.role === "user") n += 1;
    } catch {
      /* 中断残留行跳过 */
    }
  }
  return n;
}

/** 解析 jsonl 中带 usage 的开销条目（compaction/branch_summary/toolResult）。 */
export function parseSessionOverhead(text: string): ParsedOverheadEntry[] {
  const out: ParsedOverheadEntry[] = [];
  const toTs = (raw: unknown): number => {
    if (typeof raw === "number") return raw;
    if (typeof raw === "string") {
      const n = Date.parse(raw);
      if (!Number.isNaN(n)) return n;
    }
    return Date.now();
  };
  const hasUsage = (u: RecordLiveInput["message"]["usage"] | null | undefined): u is NonNullable<typeof u> =>
    Boolean(u && (u.input || u.output || u.cacheRead || u.cacheWrite || u.cost));
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: { type?: string; id?: string; timestamp?: unknown; provider?: string; model?: string; usage?: unknown; message?: Record<string, unknown> } | null = null;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry) continue;
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      const u = entry.usage as RecordLiveInput["message"]["usage"] | undefined;
      if (!hasUsage(u)) continue;
      out.push({
        entryId: entry.id ?? `overhead:${out.length}`,
        kind: "compaction",
        ts: toTs(entry.timestamp),
        provider: entry.provider ?? null,
        model: entry.model ?? null,
        usage: u,
      });
    } else if (entry.type === "message" && entry.message?.role === "toolResult") {
      const u = entry.message.usage as RecordLiveInput["message"]["usage"] | undefined;
      if (!hasUsage(u)) continue;
      out.push({
        entryId: entry.id ?? `overhead:${out.length}`,
        kind: "toolresult",
        ts: toTs(entry.message.timestamp),
        provider: (entry.message.provider as string | null) ?? null,
        model: (entry.message.model as string | null) ?? null,
        usage: u,
      });
    }
  }
  return out;
}

/** subagent usage-archive.jsonl 行。 */
export interface SubagentArchiveEntry {
  subagentId: string;
  role?: string;
  scope?: string;
  finishedAt: number;
  status?: string;
  model?: string;
  /** 实例运行轮次（applyOutcome 递增）；key 消歧用 */
  runCount?: number;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: number; turns?: number };
}

export function parseSubagentArchive(text: string): SubagentArchiveEntry[] {
  const out: SubagentArchiveEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as SubagentArchiveEntry;
      if (e && typeof e.subagentId === "string" && e.subagentId) out.push(e);
    } catch {
      continue;
    }
  }
  return out;
}

export interface UsageQueryRow extends UsageEventRow {
  responseId: string | null;
  backfilled: number;
}

export class UsageStatsService {
  private coverageAvailable = true;
  constructor(private readonly db: Database) {
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS usage_event_coverage (entry_id TEXT PRIMARY KEY REFERENCES usage_events(entry_id) ON DELETE CASCADE ON UPDATE CASCADE,
        input_known INTEGER NOT NULL, output_known INTEGER NOT NULL, cache_read_known INTEGER NOT NULL, cache_write_known INTEGER NOT NULL, cost_known INTEGER NOT NULL)`);
    } catch { this.coverageAvailable = false; }
    // 启动即修一次历史 coverage（幂等，见 repairLegacyCoverage 注释）。
    this.repairLegacyCoverage();
  }

  /**
   * 一次性、幂等的历史 coverage 修复（随 UsageStatsService 构造在启动路径执行；重复执行无副作用）。
   *
   * 旧写入路径留下两类错误 unknown：
   * 1) provider 未上报时整行 coverage 记成全 unknown，但 token 列其实来自 pi 归一化 usage；
   * 2) chat-completions / responses / google 不报 cache_creation，cache_write_known 被记成 0，
   *    而 pi 归一化 usage 里 cacheWrite 是确定的 0。
   * 判据只有一条：行内有真实用量（total_tokens > 0）时，token 列就是 pi 归一化后的真实计数——
   * 旧缺陷仅有的破坏是把整行清零，而清零出来的行 total_tokens = 0。所以恢复四字段 known。
   * total_tokens = 0 的行保持 unknown（失败调用没消耗 token，不能用 0 冒充已知）。
   * cost 同口径：有真实用量就说「费用已知（未上报即 0）」，不再因为一行没上报费用把
   * 整窗费用降级成未知。
   * 只改 coverage 的 known 位，不动 usage_events 里的任何 token / 费用数值。
   */
  repairLegacyCoverage(): number {
    if (!this.coverageAvailable) return 0;
    try {
      const usage = `EXISTS (SELECT 1 FROM usage_events e WHERE e.entry_id = usage_event_coverage.entry_id AND e.total_tokens > 0)`;
      const tokens = this.db
        .prepare(
          `UPDATE usage_event_coverage SET input_known = 1, output_known = 1, cache_read_known = 1, cache_write_known = 1
            WHERE cache_write_known = 0 AND ${usage}`,
        )
        .run().changes;
      const cost = this.db
        .prepare(`UPDATE usage_event_coverage SET cost_known = 1 WHERE cost_known = 0 AND ${usage}`)
        .run().changes;
      return tokens + cost;
    } catch { return 0; }
  }

  // ---------- live 投影 ----------

  recordLive(input: RecordLiveInput): void {
    const { sample, message } = input;
    const sessionFile = input.sessionFile ?? null;
    const reported = input.reportedUsage;
    const native = message.usage ?? null;
    const nativeCounts = native
      ? {
          input: native.input ?? null,
          output: native.output ?? null,
          cacheRead: native.cacheRead ?? null,
          cacheWrite: native.cacheWrite ?? null,
        }
      : null;
    // 逐字段合并：provider 上报优先，缺失字段回落 pi 原生归一化 usage；两边都没有才是
    // 未知（null）——不能用 0 冒充缺失，否则面板把「未上报」显示成真实 0，下游 known
    // 判定也随之失真。
    // 例外：上报侧不含 cacheWrite（chat-completions / responses / google 都不报
    // cache_creation）时，上报的 input 已把 cache-write token 算进未命中侧
    // （prompt-cached），而 pi 原生会单独扣出；此时 input 一并取原生值，避免双计。
    const reportedWrite = reported?.cacheWrite ?? null;
    const nativeWrite = nativeCounts?.cacheWrite ?? null;
    let inputTokens = reported?.input ?? nativeCounts?.input ?? null;
    if (reported?.input != null && reportedWrite === null && (nativeWrite ?? 0) > 0) inputTokens = nativeCounts?.input ?? inputTokens;
    const counts = {
      input: inputTokens,
      output: reported?.output ?? nativeCounts?.output ?? null,
      cacheRead: reported?.cacheRead ?? nativeCounts?.cacheRead ?? null,
      cacheWrite: reportedWrite ?? nativeWrite ?? null,
    };
    const attributed = applyMyBuddyModelAttribution(message, input.modelId);
    const entryId = input.persistedEntryId ?? `${LIVE_PREFIX}${sessionFile ?? input.taskId ?? "?"}:${message.responseId ?? `ti${sample.turnIndex}`}`;
    const total = (counts.input ?? 0) + (counts.output ?? 0) + (counts.cacheRead ?? 0) + (counts.cacheWrite ?? 0);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO usage_events (
          entry_id, task_id, session_file, source_kind, source_detail,
          provider, model, response_model, ts,
          input_tokens, output_tokens, cache_read, cache_write, cache_write_1h, reasoning_tokens, total_tokens,
          cost_total, cost_input, cost_output, cost_cache_read, cost_cache_write,
          stop_reason, error_message,
          request_started_at, first_response_at, completed_at, ttft_ms, decode_ms, generation_tps, model_wall_ms,
          response_id, turn_index, user_turn, backfilled
        ) VALUES (
          @entryId, @taskId, @sessionFile, @sourceKind, @sourceDetail,
          @provider, @model, @responseModel, @ts,
          @inputTokens, @outputTokens, @cacheRead, @cacheWrite, @cacheWrite1h, @reasoningTokens, @totalTokens,
          @costTotal, @costInput, @costOutput, @costCacheRead, @costCacheWrite,
          @stopReason, @errorMessage,
          @requestStartedAt, @firstResponseAt, @completedAt, @ttftMs, @decodeMs, @generationTps, @modelWallMs,
          @responseId, @turnIndex, @userTurn, 0
        )`,
      )
      .run({
        entryId,
        taskId: input.taskId,
        sessionFile,
        sourceKind: input.sourceKind,
        sourceDetail: input.sourceDetail ?? null,
        provider: attributed.provider,
        model: attributed.model,
        responseModel: attributed.responseModel,
        ts: message.timestamp ?? sample.completedAt ?? Date.now(),
        inputTokens: counts.input ?? 0,
        outputTokens: counts.output ?? 0,
        cacheRead: counts.cacheRead ?? 0,
        cacheWrite: counts.cacheWrite ?? 0,
        cacheWrite1h: native?.cacheWrite1h ?? null,
        reasoningTokens: native?.reasoning ?? null,
        totalTokens: total,
        costTotal: native?.cost?.total ?? 0,
        costInput: native?.cost?.input ?? 0,
        costOutput: native?.cost?.output ?? 0,
        costCacheRead: native?.cost?.cacheRead ?? 0,
        costCacheWrite: native?.cost?.cacheWrite ?? 0,
        stopReason: message.stopReason ?? null,
        errorMessage: message.errorMessage ?? null,
        requestStartedAt: sample.requestStartedAt,
        firstResponseAt: sample.firstResponseAt,
        completedAt: sample.completedAt,
        ttftMs: sample.ttftMs,
        decodeMs: sample.decodeMs,
        generationTps: sample.generationTps,
        modelWallMs: sample.modelWallMs,
        responseId: message.responseId ?? null,
        turnIndex: sample.turnIndex,
        userTurn: input.userTurn ?? null,
      });
    // coverage：记录这次调用实际知道哪些分量——已合并上报/原生之后仍为 null 的字段才算
    // 未知。每行都写，取代 queryRows 里「token>0 才算已知」的旧启发式（它把真实的 0
    // 当成未知，让面板整片显示「未知」）。
    // cost：有真实用量即视为已知（没上报费用就是 0，见 queryRows 的同款口径）。
    const costKnown = total > 0 || reported?.costTotal != null || nativeCostEvidence(native, reported).complete;
    if (this.coverageAvailable) try {
      this.db.prepare("INSERT OR IGNORE INTO usage_event_coverage VALUES (?,?,?,?,?,?)")
        .run(entryId, Number(counts.input !== null), Number(counts.output !== null), Number(counts.cacheRead !== null), Number(counts.cacheWrite !== null), Number(costKnown));
    } catch { /* Unknown coverage must not affect a completed model call. */ }
  }

  /** subagent 实例结束归档（usage-archive.jsonl → 事实表；key = sub:{id}:{finishedAt}，
   *  同 id 多次运行（复用）每次归档一行，重复扫描同一行幂等）。
   *  缺字段：归档行可能不带 cacheRead/cacheWrite。数值列是 NOT NULL DEFAULT 0，所以
   *  "没有这个字段"与"这个字段是 0"在表里长得一样，必须由 coverage 行区分——否则缺字段
   *  的行会被当成"已知的缓存未命中"，把命中率分母虚假抬高（实测 0.9 → 0.818）。 */
  recordSubagentArchive(entries: SubagentArchiveEntry[]): void {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO usage_events (
        entry_id, task_id, session_file, source_kind, source_detail,
        provider, model, ts, input_tokens, output_tokens, cache_read, cache_write,
        reasoning_tokens, total_tokens, cost_total, turn_index, backfilled
      ) VALUES (?, ?, ?, 'subagent', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, 1)`,
    );
    const coverage = this.coverageAvailable
      ? this.db.prepare("INSERT OR IGNORE INTO usage_event_coverage VALUES (?,?,?,?,?,?)")
      : null;
    const tx = this.db.transaction((entries: SubagentArchiveEntry[]) => {
      for (const e of entries) {
        const u = e.usage ?? {};
        const total = (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
        const entryId = `${SUBAGENT_PREFIX}${e.subagentId}:${e.runCount ?? 0}:${e.finishedAt ?? 0}`;
        const inserted = insert.run(
          entryId,
          e.scope ?? null,
          null,
          e.role ?? null,
          null, // subagent 无 provider 信息（仅 model）
          e.model ?? null,
          e.finishedAt,
          u.input ?? 0,
          u.output ?? 0,
          u.cacheRead ?? 0,
          u.cacheWrite ?? 0,
          total,
          u.cost ?? 0,
        );
        if (inserted.changes && coverage) {
          coverage.run(entryId, Number(u.input != null), Number(u.output != null),
            Number(u.cacheRead != null), Number(u.cacheWrite != null), Number(u.cost != null || total > 0));
        }
      }
    });
    tx(entries);
  }

  // ---------- 查询 ----------

  queryRows(opts: { since?: number; until?: number; sourceKinds?: string[] }): UsageQueryRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.since !== undefined) {
      where.push("ts >= ?");
      args.push(opts.since);
    }
    if (opts.until !== undefined) {
      where.push("ts <= ?");
      args.push(opts.until);
    }
    if (opts.sourceKinds && opts.sourceKinds.length > 0) {
      where.push(`source_kind IN (${opts.sourceKinds.map(() => "?").join(",")})`);
      args.push(...opts.sourceKinds);
    }
    const sql = `SELECT
        e.entry_id AS entryId, task_id AS taskId, session_file AS sessionFile,
        source_kind AS sourceKind, source_detail AS sourceDetail,
        provider, model, response_model AS responseModel, ts,
        input_tokens AS inputTokens, output_tokens AS outputTokens,
        cache_read AS cacheRead, cache_write AS cacheWrite, cache_write_1h AS cacheWrite1h,
        reasoning_tokens AS reasoningTokens, total_tokens AS totalTokens, cost_total AS costTotal,
        stop_reason AS stopReason, error_message AS errorMessage,
        ttft_ms AS ttftMs, decode_ms AS decodeMs, generation_tps AS generationTps, model_wall_ms AS modelWallMs,
        turn_index AS turnIndex, user_turn AS userTurn,
        response_id AS responseId, backfilled,
        ${this.coverageAvailable ? "c.input_known AS inputKnown,c.output_known AS outputKnown,c.cache_read_known AS cacheReadKnown,c.cache_write_known AS cacheWriteKnown,c.cost_known AS costKnown" : "NULL AS inputKnown,NULL AS outputKnown,NULL AS cacheReadKnown,NULL AS cacheWriteKnown,NULL AS costKnown"}
      FROM usage_events e ${this.coverageAvailable ? "LEFT JOIN usage_event_coverage c ON c.entry_id=e.entry_id" : ""}
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY ts ASC`;
    const rows = this.db.prepare<unknown[], UsageQueryRow & { inputKnown: number | null; outputKnown: number | null; cacheReadKnown: number | null; cacheWriteKnown: number | null; costKnown: number | null }>(sql).all(...args);
    return rows.map(row => {
      // 有 coverage 行时以它为准（权威）。没有 coverage 行（老数据 / 回填 / 子代理归档）时
      // 按行内数据判定：旧写入缺陷只会把整行 token 清零，所以 total_tokens > 0 的行是 pi
      // 归一化后的真实计数、四字段可信；total_tokens = 0 才保持 unknown（失败调用没消耗
      // token，不能用 0 冒充已知）。旧实现按 source_detail='pi-durable' 一律判未知，导致
      // 历史 pi-durable 行永远显示「未知」。
      // cost 口径（用户 2026-11-06 明确要求）：只要这一行有真实用量（total > 0），就把
      // 费用视为已知——没有上报费用就是 0（面板按目录单价估算，0 与「未知」相比更接近
      // 事实，也不会因为一条无费用行把整窗降级成未知）。total = 0 的失败行仍然未知。
      const legacyKnown = row.totalTokens > 0;
      const known = {
      input: row.inputKnown === null ? legacyKnown : row.inputKnown === 1,
      output: row.outputKnown === null ? legacyKnown : row.outputKnown === 1,
      cacheRead: row.cacheReadKnown === null ? legacyKnown : row.cacheReadKnown === 1,
      cacheWrite: row.cacheWriteKnown === null ? legacyKnown : row.cacheWriteKnown === 1,
      cost: row.costKnown === null ? legacyKnown : row.costKnown === 1 || legacyKnown,
      };
      const inputTokens = known.input ? row.inputTokens : 0;
      const outputTokens = known.output ? row.outputTokens : 0;
      const cacheRead = known.cacheRead ? row.cacheRead : 0;
      const cacheWrite = known.cacheWrite ? row.cacheWrite : 0;
      return { ...row, known, inputTokens, outputTokens, cacheRead, cacheWrite,
        totalTokens: known.input && known.output && known.cacheRead && known.cacheWrite ? row.totalTokens : inputTokens + outputTokens + cacheRead + cacheWrite,
        costTotal: known.cost ? row.costTotal : 0 };
    });
  }

  summarize(rangeDays: number): ReturnType<typeof summarizeRows> {
    const now = Date.now();
    const rows = this.queryRows({ since: rangeStartMs(rangeDays, now) });
    return summarizeRows(rows);
  }

  /** 每 session 权威 user 消息数（turns 口径；来自回填水位，含无回复轮次）。 */
  sessionUserTurnCounts(): Map<string, number> {
    const rows = this.db
      .prepare(`SELECT session_file AS sf, user_messages AS n FROM usage_backfill_state WHERE user_messages IS NOT NULL`)
      .all() as Array<{ sf: string; n: number }>;
    return new Map(rows.map((r) => [r.sf, r.n]));
  }

  drilldown(rangeDays: number): ReturnType<typeof groupByProviderModel> {
    const now = Date.now();
    const rows = this.queryRows({ since: rangeStartMs(rangeDays, now) });
    return groupByProviderModel(rows);
  }

  trend(rangeDays: number): ReturnType<typeof dailyTrend> {
    const now = Date.now();
    const rows = this.queryRows({ since: rangeStartMs(rangeDays, now) });
    return dailyTrend(rows, rangeDays, now);
  }

  /**
   * 面板一次拉取：窗口内汇总 + 近 53 周活跃度/连续天数 + skills + 模型明细。
   */
  dashboard(rangeDays: number): {
    known?: import("../../shared/usage-stats").UsageKnownFields;
    rangeDays: number;
    from: string;
    to: string;
    heatFrom: string;
    heatTo: string;
    totalTokens: number;
    dailyPeakTokens: number;
    longestTaskMs: number;
    currentStreakDays: number;
    longestStreakDays: number;
    sessions: number;
    runs: number;
    calls: number;
    avgTokensPerRun: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number | null;
    cost: number;
    cacheHitRate: number | null;
    avgTtftMs: number | null;
    avgTps: number | null;
    avgModelWallMs: number | null;
    errorRate: number | null;
    errors: number;
    days: ReturnType<typeof dailyActivity>;
    models: ReturnType<typeof groupByProviderModel>;
    skills: Array<{ name: string; count: number }>;
  } {
    const now = Date.now();
    const since = rangeStartMs(rangeDays, now);
    const rangeRows = this.queryRows({ since });
    const summary = summarizeRows(rangeRows);
    const heatSince = rangeStartMs(Math.max(rangeDays, 371), now);
    const heatRows = rangeDays >= 371 ? rangeRows : this.queryRows({ since: heatSince });
    const days = dailyActivity(heatRows, heatSince, now);
    const streaks = streakStats(days, localDayKey(now));
    const rangeDaysActivity = dailyActivity(rangeRows, since, now);
    const dailyPeakTokens = rangeDaysActivity.reduce((m, d) => Math.max(m, d.tokens), 0);
    const runs = summary.turns;
    return {
      known: summary.known,
      rangeDays,
      from: localDayKey(since),
      to: localDayKey(now),
      heatFrom: days[0]?.date ?? localDayKey(heatSince),
      heatTo: days[days.length - 1]?.date ?? localDayKey(now),
      totalTokens: summary.totalTokens,
      dailyPeakTokens,
      longestTaskMs: longestSessionMs(rangeRows),
      currentStreakDays: streaks.current,
      longestStreakDays: streaks.longest,
      sessions: summary.sessions,
      runs,
      calls: summary.calls,
      avgTokensPerRun: runs > 0 ? summary.totalTokens / runs : 0,
      input: summary.input,
      output: summary.output,
      cacheRead: summary.cacheRead,
      cacheWrite: summary.cacheWrite,
      reasoning: summary.reasoning,
      cost: summary.cost,
      cacheHitRate: summary.cacheHitRate,
      avgTtftMs: summary.avgTtftMs,
      avgTps: summary.avgTps,
      avgModelWallMs: summary.avgModelWallMs,
      errorRate: summary.errorRate,
      errors: summary.errors,
      days,
      models: groupByProviderModel(rangeRows),
      skills: this.skillUsageForRows(rangeRows),
    };
  }

  heatmap(year: number): ReturnType<typeof weekHeatmap> {
    const rows = this.queryRows({ since: new Date(year, 0, 1).getTime(), until: new Date(year, 11, 31, 23, 59, 59).getTime() });
    return weekHeatmap(rows, year);
  }

  monthly(): ReturnType<typeof monthlySummary> {
    return monthlySummary(this.queryRows({}));
  }

  exportCsv(rangeDays: number): string {
    const now = Date.now();
    const rows = this.queryRows({ since: rangeStartMs(rangeDays, now) });
    return toCsv(rows);
  }

  private skillUsageForRows(rows: UsageEventRow[]): Array<{ name: string; count: number }> {
    const files = new Set<string>();
    for (const r of rows) {
      if (r.sessionFile) files.add(r.sessionFile);
    }
    const counts = new Map<string, number>();
    for (const file of files) {
      if (!existsSync(file)) continue;
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const [name, n] of parseSkillInvocations(text)) {
        counts.set(name, (counts.get(name) ?? 0) + n);
      }
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, 20);
  }

  // ---------- 历史回填（jsonl） ----------

  /**
   * 回填单个 session_file：文件未变化（size/mtime 快照一致）直接短路；
   * 变化时增量（水位）+ live 认领（防双计）。返回处理行数。
   */
  backfillSession(sessionFile: string | null): number {
    if (!sessionFile || !existsSync(sessionFile)) return 0;
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(sessionFile);
    } catch {
      return 0;
    }
    const state = this.db
      .prepare(
        `SELECT last_entry_id AS lastEntryId, file_size AS fileSize, file_mtime AS fileMtime
         FROM usage_backfill_state WHERE session_file = ?`,
      )
      .get(sessionFile) as { lastEntryId: string | null; fileSize: number | null; fileMtime: number | null } | undefined;

    // 文件未变化（size+mtime 一致）且已回填过 → 短路（避免每次会话释放全量读）
    if (state?.lastEntryId && state.fileSize === stat.size && state.fileMtime === stat.mtimeMs) {
      return 0;
    }

    let text: string;
    try {
      text = readFileSync(sessionFile, "utf8");
    } catch {
      return 0;
    }
    const entries = parseSessionJsonl(text);
    const overhead = parseSessionOverhead(text);
    if (entries.length === 0 && overhead.length === 0) return 0;
    const userMessages = countSessionUserMessages(text);
    const myBuddyModelId = this.taskModelIdForSession(sessionFile);

    // 水位之后的新条目（水位失效 → findIndex=-1 → startIdx=0 全量重扫，幂等）
    const startIdx = state?.lastEntryId
      ? entries.findIndex((e) => e.entryId === state.lastEntryId) + 1
      : 0;
    const newEntries = startIdx > 0 ? entries.slice(startIdx) : entries;

    // 1) live 认领：response_id 精确匹配 → 更新 entry_id（消除双计），user_turn 以
    //    jsonl 为准（应用中途接入时 live 计数可能低于 jsonl 重建值）
    const claimByResponseId = this.db.prepare(
      `UPDATE usage_events SET entry_id = @entryId, backfilled = 1, user_turn = @userTurn
       WHERE response_id = @responseId AND entry_id LIKE 'live:%' AND source_kind = 'main'`,
    );
    // 2) 顺序对齐认领：无 response_id 的 live 行按顺序匹配（同取 jsonl user_turn）
    const liveRows = this.db
      .prepare(
        `SELECT entry_id AS entryId, turn_index AS turnIndex, response_id AS responseId
         FROM usage_events WHERE session_file = ? AND entry_id LIKE 'live:%' ORDER BY COALESCE(turn_index, 0), ts ASC`,
      )
      .all(sessionFile) as Array<{ entryId: string; turnIndex: number | null; responseId: string | null }>;
    const claimByOrder = this.db.prepare(
      `UPDATE usage_events SET entry_id = @entryId, backfilled = 1, user_turn = @userTurn WHERE entry_id = @oldEntryId`,
    );

    const insert = this.db.prepare(
      `INSERT INTO usage_events (
        entry_id, task_id, session_file, source_kind, provider, model, response_model, ts,
        input_tokens, output_tokens, cache_read, cache_write, cache_write_1h, reasoning_tokens, total_tokens,
        cost_total, cost_input, cost_output, cost_cache_read, cost_cache_write,
        stop_reason, error_message, response_id, turn_index, user_turn, backfilled
      ) VALUES (?, ?, ?, 'main', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 1)
      ON CONFLICT(entry_id) DO UPDATE SET user_turn = excluded.user_turn
        WHERE usage_events.user_turn IS NULL`,
    );
    const insertOverhead = this.db.prepare(
      `INSERT OR IGNORE INTO usage_events (
        entry_id, task_id, session_file, source_kind, provider, model, response_model, ts,
        input_tokens, output_tokens, cache_read, cache_write, cache_write_1h, reasoning_tokens, total_tokens,
        cost_total, cost_input, cost_output, cost_cache_read, cost_cache_write,
        stop_reason, error_message, response_id, turn_index, user_turn, backfilled
      ) VALUES (?, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, 1)`,
    );

    const tx = this.db.transaction(() => {
      let handled = 0;
      // 认领：精确 response_id（只认领成功者——这是防双计且不丢行的关键：
      // 旧实现把"全部带 response_id 的条目"都标为已认领，导致回填只插入
      // 无 response_id 的行，带 response_id 的 assistant message 全部丢失）
      const claimedIds = new Set<string>();
      for (const e of entries) {
        if (!e.responseId) continue;
        const res = claimByResponseId.run({ entryId: e.entryId, responseId: e.responseId, userTurn: e.userTurn });
        if (res.changes > 0) {
          handled += 1;
          claimedIds.add(e.entryId);
        }
      }
      // 认领：顺序对齐（仅无 response_id 的 live 行与无 response_id 的 entry）
      const noRespLive = liveRows.filter((r) => !r.responseId);
      const noRespEntries = newEntries.filter((e) => !e.responseId);
      if (noRespLive.length > 0 && noRespEntries.length > 0) {
        const n = Math.min(noRespLive.length, noRespEntries.length);
        for (let i = 0; i < n; i++) {
          const res = claimByOrder.run({
            entryId: noRespEntries[i].entryId,
            oldEntryId: noRespLive[i].entryId,
            userTurn: noRespEntries[i].userTurn,
          });
          if (res.changes > 0) {
            handled += 1;
            claimedIds.add(noRespEntries[i].entryId);
          }
        }
      }
      // 插入未认领的新条目（含全部带 response_id 的历史条目；INSERT OR IGNORE 幂等）
      for (const e of newEntries) {
        if (claimedIds.has(e.entryId)) continue; // 本趟已认领（行已存在，entry_id 已更新）
        const u = e.usage ?? {};
        const total = u.totalTokens ?? ((u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0));
        const attributed = applyMyBuddyModelAttribution(
          { provider: e.provider, model: e.model },
          myBuddyModelId,
        );
        const res = insert.run(
          e.entryId,
          null,
          sessionFile,
          attributed.provider,
          attributed.model,
          attributed.responseModel,
          e.ts,
          u.input ?? 0,
          u.output ?? 0,
          u.cacheRead ?? 0,
          u.cacheWrite ?? 0,
          u.cacheWrite1h ?? null,
          u.reasoning ?? null,
          total,
          u.cost?.total ?? 0,
          u.cost?.input ?? 0,
          u.cost?.output ?? 0,
          u.cost?.cacheRead ?? 0,
          u.cost?.cacheWrite ?? 0,
          e.stopReason,
          e.errorMessage,
          e.responseId,
          e.userTurn,
        );
        if (res.changes > 0) handled += 1;
      }
      // 开销行（compaction/branch_summary/toolResult 带 usage）：计入 tokens/cost/cache hit，
      // 不计调用；每次扫描 INSERT OR IGNORE 幂等（文件未变时由 size/mtime 短路跳过）
      for (const o of overhead) {
        const u = o.usage ?? {};
        const total = u.totalTokens ?? ((u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0));
        const res = insertOverhead.run(
          o.entryId,
          sessionFile,
          o.kind,
          o.provider,
          o.model,
          o.ts,
          u.input ?? 0,
          u.output ?? 0,
          u.cacheRead ?? 0,
          u.cacheWrite ?? 0,
          total,
          u.cost?.total ?? 0,
          u.cost?.input ?? 0,
          u.cost?.output ?? 0,
          u.cost?.cacheRead ?? 0,
          u.cost?.cacheWrite ?? 0,
        );
        if (res.changes > 0) handled += 1;
      }
      // 更新水位 + 文件快照（size/mtime）+ 每 session user 消息数（turns 权威口径）；
      // 纯开销文件（无 assistant）时 last_entry_id 置 NULL（下次扫描全量重扫，
      // INSERT OR IGNORE 幂等；文件未变仍走 size/mtime 短路）
      const last = entries[entries.length - 1] ?? null;
      this.db
        .prepare(
          `INSERT INTO usage_backfill_state (session_file, last_entry_id, file_size, file_mtime, user_messages, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_file) DO UPDATE SET
             last_entry_id = excluded.last_entry_id,
             file_size = excluded.file_size,
             file_mtime = excluded.file_mtime,
             user_messages = excluded.user_messages,
             updated_at = excluded.updated_at`,
        )
        .run(sessionFile, last?.entryId ?? null, stat.size, stat.mtimeMs, userMessages, Date.now());
      return handled;
    });
    return tx();
  }

  /** 全量任务回填（同步；测试与显式调用用）。 */
  backfillAllTasks(listSessionFiles: Array<{ sessionFile: string | null }>): number {
    let total = 0;
    for (const t of listSessionFiles) {
      total += this.backfillSession(t.sessionFile);
    }
    return total;
  }

  /**
   * 异步分片回填（启动/后台用）：每批处理 batchSize 个文件后让出事件循环
   * （setImmediate），避免主进程启动阻塞。返回处理行数。
   */
  async backfillAllTasksAsync(listSessionFiles: Array<{ sessionFile: string | null }>, batchSize = 8): Promise<number> {
    let total = 0;
    for (let i = 0; i < listSessionFiles.length; i += batchSize) {
      const batch = listSessionFiles.slice(i, i + batchSize);
      for (const t of batch) {
        total += this.backfillSession(t.sessionFile);
      }
      if (i + batchSize < listSessionFiles.length) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    return total;
  }

  /** 扫描 subagent usage-archive.jsonl（幂等）。 */
  scanSubagentArchive(archivePath: string): number {
    if (!existsSync(archivePath)) return 0;
    let text: string;
    try {
      text = readFileSync(archivePath, "utf8");
    } catch {
      return 0;
    }
    const entries = parseSubagentArchive(text);
    const before = this.db.prepare(`SELECT COUNT(*) AS n FROM usage_events WHERE entry_id LIKE 'sub:%'`).get() as { n: number };
    this.recordSubagentArchive(entries);
    const after = this.db.prepare(`SELECT COUNT(*) AS n FROM usage_events WHERE entry_id LIKE 'sub:%'`).get() as { n: number };
    return after.n - before.n;
  }

  /**
   * 把已入库的 main/btw 行按 MyBuddy 任务 model_id 改记。
   * pi jsonl 的原模型写入 response_model（若空）。无 tasks 表时零操作。
   */
  reattributeToMyBuddyModels(): number {
    if (!this.hasTable("tasks")) return 0;
    const pairs = this.db
      .prepare(
        `SELECT e.entry_id AS entryId, e.provider AS provider, e.model AS model, t.model_id AS modelId
         FROM usage_events e
         JOIN tasks t ON t.session_file = e.session_file
         WHERE t.model_id IS NOT NULL AND TRIM(t.model_id) != ''
           AND e.source_kind IN ('main', 'btw')
           AND e.session_file IS NOT NULL`,
      )
      .all() as Array<{ entryId: string; provider: string | null; model: string | null; modelId: string }>;
    const update = this.db.prepare(
      `UPDATE usage_events SET provider = ?, model = ?, response_model = COALESCE(response_model, ?)
       WHERE entry_id = ?`,
    );
    let n = 0;
    const tx = this.db.transaction(() => {
      for (const row of pairs) {
        const attributed = applyMyBuddyModelAttribution(
          { provider: row.provider, model: row.model },
          row.modelId,
        );
        if (attributed.provider === row.provider && attributed.model === row.model) continue;
        update.run(attributed.provider, attributed.model, row.model, row.entryId);
        n += 1;
      }
    });
    tx();
    return n;
  }

  private hasTable(name: string): boolean {
    try {
      const row = this.db
        .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(name) as { ok: number } | undefined;
      return Boolean(row);
    } catch {
      return false;
    }
  }

  private taskModelIdForSession(sessionFile: string): string | null {
    if (!this.hasTable("tasks")) return null;
    try {
      const row = this.db
        .prepare(
          `SELECT model_id AS modelId FROM tasks WHERE session_file = ? AND model_id IS NOT NULL LIMIT 1`,
        )
        .get(sessionFile) as { modelId: string | null } | undefined;
      return row?.modelId?.trim() ? row.modelId : null;
    } catch {
      return null;
    }
  }

  /** 调试/测试辅助：直查。 */
  countRows(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM usage_events`).get() as { n: number }).n;
  }

  listSessionFiles(): Array<{ sessionFile: string | null }> {
    return this.db.prepare(`SELECT session_file AS sessionFile FROM tasks WHERE session_file IS NOT NULL`).all() as Array<{
      sessionFile: string | null;
    }>;
  }
}
