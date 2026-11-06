/**
 * token-format-test.ts — token 显示口径的行为断言（产品口径：一律 M，最多 3 位小数）。
 *
 * 口径来源：用户 2026-11-06 明确要求「单位改成 M、不要用万」，且「一律用 M 且保留 3 位小数」。
 * 断言的是渲染后的字符串（用户看到的东西），不是实现细节。
 */
import { formatTokenCount, formatCount, formatRatePercent, formatRateDash } from "../src/shared/token-format";

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
function eq(actual: string, expected: string, label: string): void {
  assert(actual === expected, `${label}：期望 ${expected}，实际 ${actual}`);
}

console.log("== formatTokenCount：一律 M，最多 3 位小数 ==");
{
  eq(formatTokenCount(64_900), "0.065M", "64.9K → 0.065M（截图里「已使用 约 64.9K」）");
  eq(formatTokenCount(1_048_000), "1.048M", "1048.0K → 1.048M（上下文窗口）");
  eq(formatTokenCount(996_100), "0.996M", "996.1K → 0.996M（缓存读）");
  eq(formatTokenCount(42_100), "0.042M", "42.1K → 0.042M（输入）");
  eq(formatTokenCount(26_800), "0.027M", "26.8K → 0.027M（输出）");
  eq(formatTokenCount(3_523_000), "3.523M", "352.3万 → 3.523M（累计 tokens）");
  eq(formatTokenCount(1_000_000), "1M", "恰好 1M 去尾零");
  eq(formatTokenCount(1_500_000), "1.5M", "1.5M 去尾零");
  eq(formatTokenCount(10_000_000), "10M", "10M 整数不带小数点");
  eq(formatTokenCount(123_456_789), "123.457M", "9 位数保留 3 位小数");
  eq(formatTokenCount(0), "0M", "0 显示 0M");
  eq(formatTokenCount(400), "<0.001M", "四舍五入为 0 的正数显示 <0.001M，不伪装成 0");
  eq(formatTokenCount(null), "—", "null → 破折号（未知）");
  eq(formatTokenCount(undefined), "—", "undefined → 破折号");
  eq(formatTokenCount(Number.NaN), "—", "NaN → 破折号");
}

console.log("== formatTokenCount：不再出现万 / 亿 / K ==");
{
  const samples = [999, 1_000, 12_345, 99_999, 352_300, 3_523_000, 352_300_000];
  for (const n of samples) {
    const text = formatTokenCount(n);
    assert(!/[万亿K]/.test(text), `${n} 的显示「${text}」不含万/亿/K`);
    assert(text.endsWith("M"), `${n} 的显示「${text}」以 M 结尾`);
  }
}

console.log("== formatCount：计数不套 M 单位 ==");
{
  eq(formatCount(61), "61", "总会话数 61");
  eq(formatCount(1), "1", "总运行数 1");
  eq(formatCount(12345), "12,345", "五位数千分位");
  eq(formatCount(null), "—", "未知计数 → 破折号");
}

console.log("== 百分比口径 ==");
{
  eq(formatRatePercent(0.623), "62%", "保留整数百分比");
  eq(formatRatePercent(0.0042), "0.4%", "极低命中率保留一位小数");
  eq(formatRatePercent(0), "0%", "0 命中率显示 0%");
  eq(formatRatePercent(null), "未知", "未知命中率显示「未知」（用量面板话术）");
  eq(formatRateDash(null), "—", "上下文弹窗未知命中率显示破折号");
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exitCode = 1;
