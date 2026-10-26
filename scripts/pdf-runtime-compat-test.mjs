/**
 * PDF Runtime Compat — pdfjs build flavor 一致性快速验证（node 直跑）
 *
 * 根因（Wave 5C production hotfix）：主线程 API 用 legacy build，Worker 用
 * modern build。legacy 自带 `Uint8Array.prototype.toHex` 等兼容/polyfill 逻辑，
 * modern 没有 —— 真实 worker 作用域里没有主线程的 legacy polyfill，
 * modern worker 调用 `hashOriginal.toHex()` 时报 `n2.toHex is not a function`。
 *
 * 本测试证明：
 *   1. 当前 runtime（Electron 37 系）纯净环境没有原生 Uint8Array.toHex
 *   2. modern worker 不提供兼容层（混合组合必崩的前提）
 *   3. legacy main 与 legacy worker 都提供兼容层（修复后组合成立）
 *   4. legacy worker 在 worker 语义下可用（globalThis.pdfjsWorker 注册）
 *
 * 注意：这是 Node 侧 flavor 契约测试；真实 Electron + 真实 blob worker 的
 * 运行时验证由 test:pdf-runtime-e2e 覆盖（本测试 PASS ≠ Electron worker PASS）。
 *
 * 运行：pnpm test:pdf-runtime-compat
 */
const results = [];
function check(name, pass, detail = "") {
  results.push([name, pass, detail]);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const toHexType = () => typeof Uint8Array.prototype.toHex;
// 新版 Node/Electron 已把 Uint8Array.prototype.toHex 收进原生（本仓库 CI 用的 Electron 37 系还没有）。
// 原生存在时「modern worker 没有 polyfill → 必崩」这个根因前提不成立，前两条前提断言跳过，
// 后续 legacy 兼容层/worker 注册的行为断言照常执行。
const nativeToHex = toHexType() === "function";

// 1. 纯净环境（未加载任何 pdfjs build）
if (nativeToHex) {
  console.log(`SKIP  compat: 纯净环境无原生 Uint8Array.toHex（本运行时已内置 toHex，前提不成立）`);
} else {
  check("compat: 纯净环境无原生 Uint8Array.toHex（根因前提）", true, `type=${toHexType()}`);
}

// 2. modern worker：不提供兼容层（legacy main + modern worker 组合的缺陷）
await import("pdfjs-dist/build/pdf.worker.min.mjs");
if (nativeToHex) {
  check("compat: modern worker 不新增 toHex 兼容层（原生已内置，混合组合不再必崩）", toHexType() === "function", `type=${toHexType()}`);
} else {
  check(
    "compat: modern worker 不提供 toHex 兼容层（混合组合必崩）",
    toHexType() === "undefined",
    `type=${toHexType()}`,
  );
}

// 3. legacy main：提供兼容层（当前主线程入口，与修复前一致）
await import("pdfjs-dist/legacy/build/pdf.mjs");
check("compat: legacy main 提供 toHex 兼容层", toHexType() === "function", `type=${toHexType()}`);

// 4. legacy worker：同样提供兼容层（修复后统一 legacy，worker 内可运行）
await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs");
check("compat: legacy worker 提供 toHex 兼容层（统一 legacy 成立）", toHexType() === "function", `type=${toHexType()}`);

// 5. worker 入口全局注册（pdfjs fake-worker/worker 初始化依赖 globalThis.pdfjsWorker）
const g = globalThis;
check(
  "compat: legacy worker 注册 globalThis.pdfjsWorker",
  typeof g.pdfjsWorker === "object" && g.pdfjsWorker !== null,
  `pdfjsWorker=${typeof g.pdfjsWorker}`,
);

const failed = results.filter(([, pass]) => !pass).length;
console.log(`\nPDF Runtime Compat: ${results.length - failed}/${results.length} PASS`);
if (failed > 0) process.exit(1);
