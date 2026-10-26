#!/usr/bin/env node
/**
 * typecheck-scripts.mjs — scripts/ 目录的 TypeScript 棘轮检查（只拦「新增」错误）。
 *
 * 背景：`scripts/`（测试与工具脚本）不在 tsconfig.node/web 的 include 里，因此测试脚本引用
 * 主进程服务契约发生漂移时没有任何静态检查能发现。实例：`347cc98` 把 DurableDomainTools 从
 * `ToolRegistration[]` 改成 `{ tools, contextHooks }`，两个 Durable 测试仍写 `tools: () => [tool]`，
 * 域工具被静默丢弃、只能靠 15s fixture 超时在运行时暴露。
 *
 * 做法与 test:all 的 baseline 棘轮一致：
 *   - 跑 `tsc -p tsconfig.scripts.json`，把 scripts/ 下的错误归一成「文件 + 错误码 + 消息」键；
 *   - 与 scripts/typecheck-baseline.json 比较：新增键 → 退出码 1；已修复的键 → 提示移除；
 *   - `--update-baseline` 重写基线（清理历史错误后再跑一次）。
 *
 * 为什么 key 里不带行号：行号随改动漂移会让棘轮噪声爆炸；同一文件同一错误码同一消息才视为同一条。
 *
 * 用法：
 *   node scripts/typecheck-scripts.mjs               # 检查（CI/typecheck 调用）
 *   node scripts/typecheck-scripts.mjs --update-baseline
 *   node scripts/typecheck-scripts.mjs --verbose     # 打印当前全部错误
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = join(ROOT, "scripts", "typecheck-baseline.json");
const CONFIG = join(ROOT, "tsconfig.scripts.json");

const args = process.argv.slice(2);
const updateBaseline = args.includes("--update-baseline");
const verbose = args.includes("--verbose");

if (!existsSync(CONFIG)) {
  console.error(`[typecheck-scripts] 缺少 ${relative(ROOT, CONFIG)}`);
  process.exit(2);
}

const result = spawnSync("npx", ["tsc", "--noEmit", "-p", CONFIG], {
  cwd: ROOT,
  encoding: "utf8",
  shell: true,
  maxBuffer: 32 * 1024 * 1024,
});
if (result.error) {
  console.error(`[typecheck-scripts] 无法运行 tsc: ${result.error.message}`);
  process.exit(2);
}

const LINE = /^(.+?)\(\d+,\d+\): error (TS\d+): (.*)$/;
const keys = new Map(); // key -> { file, code, message, samples }
for (const line of `${result.stdout ?? ""}\n${result.stderr ?? ""}`.split("\n")) {
  const match = LINE.exec(line.trim());
  if (!match) continue;
  const file = relative(ROOT, match[1]).replace(/\\/g, "/");
  // 只统计 scripts/ 下的错误；被 import 连带进来的 app/** 归它们自己的检查口径
  if (!file.startsWith("scripts/")) continue;
  const code = match[2];
  const message = match[3].trim();
  const key = `${file} :: ${code} :: ${message}`;
  if (!keys.has(key)) keys.set(key, { file, code, message });
}

const baseline = existsSync(BASELINE_PATH)
  ? new Set(JSON.parse(readFileSync(BASELINE_PATH, "utf8")).knownErrors ?? [])
  : new Set();

const current = [...keys.keys()].sort();
const added = current.filter((key) => !baseline.has(key));
const fixed = [...baseline].filter((key) => !keys.has(key)).sort();

console.log(
  `[typecheck-scripts] scripts/ 错误 ${current.length} 条 · 基线 ${baseline.size} 条 · 新增 ${added.length} · 已修复 ${fixed.length}`,
);

if (verbose) for (const key of current) console.log(`  ${key}`);

if (updateBaseline) {
  writeFileSync(
    BASELINE_PATH,
    `${JSON.stringify(
      {
        $comment:
          "scripts/ 的历史 TypeScript 错误基线（棘轮）——只允许减少。修复后请跑 `pnpm -s typecheck:scripts:update-baseline` 重写本文件；切勿为掩盖新错误而新增条目。",
        generatedAt: new Date().toISOString(),
        knownErrors: current,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`[typecheck-scripts] 已更新基线: ${relative(ROOT, BASELINE_PATH)}（${current.length} 条）`);
  process.exit(0);
}

if (fixed.length > 0) {
  console.log("[typecheck-scripts] 这些历史错误已不复现，可从基线移除：");
  for (const key of fixed.slice(0, 20)) console.log(`  - ${key}`);
  if (fixed.length > 20) console.log(`  … 另外 ${fixed.length - 20} 条`);
}

if (added.length > 0) {
  console.error("[typecheck-scripts] 新增 TypeScript 错误（棘轮失败）：");
  for (const key of added) console.error(`  - ${key}`);
  console.error("[typecheck-scripts] 请修掉新增错误；只有确认是既有技术债时才更新基线。");
  process.exit(1);
}

console.log("[typecheck-scripts] OK：没有新增错误。");
process.exit(0);
