#!/usr/bin/env node
/**
 * test-all.mjs — 统一测试聚合门禁。
 *
 * 背景：仓库有 320+ 个 `test:*` 脚本，但既无聚合入口也无 CI，导致「过期常量」
 * （如断言 Pi 1.0.0 而实际 1.3.0）与「源码文本断言」长期腐烂而无人察觉。
 *
 * 设计（棘轮 ratchet，避免"上线即全红→被忽略"）：
 *   - default 套件只跑 headless 用例；GUI/NETWORK/DATASET 三类显式分类后再排除
 *     （见下方 GUI_TESTS / NETWORK_TESTS / DATASET_TESTS）。
 *   - GUI 类可用 `--include-gui` 单独放行（真实桌面会话）；`--include-live` 放行全部。
 *   - 与 scripts/test-baseline.json 中记录的已知失败对比：
 *       * 新增失败（回归）→ 退出码 1（门禁失败）
 *       * 已知失败仍失败 → 允许，但在输出中列出，债务保持可见
 *       * 已知失败现在通过 → 提示可更新 baseline（不算失败）
 *   - 未在 baseline 中且通过的用例正常通过。
 *
 * 用法：
 *   node scripts/test-all.mjs                    # default 套件（headless，并行池 + 串行性能池）
 *   node scripts/test-all.mjs --include-gui      # default + GUI（需要真实桌面会话/Electron）
 *   node scripts/test-all.mjs --include-live     # 全部（GUI + NETWORK + DATASET）
 *   node scripts/test-all.mjs --list             # 只列分类与选中的用例，不执行
 *   node scripts/test-all.mjs --audit            # 只做分类自检（GUI 清单 vs electron 命令）
 *   node scripts/test-all.mjs --update-baseline  # 记录当前失败集为基线
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
 * 排除集合分三类（+ 一个临时桶），默认套件只跑 headless 用例：
 *
 *   GUI     真实桌面会话/Electron 窗口（--include-gui 放行）
 *   NETWORK 联网、远程设备、浏览器自动化、本地端口服务（--include-live 放行）
 *   DATASET 依赖本机数据集或原生模块（--include-live 放行）
 *   KNOWN_HEADLESS_RED 临时桶：本身 headless，但当前是既有红（见各项原因），
 *           修好后必须移回 default；只有 --include-live 会跑到，避免把它藏进 GUI job。
 *
 * 清单以"显式名字"为准（审计 artifacts/audit-2026-10-26/gate-test-debt.md §2-3）：
 * 名字正则只做新用例的兜底，不能判断一个用例到底会不会启动 Electron
 * （历史教训：`-ui$` 与 `:desktop$` 都曾漏出 GUI 用例，混进"无头"门禁）。
 */
const GUI_TESTS = new Set([
  // 真 Electron 窗口（隐藏 BrowserWindow / 真实 UI 交互）
  "test:memory-ui",
  "test:tray",
  "test:expert-ui",
  "test:project-create-folder-ui",
  "test:project-materials-ui",
  "test:project-activity-ui",
  "test:consult-card-ui",
  "test:settings-records-ui",
  "test:svg-preview-resize",
  "test:consult-selection",
  "test:consult-entry:desktop",
  // Electron 运行时 / e2e
  "test:html-edit-electron",
  "test:local-capabilities-electron",
  "test:runtime-probe-electron",
  "test:browser-refresh",
  "test:browser-navbar-ui",
  "test:browser-screenshot-electron",
  // 性能用例里会 spawn 真实 Electron（core-performance-all 内部还串联 electron 用例）
  "test:core-performance-electron",
  "test:core-performance-mybuddy-startup",
  "test:core-performance-all",
  "test:pdf-runtime-e2e",
  "test:pdf-page-identity-e2e",
  "test:artifact-open-e2e",
  // -desktop
  "test:chat-attachment-acp-desktop",
  "test:expert-binding-desktop",
  "test:memory-lifecycle-desktop",
  "test:magpie-desktop",
  "test:multi-search-desktop",
  "test:durable-bot-desktop",
  "test:archive-deletion-desktop",
  "test:task-status-dot-desktop",
  "test:remote-task-dot-ui-desktop",
  "test:sidebar-space-collapse-desktop",
  "test:computer-use-desktop",
  // Windows 桌面自动化（UIA/真实桌面）
  "test:computer-use-recovery",
  "test:computer-automation",
  "test:computer-use-run",
  "test:computer-use-overlay",
  "test:computer-automation-windows",
  // Linux/Wayland 真机冒烟（CUL 分页 + 截图 + doctor + 可选 ydotool 输入）。
  // 需要真实 Hyprland 会话（hyprctl + xdg-desktop-portal + AT-SPI 桥），xvfb 里跑不了，
  // 所以归 GUI；`--allow-input` 才碰真按键，日常只读。
  "test:computer-use-linux",
]);

