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
  bucketTurns,
  cacheLine,
  percentile,
  sampleCacheTrend,
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
  const partial = summarizeCache([
    request({id:'known',executionId:'same'}),
    request({id:'missing',executionId:'same',usage:{input:1000,output:1,cacheRead:null,cacheWrite:null}}),
  ]);
  assert(partial.hitRate === null, '同轮部分请求缓存缺失，不把部分和当完整命中率');

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
  assert(slowFirst.turns[0]?.verdict === "ok", "首字慢不参与判定（仍为正常）");
  assert(!slowFirst.turns[0]?.findings.some((finding) => finding.ruleId === "A5"), "不再有 A5 首字规则");
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

console.log("== 性能指标只展示、不判定 ==");
{
  // 极慢的首字 + 极低的输出速率：都不该产生判定
  const slow = buildDiagnosticsReport(dto({ requests: [
    request({ id: "slow", executionId: "t1", startedAt: NOW - 60_000, firstResponseAt: NOW - 5_000, finishedAt: NOW - 1_000, modelMs: 59_000,
      usage: { input: 1_000, output: 3, cacheRead: 9_000, cacheWrite: 0 } }),
  ] }), NOW).turns[0];
  assert(slow?.verdict === "ok", `慢首字 + 低速率仍是正常（${slow?.verdict}）`);
  assert(!slow?.findings.some((finding) => finding.ruleId === "A5" || finding.ruleId === "C1" || finding.ruleId === "C2"),
    "首字/速率规则都不存在");
  assert(slow?.firstTokenMs === 55_000, "首字仍是可见指标");
  assert(slow?.outputTps !== null && (slow?.outputTps ?? 0) < 1, "速率仍是可见指标");

  // 缓存：只有掉到 0% 才判定，普通波动不报警
  const mildDrop = buildDiagnosticsReport(dto({ requests: [
    request({ id: "a", executionId: "t1", usage: { input: 1_000, output: 1, cacheRead: 9_000, cacheWrite: 0 } }),
    request({ id: "b", executionId: "t2", usage: { input: 3_000, output: 1, cacheRead: 7_000, cacheWrite: 0 }, startedAt: NOW - 30_000, finishedAt: NOW - 20_000 }),
  ] }), NOW).turns.find((turn) => turn.key === "t2");
  assert(!mildDrop?.findings.some((finding) => finding.ruleId === "C3"), "命中率 90%→70% 不算回源");

  const zeroTurn = buildDiagnosticsReport(dto({ requests: [
    request({ id: "a", executionId: "t1", usage: { input: 1_000, output: 1, cacheRead: 9_000, cacheWrite: 0 } }),
    request({ id: "b", executionId: "t2", usage: { input: 10_000, output: 1, cacheRead: 0, cacheWrite: 0 }, startedAt: NOW - 30_000, finishedAt: NOW - 20_000 }),
  ] }), NOW);
  const zero = zeroTurn.turns.find((turn) => turn.key === "t2");
  assert(zero?.cache.hitRate === 0, "该轮命中率就是 0%");
  assert(Boolean(zero?.findings.some((finding) => finding.ruleId === "C3")), "掉到 0% → C3");
  assert(zero?.verdict === "warn", "0% 命中 → 需注意（不是异常）");

  const zeroFromStart = buildDiagnosticsReport(dto({ requests: [
    request({ id: "c", executionId: "t9", usage: { input: 5_000, output: 1, cacheRead: 0, cacheWrite: 0 } }),
  ] }), NOW).turns[0];
  assert(Boolean(zeroFromStart?.findings.some((finding) => finding.title.includes("命中 0%"))), "首轮 0% 也提示");
}

