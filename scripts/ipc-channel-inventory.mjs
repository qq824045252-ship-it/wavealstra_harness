#!/usr/bin/env node
/**
 * IPC channel 清单与冻结基线（Phase 0.2）。
 *
 * 目的：把「主进程最终生效的 channel 集合」变成可断言的事实，后续任何重构都必须保持集合不变。
 *
 * 口径（照 10 路复核结论收紧，见 docs/refactor-plan-verified.md）：
 *  1. 只把 `src/main/**` 计入「本进程注册」；`scripts/**`、`app/**` 记为跨进程/测试，不计入生效集合。
 *  2. channel 字面量必须解析 `Ipc` 常量对象（定义在 `src/shared/**` 与 `shared/src/**`），
 *     因为调用点写的是标识符而不是字符串。
 *  3. 支持多行调用（逐字符配平括号取第一个实参）。
 *  4. `ipcMain.handle = ...` 是猴补丁赋值，不是注册点，单独列出。
 *  5. 重复通道分 3 级：real（真重复）/ crossProcess / test。
 *     运行时动态注册（on + removeListener）单独标记 runtime。
 *
 * 用法：
 *   node scripts/ipc-channel-inventory.mjs            打印清单，不写文件
 *   node scripts/ipc-channel-inventory.mjs --update   写入基线
 *   node scripts/ipc-channel-inventory.mjs --check    与基线比对，新增即 exit 1
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const BASELINE_PATH = join(ROOT, "artifacts", "ipc-channel-baseline.json");

const SCAN_DIRS = ["src/main", "src/shared", "shared/src", "scripts", "app"];
const CONSTANT_DIRS = ["src/shared", "shared/src"];
const SKIP_DIRS = new Set(["node_modules", "out", "release", ".git", "dist", "build"]);

function walk(dir, out = []) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return out;
  for (const entry of readdirSync(abs)) {
    if (SKIP_DIRS.has(entry) || entry.startsWith("release-")) continue;
    const full = join(abs, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(join(dir, entry), out);
    else if (/\.(ts|tsx|mts|cts)$/.test(entry)) out.push(join(dir, entry).split(sep).join("/"));
  }
  return out;
}

const toPosix = (p) => p.split(sep).join("/");
const lineOf = (src, index) => src.slice(0, index).split("\n").length;

/** 解析所有 `export const XxxIpc = { a: "channel" } as const`。 */
function parseConstantObjects(files) {
  const byMember = new Map();
  const objects = new Map();
  const re = /export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*\{([\s\S]*?)\}\s*as\s+const/g;
  for (const file of files) {
    const src = readFileSync(join(ROOT, file), "utf8");
    let m;
    while ((m = re.exec(src))) {
      const ident = m[1];
      const body = m[2];
      const obj = objects.get(ident) ?? new Map();
      const memberRe = /(?:^|[\s,{])([A-Za-z_$][\w$]*)\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;
      let mm;
      while ((mm = memberRe.exec(body))) obj.set(mm[1], mm[2] ?? mm[3]);
      objects.set(ident, obj);
      for (const [k, v] of obj) byMember.set(`${ident}.${k}`, v);
    }
  }
  return { byMember, objects };
}

/** 取 `(` 之后、深度 1 层的第一个实参（跨行安全）。 */
function firstArgument(src, openParen) {
  let depth = 0;
  let i = openParen;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) break;
    } else if (c === "," && depth === 1) break;
  }
  return src.slice(openParen + 1, i).trim();
}

function resolveChannel(expr, byMember) {
  const s = expr.trim();
  let m;
  if ((m = /^"((?:[^"\\]|\\.)*)"$/.exec(s))) return { channel: JSON.parse(s), kind: "literal" };
  if ((m = /^'((?:[^'\\]|\\.)*)'$/.exec(s))) return { channel: m[1], kind: "literal" };
  if ((m = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/.exec(s))) {
    const key = `${m[1]}.${m[2]}`;
    return byMember.has(key)
      ? { channel: byMember.get(key), kind: "constant" }
      : { channel: null, kind: "unresolved-constant", expr: s };
  }
  return { channel: null, kind: "unresolved-expression", expr: s };
}

function scopeOf(file) {
  if (file.startsWith("src/main/")) return "main";
  if (file.startsWith("scripts/")) {
    // e2e/smoke 在自己的 Electron 进程注册同名通道 → 跨进程；-test 是单测/mock。
    if (/-e2e\.|-smoke\./.test(file)) return "crossProcess";
    return /-test\.|\/test-/.test(file) ? "test" : "script";
  }
  if (file.startsWith("app/")) return "app";
  return "other";
}

