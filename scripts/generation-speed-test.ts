/**
 * generation-speed-test.ts — 「生成速度」统计的行为断言（聊天回复下方速度徽标的唯一数据源）。
 *
 * 现象（老板截图）：durable 路径流式期间徽标只有「正在生成」，结束后没有平均 tok/s。
 * 根因：`DurableBotRuntime.refresh()` 的 live 行把 `tps/estimated/outputTokens/ttftMs` 写死成 null，
 * `updatedAt` 一直是 startedAt；`DurableHistoryProjection.assistantRow()` 完成态同样 tps=null。
 * pi-durable 的 `LiveState.generation` 没有时间戳，所以时间必须由 host 在每次 watch 提交时自己观测。
 *
 * 本测试断言三件事：
 *   a) 纯函数 `GenerationTiming`：首个输出前 tps=null、按加权字符口径粗估（与 native
 *      `GenerationSpeedTracker.estimateDeltaTokens()` 一致：ASCII 0.25 / 非 ASCII 1，按 code point）、
 *      output=0 → null、时钟防御不产生 NaN/Infinity、完成后 tps = output / decode；
 *   b) 渲染层 `generationSpeedView()`（纯函数，不改）用这些真实字段得到 `≈N tok/s` 与 `平均 N tok/s`；
 *   c) 真实 durable 夹具：带**中文 + ASCII** 输出的流式假模型跑一次，流式阶段 snapshot 里出现过
 *      `tps != null && estimated === true && updatedAt > startedAt` 且 `estimatedTokens` 等于加权口径，
 *      完成后该条 assistant 消息 `tps != null && estimated === false && outputTokens === usage.output`。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { createModels, type AssistantMessage, type Models } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { defineDoc } from "@earendil-works/pi-durable";
import { DurableBotRuntime } from "../src/main/agent/durable/DurableBotRuntime";
import { DurableHistoryProjection, assistantRow } from "../src/main/agent/durable/DurableHistoryProjection";
import { GenerationTiming, generationContentTokens, estimateTextTokens, MIN_STREAM_INTERVAL_MS } from "../src/main/usage/generation-timing";
import { generationSpeedView, type GenerationSpeedInput } from "../src/renderer/src/lib/generationSpeed";
import type { GenerationStats } from "../src/shared/generation-stats";

process.env.MYBUDDY_CACHE_TRACE = "0";

/**
 * 旧版本（本次改动之前）的 `mybuddy.response-timing`：只有 `completed`，没有 `speed`。
 * 用同 kind/version 的 token 先写一份旧形状，验证新代码在既有会话上能平滑补上 `speed`。
 */
const LegacyResponseTiming = defineDoc({ kind: "mybuddy.response-timing", version: 1, scope: "conversation", history: "latest",
  fork: "current", checkpointWhen: () => false,
  initial: () => ({ completed: {} as Record<string, number> }) as {
    completed: Record<string, number>;
    speed?: Record<string, { tps: number | null; ttftMs: number | null }>;
  } });

/** 允许 ±40% 的真实时延误差：host 观测的是节流提交（≈100ms 粒度），不是精确的 provider 打点。 */
function assertClose(actual: number, expected: number, tolerance: number, label: string): void {
  const relative = Math.abs(actual - expected) / Math.abs(expected);
  assert(relative <= tolerance, `${label}：期望约 ${expected}，实际 ${actual}（相对误差 ${(relative * 100).toFixed(1)}% > ${(tolerance * 100).toFixed(0)}%）`);
}

