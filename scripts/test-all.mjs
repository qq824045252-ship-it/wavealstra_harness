#!/usr/bin/env node
/**
 * test-all.mjs — 统一测试聚合门禁（default 套件）。
 *
 * 背景：仓库有 290+ 个 `test:*` 脚本，但既无聚合入口也无 CI，导致「过期常量」
 * （如断言 Pi 1.0.0 而实际 1.3.0）与「源码文本断言」长期腐烂而无人察觉。
 *
 * 设计（棘轮 ratchet，避免"上线即全红→被忽略"）：
 *   - 跑 default 套件（排除需要 GUI/CDP/GPU 与联网 live 的用例，见 EXCLUDE_PATTERNS）。
 *   - 与 scripts/test-baseline.json 中记录的已知失败对比：
 *       * 新增失败（回归）→ 退出码 1（门禁失败）
 *       * 已知失败仍失败 → 允许，但在输出中列出，债务保持可见
 *       * 已知失败现在通过 → 提示可更新 baseline（不算失败）
 *   - 未在 baseline 中且通过的用例正常通过。
 *
 * 用法：
 *   node scripts/test-all.mjs                 # 顺序跑（默认）
 *   node scripts/test-all.mjs --update-baseline  # 记录当前失败集为基线
 *   node scripts/test-all.mjs --include-live     # 连同 GUI/live 一起跑
 *   node scripts/test-all.mjs --filter=memory    # 只跑名字含 memory 的
 *
 * 退出码：0 = 无新增失败；1 = 有新增失败；2 = 用法/环境错误。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = join(ROOT, "scripts", "test-baseline.json");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

/**
 * 自身与聚合脚本：绝不能递归执行，否则 test:all 会 spawn 自己形成 fork 炸弹
 * （实测：会跑满 45 分钟以上、泄漏大量 node 进程，并把所有用例误判为失败）。
 */
const SELF_EXCLUDE_PATTERNS = [/^test:all/, /^test:verify/];

/**
 * 负载敏感用例：这些用例断言的是墙钟性能（启动 p95、构建耗时等），
 * 与其它用例并行时会被 CPU/IO 争用推过预算，造成确定性 flaky。
 * 它们在并行池跑完后串行执行（JOBS=1），并且 `core-performance-all`
 * 内部还会再跑一遍同类用例，所以串行也要放在最后。
 */
const SERIAL_TEST_PATTERNS = [/^test:core-performance/];

/**
 * 需要 GUI / CDP / GPU / 真实桌面会话或联网的用例：在无头 CI 上不可靠。
 * 这些由 `--include-live` 或本地机器单独验证，不进入 default 门禁。
 */
const EXCLUDE_PATTERNS = [
  /-e2e$/, // 端到端：脚本里直接 `electron out/tests/...`，且单个用例可达 305s
  /-desktop$/, // Electron 桌面端 UI（CDP 截图/真实窗口）
  /-electron$/, // 需要 electron 运行时
  /:live$/, // 联网/真实服务
  /^test:remote-/, // 远程访问（需真实网络+GUI）
  /^test:browser-/, // 浏览器自动化（需 CDP）
  /^test:computer-/, // 计算机使用（需真实桌面 + Windows 自动化）
  /^test:streaming-live$/,
  /^test:durable-bot$/,
  /^test:multi-search-live$/,
  /^test:workspace-files-ui$/, // 需 GUI 文件面板
  /^test:models-settings-overlay$/,
  /^test:terminal$/, // 需 node-pty 原生模块
  // 依赖 gitignore 的官方市场归档 `mybuddyskills-main/`（约 294 技能）：该用例从市场安装真实
  // blender-* 技能，归档不存在时**无法**通过（不是代码缺陷）。需在具备该数据集的机器上单独跑。
  /^test:blender-skill$/,
];

