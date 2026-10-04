/**
 * usage-reconciliation-test.ts — PI 权威三方对账测试。
 *
 * 权威 = 当前安装版 pi AgentSession.getSessionStats（assistantMessages=模型调用数、
 * userTurns=用户消息数、tokens/cost 含 assistant+toolResult+compaction 全部 usage）。
 * 覆盖：
 * 1) computePiSessionStats 从合成 jsonl 重建 PI 统计（含 toolCall 块、toolResult usage、
 *    compaction usage、中断残留行容错）。
 * 2) 经 UsageStatsService 回填入库 → reconcileUsageRows 三方对账一致（calls/turns/
 *    input/output/cacheRead/cacheWrite/cost）。
 * 3) 负向：删行/篡改 usage → 对账报告 mismatch（ok=false）。
 * 4) live 行 + 回填认领后对账仍一致（不双计、不丢行）。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { UsageStatsService } from "../src/main/usage/UsageStatsService";
import { computePiSessionStats, reconcileUsageRows } from "../src/shared/usage-reconciliation";
import { summarizeRows, type UsageEventRow } from "../src/shared/usage-stats";

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

const TS0 = 1750000000000;

/** 合成 pi session jsonl：2 个用户轮次；工具循环（同轮多次模型调用）；toolResult 带 usage；compaction 带 usage。 */
function syntheticJsonl(): string {
  const user = (id: string, content: string) =>
    JSON.stringify({ type: "message", id, message: { role: "user", content } });
  const assistant = (
    id: string,
    responseId: string,
    usage: object,
    stopReason: string,
    toolCalls = 0,
  ) => {
    const content: Array<Record<string, unknown>> = [{ type: "text", text: "ok" }];
    for (let i = 0; i < toolCalls; i++) {
      content.push({ type: "toolCall", id: `tc-${id}-${i}`, name: "bash", arguments: {} });
    }
    return JSON.stringify({
      type: "message",
      id,
      message: { role: "assistant", provider: "anthropic", model: "claude", timestamp: TS0, responseId, usage, stopReason, content },
    });
  };
  const toolResult = (id: string, usage: object) =>
    JSON.stringify({ type: "message", id, message: { role: "toolResult", provider: "anthropic", model: "claude", timestamp: TS0, usage } });
  const compaction = (id: string, usage: object) =>
    JSON.stringify({ type: "compaction", id, summary: "s", tokensBefore: 99, usage });
  const lines = [
    JSON.stringify({ type: "session", id: "s1", timestamp: "2026-01-01T00:00:00Z", cwd: "C:/" }),
    user("u1", "hello"),
    assistant("a1", "r1", { input: 1000, output: 200, cacheRead: 5000, cacheWrite: 300, cost: { total: 0.01 } }, "toolUse", 2),
    toolResult("tr1", { input: 50, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } }),
    assistant("a2", "r2", { input: 120, output: 80, cacheRead: 5600, cacheWrite: 0, cost: { total: 0.002 } }, "stop", 1),
    user("u2", "again"),
    assistant("a3", "r3", { input: 90, output: 30, cacheRead: 6200, cacheWrite: 0, cost: { total: 0.0015 } }, "stop", 0),
    compaction("c1", { input: 400, output: 100, cacheRead: 0, cacheWrite: 0, cost: { total: 0.003 } }),
    "{\"type\": \"message\", \"id\": \"partial", // 中断残留行
  ];
  return lines.join("\n");
}