const NETWORK_TESTS = new Set([
  "test:remote-workspace-create",
  "test:remote-access",
  "test:remote-renderer-stdio",
  "test:remote-connection",
  "test:remote-done-ack",
  "test:remote-delete",
  "test:remote-task-cache",
  "test:remote-db",
  "test:compaction:live",
  "test:multi-model-consult:live",
  "test:conversation-branch:live",
  "test:task-status-dot:live",
  "test:acp-remote-android:live",
  "test:acp-remote-android-sync:live",
  "test:acp-remote-android-e2e:live",
  "test:remote-task-dot-android:live",
  "test:streaming-live",
  "test:multi-search-live",
  "test:durable-bot",
  "test:browser-automation-recovery",
]);

const DATASET_TESTS = new Set([
  // node-pty 原生模块 + 真实 pty。
  "test:terminal",
]);

/**
 * GUI 里"只在 Windows 上有意义"的用例：computer_* 系列依赖 UIA/Windows 桌面自动化，
 * 非 Windows 平台会直接断言 "requires Windows"（或在 Windows 专属验收里读真实 profile）。
 * 非 win32 上 `--include-gui` 会自动跳过它们并打印说明，避免本机 Linux 的 GUI 跑被
 * 平台限制污染；Windows 的 GUI job 仍然会跑。
 */
const GUI_WINDOWS_ONLY = new Set([
  "test:computer-use-desktop",
  "test:computer-automation",
  "test:computer-use-run",
  "test:computer-use-overlay",
  "test:computer-automation-windows",
]);

/** 临时桶：headless 但当前是既有红，先不进 default（否则门禁立刻红），也不要塞进 GUI
 * job 掩盖成"GUI 环境问题"。修好后删掉本项，让它回到 default。
 */
const KNOWN_HEADLESS_RED = new Set([
  // 目前为空。2026-10-27 清理时已删除 test:workspace-files-ui 的过时断言
  //（"项目资产可跳到侧边栏资料库"：ProjectAssets 已不再提供该入口），用例回到 default。
]);

/**
 * 显式 headless 白名单：名字看起来像 GUI/NETWORK，但实际是纯 node 静态断言。
 * 显式清单优先于下面的命名兜底，否则它们会被 `^test:browser-` 之类正则误伤。
 */
const HEADLESS_TESTS = new Set([
  "test:browser-open-guard", // 纯源码文本断言（stale preload 回归门），6/6 PASS
  "test:models-settings-overlay", // 纯源码文本断言，9/9 PASS
]);

/** 兜底规则：显式清单之外的新用例按命名约定归类（显式清单永远优先）。 */
const GUI_PATTERNS = [/-e2e$/, /-desktop$/, /-electron$/, /:desktop$/, /^test:computer-/];
const NETWORK_PATTERNS = [/:live$/, /^test:remote-/, /^test:browser-/];
const DATASET_PATTERNS = [];

/** @returns {"headless"|"gui"|"network"|"dataset"|"pending"} */
function classify(name) {
  if (GUI_TESTS.has(name)) return "gui";
  if (NETWORK_TESTS.has(name)) return "network";
  if (DATASET_TESTS.has(name)) return "dataset";
  if (KNOWN_HEADLESS_RED.has(name)) return "pending";
  if (HEADLESS_TESTS.has(name)) return "headless";
  if (GUI_PATTERNS.some((re) => re.test(name))) return "gui";
  if (NETWORK_PATTERNS.some((re) => re.test(name))) return "network";
  if (DATASET_PATTERNS.some((re) => re.test(name))) return "dataset";
  return "headless";
}

const args = process.argv.slice(2);
const updateBaseline = args.includes("--update-baseline");
const includeLive = args.includes("--include-live");
const includeGui = args.includes("--include-gui");
const filterArg = args.find((a) => a.startsWith("--filter="));
const filter = filterArg ? filterArg.slice("--filter=".length) : null;
const jobsArg = args.find((a) => a.startsWith("--jobs="));
const JOBS = Math.max(1, Number(jobsArg ? jobsArg.slice("--jobs=".length) : (process.env.TEST_ALL_JOBS ?? 4)));
const timeoutArg = args.find((a) => a.startsWith("--timeout="));
// 单个用例超时（秒）。test-guard 内部是 900s；聚合门禁需要更短的墙钟上限，
// 否则一个挂死用例就会拖住整条流水线（实测串行跑 250 个用例可超过 45 分钟）。
const PER_TEST_TIMEOUT = Math.max(30, Number(timeoutArg ? timeoutArg.slice("--timeout=".length) : 300));

/** 全量 test:*（去掉聚合脚本自身），用于分类统计与自检。 */
const allTestNames = Object.keys(pkg.scripts)
  .filter((k) => k.startsWith("test:"))
  .filter((n) => !SELF_EXCLUDE_PATTERNS.some((re) => re.test(n)))
  .sort();