function collect() {
  const files = SCAN_DIRS.flatMap((d) => walk(d));
  const constantFiles = CONSTANT_DIRS.flatMap((d) => walk(d));
  const { byMember } = parseConstantObjects(constantFiles);

  const registrations = [];
  const patches = [];
  const runtime = [];

  for (const file of files) {
    const src = readFileSync(join(ROOT, file), "utf8");
    const patchRe = /ipcMain\s*\.\s*handle\s*=\s*[(a-zA-Z_$[]/g;
    let pm;
    while ((pm = patchRe.exec(src))) {
      patches.push({ file, line: lineOf(src, pm.index) });
    }
    const re = /ipcMain\s*\.\s*(handle|handleOnce|on|once)\s*\(/g;
    let m;
    while ((m = re.exec(src))) {
      const openParen = m.index + m[0].length - 1;
      const arg = firstArgument(src, openParen);
      const { channel, kind, expr } = resolveChannel(arg, byMember);
      const entry = {
        file,
        line: lineOf(src, m.index),
        method: m[1],
        channel,
        kind,
        scope: scopeOf(file),
        ...(expr ? { expr } : {}),
      };
      registrations.push(entry);
      if (expr) continue;
      if (m[1] === "on" || m[1] === "once") {
        if (src.includes(`removeListener(${channel === null ? "" : JSON.stringify(channel)}`)) {
          entry.runtime = true;
          runtime.push(entry);
        }
      }
    }
  }
  return { registrations, patches, runtime };
}

/** 同一 channel 的重复分 4 级。 */
function classifyDuplicates(registrations) {
  const byChannel = new Map();
  for (const r of registrations) {
    if (!r.channel) continue;
    if (!byChannel.has(r.channel)) byChannel.set(r.channel, []);
    byChannel.get(r.channel).push(r);
  }
  const tiers = { real: [], mutex: [], crossProcess: [], test: [] };
  for (const [channel, entries] of byChannel) {
    if (entries.length < 2) continue;
    const record = {
      channel,
      entries: entries.map((e) => `${e.file}:${e.line}`),
      foreign: entries.filter((e) => e.scope !== "main").map((e) => `${e.file}:${e.line}`),
    };
    // 只看主进程侧的关系：同一 channel 在主进程注册 2 次才是互斥或真重复；
    // 只有 1 次而另有 scripts/app 注册的，属跨进程同名，不是主进程重复。
    const mainEntries = entries.filter((e) => e.scope === "main");
    if (mainEntries.length >= 2) {
      tiers.real.push(record);
    } else if (entries.some((e) => e.scope === "test")) tiers.test.push(record);
    else tiers.crossProcess.push(record);
  }
  return tiers;
}

function buildReport() {
  const { registrations, patches, runtime } = collect();
  const mainRegistrations = registrations.filter((r) => r.scope === "main");
  const channels = [...new Set(mainRegistrations.map((r) => r.channel).filter(Boolean))].sort();
  const unresolved = registrations.filter((r) => !r.channel && r.scope === "main");
  const tiers = classifyDuplicates(registrations);
  return {
    scope: "src/main/**",
    mainRegistrations: mainRegistrations.length,
    allRegistrations: registrations.length,
    uniqueChannels: channels.length,
    channels,
    runtimeChannels: [...new Set(runtime.map((r) => r.channel))].sort(),
    monkeyPatches: patches,
    unresolved: unresolved.map((r) => `${r.file}:${r.line} → ${r.expr}`),
    duplicates: tiers,
    counts: {
      realDuplicates: tiers.real.length,
      mutexDuplicates: tiers.mutex.length,
      crossProcessDuplicates: tiers.crossProcess.length,
    },
  };
}

function main() {
  const mode = process.argv.includes("--check")
    ? "check"
    : process.argv.includes("--update")
      ? "update"
      : "print";
  const report = buildReport();

  console.log(`[ipc-inventory] 范围=src/main/**`);
  console.log(`[ipc-inventory] 本进程注册点=${report.mainRegistrations} 全仓=${report.allRegistrations}`);
  console.log(`[ipc-inventory] 唯一 channel=${report.uniqueChannels}`);
  console.log(
    `[ipc-inventory] 重复：真=${report.counts.realDuplicates} 互斥=${report.counts.mutexDuplicates} 跨进程=${report.counts.crossProcessDuplicates}`,
  );
  console.log(`[ipc-inventory] 运行时通道=${report.runtimeChannels.join(",") || "(none)"}`);
  console.log(`[ipc-inventory] 猴补丁赋值=${report.monkeyPatches.map((p) => `${p.file}:${p.line}`).join(",") || "(none)"}`);
  console.log(`[ipc-inventory] 未解析引用=${report.unresolved.length}`);
  for (const u of report.unresolved) console.log(`  ? ${u}`);
  if (report.counts.realDuplicates > 0) {
    for (const d of report.duplicates.real) console.log(`  ! 真重复 ${d.channel}: ${d.entries.join(" / ")}`);
  }

  if (mode === "update") {
    mkdirSync(join(ROOT, "artifacts"), { recursive: true });
    writeFileSync(BASELINE_PATH, JSON.stringify(report, null, 2) + "\n");
    console.log(`[ipc-inventory] 基线已写入 ${toPosix(relative(ROOT, BASELINE_PATH))}`);
    return;
  }

  if (mode === "check") {
    if (!existsSync(BASELINE_PATH)) {
      console.error(`[ipc-inventory] 缺少基线 ${toPosix(relative(ROOT, BASELINE_PATH))}；先跑 --update`);
      process.exit(2);
    }
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    const before = new Set(baseline.channels);
    const after = new Set(report.channels);
    const added = [...after].filter((c) => !before.has(c));
    const removed = [...before].filter((c) => !after.has(c));
    const newReal = report.duplicates.real.filter(
      (d) => !(baseline.duplicates?.real ?? []).some((b) => b.channel === d.channel),
    );
    if (added.length) console.error(`[ipc-inventory] 新增 channel：\n  ${added.join("\n  ")}`);
    if (removed.length) console.error(`[ipc-inventory] 移除 channel：\n  ${removed.join("\n  ")}`);
    if (newReal.length) console.error(`[ipc-inventory] 新增真重复：${newReal.map((d) => d.channel).join(",")}`);
    if (added.length || removed.length || newReal.length) {
      console.error("[ipc-inventory] 冻结基线失配：如需有意变更，请跑 --update 并审阅 diff。");
      process.exit(1);
    }
    console.log("[ipc-inventory] 冻结基线一致。");
  }
}

main();
