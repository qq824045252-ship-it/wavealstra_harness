/**
 * subagent 并行上限回归测试（用户要求：总数 200 / 同时 100）。
 *
 * 真机背景：原实现硬编码 MAX_PARALLEL_TASKS = 8、MAX_CONCURRENCY = 4，
 * 用户派 9 个以上会被整体拒绝（"Too many parallel tasks"），且实际只有 4 个在跑。
 *
 * 断言：
 *  1. 单次 parallel 允许 200 条
 *  2. 同时存活 100 个 worker，其余排队
 *  3. 输出预算：任务少时保持每任务 50KB，任务多时总量封顶 400KB（200 条 → 每条约 2KB）
 *  4. 预算函数有下界（不会算出 0 字节），且随任务数单调不增
 */
import assert from "node:assert/strict";
import {
  MAX_CONCURRENCY,
  MAX_PARALLEL_TASKS,
  parallelPerTaskOutputCap,
  resolveParallelLimits,
} from "../src/main/capabilities/subagent/index";

let passed = 0;
function ok(label: string): void { passed += 1; console.log(`  ✓ ${label}`); }

// ---------- 1/2. 上限数值 ----------
assert.equal(MAX_PARALLEL_TASKS, 200, "单次 parallel 的 tasks 上限必须是 200");
assert.equal(MAX_CONCURRENCY, 100, "同时运行的 worker 上限必须是 100");
ok("上限 = 200 总数 / 100 并发（其余排队）");

// ---------- 3. 输出预算 ----------
const KB = 1024;
assert.equal(parallelPerTaskOutputCap(1), 50 * KB, "单任务仍保留 50KB");
assert.equal(parallelPerTaskOutputCap(4), 50 * KB, "任务少时不压缩输出");
assert.equal(parallelPerTaskOutputCap(8), 50 * KB, "原上限 8 条时行为不变（50KB/条）");
assert.equal(parallelPerTaskOutputCap(100), 4 * KB, "100 条时总量 400KB → 每条约 4KB");
assert.equal(parallelPerTaskOutputCap(200), 2 * KB, "200 条时每任务 2KB，总量 400KB");
assert.equal(parallelPerTaskOutputCap(400), 2 * KB, "超过 200 也不会低于 2KB 下界");
assert.equal(parallelPerTaskOutputCap(0), 50 * KB, "非法任务数回退单任务上限");
assert.equal(parallelPerTaskOutputCap(Number.NaN), 50 * KB, "NaN 回退单任务上限");
ok("输出预算：少任务 50KB/条，多任务按 400KB 总量均分");

// ---------- 4. 单调性 + 总量不超标 ----------
let previous = Number.POSITIVE_INFINITY;
for (let count = 1; count <= 400; count += 1) {
  const cap = parallelPerTaskOutputCap(count);
  assert.ok(cap <= previous, `任务数增加时每任务预算不得变大（${count}）`);
  assert.ok(cap >= 2 * KB, `每任务预算不得低于 2KB（${count}）`);
  assert.ok(cap * count <= 400 * KB + 2 * KB * count, `总量不得明显超过 400KB（${count}）`);
  previous = cap;
}
ok("预算随任务数单调不增且有下界");

// ---------- 5. 生效上限：默认 200/100，subagent.json 只能往下调 ----------
assert.deepEqual(resolveParallelLimits(), { maxParallelTasks: 200, maxConcurrency: 100 }, "无配置 = 200/100");
assert.deepEqual(resolveParallelLimits({}), { maxParallelTasks: 200, maxConcurrency: 100 });
assert.deepEqual(
  resolveParallelLimits({ maxConcurrency: 20 }),
  { maxParallelTasks: 200, maxConcurrency: 20 },
  "只调并发",
);
assert.deepEqual(
  resolveParallelLimits({ maxParallelTasks: 50 }),
  { maxParallelTasks: 50, maxConcurrency: 50 },
  "并发不得超过任务总数",
);
assert.deepEqual(
  resolveParallelLimits({ maxParallelTasks: 10, maxConcurrency: 50 }),
  { maxParallelTasks: 10, maxConcurrency: 10 },
  "并发被任务总数夹紧",
);
assert.deepEqual(
  resolveParallelLimits({ maxParallelTasks: 9999, maxConcurrency: 9999 }),
  { maxParallelTasks: 200, maxConcurrency: 100 },
  "配置不能突破硬上限",
);
assert.deepEqual(
  resolveParallelLimits({ maxParallelTasks: 0, maxConcurrency: -5 }),
  { maxParallelTasks: 200, maxConcurrency: 100 },
  "非法值（<1）回退默认",
);
assert.deepEqual(
  resolveParallelLimits({ maxParallelTasks: "abc" as unknown as number, maxConcurrency: Number.NaN }),
  { maxParallelTasks: 200, maxConcurrency: 100 },
  "非数字回退默认",
);
ok("subagent.json 只能往下调（默认 200/100，硬上限不可突破）");

console.log(`\nsubagent parallel limits: PASS (${passed} checks)`);
