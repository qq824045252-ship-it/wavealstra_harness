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
import { spawnSync } from "node:child_process";
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
  /^test:python-runtime-live$/, // 需真实 Python 运行时下载
  /^test:python-runtime-electron$/,
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

if (args.includes("--list")) {
  console.log(`[test-all] 选中 ${names.length} 个用例：`);
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

function runOne(name) {
  const t0 = Date.now();
  const res = spawnSync("pnpm", ["-s", name], {
    cwd: ROOT,
    stdio: "ignore",
    shell: true,
    env: childEnv,
    timeout: PER_TEST_TIMEOUT * 1000,
    killSignal: "SIGKILL",
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const killed = res.error?.code === "ETIMEDOUT" || res.signal === "SIGKILL";
  return { name, ok: !killed && res.status === 0, killed, secs };
}

/** 有限并发：pnpm+esbuild 启动开销占比高，串行会慢数倍。 */
async function runPool(items, worker) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(JOBS, queue.length) }, async () => {
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
      }
    }
  });
  await Promise.all(workers);
}

console.log(`[test-all] 并发 ${JOBS} · 单用例超时 ${PER_TEST_TIMEOUT}s`);
await runPool(names, async (n) => runOne(n));

const elapsed = ((Date.now() - started) / 1000 / 60).toFixed(1);
const newRegressions = failed.filter((n) => !baseline.has(n));
const fixedSinceBaseline = [...baseline].filter((n) => !failed.includes(n) && names.includes(n));

console.log("");
console.log("=".repeat(64));
console.log(`[test-all] ${elapsed} min · 通过 ${passed.length} · 失败 ${failed.length} · 已知失败 ${failed.length - newRegressions.length} · 新增回归 ${newRegressions.length}${timedOut.length ? ` · 超时 ${timedOut.length}` : ""}`);

if (timedOut.length > 0) {
  console.log(`[test-all] 超时用例（>${PER_TEST_TIMEOUT}s，未作为回归判定）：`);
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
  const payload = {
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
