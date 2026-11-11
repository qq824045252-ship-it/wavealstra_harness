/**
 * Durable 压缩阈值（CompactionPolicy）headless 单测：不需要 Durable、不读磁盘、不起模型。
 *
 * 覆盖：128K ratio 0.8、272K 与 absolute 200K 的先达到者、absolute=null 只按 ratio、
 * 1M 窗口、运行中改 ratio 重新求值、非法窗口保守默认、absolute 小于 ratio、clamp 下界、
 * modelKey 写入 modelOverrides、keepRecentTokens 覆盖。
 */
import assert from "node:assert/strict";
import type { CompactionSettings } from "@earendil-works/pi-durable";
import { resolveDurableCompactionSettings, DEFAULT_PRODUCT_COMPACTION_SETTINGS,
  DEFAULT_DURABLE_KEEP_RECENT_TOKENS, CONSERVATIVE_DURABLE_RESERVE_TOKENS } from "../src/main/agent/durable/context/CompactionPolicy";
import type { ProductCompactionSettings } from "../src/main/agent/durable/context/types";

let passed = 0;
const check = (name: string, body: () => void): void => { body(); passed++; console.log("PASS " + name); };
/** 设置里没有 triggerTokens 字段：触发线 = 窗口 - reserve，与 pi-durable 的生效口径一致。 */
const triggerOf = (contextWindow: number, settings: { reserveTokens: number }): number => contextWindow - settings.reserveTokens;
const product = (ratio: number, absoluteTokens: number | null): ProductCompactionSettings => ({ ratio, absoluteTokens });

try {
  check("defaults match the product settings page (0.8 / 200K)", () => {
    assert.deepEqual(DEFAULT_PRODUCT_COMPACTION_SETTINGS, { ratio: 0.8, absoluteTokens: 200_000 });
    assert.equal(DEFAULT_DURABLE_KEEP_RECENT_TOKENS, 20_000);
    assert.equal(CONSERVATIVE_DURABLE_RESERVE_TOKENS, 16_384);
  });

  check("128K window, ratio 0.8, absolute 200K -> trigger 102400 / reserve 25600", () => {
    const settings = resolveDurableCompactionSettings(128_000, product(0.8, 200_000));
    assert.equal(triggerOf(128_000, settings), 102_400);
    assert.equal(settings.reserveTokens, 25_600);
    assert.equal(settings.enabled, true, "overflow recovery stays available");
    assert.equal(settings.backgroundTokens, 0, "native background pre-compaction must stay off while BC is in charge");
    assert.equal(settings.keepRecentTokens, 20_000);
    assert.deepEqual(settings.modelOverrides, {});
  });

  check("272K window, ratio 0.8, absolute 200K -> absolute wins (272000*0.8=217600 > 200000)", () => {
    const settings = resolveDurableCompactionSettings(272_000, product(0.8, 200_000));
    assert.equal(triggerOf(272_000, settings), 200_000);
    assert.equal(settings.reserveTokens, 72_000);
  });

  check("192K window, ratio 0.8, absolute 200K -> ratio wins (153600 < 200000)", () => {
    const settings = resolveDurableCompactionSettings(192_000, product(0.8, 200_000));
    assert.equal(triggerOf(192_000, settings), 153_600);
    assert.equal(settings.reserveTokens, 38_400);
  });

  check("absolute=null means ratio only", () => {
    assert.equal(triggerOf(128_000, resolveDurableCompactionSettings(128_000, product(0.8, null))), 102_400);
    assert.equal(triggerOf(272_000, resolveDurableCompactionSettings(272_000, product(0.8, null))), 217_600);
  });

  check("1M window (1,024,000), ratio 0.8, absolute off -> trigger 819200", () => {
    // 只按比例：absolute=200K 时最小者仍是 200000（见 272K 用例），要拿到 819200 必须关掉绝对阈值。
    const settings = resolveDurableCompactionSettings(1_024_000, product(0.8, null));
    assert.equal(triggerOf(1_024_000, settings), 819_200);
    assert.equal(settings.reserveTokens, 204_800);
  });

  check("ratio is re-evaluated on every read (settings change while running)", () => {
    let current = product(0.8, 200_000);
    const read = (): ReturnType<typeof resolveDurableCompactionSettings> => resolveDurableCompactionSettings(128_000, current);
    assert.equal(triggerOf(128_000, read()), 102_400);
    current = product(0.5, 200_000);
    assert.equal(triggerOf(128_000, read()), 64_000);
    current = product(0.3, null);
    assert.equal(triggerOf(128_000, read()), 38_400);
    assert.equal(read().reserveTokens, 89_600);
    // 改绝对阈值同样即时生效。
    current = product(0.8, 50_000);
    assert.equal(triggerOf(128_000, read()), 50_000);
    assert.equal(read().reserveTokens, 78_000);
  });

  check("invalid context window falls back to the conservative settings", () => {
    for (const window of [0, -1, 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2]) {
      const settings = resolveDurableCompactionSettings(window, product(0.8, 200_000));
      assert.deepEqual(settings, { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000,
        backgroundTokens: 0, modelOverrides: {} }, `window=${String(window)}`);
    }
  });

  check("absolute below ratio wins", () => {
    const settings = resolveDurableCompactionSettings(128_000, product(0.9, 64_000));
    assert.equal(triggerOf(128_000, settings), 64_000);
    assert.equal(settings.reserveTokens, 64_000);
  });

  check("reserve never drops below 1024 tokens", () => {
    const settings = resolveDurableCompactionSettings(2_000, product(0.9, null));
    assert.equal(settings.reserveTokens, 1_024);
    assert.equal(triggerOf(2_000, settings), 976);
  });

  check("modelKey fills modelOverrides; keepRecentTokens can be overridden", () => {
    const plain = resolveDurableCompactionSettings(128_000, product(0.8, 200_000));
    const keyed = resolveDurableCompactionSettings(128_000, product(0.8, 200_000), { modelKey: "fixture/model" });
    assert.deepEqual(plain.modelOverrides, {});
    assert.deepEqual(keyed.modelOverrides, { "fixture/model": { reserveTokens: 25_600 } });
    assert.equal(keyed.reserveTokens, plain.reserveTokens);
    assert.equal(resolveDurableCompactionSettings(128_000, product(0.8, 200_000), { keepRecentTokens: 9_000 }).keepRecentTokens, 9_000);
    assert.equal(resolveDurableCompactionSettings(128_000, product(0.8, 200_000), { keepRecentTokens: -1 }).keepRecentTokens, 20_000);
  });

  check("result is a plain CompactionSettings for pi-durable (no extra keys)", () => {
    const settings: CompactionSettings = resolveDurableCompactionSettings(128_000, product(0.8, 200_000));
    assert.deepEqual(Object.keys(settings).sort(), ["backgroundTokens", "enabled", "keepRecentTokens", "modelOverrides", "reserveTokens"]);
    assert.deepEqual(Object.keys(settings.modelOverrides ?? {}), []);
    assert.equal(resolveDurableCompactionSettings(128_000, product(0.8, 200_000), { modelKey: "fixture/model" })
      .modelOverrides["fixture/model"]?.reserveTokens, 25_600);
  });

  console.log(`PASS all ${passed} durable compaction settings checks`);
} catch (error) {
  console.error("FAIL " + (error instanceof Error ? error.stack ?? error.message : String(error)));
  process.exitCode = 1;
}