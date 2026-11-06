/**
 * subagent-cache-accounting-test.ts — 子代理缓存计量的记账链路（离线、无云调用）。
 *
 * 被测事实：子代理的 cacheRead / cacheWrite 从 pi 归一化 usage 出发，经
 * AgentService.recordDurableUsage → UsageStatsService.recordLive(sourceKind='subagent')
 * 落进 usage_events，再由 cacheHitRate 算出命中率。本用例锁住这条链上会静默出错的点：
 *
 * 1) 单次调用：cacheRead / cacheWrite 原样入库，命中率 = cacheRead/(input+cacheRead+cacheWrite)。
 * 2) 同会话两代（同一 conversationId，generation 递增）：两行独立存在，第二代的 cacheRead
 *    不含第一代，合计等于真实复用信息（不是"一行覆盖一行"）。
 * 3) 重复投递（onResponse 与 onEntries 用同一个 persistedEntryId 各报一次）：1 行，
 *    cacheRead 不双计——双计会让"缓存变好了"变成假象。
 * 4) 同 generation 不同会话：entry_id 含 conversationId，两行不互相吞掉。
 * 5) 失败的子代理（400 upstream_error，零 usage）：行存在但 total=0、known 全 false，
 *    不参与命中率分母——失败调用不得被统计成"缓存未命中"。
 * 6) 诊断侧只上报部分字段：cacheRead/cacheWrite 回落 pi 原生值；上报不带 cacheWrite 时
 *    input 也取原生值（否则 cache-write token 被算两次，命中率分母虚高）。
 * 7) 遗留归档读取路径（usage-archive.jsonl，启动扫描）保留 cache 字段与命中率，
 *    并对同一行重复扫描幂等。
 *
 * 不覆盖（需真上游，见交付说明）：真实前缀命中率随时间的走向、并发摊薄。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { UsageStatsService } from "../src/main/usage/UsageStatsService";
import type { ReportedTokenUsage } from "../src/shared/task-diagnostics";
import { cacheHitRate } from "../src/shared/usage-stats";

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
/** 与生产一致的近似比较（浮点命中率）。 */
function close(actual: number | null, expected: number, label: string): void {
  assert(actual !== null && Math.abs(actual - expected) < 1e-12, `${label}（期望 ${expected}，实际 ${actual}）`);
}

/** AppDatabase.ensureUsageTables 的等价结构；用例不启动 Electron / 完整 AppDatabase。 */
const SCHEMA = `
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
`;

const dir = mkdtempSync(join(tmpdir(), "subagent-cache-accounting-"));
/** summarize(rangeDays) 按 ts 过滤，用例时间戳必须落在窗口内（真实毫秒时间轴）。 */
const NOW = Date.now();
const at = (minutesAgo: number) => NOW - minutesAgo * 60_000;
const db = new Database(join(dir, "usage.db"));
db.exec(SCHEMA);
const svc = new UsageStatsService(db);

type Counters = { input: number; output: number; cacheRead: number; cacheWrite: number };
const TASK = "task-cache";
/**
 * 与 AgentService.recordDurableUsage 相同的入参形状：一个 generation 一条，
 * entry_id = durable:{taskId}:{conversationId}:generation:{generationTaskId}:{timestamp}。
 */
function recordChildGeneration(conversationId: string, generationTaskId: number, ts: number,
  usage: Counters, extra: {
    /** 与 TaskDiagnosticsRepository.usageForGeneration 同形：缺的字段是 null，不是省略。 */
    reportedUsage?: ReportedTokenUsage & { costTotal: number | null };
    stopReason?: string; errorMessage?: string; responseId?: string;
  } = {}): string {
  const entryId = `durable:${TASK}:${conversationId}:generation:${generationTaskId}:${ts}`;
  svc.recordLive({
    taskId: TASK,
    sessionFile: `durable:${TASK}:${conversationId}`,
    persistedEntryId: entryId,
    sourceKind: "subagent",
    sourceDetail: "pi-durable",
    reportedUsage: extra.reportedUsage,
    userTurn: null,
    sample: { turnIndex: generationTaskId, requestStartedAt: null, firstResponseAt: null, completedAt: ts,
      ttftMs: null, decodeMs: null, generationTps: null, modelWallMs: null, outputTokens: usage.output, reasoningTokens: null },
    message: { provider: "codex", model: "gpt-6.1-terra", responseId: extra.responseId ?? null,
      usage: { ...usage, cost: { total: 0 } },
      stopReason: extra.stopReason ?? "stop", errorMessage: extra.errorMessage, timestamp: ts },
  });
  return entryId;
}

function rowOf(entryId: string) {
  return svc.queryRows({ sourceKinds: ["subagent"] }).find((row) => row.entryId === entryId);
}