// ─────────────────────────────────────────────────────────────────────────────
// a) 纯函数：字符粗估、门槛、时钟防御、完成态口径
// ─────────────────────────────────────────────────────────────────────────────
console.log("== a. GenerationTiming 纯函数 ==");
{
  const T0 = 1_000_000;

  // 首个输出前：没有 tps、没有 ttft，updatedAt 停在 startedAt（不假装在动）。
  const idle = new GenerationTiming(T0);
  const before = idle.snapshot(T0 + 5_000);
  assert.equal(before.tps, null, "首个输出前 tps 必须是 null（不能编造速度）");
  assert.equal(before.ttftMs, null, "首个输出前没有 TTFT");
  assert.equal(before.firstOutputAt, null);
  assert.equal(before.updatedAt, T0, "没有输出时 updatedAt 不得推进（stalled 语义要诚实）");
  assert.equal(before.startedAt, T0);

  // 估算口径：与 native `GenerationSpeedTracker.estimateDeltaTokens()` 完全一致
  // （ASCII 0.25 / 非 ASCII 1，按 code point 遍历）——不是「字符数 ÷ 4」。
  assert.equal(estimateTextTokens(""), 0, "空串 → 0 token");
  assert.equal(estimateTextTokens("abcd"), 1, "4 个 ASCII 字符 → 1 token（0.25/字符）");
  assert.equal(estimateTextTokens("x".repeat(400)), 100, "400 个 ASCII 字符 → 100 token");
  // 中文是这次换口径的原因：每个汉字 1 token，而不是 ÷4 的 0.25。
  assert.equal(estimateTextTokens("中文速度"), 4, "4 个汉字 → 4 token（每字 1 token）");
  assert.equal(estimateTextTokens("你好，世界"), 5, "5 个 CJK 字符（含全角逗号）→ 5 token");
  assert.equal(estimateTextTokens("中文速度"), 4 * ("中文速度".length / 4), "同一段中文：加权口径是 ÷4 口径的 4 倍");
  assert(estimateTextTokens("中文速度") > "中文速度".length / 4, `中文估算明显高于 ÷4（实际 ${estimateTextTokens("中文速度")} vs ${"中文速度".length / 4}）`);
  // 混合与 emoji：ASCII 0.25 + 非 ASCII 1；按 code point 遍历，emoji 不按 UTF-16 代理对算两次。
  assert.equal(estimateTextTokens("你好 world"), 3.5, "2 汉字(2) + 空格(0.25) + world(1.25) = 3.5 token");
  assert.equal(estimateTextTokens("abc🙂"), 1.75, "3 个 ASCII(0.75) + emoji(1) = 1.75 token");
  assert.equal("🙂".length, 2, "夹具前提：🙂 在 UTF-16 里占 2 个 code unit");
  assert.equal(estimateTextTokens("🙂🙂"), 2, "两个 emoji → 2 token（按 code point，不是 4）");

  // 首个输出后：elapsed 不足门槛（500ms）先不出数（避免 1 token/16ms 的假尖峰）。
  const timing = new GenerationTiming(T0);
  timing.observe(10, T0 + 800);
  const early = timing.snapshot(T0 + 800 + MIN_STREAM_INTERVAL_MS - 1);
  assert.equal(early.tps, null, `首个输出后不足 ${MIN_STREAM_INTERVAL_MS}ms → tps=null（不发布噪声）`);
  assert.equal(early.ttftMs, 800, "TTFT = 首个输出 - generation 首次被观测");
  assert.equal(early.estimatedTokens, 10, "已产出 10 token → estimatedTokens=10");

  const threshold = timing.snapshot(T0 + 800 + MIN_STREAM_INTERVAL_MS);
  assertClose(threshold.tps!, 20, 0.001, "10 token / 0.5s = 20 tok/s（刚过门槛就出数）");

  const started = timing.snapshot(T0 + 1_800); // firstOutputAt 后 1000ms
  assertClose(started.tps!, 10, 0.001, "10 token / 1.0s = 10 tok/s");

  // 持续增长：lastOutputAt 只在产出增长时前进，tps 用 now - firstOutputAt 计算。
  timing.observe(40, T0 + 2_000);
  const grown = timing.snapshot(T0 + 3_000); // elapsed = 2200ms
  assert.equal(grown.updatedAt, T0 + 2_000, "updatedAt = 最近一次输出增长时间");
  assert.equal(grown.estimatedTokens, 40);
  assertClose(grown.tps!, 40 / 2.2, 0.001, "40 token / 2.2s ≈ 18.18 tok/s");

  // 没有新输出时 updatedAt 不前进（stalled 判定靠它）。
  timing.observe(40, T0 + 2_500);
  assert.equal(timing.snapshot(T0 + 3_000).updatedAt, T0 + 2_000, "产出没增长 → updatedAt 不更新");
  // 工具参数被修复后变短：算更正，不算新输出。
  timing.observe(30, T0 + 2_600);
  const shrunk = timing.snapshot(T0 + 3_000);
  assert.equal(shrunk.updatedAt, T0 + 2_000, "产出变短是更正，不推进 updatedAt");
  assert.equal(shrunk.estimatedTokens, 30);

  // output=0 / 无时长 → tps=null（诚实），但 decode/ttft 仍按真实时间给。
  const zero = new GenerationTiming(T0);
  zero.observe(100, T0 + 500);
  const zeroMetrics = zero.finalize(0, T0 + 5_000);
  assert.equal(zeroMetrics.tps, null, "usage.output=0 → tps=null，不能是 0 tok/s");
  assert.equal(zeroMetrics.outputTokens, null, "output=0 → outputTokens=null");
  assert.equal(zeroMetrics.decodeMs, 4_500, "decodeMs = 完成 - 首个输出（不含 TTFT）");
  assert.equal(zeroMetrics.ttftMs, 500);

  // 完成后：tps = output / (decodeMs / 1000)，estimatedTokens 只做诊断。
  const done = new GenerationTiming(T0);
  done.observe(20, T0 + 1_000);
  const metrics = done.finalize(200, T0 + 5_000);
  assert.equal(metrics.decodeMs, 4_000);
  assert.equal(metrics.ttftMs, 1_000);
  assert.equal(metrics.outputTokens, 200);
  assert.equal(metrics.tps, 50, "200 token / 4.0s = 50 tok/s（权威口径）");
  assert.equal(metrics.estimatedTokens, 20);
  done.observe(9_999, T0 + 6_000);
  assert.equal(done.snapshot(T0 + 6_000).estimatedTokens, 20, "finalize 之后不再接受观测");

  // 时钟防御 1：观测时间早于 generation 开始（时钟回拨）→ TTFT 记 0，不出现负值。
  const backwards = new GenerationTiming(T0);
  backwards.observe(100, T0 - 5_000);
  const backwardsAt = backwards.snapshot(T0 - 1_000); // now 早于首个输出
  assert.equal(backwardsAt.ttftMs, 0, "观测早于 startedAt → TTFT 收敛为 0，不是负数");
  assert.equal(backwardsAt.tps, null, "now 早于首个输出 → 负时长不出 tps（不产生 Infinity/NaN）");

  // 时钟防御 2：完成时间早于首个输出 → decodeMs=null、tps=null。
  const skewed = new GenerationTiming(T0);
  skewed.observe(100, T0 + 100);
  const skewedMetrics = skewed.finalize(100, T0 + 50);
  assert.equal(skewedMetrics.decodeMs, null, "完成早于首个输出 → decodeMs=null");
  assert.equal(skewedMetrics.tps, null, "decodeMs=null → tps=null");
  assert.equal(skewedMetrics.ttftMs, 100);

  // 时钟防御 3：NaN 输入不产生 NaN 速度。
  const nanTiming = new GenerationTiming(T0);
  nanTiming.observe(Number.NaN, Number.NaN);
  const nanSnapshot = nanTiming.snapshot(Number.NaN);
  assert.equal(nanSnapshot.estimatedTokens, 0);
  assert.equal(nanSnapshot.tps, null);
  assert.equal(nanSnapshot.ttftMs, null);
  const nanMetrics = nanTiming.finalize(Number.NaN, T0);
  assert.equal(nanMetrics.tps, null);
  assert.equal(nanMetrics.outputTokens, null);

  // elapsed 恰好为 0 时也不除零。
  const instant = new GenerationTiming(T0);
  instant.observe(1, T0 + 500);
  const instantSnapshot = instant.snapshot(T0 + 500);
  assert.equal(instantSnapshot.tps, null, "elapsed=0 → tps=null（不会变成 Infinity）");

  // 输出内容口径：text + thinking + toolCall 参数，全部走同一加权估算。
  const content = [
    { type: "text", text: "abc" }, // 3 ASCII → 0.75
    { type: "thinking", thinking: "de" }, // 2 ASCII → 0.5
    { type: "toolCall", id: "c1", name: "echo", arguments: { a: 1 } }, // '{"a":1}' 7 ASCII → 1.75
    { type: "toolCall", id: "c2", name: "echo", arguments: "raw-arg" }, // 7 ASCII → 1.75
  ];
  assert.equal(generationContentTokens(content), 4.75, "text + thinking + toolCall 参数按权重累加（4.75）");
  assert.equal(generationContentTokens([{ type: "text", text: "中文速度" }]), 4, "中文内容 = 4 token（不是 ÷4 的 1）");
  assert.equal(generationContentTokens([{ type: "text", text: "abc你好" }]), 2.75, "混合内容 = 0.75 + 2 token");
  assert.equal(generationContentTokens("not-an-array"), 0, "非数组 content → 0");
  assert.equal(generationContentTokens(undefined), 0, "undefined content → 0");
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(generationContentTokens([{ type: "toolCall", arguments: circular }]), 0, "无法序列化的参数 → 0（不抛异常）");
}