console.log("== 标签页：主任务 + 每个子代理各一页，各带自己的缓存趋势 ==");
{
  const value = dto({
    requests: [
      request({ id: "m1", executionId: "t-main-1", sourceKind: "main" }),
      request({ id: "m2", executionId: "t-main-2", sourceKind: "main", startedAt: NOW - 30_000, finishedAt: NOW - 20_000 }),
      request({ id: "s1", executionId: "t-sub-1", sourceKind: "subagent", conversationId: "sub-a", startedAt: NOW - 40_000, finishedAt: NOW - 30_000 }),
      request({ id: "s2", executionId: "t-sub-2", sourceKind: "subagent", conversationId: "sub-a", startedAt: NOW - 35_000, finishedAt: NOW - 25_000 }),
      request({ id: "s3", executionId: "t-sub-3", sourceKind: "subagent", conversationId: "sub-b", startedAt: NOW - 25_000, finishedAt: NOW - 15_000 }),
      request({ id: "s4", executionId: "t-sub-4", sourceKind: "subagent", conversationId: "sub-b", status: "failed", error: "boom", startedAt: NOW - 20_000, finishedAt: NOW - 10_000 }),
      request({ id: "a1", executionId: "t-aux-1", sourceKind: "auxiliary", conversationId: "aux-1", startedAt: NOW - 50_000, finishedAt: NOW - 45_000 }),
    ],
  });
  const report = buildDiagnosticsReport(value, NOW, { "sub-a": "妙蛙种子" });
  assert(report.tabs.length === 4, `主任务 + 2 个子代理 + 辅助 = 4 页（${report.tabs.length}）`);
  assert(report.tabs[0]?.key === "main" && report.tabs[0]?.label === "主任务", "主任务排第一");
  const subA = report.tabs.find((tab) => tab.key === "sub:sub-a");
  const subB = report.tabs.find((tab) => tab.key === "sub:sub-b");
  assert(subA?.label === "妙蛙种子", `子代理标签用 displayName（${subA?.label}）`);
  assert(subB?.label === "子代理 2", `没有名字时按顺序编号（${subB?.label}）`);
  assert(subA?.turns.length === 2 && subB?.turns.length === 2, "每个子代理各自分页，不混在一起");
  assert(report.tabs[0]?.turns.length === 2, "主任务页只含主任务轮次");
  assert(subA?.turns.map((turn) => turn.label).join(",") === "第 1 轮,第 2 轮", "子代理独立编号");
  assert(subA?.cacheTrend.length === 2 && subB?.cacheTrend.length === 2, "每页各有自己的趋势数据");
  assert(report.tabs[0]?.cacheTrend.length === 2, "主任务趋势不含子代理轮次");
  assert(report.tabs.every((tab) => tab.cacheTrend.every((point) => point.hitRate !== null)), "每轮都有命中率点位");
  assert(report.tabs.reduce((sum, tab) => sum + tab.summary.ok, 0) === report.summary.ok, "页内汇总与全局汇总一致");
  assert(report.headline.startsWith("子代理 2") && report.headline.includes("："), `结论条带页名与原因（${report.headline}）`);

  // 每页的 Δpp 只跟自己上一轮比
  const deltaTurn = subA?.turns[1];
  assert(deltaTurn?.previousHitRate === subA?.turns[0]?.cache.hitRate, "Δpp 与同页上一轮比较");
}

console.log("== 趋势降采样（长任务不卡、关键点不丢） ==");
{
  const points = Array.from({ length: 1000 }, (_, index) => ({
    key: `k${index}`, label: `第 ${index + 1} 轮`, sourceKind: "main" as const, order: index + 1,
    hitRate: index === 500 || index === 900 ? 0 : 0.9, startedAt: NOW + index,
  }));
  const sampled = sampleCacheTrend(points);
  assert(sampled.length <= 241, `降采样到 ≤241 点（${sampled.length}）`);
  assert(sampled.filter((point) => point.hitRate === 0).length === 2, "0% 关键点不会被采样丢掉");
  assert(sampled[0]?.key === "k0" && sampled[sampled.length - 1]?.key === "k999", "首尾保留");
  assert(sampleCacheTrend(points.slice(0, 10)).length === 10, "短序列原样返回");
  assert(sampleCacheTrend([]).length === 0, "空序列不炸");
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