const classOf = (name) => classify(name);
const classCounts = { headless: 0, gui: 0, network: 0, dataset: 0, pending: 0 };
for (const n of allTestNames) classCounts[classOf(n)] += 1;

/**
 * 自检：显式 GUI 清单与"命令里真的启动 electron"应对齐。
 * 这不是门禁断言（避免把分类维护成本转成红灯），但 `--list` / `--audit` 会打印，
 * 让新加的 Electron 用例不会悄悄混进 default 套件。
 *
 * warnings：需要处理（Electron 用例被归为 headless / 清单项已不存在）
 * info：预期内的信息（GUI 用例由 node driver 内部 spawn electron，命令串里看不到）
 */
function classificationWarnings() {
  const warnings = [];
  const info = [];
  const launchers = new Set();
  for (const [name, cmd] of Object.entries(pkg.scripts)) {
    if (!name.startsWith("test:")) continue;
    if (/(^|&&|;)\s*electron\s/.test(cmd)) launchers.add(name);
  }
  for (const name of launchers) {
    if (classOf(name) === "headless") warnings.push(`${name} 命令里直接启动 electron，却归为 headless（会进 default 套件）`);
  }
  for (const name of GUI_TESTS) {
    if (!pkg.scripts[name]) warnings.push(`GUI 清单里的 ${name} 已不存在于 package.json`);
    else if (!launchers.has(name)) info.push(`${name} 由 node driver 内部 spawn electron（命令串里没有直接 electron，属预期）`);
  }
  return { warnings, info };
}

let names = [...allTestNames];
if (includeLive) {
  // 放行全部（GUI + NETWORK + DATASET + pending）。
} else if (includeGui) {
  names = names.filter((n) => classOf(n) === "headless" || classOf(n) === "gui");
} else {
  names = names.filter((n) => classOf(n) === "headless");
}
// 非 Windows 上跳过 GUI_WINDOWS_ONLY（它们会直接断言 requires Windows）。
const skippedWindowsOnly =
  includeGui && !includeLive && process.platform !== "win32"
    ? names.filter((n) => GUI_WINDOWS_ONLY.has(n))
    : [];
if (skippedWindowsOnly.length > 0) names = names.filter((n) => !GUI_WINDOWS_ONLY.has(n));
if (filter) names = names.filter((n) => n.includes(filter));
names.sort();

if (args.includes("--list") || args.includes("--audit")) {
  const { warnings, info } = classificationWarnings();
  console.log(
    `[test-all] 分类：headless ${classCounts.headless} · GUI ${classCounts.gui} · NETWORK ${classCounts.network} · DATASET ${classCounts.dataset} · pending ${classCounts.pending}`,
  );
  console.log(
    `[test-all] 选中 ${names.length} 个用例${includeLive ? "（全部：GUI+NETWORK+DATASET）" : includeGui ? "（default + GUI）" : "（default：headless）"}${filter ? ` filter=${filter}` : ""}`,
  );
  if (skippedWindowsOnly.length > 0) {
    console.log(`[test-all] 非 Windows，跳过 ${skippedWindowsOnly.length} 个 Windows-only GUI 用例：${skippedWindowsOnly.join(", ")}`);
  }
  if (warnings.length > 0) {
    console.log(`[test-all] 分类自检警告（${warnings.length} 条，需要处理）：`);
    for (const w of warnings) console.log(`  ! ${w}`);
  } else {
    console.log("[test-all] 分类自检 OK：没有 Electron 用例混进 headless。");
  }
  if (args.includes("--audit") && info.length > 0) {
    console.log(`[test-all] 分类说明（${info.length} 条）：`);
    for (const line of info) console.log(`  · ${line}`);
  }
  if (args.includes("--list")) {
    const serial = names.filter((n) => SERIAL_TEST_PATTERNS.some((re) => re.test(n)));
    console.log(`[test-all] 并行 ${names.length - serial.length} · 串行 ${serial.length}`);
    for (const n of names) console.log(`  ${n}`);
  }
  process.exit(0);
}

if (names.length === 0) {
  console.error("[test-all] 没有匹配的 test:* 脚本");
  process.exit(2);
}

const serialNames = names.filter((n) => SERIAL_TEST_PATTERNS.some((re) => re.test(n)));
const parallelNames = names.filter((n) => !serialNames.includes(n));

const baseline = existsSync(BASELINE_PATH)
  ? new Set(JSON.parse(readFileSync(BASELINE_PATH, "utf8")).knownFailing ?? [])
  : new Set();

console.log(
  `[test-all] 运行 ${names.length} 个用例${includeLive ? "（全部：GUI+NETWORK+DATASET）" : includeGui ? "（default + GUI）" : "（default：headless）"}${filter ? ` filter=${filter}` : ""}`,
);
if (skippedWindowsOnly.length > 0) {
  console.log(`[test-all] 非 Windows，跳过 ${skippedWindowsOnly.length} 个 Windows-only GUI 用例：${skippedWindowsOnly.join(", ")}`);
}
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