// ---------- 1) 冷启动一代：没有缓存命中 ----------
const gen1 = recordChildGeneration("conv-201", 394, at(60), { input: 1000, output: 10, cacheRead: 0, cacheWrite: 0 }, { responseId: "resp-394" });
const row1 = rowOf(gen1);
assert(row1 !== undefined, "子代理 generation 行入表（sourceKind=subagent）");
assert(row1?.sourceKind === "subagent" && row1?.sourceDetail === "pi-durable", "来源标记保持 subagent / pi-durable");
assert(row1?.cacheRead === 0 && row1?.cacheWrite === 0 && row1?.inputTokens === 1000 && row1?.outputTokens === 10,
  `首代 cacheRead=0、input=1000（实际 cacheRead=${row1?.cacheRead} input=${row1?.inputTokens}）`);
assert(row1?.known?.cacheRead === true && row1?.known.cacheWrite === true && row1?.known.input === true,
  `pi 上报的 0 是「已知的 0」而不是「未知」（known 位全 1）`);
close(cacheHitRate([row1!]), 0, "首代命中率 0（分母 1000 全未命中）");

// ---------- 2) 同会话下一代：同前缀第二次请求带 cacheRead ----------
const gen2 = recordChildGeneration("conv-201", 400, at(50), { input: 10, output: 10, cacheRead: 1000, cacheWrite: 0 }, { responseId: "resp-400" });
const row2 = rowOf(gen2);
assert(row2?.cacheRead === 1000 && row2?.inputTokens === 10, `第二代 cacheRead=1000、input=10（实际 cacheRead=${row2?.cacheRead} input=${row2?.inputTokens}）`);
const both = svc.queryRows({ sourceKinds: ["subagent"] }).filter((row) => row.entryId === gen1 || row.entryId === gen2);
assert(both.length === 2, `两代各自一行，不覆盖（${both.length}）`);
close(cacheHitRate(both), 1000 / 2010, "两代合计命中率 = 1000/(10+1000+0+1000)");
const sum2 = svc.summarize(3650);
assert(sum2.cacheRead === 1000 && sum2.input === 1010, `面板合计 cacheRead=1000 input=1010（实际 ${sum2.cacheRead}/${sum2.input}）`);

// ---------- 3) 重复投递同一 generation：不双计 ----------
recordChildGeneration("conv-201", 400, at(50), { input: 10, output: 10, cacheRead: 1000, cacheWrite: 0 }, { responseId: "resp-400" });
const afterRedelivery = svc.queryRows({ sourceKinds: ["subagent"] }).filter((row) => row.entryId === gen2);
assert(afterRedelivery.length === 1, "onResponse + onEntries 同 entry_id 重复投递仍 1 行");
assert(svc.summarize(3650).cacheRead === 1000, `重复投递后 cacheRead 仍为 1000（实际 ${svc.summarize(3650).cacheRead}）`);

// ---------- 4) 同 generation 不同会话：互不吞并 ----------
const other = recordChildGeneration("conv-202", 400, at(50), { input: 500, output: 10, cacheRead: 0, cacheWrite: 0 });
assert(rowOf(other) !== undefined && rowOf(other)?.cacheRead === 0, "不同 conversationId 同 generation 各自成行（entry_id 含会话）");
close(cacheHitRate([row1!, row2!, rowOf(other)!]), 1000 / 2510, "三行合计命中率 = 1000/(1000+10+1000+500)");

// ---------- 5) 失败的子代理：零用量不得算成缓存未命中 ----------
const failedEntry = recordChildGeneration("conv-203", 410, at(40), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  { stopReason: "error", errorMessage: "400 upstream_error: provider rejected the request" });
const failedRow = rowOf(failedEntry);
assert(failedRow !== undefined && failedRow.totalTokens === 0, "失败行入表但 total=0");
// pi 对失败调用上报的是显式 0（不是缺字段），所以 known 仍为 1；保护点是"分母为 0 时
// 命中率为 null"，不能让一条 0/0 的行把 0.39 的命中率打成 0。
assert(failedRow?.known?.cacheRead === true && failedRow?.known.input === true, "显式上报的 0 视为已知的 0（known=true）");
assert(cacheHitRate([failedRow!]) === null, "失败行自身分母为 0 → 命中率 null，不是 0");
assert(svc.summarize(3650).errors === 1, `失败行计入 errors（${svc.summarize(3650).errors}）`);
close(svc.summarize(3650).cacheHitRate, 1000 / 2510, "失败行不改变命中率分母");

// ---------- 6) 诊断侧只报部分字段：回落 pi 原生值 ----------
const partial = recordChildGeneration("conv-204", 420, at(30), { input: 5, output: 5, cacheRead: 7000, cacheWrite: 0 },
  { reportedUsage: { input: 5, output: 5, cacheRead: null, cacheWrite: null, costTotal: null } });
const partialRow = rowOf(partial);
assert(partialRow?.cacheRead === 7000, `上报缺 cacheRead 时回落原生 7000（实际 ${partialRow?.cacheRead}）`);
assert(partialRow?.known?.cacheRead === true, "回落后 cacheRead 视为已知");
const reportedNoWrite = recordChildGeneration("conv-205", 421, at(20), { input: 30, output: 5, cacheRead: 100, cacheWrite: 20 },
  { reportedUsage: { input: 999, output: 5, cacheRead: 100, cacheWrite: null, costTotal: null } });