const args = process.argv.slice(2);
const updateBaseline = args.includes("--update-baseline");
const includeLive = args.includes("--include-live");
const filterArg = args.find((a) => a.startsWith("--filter="));
const filter = filterArg ? filterArg.slice("--filter=".length) : null;
const jobsArg = args.find((a) => a.startsWith("--jobs="));
const JOBS = Math.max(1, Number(jobsArg ? jobsArg.slice("--jobs=".length) : (process.env.TEST_ALL_JOBS ?? 4)));
const timeoutArg = args.find((a) => a.startsWith("--timeout="));
// 单个用例超时（秒）。test-guard 内部是 900s；聚合门禁需要更短的墙钟上限，
// 否则一个挂死用例就会拖住整条流水线（实测串行跑 250 个用例可超过 45 分钟）。
const PER_TEST_TIMEOUT = Math.max(30, Number(timeoutArg ? timeoutArg.slice("--timeout=".length) : 300));

let names = Object.keys(pkg.scripts).filter((k) => k.startsWith("test:"));
names = names.filter((n) => !SELF_EXCLUDE_PATTERNS.some((re) => re.test(n)));
if (!includeLive) names = names.filter((n) => !EXCLUDE_PATTERNS.some((re) => re.test(n)));
if (filter) names = names.filter((n) => n.includes(filter));
names.sort();

if (names.length === 0) {
  console.error("[test-all] 没有匹配的 test:* 脚本");
  process.exit(2);
}

const serialNames = names.filter((n) => SERIAL_TEST_PATTERNS.some((re) => re.test(n)));
const parallelNames = names.filter((n) => !serialNames.includes(n));

if (args.includes("--list")) {
  console.log(`[test-all] 选中 ${names.length} 个用例（并行 ${parallelNames.length} · 串行 ${serialNames.length}）：`);
  for (const n of names) console.log(`  ${n}`);
  process.exit(0);
}

const baseline = existsSync(BASELINE_PATH)
  ? new Set(JSON.parse(readFileSync(BASELINE_PATH, "utf8")).knownFailing ?? [])
  : new Set();

console.log(`[test-all] 运行 ${names.length} 个用例${includeLive ? "（含 GUI/live）" : "（default 套件）"}${filter ? ` filter=${filter}` : ""}`);
console.log(`[test-all] baseline 已知失败: ${baseline.size}`);
console.log("");

const failed = [];
const passed = [];
const timedOut = [];
const started = Date.now();

// ELECTRON_RUN_AS_NODE=1 会让 Electron UI 用例以 `app is undefined` 失败；
// 必须真正删除该变量（赋值为 undefined 在部分 Node 版本会变成字符串 "undefined"）。
const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

const MAX_OUTPUT_BYTES = 1024 * 1024;
const activeChildren = new Set();

/** 只保留输出尾部：失败诊断要的是最后几十行，不是整段 esbuild 输出。 */
function tail(text, lines = 80) {
  const parts = String(text ?? "").trim().split(/\r?\n/);
  return parts.length <= lines ? parts.join("\n") : parts.slice(-lines).join("\n");
}

/**
 * 杀整棵进程树。之前用 `spawnSync(shell:true, timeout, SIGKILL)` 只杀掉了
 * `sh -c`/`cmd.exe`，其下的 pnpm → esbuild/node/electron 孙进程会继续持有
 * 端口、临时目录、~/.mybuddy 锁和 CPU，污染并行队列里的后续用例。
 * POSIX 用独立进程组 kill(-pid)，Windows 用 taskkill /T。
 */
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

function runOne(name) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn("pnpm", ["-s", name], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
      // POSIX 直接 spawn pnpm（不再套 sh -c，避免 Node DEP0190 与多一层僵尸进程）；
      // Windows 的 pnpm 是 .cmd，必须经 shell。超时为整组 kill / taskkill /T。
      shell: process.platform === "win32",
      detached: process.platform !== "win32",
    });
    activeChildren.add(child);
    let output = "";
    let settled = false;
    let killed = false;

    const collect = (chunk) => {
      output += chunk.toString();
      if (output.length > MAX_OUTPUT_BYTES) output = output.slice(-MAX_OUTPUT_BYTES);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeChildren.delete(child);
      resolve({ name, ok: !killed && code === 0, killed, secs: ((Date.now() - t0) / 1000).toFixed(1), output });
    };

    const timer = setTimeout(() => {
      killed = true;
      killTree(child);
      // 某些平台上 kill 后 close 可能迟迟不来，兜底结束该用例，避免整条门禁挂死。
      const fallback = setTimeout(() => finish(null), 5000);
      fallback.unref?.();
    }, PER_TEST_TIMEOUT * 1000);

    child.on("close", (code) => finish(code));
    child.on("error", (error) => {
      output += `\n[spawn error] ${error.message}`;
      finish(1);
    });
  });
}

