/**
 * native-cost-evidence-test.ts — 费用证据的纯函数 + 追踪器口径测试。
 *
 * 背景：模型目录里 `cost` 四项全 0（未配置价格）时，Pi 仍会算 `usage.cost.total = 0`。
 * `nativeCostEvidence` 以前把它当作真实 pi-native 账单（total=0、complete=true），
 * 诊断面板于是显示「费用 $0.000000」。判定矩阵：
 *
 *   total 无效（缺失/负/NaN）                        → { null, null, false }
 *   total=0 且定价未配置（四项全 0）且 provider 未报   → { null, null, false }（未知）
 *   total=0 且定价未配置，但 provider 报告 0          → provider-reported 0
 *   total=0 且定价已配置                              → pi-native 0（真实账单）
 *   total>0                                          → pi-native
 *   pricingConfigured 未传（旧调用方）                → 保持旧判定（回归保护）
 *
 * CacheRequestTracer.start(model) 收到的就是完整 Pi Model；它把 `cost` 四项是否任一 > 0
 * 折算成 pricingConfigured 并传给 nativeCostEvidence，本测试用真实 tracer 的 result
 * 记录验证这条链路。
 */
import assert from 'node:assert/strict';
import { CacheRequestTracer } from '../src/main/agent/CacheRequestTrace';
import { nativeCostEvidence, type NativeCostUsage } from '../src/main/agent/NativeCostEvidence';
import { unknownTokenUsage } from '../src/main/agent/ReportedTokenUsage';

const unknown = { total: null, source: null, complete: false };
const zeroUsage: NativeCostUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
const usedUsage: NativeCostUsage = { input: 12, output: 4, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
const reportedTokens = { input: 12, output: 4, cacheRead: 0, cacheWrite: 0 };

// ── 纯函数判定 ────────────────────────────────────────────────────────────────
// 1) 未配置价格 + total 0 + 无 providerCost → 未知（不再伪造 $0）
assert.deepEqual(nativeCostEvidence(zeroUsage, unknownTokenUsage(), undefined, false), unknown,
  '未配置定价的 0 必须是未知');
assert.deepEqual(nativeCostEvidence(usedUsage, reportedTokens, null, false), unknown,
  '即使 provider 报告了 token，没有价格也不能得出 0 费用');
// 5) usage 全 0、无价格、无 providerCost → 未知
assert.deepEqual(nativeCostEvidence({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
  unknownTokenUsage(), undefined, false), unknown, '全 0 用量且无价目仍是未知');

// 2) 已配置价格 + total 0 + 有真实 token 用量 → pi-native 的真实 0（old 判定语义）
assert.deepEqual(nativeCostEvidence(usedUsage, unknownTokenUsage(), undefined, true),
  { total: 0, source: 'pi-native', complete: true }, '已配置价格时 0 是真实费用');
assert.deepEqual(nativeCostEvidence(usedUsage, unknownTokenUsage(), null, true),
  { total: 0, source: 'pi-native', complete: true }, 'provider 未报告费用（null）不覆盖已配置的 0');

// 3) provider 明确报告 0 → provider-reported（即使目录里没有价格）
assert.deepEqual(nativeCostEvidence(zeroUsage, unknownTokenUsage(), 0, false),
  { total: 0, source: 'provider-reported', complete: true }, '供应商报告的 0 是账单');
assert.deepEqual(nativeCostEvidence(zeroUsage, unknownTokenUsage(), 0),
  { total: 0, source: 'provider-reported', complete: true }, '未传定价标志时供应商 0 仍是账单');

// 4) total>0 → pi-native
assert.deepEqual(nativeCostEvidence({ ...usedUsage, cost: { total: 0.0025 } }, unknownTokenUsage(), undefined, false),
  { total: 0.0025, source: 'pi-native', complete: true }, '正费用始终是 pi-native 账单');

// 无效 total 一律未知
for (const cost of [undefined, null, { total: -1 }, { total: Number.NaN }, { total: Infinity }]) {
  assert.deepEqual(nativeCostEvidence({ cost } as NativeCostUsage, reportedTokens, 0, true), unknown,
    `无效 total ${JSON.stringify(cost)} 必须是未知`);
}

// pricingConfigured 未传（旧调用方）保持旧判定：用量存在 → pi-native
assert.deepEqual(nativeCostEvidence(usedUsage, reportedTokens), { total: 0, source: 'pi-native', complete: true },
  '不传 pricingConfigured 的调用方语义不变');

// ── CacheRequestTracer：从 Model.cost 折算 pricingConfigured ───────────────────
interface TraceRecord { event: string; nativeCostTotal?: number | null; nativeCostSource?: string | null; nativeCostComplete?: boolean }
function traceResult(model: { provider: string; id: string; api: string; cost?: { input: number; output: number; cacheRead: number; cacheWrite: number } },
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: { total?: number } },
  providerEvent?: unknown): TraceRecord {
  const records: TraceRecord[] = [];
  const tracer = new CacheRequestTracer(record => records.push(record as unknown as TraceRecord));
  const trace = tracer.start(model, 'cost-session', { operation: 'stream' });
  if (providerEvent !== undefined) trace.providerEvent(providerEvent);
  trace.result({ stopReason: 'stop', usage });
  const result = records.filter(record => record.event === 'result').at(-1);
  assert(result, 'result 记录必须产生');
  return result;
}
const unpriced = { provider: 'magpie', id: 'opendesign/deepseek-v4.1-flash-eco', api: 'openai-completions', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const priced = { ...unpriced, cost: { input: 0.000001, output: 0, cacheRead: 0, cacheWrite: 0 } };

// 目录价目全 0：pi 的 total=0 不再记为已知费用（面板应显示「未知」）
let r = traceResult(unpriced, { input: 1200, output: 300, cacheRead: 64, cacheWrite: 0, cost: { total: 0 } });
assert.equal(r.nativeCostTotal, null, '未配置定价时 nativeCostTotal 必须为 null');
assert.equal(r.nativeCostSource, null, '未配置定价时不应标记来源');
assert.equal(r.nativeCostComplete, false, '未配置定价时不能声称费用完整');

r = traceResult(unpriced, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } });
assert.equal(r.nativeCostTotal, null, '全 0 用量 + 未配置定价仍是未知');

// 目录价目已配置：真实 0 保留
r = traceResult(priced, { input: 1200, output: 300, cacheRead: 64, cacheWrite: 0, cost: { total: 0 } });
assert.equal(r.nativeCostTotal, 0, '已配置定价时 0 是真实费用');
assert.equal(r.nativeCostSource, 'pi-native');
assert.equal(r.nativeCostComplete, true);

// 供应商报告费用（含 0）：provider-reported 优先
r = traceResult(unpriced, { input: 1200, output: 300, cacheRead: 64, cacheWrite: 0, cost: { total: 0 } },
  { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1200, output_tokens: 300, cost: 0 } } });
assert.equal(r.nativeCostTotal, 0, '供应商报告的 0 是真实账单');
assert.equal(r.nativeCostSource, 'provider-reported');
assert.equal(r.nativeCostComplete, true);

// 正费用始终是 pi-native
r = traceResult(unpriced, { input: 1200, output: 300, cacheRead: 64, cacheWrite: 0, cost: { total: 0.0042 } });
assert.equal(r.nativeCostTotal, 0.0042);
assert.equal(r.nativeCostSource, 'pi-native');
assert.equal(r.nativeCostComplete, true);

console.log('PASS native cost evidence: 未配置定价的 0 为未知，已配置/供应商报告的 0 保留，正费用 pi-native');