const writtenRow = rowOf(reportedNoWrite);
assert(writtenRow?.inputTokens === 30, `上报不含 cacheWrite 时 input 取原生 30，不把 cache-write 算进未命中侧（实际 ${writtenRow?.inputTokens}）`);
assert(writtenRow?.cacheWrite === 20, `cacheWrite 取原生 20（实际 ${writtenRow?.cacheWrite}）`);

// ---------- 7) 遗留归档读取路径：cache 字段与命中率保持不变 ----------
// 用户提供的真实归档行（cacheRead 数量级 1e6、cacheWrite 恒 0）。
const archiveLine = JSON.stringify({ subagentId: "reviewer-enx5pj", role: "reviewer", scope: "01a1aa7e", finishedAt: 1793868535769,
  status: "completed", model: "opendesign/deepseek-v4.1-flash", runCount: 1,
  usage: { input: 44392, output: 23588, cacheRead: 1231360, cacheWrite: 0, cost: 0, contextTokens: 78587, turns: 27 } });
const archivePath = join(dir, "usage-archive.jsonl");
writeFileSync(archivePath, archiveLine + "\n", "utf8");
assert(svc.scanSubagentArchive(archivePath) === 1, "归档行入库");
const archived = svc.queryRows({ sourceKinds: ["subagent"] }).find((row) => row.entryId.startsWith("sub:reviewer-enx5pj"));
assert(archived?.cacheRead === 1231360 && archived?.cacheWrite === 0, `归档 cacheRead=1231360 保留（实际 ${archived?.cacheRead}）`);
close(cacheHitRate([archived!]), 1231360 / (44392 + 1231360), "归档行命中率用同一分母口径");
assert(svc.scanSubagentArchive(archivePath) === 0, "同一归档文件重复扫描 0 新增（幂等）");
assert(svc.summarize(3650).cacheRead === 1_231_360 + 1000 + 7000 + 100, `面板合计含归档 cacheRead（实际 ${svc.summarize(3650).cacheRead}）`);

// ---------- 8) 归档行缺字段：不得当成"已知的缓存未命中" ----------
// 归档行可能不带 cacheRead/cacheWrite（老写入者 / 迁移产物）。数值列就是 0，若没有 coverage
// 行，queryRows 会回落"total>0 即全已知"，于是缺字段的行按 0 命中入分母——实测把只有真命中
// 行时的 0.9 稀释到 0.818。这条用例锁住"缺字段 = 未知"。
const dir2 = mkdtempSync(join(tmpdir(), "subagent-cache-missing-"));
const db2 = new Database(join(dir2, "usage.db"));
db2.exec(SCHEMA);
const svc2 = new UsageStatsService(db2);
const archive2 = join(dir2, "usage-archive.jsonl");
writeFileSync(archive2, [
  JSON.stringify({ subagentId: "sa-missing", finishedAt: NOW - 60_000, status: "completed", usage: { input: 100, output: 10 } }),
  JSON.stringify({ subagentId: "sa-hit", finishedAt: NOW - 50_000, status: "completed", usage: { input: 100, output: 10, cacheRead: 900, cacheWrite: 0 } }),
].join("\n") + "\n", "utf8");
assert(svc2.scanSubagentArchive(archive2) === 2, "两条归档行入库");
const missingRow = svc2.queryRows({ sourceKinds: ["subagent"] }).find((row) => row.entryId.startsWith("sub:sa-missing"));
const hitRow = svc2.queryRows({ sourceKinds: ["subagent"] }).find((row) => row.entryId.startsWith("sub:sa-hit"));
assert(missingRow?.known?.cacheRead === false && missingRow?.known.cacheWrite === false,
  `缺 cacheRead/cacheWrite 的归档行标为未知（实际 ${JSON.stringify(missingRow?.known)}）`);
assert(missingRow?.known?.input === true && missingRow?.known.output === true, "缺的只是 cache 字段：input/output 仍已知");
assert(hitRow?.known?.cacheRead === true, "带 cacheRead 的归档行仍是已知");
assert(cacheHitRate([hitRow!]) === 0.9, `真命中行单独命中率 0.9（实际 ${cacheHitRate([hitRow!])}）`);
close(svc2.summarize(3650).cacheHitRate, 0.9, "缺字段行不参与命中率分母（不被当成未命中）");
assert(svc2.summarize(3650).cacheRead === 900, `命中率之外的合计仍含两行的 cacheRead（${svc2.summarize(3650).cacheRead}）`);
assert(svc2.scanSubagentArchive(archive2) === 0, "缺字段场景重复扫描幂等");
assert(svc2.queryRows({ sourceKinds: ["subagent"] }).filter((row) => row.known?.cacheRead === true).length === 1,
  "重复扫描不得把缺字段行的 known 位改回已知");
db2.close();
rmSync(dir2, { recursive: true, force: true });

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n结果: passed=${passed} failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);