// Ctrl+C 时连同所有 detached 子进程组一起退出，避免门禁被中断后留下孤儿进程。
process.on("SIGINT", () => {
  for (const child of activeChildren) killTree(child);
  process.exit(130);
});

/** 有限并发：pnpm+esbuild 启动开销占比高，串行会慢数倍。 */
async function runPool(items, worker, concurrency = JOBS) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (next === undefined) return;
      const r = await worker(next);
      if (r.killed) timedOut.push(r.name);
      if (r.ok) {
        passed.push(r.name);
        console.log(`  PASS ${r.name}  (${r.secs}s)`);
      } else {
        failed.push(r.name);
        const known = baseline.has(r.name);
        console.log(
          `  ${r.killed ? "TIMEOUT" : "FAIL "} ${r.name}  (${r.secs}s)${r.killed ? "" : known ? "  [baseline 已知]" : "  [新增回归]"}`,
        );
        // 之前 stdio:"ignore" 让 CI 只看到用例名、看不到任何失败原因。
        const detail = tail(r.output);
        if (detail) console.log(detail.split("\n").map((line) => `      | ${line}`).join("\n"));
      }
    }
  });
  await Promise.all(workers);
}

console.log(`[test-all] 并发 ${JOBS} · 单用例超时 ${PER_TEST_TIMEOUT}s`);
await runPool(parallelNames, async (n) => runOne(n));
if (serialNames.length > 0) {
  console.log(`\n[test-all] 串行执行负载敏感用例（${serialNames.length} 个，避免并行争用导致性能断言误报）：`);
  for (const n of serialNames) console.log(`    - ${n}`);
  await runPool(serialNames, async (n) => runOne(n), 1);
}

const elapsed = ((Date.now() - started) / 1000 / 60).toFixed(1);
const newRegressions = failed.filter((n) => !baseline.has(n));
const fixedSinceBaseline = [...baseline].filter((n) => !failed.includes(n) && names.includes(n));

console.log("");
console.log("=".repeat(64));
console.log(`[test-all] ${elapsed} min · 通过 ${passed.length} · 失败 ${failed.length} · 已知失败 ${failed.length - newRegressions.length} · 新增回归 ${newRegressions.length}${timedOut.length ? ` · 超时 ${timedOut.length}` : ""}`);

if (timedOut.length > 0) {
  console.log(`[test-all] 超时用例（>${PER_TEST_TIMEOUT}s，按失败计入门禁）：`);
  for (const n of timedOut) console.log(`    - ${n}`);
}

if (fixedSinceBaseline.length > 0) {
  console.log(`[test-all] 这些 baseline 用例现在通过，可从 baseline 移除：`);
  for (const n of fixedSinceBaseline) console.log(`    - ${n}`);
}

if (newRegressions.length > 0) {
  console.log("[test-all] 新增回归（门禁失败）：");
  for (const n of newRegressions) console.log(`    - ${n}`);
}

if (updateBaseline) {
  // 保留原有 $basis/$remaining 等 provenance，避免 --update-baseline 一次把决策背景抹掉。
  const previous = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : {};
  const payload = {
    ...previous,
    $comment:
      "已知失败基线（棘轮）。新增失败会让 test:all 失败；修复后请移除对应条目。每条应附简短原因。",
    generatedAt: new Date().toISOString(),
    knownFailing: failed.sort(),
  };
  writeFileSync(BASELINE_PATH, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(`[test-all] 已更新 baseline: ${BASELINE_PATH} (${failed.length} 条)`);
  process.exit(0);
}

if (failed.length > 0) {
  console.log("[test-all] 已知失败仍然可见（见上），但需修复后才能移出 baseline。");
}
process.exit(newRegressions.length > 0 ? 1 : 0);
