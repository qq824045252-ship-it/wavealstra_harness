/**
 * diagnostics-rules-test.ts — 执行诊断判定层（规则 + 分轮 + 缓存）的验收。
 *
 * 覆盖用户关心的四件事：
 * 1. 每一轮能判定「正常/需注意/异常/无法判断/在等人」，并给出依据；
 * 2. 缓存命中率按已知分量加权、每轮单独算（不是各请求算术平均）；
 * 3. 规则不会在没有证据时编造结论（样本不足 → 无法判断）；
 * 4. 不再有 200 条截断：全部观测都进入统计。
 */
import type { ModelRequestDiagnostic, TaskDiagnosticsDto, ToolDiagnostic, WaitDiagnostic } from "@shared/task-diagnostics";
import {
  buildDiagnosticsReport,
  buildBaseline,
  bucketTurns,
  cacheLine,
  percentile,
  summarizeCache,
} from "@/lib/diagnosticsRules";

let passed = 0;
let failed = 0;
function assert(cond: boolean, label: string): void {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.error(`  ✗ ${label}`); }
}

const NOW = 1_000_000_000;

function request(partial: Partial<ModelRequestDiagnostic> & { id: string; executionId: string }): ModelRequestDiagnostic {
  return {
    taskId: "task", executionScope: "task", conversationId: "c1", generationTaskId: 1,
    sourceKind: "main", provider: "deepseek", model: "deepseek-v4.1",
    startedAt: NOW - 60_000, firstResponseAt: NOW - 58_000, finishedAt: NOW - 50_000, modelMs: 10_000,
    status: "completed", outcome: "stop", error: null,
    usage: { input: 1_000, output: 500, cacheRead: 9_000, cacheWrite: 0 },
    usageSource: "provider", knownCostUsd: 0.01, costComplete: true, costSource: "provider-reported",
    attempts: [{ number: 1, startedAt: NOW - 60_000, finishedAt: NOW - 50_000, httpStatus: 200 }],
    cacheContext: { previousRequestId: null, prefixStable: true, changedFields: [], coverage: "complete" },
    ...partial,
  };
}

function tool(partial: Partial<ToolDiagnostic> & { id: string; executionId: string }): ToolDiagnostic {
  return {
    conversationId: "c1", sourceKind: "main", name: "read", callId: `call-${partial.id}`,
    startedAt: NOW - 55_000, finishedAt: NOW - 54_000, status: "completed",
    observedMs: 1_000, activeMs: 1_000, waitingMs: 0, complete: true, diagnostics: [],
    ...partial,
  };
}

function wait(partial: Partial<WaitDiagnostic> & { id: string; executionId: string }): WaitDiagnostic {
  return {
    title: "确认写入", startedAt: NOW - 53_000, finishedAt: NOW - 52_000, status: "resolved",
    ...partial,
  };
}

function dto(partial: Partial<TaskDiagnosticsDto>): TaskDiagnosticsDto {
  return {
    taskId: "task", capturedAt: NOW, offset: 0, requests: [], tools: [], waits: [], truncated: false,
    totals: { modelMs: null, toolMs: null, waitingMs: 0, knownCostUsd: null, costComplete: false, unknownUsageRequests: 0 },
    ...partial,
  };
}

