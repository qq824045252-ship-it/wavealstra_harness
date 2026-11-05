#!/usr/bin/env node
/**
 * typecheck-ratchet-guard-test.cjs — 验证 scripts/typecheck-scripts.mjs 不会 fail-open。
 *
 * 背景（审计 artifacts/audit-2026-10-26/README.md §4.5）：旧实现只解析
 * `file(line,col): error TSxxxx` 行，当 tsc 崩溃或 tsconfig 配置级错误（如 TS18003）
 * 时解析到 0 条错误，会打印「历史错误已不复现」并 exit 0 —— 门禁在 tsc 本身坏掉时仍是绿的。
 *
 * 本测试造一个没有输入的 tsconfig，确认脚本以非 0 退出且把配置错误打出来。
 */
const { spawnSync } = require("node:child_process");
const { existsSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const ROOT = join(__dirname, "..");
const SCRIPT = join(ROOT, "scripts", "typecheck-scripts.mjs");

function run(configPath, args = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, TYPECHECK_SCRIPTS_CONFIG: configPath },
    timeout: 120_000,
  });
}

const dir = mkdtempSync(join(tmpdir(), "mybuddy-typecheck-guard-"));
let failures = 0;
try {
  const config = join(dir, "empty-tsconfig.json");
  writeFileSync(
    config,
    JSON.stringify({ compilerOptions: { noEmit: true, skipLibCheck: true }, include: ["nothing/**/*.none"] }),
    "utf8",
  );

  const result = run(config);
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const checks = [
    ["config-level tsc failure exits non-zero", result.status !== 0],
    ["config-level tsc failure prints the tsc diagnostic", /TS18003|No inputs were found/.test(output)],
    ["config-level tsc failure is not reported as OK", !/OK：没有新增错误/.test(output)],
  ];
  for (const [label, pass] of checks) {
    console.log(`${pass ? "PASS" : "FAIL"}  ${label}`);
    if (!pass) failures += 1;
  }
  if (failures > 0) {
    console.log("---- output ----");
    console.log(output.trim());
  }

  const source = join(dir, "dependency.ts");
  const entry = join(dir, "entry.ts");
  writeFileSync(source, 'export const value: number = "invalid";\n', "utf8");
  writeFileSync(entry, 'import { value } from "./dependency";\nexport { value };\n', "utf8");
  writeFileSync(config, JSON.stringify({ compilerOptions: { noEmit: true, skipLibCheck: true }, files: [entry] }), "utf8");
  for (const args of [[], ["--update-baseline"]]) {
    const dependency = run(config, args);
    const detail = `${dependency.stdout ?? ""}\n${dependency.stderr ?? ""}`;
    const pass = dependency.status !== 0 && /TS2322/.test(detail) && !/OK：没有新增错误/.test(detail);
    console.log(`${pass ? "PASS" : "FAIL"}  imported errors fail ${args.length ? "baseline update" : "typecheck"}`);
    if (!pass) { failures += 1; console.log(detail); }
  }

  // 对照：正常配置仍应 exit 0（顺带确认脚本本身没被改坏）。
  const normal = run(join(ROOT, "tsconfig.scripts.json"));
  const normalOutput = `${normal.stdout ?? ""}\n${normal.stderr ?? ""}`;
  const normalPass = normal.status === 0 && /OK：没有新增错误/.test(normalOutput);
  console.log(`${normalPass ? "PASS" : "FAIL"}  normal config still passes the ratchet`);
  if (!normalPass) {
    failures += 1;
    console.log("---- normal output ----");
    console.log(normalOutput.trim());
  }
} finally {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