// ─────────────────────────────────────────────────────────────────────────────
// b) 历史投影：完成态写入，缺计时时如实为 null；渲染层拿到真数字
// ─────────────────────────────────────────────────────────────────────────────
console.log("== b. assistantRow / generationSpeedView ==");
{
  const fixtureModel = { id: "fixture", name: "fixture", provider: "fixture", api: "openai-completions", baseUrl: "https://fixture.invalid",
    reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 1_024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as const;
  const reply = (text: string, timestamp: number, output: number): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text }],
    stopReason: "stop", api: fixtureModel.api, model: fixtureModel.id, provider: fixtureModel.provider, timestamp,
    usage: { input: 1, output, cacheRead: 0, cacheWrite: 0, totalTokens: 1 + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });

  // 完成态 + 实测 metrics：这正是 durable 完成路径写进去的东西。
  const measured = assistantRow("durable-7", undefined, reply("answer", 1_000, 120), 5_000, 600, false, { tps: 50, ttftMs: 800 });
  assert.equal(measured.generationStats?.tps, 50, "完成态 tps 来自实测");
  assert.equal(measured.generationStats?.estimated, false, "完成态 tps 不是估算值");
  assert.equal(measured.generationStats?.outputTokens, 120, "outputTokens = usage.output（权威总量）");
  assert.equal(measured.generationStats?.ttftMs, 800);
  assert.equal(measured.generationStats?.updatedAt, 5_000);

  // 没有计时（历史重载/恢复）：诚实为 null，不写 0。
  const unmeasured = assistantRow("durable-8", undefined, reply("answer", 1_000, 120), undefined, 600, false);
  assert.equal(unmeasured.generationStats?.tps, null, "没有计时 → tps=null（不用 0 冒充）");
  assert.equal(unmeasured.generationStats?.ttftMs, null);
  assert.equal(unmeasured.generationStats?.outputTokens, 120, "token 数仍然来自 usage");

  // 流式行由 runtime 用实时估算覆盖：这里保持 null。
  const streaming = assistantRow("durable-9", undefined, reply("partial", 1_000, 0), undefined, 600, true, { tps: 999, ttftMs: 1 });
  assert.equal(streaming.streaming, true);
  assert.equal(streaming.generationStats?.tps, null, "流式分支不预置 tps（由 runtime 覆盖）");
  assert.equal(streaming.generationStats?.ttftMs, null);

  // 持久化/外部数据不可信：坏速度归一化为 null。
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -12, 0]) {
    const row = assistantRow("durable-10", undefined, reply("answer", 1_000, 10), 2_000, 1_000, false, { tps: bad, ttftMs: -1 });
    assert.equal(row.generationStats?.tps, null, `坏 tps=${String(bad)} → null`);
    assert.equal(row.generationStats?.ttftMs, null, "负 ttftMs → null");
  }

  // merge() 用 `${taskId}:${timestamp}` 同时查完成时间与速度，保持既有 timing map 兼容。
  const entry = { id: 11, kind: "pi.assistant", byTaskId: 3, model: [reply("merged", 1_000, 120)] } as unknown as EntryRecord;
  const projection = new DurableHistoryProjection();
  projection.merge([entry], new Map(), { "3:1000": 5_000 }, { "3:1000": { tps: 40, ttftMs: 700 } });
  const merged = projection.messages[0];
  assert.equal(merged?.text, "merged");
  assert.equal(merged?.generationStats?.tps, 40, "merge 把速度带到对应 assistant 行");
  assert.equal(merged?.generationStats?.ttftMs, 700);
  assert.equal(merged?.durationMs, 4_000, "完成时间口径不变（still from completedAt - startedAt）");

  // 渲染层：同一份 stats 在流式/完成态分别显示「≈N tok/s」「平均 N tok/s」。
  const streamingStats: GenerationStats = { phase: "generating", startedAt: 1_000, updatedAt: 2_000, tps: 37.48,
    estimated: true, outputTokens: null, ttftMs: 800 };
  const streamView = generationSpeedView({ stats: streamingStats, streaming: true, createdAt: 1_000, approval: false } satisfies GenerationSpeedInput, 2_500);
  assert.equal(streamView?.label, "≈37.5 tok/s", "流式徽标显示 ≈N tok/s");
  assert(streamView?.detail.includes("实时估算"), "流式 tooltip 说明估算口径");
  assert(streamView?.detail.includes("首响应 0.8s"), "流式 tooltip 带上真实 TTFT");

  const completedStats: GenerationStats = { phase: "complete", startedAt: 1_000, updatedAt: 5_000, tps: 50.04,
    estimated: false, outputTokens: 120, ttftMs: 800, outcome: "completed" };
  const doneView = generationSpeedView({ stats: completedStats, streaming: false, createdAt: 1_000, approval: false }, 9_000);
  assert.equal(doneView?.label, "平均 50.0 tok/s", "完成徽标显示平均 tok/s");
  assert(doneView?.detail.includes("输出 120 tokens"), "完成 tooltip 带权威输出 token 数");
  assert(doneView?.detail.includes("首响应 0.8s"), "完成 tooltip 带 TTFT");

  // 只有 updatedAt 在动，才不会误判 stalled。
  const stalled = generationSpeedView({ stats: { ...streamingStats, updatedAt: 500 }, streaming: true, createdAt: 1_000, approval: false }, 4_500);
  assert.equal(stalled?.label, "等待输出 4.0s", "3 秒没有新输出才显示「等待输出」");
  const firstOutputPending = generationSpeedView({ stats: { ...streamingStats, phase: "waiting", tps: null, updatedAt: 1_000 },
    streaming: true, createdAt: 1_000, approval: false }, 1_500);
  assert.equal(firstOutputPending?.label, "等待 0.5s", "首个输出前显示等待时长，不显示速度");
  const noTps = generationSpeedView({ stats: { ...completedStats, tps: null }, streaming: false, createdAt: 1_000, approval: false }, 9_000);
  assert.equal(noTps?.label, "已完成", "没有实测速度时如实显示「已完成」");
}