console.log("== 缓存计算（加权，不是算术平均） ==");
{
  const cache = summarizeCache([
    request({ id: "r1", executionId: "t1", usage: { input: 1_000, output: 100, cacheRead: 9_000, cacheWrite: 0 } }),
    request({ id: "r2", executionId: "t1", usage: { input: 1_000, output: 100, cacheRead: 1_000, cacheWrite: 0 } }),
  ]);
  // 加权：10000 / (2000 + 10000 + 0) = 83%；两请求各自 90% / 50% 的算术平均是 70%
  assert(cache.hitRate !== null && Math.round(cache.hitRate * 100) === 83, `加权命中率 83%（${cache.hitRate}）`);
  assert(cache.cacheRead === 10_000 && cache.input === 2_000, "分量求和正确");
  assert(cache.degraded === false, "分量齐全不标降级");

  const degraded = summarizeCache([request({ id: "r3", executionId: "t2", usage: { input: 1_000, output: 1, cacheRead: 1_000, cacheWrite: null } })]);
  assert(degraded.hitRate !== null && degraded.degraded, `cacheWrite 未知 → 用已知分量算并标降级（${degraded.hitRate}）`);

  const unknown = summarizeCache([request({ id: "r4", executionId: "t3", usage: { input: null, output: 1, cacheRead: 1_000, cacheWrite: 0 } })]);
  assert(unknown.hitRate === null, "新输入未知 → 命中率 null（不写 0）");
  assert(cacheLine(unknown).includes("缓存命中 —"), `未知命中率显示破折号（${cacheLine(unknown)}）`);

  const perTurn = summarizeCache([request({ id: "r5", executionId: "t4", usage: { input: 500, output: 1, cacheRead: 500, cacheWrite: 0 } })]);
  assert(perTurn.hitRate !== null && Math.round(perTurn.hitRate * 100) === 50, "每轮独立计算（50%）");
}

console.log("== 分轮（executionId 精确归属） ==");
{
  const value = dto({
    requests: [
      request({ id: "r1", executionId: "durable:task:c1:11" }),
      request({ id: "r2", executionId: "durable:task:c1:11", startedAt: NOW - 40_000, finishedAt: NOW - 30_000 }),
      request({ id: "r3", executionId: "durable:task:c1:12", startedAt: NOW - 20_000, finishedAt: NOW - 10_000 }),
    ],
    tools: [tool({ id: "tool-1", executionId: "durable:task:c1:11" }), tool({ id: "tool-2", executionId: "durable:task:c1:12" })],
    waits: [wait({ id: "w1", executionId: "durable:task:c1:12" })],
  });
  const buckets = bucketTurns(value);
  assert(buckets.length === 2, `两轮（${buckets.length}）`);
  assert(buckets[0]?.requests.length === 2 && buckets[0]?.tools.length === 1, "第 1 轮：2 请求 + 1 工具");
  assert(buckets[1]?.requests.length === 1 && buckets[1]?.tools.length === 1 && buckets[1]?.waits.length === 1, "第 2 轮：请求+工具+等待归到同一轮");
  assert(buckets.every((bucket) => !bucket.approximateWaits), "executionId 能匹配的等待不标估算");

  const fallback = bucketTurns(dto({
    requests: [request({ id: "r9", executionId: "durable:task:c1:11" })],
    waits: [wait({ id: "w9", executionId: "execution-legacy-uuid", startedAt: NOW - 59_000 })],
  }));
  assert(fallback[0]?.waits.length === 1 && fallback[0]?.approximateWaits === true, "旧口径等待按时间归属并标估算");
}

