/**
 * usage-stats-test.ts — 用量统计针对性测试。
 *
 * 覆盖（阶段 0-5）：
 * 1) PerformanceTracker 状态机：text-first / thinking-first / toolcall-only /
 *    极短响应兜底 / output=0 / error / abort / 连续多轮不串 / turn_start 缺失兜底。
 * 2) 聚合口径：cache hit（= cacheRead/(input+cacheRead+cacheWrite)，对齐 pi footer CH；
 *    分母 0 → null 不 NaN；全 cacheWrite 轮 → 0；cacheWrite 稀释命中率）、错误率、TTFT/TPS 平均仅非 null、
 *    calls=模型调用行（排除 compaction/toolresult 开销行与 dispose 结算行）、
 *    turns=distinct user_turn（用户轮次；JSONL 可重建）、
 *    开销行计入 tokens/cost 不计调用、drilldown、趋势、53 周热力图、CSV。
 * 3) 回填：jsonl 解析（中断行跳过、compaction/model_change 忽略、user_turn 重建）、
 *    live 认领（response_id 精确 + 顺序对齐）、幂等（重复回填不双计）、水位、
 *    P0 回归：带 response_id 的纯回填会话全部入表、live 键 responseId 防碰撞。
 * 5) known 判定（供应商不上报的能力缺口）：cacheWrite 未知只降级命中率分母、
 *    provider 未上报时回落 pi 原生计数（known 全 true）、两边都没有仍为 unknown，
 *    观测值（诊断口径）的 null 不覆盖 pi 账本算出的计数与命中率。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { PerformanceTracker } from "../src/main/usage/PerformanceTracker";
import { UsageStatsService, parseSessionJsonl, parseSubagentArchive } from "../src/main/usage/UsageStatsService";
import { TaskDiagnosticsRepository } from "../src/main/agent/TaskDiagnosticsRepository";
import { mergeContextUsage } from "../src/main/usage/context-usage-merge";
import {
  applyMyBuddyModelAttribution,
  summarizeRows,
  groupByProviderModel,
  cacheHitRate,
  dailyTrend,
  dailyActivity,
  weekHeatmap,
  monthlySummary,
  toCsv,
  isoWeek,
  rangeStartMs,
  localDayKey,
  localDayStart,
  streakStats,
  longestSessionMs,
  parseSkillInvocations,
  weeklyTotals,
  barHeights,
  mondayIndex,
  type UsageEventRow,
} from "../src/shared/usage-stats";

let passed = 0;
let failed = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

console.log("== 阶段 0：PerformanceTracker 状态机 ==");
{
  // 普通 text 优先
  const t = new PerformanceTracker();
  t.onTurnStart(0, 1000);
  t.onMessageUpdate("start", 1010); // 结构事件不采
  t.onMessageUpdate("text_delta", 1500);
  t.onMessageUpdate("text_delta", 1510);
  const s = t.onMessageEnd(2500, { usage: { output: 100 } });
  assert(s?.ttftMs === 500 && s?.decodeMs === 1000, "TTFT=firstResponseAt-requestStartedAt；decode=end-first");
  assert(s?.generationTps === 100 && s?.modelWallMs === 1500, "TPS=output/decodeSec；wall=end-start");

  // thinking-first
  const t2 = new PerformanceTracker();
  t2.onTurnStart(0, 2000);
  t2.onMessageUpdate("thinking_delta", 2200);
  const s2 = t2.onMessageEnd(4000, { usage: { output: 50, reasoning: 20 } });
  assert(s2?.ttftMs === 200 && s2?.reasoningTokens === 20, "thinking_delta 为首响应");

  // toolcall-only（无 text delta）
  const t3 = new PerformanceTracker();
  t3.onTurnStart(0, 3000);
  t3.onMessageUpdate("toolcall_start", 3100);
  t3.onMessageUpdate("toolcall_delta", 3110);
  const s3 = t3.onMessageEnd(3200, { usage: { output: 0 } });
  assert(s3?.ttftMs === 100 && s3?.generationTps === null, "toolcall 首响应；output=0 → TPS null 不造数");

  // 极短响应兜底（仅 *_end）
  const t4 = new PerformanceTracker();
  t4.onTurnStart(0, 4000);
  t4.onMessageUpdate("text_end", 4100);
  const s4 = t4.onMessageEnd(4200, { usage: { output: 5 } });
  assert(s4?.ttftMs === 100, "text_end 兜底首响应");

  // error / abort 仍记 wall time
  const t5 = new PerformanceTracker();
  t5.onTurnStart(0, 5000);
  t5.onMessageUpdate("thinking_delta", 5200);
  const s5 = t5.onMessageEnd(7000, { usage: { output: 0 }, stopReason: "error", errorMessage: "boom" });
  assert(s5?.stopReason === "error" && s5?.modelWallMs === 2000 && s5?.generationTps === null, "error 记 wall + TPS null");

  // 连续多轮不串
  const t6 = new PerformanceTracker();
  t6.onTurnStart(0, 100);
  t6.onMessageUpdate("text_delta", 200);
  t6.onMessageEnd(300, { usage: { output: 10 } });
  t6.onTurnStart(1, 500);
  t6.onMessageUpdate("text_delta", 800);
  const s6 = t6.onMessageEnd(900, { usage: { output: 20 } });
  assert(s6?.ttftMs === 300 && s6?.outputTokens === 20, "第二轮样本独立（300ms / 20 tok）");

  // turn_start 缺失 → null（不崩）
  const t7 = new PerformanceTracker();
  const s7 = t7.onMessageEnd(100, { usage: { output: 1 } });
  assert(s7 === null, "无 pending 的 message_end → null");

  // agent_settled 丢弃孤悬 pending
  const t8 = new PerformanceTracker();
  t8.onTurnStart(0, 100);
  t8.onMessageUpdate("text_delta", 150);
  t8.onSettled();
  assert(t8.pendingCount === 0 && t8.onMessageEnd(200, { usage: { output: 1 } }) === null, "settled 后孤悬样本丢弃");

  // 时钟异常防御：firstResponseAt < requestStartedAt → TTFT/decode null（不入库负值）
  const t9 = new PerformanceTracker();
  t9.onTurnStart(0, 5000);
  t9.onMessageUpdate("text_delta", 4000); // 早于 requestStart（时钟抖动）
  const s9 = t9.onMessageEnd(6000, { usage: { output: 10 } });
  assert(s9?.ttftMs === null && s9?.decodeMs === 2000 && s9?.generationTps === 5 && s9?.modelWallMs === 1000, "首响应早于起点 → TTFT null、decode/TPS 正常");
  const t10 = new PerformanceTracker();
  t10.onTurnStart(0, 5000);
  t10.onMessageUpdate("text_delta", 5100);
  const s10 = t10.onMessageEnd(4900, { usage: { output: 10 } }); // end 早于首响应
  assert(s10?.decodeMs === null && s10?.generationTps === null && s10?.modelWallMs === null, "end 早于首响应 → decode/TPS/wall null");

  // settlePending：BTW dispose 场景安全结算
  const t11 = new PerformanceTracker();
  t11.onTurnStart(3, 1000);
  t11.onMessageUpdate("thinking_delta", 1200);
  const s11 = t11.settlePending(2000, "disposed");
  assert(s11?.outputTokens === 0 && s11?.generationTps === null && s11?.modelWallMs === 1000 && s11?.ttftMs === 200, "settlePending 记 wall+TTFT、无 token、TPS null");
  assert(t11.pendingCount === 0 && t11.settlePending(2100) === null, "settle 后 pending 清空，二次 settle null");
}

console.log("== 阶段 1/4：聚合口径 ==");
{
  const base: UsageEventRow = {
    entryId: "e1", taskId: "t", sessionFile: "s", sourceKind: "main", sourceDetail: null,
    provider: "anthropic", model: "claude", responseModel: null, ts: 1750000000000,
    inputTokens: 100, outputTokens: 50, cacheRead: 200, cacheWrite: 30, cacheWrite1h: null,
    reasoningTokens: 10, totalTokens: 380, costTotal: 0.01,
    stopReason: "stop", errorMessage: null, ttftMs: 500, decodeMs: 1000, generationTps: 50, modelWallMs: 1500,
    turnIndex: 0, userTurn: 1,
  };
  const errRow: UsageEventRow = { ...base, entryId: "e2", stopReason: "error", errorMessage: "x", ttftMs: null, generationTps: null, turnIndex: 1 };
  const rows = [base, errRow];

  const sum = summarizeRows(rows);
  assert(sum.calls === 2 && sum.turns === 1 && sum.sessions === 1, "calls=模型调用行；turns=distinct user_turn（同用户轮次→1）；sessions 不放大");
  // BTW 会话合并修复：多个 sessionFile=null 的 BTW 会话同轮次不得合并；
  // 同会话两次用户轮次（userTurn 1/2）必须区分
  const btwRows: UsageEventRow[] = [
    { ...base, entryId: "b1", sourceKind: "btw", taskId: "btw-1", sessionFile: null, turnIndex: 0, userTurn: 1 },
    { ...base, entryId: "b2", sourceKind: "btw", taskId: "btw-2", sessionFile: null, turnIndex: 0, userTurn: 1 },
    { ...base, entryId: "b3", sourceKind: "btw", taskId: "btw-2", sessionFile: null, turnIndex: 1, userTurn: 2 },
  ];
  const btwSum = summarizeRows(btwRows);
  assert(btwSum.turns === 3, `BTW 多会话 turns 不合并（${btwSum.turns}）`);
  assert(btwSum.sessions === 2, "BTW 会话数按 taskId 区分");
  assert(sum.avgTtftMs === 500 && sum.avgTps === 50, "TTFT/TPS 平均仅非 null");
  assert(sum.errorRate === 0.5 && sum.errors === 1 && sum.calls === 2, "错误率=errors/calls=1/2");
  const hit = cacheHitRate(rows);
  assert(hit !== null && Math.abs(hit - 200 / 330) < 1e-9, "cache hit = cacheRead/(input+cacheRead+cacheWrite)=400/660（含 cacheWrite 60）");
  assert(cacheHitRate([]) === null, "无数据 cache hit → null 不 NaN");

  // 全 cacheWrite 轮（input=cacheRead=0, cacheWrite>0）：分母>0 → 0 而非 null（对齐 pi footer 显示 0%)
  const writeOnly: UsageEventRow = { ...base, entryId: "w1", inputTokens: 0, cacheRead: 0, cacheWrite: 8000, totalTokens: 8050 };
  const hitWriteOnly = cacheHitRate([writeOnly]);
  assert(hitWriteOnly !== null && hitWriteOnly === 0, "全 cacheWrite 轮 → 0 而非 null（分母=cacheWrite>0）");
  // 分母只含 cacheWrite 的聚合也成立（多行混合）
  const hitMixed = cacheHitRate([writeOnly, { ...base, entryId: "w2", inputTokens: 0, cacheRead: 0, cacheWrite: 2000, totalTokens: 2050 }]);
  assert(hitMixed !== null && hitMixed === 0, "多行全 cacheWrite → 仍 0");

  // cacheWrite 属未命中侧：同 input/cacheRead 下 cacheWrite 越大命中率越低（稀释）
  const noWrite: UsageEventRow = { ...base, entryId: "n1", cacheWrite: 0, totalTokens: 350 };
  const hitNoWrite = cacheHitRate([noWrite]);
  const hitWithWrite = cacheHitRate([base]);
  assert(
    hitNoWrite !== null && hitWithWrite !== null && hitWithWrite < hitNoWrite,
    `cacheWrite 稀释命中率（${hitNoWrite?.toFixed(4)} > ${hitWithWrite?.toFixed(4)}）`,
  );

  // 与 pi footer CH 公式等价：cacheRead / (input + cacheRead + cacheWrite)
  const piCh = (rs: UsageEventRow[]): number | null => {
    const i = rs.reduce((a, r) => a + r.inputTokens, 0);
    const cr = rs.reduce((a, r) => a + r.cacheRead, 0);
    const cw = rs.reduce((a, r) => a + r.cacheWrite, 0);
    return i + cr + cw > 0 ? cr / (i + cr + cw) : null;
  };
  assert(hit !== null && piCh(rows) !== null && Math.abs(hit - piCh(rows)!) < 1e-12, "与 pi 官方 CH=cacheRead/(input+cacheRead+cacheWrite) 数值等价");
  assert(piCh([]) === null && cacheHitRate([]) === null, "pi 等价：无数据均为 null");

  const attributed = applyMyBuddyModelAttribution(
    { provider: "opencode-go", model: "mimo-v2.5" },
    "opencode-go/gpt-5.6-luna",
  );
  assert(
    attributed.provider === "opencode-go" &&
      attributed.model === "gpt-5.6-luna" &&
      attributed.responseModel === "mimo-v2.5",
    "用量按 MyBuddy 选择记账，pi 模型退到 responseModel",
  );
  const passthrough = applyMyBuddyModelAttribution({ provider: "anthropic", model: "claude" }, null);
  assert(passthrough.provider === "anthropic" && passthrough.model === "claude", "无 MyBuddy 模型 → 保留原值");

  const dd = groupByProviderModel(rows);
  assert(dd.length === 1 && dd[0].calls === 2 && dd[0].errors === 1, "drilldown 按 provider+model 聚合");
  const multi = groupByProviderModel([
    base,
    { ...base, entryId: "luna", model: "gpt-5.6-luna", totalTokens: 900, turnIndex: 2 },
    { ...base, entryId: "glm", model: "glm-5.3", provider: "opencode-go", totalTokens: 400, turnIndex: 3 },
  ]);
  assert(
    multi.length === 3 &&
      multi.some((r) => r.model === "gpt-5.6-luna") &&
      multi.some((r) => r.model === "glm-5.3"),
    "drilldown 按实际 model 分行，不把其它模型吞进默认行",
  );

  const csv = toCsv(rows);
  assert(csv.split("\n").length === 3 && csv.includes("anthropic"), "CSV 导出行数");

  const now = Date.now();
  const trend = dailyTrend([{ ...base, ts: now - 3 * 86400000 }], 7, now);
  assert(trend.length === 7 && trend.some((t) => t.tokens > 0), "日趋势=7 个本地日点");
  assert(trend.every((t) => /^\d{4}-\d{2}-\d{2}$/.test(t.key)), "趋势键是本地 YYYY-MM-DD");
  const todayStart = localDayStart(now);
  assert(rangeStartMs(1, now) === todayStart, "今天 = 本地 0 点，不是滚动 24h");
  const sixDaysAgo = new Date(todayStart);
  sixDaysAgo.setDate(sixDaysAgo.getDate() - 6);
  sixDaysAgo.setHours(0, 0, 0, 0);
  assert(rangeStartMs(7, now) === sixDaysAgo.getTime(), "7 天从 6 天前本地 0 点起");
  const previousTz = process.env.TZ;
  try {
    for (const [zone, date, expectedFirst] of [
      ["America/New_York", "2026-03-10", "2026-03-04"],
      ["America/New_York", "2026-11-03", "2026-10-28"],
      ["America/Santiago", "2026-09-06", "2026-08-31"],
      ["America/Santiago", "2026-09-08", "2026-09-02"],
      ["America/Sao_Paulo", "2018-11-04", "2018-10-29"],
      ["America/Sao_Paulo", "2018-11-06", "2018-10-31"],
    ]) {
      process.env.TZ = zone;
      const end = new Date(`${date}T12:00:00`).getTime();
      const start = rangeStartMs(7, end);
      const points = dailyTrend([{ ...base, ts: end }], 7, end);
      assert(localDayKey(start) === expectedFirst && new Date(start).getHours() === 0, `DST ${date}: 起点为正确本地午夜`);
      assert(points.length === 7 && new Set(points.map(point => point.key)).size === 7, `DST ${date}: 七个不重复日历日`);
      assert(points[0]?.key === expectedFirst && points.at(-1)?.key === date, `DST ${date}: 保留窗口首尾日期`);
      assert(points.at(-1)?.tokens === base.totalTokens, `DST ${date}: 当日用量不丢失`);
    }
  } finally {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  }
  const heat = weekHeatmap([{ ...base, ts: now }], new Date().getFullYear());
  assert(heat.length === 53 && heat.some((h) => h.tokens > 0), "53 周热力图");
  const month = monthlySummary(rows);
  assert(month.length >= 1, "月度汇总");
  assert(isoWeek(new Date("2026-01-01T00:00:00Z")) >= 1 && isoWeek(new Date("2026-01-01T00:00:00Z")) <= 53, "isoWeek 有效");
}

console.log("== 阶段 2：jsonl 解析与回填幂等 ==");
{
  const jsonl = [
    JSON.stringify({ type: "session", id: "s1", timestamp: "2026-01-01T00:00:00Z", cwd: "C:/" }),
    JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: [] } }),
    JSON.stringify({ type: "message", id: "m2", parentId: null, timestamp: "2026-01-01T00:00:02Z", message: { role: "assistant", provider: "openai", model: "gpt-x", timestamp: 1750000000000, usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.1 } }, stopReason: "stop", responseId: "resp-1" } }),
    JSON.stringify({ type: "message", id: "m3", parentId: null, timestamp: "2026-01-01T00:00:03Z", message: { role: "assistant", provider: "deepseek", model: "ds", timestamp: 1750000000001, usage: { input: 20, output: 8 }, stopReason: "stop" } }),
    JSON.stringify({ type: "model_change", id: "mc", provider: "openai", modelId: "gpt-x" }),
    JSON.stringify({ type: "compaction", id: "c1", summary: "x", tokensBefore: 99, usage: { input: 5, output: 5 } }),
    "{\"type\": \"message\", \"id\": \"partial", // 中断残留行
  ].join("\n");

  const parsed = parseSessionJsonl(jsonl);
  assert(parsed.length === 2, `仅 assistant message 计入（${parsed.length}；model_change/compaction/中断行忽略）`);
  assert(parsed[0].responseId === "resp-1" && parsed[0].order === 0, "response_id + 顺序");
  assert(parsed[0].userTurn === 1 && parsed[1].userTurn === 1, "user_turn 重建：两个 assistant 均属首个 user message 后的轮次");

  // 真实 DB 回填：live 行 + 回填 → 不双计
  const dir = mkdtempSync(join(tmpdir(), "usage-test-"));
  const dbPath = join(dir, "test.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE usage_events (
      entry_id TEXT PRIMARY KEY, task_id TEXT, session_file TEXT,
      source_kind TEXT NOT NULL DEFAULT 'main', source_detail TEXT,
      provider TEXT, model TEXT, response_model TEXT, ts INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0,
      cache_write_1h INTEGER, reasoning_tokens INTEGER, total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_total REAL NOT NULL DEFAULT 0, cost_input REAL NOT NULL DEFAULT 0,
      cost_output REAL NOT NULL DEFAULT 0, cost_cache_read REAL NOT NULL DEFAULT 0,
      cost_cache_write REAL NOT NULL DEFAULT 0, stop_reason TEXT, error_message TEXT,
      request_started_at INTEGER, first_response_at INTEGER, completed_at INTEGER,
      ttft_ms INTEGER, decode_ms INTEGER, generation_tps REAL, model_wall_ms INTEGER,
      response_id TEXT, turn_index INTEGER, backfilled INTEGER NOT NULL DEFAULT 0,
      user_turn INTEGER
    );
    CREATE TABLE usage_backfill_state (session_file TEXT PRIMARY KEY, last_entry_id TEXT, file_size INTEGER, file_mtime INTEGER, user_messages INTEGER, updated_at INTEGER NOT NULL);
  `);
  const svc = new UsageStatsService(db);
  const sessionFile = join(dir, "session.jsonl");
  writeFileSync(sessionFile, jsonl, "utf8");

  // 1) live 投影两行（含 response_id 与无 response_id）
  svc.recordLive({
    taskId: "t1", sessionFile, sourceKind: "main",
    sample: { turnIndex: 0, requestStartedAt: Date.now() - 2000, firstResponseAt: Date.now() - 1000, completedAt: Date.now() - 500, ttftMs: 1000, decodeMs: 500, generationTps: 10, modelWallMs: 1500, outputTokens: 5, reasoningTokens: null },
    message: { provider: "openai", model: "gpt-x", responseId: "resp-1", usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.1 } }, stopReason: "stop" },
  });
  svc.recordLive({
    taskId: "t1", sessionFile, sourceKind: "main",
    sample: { turnIndex: 1, requestStartedAt: Date.now() - 2000, firstResponseAt: Date.now() - 1000, completedAt: Date.now() - 500, ttftMs: 1000, decodeMs: 500, generationTps: 8, modelWallMs: 1500, outputTokens: 8, reasoningTokens: null },
    message: { provider: "deepseek", model: "ds", usage: { input: 20, output: 8 } },
  });
  assert(svc.countRows() === 2, "live 2 行");

  // 2) 回填：response_id 认领 + 顺序对齐认领 + 开销行（compaction usage）插入 → 不双计
  const handled = svc.backfillSession(sessionFile);
  assert(handled === 3, `回填认领 2 + 开销行 1 = ${handled}（compaction usage 入表）`);
  const rows = svc.queryRows({});
  assert(rows.length === 3, `回填后 3 行（2 调用 + 1 开销；无双计）`);
  const claimed = rows.find((r) => r.entryId === "m2");
  assert(claimed?.entryId === "m2" && claimed?.responseId === "resp-1" && claimed?.backfilled === 1, "response_id 精确认领");
  assert(claimed?.userTurn === 1, "认领行 user_turn 以 jsonl 重建值为准");
  const claimedOrder = rows.find((r) => r.entryId === "m3");
  assert(claimedOrder?.entryId === "m3" && claimedOrder?.model === "ds", "顺序对齐认领（无 response_id）");
  const compRow = rows.find((r) => r.sourceKind === "compaction");
  assert(compRow?.entryId === "c1" && compRow?.inputTokens === 5 && compRow?.totalTokens === 10, "compaction 开销行入表（tokens 计入）");

  // 3) 幂等：重复回填不新增
  const handled2 = svc.backfillSession(sessionFile);
  assert(handled2 === 0 && svc.countRows() === 3, "重复回填 0 处理（幂等）");

  // 4) 聚合：calls 不含开销行，tokens/cost 含开销行（对齐 pi getSessionStats）
  const sum2 = svc.summarize(3650);
  assert(sum2.calls === 2 && sum2.turns === 1 && sum2.input === 35 && sum2.output === 18, `回填行参与聚合：calls=2（开销不计）input=35（含 compaction 5）output=18（含 compaction 5）turns=${sum2.turns}`);

  // 5) subagent archive
  const archive = JSON.stringify({ subagentId: "sa-1", role: "Review", scope: "s", finishedAt: Date.now(), model: "ds", usage: { input: 7, output: 3, cacheRead: 1, cacheWrite: 0, cost: 0.01 } });
  const parsedSub = parseSubagentArchive(archive + "\n" + "not-json\n");
  assert(parsedSub.length === 1 && parsedSub[0].subagentId === "sa-1", "subagent archive 解析（坏行跳过）");
  writeFileSync(join(dir, "usage-archive.jsonl"), archive + "\n", "utf8");
  const added = svc.scanSubagentArchive(join(dir, "usage-archive.jsonl"));
  assert(added === 1, `subagent archive 入库（${added}）`);
  assert(svc.scanSubagentArchive(join(dir, "usage-archive.jsonl")) === 0, "subagent 重复扫描 0 新增（幂等）");
  const subRows = svc.queryRows({ sourceKinds: ["subagent"] });
  assert(subRows.length === 1 && subRows[0].sourceKind === "subagent", "sourceKind 过滤");

  // 6) 同 id 多次归档（复用运行实例）→ 每次一行，不覆盖（key=sub:{id}:{runCount}:{finishedAt}）
  const archive2 = JSON.stringify({ subagentId: "sa-1", role: "Review", scope: "s", finishedAt: Date.now() + 1000, model: "ds", usage: { input: 9, output: 4, cacheRead: 0, cacheWrite: 1, cost: 0.02 } });
  writeFileSync(join(dir, "usage-archive.jsonl"), archive + "\n" + archive2 + "\n", "utf8");
  const added2 = svc.scanSubagentArchive(join(dir, "usage-archive.jsonl"));
  assert(added2 === 1, `同 id 两次归档 → 第二条也入库（${added2}）`);
  const subRows2 = svc.queryRows({ sourceKinds: ["subagent"] });
  assert(subRows2.length === 2, `同 id 复用累计 2 行（${subRows2.length}）`);
  assert(svc.scanSubagentArchive(join(dir, "usage-archive.jsonl")) === 0, "含同 id 多行的 archive 重复扫描幂等");

  // 7) finishedAt 同毫秒碰撞：同 id 同 finishedAt 但 runCount 不同 → 仍两条
  const archive3 = JSON.stringify({ subagentId: "sa-2", role: "R", scope: "s", finishedAt: 999, runCount: 1, usage: { input: 1, output: 1 } });
  const archive4 = JSON.stringify({ subagentId: "sa-2", role: "R", scope: "s", finishedAt: 999, runCount: 2, usage: { input: 2, output: 2 } });
  writeFileSync(join(dir, "usage-archive.jsonl"), archive3 + "\n" + archive4 + "\n", "utf8");
  const added3 = svc.scanSubagentArchive(join(dir, "usage-archive.jsonl"));
  assert(added3 === 2, `同毫秒不同 runCount → 2 条（${added3}）`);
  const subRows3 = svc.queryRows({ sourceKinds: ["subagent"] });
  const sa2 = subRows3.filter((r) => r.entryId.includes("sa-2"));
  assert(sa2.length === 2, `同 id 同毫秒 runCount 消歧（${sa2.length}）`);
  assert(svc.scanSubagentArchive(join(dir, "usage-archive.jsonl")) === 0, "runCount 场景重复扫描幂等");

  // 8) backfill 短路：文件未变化（size/mtime 一致）→ 0 处理（不重复全量读）\n\n  // 8) backfill 短路：文件未变化（size/mtime 一致）→ 0 处理（不重复全量读）
  const handled3 = svc.backfillSession(sessionFile);
  assert(handled3 === 0, `文件未变化短路（${handled3}）`);

  // 2b) P0 回归 1：纯回填会话（无 live 行）——带 responseId 的 assistant 全部入表。
  //     旧 claimedIds 缺陷把"全部带 responseId 的条目"视为已认领 → 只插入无
  //     responseId 的行，实测 80 行 vs jsonl 上千条。
  const sfBf = join(dir, "backfill-only.jsonl");
  writeFileSync(
    sfBf,
    [
      JSON.stringify({ type: "message", id: "u1", message: { role: "user", content: "q" } }),
      JSON.stringify({ type: "message", id: "a1", message: { role: "assistant", provider: "anthropic", model: "c", timestamp: 1, responseId: "r1", usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.1 } }, stopReason: "toolUse" } }),
      JSON.stringify({ type: "message", id: "a2", message: { role: "assistant", provider: "anthropic", model: "c", timestamp: 2, responseId: "r2", usage: { input: 20, output: 8, cacheRead: 4, cacheWrite: 0, cost: { total: 0.2 } }, stopReason: "stop" } }),
    ].join("\n"),
    "utf8",
  );
  assert(svc.backfillSession(sfBf) === 2, "纯回填：2 条带 responseId 全部处理（P0 修复）");
  const bfRows = svc.queryRows({}).filter((r) => r.sessionFile === sfBf);
  assert(bfRows.length === 2 && bfRows.every((r) => r.backfilled === 1), `带 responseId 回填行全部入表（${bfRows.length}/2）`);
  assert(bfRows.map((r) => r.entryId).sort().join(",") === "a1,a2", "entry_id=真实 jsonl id");
  assert(bfRows.every((r) => r.userTurn === 1), `user_turn 重建=1（${bfRows.map((r) => r.userTurn).join(",")}）`);
  const bfSum = summarizeRows(svc.queryRows({}).filter((r) => r.sessionFile === sfBf));
  assert(
    bfSum.calls === 2 && bfSum.turns === 1 && bfSum.cacheRead === 6 && Math.abs(bfSum.cost - 0.3) < 1e-9,
    `纯回填聚合与 jsonl 一致（calls=2 turns=1 cacheRead=6 cost=0.3；实际 ${bfSum.calls}/${bfSum.turns}/${bfSum.cacheRead}/${bfSum.cost}）`,
  );
  assert(svc.backfillSession(sfBf) === 0, "纯回填幂等（重复扫描 0 处理）");

  // 2b) P0 回归 2：live 键防碰撞——同 session 同 turnIndex（pi 原始事件恒为 0）不同
  //     responseId → 两行都入（旧键 live:file:0 会 INSERT OR IGNORE 丢行）
  const sfLive = join(dir, "live-collide.jsonl");
  const mkSample = (ti: number) => ({
    turnIndex: ti, requestStartedAt: 1, firstResponseAt: 2, completedAt: 3,
    ttftMs: 1, decodeMs: 1, generationTps: null, modelWallMs: 2, outputTokens: 5, reasoningTokens: null,
  });
  svc.recordLive({
    taskId: "t", sessionFile: sfLive, sourceKind: "main", sample: mkSample(0),
    message: { responseId: "rA", usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.1 } }, stopReason: "stop" },
    userTurn: 1,
  });
  svc.recordLive({
    taskId: "t", sessionFile: sfLive, sourceKind: "main", sample: mkSample(0),
    message: { responseId: "rB", usage: { input: 20, output: 8, cacheRead: 4, cacheWrite: 0, cost: { total: 0.2 } }, stopReason: "stop" },
    userTurn: 1,
  });
  const liveRows = svc.queryRows({}).filter((r) => r.sessionFile === sfLive);
  assert(liveRows.length === 2, `同 session 同 turnIndex 不同 responseId → 2 行（${liveRows.length}）`);
  assert(liveRows.some((r) => r.responseId === "rA") && liveRows.some((r) => r.responseId === "rB"), "两行 responseId 各自保留");
  assert(liveRows.every((r) => r.userTurn === 1), "live user_turn 写入");

  // 2b) P0 回归 3：dispose 安全结算行不计调用（pi 未持久化该 assistant message，
  //     权威 assistantMessages 不含它；tokens/cost 为 0 不影响聚合）
  svc.recordLive({
    taskId: "b1", sessionFile: null, sourceKind: "btw", sample: mkSample(0),
    message: { stopReason: "disposed" },
  });
  const dispRows = svc.queryRows({}).filter((r) => r.taskId === "b1");
  assert(dispRows.length === 1, "dispose 结算行入表");
  const dispSum = summarizeRows(dispRows);
  assert(dispSum.calls === 0 && dispSum.turns === 0 && dispSum.totalTokens === 0, "dispose 结算行：calls=0 turns=0 tokens=0");

  // 2b) P0 回归 4：尾部无回复 user message——turns 权威口径 = jsonl user 消息数
  //     （回填水位 user_messages；含无回复轮次，对齐 pi userMessages）
  const sfTail = join(dir, "tail-user.jsonl");
  writeFileSync(
    sfTail,
    [
      JSON.stringify({ type: "message", id: "t1", message: { role: "user", content: "q1" } }),
      JSON.stringify({ type: "message", id: "t2", message: { role: "assistant", provider: "p", model: "m", timestamp: 5, responseId: "rt1", usage: { input: 10, output: 5, cost: { total: 0.01 } }, stopReason: "stop" } }),
      JSON.stringify({ type: "message", id: "t3", message: { role: "user", content: "q2 无回复" } }),
    ].join("\n"),
    "utf8",
  );
  assert(svc.backfillSession(sfTail) === 1, "尾部 user 无回复：仅 1 条 assistant 入表");
  const tailRows = svc.queryRows({}).filter((r) => r.sessionFile === sfTail);
  const tailPure = summarizeRows(tailRows); // 纯行聚合（无水位）→ 只有 1 个 distinct user_turn
  assert(tailPure.turns === 1, `纯行聚合 turns=1（仅 1 轮有调用；${tailPure.turns}）`);
  assert(svc.sessionUserTurnCounts().get(sfTail) === 2, "回填水位 user_messages=2（含无回复轮次）");
  const tailWithState = summarizeRows(tailRows, svc.sessionUserTurnCounts());
  assert(tailWithState.turns === 1, `窗口内轮次只计有调用的 distinct user_turn（${tailWithState.turns}）`);

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log("== 阶段 3：MyBuddy 模型记账（不跟 pi message.model） ==");
{
  const dir = mkdtempSync(join(tmpdir(), "usage-mybuddy-"));
  const db = new Database(join(dir, "t.db"));
  db.exec(`
    CREATE TABLE usage_events (
      entry_id TEXT PRIMARY KEY, task_id TEXT, session_file TEXT,
      source_kind TEXT NOT NULL DEFAULT 'main', source_detail TEXT,
      provider TEXT, model TEXT, response_model TEXT, ts INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0,
      cache_write_1h INTEGER, reasoning_tokens INTEGER, total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_total REAL NOT NULL DEFAULT 0, cost_input REAL NOT NULL DEFAULT 0,
      cost_output REAL NOT NULL DEFAULT 0, cost_cache_read REAL NOT NULL DEFAULT 0,
      cost_cache_write REAL NOT NULL DEFAULT 0, stop_reason TEXT, error_message TEXT,
      request_started_at INTEGER, first_response_at INTEGER, completed_at INTEGER,
      ttft_ms INTEGER, decode_ms INTEGER, generation_tps REAL, model_wall_ms INTEGER,
      response_id TEXT, turn_index INTEGER, backfilled INTEGER NOT NULL DEFAULT 0,
      user_turn INTEGER
    );
    CREATE TABLE usage_backfill_state (session_file TEXT PRIMARY KEY, last_entry_id TEXT, file_size INTEGER, file_mtime INTEGER, user_messages INTEGER, updated_at INTEGER NOT NULL);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, model_id TEXT, session_file TEXT);
  `);
  const svc = new UsageStatsService(db);
  const sf = join(dir, "s.jsonl");
  writeFileSync(
    sf,
    JSON.stringify({
      type: "message",
      id: "a1",
      message: {
        role: "assistant",
        provider: "opencode-go",
        model: "mimo-v2.5",
        timestamp: Date.now(),
        responseId: "r1",
        usage: { input: 10, output: 5, cost: { total: 0.01 } },
        stopReason: "stop",
      },
    }),
    "utf8",
  );
  db.prepare(`INSERT INTO tasks (id, model_id, session_file) VALUES (?, ?, ?)`).run(
    "t1",
    "opencode-go/gpt-5.6-luna",
    sf,
  );

  const sample = {
    turnIndex: 0,
    requestStartedAt: 1,
    firstResponseAt: 2,
    completedAt: 3,
    ttftMs: 1,
    decodeMs: 1,
    generationTps: null,
    modelWallMs: 2,
    outputTokens: 5,
    reasoningTokens: null,
  };
  svc.recordLive({
    taskId: "t1",
    sessionFile: sf + "-live",
    sourceKind: "main",
    sample,
    message: { provider: "opencode-go", model: "mimo-v2.5", responseId: "live-1", usage: { input: 10, output: 5 } },
    modelId: "opencode-go/gpt-5.6-luna",
  });
  const live = svc.queryRows({}).find((r) => r.responseId === "live-1");
  assert(live?.model === "gpt-5.6-luna" && live.provider === "opencode-go", "live 按 MyBuddy modelId 记账");
  assert(live?.responseModel === "mimo-v2.5", "pi 模型保留在 responseModel");

  const handled = svc.backfillSession(sf);
  assert(handled >= 1, `回填插入 MyBuddy 模型行（${handled}）`);
  const bf = svc.queryRows({}).find((r) => r.entryId === "a1");
  assert(bf?.model === "gpt-5.6-luna", "回填按 tasks.model_id 记账，不跟 jsonl mimo");
  assert(bf?.responseModel === "mimo-v2.5", "回填保留 pi 模型到 responseModel");

  // 历史行：先按 pi 模型入库，再回写
  db.prepare(
    `INSERT INTO usage_events (entry_id, session_file, source_kind, provider, model, ts, total_tokens, cost_total)
     VALUES ('old1', ?, 'main', 'opencode-go', 'mimo-v2.5', 1, 10, 0)`,
  ).run(sf);
  const n = svc.reattributeToMyBuddyModels();
  assert(n >= 1, `历史行按任务模型回写（${n}）`);
  const old = svc.queryRows({}).find((r) => r.entryId === "old1");
  assert(old?.model === "gpt-5.6-luna", "回写后历史行是 MyBuddy 模型");
  assert(old?.responseModel === "mimo-v2.5", "回写把原 pi 模型放到 responseModel");
  assert(svc.reattributeToMyBuddyModels() === 0, "回写幂等");

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log("== 阶段 4：窗口口径 / 活跃度 / skills ==");
{
  const now = Date.now();
  const today = localDayStart(now);
  const base: UsageEventRow = {
    entryId: "e", taskId: "t", sessionFile: "s.jsonl", sourceKind: "main", sourceDetail: null,
    provider: "opencode-go", model: "luna", responseModel: "mimo", ts: today + 3600_000,
    inputTokens: 10, outputTokens: 5, cacheRead: 20, cacheWrite: 0, cacheWrite1h: null,
    reasoningTokens: null, totalTokens: 35, costTotal: 0.01,
    stopReason: "stop", errorMessage: null, ttftMs: 100, decodeMs: 200, generationTps: 10, modelWallMs: 300,
    turnIndex: 0, userTurn: 1,
  };
  const compact: UsageEventRow = { ...base, entryId: "c", sourceKind: "compaction", userTurn: null, ttftMs: null, generationTps: null, modelWallMs: null };
  const sum = summarizeRows([base, compact]);
  assert(sum.sessions === 1, "compaction 不拆成第二个会话");
  assert(sum.calls === 1, "compaction 不计调用");
  assert(sum.totalTokens === 70, "compaction token 计入总量");

  const old = { ...base, entryId: "old", ts: today - 10 * 86400000, userTurn: 9, sessionFile: "s.jsonl" };
  const inRange = summarizeRows([old, base]);
  assert(inRange.turns === 2, "不同 user_turn 计 2");
  // 旧算法用水位会把整段会话 50 轮算进 7 天；新算法只看传入行
  assert(inRange.turns !== 50, "不用整段 jsonl 水位膨胀窗口轮次");

  const days = dailyActivity(
    [
      { ...base, ts: today },
      { ...base, entryId: "y", ts: today - 86400000, totalTokens: 100 },
      { ...base, entryId: "z", ts: today - 2 * 86400000, totalTokens: 0, userTurn: 3 },
    ],
    today - 3 * 86400000,
    now,
  );
  const st = streakStats(days, localDayKey(now));
  assert(st.current >= 2 && st.longest >= 2, `连续天数 current=${st.current} longest=${st.longest}`);

  const long = longestSessionMs([
    { ...base, ts: today, modelWallMs: 1000, userTurn: 1 },
    { ...base, entryId: "e2", ts: today + 30 * 60_000, modelWallMs: 1000, userTurn: 1 },
  ]);
  assert(long >= 30 * 60_000, `同一轮运行按时长计（${long}）`);
  const splitDays = longestSessionMs([
    { ...base, entryId: "old", ts: today - 6 * 86400000, userTurn: 1, modelWallMs: 40_000 },
    { ...base, entryId: "new", ts: today, userTurn: 2, modelWallMs: 50_000 },
  ]);
  assert(splitDays === 50_000, `跨日会话不把日历跨度当最长任务（${splitDays}）`);

  const skills = parseSkillInvocations(
    [
      JSON.stringify({ type: "message", message: { role: "user", content: "/officecli 帮我改文档" } }),
      JSON.stringify({ type: "message", message: { role: "user", content: "$docs-sprint\n继续" } }),
      JSON.stringify({ type: "message", message: { role: "user", content: "请看 C:/officecli/foo" } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: "/not-a-skill" } }),
    ].join("\n"),
  );
  assert(skills.get("officecli") === 1 && skills.get("docs-sprint") === 1, "只统计用户消息行首 /skill 或 $skill");
  assert(!skills.has("foo") && !skills.has("not-a-skill"), "路径和助手消息不算 skill");

  assert(mondayIndex("2026-08-17") === 0, "2026-08-17 是周一");
  assert(mondayIndex("2026-08-16") === 6, "2026-08-16 是周日");
  const weekDays = [
    { date: "2026-08-16", tokens: 10, calls: 1 }, // Sun → 上一周
    { date: "2026-08-17", tokens: 20, calls: 1 }, // Mon → 新一周
    { date: "2026-08-18", tokens: 5, calls: 1 },
  ];
  const weeks = weeklyTotals(weekDays);
  assert(weeks.length >= 2, `周一对齐至少两周（${weeks.length}）`);
  assert(weeks[0].tokens === 10, `周日计入上一周（${weeks[0]?.tokens}）`);
  assert(weeks[1].tokens === 25, `周一起新一周（${weeks[1]?.tokens}）`);
  assert(JSON.stringify(barHeights([0, 10, 50], 7)) === JSON.stringify([0, 1, 7]), "柱高：空=0、有量至少 1、峰值=满格");
  assert(JSON.stringify(barHeights([10, 20, 30], 7)) === JSON.stringify([2, 5, 7]), "柱高等比");
  const cum = [10, 20, 30].reduce<number[]>((a, v) => {
    a.push((a[a.length - 1] ?? 0) + v);
    return a;
  }, []);
  assert(JSON.stringify(barHeights(cum, 7)) === JSON.stringify([1, 4, 7]), "累计柱从左到右升高");
}

console.log("== 阶段 5：known 判定与缓存命中率降级（供应商不上报 cache_creation） ==");
{
  const mkRow = (over: Partial<UsageEventRow>): UsageEventRow => ({
    entryId: "r", taskId: "t", sessionFile: "s", sourceKind: "main", sourceDetail: null,
    provider: "opencode-go", model: "glm-5", responseModel: null, ts: 1750000000000,
    inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: null,
    reasoningTokens: null, totalTokens: 0, costTotal: 0,
    stopReason: "stop", errorMessage: null, ttftMs: null, decodeMs: null, generationTps: null, modelWallMs: null,
    turnIndex: 0, userTurn: 1,
    ...over,
  });
  const allKnown = { input: true, output: true, cacheRead: true, cacheWrite: true, cost: true };

  // 5.1 面板真实口径（输入 42.1K / 缓存读 996.1K / 输出 26.8K，供应商不报 cache_creation）：
  // cacheWrite 未知不能让命中率整体变 null，分母降级为 input+cacheRead。
  const chatCompletions = mkRow({
    entryId: "cc", inputTokens: 42_100, outputTokens: 26_800, cacheRead: 996_100, cacheWrite: 0,
    totalTokens: 1_065_000, known: { ...allKnown, cacheWrite: false },
  });
  const degraded = cacheHitRate([chatCompletions]);
  assert(
    degraded !== null && Math.abs(degraded - 996_100 / (42_100 + 996_100)) < 1e-12,
    `cacheWrite 未知 → 分母 input+cacheRead，命中率有值（${degraded}）`,
  );
  const [group] = groupByProviderModel([chatCompletions]);
  assert(
    group.cacheHitRate !== null && degraded !== null && Math.abs(group.cacheHitRate - degraded) < 1e-12,
    `模型明细命中率同样降级（${group.cacheHitRate}）`,
  );
  // 分子未知（cacheRead unknown）或分母没有已知分量 → 该行不参与，全部不可用 → null（不用 0 冒充）
  assert(cacheHitRate([mkRow({ cacheRead: 100, known: { ...allKnown, cacheRead: false } })]) === null, "cacheRead 未知 → 命中率仍为 null");
  assert(
    cacheHitRate([mkRow({ cacheRead: 100, known: { ...allKnown, input: false, cacheWrite: false } })]) === null,
    "input 与 cacheWrite 都未知 → 没有可信分母 → null",
  );

  const dir = mkdtempSync(join(tmpdir(), "usage-known-"));
  const db = new Database(join(dir, "t.db"));
  db.exec(`
    CREATE TABLE usage_events (
      entry_id TEXT PRIMARY KEY, task_id TEXT, session_file TEXT,
      source_kind TEXT NOT NULL DEFAULT 'main', source_detail TEXT,
      provider TEXT, model TEXT, response_model TEXT, ts INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0,
      cache_write_1h INTEGER, reasoning_tokens INTEGER, total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_total REAL NOT NULL DEFAULT 0, cost_input REAL NOT NULL DEFAULT 0,
      cost_output REAL NOT NULL DEFAULT 0, cost_cache_read REAL NOT NULL DEFAULT 0,
      cost_cache_write REAL NOT NULL DEFAULT 0, stop_reason TEXT, error_message TEXT,
      request_started_at INTEGER, first_response_at INTEGER, completed_at INTEGER,
      ttft_ms INTEGER, decode_ms INTEGER, generation_tps REAL, model_wall_ms INTEGER,
      response_id TEXT, turn_index INTEGER, backfilled INTEGER NOT NULL DEFAULT 0,
      user_turn INTEGER
    );
  `);
  const svc = new UsageStatsService(db);
  const sample = { turnIndex: 0, requestStartedAt: null, firstResponseAt: null, completedAt: 1000,
    ttftMs: null, decodeMs: null, generationTps: null, modelWallMs: null, outputTokens: 200, reasoningTokens: null };
  const nativeUsage = { input: 500, output: 200, cacheRead: 900, cacheWrite: 100, totalTokens: 1700, cost: { total: 0.01 } };

  // 5.2 provider 未上报（AgentService.recordDurableUsage 的真实形状：usageForGeneration 未命中
  //     → reportedUsage 全 null）→ 回落 pi 原生计数，known 全 true，面板不再显示「未知」。
  svc.recordLive({
    taskId: "t", sessionFile: "durable:t:c1", sourceKind: "main", sourceDetail: "pi-durable",
    reportedUsage: { input: null, output: null, cacheRead: null, cacheWrite: null, costTotal: null },
    persistedEntryId: "durable:t:c1:generation:1:1000", sample,
    message: { provider: "opencode-go", model: "glm-5", responseId: "r1", timestamp: 1000, usage: nativeUsage, stopReason: "stop" },
  });
  const live = svc.queryRows({})[0]!;
  assert(
    live.inputTokens === 500 && live.outputTokens === 200 && live.cacheRead === 900 && live.cacheWrite === 100 && live.totalTokens === 1700,
    `provider 未上报 → 回落 pi 原生计数（${live.inputTokens}/${live.outputTokens}/${live.cacheRead}/${live.cacheWrite}/${live.totalTokens}）`,
  );
  assert(
    live.known?.input === true && live.known.output === true && live.known.cacheRead === true && live.known.cacheWrite === true,
    "known 四项均 true（输入/输出/缓存读取/缓存写入 不再是「未知」）",
  );
  const knownSummary = summarizeRows(svc.queryRows({}));
  assert(
    knownSummary.cacheHitRate !== null && Math.abs(knownSummary.cacheHitRate - 900 / 1500) < 1e-12,
    `面板命中率 = 900/(500+900+100)（${knownSummary.cacheHitRate}）`,
  );
  assert(knownSummary.input === 500 && knownSummary.known?.cacheWrite === true, `汇总输入与 known 一致（input=${knownSummary.input}）`);

  // 5.3 两边都没有计数 → 仍然是 unknown（不用 0 冒充）
  svc.recordLive({
    taskId: "t", sessionFile: "durable:t:c1", sourceKind: "main", sourceDetail: "pi-durable",
    persistedEntryId: "durable:t:c1:generation:2:2000", sample,
    message: { responseId: "r2", timestamp: 2000, stopReason: "error", errorMessage: "boom" },
  });
  const blind = svc.queryRows({}).find((r) => r.entryId === "durable:t:c1:generation:2:2000")!;
  assert(
    blind.known?.input === false && blind.known.output === false && blind.known.cacheRead === false && blind.known.cacheWrite === false,
    "无上报也无原生计数 → known 全 false（未知）",
  );
  assert(summarizeRows([blind]).cacheHitRate === null, "无可用分量的行不给命中率");

  // 5.4 上报与原生混合：上报不含 cacheWrite 时其 input 已含 cache-write（prompt-cached），
  //     pi 原生单独扣出 → input 取原生值，避免与原生 cacheWrite 双计。
  svc.recordLive({
    taskId: "t", sessionFile: "durable:t:c2", sourceKind: "main", sourceDetail: "pi-durable",
    reportedUsage: { input: 1200, output: 200, cacheRead: 5000, cacheWrite: null, costTotal: null },
    persistedEntryId: "durable:t:c2:generation:1:3000", sample,
    message: { provider: "openai", model: "gpt", responseId: "r3", timestamp: 3000,
      usage: { input: 1000, output: 200, cacheRead: 5000, cacheWrite: 200, totalTokens: 6400, cost: { total: 0.02 } }, stopReason: "stop" },
  });
  const mixed = svc.queryRows({}).find((r) => r.entryId === "durable:t:c2:generation:1:3000")!;
  assert(
    mixed.inputTokens === 1000 && mixed.cacheWrite === 200 && mixed.totalTokens === 6400 && mixed.known?.cacheWrite === true,
    `上报缺 cacheWrite 时不与原生 cacheWrite 双计（${mixed.inputTokens}/${mixed.cacheWrite}/${mixed.totalTokens}）`,
  );

  // 5.5 上下文弹窗来源（TaskDiagnosticsRepository.usageForConversation）：供应商不报
  //     cache_creation → cacheWrite 未知只降级分母，命中率不再整体 null。
  const diagDb = new Database(join(dir, "diag.db"));
  diagDb.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY);
    CREATE TABLE conversation_interactions (task_id TEXT, execution_id TEXT);`);
  diagDb.prepare(`INSERT INTO tasks (id) VALUES ('t1')`).run();
  const repo = new TaskDiagnosticsRepository(diagDb);
  const diagnosticModel = { provider: "opencode-go", id: "glm-5", api: "openai-completions" };
  for (const [n, usage] of [
    [1, { input: 1000, output: 200, cacheRead: 5000, cacheWrite: null }],
    [2, { input: 4200, output: 800, cacheRead: 94_000, cacheWrite: null }],
  ] as const) {
    repo.observeTrace({ request: `rq${n}`, at: n, event: "execution", taskId: "t1", conversationId: "c1",
      generationTaskId: n, sourceKind: "main", executionScope: "t1" }, diagnosticModel);
    repo.observeTrace({ request: `rq${n}`, at: n + 10, event: "result", outcome: "stop", reportedUsage: usage }, diagnosticModel);
  }
  const observed = repo.usageForConversation("t1", "c1");
  assert(
    observed.inputTokens === 5200 && observed.outputTokens === 1000 && observed.cacheReadTokens === 99_000,
    `诊断会话合计只丢未知分量（${observed.inputTokens}/${observed.outputTokens}/${observed.cacheReadTokens}）`,
  );
  assert(
    observed.cacheHitRate !== null && Math.abs(observed.cacheHitRate - 99_000 / (5200 + 99_000)) < 1e-12,
    `cacheWrite 未知不再把上下文命中率整体置 null（${observed.cacheHitRate}）`,
  );
  repo.observeTrace({ request: "rq3", at: 20, event: "execution", taskId: "t1", conversationId: "c2",
    generationTaskId: 3, sourceKind: "main", executionScope: "t1" }, diagnosticModel);
  repo.observeTrace({ request: "rq3", at: 21, event: "result", outcome: "stop" }, diagnosticModel);
  const blindObserved = repo.usageForConversation("t1", "c2");
  assert(blindObserved.inputTokens === null && blindObserved.cacheHitRate === null, "完全没有上报 → 上下文用量仍是未知");
  diagDb.close();

  // 5.6 观测值合并：null 只表示「不知道」，不能覆盖 pi 账本算出的计数与命中率。
  const computed = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 100 };
  const merged = mergeContextUsage(computed, { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheHitRate: null });
  assert(merged.inputTokens === 100 && merged.outputTokens === 50 && merged.cacheReadTokens === 900, "观测值 null 不覆盖账本计数");
  assert(
    merged.cacheHitRate !== null && Math.abs(merged.cacheHitRate - 900 / 1100) < 1e-12,
    `观测值 null 不覆盖账本命中率（${merged.cacheHitRate}）`,
  );
  const observedWins = mergeContextUsage(computed, { inputTokens: 7, outputTokens: 3, cacheReadTokens: 11, cacheHitRate: 0.25 });
  assert(observedWins.inputTokens === 7 && observedWins.cacheHitRate === 0.25, "观测值已知时仍优先（诊断口径）");
  assert(
    mergeContextUsage({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }).cacheHitRate === null,
    "账本无计数 → 命中率 null",
  );

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log("== 阶段 6：legacy 行 known 兜底 / 零用量行不污染 / 历史 coverage 幂等修复 ==");
{
  const dir = mkdtempSync(join(tmpdir(), "usage-legacy-"));
  const db = new Database(join(dir, "t.db"));
  // 真实库的两类历史形态：老 pi-durable 行完全没有 coverage 行；旧写入 bug 留下
  // 1110 / 0000 两种错误 coverage。
  db.exec(`
    CREATE TABLE usage_events (
      entry_id TEXT PRIMARY KEY, task_id TEXT, session_file TEXT,
      source_kind TEXT NOT NULL DEFAULT 'main', source_detail TEXT,
      provider TEXT, model TEXT, response_model TEXT, ts INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0,
      cache_write_1h INTEGER, reasoning_tokens INTEGER, total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_total REAL NOT NULL DEFAULT 0, cost_input REAL NOT NULL DEFAULT 0,
      cost_output REAL NOT NULL DEFAULT 0, cost_cache_read REAL NOT NULL DEFAULT 0,
      cost_cache_write REAL NOT NULL DEFAULT 0, stop_reason TEXT, error_message TEXT,
      request_started_at INTEGER, first_response_at INTEGER, completed_at INTEGER,
      ttft_ms INTEGER, decode_ms INTEGER, generation_tps REAL, model_wall_ms INTEGER,
      response_id TEXT, turn_index INTEGER, backfilled INTEGER NOT NULL DEFAULT 0,
      user_turn INTEGER
    );
    CREATE TABLE usage_event_coverage (
      entry_id TEXT PRIMARY KEY REFERENCES usage_events(entry_id) ON DELETE CASCADE ON UPDATE CASCADE,
      input_known INTEGER NOT NULL, output_known INTEGER NOT NULL,
      cache_read_known INTEGER NOT NULL, cache_write_known INTEGER NOT NULL, cost_known INTEGER NOT NULL
    );
  `);
  const ts = Date.now();
  const insertRow = db.prepare(`INSERT INTO usage_events (entry_id, session_file, source_kind, source_detail, provider, model, ts,
      input_tokens, output_tokens, cache_read, cache_write, total_tokens, cost_total, stop_reason)
    VALUES (@entryId, NULL, 'main', @sourceDetail, 'opencode-go', 'glm-5', @ts,
      @input, @output, @cacheRead, @cacheWrite, @total, @cost, @stopReason)`);
  const insertCoverage = db.prepare(`INSERT INTO usage_event_coverage VALUES (?,?,?,?,?,?)`);
  // A) 旧 bug 的 live 行：coverage 1110（cacheWrite 被误判 unknown），token 列是真实值
  insertRow.run({ entryId: "live-1110", sourceDetail: "pi-durable", ts, input: 100, output: 20, cacheRead: 900, cacheWrite: 0, total: 1020, cost: 0.001, stopReason: "stop" });
  insertCoverage.run("live-1110", 1, 1, 1, 0, 1);
  // B) 老 pi-durable 行：完全没有 coverage 行（真实库 19k 行这种）
  insertRow.run({ entryId: "legacy-nocoverage", sourceDetail: "pi-durable", ts, input: 50, output: 10, cacheRead: 400, cacheWrite: 0, total: 460, cost: 0.002, stopReason: "stop" });
  // C) 旧 bug 的 live 行：coverage 全 unknown 但 token 列真实（reported 缺失 + costKnown=false 路径）
  insertRow.run({ entryId: "live-0000", sourceDetail: "pi-durable", ts, input: 30, output: 5, cacheRead: 200, cacheWrite: 0, total: 235, cost: 0, stopReason: "stop" });
  insertCoverage.run("live-0000", 0, 0, 0, 0, 0);
  // D) 零用量失败行（tier_limit 400，未消耗 token）：无 coverage
  insertRow.run({ entryId: "fail-nocoverage", sourceDetail: "pi-durable", ts, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, stopReason: "error" });
  // E) 零用量失败行：coverage 全 unknown
  insertRow.run({ entryId: "fail-0000", sourceDetail: "pi-durable", ts, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, stopReason: "error" });
  insertCoverage.run("fail-0000", 0, 0, 0, 0, 0);

  // 构造即修复（历史 coverage，幂等）
  const svc = new UsageStatsService(db);
  const coverageOf = (id: string) =>
    db.prepare(`SELECT input_known AS i,output_known AS o,cache_read_known AS cr,cache_write_known AS cw,cost_known AS c
      FROM usage_event_coverage WHERE entry_id=?`).get(id) as { i: number; o: number; cr: number; cw: number; c: number } | undefined;
  assert(JSON.stringify(coverageOf("live-1110")) === '{"i":1,"o":1,"cr":1,"cw":1,"c":1}', "repair：1110 的历史行恢复 cacheWrite known");
  assert(JSON.stringify(coverageOf("live-0000")) === '{"i":1,"o":1,"cr":1,"cw":1,"c":1}', "repair：全 unknown 且 total>0 的历史行四字段 + 费用恢复 known");
  assert(JSON.stringify(coverageOf("fail-0000")) === '{"i":0,"o":0,"cr":0,"cw":0,"c":0}', "repair：total=0 的失败行保持 unknown（不用 0 冒充已知）");
  assert(svc.repairLegacyCoverage() === 0, "repair 幂等（重复执行 0 行变更）");

  // repair 不动 usage_events 的 token 数值
  const raw = db.prepare(`SELECT input_tokens AS i,output_tokens AS o,cache_read AS cr,cache_write AS cw,total_tokens AS t
    FROM usage_events WHERE entry_id='live-0000'`).get() as { i: number; o: number; cr: number; cw: number; t: number };
  assert(raw.i === 30 && raw.o === 5 && raw.cr === 200 && raw.cw === 0 && raw.t === 235, "repair 只改 known 位、不动 token 数值");

  // 无 coverage 行的兜底：total>0 → 四字段 known；total=0 → unknown
  const rows = svc.queryRows({});
  const legacyRow = rows.find((r) => r.entryId === "legacy-nocoverage")!;
  const failRow = rows.find((r) => r.entryId === "fail-nocoverage")!;
  assert(
    legacyRow.known?.input === true && legacyRow.known.output === true && legacyRow.known.cacheRead === true && legacyRow.known.cacheWrite === true,
    "无 coverage 老行（total>0）按行内数据判定 known=true，不再因 pi-durable 一律未知",
  );
  assert(failRow.known?.input === false && failRow.known.cacheWrite === false, "无 coverage 且 total=0 → 保持 unknown");
  assert(failRow.totalTokens === 0 && legacyRow.totalTokens === 460, "行内 token 未被改写");

  // 面板（dashboard(1)）：三类行都在窗口内，零用量失败行不得把已知位/命中率降级
  const d = svc.dashboard(1);
  assert(d.input === 180 && d.output === 35 && d.cacheRead === 1500 && d.cacheWrite === 0, `面板四项有值（${d.input}/${d.output}/${d.cacheRead}/${d.cacheWrite}）`);
  assert(d.totalTokens === 1715, `面板累计 tokens=${d.totalTokens}（零用量行贡献 0）`);
  assert(
    d.known?.input === true && d.known.output === true && d.known.cacheRead === true && d.known.cacheWrite === true,
    `含 total=0 失败行时 known 仍为 true（${JSON.stringify(d.known)}）`,
  );
  // 费用口径（用户 2026-11-06）：有真实用量的行，费用视为已知（没上报就是 0）；
  // total=0 的失败行仍未知，且不参与 known 聚合。
  assert(d.known?.cost === true, `有真实用量的行费用视为已知（${JSON.stringify(d.known)}）`);
  assert(legacyRow.known?.cost === true, "无 coverage 老行（total>0）费用 known=true");
  assert(failRow.known?.cost === false, "total=0 失败行费用仍 unknown（不用 0 冒充已知）");
  assert(
    d.cacheHitRate !== null && Math.abs(d.cacheHitRate - 1500 / 1680) < 1e-12,
    `含 total=0 失败行时命中率仍非 null（${d.cacheHitRate}）`,
  );
  assert(d.calls === 5 && d.errors === 2, `calls/errors 仍按调用行统计（${d.calls}/${d.errors}）`);
  assert(
    d.models.length === 1 && d.models[0].known?.input === true && d.models[0].known?.cacheWrite === true,
    "模型明细 known 同样不被零用量行污染",
  );
  assert(d.models[0].cacheHitRate !== null && Math.abs(d.models[0].cacheHitRate - 1500 / 1680) < 1e-12, "模型明细命中率有值");
  // 热力/趋势也不因零用量行降级（同一 summarizeRows 口径）
  assert(svc.summarize(1).known?.cacheRead === true, "summarize 与 dashboard 同口径");

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n结果: passed=${passed} failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);