// ─────────────────────────────────────────────────────────────────────────────
// c) 真实 durable 夹具：流式阶段出估算，完成态出权威平均
// ─────────────────────────────────────────────────────────────────────────────
console.log("== c. durable 夹具（真实 watch/projection 链路）==");
{
  const directory = await mkdtemp(join(tmpdir(), "mybuddy-generation-speed-"));
  const cwd = join(directory, "workspace");
  await mkdir(cwd);
  const model = { id: "fixture", name: "fixture", provider: "fixture", api: "openai-completions", baseUrl: "https://fixture.invalid",
    reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 1_024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as const;
  const usageOf = (output: number) => ({ input: 1, output, cacheRead: 0, cacheWrite: 0, totalTokens: 1 + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  const CHUNKS = 24;
  const CHUNK_CHARS = 40;
  // 全中文流式：每块 40 个汉字 = 40 token（加权口径，每字 1 token）；÷4 口径只有 10 token/块。
  // 这样流式 tps 对口径非常敏感：加权 ≈700 tok/s，÷4 只会在 ~180 以下。
  const CHUNK_TEXT = "中文速度快";
  const CHUNK = CHUNK_TEXT.repeat(Math.ceil(CHUNK_CHARS / CHUNK_TEXT.length)).slice(0, CHUNK_CHARS);
  const CHUNK_DELAY_MS = 55;
  const FIRST_DELTA_MS = 400;
  const OUTPUT_TOKENS = 120;
  let firstDeltaAt = 0;
  let providerCompletedAt = 0;
  const streamModels: Models = Object.assign(createModels(), {
    getModel: () => ({ ...model, input: ["text"] as const }),
    getAuth: async () => undefined,
    streamSimple: () => {
      const stream = createAssistantMessageEventStream();
      const base: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "stop",
        api: model.api, model: model.id, provider: model.provider, timestamp: Date.now(), usage: usageOf(0) };
      let text = "";
      let index = 0;
      const tick = () => {
        if (index < CHUNKS) {
          if (index === 0) firstDeltaAt = Date.now();
          index += 1;
          text += CHUNK;
          stream.push({ type: "text_delta", contentIndex: 0, delta: CHUNK, partial: { ...base, content: [{ type: "text", text }] } });
          setTimeout(tick, CHUNK_DELAY_MS);
          return;
        }
        providerCompletedAt = Date.now();
        const final: AssistantMessage = { ...base, content: [{ type: "text", text }], usage: usageOf(OUTPUT_TOKENS), timestamp: Date.now() };
        stream.push({ type: "done", reason: "stop", message: final });
        stream.end();
      };
      setTimeout(tick, FIRST_DELTA_MS);
      return stream;
    },
    completeSimple: async (): Promise<AssistantMessage> => ({ role: "assistant", content: [{ type: "text", text: "summary" }],
      stopReason: "stop", api: model.api, model: model.id, provider: model.provider, timestamp: Date.now(), usage: usageOf(1) }),
  });
  const streamSamples: Array<GenerationStats & { text: string }> = [];
  const runtime = await DurableBotRuntime.open({ directory: join(directory, "state"), cwd, models: streamModels,
    model: { provider: model.provider, modelId: model.id }, toolMode: "native", instructions: () => "fixture",
    onSnapshot: snapshot => {
      const row = snapshot.messages.findLast(message => message.role === "assistant" && message.streaming);
      if (row?.generationStats) streamSamples.push({ ...row.generationStats, text: row.text });
    } });
  try {
    // 先写一份旧形状的计时文档（没有 speed 字段），模拟「升级前就存在的会话」。
    await runtime.conversation.commit(async tx => {
      const legacy = await tx.doc(LegacyResponseTiming, runtime.conversation.id);
      legacy.completed["0:0"] = 1;
    }, context);

    const submission = await runtime.submit("stream a real answer", "generation-speed-input");
    assert.equal((await submission.wait(context)).status, "done");
    await runtime.conversation.waitForIdle(context);
    const snapshot = await runtime.refresh();

    // 流式阶段：真实估算速度出现过，且 updatedAt 确实在推进。
    const generating = streamSamples.filter(stats => stats.phase === "generating");
    assert(generating.length >= 2, `流式期间至少观测到两次 generating（实际 ${generating.length}）`);
    const withTps = generating.filter(stats => stats.tps !== null);
    assert(withTps.length >= 1, `流式阶段出现过 tps（实际 ${withTps.length}/${generating.length} 次非空）`);
    assert(generating.every(stats => stats.estimated === true), "generating 相位一律标记为估算值（与非 durable 路径一致）");
    assert(withTps.every(stats => stats.tps! > 0 && Number.isFinite(stats.tps!) && stats.tps! < 5_000),
      `流式 tps 是有限正数（样本 ${withTps.map(stats => stats.tps!.toFixed(1)).join(", ")}）`);
    assert(generating.every(stats => stats.outputTokens === null), "流式阶段不写 outputTokens（那是权威总量）");
    assert(withTps.some(stats => stats.updatedAt > stats.startedAt), "有输出后 updatedAt 必须晚于 startedAt（否则会被误判 stalled）");
    assert(new Set(generating.map(stats => stats.updatedAt)).size >= 2, "多次 watch 提交让 updatedAt 持续推进");
    assert(generating.some(stats => (stats.ttftMs ?? 0) >= 150), `流式阶段测到真实 TTFT（样本 ${generating.map(stats => String(stats.ttftMs)).join(", ")}）`);
    // 中文流式：加权口径下 40 汉字/块、55ms/块 ≈ 700 tok/s；若误用 ÷4 口径最高只有 ~180 tok/s。
    const withText = generating.filter(sample => sample.text.length > 0);
    assert(withText.length >= 1, `流式样本带出了已产出的文本（${withText.length} 条）`);
    const chineseSample = withText.at(-1)!;
    assert([...chineseSample.text].every(char => char.codePointAt(0)! > 0x7f), "流式样本是纯中文（ASCII 不予计入，口径可见）");
    const peakTps = Math.max(...withTps.map(stats => stats.tps!));
    assert(peakTps > 350, `中文流式估算按「每字符 1 token」（峰值 ${peakTps.toFixed(1)} tok/s；÷4 口径会落在 ~180 以下）`);
    console.log(`   流式实测：tps=[${withTps.map(stats => stats.tps!.toFixed(1)).join(", ")}] ttft=${generating.find(stats => stats.ttftMs !== null)?.ttftMs}ms ` +
      `updatedAt-startedAt=[${generating.map(stats => stats.updatedAt - stats.startedAt).join(", ")}]ms ` +
      `末样本 ${chineseSample.text.length} 个汉字 → 加权 ${chineseSample.text.length} token（÷4 口径只有 ${chineseSample.text.length / 4}）`);

    // 完成态：该条 assistant 消息拿到权威平均速度。
    const answer = snapshot.messages.findLast(message => message.role === "assistant" && message.text.startsWith(CHUNK_TEXT));
    assert(answer, `完成后的 assistant 消息存在（当前 ${snapshot.messages.length} 条）`);
    assert.equal(answer!.streaming, false);
    const stats = answer!.generationStats;
    assert(stats, "完成行带 generationStats");
    assert.equal(stats!.phase, "complete");
    assert.equal(stats!.estimated, false, "完成态 tps 不是估算值");
    assert.notEqual(stats!.tps, null, "完成后必须有平均 tok/s（这是老板截图缺的那个数）");
    assert(stats!.tps! > 0 && Number.isFinite(stats!.tps!), `平均 tps 是有限正数（实际 ${stats!.tps}）`);
    assert.equal(stats!.outputTokens, OUTPUT_TOKENS, "outputTokens === usage.output（权威 token 数）");
    assert.notEqual(stats!.ttftMs, null, "完成行带 TTFT");
    assert(stats!.ttftMs! >= 150, `TTFT 是真实测量值（实际 ${stats!.ttftMs}ms）`);
    const expectedTps = OUTPUT_TOKENS / ((providerCompletedAt - firstDeltaAt) / 1000);
    assertClose(stats!.tps!, expectedTps, 0.4, "平均 tps 与 output/decode 一致");
    console.log(`   完成实测：tps=${stats!.tps!.toFixed(1)} ttft=${stats!.ttftMs}ms output=${stats!.outputTokens} ` +
      `(output/decode≈${expectedTps.toFixed(1)})`);

    // 同一条回复在渲染层应显示「平均 N tok/s」。
    const view = generationSpeedView({ stats: stats!, streaming: false, createdAt: answer!.createdAt, approval: false }, Date.now());
    assert.equal(view?.label, `平均 ${stats!.tps!.toFixed(1)} tok/s`, `徽标显示平均速度（实际 ${view?.label}）`);

    // 旧形状文档（只有 completed）在运行中被补上 speed，旧数据不丢。
    const persisted = await runtime.harness.snapshot(LegacyResponseTiming, runtime.conversation.id, context);
    assert.equal(persisted?.completed["0:0"], 1, "旧 completed 记录保持不变");
    const persistedSpeeds = Object.values(persisted?.speed ?? {});
    assert.equal(persistedSpeeds.length, 1, "为新回复补写了一条 speed（旧文档也能平滑升级）");
    assert.equal(persistedSpeeds[0]?.tps, stats!.tps, "持久化的 tps 与 DTO 一致");
    assert.equal(persistedSpeeds[0]?.ttftMs, stats!.ttftMs, "持久化的 ttftMs 与 DTO 一致");

    // 历史重载：真实 durable 里计时是持久化的，重开 runtime 后仍能给出同一个平均速度。
    await runtime.close(); // Release the single-writer lease before exercising a real restart.
    const reopened = await DurableBotRuntime.open({ directory: join(directory, "state"), cwd, models: streamModels,
      model: { provider: model.provider, modelId: model.id }, toolMode: "native", instructions: () => "fixture", onSnapshot: () => {} });
    try {
      const reloaded = await reopened.refresh();
      const reloadedAnswer = reloaded.messages.findLast(message => message.role === "assistant" && message.text.startsWith(CHUNK_TEXT));
      assert(reloadedAnswer, "重开后历史消息仍在");
      assert.equal(reloadedAnswer!.generationStats?.tps, stats!.tps, "持久化的实测速度在重开后一致");
      assert.equal(reloadedAnswer!.generationStats?.estimated, false);
    } finally {
      await reopened.close();
    }
  } finally {
    await runtime.close();
  }
}

console.log("\nPASS 生成速度：纯函数口径、完成/诚实缺省、渲染层文案与真实 durable 流式/完成实测");