console.log("== 硬规则 ==");
{
  const failed = buildDiagnosticsReport(dto({ requests: [request({ id: "r1", executionId: "t1", status: "failed", error: "400 invalid_request" })] }), NOW);
  assert(failed.turns[0]?.verdict === "error", "失败请求 → 异常");
  assert(failed.turns[0]?.findings.some((finding) => finding.ruleId === "A1" && finding.evidence.includes("400")), "A1 带原始错误文本");

  const retried = buildDiagnosticsReport(dto({ requests: [request({ id: "r1", executionId: "t1", attempts: [
    { number: 1, startedAt: NOW - 60_000, finishedAt: NOW - 58_000, httpStatus: 503 },
    { number: 2, startedAt: NOW - 57_000, finishedAt: NOW - 50_000, httpStatus: 200 },
  ] })] }), NOW);
  assert(retried.turns[0]?.verdict === "error", "重试 + 503 → 异常（A4 优先于 A3）");
  assert(retried.turns[0]?.findings.some((finding) => finding.ruleId === "A3"), "A3 记录重试");
  assert(retried.turns[0]?.findings.some((finding) => finding.ruleId === "A4"), "A4 记录 5xx");

  const interrupted = buildDiagnosticsReport(dto({ requests: [request({ id: "r1", executionId: "t1", status: "interrupted", modelMs: null })] }), NOW);
  assert(interrupted.turns[0]?.verdict === "unknown", "观测中断 → 无法判断（不是异常）");

  const interruptedTool = buildDiagnosticsReport(dto({ tools: [tool({ id: "t1", executionId: "t1", status: "interrupted", complete: false })] }), NOW);
  assert(interruptedTool.turns[0]?.verdict === "unknown", "工具观测不完整 → 无法判断");

  const failedTools = buildDiagnosticsReport(dto({ tools: [
    tool({ id: "a", executionId: "t1", name: "bash", status: "failed", diagnostics: ["exit 1"] }),
    tool({ id: "b", executionId: "t1", name: "bash", status: "failed", diagnostics: ["exit 1"] }),
  ] }), NOW);
  assert(failedTools.turns[0]?.verdict === "error", "工具失败 → 异常");
  assert(failedTools.turns[0]?.findings.some((finding) => finding.title.includes("同名工具连续失败")), "同名失败 ≥2 次提示循环");

  const downgraded = buildDiagnosticsReport(dto({ tools: [tool({ id: "a", executionId: "t1", diagnostics: ["模型降级：gpt → deepseek"] })] }), NOW);
  assert(downgraded.turns[0]?.verdict === "warn", "工具降级诊断 → 需注意");
  assert(downgraded.turns[0]?.findings.some((finding) => finding.ruleId === "A7"), "A7 原样带诊断文本");

  const waiting = buildDiagnosticsReport(dto({
    requests: [request({ id: "r1", executionId: "t1" })],
    waits: [wait({ id: "w1", executionId: "t1", status: "pending", finishedAt: null })],
  }), NOW);
  assert(waiting.turns[0]?.verdict === "waiting", "在等人回答 → waiting（不算故障）");
  assert(waiting.summary.waiting === 1, "汇总计数把 waiting 单独计");

  const slowFirst = buildDiagnosticsReport(dto({ requests: [request({ id: "r1", executionId: "t1", firstResponseAt: NOW - 60_000 + 45_000 })] }), NOW);
  assert(slowFirst.turns[0]?.verdict === "warn", "首字 45s → 需注意");
}

console.log("== 观测质量规则 ==");
{
  const unknownUsage = buildDiagnosticsReport(dto({ requests: [request({ id: "r1", executionId: "t1",
    usage: { input: null, output: 10, cacheRead: null, cacheWrite: null } })] }), NOW);
  assert(unknownUsage.turns[0]?.findings.some((finding) => finding.ruleId === "B1"), "B1 用量不完整");
  assert(unknownUsage.turns[0]?.cache.hitRate === null, "用量缺失时缓存命中率必须是 null");

  const sdkCost = buildDiagnosticsReport(dto({ requests: [request({ id: "r1", executionId: "t1", costSource: "sdk-default", costComplete: false })] }), NOW);
  assert(sdkCost.turns[0]?.findings.some((finding) => finding.ruleId === "B2"), "B2 费用不是真实账单");

  const prefixLost = buildDiagnosticsReport(dto({ requests: [request({ id: "r1", executionId: "t1",
    cacheContext: { previousRequestId: "r0", prefixStable: false, changedFields: [], coverage: "complete" } })] }), NOW);
  assert(prefixLost.turns[0]?.verdict === "warn", "前缀无故失效 → 需注意");

  const prefixExplained = buildDiagnosticsReport(dto({ requests: [request({ id: "r1", executionId: "t1",
    cacheContext: { previousRequestId: "r0", prefixStable: false, changedFields: ["tools"], coverage: "complete" } })] }), NOW);
  assert(prefixExplained.turns[0]?.verdict === "ok", "前缀失效但配置变了 → 正常");
}