const DDL = `
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

console.log("== 阶段 1：computePiSessionStats（jsonl → PI 权威统计） ==");
{
  const pi = computePiSessionStats(syntheticJsonl());
  assert(pi.assistantMessages === 3, `assistantMessages=3（模型调用数；${pi.assistantMessages}）`);
  assert(pi.userTurns === 2, `userTurns=2（用户消息数；${pi.userTurns}）`);
  assert(pi.toolCalls === 3, `toolCalls=3（2+1 toolCall 块；${pi.toolCalls}）`);
  // tokens：assistant(1000+200+5000+300=6500) + tr1(60) + a2(5800) + a3(6320) + c1(500)
  assert(pi.tokens.input === 1000 + 120 + 90 + 50 + 400, `input 含 toolResult+compaction（${pi.tokens.input}）`);
  assert(pi.tokens.cacheRead === 5000 + 5600 + 6200, `cacheRead=${pi.tokens.cacheRead}`);
  assert(pi.tokens.cacheWrite === 300, `cacheWrite=${pi.tokens.cacheWrite}`);
  assert(
    pi.tokens.total === 6500 + 60 + 5800 + 6320 + 500,
    `tokens.total=input+output+cacheRead+cacheWrite（${pi.tokens.total}）`,
  );
  assert(Math.abs(pi.cost - (0.01 + 0.001 + 0.002 + 0.0015 + 0.003)) < 1e-9, `cost 含全部 usage 行（${pi.cost}）`);
  // 空/坏输入
  assert(computePiSessionStats("").assistantMessages === 0, "空文本 → 0 统计");
  assert(computePiSessionStats("{bad json\n").assistantMessages === 0, "坏行容错 → 0 统计");
}

console.log("== 阶段 2：回填入库 → 三方对账一致 ==");
{
  const dir = mkdtempSync(join(tmpdir(), "usage-recon-"));
  const db = new Database(join(dir, "t.db"));
  db.exec(DDL);
  const svc = new UsageStatsService(db);
  const sf = join(dir, "s.jsonl");
  writeFileSync(sf, syntheticJsonl(), "utf8");

  const handled = svc.backfillSession(sf);
  assert(handled === 5, `回填处理 5 条（3 assistant + toolResult + compaction 开销；${handled}）`);

  const rows = svc.queryRows({});
  assert(rows.length === 5, `5 行（${rows.length}）`);
  const recon = reconcileUsageRows(rows, syntheticJsonl());
  assert(recon.ok, `对账一致：${recon.mismatches.join("; ") || "无差异"}`);
  assert(recon.db.calls === 3 && recon.db.turns === 2, `calls=3 turns=2（db=${recon.db.calls}/${recon.db.turns}）`);
  assert(recon.db.cacheRead === 5000 + 5600 + 6200 && recon.db.cost === recon.pi.cost, "cacheRead/cost 与 PI 一致");

  // 聚合视图（summarizeRows）与对账口径一致
  const sum = summarizeRows(rows);
  assert(sum.calls === 3 && sum.turns === 2, `summarizeRows calls=3 turns=2（${sum.calls}/${sum.turns}）`);
  assert(sum.cacheRead === recon.pi.tokens.cacheRead, "cacheHit 分子（cacheRead 总量）与 PI 一致");

  // 幂等：重复回填 0 处理，对账仍一致
  assert(svc.backfillSession(sf) === 0, "重复回填幂等");
  assert(reconcileUsageRows(svc.queryRows({}), syntheticJsonl()).ok, "重复回填后对账仍一致");

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log("== 阶段 3：负向对账（丢行/篡改 → mismatch） ==");
{
  const rows: UsageEventRow[] = [
    {
      entryId: "a1", taskId: null, sessionFile: "s.jsonl", sourceKind: "main", sourceDetail: null,
      provider: "anthropic", model: "claude", responseModel: null, ts: TS0,
      inputTokens: 1000, outputTokens: 200, cacheRead: 5000, cacheWrite: 300, cacheWrite1h: null,
      reasoningTokens: null, totalTokens: 6500, costTotal: 0.01,
      stopReason: "toolUse", errorMessage: null, ttftMs: null, decodeMs: null, generationTps: null, modelWallMs: null,
      turnIndex: 0, userTurn: 1,
    },
  ];
  // jsonl 有 3 条 assistant → 只给 1 行 → 对账必须报 calls mismatch
  const recon = reconcileUsageRows(rows, syntheticJsonl());
  assert(!recon.ok, "缺行 → ok=false");
  assert(recon.mismatches.some((m) => m.startsWith("calls:")), `calls mismatch 报告（${recon.mismatches.join("; ")}）`);
  assert(recon.mismatches.some((m) => m.startsWith("cacheRead:")), "cacheRead mismatch 报告");
  // tokens 篡改：input 改小
  const tampered: UsageEventRow[] = [{ ...rows[0], inputTokens: 10 }];
  const recon2 = reconcileUsageRows(tampered, syntheticJsonl());
  assert(recon2.mismatches.some((m) => m.startsWith("input:")), "input mismatch 报告");
  // 空 rows + 空 jsonl → 一致
  assert(reconcileUsageRows([], "").ok, "空对空 → 一致");
}

console.log("== 阶段 4：live + 回填认领 → 对账一致（不双计、user_turn 以 jsonl 为准） ==");
{
  const dir = mkdtempSync(join(tmpdir(), "usage-recon-live-"));
  const db = new Database(join(dir, "t.db"));
  db.exec(DDL);
  const svc = new UsageStatsService(db);
  const sf = join(dir, "s.jsonl");
  writeFileSync(sf, syntheticJsonl(), "utf8");
  const mkSample = (ti: number) => ({
    turnIndex: ti, requestStartedAt: 1, firstResponseAt: 2, completedAt: 3,
    ttftMs: 1, decodeMs: 1, generationTps: null, modelWallMs: 2, outputTokens: 10, reasoningTokens: null,
  });
  // live 投影 3 条（模拟真实事件流；userTurn 计数从接入起=1，jsonl 重建=1/2）
  svc.recordLive({ taskId: "t", sessionFile: sf, sourceKind: "main", sample: mkSample(0), message: { provider: "anthropic", model: "claude", responseId: "r1", usage: { input: 1000, output: 200, cacheRead: 5000, cacheWrite: 300, cost: { total: 0.01 } }, stopReason: "toolUse" }, userTurn: 1 });
  svc.recordLive({ taskId: "t", sessionFile: sf, sourceKind: "main", sample: mkSample(0), message: { provider: "anthropic", model: "claude", responseId: "r2", usage: { input: 120, output: 80, cacheRead: 5600, cacheWrite: 0, cost: { total: 0.002 } }, stopReason: "stop" }, userTurn: 1 });
  svc.recordLive({ taskId: "t", sessionFile: sf, sourceKind: "main", sample: mkSample(0), message: { provider: "anthropic", model: "claude", responseId: "r3", usage: { input: 90, output: 30, cacheRead: 6200, cacheWrite: 0, cost: { total: 0.0015 } }, stopReason: "stop" }, userTurn: 1 });
  assert(svc.countRows() === 3, "live 3 行（同 turnIndex 不同 responseId 不碰撞）");
  // 回填：3 条认领 + 2 开销插入；无重复
  const bfN = svc.backfillSession(sf);
  assert(bfN === 5, `回填处理 5（3 认领 + 2 开销；${bfN}）`);
  assert(svc.countRows() === 5, "认领后仍 5 行（不双计）");
  const rows = svc.queryRows({});
  const recon = reconcileUsageRows(rows, syntheticJsonl());
  assert(recon.ok, `live+backfill 对账一致（${recon.mismatches.join("; ") || "无差异"}）`);
  assert(rows.filter((r) => r.entryId.startsWith("live:")).length === 0, "全部 live 行已被认领为真实 id");
  assert(recon.db.turns === 2, `user_turn 以 jsonl 重建为准 → turns=2（${recon.db.turns}）`);
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n结果: passed=${passed} failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);
