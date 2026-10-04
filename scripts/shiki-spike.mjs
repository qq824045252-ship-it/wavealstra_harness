/**
 * 1F — Shiki Spike（V3.5 §52）
 *
 * 决策问题：MyBuddy 静态代码 Artifact 最终用 Shiki 哪种运行方案？
 *
 * 对比：
 *   A. JavaScript RegExp engine（createJavaScriptRegexEngine）
 *   B. Oniguruma WASM engine（createOnigurumaEngine）
 *
 * 指标：cold start / 首次 highlight / warm 重复 / bundle 大小 / 内存 /
 *       fidelity（token 序列一致性）/ 大文件 / CSP·WASM·asar 可行性。
 *
 * 运行：node scripts/shiki-spike.mjs [--json out/shiki-spike.json]
 * 输出：控制台表格 + 可选 JSON 报告。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { createHighlighter, createJavaScriptRegexEngine, createOnigurumaEngine } from "shiki";

const FIX = join(import.meta.dirname, "..", "fixtures", "artifacts", "synthetic");

const FILES = [
  { name: "code-ts.ts", lang: "typescript", label: "小 TS 56 行" },
  { name: "code-python.py", lang: "python", label: "Py 841 行" },
  { name: "code-medium.ts", lang: "typescript", label: "中 TS 1.6k 行" },
  { name: "code-json.json", lang: "json", label: "JSON 8k 行" },
  { name: "code-large.ts", lang: "typescript", label: "大 TS 10.9k 行" },
];

const LANGS = ["typescript", "javascript", "json", "python", "shellscript", "markdown"];
const THEME = "github-dark";

function load(name) {
  return readFileSync(join(FIX, name), "utf-8");
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function fmt(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${n.toFixed(1)}ms`;
}

async function buildHighlighter(engineName) {
  const engine = engineName === "js" ? createJavaScriptRegexEngine() : createOnigurumaEngine(import("shiki/wasm"));
  const t0 = performance.now();
  const hi = await createHighlighter({
    themes: [THEME],
    langs: LANGS,
    engine,
  });
  return { hi, initMs: performance.now() - t0 };
}

async function benchEngine(engineName) {
  console.log(`\n========== Engine ${engineName === "js" ? "A: JavaScript RegExp" : "B: Oniguruma WASM"} ==========`);

  const { hi, initMs } = await buildHighlighter(engineName);
  console.log(`createHighlighter (init, 6 langs): ${fmt(initMs)}`);

  const rows = [];
  let peakRss = 0;

  for (const f of FILES) {
    const src = load(f.name);

    // 首次（含 grammar/font 初始化）
    const t1 = performance.now();
    const html1 = hi.codeToHtml(src, { lang: f.lang, theme: THEME });
    const firstMs = performance.now() - t1;

    // warm ×5 中位数
    const warm = [];
    for (let i = 0; i < 5; i++) {
      const tw = performance.now();
      hi.codeToHtml(src, { lang: f.lang, theme: THEME });
      warm.push(performance.now() - tw);
    }
    const warmMs = median(warm);

    // tokens 统计（fidelity 基础）
    const tokens = hi.codeToTokens(src, { lang: f.lang, theme: THEME }).tokens;
    const tokenCount = tokens.flat().length;

    peakRss = Math.max(peakRss, process.memoryUsage().rss / 1024 / 1024);
    rows.push({
      file: f.label,
      firstMs: +firstMs.toFixed(1),
      warmMs: +warmMs.toFixed(1),
      htmlKB: +(html1.length / 1024).toFixed(1),
      tokens: tokenCount,
    });
  }

  console.log("file                 first     warm(med)  htmlKB   tokens");
  for (const r of rows) {
    console.log(
      `${r.file.padEnd(20)} ${String(r.firstMs).padStart(8)}ms ${String(r.warmMs).padStart(9)}ms ${String(r.htmlKB).padStart(8)} ${String(r.tokens).padStart(9)}`,
    );
  }
  console.log(`峰值 RSS: ${peakRss.toFixed(1)} MB`);

  return { engine: engineName, initMs, rows, peakRss: +peakRss.toFixed(1) };
}

async function fidelityCheck() {
  console.log(`\n========== Fidelity: JS vs Oniguruma token 序列对比 ==========`);
  const src = load("code-medium.ts");
  const langs = ["typescript", "python", "json"];
  const res = [];
  for (const lang of langs) {
    const file = lang === "typescript" ? "code-medium.ts" : lang === "python" ? "code-python.py" : "code-json.json";
    const text = load(file);
    const hiJs = await buildHighlighter("js");
    const hiOg = await buildHighlighter("og");
    const tJs = hiJs.hi.codeToTokens(text, { lang, theme: THEME }).tokens;
    const tOg = hiOg.hi.codeToTokens(text, { lang, theme: THEME }).tokens;
    const flatJs = tJs.flat().map((t) => `${t.content}|${t.color}`);
    const flatOg = tOg.flat().map((t) => `${t.content}|${t.color}`);
    let diff = 0;
    const n = Math.max(flatJs.length, flatOg.length);
    for (let i = 0; i < n; i++) if (flatJs[i] !== flatOg[i]) diff++;
    const pct = ((diff / n) * 100).toFixed(3);
    console.log(`  ${lang.padEnd(12)} tokens JS=${flatJs.length} OG=${flatOg.length} 差异=${diff} (${pct}%)`);
    res.push({ lang, js: flatJs.length, og: flatOg.length, diff, pct });
    await hiJs.hi.dispose();
    await hiOg.hi.dispose();
  }
  return res;
}

async function bundleCheck() {
  console.log(`\n========== Bundle: 最小高亮器两种 engine ==========`);
  try {
    const { build } = await import("esbuild");
    const tmp = join(import.meta.dirname, "..", "out", "spike-shiki");
    mkdirSync(tmp, { recursive: true });

    const entryJs = join(tmp, "entry-js.mjs");
    const entryOg = join(tmp, "entry-og.mjs");
    writeFileSync(
      entryJs,
      `import { createHighlighter, createJavaScriptRegexEngine } from "shiki";
import { readFileSync } from "node:fs";
export async function run() {
  const hi = await createHighlighter({ themes: ["github-dark"], langs: ["typescript"], engine: createJavaScriptRegexEngine() });
  return hi.codeToHtml(readFileSync(process.argv[1], "utf-8"), { lang: "typescript", theme: "github-dark" });
}`,
    );
    writeFileSync(
      entryOg,
      `import { createHighlighter, createOnigurumaEngine } from "shiki";
import { readFileSync } from "node:fs";
export async function run() {
  const hi = await createHighlighter({ themes: ["github-dark"], langs: ["typescript"], engine: createOnigurumaEngine(import("shiki/wasm")) });
  return hi.codeToHtml(readFileSync(process.argv[1], "utf-8"), { lang: "typescript", theme: "github-dark" });
}`,
    );

    const sizes = {};
    for (const [tag, entry] of [["js", entryJs], ["og", entryOg]]) {
      const r = await build({
        entryPoints: [entry],
        bundle: true,
        format: "esm",
        platform: "node",
        outfile: join(tmp, `bundle-${tag}.mjs`),
        write: false,
        metafile: true,
        logLevel: "silent",
      });
      const out = r.outputFiles?.[0]?.contents?.length;
      sizes[tag] = { bundleKB: +(out / 1024).toFixed(1), meta: r.metafile };
    }
    console.log(`  JS engine  bundle: ${sizes.js.bundleKB} KB`);
    console.log(`  Oniguruma bundle: ${sizes.og.bundleKB} KB (含 wasm 引用)`);
    return sizes;
  } catch (e) {
    console.log(`  esbuild bundle 检查失败: ${e.message}`);
    return null;
  }
}

async function main() {
  const jsonArg = process.argv.indexOf("--json");
  const jsonPath = jsonArg >= 0 ? process.argv[jsonArg + 1] : null;

  const report = { date: new Date().toISOString(), shikiVersion: "4.4.2" };
  report.engineA = await benchEngine("js");
  report.engineB = await benchEngine("og");
  report.fidelity = await fidelityCheck();
  report.bundle = await bundleCheck();

  console.log(`\n========== 结论摘要 ==========`);
  const a = report.engineA, b = report.engineB;
  console.log(`init:        A ${fmt(a.initMs)}  vs  B ${fmt(b.initMs)}`);
  console.log(`峰值 RSS:    A ${a.peakRss} MB  vs  B ${b.peakRss} MB`);
  const bigA = a.rows.find((r) => r.file.startsWith("大"));
  const bigB = b.rows.find((r) => r.file.startsWith("大"));
  console.log(`大文件首次:  A ${fmt(bigA.firstMs)}  vs  B ${fmt(bigB.firstMs)}`);
  console.log(`大文件 warm: A ${fmt(bigA.warmMs)}  vs  B ${fmt(bigB.warmMs)}`);

  if (jsonPath) {
    mkdirSync(dirname(jsonPath), { recursive: true });
    writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf-8");
    console.log(`\nJSON 报告: ${jsonPath}`);
  }
}

await main();