console.log("== 相对规则（基线不足不编造） ==");
{
  const few = buildBaseline([request({ id: "r1", executionId: "t1" }), request({ id: "r2", executionId: "t2" })]);
  assert(few.firstToken.p90 === null && few.firstToken.samples === 2, "样本不足 → 无 p90");
  const fewReport = buildDiagnosticsReport(dto({ requests: [request({ id: "r1", executionId: "t1", firstResponseAt: NOW - 60_000 + 25_000 })] }), NOW);
  assert(!fewReport.turns[0]?.findings.some((finding) => finding.ruleId === "C1"), "样本不足不触发 C1");

  const base = Array.from({ length: 6 }, (_, index) => request({
    id: `b${index}`, executionId: `t${index}`,
    startedAt: NOW - 600_000 + index * 10_000, firstResponseAt: NOW - 600_000 + index * 10_000 + 2_000,
    finishedAt: NOW - 600_000 + index * 10_000 + 12_000,
  }));
  const withBaseline = buildDiagnosticsReport(dto({ requests: [
    ...base,
    request({ id: "slow", executionId: "t99", startedAt: NOW - 40_000, firstResponseAt: NOW - 40_000 + 20_000, finishedAt: NOW - 30_000 }),
  ] }), NOW);
  const slowTurn = withBaseline.turns.find((turn) => turn.key === "t99");
  assert(Boolean(slowTurn?.findings.some((finding) => finding.ruleId === "C1")), "首字显著慢于历史 p90 → C1");

  const dropTurn = buildDiagnosticsReport(dto({ requests: [
    request({ id: "a", executionId: "t1", usage: { input: 1_000, output: 1, cacheRead: 9_000, cacheWrite: 0 } }),
    request({ id: "b", executionId: "t2", usage: { input: 9_000, output: 1, cacheRead: 1_000, cacheWrite: 0 }, startedAt: NOW - 30_000, finishedAt: NOW - 20_000 }),
  ] }), NOW).turns.find((turn) => turn.key === "t2");
  assert(dropTurn?.hitRateDeltaPct !== null && (dropTurn?.hitRateDeltaPct ?? 0) <= -30, `命中率下降超过 30pp（${dropTurn?.hitRateDeltaPct}）`);
  assert(Boolean(dropTurn?.findings.some((finding) => finding.ruleId === "C3")), "C3 缓存回源被标出");
}

console.log("== 判定优先级 + 无 200 条截断 ==");
{
  const priority = buildDiagnosticsReport(dto({
    requests: [request({ id: "r1", executionId: "t1", status: "failed", error: "boom",
      usage: { input: null, output: null, cacheRead: null, cacheWrite: null } })],
    waits: [wait({ id: "w1", executionId: "t1", status: "pending", finishedAt: null })],
  }), NOW);
  assert(priority.turns[0]?.verdict === "error", "异常 > 在等人 > 无法判断");

  const many = Array.from({ length: 300 }, (_, index) => request({
    id: `m${index}`, executionId: `durable:task:c1:${index}`,
    startedAt: NOW - 900_000 + index * 1_000, firstResponseAt: NOW - 900_000 + index * 1_000 + 500,
    finishedAt: NOW - 900_000 + index * 1_000 + 9_000,
  }));
  const big = buildDiagnosticsReport(dto({ requests: many }), NOW);
  assert(big.totals.requests === 300, `全部 300 条进入统计（${big.totals.requests}）`);
  assert(big.turns.length === 300, `300 轮都保留（${big.turns.length}）`);
  assert(big.summary.ok + big.summary.warn + big.summary.error + big.summary.unknown + big.summary.waiting === 300, "汇总覆盖全部轮次");

  assert(percentile([1, 2, 3, 4], 0.9) !== null, "分位函数可用");
}

console.log(`\n结果: passed=${passed} failed=${failed}`);
if (failed > 0) process.exitCode = 1;
